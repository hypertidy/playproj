// playproj: model grids.
//
// Each grid is one or more patches, each a regular array in index space. A
// patch is drawn on its own canvas in index space, where the model's grid is
// straight and coastlines bend, and that canvas textures a mesh whose
// vertices move in straight lines from the globe (t = 0) to the flat array
// (t = 1).

import * as THREE from "three";
import * as G from "../src/core/grids.js";
import { loadCoastline } from "./data.js";
import { graticule } from "../src/core/geo.js";
import { warpCanvas } from "./basemap-load.js";
import { basemapControl, exportControl } from "./basemap-ui.js";
import { gnomonic, polarStere, ringOf } from "../src/core/cellexport.js";
import { makeStage, readParams, hashWriter, shareLinks, copyText } from "../src/scene/index.js";

const DEG = "\u00b0";
const TEX = 2048;
const FLAT = 0.72;                 // flat array scale: radians of arc to scene units
const EARTH_AREA = 510065621.7;    // km2

const COLORS = {
  bg: 0x05070d,
  patch: ["#1c3557", "#33284f", "#1d3a3a", "#3d2a26", "#2c3a22", "#3a2c3f"],
  coast: "#d7ecff",
  grat: "rgba(140,196,255,0.35)",
  grid: "rgba(255,255,255,0.42)",
  join: "rgba(106,183,135,0.95)",
  fold: "#ff5d5d",
  pole: "#ffb347",
  pick: "#ffd34d",
  domain: "#ffd34d"
};

const KINDS = [
  { key: "rot", label: "Rotated pole" },
  { key: "tri", label: "Tripolar" },
  { key: "cube", label: "Cubed sphere" },
  { key: "yy", label: "Yin-Yang" }
];

// ---------------------------------------------------------------- state

const defaults = { g: "rot", t: 0, step: 10, plat: 39.25, plon: -162, join: 65, tlon: 80, eq: 1, coast: 1, grat: 1, cell: "", bm: "none", cam: null };
const state = { ...defaults };

function readHash() {
  readParams(state, defaults, {
    g: (raw) => (KINDS.some((x) => x.key === raw) ? raw : defaults.g),
    cell: (raw) => (/^\d+,\d+,\d+$/.test(raw) ? raw : ""),
    bm: String
  });
  const cl = (k, a, b) => { state[k] = Math.max(a, Math.min(b, state[k])); };
  cl("t", 0, 1); cl("step", 2, 30); cl("plat", 0, 90); cl("plon", -180, 180);
  cl("join", 40, 80); cl("tlon", -180, 180);
  state.step = Math.round(state.step);
}

const writeHash = hashWriter(state, defaults);

// ---------------------------------------------------------------- the grid

function makeGrid() {
  const step = state.step;
  if (state.g === "rot") return G.rotatedPole({ plon: state.plon, plat: state.plat, step });
  if (state.g === "tri") return G.tripolar({ plon: state.tlon, join: state.join, step });
  if (state.g === "cube") return G.cubedSphere({ n: Math.max(1, Math.round(90 / step)), stretch: state.eq ? "angle" : "plain" });
  return G.yinYang({ step });
}

// where each patch lies when flat: lower left corner and size, scene units
function layout(grid) {
  return grid.patches.map((p) => {
    const w = p.width * FLAT, h = p.height * FLAT;
    if (grid.kind === "cube") return { x0: (p.at[0] - 0.5) * w - w / 2, y0: p.at[1] * h - h / 2, w, h };
    if (grid.kind === "yy") return { x0: -w / 2, y0: p.name === "Yin" ? 0.06 : -h - 0.06, w, h };
    return { x0: -w / 2, y0: -h / 2, w, h };
  });
}

// ---------------------------------------------------------------- textures

let coastLines = null;
const gratLines = graticule(30, 2);

function texSize(p) {
  const a = p.width / p.height;
  return a >= 1 ? [TEX, Math.max(64, Math.round(TEX / a))] : [Math.max(64, Math.round(TEX * a)), TEX];
}

