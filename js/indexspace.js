// playproj: index space.
//
// An ocean model grid, curvilinear in the horizontal and terrain-following in
// the vertical, drawn as surfaces of its (i, j, k) array: the sea surface, the
// sea floor, the four walls and two sections. Every vertex has two homes, one
// in index space (a regular box) and one in the ocean (on the sphere, at its
// depth), and two sliders move it between them, horizontally and vertically.
// Colours are computed per index and so ride along.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as R from "./roms.js";
import { loadCoastline } from "./data.js";
import { sceneFrame } from "./geo.js";
import { sampleElev } from "./basemap.js";
import { loadWorld } from "./basemap-load.js";

const DEG = "\u00b0";
const BOX = 3.2;            // index space: the long side of the box, scene units
const HMIN = 10;

const KINDS = [
  { key: "so", label: "Southern Ocean ring", n: 180 },
  { key: "fan", label: "Tasman fan", n: 60 }
];

// ---------------------------------------------------------------- state

const defaults = {
  g: "so", n: 0, N: 30, vt: 2, vs: 4, ts: 7, tb: 2, hc: 250, sm: 1, bathy: "gebco", dz: 1,
  wh: 1, wv: 1, day: 40, f: "temp", si: 0.5, sj: 0.5, top: 1, bot: 1, walls: 1, sec: 1, coast: 1,
  cell: "", zu: "", cam: null
};
const state = { ...defaults };
const embed = new URLSearchParams(location.search).has("embed");

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  Object.assign(state, defaults);
  for (const k of Object.keys(defaults)) {
    if (!h.has(k)) continue;
    const raw = h.get(k);
    if (k === "g") state.g = ["so", "fan", "file"].includes(raw) ? raw : defaults.g;
    else if (k === "bathy") state.bathy = raw === "ideal" ? "ideal" : "gebco";
    else if (k === "f") state.f = ["temp", "z", "hz"].includes(raw) ? raw : "temp";
    else if (k === "zu") state.zu = /^https?:\/\//.test(raw) ? raw : "";
    else if (k === "cell") state.cell = /^\d+,\d+,\d+$/.test(raw) ? raw : "";
    else if (k === "cam") {
      const c = raw.split(",").map(Number);
      if (c.length === 6 && c.every(isFinite)) state.cam = c;
    } else if (isFinite(+raw)) state[k] = +raw;
  }
  const cl = (k, a, b) => { state[k] = Math.max(a, Math.min(b, state[k])); };
  cl("N", 3, 60); cl("ts", 0, 10); cl("tb", 0, 4); cl("hc", 1, 1000); cl("dz", 0.25, 2.5);
  cl("wh", 0, 1); cl("wv", 0, 1); cl("day", 0, 365); cl("si", 0, 1); cl("sj", 0, 1);
  state.N = Math.round(state.N);
  if (![1, 2].includes(state.vt)) state.vt = 2;
  if (![1, 2, 4].includes(state.vs)) state.vs = 4;
  if (state.vs === 1) cl("tb", 0, 1);
  if (state.n) { cl("n", 16, 360); state.n = Math.round(state.n / 4) * 4; }
  if (state.g === "file" && !state.zu) state.g = defaults.g;
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

const vert = () => ({ vt: state.vt, vs: state.vs, ts: state.ts, tb: state.tb, hc: state.hc });
const cellsAlongI = () => state.n || (KINDS.find((k) => k.key === state.g) || { n: 60 }).n;

// ---------------------------------------------------------------- the model

let gebco = null, gebcoMsg = "", fileGrid = null;

// the horizontal grid and its bathymetry
function makeHorizontal() {
  let grid, h, mask, source;
  if (state.g === "file" && fileGrid) {
    grid = R.fromArrays({ ni: fileGrid.ni, nj: fileGrid.nj, lon: fileGrid.lon, lat: fileGrid.lat, label: fileGrid.label });
    h = Float64Array.from(fileGrid.h, (x) => Math.max(HMIN, x)); mask = fileGrid.mask; source = "file";
  } else {
    const ni = cellsAlongI();
    grid = state.g === "fan" ? R.fan({ ni }) : R.southernOcean({ ni });
    const useGebco = state.bathy === "gebco" && gebco;
    const elev = useGebco ? (lon, lat) => sampleElev(gebco, lon, lat) : (lon, lat) => R.idealElevation(grid, lon, lat);
    ({ h, mask } = R.bathymetry(grid, elev, HMIN));
    source = useGebco ? "gebco" : "ideal";
  }
  const raw = h;
  const rx0raw = R.rx0(grid, raw, mask);
  if (state.sm) h = R.smoothRx0(grid, raw, mask, 0.2);
  let hmax = 0, hmin = Infinity;
  for (let k = 0; k < h.length; k++) if (mask[k]) { hmax = Math.max(hmax, h[k]); hmin = Math.min(hmin, h[k]); }
  if (!(hmax > 0)) { hmax = 100; hmin = HMIN; }
  return { grid, h, mask, source, rx0raw, rx0: R.rx0(grid, h, mask), hmax, hmin };
}

