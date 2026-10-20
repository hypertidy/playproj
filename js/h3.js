// playproj: H3 hexagons.
//
// Twenty triangular patches, one per icosahedron face, each textured with
// its own canvas drawn in the face's gnomonic plane, where H3's hexagons are
// regular and their edges straight. Unfold moves every patch from the globe
// out to the icosahedron (radially: the gnomonic projection) and then hinges
// the faces open into the strip net.
//
// The cells themselves come from h3-js (Uber's H3 library, Apache 2.0); the
// icosahedron is built from H3's own twelve pentagons and numbered as H3
// numbers its faces.

import * as THREE from "three";
import * as h3 from "h3-js";
import * as ico from "../src/core/icosa.js";
import { loadCoastline } from "./data.js";
import { warpCanvas } from "./basemap-load.js";
import { basemapControl, exportControl } from "./basemap-ui.js";
import { gnomonic } from "../src/core/cellexport.js";
import { makeStage, readParams, hashWriter, shareLinks, copyText } from "../src/scene/index.js";

const DEG = "\u00b0";
const TEX = 1024;
const N = 24;                      // patch subdivisions along a face edge
const MAX_RES = 3;                 // finest grid drawn over the whole globe
const H3_R = 6371007.180918475;    // H3's sphere (authalic), metres

const COLORS = {
  bg: 0x05070d,
  face: "#16263d",
  coast: "#d7ecff",
  grid: "rgba(215,236,255,0.45)",
  pent: "#ff7a59",
  kids: "#5fe3d0",
  pick: "#ffd34d"
};
const DIGIT = ["#e8eef7", "#e15759", "#f28e2b", "#edc948", "#59a14f", "#4e79a7", "#b07aa1"];

const toScene = (p) => new THREE.Vector3(p[1], p[2], p[0]);

// ---------------------------------------------------------------- the icosahedron

const I = ico.renumber(
  ico.icosahedron(h3.getPentagons(0).map((c) => { const [lat, lon] = h3.cellToLatLng(c); return [lon, lat]; })),
  (c) => { const [lon, lat] = ico.toLonLat(c); return h3.getIcosahedronFaces(h3.latLngToCell(lat, lon, 12))[0]; }
);
const NET = ico.stripNet(I);
const HINGE = ico.hinges(I, NET.parent);
const CORNERS = I.faces.map((_, f) => ico.corners(I, f));
// the texture square covers the face's circumcircle, a little more
const RT = 1.02 * Math.hypot(...CORNERS[0][0]);
const texX = (x) => ((x / RT + 1) / 2) * TEX, texY = (y) => (1 - (y / RT + 1) / 2) * TEX;

// ---------------------------------------------------------------- state

const isCell = (raw) => typeof raw === "string" && h3.isValidCell(raw.toLowerCase());
const defaults = { res: 2, t: 0, grid: 1, coast: 1, kids: 1, col: "base", cell: "", bm: "none", cam: null };
const state = { ...defaults };

function readHash() {
  readParams(state, defaults, {
    bm: String, col: String,
    cell: (raw) => (isCell(raw) ? raw.toLowerCase() : "")
  });
  state.res = Math.max(0, Math.min(MAX_RES, Math.round(state.res)));
  state.t = Math.max(0, Math.min(1, state.t));
  if (!["base", "digit", "none"].includes(state.col)) state.col = "base";
}
const writeHash = hashWriter(state, defaults);

// ---------------------------------------------------------------- cells

// the H3 digit at resolution r (1..15): which of seven children of its parent
const digitOf = (cell, r) => Number((BigInt("0x" + cell) >> BigInt(3 * (15 - r))) & 7n);

