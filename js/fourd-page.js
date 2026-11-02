// playproj: Time and depth.
//
// Several time series on one globe on one date. Each layer is an array with
// a time axis and, for an ocean model, a depth axis, read in place from a
// virtual store (byte references into the original files). The clock is a
// date; each layer shows its own nearest time step. Surface layers (sea ice,
// SST) are textures on a mesh placed through the grid's own CRS. An ocean
// layer is read over a box, every level down to a chosen depth, and drawn as
// a shell sunk below the surface by its depth times the exaggeration, and two
// sections through the box. The registry (data/fourd/stores.json) names
// where the index lives; src/core/fourd.js holds the axes, the clock and the
// cache; js/fourd-read.js reads.

import * as THREE from "three";
import * as F from "../src/core/fourd.js";
import * as R from "./fourd-read.js";
import { PALETTES, rampAt } from "../src/core/palette.js";
import { loadCoastline } from "./data.js";
import * as spilhaus from "../src/core/families/spilhaus.js";
import { makeStage, readParams, hashWriter, shareLinks, oneOf } from "../src/scene/index.js";

const proj4 = window.proj4;
const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";
const D2R = Math.PI / 180;
const DAY = 86400000;
const AHEAD = 3;
const COLORS = { bg: 0x05070d, base: 0x1b2433, coast: 0xd7ecff, box: 0xffd34d, pick: 0xff7ab8 };
const STEPS = ["day", "5day", "month", "year"];

// ---------------------------------------------------------------- state

const defaults = {
  date: "2025-09-15", layers: "oisst-sst,g02202-south,bran-temp", box: "60,90,-70,-45",
  lev: 30, zmax: 3, dz: 3, cl: 0.5, cp: 0.5, cut: 1, coast: 1, step: "day", base: "", view: "globe", t: 1, range: 20000, clon: null, clat: null, cam: null
};
const state = { ...defaults };
function readHash() {
  const num = (r) => (r === "" || !isFinite(+r) ? undefined : +r);
  readParams(state, defaults, { date: (r) => (F.parseDay(r) !== null ? r : undefined), layers: String, box: String, base: String, step: oneOf(STEPS, "day"),
    view: oneOf(["globe", "aeqd", "spilhaus"], "globe"), clon: num, clat: num });
  state.t = Math.max(0, Math.min(1, state.t));
  state.range = Math.max(100, Math.min(20000, state.range));
  state.zmax = Math.max(1, Math.min(3.7, state.zmax));
  state.dz = Math.max(0, Math.min(3, state.dz));
  state.cl = Math.max(0, Math.min(1, state.cl));
  state.cp = Math.max(0, Math.min(1, state.cp));
  state.lev = Math.max(0, Math.round(state.lev));
}
const writeHash = hashWriter(state, defaults);
readHash();

const ui = {
  date: $("date"), dateOut: $("date-out"), dateText: $("date-text"), play: $("play"), back: $("back"), fwd: $("fwd"), step: $("step"),
  loading: $("loading"), layers: $("layers").tBodies[0], cut: $("cut"), coast: $("coast"),
  box: $("box"), boxGo: $("box-go"), lev: $("lev"), levOut: $("lev-out"), zmax: $("zmax"), zmaxOut: $("zmax-out"),
  dz: $("dz"), dzOut: $("dz-out"), cl: $("cl"), clOut: $("cl-out"), cp: $("cp"), cpOut: $("cp-out"),
  pick: $("pick-table").tBodies[0], profile: $("profile"), pickHint: $("pick-hint"),
  view: $("view"), t: $("t"), tOut: $("t-out"), range: $("range"), rangeOut: $("range-out"), centrePick: $("centre-pick"), centreBox: $("centre-box"),
  probe: $("probe"), reset: $("reset-view"), hosts: $("hosts").tBodies[0], status: $("status"), credit: $("credit")
};

const dayOf = (ms) => Math.floor(ms / DAY);
const exag = () => 10 ** state.dz;
const zmaxM = () => 10 ** state.zmax;
function parseBox(s) {
  const b = String(s).split(",").map(Number);
  if (b.length !== 4 || !b.every(isFinite) || b[3] <= b[2] || b[2] < -90 || b[3] > 90) return null;
  if (b[1] <= b[0]) b[1] += 360;
  return b;
}
let box = parseBox(state.box) || parseBox(defaults.box);

// ---------------------------------------------------------------- stage

const { renderer, scene: world, camera, controls, setCamera, resize } = makeStage($("three"), {
  bg: COLORS.bg, fov: 35, near: 0.01, far: 100,
  onCamera: (cam) => { state.cam = cam; writeHash(); }
});
controls.minDistance = 0.02;
controls.maxDistance = 12;

// lon, lat (degrees) and a radius to a point on the Earth, y up (the pole),
// lon 0 towards +x
function toVec(lon, lat, r, out = new THREE.Vector3()) {
  const c = Math.cos(lat * D2R);
  return out.set(r * c * Math.cos(lon * D2R), r * Math.sin(lat * D2R), -r * c * Math.sin(lon * D2R));
}
function fromVec(p) {
  const r = p.length();
  return { lon: Math.atan2(-p.z, p.x) / D2R, lat: Math.asin(p.y / r) / D2R, r };
}

// ---------------------------------------------------------------- where things go
//
// Every vertex is kept as (lon, lat, r) and placed in a frame on the view's
// centre: x east, y north, z up, with the centre on the surface at the
// origin. On the globe that is the sphere turned to face the viewer; on a
// map it is the projection's (x, y) in Earth radii and z = r - 1, so depth
// goes down from the plane by the same exaggeration. Unfold (t) moves every
// vertex in a straight line between the two. Only what lies within the range
// of the centre is drawn, and on a map a triangle or line that would cross
// a cut of the projection (the antipode, the edge of the Spilhaus square)
// is left out.

