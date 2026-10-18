// playproj: regular in what?
//
// A storyline in two parts. First the geostationary view, in 3D: a light at
// the satellite, the scan angles it records (not a flat image), the two
// gimbal orders PROJ calls sweep x and sweep y, and the disc unfolded into
// the regular scan-angle grid. Then, in 2D, the lon/lat arrays datasets ship
// for grids like that one, the same grid put back in its own CRS, and a test
// that finds the CRS from the arrays alone (src/core/regular.js).

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as R from "../src/core/regular.js";
import { loadCoastline } from "./data.js";
import { graticule } from "../src/core/geo.js";

R.init(window.proj4);

const DEG = "\u00b0", MU = "\u00b5";
const D2R = Math.PI / 180;
const A_KM = 6378.137, GEO_KM = 35786.023;
const PIX = 56e-6;                 // GOES ABI 2 km pixel, radians

const C = {
  bg: 0x05070d, ocean: "#0b1a33", coast: "#d7ecff", grat: "rgba(140,196,255,0.30)",
  geos: "#ffd34d", other: "#5ed1ff", ray: 0xffd34d, limb: 0xffb347,
  ink: "#dfe7f2", muted: "#8a97ab", grid: "rgba(255,255,255,0.35)", green: "#6ab787", orange: "#ffb347", red: "#ff5d5d"
};

const SATS = [
  { key: "goes-e", label: "GOES-East", lon: -75, sweep: "x" },
  { key: "goes-w", label: "GOES-West", lon: -137, sweep: "x" },
  { key: "himawari", label: "Himawari", lon: 140.7, sweep: "y" },
  { key: "meteosat", label: "Meteosat", lon: 0, sweep: "y" }
];
const satOf = () => SATS.find((s) => s.key === state.sat) || SATS[0];

// ---------------------------------------------------------------- state

const defaults = { s: 0, sat: "goes-e", h: GEO_KM, h2: 3000, mag: 100, t: 0, m: 0, ex: "goes", pick: 0 };
const state = { ...defaults };
const embed = new URLSearchParams(location.search).has("embed");

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  Object.assign(state, defaults);
  for (const k of Object.keys(defaults)) {
    if (!q.has(k)) continue;
    const raw = q.get(k);
    if (k === "sat") state.sat = SATS.some((x) => x.key === raw) ? raw : defaults.sat;
    else if (k === "ex") state.ex = R.EXAMPLES.some((x) => x.key === raw) ? raw : defaults.ex;
    else if (isFinite(+raw)) state[k] = +raw;
  }
  const cl = (k, a, b) => { state[k] = Math.max(a, Math.min(b, state[k])); };
  cl("s", 0, STEPS.length - 1); state.s = Math.round(state.s);
  cl("h", 300, 120000); cl("h2", 300, 120000); cl("mag", 1, 1000); cl("t", 0, 1); cl("m", 0, 1);
  state.pick = Math.max(0, Math.round(state.pick));
}

let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const q = new URLSearchParams();
    for (const k of Object.keys(defaults)) {
      if (k === "ex" && pasted && state.ex === "paste") continue;
      const v = typeof state[k] === "number" ? +state[k].toFixed(3) : state[k];
      if (v !== defaults[k]) q.set(k, String(v));
    }
    const s = q.toString();
    history.replaceState(null, "", s ? "#" + s : location.pathname + location.search);
  }, 200);
}

// ---------------------------------------------------------------- geometry

const rgOf = (hkm) => 1 + hkm / A_KM;
const ease = (x) => x * x * (3 - 2 * x);

// geographic lon/lat to the scene: 0E towards +z, east +x, north +y
function toScene(lon, lat, r = 1) {
  const p = lat * D2R, l = lon * D2R;
  return new THREE.Vector3(Math.cos(p) * Math.sin(l) * r, Math.sin(p) * r, Math.cos(p) * Math.cos(l) * r);
}

// where a direction from the satellite (toward the Earth, east, north) meets
// the unit sphere, as lon/lat, or null
function hit(d, rg, lon0) {
  const n = Math.hypot(d[0], d[1], d[2]), d0 = d[0] / n, d1 = d[1] / n, d2 = d[2] / n;
  const disc = rg * rg * d0 * d0 - rg * rg + 1;
  if (disc < 0) return null;
  const s = rg * d0 - Math.sqrt(disc);
  const x = rg - s * d0, y = s * d1, z = s * d2;
  return [Math.atan2(y, x) / D2R + lon0, Math.asin(Math.max(-1, Math.min(1, z))) / D2R];
}

// ---------------------------------------------------------------- 3D scene

const stage = document.getElementById("three");
const view = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(C.bg);
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 400);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// the Earth: a lon/lat lattice so the texture lines up with toScene
const earthCanvas = document.createElement("canvas");
earthCanvas.width = 2048; earthCanvas.height = 1024;
const earthTex = new THREE.CanvasTexture(earthCanvas);
earthTex.colorSpace = THREE.SRGBColorSpace;
earthTex.anisotropy = 4;
{
  const NX = 180, NY = 90, pos = [], uv = [], idx = [];
  for (let j = 0; j <= NY; j++)
    for (let i = 0; i <= NX; i++) {
      const lon = -180 + (360 * i) / NX, lat = -90 + (180 * j) / NY;
      const v = toScene(lon, lat);
      pos.push(v.x, v.y, v.z); uv.push(i / NX, j / NY);
    }
  for (let j = 0; j < NY; j++)
    for (let i = 0; i < NX; i++) {
      const a = j * (NX + 1) + i, b = a + NX + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: earthTex, side: THREE.FrontSide })));
}