// where the grid sits in the scene: index box and world frame
function makeFrame(H) {
  const g = H.grid, W = g.ni + 1;
  const c = BOX / Math.max(g.ni, g.nj), Wx = g.ni * c, Wy = g.nj * c;
  const frame = sceneFrame(g.center[1], g.center[0]);
  const tmp = [0, 0, 0];
  const at = (k) => frame(g.lon[k], g.lat[k], [0, 0, 0]);
  // turn about the vertical so the j direction at the middle points away (-z)
  const mi = g.ni >> 1, mj = g.nj >> 1;
  const a = at(mj * W + mi), b = at(Math.min(g.nj, mj + 1) * W + mi);
  const phi = Math.atan2(b[0] - a[0], -(b[2] - a[2]));
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const place = (lon, lat, out) => {
    frame(lon, lat, tmp);
    out[0] = tmp[0] * cp + tmp[2] * sp; out[1] = tmp[1]; out[2] = -tmp[0] * sp + tmp[2] * cp;
    return out;
  };
  // solid angle of the grid, to give the world the same area as the box
  let area = 0;
  const p00 = [0, 0, 0], p10 = [0, 0, 0], p01 = [0, 0, 0], p11 = [0, 0, 0];
  for (let j = 0; j < g.nj; j++)
    for (let i = 0; i < g.ni; i++) {
      const k = j * W + i;
      place(g.lon[k], g.lat[k], p00); place(g.lon[k + 1], g.lat[k + 1], p10);
      place(g.lon[k + W], g.lat[k + W], p01); place(g.lon[k + W + 1], g.lat[k + W + 1], p11);
      const ax = p11[0] - p00[0], ay = p11[1] - p00[1], az = p11[2] - p00[2];
      const bx = p01[0] - p10[0], by = p01[1] - p10[1], bz = p01[2] - p10[2];
      area += 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
    }
  const S = Math.sqrt((Wx * Wy) / area);
  // the depth of the box, and of the deepest water on the sphere
  const Di = 0.2 * BOX * state.dz, Dw = Math.min(0.2 * BOX, 0.12 * S) * state.dz;
  return { Wx, Wy, S, Di, Dw, place, exag: (Dw / S) * 6371000 / H.hmax };
}

// ---------------------------------------------------------------- sheets

// A sheet is one surface of the array: vertices on a (na + 1) x (nb + 1)
// lattice, each at an index vertex (i, j, k). For each vertex we keep both
// homes: index (ix, iz and iy, a fraction of the box's depth) and world
// (base on the sphere, its outward normal, and depth wd, a fraction of the
// deepest water).
function makeSheet(M, name, na, nb, ijk) {
  const { grid: g, h, mask } = M.H, F = M.F, N = M.N, v = M.v;
  const n = (na + 1) * (nb + 1), W = g.ni + 1;
  const s = {
    name, na, nb, ijk, n,
    gi: new Int32Array(n), gj: new Int32Array(n), gk: new Int32Array(n),
    idx: new Float32Array(n * 3), base: new Float32Array(n * 3), nrm: new Float32Array(n * 3), wd: new Float32Array(n), z: new Float32Array(n)
  };
  const P = [0, 0, 0];
  for (let b = 0, m = 0; b <= nb; b++)
    for (let a = 0; a <= na; a++, m++) {
      const [i, j, k] = ijk(a, b);
      s.gi[m] = i; s.gj[m] = j; s.gk[m] = k;
      const q = j * W + i;
      s.idx[3 * m] = (i / g.ni - 0.5) * F.Wx; s.idx[3 * m + 1] = k / N - 1; s.idx[3 * m + 2] = -(j / g.nj - 0.5) * F.Wy;
      F.place(g.lon[q], g.lat[q], P);
      s.base[3 * m] = F.S * P[0]; s.base[3 * m + 1] = F.S * (P[1] - 1); s.base[3 * m + 2] = F.S * P[2];
      s.nrm.set(P, 3 * m);
      const z = R.depth(R.sW(k, N), mask[q] ? h[q] : HMIN, v);
      s.z[m] = z;
      s.wd[m] = z / M.H.hmax;
    }
  const index = [];
  for (let b = 0; b < nb; b++)
    for (let a = 0; a < na; a++) {
      const p = b * (na + 1) + a, q = p + na + 1;
      index.push(p, p + 1, q, p + 1, q + 1, q);
    }
  const geo = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  geo.setAttribute("position", pos);
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const uv = new Float32Array(n * 2);
  for (let b = 0, m = 0; b <= nb; b++) for (let a = 0; a <= na; a++, m++) { uv[2 * m] = a; uv[2 * m + 1] = b; }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  s.mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
  s.mesh.userData.sheet = s;

  // grid lines: every layer interface, and every few columns
  const li = [];
  const strideA = Math.max(1, Math.ceil(na / 72)), strideB = name === "top" || name === "bot" ? Math.max(1, Math.ceil(nb / 72)) : Math.max(1, Math.ceil(nb / 60));
  for (let b = 0; b <= nb; b += (b + strideB > nb && b !== nb ? nb - b : strideB))
    for (let a = 0; a < na; a++) li.push(b * (na + 1) + a, b * (na + 1) + a + 1);
  for (let a = 0; a <= na; a += (a + strideA > na && a !== na ? na - a : strideA))
    for (let b = 0; b < nb; b++) li.push(b * (na + 1) + a, (b + 1) * (na + 1) + a);
  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", pos);
  lg.setIndex(li);
  s.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x05070d, transparent: true, opacity: 0.4 }));
  return s;
}

const ease = (x) => x * x * (3 - 2 * x);

function placeSheet(s, eh, ev, D) {
  const pos = s.mesh.geometry.attributes.position.array;
  for (let m = 0; m < s.n; m++) {
    const o = 3 * m;
    const y = D * (s.idx[o + 1] + (s.wd[m] - s.idx[o + 1]) * ev);
    for (let c = 0; c < 3; c++) {
      const hb = (c === 1 ? 0 : s.idx[o + c]) + (s.base[o + c] - (c === 1 ? 0 : s.idx[o + c])) * eh;
      const up = (c === 1 ? 1 : 0) + (s.nrm[o + c] - (c === 1 ? 1 : 0)) * eh;
      pos[o + c] = hb + up * y;
    }
  }
  s.mesh.geometry.attributes.position.needsUpdate = true;
  s.mesh.geometry.computeVertexNormals();
  s.mesh.geometry.computeBoundingSphere();
}