const root = new THREE.Group();
root.rotation.x = -Math.PI / 2; // the frame's z up is three.js's y up
world.add(root);

const VIEWS = ["globe", "aeqd", "spilhaus"];
const view = { key: "globe", E: new THREE.Vector3(), N: new THREE.Vector3(), U: new THREE.Vector3(), cosRange: -2, flat: null, lon0: 0, lat0: 0 };
function setView() {
  view.key = state.view;
  let lon0, lat0;
  if (view.key === "spilhaus") { lon0 = spilhaus.defaults.lon0; lat0 = spilhaus.defaults.lat0; }
  else { lon0 = state.clon ?? (box[0] + box[1]) / 2; lat0 = state.clat ?? (box[2] + box[3]) / 2; }
  view.lon0 = lon0; view.lat0 = lat0;
  toVec(lon0, lat0, 1, view.U);
  view.N.set(0, 1, 0).sub(view.U.clone().multiplyScalar(view.U.y));
  if (view.N.lengthSq() < 1e-12) view.N.set(-1, 0, 0);
  view.N.normalize();
  view.E.crossVectors(view.N, view.U).normalize();
  view.cosRange = state.range >= 20000 ? -2 : Math.cos((state.range * 1000) / F.EARTH_R);
  if (view.key === "aeqd") {
    // azimuthal equidistant on the sphere, in Earth radii: the distance from
    // the centre is kept along every great circle through it
    const s0 = Math.sin(lat0 * D2R), c0 = Math.cos(lat0 * D2R);
    view.flat = (lon, lat) => {
      const sp = Math.sin(lat * D2R), cp = Math.cos(lat * D2R), dl = (lon - lon0) * D2R, cl = Math.cos(dl);
      const cc = Math.max(-1, Math.min(1, s0 * sp + c0 * cp * cl)), c = Math.acos(cc);
      if (c > Math.PI - 1e-6) return null;
      const k = c < 1e-9 ? 1 : c / Math.sin(c);
      return [k * cp * Math.sin(dl), k * (c0 * sp - s0 * cp * cl)];
    };
  } else if (view.key === "spilhaus") {
    view.flat = (lon, lat) => { const q = spilhaus.project(lon, lat); return q && isFinite(q[0]) && isFinite(q[1]) ? [q[0], q[1]] : null; };
  } else view.flat = null;
}

setView();

const placed = new Set();
const v3a = new THREE.Vector3();
// the two homes of (lon, lat, r): on the turned globe and on the map, or
// null when it is out of range or off the map
function homes(lon, lat, r) {
  toVec(lon, lat, 1, v3a);
  if (v3a.dot(view.U) < view.cosRange) return null;
  const g = [r * v3a.dot(view.E), r * v3a.dot(view.N), r * v3a.dot(view.U) - 1];
  if (!view.flat) return { g, f: g };
  const q = view.flat(lon, lat);
  if (!q || !isFinite(q[0]) || !isFinite(q[1])) return null;
  return { g, f: [q[0], q[1], r - 1] };
}
// work out both homes of every vertex and which triangles (or segments) to
// draw; then blend() places them for the current unfold
function layout(geo) {
  const { llr, prims, per } = geo.userData, n = llr.length / 3;
  const G = new Float32Array(n * 3), Fl = new Float32Array(n * 3), ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const lon = llr[3 * i], lat = llr[3 * i + 1];
    const h = lon === lon && lat === lat ? homes(lon, lat, llr[3 * i + 2]) : null;
    if (!h) continue;
    ok[i] = 1;
    G.set(h.g, 3 * i); Fl.set(h.f, 3 * i);
  }
  const cut = view.flat ? 0.35 : Infinity, keep = [];
  for (let k = 0; k < prims.length; k += per) {
    let good = true;
    for (let a = 0; a < per && good; a++) {
      const i = prims[k + a];
      if (!ok[i]) good = false;
      else for (let b = a + 1; b < per && good; b++) {
        const j = prims[k + b];
        if (Math.hypot(Fl[3 * i] - Fl[3 * j], Fl[3 * i + 1] - Fl[3 * j + 1]) > cut) good = false;
      }
    }
    if (good) for (let a = 0; a < per; a++) keep.push(prims[k + a]);
  }
  geo.userData.G = G; geo.userData.F = Fl;
  geo.setIndex(keep);
  blend(geo);
}
function blend(geo) {
  const { G, F: Fl } = geo.userData, pos = geo.attributes.position.array, t = view.flat ? state.t : 0;
  for (let i = 0; i < pos.length; i++) pos[i] = G[i] + (Fl[i] - G[i]) * t;
  geo.attributes.position.needsUpdate = true;
  geo.computeBoundingSphere();
}
function placedGeometry(llr, prims, per, uv = null) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(llr.length), 3));
  if (uv) g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.userData = { llr, prims, per };
  placed.add(g);
  layout(g);
  return g;
}
function dropGeometry(g) { placed.delete(g); g.dispose(); }
const relayout = () => { setView(); for (const g of placed) layout(g); placeMarker(); };
const reblend = () => { for (const g of placed) blend(g); placeMarker(); };
// one point placed for the current view and unfold, or null
function placePoint(lon, lat, r, out = new THREE.Vector3()) {
  const h = homes(lon, lat, r);
  if (!h) return null;
  const t = view.flat ? state.t : 0;
  return out.set(h.g[0] + (h.f[0] - h.g[0]) * t, h.g[1] + (h.f[1] - h.g[1]) * t, h.g[2] + (h.f[2] - h.g[2]) * t);
}