function drawEarth(coast) {
  const ctx = earthCanvas.getContext("2d"), W = earthCanvas.width, H = earthCanvas.height;
  ctx.fillStyle = C.ocean; ctx.fillRect(0, 0, W, H);
  const stroke = (lines, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    for (const l of lines) {
      for (let k = 0; k < l.length; k += 2) {
        const x = ((l[k] + 180) / 360) * W, y = ((90 - l[k + 1]) / 180) * H;
        if (k && Math.abs(l[k] - l[k - 2]) < 180) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
    }
    ctx.stroke();
  };
  stroke(graticule(15, 1), C.grat, 1.5);
  if (coast) stroke(coast, C.coast, 2);
  earthTex.needsUpdate = true;
}

const sat = new THREE.Mesh(new THREE.OctahedronGeometry(0.07), new THREE.MeshBasicMaterial({ color: 0xffd34d }));
scene.add(sat);

function lineObject(color, opacity = 1) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
  const o = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
  scene.add(o);
  return o;
}
// polylines (arrays of Vector3, null to break) into segment pairs
function setLines(obj, lines) {
  const a = [];
  for (const l of lines)
    for (let k = 1; k < l.length; k++) if (l[k] && l[k - 1]) a.push(l[k - 1].x, l[k - 1].y, l[k - 1].z, l[k].x, l[k].y, l[k].z);
  obj.geometry.dispose();
  obj.geometry = new THREE.BufferGeometry();
  obj.geometry.setAttribute("position", new THREE.Float32BufferAttribute(a, 3));
}

const rays = lineObject(C.ray, 0.45);
const limb = lineObject(C.limb, 0.8);
const gridA = lineObject(new THREE.Color(C.geos).getHex());
const gridB = lineObject(new THREE.Color(C.other).getHex());

// the disc for unfolding: a polar lattice in scan angles, textured in scan angles
const discCanvas = document.createElement("canvas");
discCanvas.width = discCanvas.height = 1024;
const discTex = new THREE.CanvasTexture(discCanvas);
discTex.colorSpace = THREE.SRGBColorSpace;
discTex.anisotropy = 4;
const disc = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ map: discTex, side: THREE.DoubleSide }));
scene.add(disc);
let discData = null;    // { key, globe, flat, edge, tmax }

// the scan-angle radius of the disc along direction psi: the limb, by bisection
function edgeRadius(psi, sweep, rg) {
  let lo = 0, hi = Math.asin(1 / rg) * 1.3;
  for (let k = 0; k < 40; k++) {
    const m = (lo + hi) / 2;
    if (R.scanToLonLat(m * Math.cos(psi), m * Math.sin(psi), sweep, rg)) lo = m; else hi = m;
  }
  return lo * 0.9995;
}