// ---------------------------------------------------------------- colour

const RAMPS = {
  temp: [[0, 22, 28, 92], [0.16, 36, 78, 168], [0.36, 38, 152, 168], [0.56, 150, 202, 118], [0.76, 246, 182, 64], [1, 214, 58, 48]],
  z: [[0, 205, 238, 250], [0.25, 110, 185, 225], [0.55, 40, 105, 175], [1, 10, 22, 66]],
  hz: [[0, 68, 1, 84], [0.25, 59, 82, 139], [0.5, 33, 145, 140], [0.75, 94, 201, 98], [1, 253, 231, 37]]
};
function rampAt(stops, t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++)
    if (t <= stops[i][0]) {
      const [a, r0, g0, b0] = stops[i - 1], [b, r1, g1, b1] = stops[i], f = (t - a) / (b - a);
      return [r0 + f * (r1 - r0), g0 + f * (g1 - g0), b0 + f * (b1 - b0)];
    }
  const l = stops[stops.length - 1];
  return [l[1], l[2], l[3]];
}

function fieldRange(M) {
  // temperature on a square-root scale, so the cold deep water shows its range
  if (state.f === "temp") return { lo: M.trange[0], hi: M.trange[1], gamma: 0.5, label: (x) => `${x.toFixed(0)}${DEG}C`, title: "Temperature (synthetic)" };
  if (state.f === "z") return { lo: 0, hi: M.H.hmax, label: (x) => `${Math.round(x)} m`, title: "Depth" };
  return { lo: 0, hi: 3.5, label: (x) => `${10 ** x < 10 ? (10 ** x).toFixed(1) : Math.round(10 ** x)} m`, title: "Layer thickness (log)" };
}

function colourSheet(M, s) {
  const { grid: g, h, mask } = M.H, N = M.N, v = M.v, W = g.ni + 1;
  const col = s.mesh.geometry.attributes.color.array, c = new THREE.Color();
  const rg = fieldRange(M), stops = RAMPS[state.f];
  for (let m = 0; m < s.n; m++) {
    const q = s.gj[m] * W + s.gi[m];
    if (!mask[q]) { c.setRGB(0.36, 0.38, 0.41, THREE.SRGBColorSpace); }
    else {
      let val;
      if (state.f === "temp") val = R.temperature(g.lon[q], g.lat[q], s.z[m], state.day, s.gi[m] / g.ni, s.gj[m] / g.nj);
      else if (state.f === "z") val = -s.z[m];
      else {
        const sv = R.sW(s.gk[m], N), a = Math.max(-1, sv - 0.5 / N), b = Math.min(0, sv + 0.5 / N);
        val = Math.log10(Math.max(1e-3, ((R.depth(b, h[q], v) - R.depth(a, h[q], v)) / (b - a)) / N));
      }
      const f = Math.max(0, (val - rg.lo) / (rg.hi - rg.lo));
      const [r, gg, bb] = rampAt(stops, rg.gamma ? f ** rg.gamma : f);
      c.setRGB(r / 255, gg / 255, bb / 255, THREE.SRGBColorSpace);
    }
    col[3 * m] = c.r; col[3 * m + 1] = c.g; col[3 * m + 2] = c.b;
  }
  s.mesh.geometry.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------------- scene

const stage = document.getElementById("three");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x05070d);
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-2, 5, -3);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(38, 1, 0.02, 400);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
// from the open ocean (high j) side, looking back along j
const DEFAULT_CAM = [-1.2, 3.2, -4.6, 0, -0.2, 0];
function setCamera(c) {
  camera.position.set(c[0], c[1], c[2]);
  controls.target.set(c[3], c[4], c[5]);
  controls.update();
}
controls.addEventListener("end", () => {
  const p = camera.position, t = controls.target;
  state.cam = [p.x, p.y, p.z, t.x, t.y, t.z];
  writeHash();
});

const group = new THREE.Group();
scene.add(group);

// the rest of the globe, under the grid, when it is on the sphere
const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), new THREE.MeshBasicMaterial({ color: 0x0b1222, transparent: true }));
group.add(globe);
const coastIn = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xe8f4ff, transparent: true, opacity: 0.85 }));
const coastOut = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x9fc6ee, transparent: true, opacity: 0.5 }));
group.add(coastIn, coastOut);
const pickBox = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd34d, depthTest: false }));
pickBox.renderOrder = 10;
const edges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.7 }));
group.add(pickBox, edges);

let M = null;          // { hKey, vKey, H, F, N, v, sheets, coast }
let coastLines = { "110m": null, "50m": null };

function hKey() { return [state.g, cellsAlongI(), state.bathy, !!gebco, state.sm, state.g === "file" ? state.zu : ""].join("|"); }
function vKey() { return [state.N, state.vt, state.vs, state.ts, state.tb, state.hc, state.dz].join("|"); }