// A mesh over a grid of (u, v) in [0, 1], placed by at(u, v) -> [lon, lat, r];
// uv runs with u and v, so a texture of the grid's cells drapes onto it.
function gridGeometry(nu, nv, at) {
  const n = (nu + 1) * (nv + 1), llr = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let p = 0, q = 0;
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const u = i / nu, v = j / nv, [lon, lat, r] = at(u, v);
    const bad = lon === null || !isFinite(lon) || !isFinite(lat);
    llr[p++] = bad ? NaN : lon; llr[p++] = bad ? NaN : lat; llr[p++] = r;
    uv[q++] = u; uv[q++] = v;
  }
  const idx = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    idx.push(a, b, d, a, d, c);
  }
  return placedGeometry(llr, idx, 3, uv);
}
// line segments from a flat list of [lon, lat, r] pairs
function lineGeometry(pairs) {
  const llr = Float32Array.from(pairs);
  return placedGeometry(llr, Array.from({ length: llr.length / 3 }, (_, i) => i), 2);
}

function defaultCamera() {
  // the target is the centre (the origin of the frame); the eye stands off
  // to the equator side of a box on the globe, low enough to see down its
  // sections, and south of the centre over a map, so north is up
  let s, p;
  if (view.key === "spilhaus") p = [0, -0.6, 6.8];
  else if (view.key === "aeqd" && state.t > 0.5) { s = Math.min(3, Math.max(0.2, (state.range * 1000) / F.EARTH_R)); p = [0, -1.3 * s, 2.2 * s]; }
  else {
    s = Math.max(0.15, (box[3] - box[2]) * D2R * 1.6);
    const toEq = view.lat0 < 0 ? 1 : -1;
    p = [-0.6 * s, 0.95 * s * toEq, 0.45 * s];
  }
  // frame (x, y, z) to three.js (x, z, -y), as root is turned
  return [p[0], p[2], -p[1], 0, 0, 0];
}

// The coordinate of an axis at a fractional cell index (cell i spans i to
// i + 1, its centre at i + 0.5), linear between centres and beyond the ends.
function axisAt(ax, e) {
  const v = ax.values, n = v.length, c = e - 0.5;
  if (n === 1) return v[0];
  const i = Math.max(0, Math.min(n - 2, Math.floor(c)));
  return v[i] + (v[i + 1] - v[i]) * (c - i);
}
// The cell index nearest a coordinate, or -1 outside the axis.
function cellOf(ax, x) {
  const v = ax.values, n = v.length;
  const step = n > 1 ? v[1] - v[0] : 1;
  const i = Math.round((x - v[0]) / step);
  if (ax.affine || n < 3) return i >= 0 && i < n ? i : -1;
  const asc = v[n - 1] > v[0];
  const { index, outside } = F.nearestIndex(asc ? v : Float64Array.from(v).reverse(), x);
  return outside ? -1 : asc ? index : n - 1 - index;
}
// depth edges of levels 0..nk-1 (m): 0, the midpoints, a half step past the last
function depthEdges(z, nk) {
  const e = [0];
  for (let k = 1; k < nk; k++) e.push((z[k - 1] + z[k]) / 2);
  e.push(nk > 1 ? z[nk - 1] + (z[nk - 1] - z[nk - 2]) / 2 : 2 * z[0]);
  return e;
}

function makeTexture(w, h) {
  const t = new THREE.DataTexture(new Uint8Array(w * h * 4), w, h, THREE.RGBAFormat);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
const cutout = (map) => new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide, alphaTest: 0.5 });

// values (row major, w by h) into a texture through the layer's palette;
// NaN, values below the range when the layer clears them, and cells the mask
// hides are transparent
function paint(tex, values, entry, get = (i) => values[i], mask = null) {
  const { width: w, height: h, data } = tex.image;
  const stops = PALETTES[entry.palette] || PALETTES.viridis, [lo, hi] = entry.range;
  const clear = entry.below === "clear";
  for (let i = 0, n = w * h; i < n; i++) {
    const v = get(i), o = i * 4;
    if (v !== v || (clear && v < lo) || (mask && mask[i])) { data[o + 3] = 0; continue; }
    const c = rampAt(stops, (v - lo) / (hi - lo));
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
  }
  tex.needsUpdate = true;
}
const cssStops = (entry) => (PALETTES[entry.palette] || PALETTES.viridis).map((c) => `rgb(${c.join(",")})`).join(",");

const inBox = (lon, lat) => {
  if (lat < box[2] || lat > box[3]) return false;
  const l = ((((lon - box[0]) % 360) + 360) % 360);
  return l <= box[1] - box[0];
};

// ---------------------------------------------------------------- base globe

// an opaque sphere just under the surface layers (land shows through where a
// layer has no data), cut open over the box so the ocean below shows
let base = null;
function buildBase() {
  if (base) { root.remove(base); dropGeometry(base.geometry); base.material.map.dispose(); }
  const w = 720, h = 360, tex = makeTexture(w, h), d = tex.image.data;
  const c = new THREE.Color(COLORS.base);
  const active = activeLayers().some((L) => L.entry.kind === "volume" && L.visible);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const o = (j * w + i) * 4, lon = -180 + (i + 0.5) / 2, lat = -90 + (j + 0.5) / 2;
    d[o] = c.r * 255; d[o + 1] = c.g * 255; d[o + 2] = c.b * 255;
    d[o + 3] = state.cut && active && inBox(lon, lat) ? 0 : 255;
  }
  tex.needsUpdate = true;
  base = new THREE.Mesh(gridGeometry(180, 90, (u, v) => [-180 + 360 * u, -90 + 180 * v, 0.998]), cutout(tex));
  base.renderOrder = 0;
  root.add(base);
}

let coastLines = null;
loadCoastline("110m").then((lines) => {
  const pts = [];
  for (const l of lines) for (let i = 0; i + 3 < l.length; i += 2) pts.push(l[i], l[i + 1], 1.0025, l[i + 2], l[i + 3], 1.0025);
  const g = lineGeometry(pts);
  coastLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: COLORS.coast, transparent: true, opacity: 0.55 }));
  coastLines.visible = !!state.coast;
  root.add(coastLines);
}).catch(() => {});