function buildDisc(coast) {
  const s = satOf(), rg = rgOf(GEO_KM), key = s.key + "|" + (coast ? 1 : 0);
  if (discData && discData.key === key) return;
  const NR = 40, NA = 160, edge = [];
  for (let a = 0; a < NA; a++) edge.push(edgeRadius((2 * Math.PI * a) / NA, s.sweep, rg));
  const tmax = Math.max(...edge) * 1.01;
  const U = toScene(s.lon, 0), E = toScene(s.lon + 90, 0), N = new THREE.Vector3(0, 1, 0);
  const globe = [], flat = [], uv = [], idx = [];
  const add = (ax, ay) => {
    const ll = R.scanToLonLat(ax, ay, s.sweep, rg, s.lon) || [s.lon, 0];
    const g = toScene(ll[0], ll[1], 1.004);
    globe.push(g.x, g.y, g.z);
    const f = U.clone().multiplyScalar(1.05).addScaledVector(E, ax / tmax).addScaledVector(N, ay / tmax);
    flat.push(f.x, f.y, f.z);
    uv.push((ax / tmax + 1) / 2, (ay / tmax + 1) / 2);
  };
  add(0, 0);
  for (let r = 1; r <= NR; r++)
    for (let a = 0; a < NA; a++) {
      const psi = (2 * Math.PI * a) / NA, rho = edge[a] * (r / NR);
      add(rho * Math.cos(psi), rho * Math.sin(psi));
    }
  const at = (r, a) => (r === 0 ? 0 : 1 + (r - 1) * NA + (a % NA));
  for (let r = 0; r < NR; r++)
    for (let a = 0; a < NA; a++) {
      if (r === 0) idx.push(0, at(1, a), at(1, a + 1));
      else idx.push(at(r, a), at(r + 1, a), at(r + 1, a + 1), at(r, a), at(r + 1, a + 1), at(r, a + 1));
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(globe.slice(), 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  disc.geometry.dispose();
  disc.geometry = g;
  discData = { key, globe: Float32Array.from(globe), flat: Float32Array.from(flat), tmax };

  // the texture: coastline and graticule in scan angles, and the pixel grid, straight
  const ctx = discCanvas.getContext("2d"), W = discCanvas.width;
  const px = (ax) => ((ax / tmax + 1) / 2) * W, py = (ay) => (1 - (ay / tmax + 1) / 2) * W;
  ctx.fillStyle = "#05070d"; ctx.fillRect(0, 0, W, W);
  ctx.beginPath();
  edge.forEach((rho, a) => { const psi = (2 * Math.PI * a) / NA; ctx.lineTo(px(rho * Math.cos(psi)), py(rho * Math.sin(psi))); });
  ctx.closePath();
  ctx.fillStyle = C.ocean; ctx.fill();
  ctx.save(); ctx.clip();
  const stroke = (lines, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    for (const l of lines) {
      let on = false;
      for (let k = 0; k < l.length; k += 2) {
        const q = R.lonLatToScan(l[k], l[k + 1], s.sweep, rg, s.lon);
        if (!q) { on = false; continue; }
        if (on) ctx.lineTo(px(q[0]), py(q[1])); else ctx.moveTo(px(q[0]), py(q[1]));
        on = true;
      }
    }
    ctx.stroke();
  };
  stroke(graticule(15, 1), C.grat, 2);
  if (coast) stroke(coast, C.coast, 2.5);
  // the fixed grid: every 0.01 rad of scan angle, about 180 GOES pixels
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1.5; ctx.beginPath();
  for (let a = -0.15; a <= 0.1501; a += 0.01) {
    ctx.moveTo(px(a), 0); ctx.lineTo(px(a), W);
    ctx.moveTo(0, py(a)); ctx.lineTo(W, py(a));
  }
  ctx.stroke();
  ctx.restore();
  discTex.needsUpdate = true;
}

function placeDisc() {
  if (!discData) return;
  const e = ease(state.t), pos = disc.geometry.attributes.position.array;
  for (let k = 0; k < pos.length; k++) pos[k] = discData.globe[k] + (discData.flat[k] - discData.globe[k]) * e;
  disc.geometry.attributes.position.needsUpdate = true;
  disc.geometry.computeBoundingSphere();
}

// scan-angle grid lines on the globe: constant x angle, then constant y angle
function scanLines(dirFn, steps, rg, lon0, r = 1.004) {
  const lines = [];
  for (const fixed of [0, 1])
    for (const a of steps) {
      const l = [];
      for (let k = 0; k <= 200; k++) {
        const b = -steps.lim + (2 * steps.lim * k) / 200;
        const ll = hit(fixed === 0 ? dirFn(a, b) : dirFn(b, a), rg, lon0);
        l.push(ll ? toScene(ll[0], ll[1], r) : null);
      }
      lines.push(l);
    }
  return lines;
}
const geosDir = (sweep) => (ax, ay) => R.scanDirection(ax, ay, sweep);
const planeDir = (u, v) => [1, u, v];

function update3D() {
  const s = satOf(), step = STEPS[state.s];
  const hkm = step.key === "plane" ? state.h2 : step.key === "light" ? state.h : GEO_KM;
  const rg = rgOf(hkm), td = Math.asin(1 / rg);
  sat.position.copy(toScene(s.lon, 0, rg));
  rays.visible = limb.visible = gridA.visible = gridB.visible = false;
  disc.visible = false;

  if (step.key === "light") {
    // the light at the satellite: rays to a lattice of scan angles, and the limb
    const L = [], sp = sat.position.clone();
    for (let a = -4; a <= 4; a++)
      for (let b = -4; b <= 4; b++) {
        const ll = hit(R.scanDirection((a / 4.4) * td, (b / 4.4) * td, s.sweep), rg, s.lon);
        if (ll) L.push([sp, toScene(ll[0], ll[1])]);
      }
    setLines(rays, L);
    const c = Math.acos(1 / rg), U = toScene(s.lon, 0), E = toScene(s.lon + 90, 0), N = new THREE.Vector3(0, 1, 0);
    const ring = [], cone = [];
    for (let k = 0; k <= 96; k++) {
      const psi = (2 * Math.PI * k) / 96;
      const p = U.clone().multiplyScalar(Math.cos(c)).addScaledVector(E, Math.sin(c) * Math.cos(psi)).addScaledVector(N, Math.sin(c) * Math.sin(psi)).multiplyScalar(1.003);
      ring.push(p);
      if (k % 4 === 0) cone.push([sp, p]);
    }
    setLines(limb, [ring, ...cone]);
    const steps = Object.assign([-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75].map((x) => x * td), { lim: td });
    setLines(gridA, scanLines(geosDir(s.sweep), steps, rg, s.lon));
    rays.visible = limb.visible = gridA.visible = true;
  } else if (step.key === "plane") {
    // equal steps of angle (geos) against equal steps on a flat image (nsper)
    const n = 8, steps = Object.assign([], { lim: td });
    for (let k = -n; k <= n; k++) steps.push((k / n) * td * 0.999);
    setLines(gridA, scanLines(geosDir(s.sweep), steps, rg, s.lon));
    const ps = Object.assign(steps.map((a) => a), { lim: Math.tan(td) });
    setLines(gridB, scanLines(planeDir, ps, rg, s.lon, 1.006));
    gridA.visible = gridB.visible = true;
  } else if (step.key === "sweep") {
    // the same scan angles with the other gimbal order, the difference magnified
    const other = s.sweep === "x" ? "y" : "x", n = 8, lines = [], linesA = [];
    for (const fixed of [0, 1])
      for (let k = -n; k <= n; k++) {
        const a = (k / n) * td, la = [], lb = [];
        for (let m = 0; m <= 200; m++) {
          const b = -td + (2 * td * m) / 200;
          const [ax, ay] = fixed === 0 ? [a, b] : [b, a];
          const pa = hit(R.scanDirection(ax, ay, s.sweep), rg, s.lon), pb = hit(R.scanDirection(ax, ay, other), rg, s.lon);
          if (!pa || !pb) { la.push(null); lb.push(null); continue; }
          const va = toScene(pa[0], pa[1]), vb = toScene(pb[0], pb[1]);
          la.push(va.clone().multiplyScalar(1.004));
          lb.push(va.clone().addScaledVector(vb.sub(va), state.mag).normalize().multiplyScalar(1.006));
        }
        linesA.push(la); lines.push(lb);
      }
    setLines(gridA, linesA); setLines(gridB, lines);
    gridA.visible = gridB.visible = true;
  } else if (step.key === "unfold") {
    buildDisc(coastLines);
    placeDisc();
    disc.visible = true;
  }
}

// a view for each step, from the satellite's side
function cameraFor(step) {
  const s = satOf(), lon = s.lon;
  if (step.key === "light") {
    const rg = rgOf(state.h);
    return [toScene(lon + 75, 28, Math.max(5, rg * 1.55)), toScene(lon, 0, Math.min(rg, 20) * 0.42)];
  }
  if (step.key === "plane") return [toScene(lon + 32, 22, 3.1), new THREE.Vector3()];
  if (step.key === "sweep") return [toScene(lon + 12, 8, 3.4), new THREE.Vector3()];
  return [toScene(lon + 50, 22, 4.6), toScene(lon, 0, 0.5)];
}
function resetCamera() {
  const [p, t] = cameraFor(STEPS[state.s]);
  camera.position.copy(p); controls.target.copy(t); controls.update();
}

// ---------------------------------------------------------------- 2D

const ctx2 = view.getContext("2d");
let W2 = 0, H2 = 0;
function size2d() {
  const r = view.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
  W2 = Math.max(1, r.width); H2 = Math.max(1, r.height);
  view.width = Math.round(W2 * dpr); view.height = Math.round(H2 * dpr);
  ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l), f = (n) => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

// the lon and lat arrays as two images, as stored: row 0 at the top
const arrays = new Map();
function arraysOf(ex) {
  if (arrays.has(ex.key)) return arrays.get(ex.key);
  const big = 200, a = ex.ni / ex.nj;
  const w = a >= 1 ? big : Math.max(24, Math.round(big * a)), h = a >= 1 ? Math.max(24, Math.round(big / a)) : big;
  const lon = new Float32Array(w * h), lat = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ll = ex.lonlat(((x + 0.5) / w) * ex.ni - 0.5, ((y + 0.5) / h) * ex.nj - 0.5);
      lon[y * w + x] = ll ? ll[0] : NaN; lat[y * w + x] = ll ? ll[1] : NaN;
    }
  const out = { w, h, lon, lat };
  arrays.set(ex.key, out);
  return out;
}
function arrayImage(vals, w, h, kind) {
  const img = new ImageData(w, h);
  for (let k = 0; k < vals.length; k++) {
    const v = vals[k];
    let c = [16, 20, 32];
    if (Number.isFinite(v)) {
      const band = Math.floor(v / 10) & 1;
      c = kind === "lon" ? hsl((((v + 180) % 360) + 360) % 360 / 360, 0.55, band ? 0.42 : 0.52)
        : hsl(0.62 - ((v + 90) / 180) * 0.62, 0.6, band ? 0.40 : 0.50);
    }
    img.data[4 * k] = c[0]; img.data[4 * k + 1] = c[1]; img.data[4 * k + 2] = c[2]; img.data[4 * k + 3] = 255;
  }
  return img;
}
function label(text, x, y, color = C.muted, align = "center", size = 13) {
  ctx2.fillStyle = color; ctx2.font = `${size}px system-ui, sans-serif`;
  ctx2.textAlign = align; ctx2.textBaseline = "top";
  ctx2.fillText(text, x, y);
}

function drawArrays(ex) {
  const A = arraysOf(ex), gap = 30, pad = 36;
  const side = W2 > H2 * 1.2;
  const cw = side ? (W2 - 2 * pad - gap) / 2 : W2 - 2 * pad, ch = side ? H2 - 2 * pad - 40 : (H2 - 2 * pad - gap - 60) / 2;
  const sc = Math.min(cw / A.w, ch / A.h), dw = A.w * sc, dh = A.h * sc;
  [["lon", A.lon, "longitude[" + ex.nj + ", " + ex.ni + "]"], ["lat", A.lat, "latitude[" + ex.nj + ", " + ex.ni + "]"]].forEach(([k, vals, name], m) => {
    const x0 = side ? pad + m * (cw + gap) + (cw - dw) / 2 : pad + (cw - dw) / 2;
    const y0 = side ? pad + (ch - dh) / 2 : pad + m * (ch + gap + 30) + (ch - dh) / 2;
    const c = document.createElement("canvas");
    c.width = A.w; c.height = A.h;
    c.getContext("2d").putImageData(arrayImage(vals, A.w, A.h, k), 0, 0);
    ctx2.imageSmoothingEnabled = false;
    ctx2.drawImage(c, x0, y0, dw, dh);
    ctx2.strokeStyle = "#1f2a40"; ctx2.strokeRect(x0, y0, dw, dh);
    label(name, x0 + dw / 2, y0 + dh + 8, C.ink);
    label("row 0 at the top", x0, y0 - 16, C.muted, "left", 11);
  });
  const mb = (2 * ex.ni * ex.nj * 4) / 1e6;
  label(`Two float32 arrays: ${mb >= 1 ? mb.toFixed(0) + " MB" : (mb * 1000).toFixed(0) + " kB"} to say what a CRS and six numbers say. Bands are every 10${DEG}.`, W2 / 2, H2 - 26, C.muted);
}

// lattice lines of the grid as lon/lat and as index
function latticeOf(ex) {
  const lines = [], NL = 24, NS = 120;
  for (const along of [0, 1]) {
    const n = along ? ex.ni : ex.nj, m = along ? ex.nj : ex.ni;
    for (let k = 0; k <= NL; k++) {
      const fixed = (k / NL) * (n - 1), l = [];
      for (let q = 0; q <= NS; q++) {
        const run = (q / NS) * (m - 1), i = along ? fixed : run, j = along ? run : fixed;
        const ll = ex.lonlat(i, j);
        l.push(ll ? { ll, ij: [i, j] } : null);
      }
      lines.push(l);
    }
  }
  return lines;
}
const lattices = new Map();

// coastline clipped to the grid: lon/lat and index for every vertex inside
const coastIdx = new Map();
function coastOf(ex) {
  if (!coastLines || !ex.index) return [];
  if (coastIdx.has(ex.key)) return coastIdx.get(ex.key);
  const out = [], mi = ex.ni * 0.25;
  for (const l of coastLines) {
    let cur = [];
    for (let k = 0; k < l.length; k += 2) {
      const ij = ex.index(l[k], l[k + 1]);
      const inside = ij && ij[0] >= -0.5 && ij[0] <= ex.ni - 0.5 && ij[1] >= -0.5 && ij[1] <= ex.nj - 0.5;
      const prev = cur[cur.length - 1];
      if (!inside || (prev && Math.abs(ij[0] - prev.ij[0]) > mi)) { if (cur.length > 1) out.push(cur); cur = []; if (!inside) continue; }
      cur.push({ ll: [l[k], l[k + 1]], ij });
    }
    if (cur.length > 1) out.push(cur);
  }
  coastIdx.set(ex.key, out);
  return out;
}

// screen placement that fits a set of points, equal aspect
function fitter(pts, pad = 40) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const s = Math.min((W2 - 2 * pad) / (x1 - x0 || 1), (H2 - 2 * pad - 30) / (y1 - y0 || 1));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return (p) => [W2 / 2 + (p[0] - cx) * s, (H2 - 30) / 2 - (p[1] - cy) * s];
}