// every cell at a resolution, sorted onto the faces it touches
const byRes = new Map();
function cellsAt(res) {
  if (byRes.has(res)) return byRes.get(res);
  const faces = Array.from({ length: 20 }, () => []);
  for (const c0 of h3.getRes0Cells())
    for (const c of h3.cellToChildren(c0, res)) {
      const ring = h3.cellToBoundary(c).map(([la, lo]) => ico.toXYZ(lo, la));
      const rec = { cell: c, ring, base: h3.getBaseCellNumber(c), digit: res ? digitOf(c, res) : 0, pent: h3.isPentagon(c) };
      for (const f of h3.getIcosahedronFaces(c)) faces[f].push(rec);
    }
  byRes.set(res, faces);
  return faces;
}

// a ring of unit vectors on face f's texture, as a path
function ringPath(ctx, f, ring) {
  ring.forEach((p, i) => {
    const [x, y] = ico.toPlane(I, f, p);
    if (i) ctx.lineTo(texX(x), texY(y)); else ctx.moveTo(texX(x), texY(y));
  });
  ctx.closePath();
}
const cellRing = (c) => h3.cellToBoundary(c).map(([la, lo]) => ico.toXYZ(lo, la));

// ---------------------------------------------------------------- face textures

let coastPaths = null;
function buildCoast(lines) {
  coastPaths = I.faces.map((F, f) => {
    const path = new Path2D();
    for (const l of lines) {
      let pen = false;
      for (let i = 0; i < l.length; i += 2) {
        const p = ico.toXYZ(l[i], l[i + 1]);
        if (p[0] * F.c[0] + p[1] * F.c[1] + p[2] * F.c[2] < 0.6) { pen = false; continue; }
        const [x, y] = ico.toPlane(I, f, p);
        if (pen) path.lineTo(texX(x), texY(y)); else path.moveTo(texX(x), texY(y));
        pen = true;
      }
    }
    return path;
  });
}

const canvases = [], textures = [];
for (let f = 0; f < 20; f++) {
  const c = document.createElement("canvas");
  c.width = c.height = TEX;
  canvases.push(c);
  const tx = new THREE.CanvasTexture(c);
  tx.colorSpace = THREE.SRGBColorSpace;
  tx.anisotropy = 4;
  textures.push(tx);
}

let bmFaces = null;
const BM_TEX = 512;
function buildBasemapFaces(world) {
  bmFaces = !world ? null : I.faces.map((_, f) =>
    warpCanvas(world, BM_TEX, BM_TEX, (s, t) => ico.toLonLat(ico.fromPlane(I, f, (2 * s - 1) * RT, (2 * t - 1) * RT))));
}

const baseHue = (b) => `hsl(${(b * 137.508) % 360}, 45%, 30%)`;