function rebuild() {
  const hk = hKey(), vk = vKey(), sk = [state.si, state.sj, state.sec].join("|");
  if (M && M.hKey === hk && M.vKey === vk && M.sKey === sk) return false;
  let H = M && M.hKey === hk ? M.H : makeHorizontal();
  if (M) for (const s of M.sheets) { group.remove(s.mesh, s.lines); s.mesh.geometry.dispose(); s.lines.geometry.dispose(); s.mesh.material.dispose(); s.lines.material.dispose(); }
  const F = makeFrame(H), N = state.N, v = vert();
  const next = { hKey: hk, vKey: vk, sKey: sk, H, F, N, v, sheets: [] };
  const g = H.grid, ni = g.ni, nj = g.nj;
  const si = Math.round(state.si * ni), sj = Math.round(state.sj * nj);
  const add = (...a) => next.sheets.push(makeSheet(next, ...a));
  // with sections on, the sea surface and the wall at j = nj go, so the
  // near half is open (the view looks back along j)
  const topTo = state.sec ? Math.max(1, sj) : nj;
  add("top", ni, topTo, (a, b) => [a, b, N]);
  add("bot", ni, nj, (a, b) => [a, b, 0]);
  add("wall", nj, N, (a, b) => [0, a, b]);
  add("wall", nj, N, (a, b) => [ni, a, b]);
  add("wall", ni, N, (a, b) => [a, 0, b]);
  if (!state.sec) add("wall", ni, N, (a, b) => [a, nj, b]);
  add("sec", nj, N, (a, b) => [si, a, b]);
  add("sec", ni, N, (a, b) => [a, sj, b]);
  for (const s of next.sheets) group.add(s.mesh, s.lines);
  next.rx1 = R.rx1(g, H.h, H.mask, v, N);
  // a temperature range for this grid, fixed while time runs
  let tlo = Infinity, thi = -Infinity;
  for (const s of next.sheets) for (let m = 0; m < s.n; m += 2) {
    const q = s.gj[m] * (ni + 1) + s.gi[m];
    if (!H.mask[q]) continue;
    const t = R.temperature(g.lon[q], g.lat[q], s.z[m], state.day, s.gi[m] / ni, s.gj[m] / nj);
    tlo = Math.min(tlo, t); thi = Math.max(thi, t);
  }
  next.trange = isFinite(tlo) ? [Math.floor(tlo), Math.max(Math.floor(tlo) + 2, Math.ceil(thi))] : [-2, 28];
  // bounding boxes of index and world, for framing the view
  const box = (f) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const s of next.sheets.slice(0, 2)) for (let m = 0; m < s.n; m += 3) {
      const p = f(s, m);
      for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], p[c]); hi[c] = Math.max(hi[c], p[c]); }
    }
    return { c: lo.map((x, c) => (x + hi[c]) / 2), r: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 };
  };
  next.boxIdx = box((s, m) => [s.idx[3 * m], s.idx[3 * m + 1] * F.Di, s.idx[3 * m + 2]]);
  const dw = (s, m, c) => s.base[3 * m + c] + s.nrm[3 * m + c] * s.wd[m] * F.Dw;
  next.boxWld = box((s, m) => [dw(s, m, 0), dw(s, m, 1), dw(s, m, 2)]);
  M = next;
  globe.scale.setScalar(F.S - F.Dw * 1.03);
  globe.position.set(0, -F.S, 0);
  buildCoast();
  return true;
}

// coastline at sea level: inside the grid it moves with the grid (where the
// grid has an inverse); outside it is on the globe only
function buildCoast() {
  const lines = coastLines[M.H.grid.kind === "so" ? "110m" : "50m"] || coastLines["110m"];
  const inn = [], out = [];
  if (lines) {
    const g = M.H.grid, F = M.F, P = [0, 0, 0];
    const pt = (lon, lat) => {
      F.place(lon, lat, P);
      let uv = g.toIndex ? g.toIndex(lon, lat) : null;
      if (uv && !(uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1)) uv = null;
      return { b: [F.S * P[0] * 1.0006, F.S * (P[1] * 1.0006 - 1), F.S * P[2] * 1.0006], n: [P[0], P[1], P[2]], uv };
    };
    for (const l of lines) {
      let prev = null;
      for (let k = 0; k < l.length; k += 2) {
        const p = pt(l[k], l[k + 1]);
        if (prev) {
          const both = p.uv && prev.uv && Math.abs(p.uv[0] - prev.uv[0]) < 0.5;
          (both ? inn : out).push(prev, p);
        }
        prev = p;
      }
    }
  }
  M.coast = { inn, out };
  for (const [obj, arr] of [[coastIn, inn], [coastOut, out]]) {
    obj.geometry.dispose();
    obj.geometry = new THREE.BufferGeometry();
    obj.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(arr.length * 3), 3));
  }
  const op = coastOut.geometry.attributes.position.array;
  out.forEach((p, k) => op.set(p.b, 3 * k));
  coastOut.geometry.attributes.position.needsUpdate = true;
}

function placeCoast(eh) {
  const F = M.F, lift = 0.004;
  const pos = coastIn.geometry.attributes.position.array;
  M.coast.inn.forEach((p, k) => {
    const ix = (p.uv[0] - 0.5) * F.Wx, iz = -(p.uv[1] - 0.5) * F.Wy;
    const hb = [ix + (p.b[0] - ix) * eh, p.b[1] * eh, iz + (p.b[2] - iz) * eh];
    const up = [p.n[0] * eh, 1 + (p.n[1] - 1) * eh, p.n[2] * eh];
    pos[3 * k] = hb[0] + up[0] * lift; pos[3 * k + 1] = hb[1] + up[1] * lift; pos[3 * k + 2] = hb[2] + up[2] * lift;
  });
  coastIn.geometry.attributes.position.needsUpdate = true;
  coastIn.geometry.computeBoundingSphere();
  coastOut.geometry.computeBoundingSphere();
}