// orientation of index space: north up when the rows run north or south
function indexXY(ex) {
  const up = ex.dy === undefined ? 1 : Math.sign(ex.dy) || 1, right = ex.dx === undefined ? 1 : Math.sign(ex.dx) || 1;
  return (ij) => [ij[0] * right, ij[1] * up];
}

function drawMorph(ex) {
  if (!lattices.has(ex.key)) lattices.set(ex.key, latticeOf(ex));
  const lat = lattices.get(ex.key), coast = coastOf(ex), e = ease(state.m), ixy = indexXY(ex);
  const c = R.describe(R.sampleExample(ex, 9));
  const toPair = (l) => l.map((p) => p && { a: [c.lon + ((((p.ll[0] - c.lon + 180) % 360) + 360) % 360) - 180, p.ll[1]], b: ixy(p.ij) });
  const L = lat.map(toPair), K = coast.map(toPair);
  const all = L.flat().filter(Boolean);
  const fa = fitter(all.map((p) => p.a)), fb = fitter(all.map((p) => p.b));
  const place = (p) => { const a = fa(p.a), b = fb(p.b); return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e]; };
  const strokeSet = (set, color, width) => {
    ctx2.strokeStyle = color; ctx2.lineWidth = width; ctx2.beginPath();
    for (const l of set) {
      let on = false, prev = null;
      for (const p of l) {
        if (!p) { on = false; continue; }
        const q = place(p);
        // a line that crosses the lon/lat seam breaks there until it is all the way home
        if (on && prev && e < 0.999 && Math.abs(p.a[0] - prev.a[0]) > 180) on = false;
        if (on) ctx2.lineTo(q[0], q[1]); else ctx2.moveTo(q[0], q[1]);
        on = true; prev = p;
      }
    }
    ctx2.stroke();
  };
  strokeSet(L, "rgba(255,211,77,0.55)", 1);
  strokeSet(K, C.coast, 1.3);
  const where = state.m < 0.02 ? "as longitude and latitude" : state.m > 0.98 ? (ex.crs ? "in its own CRS: every line straight, every cell the same" : "as the model's array") : "";
  label(where, W2 / 2, H2 - 26, C.muted);
}