// ---------------------------------------------------------------- layers

let registry = null, baseUrl = "";
const layers = new Map(); // id -> layer
const reader = R.makeReader({ budget: 384 * 2 ** 20 });
const activeIds = () => state.layers.split(",").filter((id) => layers.has(id));
const activeLayers = () => activeIds().map((id) => layers.get(id));

function newLayer(entry) {
  return { entry, ds: null, opening: null, error: "", group: new THREE.Group(), parts: null, visible: false, shown: null, status: "" };
}

async function openLayer(L) {
  if (L.ds) return L.ds;
  if (!L.opening) L.opening = R.openDataset(L.entry, baseUrl).then((ds) => { L.ds = ds; buildParts(L); return ds; },
    (e) => { L.error = e.message || String(e); L.opening = null; throw e; });
  return L.opening;
}

// the time span of a layer, as days
const spanOf = (L) => L.ds && L.ds.desc.axes.t ? [dayOf(L.ds.desc.axes.t.dates[0]), dayOf(L.ds.desc.axes.t.dates.at(-1))] : null;

// what a layer reads for a date: its time index and the window
function readPlan(L, ms) {
  const d = L.ds.desc, tt = F.timeAt(d, ms);
  if (tt.index === null) return null;
  const outside = tt.outside || Math.abs(tt.offsetDays) > 3 * Math.max(1, typicalStep(d));
  return { tt, outside, k: L.parts.k, w: L.parts.w };
}
function typicalStep(d) {
  const t = d.axes.t.dates;
  return t.length > 1 ? (t.at(-1) - t[0]) / (t.length - 1) / DAY : 1;
}

// geometry for a layer: a surface mesh over its whole grid, or for an ocean
// layer the window over the box and its shell and two sections
function buildParts(L) {
  for (const c of [...L.group.children]) { L.group.remove(c); dropGeometry(c.geometry); if (c.material.map) c.material.map.dispose(); c.material.dispose(); }
  const d = L.ds.desc, e = L.entry, ax = d.axes;
  if (!ax.x || !ax.y) { L.error = "no horizontal axes"; return; }
  let toLonLat = (x, y) => [x, y];
  if (e.crs) {
    const P = proj4(e.crs, "WGS84");
    toLonLat = (x, y) => { const q = P.forward([x, y]); return isFinite(q[0]) && isFinite(q[1]) ? q : [null, null]; };
  }
  if (e.kind !== "volume") {
    const w = [0, ax.y.n, 0, ax.x.n], nx = ax.x.n, ny = ax.y.n;
    const tex = makeTexture(nx, ny);
    const lift = 1 + 0.0012 * (1 + (e.lift || 0));
    const nu = Math.min(nx, e.crs ? 120 : 360), nv = Math.min(ny, e.crs ? 120 : 180);
    const geo = gridGeometry(nu, nv, (u, v) => { const [lon, lat] = toLonLat(axisAt(ax.x, u * nx), axisAt(ax.y, v * ny)); return [lon, lat, lift]; });
    const mesh = new THREE.Mesh(geo, cutout(tex));
    mesh.userData.layer = L;
    L.group.add(mesh);
    // the centre of every cell, for the cut over the box
    const centres = new Float32Array(nx * ny * 2);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const [lon, lat] = toLonLat(ax.x.values[i], ax.y.values[j]);
      centres[(j * nx + i) * 2] = lon === null ? NaN : lon; centres[(j * nx + i) * 2 + 1] = lat === null ? NaN : lat;
    }
    L.parts = { kind: "surface", w, k: 0, tex, mesh, centres, toLonLat, nx, ny };
  } else {
    if (e.crs) { L.error = "an ocean layer in a projected CRS is not drawn yet"; return; }
    const wy = F.windowOf(ax.y, box[2], box[3]), wx = F.windowOf(ax.x, box[0], box[1], { lon: true });
    if (!wy || !wx) { L.error = "the box is outside this grid"; L.parts = null; return; }
    const z = ax.z ? ax.z.values : Float64Array.of(0);
    let nk = 1;
    while (nk < z.length && z[nk] <= zmaxM()) nk++;
    const ny = wy[1] - wy[0], nx = wx[1] - wx[0];
    const lev = Math.min(state.lev, nk - 1);
    const edges = depthEdges(z, nk), X = exag();
    const lonAt = (u) => axisAt(ax.x, wx[0] + u * nx), latAt = (v) => axisAt(ax.y, wy[0] + v * ny);
    const shellTex = makeTexture(nx, ny);
    const shell = new THREE.Mesh(gridGeometry(Math.min(nx, 240), Math.min(ny, 240), (u, v) => [lonAt(u), latAt(v), F.depthRadius(z[lev], X)]), cutout(shellTex));
    const ci = Math.min(nx - 1, Math.round(state.cl * (nx - 1))), rj = Math.min(ny - 1, Math.round(state.cp * (ny - 1)));
    const lonC = ax.x.values[wx[0] + ci], latC = ax.y.values[wy[0] + rj];
    const rAt = (v) => { const k = v * nk, i = Math.min(nk - 1, Math.floor(k)); return F.depthRadius(edges[i] + (edges[i + 1] - edges[i]) * (k - i), X); };
    // vertical sections, all levels: along a meridian at column c (cells
    // along y) or a parallel at row r (cells along x); the four walls of the
    // box and the two that move across it
    const sections = [];
    const section = (along, at) => {
      const n = along === "m" ? ny : nx, tex = makeTexture(n, nk);
      const lonS = along === "m" ? (u) => axisAt(ax.x, wx[0] + at + 0.5) : lonAt;
      const latS = along === "m" ? latAt : () => axisAt(ax.y, wy[0] + at + 0.5);
      const mesh = new THREE.Mesh(gridGeometry(Math.min(n, 240), nk, (u, v) => [lonS(u), latS(u), rAt(v)]), cutout(tex));
      sections.push({ along, at, tex, mesh });
    };
    section("m", 0); section("m", nx - 1); section("p", 0); section("p", ny - 1);
    section("m", ci); section("p", rj);
    // the box's rim at the surface and at the deepest edge
    const rim = [];
    for (const r of [1.0015, F.depthRadius(edges[nk], X)]) {
      const ring = [];
      for (let s = 0; s <= 64; s++) ring.push([lonAt(s / 64), latAt(0)]);
      for (let s = 0; s <= 64; s++) ring.push([lonAt(1), latAt(s / 64)]);
      for (let s = 64; s >= 0; s--) ring.push([lonAt(s / 64), latAt(1)]);
      for (let s = 64; s >= 0; s--) ring.push([lonAt(0), latAt(s / 64)]);
      for (let s = 0; s + 1 < ring.length; s++) rim.push(ring[s][0], ring[s][1], r, ring[s + 1][0], ring[s + 1][1], r);
    }
    const rg = lineGeometry(rim);
    const rimLines = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: COLORS.box, transparent: true, opacity: 0.6 }));
    for (const m of [shell, ...sections.map((q) => q.mesh)]) { m.userData.layer = L; L.group.add(m); }
    L.group.add(rimLines);
    L.parts = { kind: "volume", w: [wy[0], wy[1], wx[0], wx[1]], k: [0, nk], nk, nx, ny, lev, ci, rj, lonC, latC, z, edges, shellTex, shell, sections };
  }
  if (!root.children.includes(L.group)) root.add(L.group);
  if (L.shown) applyData(L, L.shown.values);
}