function placeAll() {
  const eh = ease(state.wh), ev = ease(state.wv), D = M.F.Di + (M.F.Dw - M.F.Di) * eh;
  for (const s of M.sheets) placeSheet(s, eh, ev, D);
  placeCoast(eh);
  // frame the view: centre and scale move from the box to the world
  const bi = M.boxIdx, bw = M.boxWld;
  const r = bi.r + (bw.r - bi.r) * eh, sc = 2.2 / r;
  group.scale.setScalar(sc);
  group.position.set(...[0, 1, 2].map((c) => -(bi.c[c] + (bw.c[c] - bi.c[c]) * eh) * sc));
  globe.visible = eh > 0.02;
  globe.material.opacity = Math.min(1, eh * 1.4);
  coastOut.visible = state.coast && eh > 0.02;
  coastOut.material.opacity = 0.5 * eh * eh;
  coastIn.visible = !!state.coast;
  for (const s of M.sheets) {
    const on = s.name === "top" ? state.top : s.name === "bot" ? state.bot : s.name === "wall" ? state.walls : state.sec;
    s.mesh.visible = s.lines.visible = !!on;
  }
  placePick(eh, ev, D);
  placeEdges(eh, ev, D);
}

// the picked cell's eight corners, warped like everything else
function pickedCell() {
  if (!state.cell || !M) return null;
  const [i, j, k] = state.cell.split(",").map(Number), g = M.H.grid;
  if (i >= g.ni || j >= g.nj || k >= M.N) return null;
  return { i, j, k };
}
// any index vertex, warped
function corner(i, j, k, eh, ev, D) {
  const { grid: g, h, mask } = M.H, F = M.F, W = g.ni + 1, P = [0, 0, 0];
  const q = j * W + i;
  F.place(g.lon[q], g.lat[q], P);
  const ix = (i / g.ni - 0.5) * F.Wx, iy = k / M.N - 1, iz = -(j / g.nj - 0.5) * F.Wy;
  const wd = R.depth(R.sW(k, M.N), mask[q] ? h[q] : HMIN, M.v) / M.H.hmax;
  const y = D * (iy + (wd - iy) * ev);
  const b = [F.S * P[0], F.S * (P[1] - 1), F.S * P[2]], ib = [ix, 0, iz], up = [0, 1, 0];
  return [0, 1, 2].map((c) => ib[c] + (b[c] - ib[c]) * eh + (up[c] + (P[c] - up[c]) * eh) * y);
}

function setLines(obj, pts) {
  const arr = new Float32Array(pts.length * 3);
  pts.forEach((p, n) => arr.set(p, 3 * n));
  const a = obj.geometry.attributes.position;
  if (a && a.array.length === arr.length) { a.array.set(arr); a.needsUpdate = true; }
  else {
    obj.geometry.dispose();
    obj.geometry = new THREE.BufferGeometry();
    obj.geometry.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  }
  obj.geometry.computeBoundingSphere();
}

// the twelve edges of the array
function placeEdges(eh, ev, D) {
  const g = M.H.grid, N = M.N, pts = [];
  const run = (n, f) => { for (let a = 0; a < n; a++) pts.push(f(a), f(a + 1)); };
  for (const j of [0, g.nj]) for (const k of [0, N]) run(g.ni, (a) => corner(a, j, k, eh, ev, D));
  for (const i of [0, g.ni]) for (const k of [0, N]) run(g.nj, (a) => corner(i, a, k, eh, ev, D));
  for (const i of [0, g.ni]) for (const j of [0, g.nj]) run(N, (a) => corner(i, j, a, eh, ev, D));
  setLines(edges, pts);
}

function placePick(eh, ev, D) {
  const p = pickedCell();
  pickBox.visible = !!p;
  if (!p) return;
  {
  }
  const c = [];
  for (const dk of [0, 1]) for (const dj of [0, 1]) for (const di of [0, 1]) c.push(corner(p.i + di, p.j + dj, p.k + dk, eh, ev, D));
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  setLines(pickBox, E.flatMap(([a, b]) => [c[a], c[b]]));
}

// ---------------------------------------------------------------- panel

const $ = (id) => document.getElementById(id);
const ui = {};
for (const id of ["kinds", "wh", "wh-out", "wv", "wv-out", "day", "day-out", "field", "legend", "si", "si-out", "sj", "sj-out",
  "top", "bot", "walls", "sec", "coast", "N", "N-out", "vt", "vs", "ts", "ts-out", "tb", "tb-out", "hc", "hc-out", "profile",
  "n", "n-out", "dz", "dz-out", "bathy", "sm", "bathy-status", "projstring", "describe", "stats", "cell-info",
  "zarr-url", "zarr-load", "zarr-status", "zarr-box"]) ui[id] = $(id);

function kindButtons() {
  ui.kinds.innerHTML = "";
  const kinds = KINDS.concat(fileGrid ? [{ key: "file", label: "From Zarr" }] : []);
  for (const k of kinds) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = k.label; b.dataset.kind = k.key;
    b.addEventListener("click", () => {
      if (state.g === k.key) return;
      state.g = k.key; state.cell = ""; state.n = 0;
      if (k.key === "file" && fileGrid.vertical) applyVertical(fileGrid.vertical);
      sync();
    });
    ui.kinds.appendChild(b);
  }
}