// residuals of one candidate, in index space, magnified
function drawResiduals(samples, r) {
  ctx2.fillStyle = "#05070d"; ctx2.fillRect(0, 0, W2, H2);
  if (!r || !r.fit.I) { label(running ? "Testing..." : "", W2 / 2, H2 / 2, C.muted); return; }
  const f = r.fit, up = f.b[2] < 0 ? -1 : 1;
  const pts = f.I.map((i, k) => [i, up * f.J[k]]);
  const fit = fitter(pts, 50);
  let max = 0;
  for (let k = 0; k < f.I.length; k++) max = Math.max(max, Math.hypot(f.res[2 * k], f.res[2 * k + 1]));
  const sp = Math.max(1, ...pts.map((p) => p[0])) / Math.sqrt(f.I.length);
  const mag = max > 0 ? (sp * 0.9) / max : 1;
  for (let k = 0; k < f.I.length; k++) {
    const a = fit(pts[k]), ri = f.res[2 * k], rj = f.res[2 * k + 1], m = Math.hypot(ri, rj);
    const b = fit([pts[k][0] + ri * mag, pts[k][1] + up * rj * mag]);
    const col = m < 0.01 ? C.green : m < 0.25 ? C.orange : C.red;
    ctx2.strokeStyle = col; ctx2.lineWidth = 1.2;
    ctx2.beginPath(); ctx2.moveTo(a[0], a[1]); ctx2.lineTo(b[0], b[1]); ctx2.stroke();
    ctx2.fillStyle = col; ctx2.beginPath(); ctx2.arc(a[0], a[1], 1.8, 0, 2 * Math.PI); ctx2.fill();
  }
  const x = mag >= 10 ? Math.round(mag).toLocaleString("en") : mag.toPrecision(2);
  label(`${r.label} (${r.shape}): what the affine fit misses at each sample, drawn ${x} times larger. ` +
    `Largest ${fmtCells(max)}.`, W2 / 2, H2 - 26, C.muted);
}

const fmtCells = (v) => v === 0 ? "0 cells" : v < 1e-3 ? v.toExponential(1) + " cells" : v < 10 ? v.toPrecision(2) + " cells" : Math.round(v) + " cells";

// ---------------------------------------------------------------- testing

const results = new Map();     // example key or "paste" -> { list, samples }
let running = false, pasted = null;

function samplesFor() {
  if (state.ex === "paste" && pasted) return pasted;
  return R.sampleExample(R.exampleByKey(state.ex), 25);
}

async function runTest() {
  const key = state.ex;
  if (results.has(key) || running) return;
  running = true;
  const samples = samplesFor(), entry = { list: [], samples, done: false };
  results.set(key, entry);
  sync();
  await R.testAll(samples, { onEach: (r, all) => { entry.list = all.slice().sort(R.rank); sync(); } });
  entry.list.sort(R.rank);
  entry.done = true;
  running = false;
  sync();
}