function surfaceMask(L) {
  const P = L.parts;
  if (!state.cut || !activeLayers().some((M) => M.entry.kind === "volume" && M.visible)) return null;
  if (P.mask && P.maskBox === box.join(",")) return P.mask;
  const m = new Uint8Array(P.nx * P.ny);
  for (let i = 0; i < m.length; i++) { const lon = P.centres[2 * i], lat = P.centres[2 * i + 1]; m[i] = lon === lon && inBox(lon, lat) ? 1 : 0; }
  P.mask = m; P.maskBox = box.join(",");
  return m;
}

function applyData(L, values) {
  const P = L.parts, e = L.entry;
  if (!P) return;
  if (P.kind === "surface") { paint(P.tex, values, e, undefined, surfaceMask(L)); return; }
  const { nx, ny, nk, lev } = P, n = nx * ny;
  paint(P.shellTex, values, e, (i) => values[lev * n + i]);
  for (const q of P.sections) {
    if (q.along === "m") paint(q.tex, values, e, (i) => { const j = i % ny, k = (i / ny) | 0; return values[k * n + j * nx + q.at]; });
    else paint(q.tex, values, e, (i) => { const x = i % nx, k = (i / nx) | 0; return values[k * n + q.at * nx + x]; });
  }
}

// ---------------------------------------------------------------- the clock

let span = [dayOf(F.parseDay(defaults.date)) - 365, dayOf(F.parseDay(defaults.date)) + 365];
function setSpan() {
  const s = activeLayers().map(spanOf).filter(Boolean);
  if (!s.length) return;
  span = [Math.min(...s.map((x) => x[0])), Math.max(...s.map((x) => x[1]))];
  ui.date.min = span[0]; ui.date.max = span[1];
}
// the clock is the middle of the day, where daily means are stamped
const dateMs = () => F.parseDay(state.date) + DAY / 2;

let showing = 0;
// Show every active layer on state.date: read what each needs (from the
// cache when it is there), and paint all of them together once all have
// answered, so a frame is never half one date and half another.
async function show() {
  const ticket = ++showing, ms = dateMs();
  ui.date.value = dayOf(ms); ui.dateOut.textContent = state.date; ui.dateText.value = state.date;
  const todo = activeLayers();
  for (const L of layers.values()) if (!todo.includes(L)) { L.group.visible = false; L.visible = false; }
  ui.loading.textContent = "reading\u2026";
  const results = await Promise.allSettled(todo.map(async (L) => {
    await openLayer(L);
    if (!L.parts) throw new Error(L.error || "not drawn");
    const plan = readPlan(L, ms);
    if (!plan || plan.outside) return { L, outside: true };
    const values = await reader.slab(L.ds, plan.tt.index, plan.k, plan.w);
    return { L, plan, values };
  }));
  if (ticket !== showing) return false;
  const needBase = [];
  results.forEach((r, i) => {
    const L = todo[i];
    if (r.status === "rejected") {
      L.group.visible = false; L.visible = false;
      const why = L.error || r.reason?.message || String(r.reason);
      L.status = /fetch/i.test(why) ? "not read: the data host did not answer (blocked, or no CORS)" : `not read: ${why}`;
      L.failed = true;
      return;
    }
    const { outside, plan, values } = r.value;
    if (outside) {
      const s = spanOf(L);
      L.group.visible = false; L.visible = false;
      L.status = s ? `no data near this date (${F.isoDay(s[0] * DAY)} to ${F.isoDay(s[1] * DAY)})` : "no time axis";
      return;
    }
    const was = L.visible;
    L.failed = false;
    L.visible = true; L.group.visible = true; L.shown = { values, plan };
    if (L.entry.kind === "volume" && !was) needBase.push(L);
    const off = plan.tt.offsetDays;
    L.status = `${F.isoDay(plan.tt.date)}${Math.abs(off) >= 1 ? ` (${off > 0 ? "+" : ""}${off.toFixed(0)} d)` : ""}, step ${plan.tt.index}`;
  });
  buildBase();
  for (const L of todo) if (L.visible) applyData(L, L.shown.values);
  ui.loading.textContent = "";
  renderLayers(); renderHosts(); refreshPick();
  prefetch(ms);
  return true;
}

