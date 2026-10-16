// playproj: s2 cells.
//
// Six square patches, one per cube face, each textured with its own canvas
// drawn in the face's (s, t) cell coordinates. Unfold moves every patch from
// the globe out to the cube (radially, the gnomonic projection) and then
// hinges the faces open into the staircase net 0-1-2-3-4-5, along which the
// Hilbert curve runs unbroken.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as s2 from "./s2.js";
import { loadCoastline } from "./geo.js";
import { warpCanvas } from "./basemap.js";
import { basemapControl, exportControl } from "./basemap-ui.js";
import { gnomonic, ringOf } from "./cellexport.js";

const DEG = "\u00b0";
const TEX = 1024;
const N = 32;                      // patch grid per face
const MAX_DRAW = { grid: 8, curve: 7 };

const COLORS = {
  bg: 0x05070d,
  face: ["#1c3557", "#1d3a3a", "#33284f", "#3d2a26", "#2c3a22", "#3a2c3f"],
  coast: "#d7ecff",
  grid: "rgba(215,236,255,0.35)",
  uv: "rgba(255,179,71,0.75)",
  pick: "#ffd34d"
};

// s2 x, y, z (x to 0,0; z north) to the scene: face 0 towards the camera
const toScene = (p) => new THREE.Vector3(p[1], p[2], p[0]);

// ---------------------------------------------------------------- state

const defaults = { lvl: 3, t: 0, curve: 1, grid: 1, coast: 1, uvgrid: 0, cell: "", bm: "none", cam: null };
const state = { ...defaults };
const embed = new URLSearchParams(location.search).has("embed");

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  Object.assign(state, defaults);
  for (const k of Object.keys(defaults)) {
    if (!h.has(k)) continue;
    const raw = h.get(k);
    if (k === "bm") state.bm = raw;
    else if (k === "cell") state.cell = s2.fromToken(raw) ? raw.toLowerCase() : "";
    else if (k === "cam") {
      const c = raw.split(",").map(Number);
      if (c.length === 6 && c.every(isFinite)) state.cam = c;
    } else if (isFinite(+raw)) state[k] = +raw;
  }
  state.lvl = Math.max(0, Math.min(12, Math.round(state.lvl)));
  state.t = Math.max(0, Math.min(1, state.t));
}

let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const h = new URLSearchParams();
    for (const k of Object.keys(defaults)) {
      if (k === "cam") { if (state.cam) h.set("cam", state.cam.map((x) => +x.toFixed(2)).join(",")); continue; }
      const val = typeof state[k] === "number" ? +state[k].toFixed(3) : state[k];
      if (val !== defaults[k]) h.set(k, String(val));
    }
    const s = h.toString();
    history.replaceState(null, "", s ? "#" + s : location.pathname + location.search);
  }, 200);
}

// ---------------------------------------------------------------- face textures

let coastPaths = null;   // per face, a Path2D in texture pixels

function buildCoast(lines) {
  coastPaths = [];
  for (let face = 0; face < 6; face++) {
    const ax = s2.faceAxis(face), path = new Path2D();
    for (const l of lines) {
      let pen = false;
      for (let i = 0; i < l.length; i += 2) {
        const p = s2.toXYZ(l[i], l[i + 1]);
        // keep points within reach of this face, so lines run off its edges
        if (p[0] * ax[0] + p[1] * ax[1] + p[2] * ax[2] < 0.3) { pen = false; continue; }
        const [u, v] = s2.faceUV(face, p);
        const x = s2.uvToST(u) * TEX, y = (1 - s2.uvToST(v)) * TEX;
        if (pen) path.lineTo(x, y); else path.moveTo(x, y);
        pen = true;
      }
    }
    coastPaths.push(path);
  }
}

const canvases = [], textures = [];
for (let f = 0; f < 6; f++) {
  const c = document.createElement("canvas");
  c.width = c.height = TEX;
  canvases.push(c);
  const tx = new THREE.CanvasTexture(c);
  tx.colorSpace = THREE.SRGBColorSpace;
  tx.anisotropy = 4;
  textures.push(tx);
}

// the basemap on each face, warped into the face's (s, t)
let bmFaces = null;
const BM_TEX = 512;
function buildBasemapFaces(world) {
  bmFaces = !world ? null : [0, 1, 2, 3, 4, 5].map((f) =>
    warpCanvas(world, BM_TEX, BM_TEX, (s, t) => s2.toLonLat(s2.faceUVtoXYZ(f, s2.stToUV(s), s2.stToUV(t)))));
}