const $ = (id) => document.getElementById(id);
const ui = {
  title: $("step-title"), caption: $("caption"), param: $("param"), paramLabel: $("param-label"), paramOut: $("param-out"),
  paramBox: $("param-box"), count: $("count"), steps: $("steps"), sats: $("sats"), examples: $("examples"),
  pasteBox: $("paste-box"), resultBox: $("result-box"), cands: $("candidates"), proj: $("projstring"), answer: $("answer"),
  play: $("play")
};

function showResults() {
  const entry = results.get(state.ex);
  ui.cands.innerHTML = "";
  if (!entry) { ui.proj.textContent = ""; ui.answer.textContent = ""; return; }
  const head = document.createElement("tr");
  head.innerHTML = "<td>Candidate</td><td>Shape</td><td>Largest miss</td>";
  ui.cands.appendChild(head);
  entry.list.slice(0, 8).forEach((r, k) => {
    const tr = document.createElement("tr");
    tr.dataset.k = k;
    if (k === Math.min(state.pick, entry.list.length - 1)) tr.classList.add("active");
    const v = R.verdict(r.fit);
    tr.innerHTML = `<td style="white-space:normal">${r.label}</td><td>${r.shape}</td>` +
      `<td style="color:${v === "regular" ? C.green : v === "nearly" ? C.orange : C.muted}">${r.fit.miss ? "off map" : fmtCells(r.fit.max)}</td>`;
    tr.addEventListener("click", () => { state.pick = k; sync(); });
    ui.cands.appendChild(tr);
  });
  const r = entry.list[Math.min(state.pick, entry.list.length - 1)];
  if (!r) { ui.proj.textContent = running ? "testing..." : ""; ui.answer.textContent = ""; return; }
  const d = R.describeResult(r), g = d.grid, s = entry.samples;
  ui.proj.textContent = d.crs;
  const gt = d.gt.map((v) => +v.toPrecision(12));
  const bits = [];
  const v = R.verdict(r.fit);
  bits.push(v === "regular" ? `Regular: no sample is more than ${fmtCells(r.fit.max)} from a straight grid.`
    : v === "nearly" ? `Nearly: the grid bends by up to ${fmtCells(r.fit.max)} in this CRS.`
    : r.fit.miss ? `${r.fit.miss} samples fall off this projection.` : `Not regular: misses by up to ${fmtCells(r.fit.max)}.`);
  if (g.angleStep) bits.push(`Scan angle step ${(Math.abs(g.angleStep[0]) * 1e6).toFixed(3)} ${MU}rad, satellite height ${Math.round(g.h).toLocaleString("en")} m.`);
  else if (g.units === "degrees") bits.push(`Cell ${+Math.abs(g.dx).toPrecision(8)} by ${+Math.abs(g.dy).toPrecision(8)} degrees.`);
  else {
    const dx = Math.abs(gt[1]) || Math.hypot(gt[1], gt[4]), dy = Math.abs(gt[5]) || Math.hypot(gt[2], gt[5]);
    bits.push(`Cell ${+dx.toPrecision(10)} by ${+dy.toPrecision(10)} m${g.snapped ? `, round on ${g.radius.name}` : ""}.`);
    if (g.arc) bits.push(`That is 1/${g.arc} degree of arc on any sphere.`);
  }
  if (v !== "no" && !r.fit.miss) {
    bits.push(`Geotransform (cell corners, column i, row j): ${gt.join(", ")}.`);
    const ni = s.ni || Math.max(...s.i) + 1, nj = s.nj || Math.max(...s.j) + 1;
    if (gt[2] === 0 && gt[4] === 0 && typeof r.crs === "string") {
      const xs = [gt[0], gt[0] + ni * gt[1]].sort((a, b) => a - b), ys = [gt[3], gt[3] + nj * gt[5]].sort((a, b) => a - b);
      const ext = [xs[0], xs[1], ys[0], ys[1]].map((x) => +x.toPrecision(12));
      const link = `./structure.html#spec=1&crs=${encodeURIComponent(d.crs)}&ext=${ext.join(",")}&dim=${ni},${nj}&tile=512&lev=0`;
      bits.push(`<a href="${link}">Open as a grid spec in Tiles and overviews</a>${gt[5] > 0 ? " (rows run south to north here, so flip them first)" : ""}.`);
    }
  }
  ui.answer.innerHTML = bits.join(" ");
}

// ---------------------------------------------------------------- steps

const logH = { min: 300, max: 120000, to: (v) => Math.log(v / 300) / Math.log(400), from: (x) => 300 * Math.pow(400, x) };
const fmtKm = (v) => `${Math.round(v).toLocaleString("en")} km`;

function edgePixels(hkm) {
  const td = Math.asin(1 / rgOf(hkm));
  return (Math.tan(td) - td) / PIX;
}
function sweepDiff() {
  const rg = rgOf(GEO_KM), td = Math.asin(1 / rg);
  let km = 0, pix = 0;
  for (let a = -1; a <= 1.0001; a += 0.05)
    for (let b = -1; b <= 1.0001; b += 0.05) {
      const ax = a * td, ay = b * td;
      const p = R.scanToLonLat(ax, ay, "x", rg), q = R.scanToLonLat(ax, ay, "y", rg);
      if (!p || !q) continue;
      const back = R.lonLatToScan(p[0], p[1], "y", rg);
      const cp = Math.cos(p[1] * D2R), cq = Math.cos(q[1] * D2R);
      const d = Math.acos(Math.min(1, Math.sin(p[1] * D2R) * Math.sin(q[1] * D2R) + cp * cq * Math.cos((p[0] - q[0]) * D2R)));
      if (Math.abs(a) < 0.95 && Math.abs(b) < 0.95) km = Math.max(km, d * A_KM);
      if (back) pix = Math.max(pix, Math.hypot(back[0] - ax, back[1] - ay) / PIX);
    }
  return { km, pix };
}
const SWEEP = sweepDiff();