const HC = { lo: 1, hi: 1000 };
const hcToSlider = (x) => Math.log(x / HC.lo) / Math.log(HC.hi / HC.lo);
const sliderToHc = (t) => { const x = HC.lo * (HC.hi / HC.lo) ** t; return x < 20 ? Math.round(x) : x < 200 ? Math.round(x / 5) * 5 : Math.round(x / 10) * 10; };
const fmtDay = (d) => { const dt = new Date(Date.UTC(2025, 0, 1 + Math.round(d))); return `day ${Math.round(d)} (${dt.toUTCString().slice(5, 11)})`; };
const km = (x) => (x < 10 ? x.toFixed(1) : Math.round(x)) + " km";

function drawLegend() {
  const cv = ui.legend, ctx = cv.getContext("2d"), W = cv.width, Hh = cv.height, rg = fieldRange(M);
  ctx.clearRect(0, 0, W, Hh);
  for (let x = 0; x < W; x++) {
    const [r, g, b] = rampAt(RAMPS[state.f], x / (W - 1));
    ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    ctx.fillRect(x, 0, 1, 22);
  }
  ctx.fillStyle = "#c4cedb"; ctx.font = "22px system-ui, sans-serif"; ctx.textBaseline = "top";
  ctx.textAlign = "left"; ctx.fillText(rg.label(rg.lo), 0, 28);
  ctx.textAlign = "center";
  ctx.fillText(rg.gamma ? `${rg.title}, ${rg.label(rg.lo + (rg.hi - rg.lo) * 0.5 ** (1 / rg.gamma))} at the middle` : rg.title, W / 2, 28);
  ctx.textAlign = "right"; ctx.fillText(rg.label(rg.hi), W, 28);
}

// layer interfaces against water depth, log scale
function drawProfile() {
  const cv = ui.profile, ctx = cv.getContext("2d"), W = cv.width, Hh = cv.height;
  const pad = { l: 70, r: 14, t: 12, b: 40 };
  const h0 = Math.max(HMIN, M.H.hmin), h1 = Math.max(h0 * 1.5, M.H.hmax), N = M.N, v = M.v;
  const X = (h) => pad.l + ((Math.log(h) - Math.log(h0)) / (Math.log(h1) - Math.log(h0))) * (W - pad.l - pad.r);
  const Y = (z) => pad.t + (-z / h1) * (Hh - pad.t - pad.b);
  ctx.fillStyle = "#070b16"; ctx.fillRect(0, 0, W, Hh);
  ctx.fillStyle = "#1a2236";
  ctx.beginPath(); ctx.moveTo(X(h0), Y(-h0));
  for (let q = 0; q <= 100; q++) { const h = h0 * (h1 / h0) ** (q / 100); ctx.lineTo(X(h), Y(-h)); }
  ctx.lineTo(X(h1), Hh - pad.b); ctx.lineTo(X(h0), Hh - pad.b); ctx.fill();
  ctx.lineWidth = 1.5;
  for (let k = 0; k <= N; k++) {
    ctx.strokeStyle = k === 0 || k === N ? "rgba(255,255,255,0.85)" : "rgba(140,196,255,0.7)";
    ctx.beginPath();
    for (let q = 0; q <= 100; q++) {
      const h = h0 * (h1 / h0) ** (q / 100), z = R.depth(R.sW(k, N), h, v);
      if (q) ctx.lineTo(X(h), Y(z)); else ctx.moveTo(X(h), Y(z));
    }
    ctx.stroke();
  }
  if (v.hc > h0 && v.hc < h1) {
    ctx.strokeStyle = "#ffb347"; ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.moveTo(X(v.hc), pad.t); ctx.lineTo(X(v.hc), Hh - pad.b); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = "#8a97ab"; ctx.font = "20px system-ui, sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText(`${Math.round(h0)} m`, pad.l, Hh - pad.b + 8);
  ctx.textAlign = "right"; ctx.fillText(`h ${Math.round(h1)} m`, W - pad.r, Hh - pad.b + 8);
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  ctx.fillText("0", pad.l - 8, Y(0)); ctx.fillText(`-${Math.round(h1)}`, pad.l - 8, Y(-h1));
}

function updatePanel() {
  for (const b of ui.kinds.children) b.classList.toggle("active", b.dataset.kind === state.g);
  ui.wh.value = state.wh; ui.wv.value = state.wv;
  ui["wh-out"].textContent = state.wh === 0 ? "index i, j" : state.wh === 1 ? "on the sphere" : "warping";
  ui["wv-out"].textContent = state.wv === 0 ? "index k" : state.wv === 1 ? "depth" : "warping";
  ui.day.value = state.day; ui["day-out"].textContent = fmtDay(state.day);
  ui.field.value = state.f;
  const g = M.H.grid;
  ui.si.value = state.si; ui["si-out"].textContent = `i = ${Math.round(state.si * g.ni)}`;
  ui.sj.value = state.sj; ui["sj-out"].textContent = `j = ${Math.round(state.sj * g.nj)}`;
  for (const k of ["top", "bot", "walls", "sec", "coast", "sm"]) ui[k].checked = !!state[k];
  ui.N.value = state.N; ui["N-out"].textContent = state.N;
  ui.vt.value = state.vt; ui.vs.value = state.vs;
  ui.tb.max = state.vs === 1 ? 1 : 4;
  ui.ts.value = state.ts; ui["ts-out"].textContent = state.ts.toFixed(1);
  ui.tb.value = state.tb; ui["tb-out"].textContent = state.tb.toFixed(2);
  ui.hc.value = hcToSlider(state.hc); ui["hc-out"].textContent = `${state.hc} m`;
  const file = state.g === "file";
  ui.n.disabled = file; ui.bathy.disabled = file;
  ui.n.value = cellsAlongI(); ui["n-out"].textContent = `${g.ni} x ${g.nj} x ${M.N} = ${(g.ni * g.nj * M.N).toLocaleString("en")} cells`;
  ui.dz.value = state.dz; ui["dz-out"].textContent = `x ${Math.round(M.F.exag).toLocaleString("en")} vertical`;
  ui.bathy.value = state.bathy;
  ui["bathy-status"].textContent = file ? "Bathymetry from the file." :
    state.bathy === "gebco" ? (gebco ? "GEBCO 2026 overview, sampled at each vertex; land is masked." : gebcoMsg || "Loading GEBCO...") :
      "Idealized: a coast, shelf, slope, ridge and seamounts.";
  ui.projstring.textContent = R.oceanIn(M.v, M.N);
  ui.projstring.classList.remove("none");
  ui.describe.textContent = g.describe || "";
  // cell sizes across the grid
  const W = g.ni + 1;
  let dmin = Infinity, dmax = 0;
  for (let j = 0; j < g.nj; j += Math.max(1, g.nj >> 5))
    for (let i = 0; i < g.ni; i += Math.max(1, g.ni >> 5)) {
      const k = j * W + i, d = Math.sqrt(R.arcKm(g, k, k + 1) * R.arcKm(g, k, k + W));
      dmin = Math.min(dmin, d); dmax = Math.max(dmax, d);
    }
  const warn = M.v.vt === 1 && M.v.hc > M.H.hmin ? ` Vtransform 1 needs hc <= the shallowest depth (${Math.round(M.H.hmin)} m).` : "";
  ui.stats.textContent = `Cells ${km(dmin)} to ${km(dmax)} across; depth ${Math.round(M.H.hmin)} to ${Math.round(M.H.hmax)} m. ` +
    `rx0 ${M.H.rx0.toFixed(2)}${state.sm && !file ? ` (${M.H.rx0raw.toFixed(2)} before smoothing)` : ""}, rx1 ${M.rx1.toFixed(1)}.${warn}`;
  const p = pickedCell();
  if (p) {
    const { h, mask } = M.H, q = p.j * W + p.i;
    const [lon, lat] = R.lonlatAt(g, p.i + 0.5, p.j + 0.5);
    const hh = mask[q] ? h[q] : HMIN;
    const zt = R.depth(R.sW(p.k + 1, M.N), hh, M.v), zb = R.depth(R.sW(p.k, M.N), hh, M.v), zr = R.depth(R.sRho(p.k + 1, M.N), hh, M.v);
    const t = R.temperature(lon, lat, zr, state.day, (p.i + 0.5) / g.ni, (p.j + 0.5) / g.nj);
    ui["cell-info"].textContent = `Cell i ${p.i}, j ${p.j}, k ${p.k + 1} of ${M.N} (1 at the floor): ${lon.toFixed(2)}${DEG}, ${lat.toFixed(2)}${DEG}; ` +
      (mask[q] ? `z ${zr.toFixed(1)} m, ${(zt - zb).toFixed(1)} m thick, ${km(R.arcKm(g, q, q + 1))} by ${km(R.arcKm(g, q, q + W))}; ${t.toFixed(2)}${DEG}C.` : "land (masked).");
  } else ui["cell-info"].textContent = "Click a surface for that cell's index, place, size and value.";
  drawLegend();
  drawProfile();
}

let rafPending = false, need = { colour: true };
function sync(opts = {}) {
  writeHash();
  if (opts.colour !== false) need.colour = true;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (rebuild()) need.colour = true;
    if (need.colour) for (const s of M.sheets) colourSheet(M, s);
    need.colour = false;
    placeAll();
    updatePanel();
  });
}