const hue = (x) => `hsl(${Math.round(300 * x)}, 85%, 62%)`;

function drawFace(face, picked) {
  const ctx = canvases[face].getContext("2d"), L = state.lvl, n = 1 << L;
  ctx.fillStyle = COLORS.face[face];
  if (bmFaces) {
    ctx.drawImage(bmFaces[face], 0, 0, TEX, TEX);
    ctx.globalAlpha = 0.3;
  }
  ctx.fillRect(0, 0, TEX, TEX);
  ctx.globalAlpha = 1;

  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.font = `bold ${TEX * 0.5}px system-ui, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(String(face), TEX / 2, TEX / 2);

  if (state.coast && coastPaths) {
    ctx.strokeStyle = COLORS.coast; ctx.lineWidth = 1.6; ctx.globalAlpha = 0.85;
    ctx.stroke(coastPaths[face]);
    ctx.globalAlpha = 1;
  }

  if (state.grid && L <= MAX_DRAW.grid) {
    ctx.strokeStyle = COLORS.grid; ctx.lineWidth = L > 6 ? 0.6 : 1.2;
    ctx.beginPath();
    for (let k = 0; k <= n; k++) {
      const x = (k / n) * TEX;
      ctx.moveTo(x, 0); ctx.lineTo(x, TEX); ctx.moveTo(0, x); ctx.lineTo(TEX, x);
    }
    ctx.stroke();
  }
  if (state.uvgrid && L <= MAX_DRAW.grid) {
    // the same grid without the quadratic stretch: even steps in u, v
    ctx.strokeStyle = COLORS.uv; ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let k = 0; k <= n; k++) {
      const x = s2.uvToST(-1 + (2 * k) / n) * TEX;
      ctx.moveTo(x, 0); ctx.lineTo(x, TEX); ctx.moveTo(0, TEX - x); ctx.lineTo(TEX, TEX - x);
    }
    ctx.stroke();
  }

  if (state.curve && L <= MAX_DRAW.curve) {
    const cells = s2.hilbertCells(face, L), total = 6 * cells.length;
    ctx.lineWidth = L > 5 ? 1.5 : 3; ctx.lineJoin = "round";
    const pt = ([i, j]) => [((i + 0.5) / n) * TEX, (1 - (j + 0.5) / n) * TEX];
    const chunk = Math.max(1, cells.length >> 6);
    for (let k = 0; k < cells.length - 1; k += chunk) {
      ctx.strokeStyle = hue((face * cells.length + k) / total);
      ctx.beginPath(); ctx.moveTo(...pt(cells[k]));
      for (let m = k + 1; m <= Math.min(k + chunk, cells.length - 1); m++) ctx.lineTo(...pt(cells[m]));
      ctx.stroke();
    }
    if (L === 0) {
      ctx.fillStyle = hue(face / 6);
      ctx.beginPath(); ctx.arc(TEX / 2, TEX / 2, 10, 0, 2 * Math.PI); ctx.fill();
    }
    // where the curve enters this face, and where it leaves for the next
    ctx.fillStyle = "#ffffff";
    for (const c of [cells[0], cells[cells.length - 1]]) {
      ctx.beginPath(); ctx.arc(...pt(c), L > 5 ? 4 : 7, 0, 2 * Math.PI); ctx.fill();
    }
  }

  if (picked && picked.face === face) {
    const x = picked.s0 * TEX, y = (1 - picked.t0 - picked.d) * TEX, w = picked.d * TEX;
    ctx.strokeStyle = COLORS.pick; ctx.lineWidth = 4;
    ctx.strokeRect(x, y, Math.max(w, 1), Math.max(w, 1));
    if (w < 12) {
      ctx.beginPath(); ctx.arc(x + w / 2, y + w / 2, 14, 0, 2 * Math.PI); ctx.stroke();
    } else {
      ctx.fillStyle = "rgba(255,211,77,0.25)"; ctx.fillRect(x, y, w, w);
    }
  }
  textures[face].needsUpdate = true;
}

// ---------------------------------------------------------------- scene

const stage = document.getElementById("three");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(COLORS.bg);
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const DEFAULT_CAM = [2.4, 1.9, 5.4, 0, 0, 0];
function setCamera(c) {
  camera.position.set(c[0], c[1], c[2]);
  controls.target.set(c[3], c[4], c[5]);
  controls.update();
}
setCamera(DEFAULT_CAM);
controls.addEventListener("end", () => {
  const p = camera.position, t = controls.target;
  state.cam = [p.x, p.y, p.z, t.x, t.y, t.z];
  writeHash();
});

const group = new THREE.Group();
scene.add(group);

const index = [];
for (let j = 0; j < N; j++)
  for (let i = 0; i < N; i++) {
    const a = j * (N + 1) + i, b = a + N + 1;
    index.push(a, a + 1, b, a + 1, b + 1, b);
  }
const uv = new Float32Array((N + 1) * (N + 1) * 2);
for (let j = 0, k = 0; j <= N; j++)
  for (let i = 0; i <= N; i++, k++) { uv[2 * k] = i / N; uv[2 * k + 1] = j / N; }

const meshes = [];
for (let f = 0; f < 6; f++) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array((N + 1) * (N + 1) * 3), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: textures[f], side: THREE.DoubleSide }));
  mesh.userData.face = f;
  meshes.push(mesh);
  group.add(mesh);
}

// The hinges of the staircase net: face k opens about the cube edge it
// shares with face k - 1. Each hinge is an axis through two points and the
// sign that opens the face outwards, found from the folded cube.
const hinges = [null];
for (let k = 1; k < 6; k++) {
  const a = toScene(s2.faceAxis(k - 1)), b = toScene(s2.faceAxis(k));
  const c = new THREE.Vector3().crossVectors(a, b);
  const p0 = a.clone().add(b).sub(c), p1 = a.clone().add(b).add(c);
  const axis = c.clone().normalize(), mid = a.clone().add(b);
  // open outwards: the face's centre ends up on the far side of the hinge from the parent's
  const test = b.clone().sub(mid).applyAxisAngle(axis, Math.PI / 2);
  const sign = test.dot(a.clone().sub(mid)) < 0 ? 1 : -1;
  hinges.push({ p0, axis, sign, p1 });
}

// position of face (s, t) at unfold t: 0 globe, 0.5 cube, 1 net
function placer(face, t) {
  const a1 = Math.min(1, 2 * t), a2 = Math.max(0, 2 * t - 1);
  const ang = (Math.PI / 2) * a2;
  const q = [];
  for (let k = face; k >= 1; k--) q.push(new THREE.Quaternion().setFromAxisAngle(hinges[k].axis, hinges[k].sign * ang));
  const v = new THREE.Vector3();
  return (s, t2, out, i) => {
    const p = s2.faceUVtoXYZ(face, s2.stToUV(s), s2.stToUV(t2));
    const r = Math.hypot(p[0], p[1], p[2]);
    const m = 1 / r + (1 - 1 / r) * a1;
    v.set(p[1] * m, p[2] * m, p[0] * m);
    // hinge from the deepest face up: each rotation about its edge as it is in the cube
    for (let k = face, n = 0; k >= 1; k--, n++) v.sub(hinges[k].p0).applyQuaternion(q[n]).add(hinges[k].p0);
    out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
  };
}

// centre of the open net, to slide it into view as it opens
const netCentre = (() => {
  const c = new THREE.Vector3(), o = [0, 0, 0];
  for (let f = 0; f < 6; f++) { placer(f, 1)(0.5, 0.5, o, 0); c.add(new THREE.Vector3(...o)); }
  return c.divideScalar(6);
})();

const ease = (x) => x * x * (3 - 2 * x);

function rebuildScene() {
  for (let f = 0; f < 6; f++) {
    const place = placer(f, state.t), pos = meshes[f].geometry.attributes.position;
    for (let j = 0, k = 0; j <= N; j++)
      for (let i = 0; i <= N; i++, k++) place(i / N, j / N, pos.array, 3 * k);
    pos.needsUpdate = true;
    meshes[f].geometry.computeBoundingSphere();
  }
  const e = ease(Math.max(0, 2 * state.t - 1));
  group.position.copy(netCentre).multiplyScalar(-e * 0.55);
  group.scale.setScalar(1 - 0.45 * e);
}

// ---------------------------------------------------------------- panel

const $ = (id) => document.getElementById(id);
const ui = {
  lvl: $("lvl"), lvlOut: $("lvl-out"), t: $("t"), tOut: $("t-out"),
  token: $("token"), cellLevel: $("cell-level"), info: $("cell-info"),
  curve: $("curve"), grid: $("grid"), coast: $("coast"), uvgrid: $("uvgrid"),
  geojson: $("copy-geojson"), up: $("cell-up"), down: $("cell-down"),
  bm: $("basemap"), tif: $("download-tif")
};

// The picked cell as a GeoTIFF: in the gnomonic projection about its face's
// centre, where its edges (great circles) are straight. S2's own sphere has
// radius 6371010 m.
const S2_R = 6371010;
const basemap = basemapControl({
  select: ui.bm, status: $("bm-status"), credit: $("credit"),
  onWorld: (world) => { buildBasemapFaces(world); sync(); }
});
const tifOut = exportControl({
  button: ui.tif, size: $("tif-size"), status: $("bm-status"), bm: () => basemap.id,
  job: () => {
    const c = pickedCell();
    if (!c) return null;
    const { face, s0, t0, d } = c;
    // the face's centre: a whole number of degrees, 180 rather than -180
    const [lo, la] = s2.toLonLat(s2.faceAxis(face)), lat0 = Math.round(la);
    const lon0 = Math.abs(lat0) === 90 ? 0 : Math.round(lo) === -180 ? 180 : Math.round(lo);
    const g = gnomonic(lat0, lon0);
    const at = (a, b) => s2.toLonLat(s2.faceUVtoXYZ(face, s2.stToUV(s0 + a * d), s2.stToUV(t0 + b * d)));
    return {
      name: `playproj-s2-${s2.toToken(c.id)}`,
      crs: { proj: `+proj=gnom +lat_0=${lat0} +lon_0=${lon0} +R=${S2_R}`, R: S2_R }, scale: S2_R,
      forward: g.forward, inverse: g.inverse, ring: ringOf(at),
      inside: (lon, lat) => {
        const p = s2.toXYZ(lon, lat);
        if (s2.faceOf(p) !== face) return false;
        const [u, v] = s2.faceUV(face, p), s = s2.uvToST(u), t = s2.uvToST(v);
        return s >= s0 && s <= s0 + d && t >= t0 && t <= t0 + d;
      }
    };
  }
});

const EARTH_AREA = 510065621.7;   // km2 on the authalic sphere
const fmtArea = (a) => a >= 100 ? Math.round(a).toLocaleString("en") + " km2" : a >= 0.01 ? a.toPrecision(3) + " km2" : (a * 1e6).toPrecision(3) + " m2";

// spherical area of a cell's quadrilateral (two triangles, l'Huilier-free:
// Van Oosterom and Strackee)
function cellArea(corners) {
  const p = corners.map(([lon, lat]) => s2.toXYZ(lon, lat));
  const tri = (a, b, c) => {
    const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    return 2 * Math.atan2(Math.abs(det), 1 + dot(a, b) + dot(b, c) + dot(c, a));
  };
  return ((tri(p[0], p[1], p[2]) + tri(p[0], p[2], p[3])) / (4 * Math.PI)) * EARTH_AREA;
}

function pickedCell() {
  const id = state.cell && s2.fromToken(state.cell);
  return id ? { id, ...s2.cellBounds(id) } : null;
}

function updatePanel(picked) {
  ui.lvl.value = state.lvl;
  const n = 6 * 4 ** state.lvl;
  ui.lvlOut.textContent = `${state.lvl} (${n.toLocaleString("en")} cells, about ${fmtArea(EARTH_AREA / n)} each)`;
  ui.t.value = state.t;
  ui.tOut.textContent = state.t === 0 ? "globe" : state.t === 0.5 ? "cube" : state.t === 1 ? "net" : state.t < 0.5 ? "to the cube" : "opening";
  ui.curve.checked = !!state.curve; ui.grid.checked = !!state.grid;
  ui.coast.checked = !!state.coast; ui.uvgrid.checked = !!state.uvgrid;
  if (document.activeElement !== ui.token) ui.token.value = state.cell;
  ui.token.classList.remove("bad");
  ui.geojson.disabled = ui.up.disabled = ui.down.disabled = !picked;
  if (!tifOut.busy) ui.tif.disabled = !picked || !basemap.world;
  if (picked) {
    ui.up.disabled = picked.level === 0; ui.down.disabled = picked.level === s2.MAX_LEVEL;
    const [lon, lat] = s2.toLonLat(s2.faceUVtoXYZ(picked.face, s2.stToUV(picked.s0 + picked.d / 2), s2.stToUV(picked.t0 + picked.d / 2)));
    ui.cellLevel.textContent = `level ${picked.level}, face ${picked.face}`;
    ui.info.textContent = `Centre ${lon.toFixed(4)}${DEG}, ${lat.toFixed(4)}${DEG}; area ${fmtArea(cellArea(picked.corners))}; id ${picked.id}.`;
  } else {
    ui.cellLevel.textContent = "";
    ui.info.textContent = "Click a cell for its token, or paste one.";
  }
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
    if (drawFaces) for (let f = 0; f < 6; f++) drawFace(f, picked);
    drawFaces = false;
    rebuildScene();
    updatePanel(picked);
  });
}

ui.lvl.addEventListener("input", () => { state.lvl = +ui.lvl.value; sync(); });
ui.t.addEventListener("input", () => { stopAnim(); state.t = +ui.t.value; sync(false); });
for (const k of ["curve", "grid", "coast", "uvgrid"])
  ui[k].addEventListener("change", () => { state[k] = ui[k].checked ? 1 : 0; sync(); });
ui.token.addEventListener("change", () => {
  const raw = ui.token.value.trim().toLowerCase();
  if (!raw) { state.cell = ""; return sync(); }
  const id = s2.fromToken(raw);
  if (!id) { ui.token.classList.add("bad"); return; }
  state.cell = s2.toToken(id);
  sync();
});
ui.up.addEventListener("click", () => {
  const c = pickedCell();
  if (c && c.level > 0) { state.cell = s2.toToken(s2.parent(c.id, c.level - 1)); sync(); }
});
ui.down.addEventListener("click", () => {
  // the child under the middle of the cell's Hilbert path: its first child
  const c = pickedCell();
  if (c && c.level < s2.MAX_LEVEL) { state.cell = s2.toToken(c.id - (c.id & -c.id) + ((c.id & -c.id) >> 2n)); sync(); }
});
ui.geojson.addEventListener("click", (e) => {
  const c = pickedCell();
  if (!c) return;
  const ring = [...c.corners, c.corners[0]].map(([x, y]) => [+x.toFixed(9), +y.toFixed(9)]);
  copy(JSON.stringify({ type: "Feature", properties: { token: s2.toToken(c.id), level: c.level, face: c.face },
    geometry: { type: "Polygon", coordinates: [ring] } }), e.target);
});
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(DEFAULT_CAM); writeHash(); });

// click (not drag) on a face picks the cell under the pointer at the current level
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
  const id = s2.cellFromFaceST(hit.object.userData.face, hit.uv.x, hit.uv.y, state.lvl);
  state.cell = s2.toToken(id);
  sync();
});

let anim = false, dir = 1, lastT = 0;
const playBtn = $("play");
function stopAnim() { anim = false; playBtn.textContent = state.t >= 1 ? "Fold" : "Unfold"; }
playBtn.addEventListener("click", () => {
  if (anim) return stopAnim();
  anim = true; dir = state.t >= 1 ? -1 : 1; playBtn.textContent = "Stop"; lastT = performance.now();
});

function copy(text, btn) {
  const done = () => { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1200); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {});
}
const pageUrl = () => location.origin + location.pathname;
$("copy-link").addEventListener("click", (e) => copy(pageUrl() + location.hash, e.target));
$("copy-embed").addEventListener("click", (e) => copy(
  `<iframe src="${pageUrl()}?embed=1${location.hash}" width="100%" height="480" style="border:0" loading="lazy" title="s2 cells"></iframe>`,
  e.target));
$("open-full").href = pageUrl() + location.hash;

// ---------------------------------------------------------------- loop

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);

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

window.addEventListener("hashchange", () => { readHash(); if (state.cam) setCamera(state.cam); basemap.set(state.bm); sync(); });

if (embed) {
  document.body.classList.add("embed");
  $("open-full").hidden = false;
}

readHash();
if (state.cam) setCamera(state.cam);
resize();
sync();
basemap.set(state.bm);
loadCoastline("110m").then((lines) => { buildCoast(lines); sync(); document.body.classList.add("ready"); });
requestAnimationFrame(tick);