function drawFace(f, picked) {
  const ctx = canvases[f].getContext("2d");
  ctx.save();
  ctx.clearRect(0, 0, TEX, TEX);
  // everything stays inside the face's triangle; the next face draws the rest
  ctx.beginPath();
  CORNERS[f].forEach(([x, y], i) => (i ? ctx.lineTo(texX(x), texY(y)) : ctx.moveTo(texX(x), texY(y))));
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = COLORS.face;
  ctx.fillRect(0, 0, TEX, TEX);

  const cells = cellsAt(state.res)[f];
  if (state.col !== "none") {
    ctx.globalAlpha = bmFaces ? 0.55 : 1;
    for (const c of cells) {
      ctx.beginPath(); ringPath(ctx, f, c.ring);
      ctx.fillStyle = state.col === "digit" && state.res ? DIGIT[c.digit] : baseHue(c.base);
      if (state.col === "digit" && state.res) ctx.globalAlpha = bmFaces ? 0.3 : 0.4;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  if (bmFaces) {
    ctx.globalAlpha = state.col === "none" ? 1 : 0.6;
    ctx.globalCompositeOperation = state.col === "none" ? "source-over" : "overlay";
    ctx.drawImage(bmFaces[f], 0, 0, TEX, TEX);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = "rgba(255,255,255,0.07)";
  ctx.font = `bold ${TEX * 0.32}px system-ui, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(String(f), TEX / 2, TEX / 2);

  if (state.coast && coastPaths) {
    ctx.strokeStyle = COLORS.coast; ctx.lineWidth = 1.6; ctx.globalAlpha = 0.85;
    ctx.stroke(coastPaths[f]);
    ctx.globalAlpha = 1;
  }

  if (state.grid) {
    ctx.strokeStyle = COLORS.grid; ctx.lineWidth = [3, 2, 1.3, 0.8, 0.5][state.res];
    ctx.beginPath();
    for (const c of cells) ringPath(ctx, f, c.ring);
    ctx.stroke();
  }
  // the twelve pentagons, at every resolution, on the corners
  ctx.strokeStyle = COLORS.pent; ctx.lineWidth = 4;
  for (const c of cells) if (c.pent) { ctx.beginPath(); ringPath(ctx, f, c.ring); ctx.stroke(); }

  if (picked && picked.faces.includes(f)) {
    const res = picked.res;
    if (state.kids && res < 15) {
      ctx.strokeStyle = COLORS.kids; ctx.lineWidth = res < 3 ? 2.5 : 1.5;
      ctx.beginPath();
      for (const k of h3.cellToChildren(picked.cell, res + 1)) ringPath(ctx, f, cellRing(k));
      ctx.stroke();
    }
    ctx.strokeStyle = COLORS.pick; ctx.lineWidth = 4;
    ctx.beginPath(); ringPath(ctx, f, picked.ring); ctx.stroke();
    const [x, y] = ico.toPlane(I, f, picked.centre);
    const span = Math.max(...picked.ring.map((p) => { const [a, b] = ico.toPlane(I, f, p); return Math.hypot(a - x, b - y); }));
    if ((span / RT) * TEX < 10) {
      ctx.beginPath(); ctx.arc(texX(x), texY(y), 14, 0, 2 * Math.PI); ctx.stroke();
    } else {
      ctx.fillStyle = "rgba(255,211,77,0.2)";
      ctx.beginPath(); ringPath(ctx, f, picked.ring); ctx.fill();
    }
  }
  ctx.restore();
  // the face's own edges
  ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 3;
  ctx.beginPath();
  CORNERS[f].forEach(([x, y], i) => (i ? ctx.lineTo(texX(x), texY(y)) : ctx.moveTo(texX(x), texY(y))));
  ctx.closePath(); ctx.stroke();
  textures[f].needsUpdate = true;
}

// ---------------------------------------------------------------- scene

const stage = document.getElementById("three");
const { renderer, scene, camera, controls, setCamera, resize } = makeStage(stage, {
  bg: COLORS.bg,
  onCamera: (c) => { state.cam = c; writeHash(); }
});
const DEFAULT_CAM = [1.9, 2.2, 5.6, 0, 0, 0];
setCamera(DEFAULT_CAM);

const group = new THREE.Group();
scene.add(group);

// a triangle cut into N x N small ones: barycentric (i, j) with i + j <= N
const tri = [], bary = [];
for (let j = 0; j <= N; j++) for (let i = 0; i <= N - j; i++) bary.push([i / N, j / N]);
const at = (i, j) => { let k = 0; for (let r = 0; r < j; r++) k += N + 1 - r; return k + i; };
for (let j = 0; j < N; j++)
  for (let i = 0; i < N - j; i++) {
    tri.push(at(i, j), at(i + 1, j), at(i, j + 1));
    if (i + j < N - 1) tri.push(at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
  }

// each patch vertex as a point on its face's plane
const planeXY = CORNERS.map(([A, B, C]) => bary.map(([u, v]) =>
  [A[0] + u * (B[0] - A[0]) + v * (C[0] - A[0]), A[1] + u * (B[1] - A[1]) + v * (C[1] - A[1])]));

const meshes = [], placers = [];
for (let f = 0; f < 20; f++) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(bary.length * 3), 3));
  const uv = new Float32Array(bary.length * 2);
  planeXY[f].forEach(([x, y], k) => { uv[2 * k] = (x / RT + 1) / 2; uv[2 * k + 1] = (y / RT + 1) / 2; });
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(tri);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: textures[f], side: THREE.DoubleSide }));
  mesh.userData.face = f;
  meshes.push(mesh);
  group.add(mesh);
  placers.push(ico.placer(I, NET.parent, HINGE, f));
}

// The open net lies in the root face's plane: turn it to face the camera,
// with the band running left to right and the top vertex's faces above.
const netFrame = (() => {
  const centre = [0, 0, 0];
  const c = (f) => placers[f](0, 0, 1);
  for (let f = 0; f < 20; f++) { const p = c(f); centre[0] += p[0] / 20; centre[1] += p[1] / 20; centre[2] += p[2] / 20; }
  // band faces 0 and 8 point the same way, so the line between them runs along the band
  const a = toScene(c(NET.band[0])), b = toScene(c(NET.band[8]));
  const ex = b.clone().sub(a).normalize();
  const ez = toScene(I.faces[NET.root].c);
  const ey = new THREE.Vector3().crossVectors(ez, ex).normalize();
  // the upper faces should be above the band
  const up = toScene(c(NET.parent.findIndex((p, f) => I.faces[f].v.includes(NET.top) && p >= 0))).sub(toScene(centre));
  // (turned half round in its plane, not flipped: we look at the outside)
  if (up.dot(ey) < 0) { ey.negate(); ex.negate(); }
  const m = new THREE.Matrix4().makeBasis(ex, ey, ez);
  return { centre: toScene(centre), q: new THREE.Quaternion().setFromRotationMatrix(m).invert() };
})();

const ease = (x) => x * x * (3 - 2 * x);
const IDQ = new THREE.Quaternion();

function rebuildScene() {
  const a1 = Math.min(1, 2 * state.t), a2 = Math.max(0, 2 * state.t - 1);
  for (let f = 0; f < 20; f++) {
    const pos = meshes[f].geometry.attributes.position.array, F = I.faces[f];
    planeXY[f].forEach(([x, y], k) => {
      let p;
      if (a2 > 0) p = placers[f](x, y, a2);
      else {
        p = [F.c[0] + x * F.e1[0] + y * F.e2[0], F.c[1] + x * F.e1[1] + y * F.e2[1], F.c[2] + x * F.e1[2] + y * F.e2[2]];
        const r = Math.hypot(p[0], p[1], p[2]), m = 1 / r + (1 - 1 / r) * a1;
        p = [p[0] * m, p[1] * m, p[2] * m];
      }
      pos[3 * k] = p[1]; pos[3 * k + 1] = p[2]; pos[3 * k + 2] = p[0];
    });
    meshes[f].geometry.attributes.position.needsUpdate = true;
    meshes[f].geometry.computeBoundingSphere();
  }
  const e = ease(a2);
  group.quaternion.slerpQuaternions(IDQ, netFrame.q, e);
  const s = 1 - 0.42 * e;
  group.scale.setScalar(s);
  group.position.copy(netFrame.centre).applyQuaternion(group.quaternion).multiplyScalar(-e * s);
}

// ---------------------------------------------------------------- panel

const $ = (id) => document.getElementById(id);
const ui = {
  res: $("res"), resOut: $("res-out"), resHint: $("res-hint"), t: $("t"), tOut: $("t-out"),
  cell: $("cell"), cellRes: $("cell-res"), info: $("cell-info"),
  grid: $("grid"), coast: $("coast"), kids: $("kids"), col: $("col"),
  geojson: $("copy-geojson"), up: $("cell-up"), down: $("cell-down"),
  bm: $("basemap"), tif: $("download-tif"), family: $("family"), familyCap: $("family-cap")
};

const basemap = basemapControl({
  select: ui.bm, status: $("bm-status"), credit: $("credit"),
  onWorld: (world) => { buildBasemapFaces(world); sync(); }
});

// the picked cell as a GeoTIFF, gnomonic about its own centre (any
// gnomonic keeps H3's edges straight: they are great circles)
const tifOut = exportControl({
  button: ui.tif, size: $("tif-size"), status: $("bm-status"), bm: () => basemap.id,
  job: () => {
    const c = pickedCell();
    if (!c) return null;
    const [lat0, lon0] = h3.cellToLatLng(c.cell).map((v) => +v.toFixed(6));
    const g = gnomonic(lat0, lon0);
    const b = h3.cellToBoundary(c.cell), ring = [];
    // densified along each edge in the gnomonic plane, where edges are straight
    for (let i = 0; i < b.length; i++) {
      const p = g.forward(b[i][1], b[i][0]), q = g.forward(b[(i + 1) % b.length][1], b[(i + 1) % b.length][0]);
      for (let k = 0; k < 8; k++) ring.push(g.inverse(p[0] + (k / 8) * (q[0] - p[0]), p[1] + (k / 8) * (q[1] - p[1])));
    }
    return {
      name: `playproj-h3-${c.cell}`,
      crs: { proj: `+proj=gnom +lat_0=${lat0} +lon_0=${lon0} +R=${H3_R}`, R: H3_R }, scale: H3_R,
      forward: g.forward, inverse: g.inverse, ring,
      inside: (lon, lat) => h3.latLngToCell(lat, lon, c.res) === c.cell
    };
  }
});

const fmtArea = (a) => a >= 100 ? Math.round(a).toLocaleString("en") + " km2" : a >= 0.01 ? a.toPrecision(3) + " km2" : (a * 1e6).toPrecision(3) + " m2";
const fmtLen = (m) => m >= 1000 ? (m / 1000).toPrecision(3) + " km" : m >= 1 ? m.toPrecision(3) + " m" : (m * 100).toPrecision(3) + " cm";

function pickedCell() {
  if (!state.cell) return null;
  const cell = state.cell, res = h3.getResolution(cell), [lat, lon] = h3.cellToLatLng(cell);
  return { cell, res, ring: cellRing(cell), centre: ico.toXYZ(lon, lat), lon, lat, faces: h3.getIcosahedronFaces(cell) };
}

function updatePanel(picked) {
  ui.res.value = state.res;
  ui.resOut.textContent = String(state.res);
  ui.resHint.textContent = `${h3.getNumCells(state.res).toLocaleString("en")} cells, about ${fmtArea(h3.getHexagonAreaAvg(state.res, "km2"))} each`;
  ui.t.value = state.t;
  ui.tOut.textContent = state.t === 0 ? "globe" : state.t === 0.5 ? "icosahedron" : state.t === 1 ? "net" : state.t < 0.5 ? "to the icosahedron" : "opening";
  ui.grid.checked = !!state.grid; ui.coast.checked = !!state.coast; ui.kids.checked = !!state.kids;
  ui.col.value = state.col;
  if (document.activeElement !== ui.cell) ui.cell.value = state.cell;
  ui.cell.classList.remove("bad");
  ui.geojson.disabled = ui.up.disabled = ui.down.disabled = !picked;
  if (!tifOut.busy) ui.tif.disabled = !picked || !basemap.world;
  if (picked) {
    ui.up.disabled = picked.res === 0; ui.down.disabled = picked.res === 15;
    const pent = h3.isPentagon(picked.cell);
    ui.cellRes.textContent = `resolution ${picked.res}, base cell ${h3.getBaseCellNumber(picked.cell)}` + (pent ? ", a pentagon" : "");
    const fs = [...picked.faces].sort((a, b) => a - b);
    const list = fs.length > 1 ? fs.slice(0, -1).join(", ") + " and " + fs[fs.length - 1] : String(fs[0]);
    ui.info.textContent = `Centre ${picked.lon.toFixed(4)}${DEG}, ${picked.lat.toFixed(4)}${DEG}; area ${fmtArea(h3.cellArea(picked.cell, "km2"))}; ` +
      `edge about ${fmtLen(h3.getHexagonEdgeLengthAvg(picked.res, "m"))}; on face${fs.length > 1 ? "s" : ""} ${list}; ` +
      `Class ${picked.res % 2 ? "III" : "II"}.`;
  } else {
    ui.cellRes.textContent = "";
    ui.info.textContent = "Click a cell for its index, or paste one.";
  }
}

// The picked cell's family on a gnomonic plane about its centre, in
// doubles, so it reads at any resolution: its neighbours, its parent
// (dashed), its seven children with their digits, and their children.
function drawFamily(picked) {
  const cv = ui.family, cap = ui.familyCap;
  cv.hidden = cap.hidden = !picked;
  if (!picked) return;
  const ctx = cv.getContext("2d"), W = cv.width, H = cv.height, res = picked.res;
  const g = gnomonic(picked.lat, picked.lon);
  const xy = (c) => h3.cellToBoundary(c).map(([la, lo]) => g.forward(lo, la));
  const near = h3.gridDisk(picked.cell, 1).filter((c) => c !== picked.cell);
  const parent = res > 0 ? h3.cellToParent(picked.cell, res - 1) : null;
  const kids = res < 15 ? h3.cellToChildren(picked.cell, res + 1) : [];
  const grand = res < 14 ? h3.cellToChildren(picked.cell, res + 2) : [];
  const rings = near.map(xy);   // the parent may run off the edge
  let ext = 0;
  for (const r of rings) for (const [x, y] of r) ext = Math.max(ext, Math.abs(x) / W, Math.abs(y) / H);
  const k = 0.47 / ext, X = (x) => W / 2 + x * k, Y = (y) => H / 2 - y * k;
  const path = (r) => { ctx.beginPath(); r.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); ctx.closePath(); };
  ctx.fillStyle = "#0b1220"; ctx.fillRect(0, 0, W, H);
  ctx.lineJoin = "round";
  for (const c of near) {
    path(xy(c)); ctx.fillStyle = "#16263d"; ctx.fill();
    ctx.strokeStyle = h3.isPentagon(c) ? COLORS.pent : "rgba(215,236,255,0.45)"; ctx.lineWidth = 1.5; ctx.stroke();
  }
  path(xy(picked.cell)); ctx.fillStyle = "rgba(255,211,77,0.12)"; ctx.fill();
  ctx.strokeStyle = "rgba(95,227,208,0.35)"; ctx.lineWidth = 0.8;
  for (const c of grand) { path(xy(c)); ctx.stroke(); }
  ctx.strokeStyle = COLORS.kids; ctx.lineWidth = 2;
  ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = "bold 15px system-ui, sans-serif";
  for (const c of kids) {
    path(xy(c)); ctx.stroke();
    const [la, lo] = h3.cellToLatLng(c), [x, y] = g.forward(lo, la);
    ctx.fillStyle = COLORS.kids; ctx.fillText(String(digitOf(c, res + 1)), X(x), Y(y));
  }
  ctx.strokeStyle = COLORS.pick; ctx.lineWidth = 3; path(xy(picked.cell)); ctx.stroke();
  if (parent) {
    ctx.setLineDash([8, 6]); ctx.strokeStyle = COLORS.pent; ctx.lineWidth = 2.5;
    path(xy(parent)); ctx.stroke(); ctx.setLineDash([]);
  }
  const area = h3.cellArea(picked.cell, "km2");
  const inside = kids.reduce((s, c) => s + h3.cellArea(c, "km2"), 0);
  cap.textContent = `The picked cell (yellow)` + (parent ? `, its parent (orange, dashed)` : "") +
    (kids.length ? `, its ${kids.length} children (cyan, by digit)` + (grand.length ? ` and their ${grand.length} children` : "") : "") +
    ` and its neighbours, on a gnomonic plane about its centre, north up.` +
    (kids.length ? ` The children cover ${(100 * inside / area).toFixed(1)}% of the cell's area but not its outline: they spill over its edges and leave its corners to the neighbours' children.` : "");
}

let rafPending = false, drawFaces = true;
function sync(faces = true) {
  writeHash();
  drawFaces = drawFaces || faces;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const picked = pickedCell();
    if (drawFaces) { for (let f = 0; f < 20; f++) drawFace(f, picked); drawFamily(picked); }
    drawFaces = false;
    rebuildScene();
    updatePanel(picked);
  });
}

ui.res.addEventListener("input", () => { state.res = +ui.res.value; sync(); });
ui.t.addEventListener("input", () => { stopAnim(); state.t = +ui.t.value; sync(false); });
for (const k of ["grid", "coast", "kids"])
  ui[k].addEventListener("change", () => { state[k] = ui[k].checked ? 1 : 0; sync(); });
ui.col.addEventListener("change", () => { state.col = ui.col.value; sync(); });
ui.cell.addEventListener("change", () => {
  const raw = ui.cell.value.trim().toLowerCase();
  if (!raw) { state.cell = ""; return sync(); }
  if (!isCell(raw)) { ui.cell.classList.add("bad"); return; }
  state.cell = raw;
  sync();
});
ui.up.addEventListener("click", () => {
  const c = pickedCell();
  if (c && c.res > 0) { state.cell = h3.cellToParent(c.cell, c.res - 1); sync(); }
});
ui.down.addEventListener("click", () => {
  const c = pickedCell();
  if (c && c.res < 15) { state.cell = h3.cellToCenterChild(c.cell, c.res + 1); sync(); }
});
ui.geojson.addEventListener("click", (e) => {
  const c = pickedCell();
  if (!c) return;
  const b = h3.cellToBoundary(c.cell, true).map(([x, y]) => [+x.toFixed(9), +y.toFixed(9)]);
  copyText(JSON.stringify({ type: "Feature", properties: { h3: c.cell, res: c.res, base_cell: h3.getBaseCellNumber(c.cell) },
    geometry: { type: "Polygon", coordinates: [b] } }), e.target);
});
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(DEFAULT_CAM); writeHash(); });

// click (not drag) on a face picks the cell under the pointer at the grid's resolution
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObjects(meshes)[0];
  if (!hit) return;
  const f = hit.object.userData.face;
  const [lon, lat] = ico.toLonLat(ico.fromPlane(I, f, (2 * hit.uv.x - 1) * RT, (2 * hit.uv.y - 1) * RT));
  state.cell = h3.latLngToCell(lat, lon, state.res);
  sync();
});

let anim = false, dir = 1, lastT = 0;
const playBtn = $("play");
function stopAnim() { anim = false; playBtn.textContent = state.t >= 1 ? "Fold" : "Unfold"; }
playBtn.addEventListener("click", () => {
  if (anim) return stopAnim();
  anim = true; dir = state.t >= 1 ? -1 : 1; playBtn.textContent = "Stop"; lastT = performance.now();
});

shareLinks("H3 hexagons");

// ---------------------------------------------------------------- loop

function tick(now) {
  if (anim) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    state.t = Math.max(0, Math.min(1, state.t + dir * dt * 0.25));
    if (state.t === 1 || state.t === 0) stopAnim();
    sync(false);
  }
  lastT = now;
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

ui.bm.addEventListener("change", () => { state.bm = ui.bm.value; writeHash(); basemap.set(state.bm); });

window.addEventListener("hashchange", () => {
  readHash();
  setCamera(state.cam || DEFAULT_CAM);
  basemap.set(state.bm); sync();
});

readHash();
setCamera(state.cam || DEFAULT_CAM);
resize();
sync();
basemap.set(state.bm);
loadCoastline("110m").then((lines) => { buildCoast(lines); sync(); document.body.classList.add("ready"); });
requestAnimationFrame(tick);