// polylines in lon/lat to a Path2D in the patch's texture pixels
function linesPath(p, lines, W, H) {
  const path = new Path2D();
  for (const l of lines) {
    let prev = null;
    for (let i = 0; i < l.length; i += 2) {
      const uv = p.toIndex(l[i], l[i + 1]);
      if (!uv || !isFinite(uv[0]) || !isFinite(uv[1])) { prev = null; continue; }
      const jump = prev && (Math.abs(uv[0] - prev[0]) > p.seam || Math.abs(uv[1] - prev[1]) > 0.25 ||
        // across the tripolar fold the arc angle turns back: both ends high, either side of the pole's column
        (p.fold !== undefined && prev[1] > p.fold && uv[1] > p.fold && (uv[0] - 0.5) * (prev[0] - 0.5) < 0));
      const x = uv[0] * W, y = (1 - uv[1]) * H;
      if (prev && !jump) path.lineTo(x, y); else path.moveTo(x, y);
      prev = uv;
    }
  }
  return path;
}

function drawPatch(grid, k, rec, picked) {
  const p = grid.patches[k], { canvas, W, H } = rec;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = COLORS.patch[grid.kind === "cube" ? k : grid.kind === "yy" ? k : 0];
  // the basemap in index space, where the model's grid is straight
  const world = basemap.world;
  if (world) {
    const f = 512 / Math.max(W, H);
    rec.bm = rec.bm || warpCanvas(world, Math.max(8, Math.round(W * f)), Math.max(8, Math.round(H * f)), (u, v) => p.fromIndex(u, v));
    ctx.drawImage(rec.bm, 0, 0, W, H);
    ctx.globalAlpha = 0.3;
  }
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;

  if (grid.kind === "cube" || grid.kind === "yy") {
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.font = `bold ${Math.min(W, H) * 0.42}px system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(grid.kind === "cube" ? String(k) : p.name, W / 2, H / 2);
  }
  if (state.grat) {
    rec.grat = rec.grat || linesPath(p, gratLines, W, H);
    ctx.strokeStyle = COLORS.grat; ctx.lineWidth = 1.5;
    ctx.stroke(rec.grat);
  }
  if (state.coast && coastLines) {
    rec.coast = rec.coast || linesPath(p, coastLines, W, H);
    ctx.strokeStyle = COLORS.coast; ctx.lineWidth = 2; ctx.globalAlpha = 0.9;
    ctx.stroke(rec.coast);
    ctx.globalAlpha = 1;
  }

  // the model's grid: straight in index space
  ctx.strokeStyle = COLORS.grid; ctx.lineWidth = p.ni > 90 ? 0.8 : 1.4;
  ctx.beginPath();
  for (let i = 0; i <= p.ni; i++) { const x = (i / p.ni) * W; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let j = 0; j <= p.nj; j++) { const y = (1 - j / p.nj) * H; ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();

  // what is special about this grid
  ctx.lineWidth = 6;
  if (grid.kind === "rot") {
    // the rotated poles are the top and bottom edges
    ctx.strokeStyle = COLORS.pole;
    ctx.beginPath(); ctx.moveTo(0, 3); ctx.lineTo(W, 3); ctx.moveTo(0, H - 3); ctx.lineTo(W, H - 3); ctx.stroke();
    // a regional domain: a rectangle near the rotated equator
    const [x0, x1, y0, y1] = G.EURO_CORDEX.win;
    ctx.strokeStyle = COLORS.domain; ctx.lineWidth = 4; ctx.setLineDash([14, 8]);
    ctx.strokeRect(((x0 + 180) / 360) * W, (1 - (y1 + 90) / 180) * H, ((x1 - x0) / 360) * W, ((y1 - y0) / 180) * H);
    ctx.setLineDash([]);
  } else if (grid.kind === "tri") {
    const yJ = (1 - p.fold) * H;
    ctx.strokeStyle = COLORS.join; ctx.lineWidth = 3; ctx.setLineDash([16, 10]);
    ctx.beginPath(); ctx.moveTo(0, yJ); ctx.lineTo(W, yJ); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = COLORS.fold; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(0, 3); ctx.lineTo(W, 3); ctx.stroke();
    ctx.fillStyle = COLORS.pole;
    for (const x of [0, 0.5, 1]) { ctx.beginPath(); ctx.arc(x * W, yJ, 14, 0, 2 * Math.PI); ctx.fill(); }
  } else if (grid.kind === "cube") {
    ctx.fillStyle = COLORS.pole;
    for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H]]) { ctx.beginPath(); ctx.arc(x, y, 18, 0, 2 * Math.PI); ctx.fill(); }
  } else {
    ctx.strokeStyle = "rgba(255,255,255,0.6)"; ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, W - 4, H - 4);
  }

  if (picked && picked.k === k) {
    const x = (picked.i / p.ni) * W, y = (1 - (picked.j + 1) / p.nj) * H;
    ctx.strokeStyle = COLORS.pick; ctx.lineWidth = 5;
    ctx.fillStyle = "rgba(255,211,77,0.3)";
    ctx.fillRect(x, y, W / p.ni, H / p.nj);
    ctx.strokeRect(x, y, W / p.ni, H / p.nj);
  }
  rec.texture.needsUpdate = true;
}

// ---------------------------------------------------------------- scene

const stage = document.getElementById("three");
const { renderer, scene, camera, controls, setCamera, resize } = makeStage(stage, {
  bg: COLORS.bg,
  onCamera: (c) => { state.cam = c; writeHash(); }
});

// a view for each grid: tripolar from above the Arctic
const DEFAULT_CAMS = { rot: [0.3, 1.5, 6.3, 0, 0, 0], tri: [0.2, 4.7, 3.7, 0, 0, 0], cube: [1.4, 1.6, 6, 0, 0, 0], yy: [1.4, 1.8, 6, 0, 0, 0] };
const defaultCam = () => DEFAULT_CAMS[state.g];
setCamera(DEFAULT_CAMS.rot);

const group = new THREE.Group();
scene.add(group);

// a dark globe under the patches, for what a grid leaves out
const under = new THREE.Mesh(new THREE.SphereGeometry(0.985, 64, 32),
  new THREE.MeshBasicMaterial({ color: 0x0a0f1c, transparent: true }));
group.add(under);

// geographic x, y, z (z north) to the scene: 0E towards the camera, east to the right
const toScene = (v, r, out) => { out[0] = v[1] * r; out[1] = v[2] * r; out[2] = v[0] * r; };

let current = null;    // { key, grid, recs }

function gridKey() {
  const s = state;
  return [s.g, s.step, s.g === "rot" ? s.plat + "," + s.plon : "", s.g === "tri" ? s.join + "," + s.tlon : "", s.g === "cube" ? s.eq : ""].join("|");
}

function rebuildGrid() {
  const key = gridKey();
  if (current && current.key === key) return false;
  if (current) for (const r of current.recs) { group.remove(r.mesh); r.mesh.geometry.dispose(); r.mesh.material.dispose(); r.texture.dispose(); }
  const grid = makeGrid(), lay = layout(grid);
  const recs = grid.patches.map((p, k) => {
    const [W, H] = texSize(p);
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    // mesh resolution: enough to follow the curves, more along the long side
    const MU = Math.max(16, Math.round(128 * Math.min(1, W / H))), MV = Math.max(16, Math.round(128 * Math.min(1, H / W)));
    const MUf = Math.max(MU, 24), MVf = Math.max(MV, 24);
    const n = (MUf + 1) * (MVf + 1);
    const sphere = new Float32Array(n * 3), flat = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    const L = lay[k], tmp = [0, 0, 0];
    // overlapping patches sit at slightly different radii so they don't fight
    const r = grid.kind === "yy" ? 1 + 0.004 * k : 1;
    for (let j = 0, m = 0; j <= MVf; j++)
      for (let i = 0; i <= MUf; i++, m++) {
        const u = i / MUf, v = j / MVf;
        toScene(G.toXYZ(...p.fromIndex(u, v)), r, tmp);
        sphere.set(tmp, 3 * m);
        flat[3 * m] = L.x0 + u * L.w; flat[3 * m + 1] = L.y0 + v * L.h; flat[3 * m + 2] = 0.002 * k;
        uv[2 * m] = u; uv[2 * m + 1] = v;
      }
    const index = [];
    for (let j = 0; j < MVf; j++)
      for (let i = 0; i < MUf; i++) {
        const a = j * (MUf + 1) + i, b = a + MUf + 1;
        index.push(a, a + 1, b, a + 1, b + 1, b);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(sphere.slice(), 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(index);
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
    mesh.userData.k = k;
    group.add(mesh);
    return { canvas, W, H, texture, mesh, sphere, flat };
  });
  // the flat arrays shrink to fit the view as they open
  const x0 = Math.min(...lay.map((l) => l.x0)), x1 = Math.max(...lay.map((l) => l.x0 + l.w));
  const y0 = Math.min(...lay.map((l) => l.y0)), y1 = Math.max(...lay.map((l) => l.y0 + l.h));
  const fit = Math.min(1, 3.6 / Math.max(x1 - x0, 1.5 * (y1 - y0)));
  current = { key, grid, recs, lay, fit };
  return true;
}

const ease = (x) => x * x * (3 - 2 * x);

function placeMeshes() {
  const e = ease(state.t);
  for (const r of current.recs) {
    const pos = r.mesh.geometry.attributes.position.array;
    for (let i = 0; i < pos.length; i++) pos[i] = r.sphere[i] + (r.flat[i] - r.sphere[i]) * e;
    r.mesh.geometry.attributes.position.needsUpdate = true;
    r.mesh.geometry.computeBoundingSphere();
  }
  group.scale.setScalar(1 + (current.fit - 1) * e);
  under.material.opacity = Math.max(0, 1 - 4 * state.t);
  under.visible = state.t < 0.25;
}

// ---------------------------------------------------------------- panel

const $ = (id) => document.getElementById(id);
const ui = {
  kinds: $("kinds"), t: $("t"), tOut: $("t-out"), step: $("step"), stepOut: $("step-out"),
  plat: $("plat"), platOut: $("plat-out"), plon: $("plon"), plonOut: $("plon-out"),
  join: $("join"), joinOut: $("join-out"), tlon: $("tlon"), tlonOut: $("tlon-out"), eq: $("eq"),
  proj: $("projstring"), describe: $("describe"), info: $("cell-info"), about: $("about"),
  coast: $("coast"), grat: $("grat"), bm: $("basemap"), tif: $("download-tif")
};

// The picked cell as a GeoTIFF in its grid's own CRS. The model grids are
// on a sphere; 6371229 m is the radius the Met Office and NEMO use.
const GRID_R = 6371229;
const basemap = basemapControl({
  select: ui.bm, status: $("bm-status"), credit: $("credit"),
  onWorld: () => { if (current) for (const r of current.recs) r.bm = null; sync(); }
});
const lonlat = { forward: (a, b) => [a, b], inverse: (a, b) => [a, b] };
const obString = (o) => `+proj=ob_tran +o_proj=longlat +o_lat_p=${num(o.oLatP)} +o_lon_p=${num(o.oLonP)} +lon_0=${num(o.lon0)} +R=${GRID_R}`;
function cellJob() {
  const c = pickedCell();
  if (!c) return null;
  const { k, i, j, p } = c, kind = current.grid.kind;
  const ring = ringOf((a, b) => p.fromIndex((i + a) / p.ni, (j + b) / p.nj));
  const base = { name: `playproj-${kind}-${kind === "cube" || kind === "yy" ? p.name.replace(" ", "") + "-" : ""}i${i}-j${j}`, ring };
  if (kind === "rot" || (kind === "yy" && p.name === "Yang")) {
    const o = kind === "rot" ? G.cfToObTran(state.plon, state.plat) : G.YANG, ob = G.obTran(o);
    return { ...base, crs: { proj: obString(o), R: GRID_R }, forward: ob.forward, inverse: ob.inverse, periodX: 360 };
  }
  if (kind === "yy" || (kind === "tri" && j + 1 <= current.grid.nS))
    return { ...base, crs: { geographic: true }, ...lonlat, periodX: 360 };
  if (kind === "cube") {
    const m = /lat_0=(\S+) \+lon_0=(\S+)/.exec(G.cubeFaceProj(k)), g = gnomonic(+m[1], +m[2]);
    return { ...base, crs: { proj: `${G.cubeFaceProj(k)} +R=${GRID_R}`, R: GRID_R }, scale: GRID_R, forward: g.forward, inverse: g.inverse };
  }
  // a cap cell of the tripolar grid has no CRS of its own: polar
  // stereographic, masked to the cell
  const ps = polarStere(false, 0), eps = 1e-9;
  return {
    ...base, crs: { proj: `+proj=stere +lat_0=90 +lon_0=0 +k=1 +R=${GRID_R}`, R: GRID_R }, scale: GRID_R,
    forward: ps.forward, inverse: ps.inverse,
    inside: (lon, lat) => {
      const uv = p.toIndex(lon, lat);
      if (!uv) return false;
      const u = uv[0] * p.ni, v = uv[1] * p.nj;
      return u >= i - eps && u <= i + 1 + eps && v >= j - eps && v <= j + 1 + eps;
    }
  };
}
const tifOut = exportControl({ button: ui.tif, size: $("tif-size"), status: $("bm-status"), bm: () => basemap.id, job: cellJob });
for (const k of KINDS) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = k.label; b.dataset.kind = k.key;
  b.addEventListener("click", () => {
    state.g = k.key; state.cell = "";
    if (!state.cam) setCamera(defaultCam());
    sync();
  });
  ui.kinds.appendChild(b);
}

const fmtLon = (x) => `${Math.abs(x).toFixed(Math.abs(x) % 1 ? 2 : 0)}${DEG}${x < 0 ? "W" : x > 0 ? "E" : ""}`;
const fmtLat = (x) => `${Math.abs(x).toFixed(Math.abs(x) % 1 ? 2 : 0)}${DEG}${x < 0 ? "S" : x > 0 ? "N" : ""}`;
const fmtArea = (a) => a >= 100 ? Math.round(a).toLocaleString("en") + " km2" : a.toPrecision(3) + " km2";
const num = (x) => +x.toFixed(4);

const ABOUT = {
  rot: `<p>Turn the lat/lon grid so its pole sits somewhere else, and a region of interest lands on the
    new equator, where the cells are nearly square. Regional climate models do this: the dashed box is
    the EURO-CORDEX domain, a plain rectangle in rotated coordinates that is Europe when the pole is at
    39.25${DEG}N 162${DEG}W. Rotated poles are PROJ's <code>ob_tran</code>, the same oblique aspect
    that turns Mercator into <a href="./cones.html">Oblique Mercator</a>.</p>
    <p>The two poles are still there, now as the top and bottom edges of the array.</p>`,
  tri: `<p>An ocean model has no use for a pole in the Arctic Ocean, where cells would shrink to nothing
    and limit the time step. A tripolar grid keeps the ordinary south pole, under Antarctica, and
    replaces the north pole with two poles on land, here on the join latitude.</p>
    <p>South of the join (green) the grid is Mercator-spaced lat/lon. North of it is Murray's (1996)
    bipolar cap, as GFDL's MOM builds it: a lat/lon grid on a second sphere whose poles sit on its
    equator, carried onto the cap by stereographic projection. It stays orthogonal, and its circles
    round each pole carry on the meridians from the south. The top row (red) is the arc from pole to
    pole across the Arctic: the grid folds there, so the left half of the top row is the right half
    reversed, and the Arctic coast appears twice. NEMO's ORCA grids are tripolar too, built
    differently (Madec and Imbard 1996), with the poles further south.</p>`,
  cube: `<p>Put a cube round the globe and cast every point onto a face from the centre: six gnomonic
    projections, each one a square array. Spacing the cells at equal angles from the centre, as the
    FV3 model does, evens out their sizes; the same cube with a quadratic stretch is
    <a href="./cells.html">S2</a>. Untick Equal angles for even steps on the face, and the corner cells
    shrink.</p>
    <p>There are no poles; instead the eight corners of the cube are points where three faces meet,
    and cells there have 120${DEG} corners.</p>`,
  yy: `<p>Take the low-latitude part of a lat/lon grid, longitude within 135${DEG} and latitude within
    45${DEG}, where the cells are nearly square. Take a second copy turned on its side. Together the two
    cover the sphere with a little overlap (Kageyama and Sato 2004), and neither has a pole.</p>
    <p>No single grid can do that. Yang is a rotated-pole grid with its pole on the equator at
    90${DEG}E; the model passes values between the two across the overlap.</p>`
};

function pickedCell() {
  if (!state.cell || !current) return null;
  const [k, i, j] = state.cell.split(",").map(Number), p = current.grid.patches[k];
  if (!p || i >= p.ni || j >= p.nj) return null;
  return { k, i, j, p };
}

function updatePanel(picked) {
  for (const b of ui.kinds.children) b.classList.toggle("active", b.dataset.kind === state.g);
  ui.t.value = state.t;
  ui.tOut.textContent = state.t === 0 ? "globe" : state.t === 1 ? "array" : "unfolding";
  ui.step.value = state.step;
  const grid = current.grid, cells = grid.patches.reduce((s, p) => s + p.ni * p.nj, 0);
  const size = grid.patches.map((p) => `${p.ni} x ${p.nj}`);
  ui.stepOut.textContent = (grid.kind === "cube" ? `${(90 / grid.patches[0].ni).toFixed(1)}${DEG}` : `${state.step}${DEG}`) +
    ` (${grid.kind === "cube" ? "6 x " + size[0] : grid.kind === "yy" ? "2 x " + size[0] : size[0]}, ${cells.toLocaleString("en")} cells)`;
  $("rot-ctl").hidden = state.g !== "rot";
  $("tri-ctl").hidden = state.g !== "tri";
  $("cube-ctl").hidden = state.g !== "cube";
  ui.plat.value = state.plat; ui.platOut.textContent = fmtLat(state.plat);
  ui.plon.value = state.plon; ui.plonOut.textContent = fmtLon(state.plon);
  ui.join.value = state.join; ui.joinOut.textContent = fmtLat(state.join);
  ui.tlon.value = state.tlon; ui.tlonOut.textContent = `${fmtLon(state.tlon)} and ${fmtLon(((state.tlon + 360) % 360) - 180)}`;
  ui.eq.checked = !!state.eq; ui.coast.checked = !!state.coast; ui.grat.checked = !!state.grat;

  ui.proj.classList.remove("none");
  if (grid.kind === "rot") {
    const o = G.cfToObTran(state.plon, state.plat);
    ui.proj.textContent = `+proj=ob_tran +o_proj=longlat +o_lat_p=${num(o.oLatP)} +o_lon_p=0 +lon_0=${num(o.lon0)}`;
    ui.describe.textContent = `CF: grid_mapping_name = "rotated_latitude_longitude", grid_north_pole_latitude = ${num(state.plat)}, grid_north_pole_longitude = ${num(state.plon)}.`;
  } else if (grid.kind === "tri") {
    ui.proj.textContent = "no PROJ string: the model stores lon and lat for every cell";
    ui.proj.classList.add("none");
    ui.describe.textContent = `Mercator spacing south of ${fmtLat(state.join)}; a bipolar cap north of it with poles at ` +
      `${fmtLat(state.join)} ${fmtLon(G.tripolar({ plon: state.tlon }).poles[0][0])} and ${fmtLon(G.tripolar({ plon: state.tlon }).poles[1][0])}, folded along the arc between them.`;
  } else if (grid.kind === "cube") {
    const f = picked ? picked.k : 0;
    ui.proj.textContent = G.cubeFaceProj(f);
    ui.describe.textContent = `Face ${f} of six; the cells are ${state.eq ? "even steps in the angle atan(x), atan(y)" : "even steps in x, y on the face"}.`;
  } else {
    const y = G.YANG;
    ui.proj.textContent = `+proj=ob_tran +o_proj=longlat +o_lat_p=${y.oLatP} +o_lon_p=${y.oLonP} +lon_0=${y.lon0}`;
    ui.describe.textContent = "That is Yang, the lower array; Yin, the upper one, is plain lon/lat. Each covers longitude -135 to 135 and latitude -45 to 45 in its own frame.";
  }
  ui.about.innerHTML = ABOUT[grid.kind];

  if (picked) {
    const { p, i, j } = picked;
    const [lon, lat] = p.fromIndex((i + 0.5) / p.ni, (j + 0.5) / p.nj);
    const area = (G.quadArea(G.cellCorners(p, i, j)) / (4 * Math.PI)) * EARTH_AREA;
    const ang = G.cellAngle(p, i, j);
    ui.info.textContent = `${grid.patches.length > 1 ? p.name + " " : ""}cell i ${i}, j ${j}: centre ${lon.toFixed(3)}${DEG}, ${lat.toFixed(3)}${DEG}; ` +
      `area ${fmtArea(area)}; grid lines meet at ${ang.toFixed(1)}${DEG}.`;
  } else ui.info.textContent = "Click a cell for its index, centre and area.";
  if (!tifOut.busy) ui.tif.disabled = !picked || !basemap.world;
}

let rafPending = false, redraw = true;
function sync(textures = true) {
  writeHash();
  redraw = redraw || textures;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (rebuildGrid()) redraw = true;
    const picked = pickedCell();
    if (redraw) current.recs.forEach((r, k) => drawPatch(current.grid, k, r, picked));
    redraw = false;
    placeMeshes();
    updatePanel(picked);
  });
}

ui.t.addEventListener("input", () => { stopAnim(); state.t = +ui.t.value; sync(false); });
for (const k of ["step", "plat", "plon", "join", "tlon"])
  ui[k].addEventListener("input", () => { state[k] = +ui[k].value; state.cell = ""; sync(); });
for (const k of ["eq", "coast", "grat"])
  ui[k].addEventListener("change", () => { state[k] = ui[k].checked ? 1 : 0; sync(); });
$("cordex").addEventListener("click", () => { state.plat = G.EURO_CORDEX.plat; state.plon = G.EURO_CORDEX.plon; state.cell = ""; sync(); });
$("unrotated").addEventListener("click", () => { state.plat = 90; state.plon = -180; state.cell = ""; sync(); });
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(defaultCam()); writeHash(); });
$("copy-proj").addEventListener("click", (e) => copyText(ui.proj.textContent, e.target));

// click (not drag) on the grid picks the cell under the pointer
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObjects(current.recs.map((x) => x.mesh))[0];
  if (!hit) return;
  const k = hit.object.userData.k, p = current.grid.patches[k];
  const i = Math.min(p.ni - 1, Math.floor(hit.uv.x * p.ni)), j = Math.min(p.nj - 1, Math.floor(hit.uv.y * p.nj));
  const cell = `${k},${i},${j}`;
  state.cell = state.cell === cell ? "" : cell;
  sync();
});

let anim = false, dir = 1, lastT = 0;
const playBtn = $("play");
function stopAnim() { anim = false; playBtn.textContent = state.t >= 1 ? "Fold" : "Unfold"; }
playBtn.addEventListener("click", () => {
  if (anim) return stopAnim();
  anim = true; dir = state.t >= 1 ? -1 : 1; playBtn.textContent = "Stop"; lastT = performance.now();
});

shareLinks("Model grids");

// ---------------------------------------------------------------- loop

function tick(now) {
  if (anim) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    state.t = Math.max(0, Math.min(1, state.t + dir * dt * 0.3));
    if (state.t === 1 || state.t === 0) stopAnim();
    sync(false);
  }
  lastT = now;
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

ui.bm.addEventListener("change", () => { state.bm = ui.bm.value; writeHash(); basemap.set(state.bm); });

window.addEventListener("hashchange", () => { readHash(); setCamera(state.cam || defaultCam()); basemap.set(state.bm); sync(); });

readHash();
setCamera(state.cam || defaultCam());
resize();
sync();
basemap.set(state.bm);
loadCoastline("110m").then((lines) => {
  coastLines = lines;
  if (current) for (const r of current.recs) r.coast = null;
  sync();
  document.body.classList.add("ready");
});
requestAnimationFrame(tick);