// read ahead: the next few dates of every active layer, one at a time
let fetching = 0;
async function prefetch(ms) {
  const ticket = ++fetching;
  let t = ms;
  for (let s = 0; s < AHEAD; s++) {
    t = F.stepFrom(t, state.step, 1);
    for (const L of activeLayers()) {
      if (ticket !== fetching) return;
      if (!L.ds || !L.parts || L.failed) continue;
      const plan = readPlan(L, t);
      if (!plan || plan.outside) continue;
      try { await reader.slab(L.ds, plan.tt.index, plan.k, plan.w); } catch (e) { /* shown when it is the date */ }
    }
  }
}

function setDate(ms) {
  const d = Math.max(span[0], Math.min(span[1], dayOf(ms)));
  state.date = F.isoDay(d * DAY);
  writeHash();
  return show();
}

let playing = false;
async function play() {
  playing = true; ui.play.textContent = "Stop";
  while (playing) {
    const t0 = performance.now(), next = F.stepFrom(dateMs(), state.step, 1);
    if (dayOf(next) > span[1]) break;
    await setDate(next);
    const wait = 220 - (performance.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  playing = false; ui.play.textContent = "Play";
}

// ---------------------------------------------------------------- panel

function renderLayers() {
  ui.layers.innerHTML = "";
  const on = new Set(activeIds());
  for (const L of layers.values()) {
    const tr = document.createElement("tr");
    const a = document.createElement("td"), b = document.createElement("td");
    const lab = document.createElement("label"), cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = on.has(L.entry.id);
    cb.addEventListener("change", () => {
      const ids = activeIds().filter((x) => x !== L.entry.id);
      if (cb.checked) ids.push(L.entry.id);
      state.layers = [...layers.keys()].filter((x) => ids.includes(x)).join(",");
      writeHash();
      openActive().then(show);
    });
    const sw = document.createElement("span");
    sw.style.cssText = `display:inline-block;width:28px;height:8px;margin:0 6px;vertical-align:middle;background:linear-gradient(90deg,${cssStops(L.entry)})`;
    lab.append(cb, sw, document.createTextNode(L.entry.title));
    if (L.entry.crs_note) lab.title = L.entry.crs_note;
    a.append(lab); a.style.textAlign = "left";
    b.textContent = on.has(L.entry.id) ? (L.status || (L.ds ? "" : "opening\u2026")) : "";
    b.style.fontSize = "11px";
    tr.append(a, b); ui.layers.append(tr);
    if (on.has(L.entry.id)) {
      const t2 = document.createElement("tr"), c = document.createElement("td");
      c.colSpan = 2; c.className = "hint"; c.style.textAlign = "left";
      const u = L.entry.units ?? (L.ds ? L.ds.desc.units : "");
      c.textContent = `colour ${L.entry.range[0]} to ${L.entry.range[1]} ${u}${L.entry.below === "clear" ? ", clear below" : ""}`;
      t2.append(c); ui.layers.append(t2);
    }
  }
}

function renderHosts() {
  ui.hosts.innerHTML = "";
  if (!R.hosts.size) return;
  const head = document.createElement("tr");
  for (const t of ["Host", "Reads", "Failed", "MB"]) { const td = document.createElement("td"); td.textContent = t; head.append(td); }
  ui.hosts.append(head);
  for (const [h, s] of R.hosts) {
    const tr = document.createElement("tr");
    for (const t of [h, s.ok, s.fail, (s.bytes / 2 ** 20).toFixed(1)]) { const td = document.createElement("td"); td.textContent = t; tr.append(td); }
    if (s.fail && !s.ok) { tr.title = s.error; tr.style.color = "var(--orange)"; }
    ui.hosts.append(tr);
  }
}
R.setFetchListener(() => { clearTimeout(renderHosts.t); renderHosts.t = setTimeout(renderHosts, 150); });

function renderControls() {
  ui.box.value = state.box;
  ui.zmax.value = state.zmax; ui.zmaxOut.textContent = `${Math.round(zmaxM())} m`;
  ui.dz.value = state.dz; ui.dzOut.textContent = `x ${Math.round(exag())}`;
  ui.cl.value = state.cl; ui.cp.value = state.cp;
  ui.cut.checked = !!state.cut; ui.coast.checked = !!state.coast;
  ui.step.value = state.step;
  ui.view.value = state.view; ui.t.value = state.t; ui.t.disabled = state.view === "globe";
  ui.tOut.textContent = state.view === "globe" ? "" : state.t.toFixed(2);
  ui.range.value = Math.log10(state.range);
  ui.rangeOut.textContent = state.range >= 20000 ? "the whole Earth" : `${Math.round(state.range)} km`;
  const V = activeLayers().find((L) => L.entry.kind === "volume" && L.parts);
  if (V) {
    const P = V.parts;
    ui.lev.max = P.nk - 1; ui.lev.value = P.lev;
    ui.levOut.textContent = `${P.z[P.lev].toFixed(1)} m (level ${P.lev})`;
    ui.clOut.textContent = `${P.lonC.toFixed(2)}${DEG}`; ui.cpOut.textContent = `${P.latC.toFixed(2)}${DEG}`;
  } else { ui.levOut.textContent = ui.clOut.textContent = ui.cpOut.textContent = "no ocean layer"; }
}

function rebuildVolumes() {
  for (const L of activeLayers()) if (L.ds && L.entry.kind === "volume") buildParts(L);
  renderControls(); writeHash();
}

ui.date.addEventListener("input", () => { state.date = F.isoDay(+ui.date.value * DAY); ui.dateOut.textContent = state.date; });
ui.date.addEventListener("change", () => setDate(+ui.date.value * DAY));
ui.dateText.addEventListener("change", () => { const t = F.parseDay(ui.dateText.value); if (t !== null) setDate(t); });
ui.back.addEventListener("click", () => setDate(F.stepFrom(dateMs(), state.step, -1)));
ui.fwd.addEventListener("click", () => setDate(F.stepFrom(dateMs(), state.step, 1)));
ui.play.addEventListener("click", () => { if (playing) playing = false; else play(); });
ui.step.addEventListener("change", () => { state.step = ui.step.value; writeHash(); prefetch(dateMs()); });
ui.cut.addEventListener("change", () => { state.cut = ui.cut.checked ? 1 : 0; writeHash(); show(); });
ui.coast.addEventListener("change", () => { state.coast = ui.coast.checked ? 1 : 0; if (coastLines) coastLines.visible = !!state.coast; writeHash(); });
ui.boxGo.addEventListener("click", () => {
  const b = parseBox(ui.box.value);
  if (!b) { ui.status.textContent = "box: west, east, south, north in degrees"; return; }
  ui.status.textContent = ""; box = b; state.box = ui.box.value.trim(); relayout(); rebuildVolumes(); show();
});
ui.lev.addEventListener("input", () => { state.lev = +ui.lev.value; rebuildVolumes(); });
ui.zmax.addEventListener("input", () => { ui.zmaxOut.textContent = `${Math.round(10 ** +ui.zmax.value)} m`; });
ui.zmax.addEventListener("change", () => { state.zmax = +ui.zmax.value; rebuildVolumes(); show(); });
ui.dz.addEventListener("input", () => { state.dz = +ui.dz.value; rebuildVolumes(); });
ui.cl.addEventListener("input", () => { state.cl = +ui.cl.value; rebuildVolumes(); });
ui.cp.addEventListener("input", () => { state.cp = +ui.cp.value; rebuildVolumes(); });
ui.view.addEventListener("change", () => {
  state.view = ui.view.value;
  if (state.view !== "globe" && state.t === 0) state.t = 1;
  relayout(); state.cam = null; setCamera(defaultCamera()); renderControls(); writeHash();
});
ui.t.addEventListener("input", () => { state.t = +ui.t.value; ui.tOut.textContent = state.t.toFixed(2); reblend(); writeHash(); });
ui.range.addEventListener("input", () => {
  const km = 10 ** +ui.range.value;
  state.range = km >= 19900 ? 20000 : Math.round(km);
  ui.rangeOut.textContent = state.range >= 20000 ? "the whole Earth" : `${state.range} km`;
});
ui.range.addEventListener("change", () => { relayout(); writeHash(); });
ui.centrePick.addEventListener("click", () => {
  if (!pickAt) { ui.status.textContent = "click the globe or map first"; return; }
  ui.status.textContent = "";
  state.clon = +pickAt.lon.toFixed(3); state.clat = +pickAt.lat.toFixed(3);
  relayout(); state.cam = null; setCamera(defaultCamera()); writeHash();
});
ui.centreBox.addEventListener("click", () => { state.clon = state.clat = null; relayout(); state.cam = null; setCamera(defaultCamera()); writeHash(); });
ui.reset.addEventListener("click", () => { state.cam = null; setCamera(defaultCamera()); writeHash(); });

// ---------------------------------------------------------------- picking

let pickAt = null;
const marker = new THREE.Mesh(new THREE.SphereGeometry(0.004, 12, 8), new THREE.MeshBasicMaterial({ color: COLORS.pick }));
marker.visible = false; root.add(marker);
function placeMarker() {
  const p = pickAt && placePoint(pickAt.lon, pickAt.lat, pickAt.r, marker.position);
  marker.visible = !!p;
}
const ray = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const targets = [];
  for (const L of activeLayers()) if (L.visible) L.group.traverse((o) => { if (o.isMesh) targets.push(o); });
  if (base) targets.push(base);
  const hit = ray.intersectObjects(targets, false)[0];
  if (!hit || !hit.face) return;
  // back from the picture to the Earth: the hit's barycentric weights in its
  // triangle as drawn, applied to the triangle's corners on the Earth
  const geo = hit.object.geometry, pos = geo.attributes.position, llr = geo.userData.llr;
  const local = hit.object.worldToLocal(hit.point.clone());
  const cs = [hit.face.a, hit.face.b, hit.face.c], P = cs.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i));
  const w = new THREE.Triangle(P[0], P[1], P[2]).getBarycoord(local, new THREE.Vector3());
  const earth = new THREE.Vector3(), q = new THREE.Vector3();
  cs.forEach((i, k) => earth.add(toVec(llr[3 * i], llr[3 * i + 1], llr[3 * i + 2], q).multiplyScalar(w.getComponent(k))));
  pickAt = fromVec(earth);
  placeMarker();
  refreshPick();
});