function applyVertical(v) {
  if (v.vt === 1 || v.vt === 2) state.vt = v.vt;
  if ([1, 2, 4].includes(v.vs)) state.vs = v.vs;
  if (v.ts !== undefined) state.ts = Math.max(0, Math.min(10, v.ts));
  if (v.tb !== undefined) state.tb = Math.max(0, Math.min(4, v.tb));
  if (v.hc !== undefined) state.hc = Math.max(1, Math.min(1000, v.hc));
  if (v.N) state.N = Math.max(3, Math.min(60, Math.round(v.N)));
}

kindButtons();
ui.wh.addEventListener("input", () => { stopAnim(); state.wh = +ui.wh.value; sync({ colour: false }); });
ui.wv.addEventListener("input", () => { stopAnim(); state.wv = +ui.wv.value; sync({ colour: false }); });
ui.day.addEventListener("input", () => { state.day = +ui.day.value; sync(); });
ui.field.addEventListener("change", () => { state.f = ui.field.value; sync(); });
for (const k of ["si", "sj", "N", "ts", "tb", "dz", "n"])
  ui[k].addEventListener("input", () => { state[k] = +ui[k].value; if (k === "N" || k === "n") state.cell = ""; sync(); });
ui.hc.addEventListener("input", () => { state.hc = sliderToHc(+ui.hc.value); sync(); });
ui.vt.addEventListener("change", () => { state.vt = +ui.vt.value; sync(); });
ui.vs.addEventListener("change", () => { state.vs = +ui.vs.value; if (state.vs === 1) state.tb = Math.min(1, state.tb); sync(); });
for (const k of ["top", "bot", "walls", "sec", "coast", "sm"])
  ui[k].addEventListener("change", () => { state[k] = ui[k].checked ? 1 : 0; sync({ colour: k === "sec" || k === "sm" }); });
ui.bathy.addEventListener("change", () => { state.bathy = ui.bathy.value; startGebco(); sync(); });
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(DEFAULT_CAM); writeHash(); });
$("copy-proj").addEventListener("click", (e) => copy(ui.projstring.textContent, e.target));