const STEPS = [
  {
    key: "light", mode: "3d", title: "A light at the satellite",
    caption: () => `A geostationary satellite sits ${fmtKm(GEO_KM)} above the equator, ${rgOf(GEO_KM).toFixed(2)} Earth radii from the centre, ` +
      `and sees the Earth as a point of light would light it: a cap out to the limb (orange), ${(100 * (1 - 1 / rgOf(state.h)) / 2).toFixed(0)}% ` +
      `of the globe from ${fmtKm(state.h)}. That is the near-side perspective on the Perspective page, with its light this far out. ` +
      `The instrument does not take a picture, though: it steps a mirror through fixed angles (amber lines).`,
    param: { key: "h", label: "Height", ...logH, fmt: fmtKm }, sats: true
  },
  {
    key: "plane", mode: "3d", title: "Angles, not a plane",
    caption: () => `A camera's pixels are equal steps across a flat image (blue, +proj=nsper). A scanning imager's pixels are equal steps ` +
      `of angle (amber, +proj=geos, x and y in radians times h). Near the satellite the two part company fast; at geostationary height ` +
      `they look alike, but a flat image is still ${edgePixels(GEO_KM).toFixed(0)} GOES pixels out at the edge of the disc. ` +
      `From ${fmtKm(state.h2)} it would be ${edgePixels(state.h2) > 1e4 ? "thousands of" : Math.round(edgePixels(state.h2)).toLocaleString("en")} pixels.`,
    param: { key: "h2", label: "Height", ...logH, fmt: fmtKm }, sats: true
  },
  {
    key: "sweep", mode: "3d", title: "Two gimbals: sweep x and sweep y",
    caption: () => `The mirror turns about two axes, one inside the other. GOES turns about the north-south axis inside the east-west one ` +
      `(PROJ's sweep=x); Meteosat and Himawari the other way round (sweep=y). The same pair of angles lands in a different place: ` +
      `up to ${SWEEP.km.toFixed(0)} km apart near the corners of the disc, or ${SWEEP.pix.toFixed(0)} pixels. ` +
      `Amber is ${satOf().label}'s own sweep, blue the other one, magnified.`,
    param: { key: "mag", label: "Magnify the difference", min: 1, max: 1000, to: (v) => Math.log(v) / Math.log(1000), from: (x) => Math.pow(1000, x), fmt: (v) => `${Math.round(v)} x` },
    sats: true
  },
  {
    key: "unfold", mode: "3d", title: "Unfold to the fixed grid",
    caption: () => `Lay the disc flat in scan angles and the instrument's grid is a plain rectangle of equal cells: 5424 x 5424 for ` +
      `GOES at 2 km, 56 ${MU}rad apart, the lines here every 0.01 rad. The Earth is what bends. This is the grid the data are regular in, ` +
      `and the files say so: x and y as 1D scan angles and a goes_imager_projection variable.`,
    param: { key: "t", label: "Unfold", min: 0, max: 1, to: (v) => v, from: (x) => x, fmt: (v) => v === 0 ? "globe" : v === 1 ? "flat" : "unfolding" },
    sats: true, play: "t"
  },
  {
    key: "arrays", mode: "2d", title: "What ships: two arrays",
    caption: () => `${R.exampleByKey(state.ex).source} ${R.exampleByKey(state.ex).ships}`,
    examples: true
  },
  {
    key: "morph", mode: "2d", title: "Put it back",
    caption: () => `The same grid lines (amber) and coast, drawn by their longitude and latitude, then moved to where the grid ` +
      `came from. ${R.exampleByKey(state.ex).crs ? "In the right CRS every line is straight and every cell the same: two arrays become six numbers." :
      "This one came from no CRS: its own array is the only flat version, and the coast has to fold to fit."}`,
    param: { key: "m", label: "Lon/lat to its own grid", min: 0, max: 1, to: (v) => v, from: (x) => x, fmt: (v) => v === 0 ? "lon/lat" : v === 1 ? "own grid" : "" },
    examples: true, play: "m"
  },
  {
    key: "test", mode: "2d", title: "Regular in what?",
    caption: () => `Given only the arrays, try each kind of projection: project the samples, fit a straight grid, and see what it misses. ` +
      `Parameters that bend the grid (a cone constant, a satellite's longitude and height, a pole) are searched for; those that only ` +
      `move, turn or scale it don't matter. Click a row to see its misses.`,
    examples: true, results: true
  },
  {
    key: "yours", mode: "2d", title: "Your own arrays",
    caption: () => `Paste samples of a lon/lat pair: a few hundred spread over the grid are plenty, and the corners alone are not ` +
      `enough to tell. Four columns are i j lon lat; two are lon lat in row order with the number of columns given.`,
    paste: true, results: true
  }
];

// ---------------------------------------------------------------- panel

for (const s of SATS) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = s.label; b.dataset.key = s.key;
  b.addEventListener("click", () => { state.sat = s.key; resetCamera(); sync(); });
  ui.sats.appendChild(b);
}
for (const ex of R.EXAMPLES) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = ex.label; b.dataset.key = ex.key;
  b.addEventListener("click", () => { state.ex = ex.key; state.pick = 0; sync(); });
  ui.examples.appendChild(b);
}
STEPS.forEach((st, k) => {
  const li = document.createElement("li");
  li.textContent = st.title;
  li.addEventListener("click", () => go(k));
  ui.steps.appendChild(li);
});