function row(k, v, cls) {
  const tr = document.createElement("tr"), a = document.createElement("td"), b = document.createElement("td");
  a.textContent = k; b.textContent = v; if (cls) tr.className = cls;
  tr.append(a, b); ui.pick.append(tr);
}
const fmt = (v) => (v === v ? (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)) : "no data");

function refreshPick() {
  ui.pick.innerHTML = "";
  ui.profile.hidden = true;
  if (!pickAt) return;
  ui.pickHint.hidden = true;
  const lon = pickAt.lon, lat = pickAt.lat;
  const depth = pickAt.r < 0.9995 ? (1 - pickAt.r) * F.EARTH_R / exag() : 0;
  row("Point", `${lat.toFixed(2)}${DEG}, ${lon.toFixed(2)}${DEG}${depth > 1 ? `, ${depth.toFixed(0)} m down` : ""}`);
  for (const L of activeLayers()) {
    if (!L.visible || !L.shown) continue;
    const d = L.ds.desc, ax = d.axes, P = L.parts, vals = L.shown.values, plan = L.shown.plan;
    let i, j;
    if (L.entry.crs) {
      const q = proj4(L.entry.crs).forward([lon, lat]);
      i = cellOf(ax.x, q[0]); j = cellOf(ax.y, q[1]);
    } else {
      i = cellOf(ax.x, ((((lon - ax.x.values[0]) % 360) + 360) % 360) + ax.x.values[0]); j = cellOf(ax.y, lat);
    }
    row(L.entry.title, "", "sub");
    if (i < 0 || j < 0) { row("cell", "outside this grid"); continue; }
    const t = plan.tt.index;
    let v, k = null;
    if (P.kind === "surface") v = vals[j * P.nx + i];
    else {
      const li = i - P.w[2], lj = j - P.w[0];
      if (li < 0 || lj < 0 || li >= P.nx || lj >= P.ny) { row("cell", "outside the box"); continue; }
      k = depth > 1 ? Math.max(0, P.edges.findIndex((e, q) => q > 0 && e >= depth) - 1) : P.lev;
      if (k < 0) k = P.nk - 1;
      v = vals[k * P.nx * P.ny + lj * P.nx + li];
      drawProfile(L, li, lj, k);
    }
    row(`value${k !== null ? ` at ${P.z[k].toFixed(1)} m` : ""}`, `${fmt(v)} ${L.entry.units ?? d.units}`);
    const idx = d.roles.map((r) => (r === "t" ? t : r === "z" ? (k ?? 0) : r === "y" ? j : r === "x" ? i : 0));
    row("cell", d.dims.map((n, q) => `${n} ${idx[q]}`).join(", "));
    row("chunk", idx.map((x, q) => Math.floor(x / d.chunks[q])).join("."));
  }
}