// click (not drag) on a surface picks the cell
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObjects(M.sheets.filter((s) => s.mesh.visible).map((s) => s.mesh))[0];
  if (!hit) return;
  const s = hit.object.userData.sheet, g = M.H.grid;
  const fa = Math.min(s.na - 1, Math.floor(hit.uv.x)), fb = Math.min(s.nb - 1, Math.floor(hit.uv.y));
  const o = s.ijk(fa, fb), da = s.ijk(fa + 1, fb), db = s.ijk(fa, fb + 1);
  // an index that moves with a or b is the cell's; one that does not is a face of the box
  const pick = [g.ni, g.nj, M.N].map((n, d) => (da[d] !== o[d] || db[d] !== o[d] ? o[d] : Math.min(n - 1, o[d])));
  const cell = pick.join(",");
  state.cell = state.cell === cell ? "" : cell;
  sync({ colour: false });
});

// animation: warp between the ocean and index space, and run time
let anim = false, dir = -1, lastT = 0, timeAnim = false;
const playBtn = $("play"), timeBtn = $("play-time");
const atIndex = () => state.wh === 0 && state.wv === 0;
function stopAnim() { anim = false; playBtn.textContent = state.wh + state.wv < 1 ? "To the ocean" : "To index space"; }
playBtn.addEventListener("click", () => {
  if (anim) return stopAnim();
  anim = true; dir = state.wh + state.wv < 1 ? 1 : -1; playBtn.textContent = "Stop"; lastT = performance.now();
});
timeBtn.addEventListener("click", () => { timeAnim = !timeAnim; timeBtn.textContent = timeAnim ? "Stop time" : "Run time"; });

function copy(text, btn) {
  const done = () => { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1200); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {});
}
const pageUrl = () => location.origin + location.pathname;
$("copy-link").addEventListener("click", (e) => copy(pageUrl() + location.hash, e.target));
$("copy-embed").addEventListener("click", (e) => copy(
  `<iframe src="${pageUrl()}?embed=1${location.hash}" width="100%" height="480" style="border:0" loading="lazy" title="Index space"></iframe>`,
  e.target));
$("open-full").href = pageUrl() + location.hash;

// ---------------------------------------------------------------- data in

function startGebco() {
  if (state.bathy !== "gebco" || gebco) return;
  gebcoMsg = "Loading GEBCO...";
  loadWorld("gebco", (msg) => { gebcoMsg = msg; if (M) updatePanel(); }).then((w) => {
    gebco = w; sync();
  }, (err) => { gebcoMsg = `GEBCO did not load (${err.message}); using the idealized sea floor.`; if (M) updatePanel(); });
}

async function loadZarr(url) {
  const base = url.replace(/\/(zarr\.json|\.zgroup|\.zattrs|\.zmetadata)$/, "").replace(/\/+$/, "");
  ui["zarr-status"].textContent = "Reading...";
  try {
    const get = async (p) => {
      const r = await fetch(`${base}/${p}`);
      return r.ok ? r.arrayBuffer() : null;
    };
    const f = await R.readRomsZarr(get);
    fileGrid = { ...f, label: `${base.split("/").pop()}: ${f.size[0]} x ${f.size[1]} rho points${f.step > 1 ? `, every ${f.step}th shown` : ""} (Zarr v${f.version}).` };
    state.zu = url; state.g = "file"; state.cell = "";
    applyVertical(f.vertical);
    kindButtons();
    ui["zarr-status"].textContent = fileGrid.label;
    sync();
  } catch (err) {
    ui["zarr-status"].textContent = `Could not read that store: ${err.message}`;
    if (state.g === "file") { state.g = defaults.g; state.zu = ""; sync(); }
  }
}
ui["zarr-load"].addEventListener("click", () => { if (ui["zarr-url"].value.trim()) loadZarr(ui["zarr-url"].value.trim()); });

// ---------------------------------------------------------------- loop

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);

function tick(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (anim) {
    // horizontal first on the way to index space, vertical first on the way back
    const step = dir * dt * 0.28;
    if (dir < 0) { if (state.wv > 0 && state.wh >= 1) state.wv = Math.max(0, state.wv + step); else state.wh = Math.max(0, state.wh + step); }
    else { if (state.wh < 1) state.wh = Math.min(1, state.wh + step); else state.wv = Math.min(1, state.wv + step); }
    if ((dir < 0 && atIndex()) || (dir > 0 && state.wh === 1 && state.wv === 1)) stopAnim();
    sync({ colour: false });
  }
  if (timeAnim) { state.day = (state.day + dt * 30) % 365; sync(); }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

window.addEventListener("hashchange", () => { readHash(); setCamera(state.cam || DEFAULT_CAM); sync(); });

if (embed) {
  document.body.classList.add("embed");
  $("open-full").hidden = false;
}

readHash();
setCamera(state.cam || DEFAULT_CAM);
resize();
if (state.zu) { ui["zarr-url"].value = state.zu; ui["zarr-box"].open = true; const g = state.g; state.g = defaults.g; loadZarr(state.zu).then(() => { if (fileGrid && g !== "file") { state.g = g; sync(); } }); }
startGebco();
sync();
Promise.all([loadCoastline("110m"), loadCoastline("50m").catch(() => null)]).then(([a, b]) => {
  coastLines = { "110m": a, "50m": b };
  if (M) buildCoast();
  sync({ colour: false });
  document.body.classList.add("ready");
});
requestAnimationFrame(tick);