function go(k) {
  stopAnim();
  const was = STEPS[state.s];
  state.s = Math.max(0, Math.min(STEPS.length - 1, k));
  const st = STEPS[state.s];
  if (st.paste) { if (pasted) state.ex = "paste"; }
  else if (state.ex === "paste") state.ex = defaults.ex;
  state.pick = 0;
  if (st.mode === "3d" && (was.key !== st.key)) resetCamera();
  sync();
}
$("prev").addEventListener("click", () => go(state.s - 1));
$("next").addEventListener("click", () => go(state.s + 1));

ui.param.addEventListener("input", () => {
  stopAnim();
  const p = STEPS[state.s].param;
  state[p.key] = p.from(+ui.param.value);
  sync();
});

$("run").addEventListener("click", () => {
  const msg = $("paste-msg");
  try {
    pasted = R.parseSamples($("paste").value, +$("ncol").value || 0);
    msg.textContent = `${pasted.i.length} samples, ${pasted.ni} x ${pasted.nj} cells.`;
  } catch (e) { msg.textContent = e.message; return; }
  results.delete("paste");
  state.ex = "paste"; state.pick = 0;
  sync();
});
$("paste-example").addEventListener("click", () => {
  const ex = R.exampleByKey("nsidc"), s = R.sampleExample(ex, 12);
  $("paste").value = `# i j lon lat: ${ex.label}\n` + s.i.map((i, k) => `${i} ${s.j[k]} ${s.lon[k]} ${s.lat[k]}`).join("\n");
  $("ncol").value = "";
});

function updatePanel() {
  const st = STEPS[state.s];
  ui.title.textContent = `${state.s + 1}. ${st.title}`;
  ui.caption.textContent = st.caption();
  ui.count.textContent = `${state.s + 1} of ${STEPS.length}`;
  [...ui.steps.children].forEach((li, k) => li.classList.toggle("active", k === state.s));
  ui.sats.hidden = !st.sats;
  for (const b of ui.sats.children) b.classList.toggle("active", b.dataset.key === state.sat);
  ui.examples.hidden = !st.examples;
  for (const b of ui.examples.children) b.classList.toggle("active", b.dataset.key === state.ex);
  ui.paramBox.hidden = !st.param;
  if (st.param) {
    ui.paramLabel.textContent = st.param.label;
    ui.param.value = st.param.to(state[st.param.key]);
    ui.paramOut.textContent = st.param.fmt(state[st.param.key]);
  }
  ui.play.hidden = !st.play;
  if (!anim) ui.play.textContent = st.play && state[st.play] >= 1 ? "Rewind" : "Play";
  ui.pasteBox.hidden = !st.paste;
  ui.resultBox.hidden = !st.results || !results.has(state.ex);
  if (st.results) showResults();
  $("prev").disabled = state.s === 0;
  $("next").disabled = state.s === STEPS.length - 1;
}

let rafPending = false;
function sync() {
  writeHash();
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const st = STEPS[state.s];
    const three = st.mode === "3d";
    renderer.domElement.style.display = three ? "" : "none";
    view.style.display = three ? "none" : "";
    if (st.results && (state.ex !== "paste" || pasted)) runTest();
    if (three) update3D();
    else draw2D();
    updatePanel();
  });
}

function draw2D() {
  size2d();
  ctx2.fillStyle = "#05070d"; ctx2.fillRect(0, 0, W2, H2);
  const st = STEPS[state.s];
  if (st.key === "arrays") drawArrays(R.exampleByKey(state.ex));
  else if (st.key === "morph") drawMorph(R.exampleByKey(state.ex));
  else {
    const entry = results.get(state.ex);
    if (!entry) { label(st.paste ? "Paste lon/lat samples and press Test." : "", W2 / 2, H2 / 2, C.muted); return; }
    drawResiduals(entry.samples, entry.list[Math.min(state.pick, entry.list.length - 1)]);
  }
}

// ---------------------------------------------------------------- play, share, loop

let anim = false, dir = 1, lastT = 0;
function stopAnim() { anim = false; }
ui.play.addEventListener("click", () => {
  const k = STEPS[state.s].play;
  if (anim) { stopAnim(); sync(); return; }
  anim = true; dir = state[k] >= 1 ? -1 : 1; ui.play.textContent = "Stop"; lastT = performance.now();
});

function copy(text, btn) {
  const done = () => { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1200); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {});
}
const pageUrl = () => location.origin + location.pathname;
$("copy-proj").addEventListener("click", (e) => copy(ui.proj.textContent, e.target));
$("copy-link").addEventListener("click", (e) => copy(pageUrl() + location.hash, e.target));
$("copy-embed").addEventListener("click", (e) => copy(
  `<iframe src="${pageUrl()}?embed=1${location.hash}" width="100%" height="480" style="border:0" loading="lazy" title="Regular in what?"></iframe>`,
  e.target));
$("open-full").href = pageUrl() + location.hash;

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (STEPS[state.s].mode === "2d") sync();
}
new ResizeObserver(resize).observe(stage);

function tick(now) {
  if (anim) {
    const k = STEPS[state.s].play, dt = Math.min(0.1, (now - lastT) / 1000);
    state[k] = Math.max(0, Math.min(1, state[k] + dir * dt * 0.35));
    if (state[k] === 1 || state[k] === 0) stopAnim();
    sync();
  }
  lastT = now;
  if (STEPS[state.s].mode === "3d") { controls.update(); renderer.render(scene, camera); }
  requestAnimationFrame(tick);
}

window.addEventListener("hashchange", () => { readHash(); resetCamera(); sync(); });

if (embed) {
  document.body.classList.add("embed");
  $("open-full").hidden = false;
}

let coastLines = null;
readHash();
resetCamera();
resize();
drawEarth(null);
sync();
loadCoastline("110m").then((lines) => {
  coastLines = lines;
  drawEarth(lines);
  discData = null;
  coastIdx.clear();
  sync();
  document.body.classList.add("ready");
});
requestAnimationFrame(tick);