function drawProfile(L, li, lj, kOn) {
  const P = L.parts, vals = L.shown.values, n = P.nx * P.ny, c = ui.profile, g = c.getContext("2d");
  const W = c.width, H = c.height, m = { l: 44, r: 10, t: 14, b: 26 };
  const ys = [], xs = [];
  for (let k = 0; k < P.nk; k++) { const v = vals[k * n + lj * P.nx + li]; if (v === v) { ys.push(P.z[k]); xs.push(v); } }
  c.hidden = false;
  const css = getComputedStyle(document.body);
  const ink = css.getPropertyValue("--text") || "#ddd", muted = css.getPropertyValue("--muted") || "#999";
  g.clearRect(0, 0, W, H);
  if (!xs.length) return;
  let lo = Math.min(...xs), hi = Math.max(...xs);
  if (hi - lo < 1e-6) { lo -= 0.5; hi += 0.5; }
  const zmax = P.edges[P.nk];
  const X = (v) => m.l + ((v - lo) / (hi - lo)) * (W - m.l - m.r), Y = (z) => m.t + (z / zmax) * (H - m.t - m.b);
  g.strokeStyle = muted; g.lineWidth = 1; g.strokeRect(m.l, m.t, W - m.l - m.r, H - m.t - m.b);
  g.fillStyle = muted; g.font = "11px system-ui, sans-serif";
  g.textAlign = "right"; g.fillText("0 m", m.l - 4, m.t + 4); g.fillText(`${Math.round(zmax)} m`, m.l - 4, H - m.b);
  g.textAlign = "left"; g.fillText(lo.toFixed(2), m.l, H - 8); g.textAlign = "right"; g.fillText(`${hi.toFixed(2)} ${L.ds.desc.units}`, W - m.r, H - 8);
  g.strokeStyle = ink.trim() || "#ddd"; g.lineWidth = 1.5; g.beginPath();
  xs.forEach((v, q) => (q ? g.lineTo(X(v), Y(ys[q])) : g.moveTo(X(v), Y(ys[q]))));
  g.stroke();
  g.strokeStyle = "#ff7ab8"; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(m.l, Y(P.z[kOn])); g.lineTo(W - m.r, Y(P.z[kOn])); g.stroke(); g.setLineDash([]);
}

// ---------------------------------------------------------------- probe

ui.probe.addEventListener("click", async () => {
  ui.probe.disabled = true; ui.status.textContent = "reading one chunk from each dataset\u2026";
  const out = [];
  for (const e of [...registry.datasets, ...(registry.probe || [])]) {
    if (e.synthetic) continue;
    const t0 = performance.now();
    try {
      const ds = await R.openDataset(e, baseUrl), d = ds.desc;
      const t = d.axes.t ? d.axes.t.n - 1 : 0;
      await ds.read(t, 0, 0, 1, 0, 1);
      out.push(`${e.id}: read (${Math.round(performance.now() - t0)} ms)`);
    } catch (err) { out.push(`${e.id}: not read`); }
    renderHosts();
  }
  ui.status.textContent = out.join("; ");
  ui.probe.disabled = false;
});

// ---------------------------------------------------------------- start

async function openActive() {
  await Promise.allSettled(activeLayers().map(openLayer));
  setSpan(); renderControls(); renderLayers();
}

async function start() {
  try {
    registry = await (await fetch(new URL("../data/fourd/stores.json", import.meta.url))).json();
  } catch (e) { ui.status.textContent = "could not read data/fourd/stores.json"; return; }
  baseUrl = state.base || registry.base;
  for (const e of registry.datasets) layers.set(e.id, newLayer(e));
  ui.credit.textContent = "OISST v2.1: NOAA NCEI. Sea ice: NOAA/NSIDC CDR G02202 v6. BRAN: CSIRO Bluelink, at NCI. Indexes: raad.virtualize, on source.coop.";
  setCamera(state.cam || defaultCamera());
  resize();
  renderControls(); renderLayers();
  await openActive();
  await show();
  window.__fourd = { state, layers, reader, hosts: R.hosts, ready: true };
}

function frame() {
  controls.update();
  renderer.render(world, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
shareLinks("playproj: Time and depth");
start();
