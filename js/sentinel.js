// playproj: MGRS and Sentinel-2.
//
// The globe carries the MGRS grid zones. One zone at a time is lifted off
// it as a strip, drawn in its own UTM coordinates (a canvas texture over a
// mesh of the zone), together with the Sentinel-2 tiles of that zone and,
// optionally, of the zones either side. Unroll moves everything from the
// globe onto the zone's transverse cylinder (0 to 0.5), then opens the
// cylinder flat by letting its radius grow (0.5 to 1), keeping the line
// where it touches the equator fixed.
//
// The UPS modes do the same for a polar cap: the cap slides down the rays
// from a light at the other pole onto the polar stereographic plane.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as g from "../src/core/mgrs.js";
import { loadCoastline } from "./data.js";
import { warpCanvas } from "./basemap-load.js";
import { basemapControl, exportControl } from "./basemap-ui.js";

const DEG = "\u00b0";
const D2R = Math.PI / 180;
const A = g.A, K0 = g.K0;

const COLORS = {
  bg: 0x05070d,
  own: 0x5fd3c6,
  nb: 0xb48cff,
  pick: 0xffd34d,
  cyl: 0x8cc4ff,
  cut: 0xffb347
};

// ---------------------------------------------------------------- state

const defaults = { mode: "utm", zone: 32, t: 0, pt: "5.3221,60.3913", tile: "", s2: 1, nb: 1, sq: 1, coast: 1, cyl: 1, bm: "none", cam: null };
const state = { ...defaults };
const embed = new URLSearchParams(location.search).has("embed");

const parsePt = (s) => {
  const p = String(s).split(",").map(Number);
  return p.length === 2 && p.every(isFinite) && Math.abs(p[1]) <= 90 ? [((p[0] + 540) % 360) - 180, p[1]] : null;
};

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  Object.assign(state, defaults);
  for (const k of Object.keys(defaults)) {
    if (!h.has(k)) continue;
    const raw = h.get(k);
    if (k === "mode") state.mode = ["utm", "upsn", "upss"].includes(raw) ? raw : "utm";
    else if (k === "bm") state.bm = raw;
    else if (k === "pt") state.pt = raw === "" || parsePt(raw) ? raw : defaults.pt;
    else if (k === "tile") state.tile = g.tileByName(raw) ? raw.toUpperCase().replace(/^T/, "") : "";
    else if (k === "cam") {
      const c = raw.split(",").map(Number);
      if (c.length === 6 && c.every(isFinite)) state.cam = c;
    } else if (isFinite(+raw)) state[k] = +raw;
  }
  state.zone = Math.max(1, Math.min(60, Math.round(state.zone)));
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

// ---------------------------------------------------------------- geometry helpers

// lon/lat to the scene: north is +y, lon 0 towards +z, lon 90 E towards +x
function sph(lon, lat, out = [0, 0, 0], i = 0) {
  const cl = Math.cos(lat * D2R);
  out[i] = cl * Math.sin(lon * D2R); out[i + 1] = Math.sin(lat * D2R); out[i + 2] = cl * Math.cos(lon * D2R);
  return out;
}

// the zone's cylinder frame: C to where the central meridian meets the
// equator, E along the cylinder's axis (east there), N north
function zoneFrame(zone) {
  const cm = g.centralMeridian(zone) * D2R;
  return { C: [Math.sin(cm), 0, Math.cos(cm)], E: [Math.cos(cm), 0, -Math.sin(cm)], N: [0, 1, 0] };
}

const ease = (x) => x * x * (3 - 2 * x);

// Position at unroll t of a point that is P on the globe and (X, Y) on the
// map (transverse Mercator metres / A), lifted off the surface by `lift`.
function placer(t, F, force = false) {
  const a1 = force ? 1 : ease(Math.min(1, 2 * t)), b = ease(Math.max(0, 2 * t - 1));
  const r = K0 / Math.max(1e-6, 1 - b);
  return (P, j, X, Y, lift, out, i) => {
    const ang = Y / r, ca = Math.cos(ang), sa = Math.sin(ang);
    const c = K0 - r + (r + lift) * ca, n = (r + lift) * sa;
    const s = 1 + lift;
    for (let k = 0; k < 3; k++) {
      const q = X * F.E[k] + c * F.C[k] + n * F.N[k];
      out[i + k] = P ? P[j + k] * s * (1 - a1) + q * a1 : q;
    }
  };
}

// A set of vertices that live on the globe and on the map at once.
class Morph {
  constructor() { this.P = []; this.XY = []; }
  add(lon, lat, X, Y) {
    const o = sph(lon, lat);
    this.P.push(o[0], o[1], o[2]); this.XY.push(X, Y);
  }
  finish() { this.P = new Float32Array(this.P); this.XY = new Float32Array(this.XY); this.pos = new Float32Array(this.P.length); }
  update(place, lift) {
    const n = this.XY.length / 2;
    for (let v = 0; v < n; v++) place(this.P, 3 * v, this.XY[2 * v], this.XY[2 * v + 1], lift, this.pos, 3 * v);
  }
}

// transverse Mercator in the current zone, in globe radii
const tmXY = (lon, lat, zone) => {
  const [x, y] = g.tmerc(lon, lat, g.centralMeridian(zone));
  return [x / A, y / A];
};

// ---------------------------------------------------------------- scene

const stage = document.getElementById("three");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(COLORS.bg);
stage.appendChild(renderer.domElement);
const maxTex = Math.min(8192, renderer.capabilities.maxTextureSize);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

function setCamera(c) {
  camera.position.set(c[0], c[1], c[2]);
  controls.target.set(c[3], c[4], c[5]);
  controls.update();
}
// The view for the current stage, followed until the camera is moved: the
// zone on the globe, turning to look along the cylinder and then at the
// flat strip from in front as it unrolls.
function defaultCam() {
  if (state.mode !== "utm") {
    // from the side, so the light and the rays show, then down onto the plane
    const sg = state.mode === "upsn" ? 1 : -1, u = ease(state.t);
    const d = sph(25, sg * (30 + 45 * u)), dist = 3.3 - 1.9 * u;
    const T = [0, sg * (0.35 + (UPS_H - 0.35) * u), 0];
    return [...d.map((v, k) => T[k] + v * dist), ...T];
  }
  const F = zoneFrame(state.zone), pt = parsePt(state.pt);
  const inZone = pt && g.zoneOf(pt[0], pt[1]) === state.zone && pt[1] >= -80 && pt[1] < 84;
  const lat = inZone ? Math.max(-50, Math.min(50, pt[1] * 0.7)) : 25;
  const d0 = sph(g.centralMeridian(state.zone) + 20, lat);
  const d1 = [0, 1, 2].map((k) => F.C[k] + 0.6 * F.E[k] + 0.12 * F.N[k]);
  const d2 = [0, 1, 2].map((k) => F.C[k] + 0.35 * F.E[k] - 0.1 * F.N[k]);
  const u = ease(Math.min(1, state.t / 0.5)), w = ease(Math.max(0, 2 * state.t - 1));
  const d = [0, 1, 2].map((k) => d0[k] * (1 - u) + d1[k] * u * (1 - w) + d2[k] * w), m = Math.hypot(...d);
  // the target moves out to the cylinder, then to the point on the flat map
  const flat = [0, 0, 0];
  if (inZone) placer(1, F)(null, 0, ...tmXY(pt[0], pt[1], state.zone), 0, flat, 0);
  else for (let k = 0; k < 3; k++) flat[k] = F.C[k];
  const T = [0, 1, 2].map((k) => F.C[k] * 0.25 * u * (1 - w) + flat[k] * w);
  const dist = 3.6 + 1.5 * u - 3.4 * w;
  return [...d.map((v, k) => T[k] + (v / m) * dist), ...T];
}

controls.addEventListener("end", () => {
  const p = camera.position, t = controls.target;
  state.cam = [p.x, p.y, p.z, t.x, t.y, t.z];
  writeHash();
});

// ------------------------------------------------ the globe: grid zones

const globeCanvas = document.createElement("canvas");
globeCanvas.width = Math.min(4096, maxTex); globeCanvas.height = globeCanvas.width / 2;
const globeTex = new THREE.CanvasTexture(globeCanvas);
globeTex.colorSpace = THREE.SRGBColorSpace;
globeTex.anisotropy = 4;

function drawGlobe(coast) {
  const W = globeCanvas.width, H = globeCanvas.height, ctx = globeCanvas.getContext("2d");
  const px = (lon) => ((lon + 180) / 360) * W, py = (lat) => ((90 - lat) / 180) * H;
  ctx.fillStyle = "#222a36"; ctx.fillRect(0, 0, W, H);
  // the basemap is plate carree, like the globe's texture
  const world = basemap.world;
  if (world) ctx.drawImage(world.canvas, 0, 0, W, H);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let z = 1; z <= 60; z++)
    for (let bi = 0; bi < 20; bi++) {
      const band = g.BANDS[bi], lr = g.gridZoneLon(z, band);
      if (!lr) continue;
      const [la0, la1] = g.bandRange(band);
      ctx.fillStyle = (z + bi) % 2 ? "#14233a" : "#1a2d49";
      ctx.globalAlpha = world ? 0.3 : 1;
      ctx.fillRect(px(lr[0]), py(la1), px(lr[1]) - px(lr[0]), py(la0) - py(la1));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#3d5377"; ctx.lineWidth = 1.5;
      ctx.strokeRect(px(lr[0]), py(la1), px(lr[1]) - px(lr[0]), py(la0) - py(la1));
      const w = px(lr[1]) - px(lr[0]);
      ctx.font = `${Math.round(Math.min(w * 0.3, W / 200))}px system-ui, sans-serif`;
      ctx.fillStyle = "rgba(215,228,245,0.55)";
      ctx.fillText(String(z).padStart(2, "0") + band, px((lr[0] + lr[1]) / 2), py((la0 + la1) / 2));
    }
  if (coast && state.coast) {
    ctx.strokeStyle = "rgba(215,236,255,0.8)"; ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (const l of coast)
      for (let i = 0; i < l.length; i += 2) {
        if (i && Math.abs(l[i] - l[i - 2]) > 180) ctx.moveTo(px(l[i]), py(l[i + 1]));
        else if (i) ctx.lineTo(px(l[i]), py(l[i + 1]));
        else ctx.moveTo(px(l[i]), py(l[i + 1]));
      }
    ctx.stroke();
  }
  globeTex.needsUpdate = true;
}

const globeGeom = (() => {
  const nx = 256, ny = 128, pos = [], uv = [], idx = [];
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      const lon = -180 + (360 * i) / nx, lat = 90 - (180 * j) / ny;
      pos.push(...sph(lon, lat)); uv.push(i / nx, 1 - j / ny);
    }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + nx + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
})();
const globe = new THREE.Mesh(globeGeom, new THREE.MeshBasicMaterial({ map: globeTex }));
scene.add(globe);
// a faded globe is drawn first and leaves no depth, so the maps that have
// left its surface (some of them inside it, under a secant surface) show
function setGlobeFade(f) {
  const m = globe.material, on = f > 0.001;
  if (m.transparent !== on) { m.transparent = on; m.depthWrite = !on; m.needsUpdate = true; }
  m.opacity = 1 - f;
  globe.renderOrder = on ? -1 : 0;
}

// ------------------------------------------------ the zone strip

const stripCanvas = document.createElement("canvas");
stripCanvas.width = 512; stripCanvas.height = maxTex;
const stripTex = new THREE.CanvasTexture(stripCanvas);
stripTex.colorSpace = THREE.SRGBColorSpace;
stripTex.anisotropy = 8;

// the strip's texture frame in UTM: easting, and northing signed (south
// of the equator without the false northing)
const FRAME = { e0: 80e3, e1: 920e3, y0: -9.0e6, y1: 9.42e6 };
const fu = (e) => (e - FRAME.e0) / (FRAME.e1 - FRAME.e0);
const fv = (y) => (y - FRAME.y0) / (FRAME.y1 - FRAME.y0);

const strip = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ map: stripTex, side: THREE.DoubleSide }));
scene.add(strip);
let stripMorph = null;

function buildStrip(zone) {
  const m = new Morph(), uv = [], idx = [];
  const F = 12;
  for (const band of g.BANDS) {
    const lr = g.gridZoneLon(zone, band);
    if (!lr) continue;
    const [la0, la1] = g.bandRange(band), nv = band === "X" ? 18 : 12, base = m.XY.length / 2;
    for (let j = 0; j <= nv; j++)
      for (let i = 0; i <= F; i++) {
        const lon = lr[0] + ((lr[1] - lr[0]) * i) / F, lat = la0 + ((la1 - la0) * j) / nv;
        const [X, Y] = tmXY(lon, lat, zone);
        m.add(lon, lat, X, Y);
        uv.push(fu(X * A + 500000), fv(Y * A));
      }
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < F; i++) {
        const a = base + j * (F + 1) + i, b = a + F + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
  }
  m.finish();
  stripMorph = m;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(m.pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  strip.geometry.dispose();
  strip.geometry = geo;
}

let coast50 = null, stripBm = null, capBm = null;
function drawStrip(zone) {
  const W = stripCanvas.width, H = stripCanvas.height, ctx = stripCanvas.getContext("2d");
  const cx = (e) => fu(e) * W, cy = (y) => (1 - fv(y)) * H;
  const cm = g.centralMeridian(zone);
  ctx.fillStyle = "#1d3253"; ctx.fillRect(0, 0, W, H);
  // the basemap in the zone's transverse Mercator
  const world = basemap.world;
  if (world) {
    if (!stripBm || stripBm.zone !== zone) {
      const c = warpCanvas(world, 128, 1024, (u, v) => g.tmercInverse(FRAME.e0 + u * (FRAME.e1 - FRAME.e0) - 500000, FRAME.y0 + v * (FRAME.y1 - FRAME.y0), cm));
      stripBm = { zone, c };
    }
    ctx.drawImage(stripBm.c, 0, 0, W, H);
    ctx.globalAlpha = 0.3;
  }

  // bands, alternately shaded, with their grid zone names
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let bi = 0; bi < 20; bi++) {
    const band = g.BANDS[bi], lr = g.gridZoneLon(zone, band);
    if (!lr) continue;
    const [la0, la1] = g.bandRange(band);
    const [, y0] = g.tmerc(cm, la0, cm), [, y1] = g.tmerc(cm, la1, cm);
    ctx.fillStyle = bi % 2 ? "#1d3253" : "#243d63";
    ctx.fillRect(0, cy(y1), W, cy(y0) - cy(y1));
  }
  ctx.globalAlpha = 1;

  if (state.sq) {
    ctx.strokeStyle = "rgba(200,220,245,0.45)"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let e = 0; e <= 1e6; e += 1e5) { ctx.moveTo(cx(e), 0); ctx.lineTo(cx(e), H); }
    for (let y = -9e6; y <= 9.4e6; y += 1e5) { ctx.moveTo(0, cy(y)); ctx.lineTo(W, cy(y)); }
    ctx.stroke();
    const ch = (cy(0) - cy(1e5));
    ctx.font = `${Math.round(Math.min(ch * 0.5, 20))}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = "rgba(225,235,250,0.7)";
    for (let y = -9e6; y < 9.4e6; y += 1e5) {
      const row = Math.round((y < 0 ? y + 1e7 : y) / 1e5);
      for (let col = 1; col <= 8; col++) ctx.fillText(g.squareLetters(zone, col, row), cx(col * 1e5 + 5e4), cy(y + 5e4));
    }
  }

  // the central meridian, and the two lines where the cylinder cuts the
  // ellipsoid (scale exactly 1)
  ctx.lineWidth = 3;
  ctx.setLineDash([18, 12]);
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.beginPath(); ctx.moveTo(cx(5e5), 0); ctx.lineTo(cx(5e5), H); ctx.stroke();
  ctx.strokeStyle = "rgba(255,179,71,0.85)";
  ctx.beginPath();
  for (const sgn of [-1, 1]) {
    // scale is 1 where k0 cosh(eta) / ... ~ 1: found numerically along the parallels
    let first = true;
    for (let lat = -80; lat <= 84; lat += 1) {
      const x = trueScaleX(lat, cm) * sgn;
      const [, y] = g.tmerc(cm, lat, cm);
      if (first) ctx.moveTo(cx(5e5 + x), cy(y)); else ctx.lineTo(cx(5e5 + x), cy(y));
      first = false;
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // band boundaries and names
  ctx.strokeStyle = "rgba(240,246,255,0.9)"; ctx.lineWidth = 3;
  for (let bi = 0; bi < 20; bi++) {
    const band = g.BANDS[bi], lr = g.gridZoneLon(zone, band);
    if (!lr) continue;
    const [la0, la1] = g.bandRange(band);
    ctx.beginPath();
    for (let k = 0; k <= 24; k++) {
      const lon = lr[0] + ((lr[1] - lr[0]) * k) / 24, [x, y] = g.tmerc(lon, la0, cm);
      if (k) ctx.lineTo(cx(x + 5e5), cy(y)); else ctx.moveTo(cx(x + 5e5), cy(y));
    }
    ctx.stroke();
    const [x, y] = g.tmerc((lr[0] + lr[1]) / 2, (la0 + la1) / 2, cm);
    ctx.font = `bold ${Math.round(H / 140)}px system-ui, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.fillText(String(zone).padStart(2, "0") + band, cx(x + 5e5), cy(y));
  }

  const lines = coast50 || coastLines;
  if (state.coast && lines) {
    ctx.strokeStyle = "rgba(225,240,255,0.95)"; ctx.lineWidth = 2;
    ctx.beginPath();
    for (const l of lines) {
      let pen = false;
      for (let i = 0; i < l.length; i += 2) {
        const dl = Math.abs(((l[i] - cm + 540) % 360) - 180);
        if (dl > 14 || l[i + 1] < -81 || l[i + 1] > 85) { pen = false; continue; }
        const [x, y] = g.tmerc(l[i], l[i + 1], cm);
        if (pen) ctx.lineTo(cx(x + 5e5), cy(y)); else ctx.moveTo(cx(x + 5e5), cy(y));
        pen = true;
      }
    }
    ctx.stroke();
  }
  stripTex.needsUpdate = true;
}

// easting offset (m) where the scale factor is exactly 1 at a latitude
const trueScaleCache = new Map();
function trueScaleX(lat) {
  if (trueScaleCache.has(lat)) return trueScaleCache.get(lat);
  const scale = (dl) => {
    const h = 1e-4, [x0] = g.tmerc(dl - h, lat, 0), [x1] = g.tmerc(dl + h, lat, 0);
    // ellipsoid parallel radius per degree
    const e2 = g.F * (2 - g.F), s = Math.sin(lat * D2R);
    const nu = A / Math.sqrt(1 - e2 * s * s);
    const ds = nu * Math.cos(lat * D2R) * 2 * h * D2R;
    return Math.hypot(x1 - x0, g.tmerc(dl + h, lat, 0)[1] - g.tmerc(dl - h, lat, 0)[1]) / ds;
  };
  let lo = 0, hi = 30;
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (scale(mid) < 1) lo = mid; else hi = mid; }
  const x = g.tmerc(lo, lat, 0)[0];
  trueScaleCache.set(lat, x);
  return x;
}

// ------------------------------------------------ Sentinel-2 tiles

let grid = null;

const tileGroup = new THREE.Group();
scene.add(tileGroup);
const fillMat = (color, opacity) => new THREE.MeshBasicMaterial({
  color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending
});
const lineMat = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });

// tiles as a translucent fill (overlaps add up) and an outline, all in the
// current zone's transverse Mercator. Each tile is an n x n grid; its
// outline runs round the grid's edge.
function tileMeshes(tiles, zone, color, fillOpacity, lineOpacity, n = 4, proj = null) {
  const fm = new Morph(), lm = new Morph(), fidx = [];
  const ring = [];
  for (let i = 0; i < n; i++) ring.push([i, 0]);
  for (let j = 0; j < n; j++) ring.push([n, j]);
  for (let i = n; i > 0; i--) ring.push([i, n]);
  for (let j = n; j > 0; j--) ring.push([0, j]);
  const ll = new Float64Array(2 * (n + 1) * (n + 1)), xy = new Float64Array(ll.length);
  for (const t of tiles) {
    const base = fm.XY.length / 2, fn = t.south ? 1e7 : 0;
    for (let j = 0, k = 0; j <= n; j++)
      for (let i = 0; i <= n; i++, k += 2) {
        const e = t.xmin + ((t.xmax - t.xmin) * i) / n, nn = t.ymin + ((t.ymax - t.ymin) * j) / n;
        const [lon, lat] = g.fromUTM(t.zone, t.south, e, nn);
        // in its own zone the map coordinates are the tile's own
        const [X, Y] = proj ? proj(lon, lat) : t.zone === zone ? [(e - 5e5) / A, (nn - fn) / A] : tmXY(lon, lat, zone);
        ll[k] = lon; ll[k + 1] = lat; xy[k] = X; xy[k + 1] = Y;
        fm.add(lon, lat, X, Y);
      }
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = base + j * (n + 1) + i, b = a + n + 1;
        fidx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    for (let r = 0; r < ring.length; r++)
      for (const [i, j] of [ring[r], ring[(r + 1) % ring.length]]) {
        const k = 2 * (j * (n + 1) + i);
        lm.add(ll[k], ll[k + 1], xy[k], xy[k + 1]);
      }
  }
  fm.finish(); lm.finish();
  const fg = new THREE.BufferGeometry();
  fg.setAttribute("position", new THREE.BufferAttribute(fm.pos, 3));
  fg.setIndex(fidx);
  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", new THREE.BufferAttribute(lm.pos, 3));
  const fill = new THREE.Mesh(fg, fillMat(color, fillOpacity));
  const line = new THREE.LineSegments(lg, lineMat(color, lineOpacity));
  fill.renderOrder = 2; line.renderOrder = 3;
  return { fill, line, fm, lm };
}

let tileSets = [];   // [{fill, line, fm, lm, lift}]
let pickSet = null;

function clearSet(s) {
  tileGroup.remove(s.fill, s.line);
  s.fill.geometry.dispose(); s.line.geometry.dispose();
}

function buildTiles(zone) {
  for (const s of tileSets) clearSet(s);
  tileSets = [];
  if (!grid) return;
  const own = tileMeshes(grid.inZone(zone), zone, COLORS.own, 0.07, 0.75);
  own.lift = 0.0016; own.kind = "own";
  const nbTiles = [...grid.inZone(((zone + 58) % 60) + 1), ...grid.inZone((zone % 60) + 1)];
  const nb = tileMeshes(nbTiles, zone, COLORS.nb, 0.06, 0.4);
  nb.lift = 0.0013; nb.kind = "nb";
  tileSets = [own, nb];
  for (const s of tileSets) tileGroup.add(s.fill, s.line);
}

function buildPick(zone) {
  if (pickSet) { clearSet(pickSet); pickSet = null; }
  const t = state.tile && g.tileByName(state.tile);
  if (!t) return;
  const north = state.mode === "upsn";
  pickSet = tileMeshes([t], zone, COLORS.pick, 0.3, 1, 16, state.mode === "utm" ? null : (lon, lat) => upsXY(lon, lat, north));
  pickSet.lift = 0.0022;
  tileGroup.add(pickSet.fill, pickSet.line);
}

// ------------------------------------------------ the point

const marker = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: COLORS.pick }));
marker.renderOrder = 5;
scene.add(marker);

// ------------------------------------------------ the cylinder

const cylGroup = new THREE.Group();
scene.add(cylGroup);
const CYL = { nx: 8, ny: 96, half: 0.7 };
const cylMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
  color: COLORS.cyl, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false
}));
const cylLines = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat(COLORS.cyl, 0.35));
const cutLines = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat(COLORS.cut, 0.9));
cylGroup.add(cylMesh, cylLines, cutLines);
{
  const idx = [];
  for (let j = 0; j < CYL.ny; j++)
    for (let i = 0; i < CYL.nx; i++) {
      const a = j * (CYL.nx + 1) + i, b = a + CYL.nx + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  cylMesh.geometry.setIndex(idx);
  cylMesh.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array((CYL.nx + 1) * (CYL.ny + 1) * 3), 3));
}

function updateCylinder(F, t) {
  const b = ease(Math.max(0, 2 * t - 1));
  const L = Math.PI * K0 * (1 - b) + 1.55 * b;
  const place = placer(t, F, true);
  const pos = cylMesh.geometry.attributes.position;
  for (let j = 0, k = 0; j <= CYL.ny; j++)
    for (let i = 0; i <= CYL.nx; i++, k++)
      place(null, 0, -CYL.half + (2 * CYL.half * i) / CYL.nx, -L + (2 * L * j) / CYL.ny, 0, pos.array, 3 * k);
  pos.needsUpdate = true;
  cylMesh.geometry.computeBoundingSphere();
  // rings at the ends and generators along it
  const seg = [], v = [0, 0, 0], w = [0, 0, 0];
  const line = (x0, y0, x1, y1, n, arr) => {
    for (let s = 0; s < n; s++) {
      place(null, 0, x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n, 0, v, 0);
      place(null, 0, x0 + ((x1 - x0) * (s + 1)) / n, y0 + ((y1 - y0) * (s + 1)) / n, 0, w, 0);
      arr.push(...v, ...w);
    }
  };
  for (const x of [-CYL.half, CYL.half]) line(x, -L, x, L, 96, seg);
  for (let k = 0; k < 12; k++) { const y = -L + (2 * L * k) / 12; line(-CYL.half, y, CYL.half, y, 1, seg); }
  setLines(cylLines, seg);
  // where the cylinder cuts the globe: x = +-sqrt(1 - k0^2)
  const cut = [], xc = Math.sqrt(1 - K0 * K0);
  for (const x of [-xc, xc]) line(x, -L, x, L, 128, cut);
  setLines(cutLines, cut);
}

function setLines(obj, arr) {
  obj.geometry.dispose();
  obj.geometry = new THREE.BufferGeometry();
  obj.geometry.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
}

// ------------------------------------------------ UPS: the polar caps

// The plane sits where a light at the far pole casts the cap at scale
// 0.994: a tangent plane would be at height 1 (scale 1 at the pole), and
// lowering it to 2 k0 - 1 shrinks the picture by k0.
const UPS_H = 2 * g.UPS_K0 - 1;
const UPS_HALF = 1.2e6;   // the cap texture frame, metres either side of the pole
const capCanvas = document.createElement("canvas");
capCanvas.width = capCanvas.height = Math.min(2048, maxTex);
const capTex = new THREE.CanvasTexture(capCanvas);
capTex.colorSpace = THREE.SRGBColorSpace;
capTex.anisotropy = 8;

const upsGroup = new THREE.Group();
scene.add(upsGroup);
const cap = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ map: capTex, side: THREE.DoubleSide }));
const lightBall = new THREE.Mesh(new THREE.SphereGeometry(0.03, 20, 14), new THREE.MeshBasicMaterial({ color: COLORS.pick }));
const rays = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat(COLORS.pick, 0.35));
const planeMesh = new THREE.Mesh(new THREE.PlaneGeometry(2 * UPS_HALF / A, 2 * UPS_HALF / A), new THREE.MeshBasicMaterial({
  color: COLORS.cyl, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false
}));
const planeEdge = new THREE.LineSegments(new THREE.EdgesGeometry(planeMesh.geometry), lineMat(COLORS.cyl, 0.45));
const cutCircle = new THREE.LineLoop(new THREE.BufferGeometry(), lineMat(COLORS.cut, 0.9));
const surfaceGroup = new THREE.Group();
surfaceGroup.add(planeMesh, planeEdge, cutCircle);
upsGroup.add(cap, lightBall, rays, surfaceGroup);
let capMorph = null, upsTiles = null, builtUps = "";

// UPS easting / northing (globe radii from the pole) to the scene plane:
// easting towards 90 E, northing towards 180 in the north and towards 0 in
// the south (the y axis points along the meridian 180 or 0)
function upsPlacer(t, north, force = false) {
  const u = force ? 1 : ease(t), sg = north ? 1 : -1;
  return (P, j, X, Y, lift, out, i) => {
    const q0 = X, q1 = sg * (UPS_H + lift), q2 = north ? -Y : Y;
    const s = 1 + lift;
    out[i] = P ? P[j] * s * (1 - u) + q0 * u : q0;
    out[i + 1] = P ? P[j + 1] * s * (1 - u) + q1 * u : q1;
    out[i + 2] = P ? P[j + 2] * s * (1 - u) + q2 * u : q2;
  };
}
const upsXY = (lon, lat, north) => {
  const u = g.toUPS(lon, lat, north);
  return [(u.e - g.UPS_FALSE) / A, (u.n - g.UPS_FALSE) / A];
};
const capEdge = (north) => (north ? 84 : -80);

function buildCap(north) {
  const m = new Morph(), uv = [], idx = [], nr = 24, ns = 120, edge = capEdge(north), pole = north ? 90 : -90;
  for (let j = 0; j <= nr; j++)
    for (let i = 0; i <= ns; i++) {
      const lat = edge + ((pole - edge) * j) / nr, lon = -180 + (360 * i) / ns;
      const u = g.toUPS(lon, lat, north);
      m.add(lon, lat, (u.e - g.UPS_FALSE) / A, (u.n - g.UPS_FALSE) / A);
      uv.push((u.e - g.UPS_FALSE + UPS_HALF) / (2 * UPS_HALF), (u.n - g.UPS_FALSE + UPS_HALF) / (2 * UPS_HALF));
    }
  for (let j = 0; j < nr; j++)
    for (let i = 0; i < ns; i++) {
      const a = j * (ns + 1) + i, b = a + ns + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  m.finish();
  capMorph = m;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(m.pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  cap.geometry.dispose();
  cap.geometry = geo;
}

function drawCap(north) {
  const W = capCanvas.width, ctx = capCanvas.getContext("2d");
  const cx = (e) => ((e - g.UPS_FALSE + UPS_HALF) / (2 * UPS_HALF)) * W;
  const cy = (n) => (1 - (n - g.UPS_FALSE + UPS_HALF) / (2 * UPS_HALF)) * W;
  const P = (lon, lat) => { const u = g.toUPS(lon, lat, north); return [cx(u.e), cy(u.n)]; };
  const west = north ? "Y" : "A", east = north ? "Z" : "B";
  const world = basemap.world;
  if (world) {
    if (!capBm || capBm.north !== north) {
      const at = (s) => g.UPS_FALSE - UPS_HALF + s * 2 * UPS_HALF;
      capBm = { north, c: warpCanvas(world, 512, 512, (u, v) => g.fromUPS(north, at(u), at(v))) };
    }
    ctx.drawImage(capBm.c, 0, 0, W, W);
    ctx.globalAlpha = 0.3;
  }
  ctx.fillStyle = "#1d3253"; ctx.fillRect(0, 0, W / 2, W);
  ctx.fillStyle = "#243d63"; ctx.fillRect(W / 2, 0, W / 2, W);
  ctx.globalAlpha = 1;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const cell = cx(1e5) - cx(0);
  if (state.sq) {
    ctx.strokeStyle = "rgba(200,220,245,0.45)"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let v = g.UPS_FALSE - 1.2e6; v <= g.UPS_FALSE + 1.2e6; v += 1e5) {
      ctx.moveTo(cx(v), 0); ctx.lineTo(cx(v), W); ctx.moveTo(0, cy(v)); ctx.lineTo(W, cy(v));
    }
    ctx.stroke();
    ctx.font = `${Math.round(cell * 0.32)}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = "rgba(225,235,250,0.75)";
    for (let e = g.UPS_FALSE - 1.2e6; e < g.UPS_FALSE + 1.2e6; e += 1e5)
      for (let n = g.UPS_FALSE - 1.2e6; n < g.UPS_FALSE + 1.2e6; n += 1e5) {
        const letter = e + 5e4 < g.UPS_FALSE ? west : east, sq = g.upsSquareLetters(letter, e + 5e4, n + 5e4);
        if (sq) ctx.fillText(sq, cx(e + 5e4), cy(n + 5e4));
      }
  }
  // parallels every 2 degrees and meridians every 30
  ctx.strokeStyle = "rgba(160,190,230,0.5)"; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let lat = capEdge(north); Math.abs(lat) < 90; lat += north ? 2 : -2)
    for (let lon = -180; lon <= 180; lon += 3) { const [x, y] = P(lon, lat); if (lon === -180) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  for (let lon = -180; lon < 180; lon += 30) { const [x0, y0] = P(lon, capEdge(north) + (north ? -1 : 1)), [x1, y1] = P(lon, north ? 90 : -90); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
  ctx.stroke();
  // Greenwich and 180, splitting the cap into its two grid zones
  ctx.strokeStyle = "rgba(240,246,255,0.95)"; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, W); ctx.stroke();
  ctx.font = `bold ${Math.round(W / 9)}px system-ui, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.fillText(west, W * 0.36, W / 2); ctx.fillText(east, W * 0.64, W / 2);
  // where the plane cuts the globe, near 81.1 degrees: scale exactly 1 there
  const cutLat = (north ? 1 : -1) * Math.asin(UPS_H) / D2R;
  ctx.strokeStyle = "rgba(255,179,71,0.9)"; ctx.lineWidth = 4; ctx.setLineDash([18, 12]);
  ctx.beginPath();
  for (let lon = -180; lon <= 180; lon += 2) { const [x, y] = P(lon, cutLat); if (lon === -180) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.stroke(); ctx.setLineDash([]);
  const lines = coast50 || coastLines;
  if (state.coast && lines) {
    ctx.strokeStyle = "rgba(225,240,255,0.95)"; ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (const l of lines) {
      let pen = false;
      for (let i = 0; i < l.length; i += 2) {
        if (north ? l[i + 1] < 78 : l[i + 1] > -74) { pen = false; continue; }
        const [x, y] = P(l[i], l[i + 1]);
        if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        pen = true;
      }
    }
    ctx.stroke();
  }
  capTex.needsUpdate = true;
}

// Sentinel-2 tiles reaching into or near the cap: UTM tiles, carried onto
// the polar plane. The grid has no UPS tiles.
const polarTileCache = {};
function polarTiles(north) {
  const key = north ? "n" : "s";
  if (polarTileCache[key]) return polarTileCache[key];
  const out = [];
  for (let z = 1; z <= 60; z++)
    for (const t of grid.inZone(z)) {
      if (t.south === north) continue;
      const [, lat] = g.fromUTM(t.zone, t.south, (t.xmin + t.xmax) / 2, north ? t.ymax : t.ymin);
      if (north ? lat > 82.5 : lat < -79.5) out.push(t);
    }
  return (polarTileCache[key] = out);
}

function buildUps(north) {
  buildCap(north);
  drawCap(north);
  if (upsTiles) clearSet(upsTiles);
  upsTiles = null;
  if (grid) {
    upsTiles = tileMeshes(polarTiles(north), 0, COLORS.own, 0.07, 0.6, 4, (lon, lat) => upsXY(lon, lat, north));
    upsTiles.lift = 0.0016;
    tileGroup.add(upsTiles.fill, upsTiles.line);
  }
  const ring = [], r = Math.sqrt(1 - UPS_H * UPS_H), sg = north ? 1 : -1;
  for (let k = 0; k < 128; k++) ring.push(r * Math.cos((2 * Math.PI * k) / 128), sg * UPS_H, r * Math.sin((2 * Math.PI * k) / 128));
  cutCircle.geometry.dispose();
  cutCircle.geometry = new THREE.BufferGeometry();
  cutCircle.geometry.setAttribute("position", new THREE.Float32BufferAttribute(ring, 3));
  planeMesh.position.set(0, sg * UPS_H, 0); planeMesh.rotation.set(-Math.PI / 2, 0, 0);
  planeEdge.position.copy(planeMesh.position); planeEdge.rotation.copy(planeMesh.rotation);
  lightBall.position.set(0, -sg, 0);
}

// rays from the light through the cap's edge (and the point) to the plane
function updateRays(north) {
  const onPlane = upsPlacer(1, north), seg = [], o = [0, 0, 0], L = [0, north ? -1 : 1, 0];
  const through = (lon, lat) => {
    onPlane(null, 0, ...upsXY(lon, lat, north), 0, o, 0);
    seg.push(...L, ...o);
  };
  for (let lon = -180; lon < 180; lon += 20) through(lon, capEdge(north));
  const pt = parsePt(state.pt);
  if (pt && (north ? pt[1] >= 84 : pt[1] < -80)) through(pt[0], pt[1]);
  setLines(rays, seg);
}

// ---------------------------------------------------------------- update

let builtZone = 0, builtTile = null, builtTiles = false, builtMode = "utm";

function rebuildUps(north) {
  if (builtUps !== state.mode || (grid && !upsTiles)) { buildUps(north); builtUps = state.mode; }
  if (builtMode !== state.mode) { builtMode = state.mode; builtTile = null; }
  if (builtTile !== state.tile) { buildPick(0); builtTile = state.tile; }
  const place = upsPlacer(state.t, north);
  capMorph.update(place, 0.0008);
  cap.geometry.attributes.position.needsUpdate = true;
  cap.geometry.computeBoundingSphere();
  for (const s of [upsTiles, pickSet]) {
    if (!s) continue;
    s.fm.update(place, s.lift); s.lm.update(place, s.lift);
    s.fill.geometry.attributes.position.needsUpdate = true;
    s.line.geometry.attributes.position.needsUpdate = true;
    s.fill.geometry.computeBoundingSphere(); s.line.geometry.computeBoundingSphere();
  }
  if (upsTiles) upsTiles.fill.visible = upsTiles.line.visible = !!state.s2;
  const pt = parsePt(state.pt);
  const inCap = pt && (north ? pt[1] >= 84 : pt[1] < -80);
  marker.visible = !!pt;
  if (pt) {
    const o = [0, 0, 0];
    if (inCap || (north ? pt[1] > 60 : pt[1] < -60)) place(sph(pt[0], pt[1]), 0, ...upsXY(pt[0], pt[1], north), 0.003, o, 0);
    else sph(pt[0], pt[1], o);
    marker.position.set(o[0], o[1], o[2]);
  }
  updateRays(north);
  surfaceGroup.visible = !!state.cyl;
  cylGroup.visible = false;
  if (!state.cam) setCamera(defaultCam());
  setGlobeFade(0.65 * ease(Math.min(1, 2 * state.t)));
}

function rebuildScene() {
  const isUps = state.mode !== "utm", north = state.mode === "upsn";
  strip.visible = !isUps; upsGroup.visible = isUps;
  for (const s of tileSets) s.fill.visible = s.line.visible = false;
  if (upsTiles) upsTiles.fill.visible = upsTiles.line.visible = false;
  if (isUps) return rebuildUps(north);
  const zone = state.zone, F = zoneFrame(zone);
  if (builtMode !== "utm") { builtMode = "utm"; builtTile = null; }
  if (builtZone !== zone) {
    buildStrip(zone);
    drawStrip(zone);
    builtZone = zone; builtTiles = false; builtTile = null;
  }
  if (!builtTiles && grid) { buildTiles(zone); builtTiles = true; }
  if (builtTile !== state.tile) { buildPick(zone); builtTile = state.tile; }

  const place = placer(state.t, F);
  stripMorph.update(place, 0.0008);
  strip.geometry.attributes.position.needsUpdate = true;
  strip.geometry.computeBoundingSphere();
  for (const s of [...tileSets, pickSet]) {
    if (!s) continue;
    s.fm.update(place, s.lift); s.lm.update(place, s.lift);
    s.fill.geometry.attributes.position.needsUpdate = true;
    s.line.geometry.attributes.position.needsUpdate = true;
    s.fill.geometry.computeBoundingSphere(); s.line.geometry.computeBoundingSphere();
  }
  if (tileSets.length) {
    tileSets[0].fill.visible = tileSets[0].line.visible = !!state.s2;
    tileSets[1].fill.visible = tileSets[1].line.visible = !!(state.s2 && state.nb);
  }

  const pt = parsePt(state.pt);
  marker.visible = !!pt;
  if (pt) {
    const P = sph(pt[0], pt[1]), [X, Y] = tmXY(pt[0], pt[1], zone), o = [0, 0, 0];
    place(P, 0, X, Y, 0.003, o, 0);
    marker.position.set(o[0], o[1], o[2]);
  }

  if (!state.cam) setCamera(defaultCam());
  cylGroup.visible = !!state.cyl;
  if (state.cyl) updateCylinder(F, state.t);
  // fade the globe as the strip leaves it
  setGlobeFade(0.6 * ease(Math.max(0, 2 * state.t - 1)));
}

// ---------------------------------------------------------------- panel

const $ = (id) => document.getElementById(id);
const ui = {
  zone: $("zone"), zoneOut: $("zone-out"), zoneRow: $("zone-row"), modes: [...document.querySelectorAll("#modes button")], t: $("t"), tOut: $("t-out"),
  lookup: $("lookup"), ptOut: $("pt-out"), info: $("pt-info"), chips: $("tile-chips"), tileInfo: $("tile-info"),
  geojson: $("copy-geojson"),
  s2: $("s2"), nb: $("nb"), sq: $("sq"), coast: $("coast"), cyl: $("cyl"),
  bm: $("basemap"), tif: $("download-tif")
};

// The picked tile as a GeoTIFF on its own grid: its UTM zone's EPSG code
// and its 109.8 km square, so 1098 pixels are 100 m ones on the tile's
// own 10 m grid.
const basemap = basemapControl({
  select: ui.bm, status: $("bm-status"), credit: $("credit"),
  onWorld: () => {
    stripBm = capBm = null;
    drawGlobe(coastLines); drawStrip(state.zone);
    if (state.mode !== "utm") drawCap(state.mode === "upsn");
    sync();
  }
});
const tifOut = exportControl({
  button: ui.tif, size: $("tif-size"), status: $("bm-status"), bm: () => basemap.id,
  job: () => {
    const t = state.tile && g.tileByName(state.tile);
    if (!t) return null;
    return {
      name: `playproj-T${t.name}`, crs: { epsg: t.epsg }, box: [t.xmin, t.ymin, t.xmax, t.ymax],
      forward: (lon, lat) => { const u = g.toUTM(lon, lat, t.zone, t.south); return [u.e, u.n]; },
      inverse: (e, n) => g.fromUTM(t.zone, t.south, e, n)
    };
  }
});

const fmtM = (v) => Math.round(v).toLocaleString("en") + " m";
const fmtLL = (lon, lat) => `${Math.abs(lat).toFixed(4)}${DEG} ${lat < 0 ? "S" : "N"}, ${Math.abs(lon).toFixed(4)}${DEG} ${lon < 0 ? "W" : "E"}`;
const fmtCM = (z) => { const c = g.centralMeridian(z); return `${Math.abs(c)}${DEG} ${c < 0 ? "W" : c > 0 ? "E" : ""}`.trim(); };

function exceptionNote(lon, lat, zone) {
  const plain = (Math.floor((((lon + 540) % 360) - 180 + 180) / 6) % 60) + 1;
  if (plain === zone) return "";
  if (lat >= 72) return ` The Svalbard exception puts it in zone ${zone}, not ${plain}: ${plain}X does not exist.`;
  return ` The Norway exception puts it in zone ${zone}, not ${plain}: 32V is widened west to 3${DEG} E.`;
}

function pointTiles() {
  const pt = parsePt(state.pt);
  return pt && grid ? g.tilesAt(pt[0], pt[1], grid.has) : [];
}

function updatePanel() {
  const isUps = state.mode !== "utm";
  for (const b of ui.modes) b.classList.toggle("active", b.dataset.mode === state.mode);
  ui.zoneRow.hidden = isUps; turnBtn.hidden = isUps;
  ui.zone.value = state.zone;
  ui.zoneOut.textContent = `${state.zone} (central meridian ${fmtCM(state.zone)})`;
  ui.t.value = state.t;
  ui.tOut.textContent = isUps ? (state.t === 0 ? "globe" : state.t === 1 ? "on the plane" : "down the rays") :
    state.t === 0 ? "globe" : state.t === 0.5 ? "cylinder" : state.t === 1 ? "flat" : state.t < 0.5 ? "to the cylinder" : "unrolling";
  for (const k of ["s2", "nb", "sq", "coast", "cyl"]) ui[k].checked = !!state[k];
  ui.lookup.classList.remove("bad");

  const pt = parsePt(state.pt);
  ui.chips.replaceChildren();
  ui.geojson.disabled = !pt;
  if (!tifOut.busy) ui.tif.disabled = !(state.tile && g.tileByName(state.tile)) || !basemap.world;
  if (!pt) {
    ui.ptOut.textContent = "";
    ui.info.textContent = "Click the globe or the zone, or paste a point, an MGRS reference or a tile name.";
    ui.tileInfo.textContent = "";
    return;
  }
  ui.ptOut.textContent = fmtLL(pt[0], pt[1]);
  if (document.activeElement !== ui.lookup) ui.lookup.value = `${+pt[0].toFixed(6)}, ${+pt[1].toFixed(6)}`;
  const mg = g.toMGRS(pt[0], pt[1]);
  if (mg && mg.ups) {
    const r = mg.ref;
    ui.info.textContent = `UPS ${mg.north ? "north" : "south"} (EPSG:${mg.epsg}): easting ${fmtM(mg.e)}, northing ${fmtM(mg.n)}. ` +
      `MGRS ${r.slice(0, 1)} ${r.slice(1, 3)} ${r.slice(3, 8)} ${r.slice(8)}, in grid zone ${mg.gzd}.`;
  } else if (mg) {
    const r = mg.ref;
    ui.info.textContent = `UTM zone ${mg.zone}${mg.south ? "S" : "N"} (EPSG:${g.epsg(mg.zone, mg.south)}): easting ${fmtM(mg.e)}, northing ${fmtM(mg.n)}. ` +
      `MGRS ${r.slice(0, 3)} ${r.slice(3, 5)} ${r.slice(5, 10)} ${r.slice(10)}.${exceptionNote(pt[0], pt[1], mg.zone)}`;
  }

  const tiles = pointTiles();
  for (const t of tiles) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "small" + (t.name === state.tile ? " active" : "");
    b.textContent = "T" + t.name;
    b.addEventListener("click", () => { state.tile = state.tile === t.name ? "" : t.name; sync(); });
    ui.chips.append(b);
  }
  const zones = new Set(tiles.map((t) => t.zone));
  let msg = !grid ? "Loading the Sentinel-2 grid." : !tiles.length ? (mg && mg.ups ? "No Sentinel-2 tile here: the grid has no UPS tiles." : "No Sentinel-2 tile here.") :
    `In ${tiles.length} Sentinel-2 tile${tiles.length > 1 ? "s" : ""}` + (zones.size > 1 ? `, from ${zones.size} zones, so ${zones.size} coordinate systems.` : ".");
  if (mg && !mg.ups && tiles.length && !zones.has(mg.zone))
    msg += ` None is from zone ${mg.zone}: ESA leaves out the squares at a zone's edge that lie mostly outside it, where the next zone's tiles already cover the ground.`;
  const sel = state.tile && g.tileByName(state.tile);
  if (sel) {
    msg += ` T${sel.name}: EPSG:${sel.epsg}, x ${sel.xmin} to ${sel.xmax}, y ${sel.ymin} to ${sel.ymax} (109.8 km, top left on a 60 m grid).`;
  }
  ui.tileInfo.textContent = msg;
}

let rafPending = false;
function sync() {
  writeHash();
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    rebuildScene();
    updatePanel();
  });
}

function setPoint(lon, lat, { zone = true, tile = true } = {}) {
  state.pt = `${+lon.toFixed(6)},${+lat.toFixed(6)}`;
  if (zone && lat >= -80 && lat < 84) { state.zone = g.zoneOf(lon, lat); state.mode = "utm"; }
  if (zone && (lat < -80 || lat >= 84)) state.mode = lat > 0 ? "upsn" : "upss";
  if (tile && grid) {
    // the point's own tile: its own zone's, the square it falls in
    const own = g.toMGRS(lon, lat, 0);
    const ts = g.tilesAt(lon, lat, grid.has);
    const best = own && ts.find((t) => t.zone === own.zone && t.name.slice(3) === own.square) || ts.find((t) => own && t.zone === own.zone) || ts[0];
    state.tile = best ? best.name : "";
  }
}

ui.zone.addEventListener("input", () => { state.zone = +ui.zone.value; sync(); });
for (const b of ui.modes) b.addEventListener("click", () => {
  if (state.mode === b.dataset.mode) return;
  state.mode = b.dataset.mode; state.cam = null; stopTurn();
  sync();
});
ui.t.addEventListener("input", () => { stopAnim(); state.t = +ui.t.value; sync(); });
for (const k of ["s2", "nb", "cyl"]) ui[k].addEventListener("change", () => { state[k] = ui[k].checked ? 1 : 0; sync(); });
for (const k of ["sq", "coast"]) ui[k].addEventListener("change", () => {
  state[k] = ui[k].checked ? 1 : 0;
  drawStrip(state.zone);
  if (state.mode !== "utm") drawCap(state.mode === "upsn");
  if (k === "coast") drawGlobe(coastLines);
  sync();
});

ui.lookup.addEventListener("change", () => {
  const raw = ui.lookup.value.trim();
  if (!raw) { state.pt = ""; state.tile = ""; return sync(); }
  const tm = /^T?(\d{1,2})([A-Z]{3})$/i.exec(raw.replace(/\s+/g, ""));
  const tile = tm && g.tileByName(tm[1].padStart(2, "0") + tm[2]);
  if (tile) {
    const [lon, lat] = g.fromUTM(tile.zone, tile.south, (tile.xmin + tile.xmax) / 2, (tile.ymin + tile.ymax) / 2);
    setPoint(lon, lat, { tile: false });
    state.zone = tile.zone; state.tile = tile.name; state.mode = "utm";
    return sync();
  }
  const ll = raw.split(/[\s,;]+/).filter(Boolean).map(Number);
  if (ll.length === 2 && ll.every(isFinite) && Math.abs(ll[1]) <= 90) { setPoint(ll[0], ll[1]); return sync(); }
  const m = g.parseMGRS(raw);
  if (m) {
    const [lon, lat] = m.ups ? g.fromUPS(m.north, m.e + m.size / 2, m.n + m.size / 2) : g.fromUTM(m.zone, m.south, m.e + m.size / 2, m.n + m.size / 2);
    setPoint(lon, lat);
    return sync();
  }
  ui.lookup.classList.add("bad");
});

ui.geojson.addEventListener("click", (e) => {
  const pt = parsePt(state.pt);
  if (!pt) return;
  const features = pointTiles().map((t) => ({
    type: "Feature",
    properties: { tile: t.name, epsg: t.epsg, xmin: t.xmin, ymin: t.ymin, xmax: t.xmax, ymax: t.ymax },
    geometry: { type: "Polygon", coordinates: [g.tileRing(t, 10).map(([x, y]) => [+x.toFixed(7), +y.toFixed(7)])] }
  }));
  const mg = g.toMGRS(pt[0], pt[1]);
  features.unshift({ type: "Feature", properties: { mgrs: mg ? mg.ref : null }, geometry: { type: "Point", coordinates: [+pt[0].toFixed(7), +pt[1].toFixed(7)] } });
  copy(JSON.stringify({ type: "FeatureCollection", features }), e.target);
});

$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(defaultCam()); writeHash(); });

// click (not drag): on the zone strip, read UTM straight off its texture
// coordinates; on the globe, take the point and move to its zone
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObjects(state.mode === "utm" ? [strip, globe] : [cap, globe])[0];
  if (!hit) return;
  if (hit.object === cap && state.t > 0) {
    const half = UPS_HALF, e = g.UPS_FALSE - half + hit.uv.x * 2 * half, n = g.UPS_FALSE - half + hit.uv.y * 2 * half;
    const [lon, lat] = g.fromUPS(state.mode === "upsn", e, n);
    setPoint(lon, lat, { zone: false });
  } else if (hit.object === strip && state.t > 0) {
    const ee = FRAME.e0 + hit.uv.x * (FRAME.e1 - FRAME.e0), y = FRAME.y0 + hit.uv.y * (FRAME.y1 - FRAME.y0);
    const [lon, lat] = g.tmercInverse(ee - 5e5, y, g.centralMeridian(state.zone));
    setPoint(lon, lat, { zone: false });
  } else {
    const p = hit.point.clone().normalize();
    // in a UPS mode, clicks keep the mode; in UTM mode a click in a cap switches to it
    setPoint(Math.atan2(p.x, p.z) / D2R, Math.asin(p.y) / D2R, { zone: state.mode === "utm" && hit.object !== strip });
  }
  sync();
});

// animations: unroll, and turning the cylinder round the globe
let anim = false, dir = 1, lastT = 0, turning = false, turnAcc = 0, turnLeft = 0;
const playBtn = $("play"), turnBtn = $("turn");
function stopAnim() { anim = false; playBtn.textContent = state.t >= 1 ? "Roll up" : "Unroll"; }
function stopTurn() { turning = false; turnBtn.textContent = "Turn the cylinder"; }
playBtn.addEventListener("click", () => {
  if (anim) return stopAnim();
  anim = true; dir = state.t >= 1 ? -1 : 1; playBtn.textContent = "Stop"; lastT = performance.now();
});
turnBtn.addEventListener("click", () => {
  if (turning) return stopTurn();
  turning = true; turnAcc = 0; turnLeft = 60; turnBtn.textContent = "Stop";
  // hold the camera still so the cylinder turns, not the globe
  if (!state.cam) { const p = camera.position, q = controls.target; state.cam = [p.x, p.y, p.z, q.x, q.y, q.z]; }
});

function copy(text, btn) {
  const done = () => { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1200); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {});
}
const pageUrl = () => location.origin + location.pathname;
$("copy-link").addEventListener("click", (e) => copy(pageUrl() + location.hash, e.target));
$("copy-embed").addEventListener("click", (e) => copy(
  `<iframe src="${pageUrl()}?embed=1${location.hash}" width="100%" height="480" style="border:0" loading="lazy" title="MGRS and Sentinel-2"></iframe>`,
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
  const dt = Math.min(0.1, (now - lastT) / 1000);
  if (anim) {
    state.t = Math.max(0, Math.min(1, state.t + dir * dt * 0.25));
    if (state.t === 1 || state.t === 0) stopAnim();
    sync();
  }
  if (turning) {
    turnAcc += dt;
    if (turnAcc > 0.25) {
      turnAcc = 0; state.zone = (state.zone % 60) + 1;
      if (--turnLeft <= 0) stopTurn();
      sync();
    }
  }
  lastT = now;
  controls.update();
  marker.scale.setScalar(0.006 * Math.min(1, camera.position.distanceTo(marker.position) / 2.5));
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

ui.bm.addEventListener("change", () => { state.bm = ui.bm.value; writeHash(); basemap.set(state.bm); });

window.addEventListener("hashchange", () => { readHash(); if (state.cam) setCamera(state.cam); basemap.set(state.bm); sync(); });

if (embed) {
  document.body.classList.add("embed");
  $("open-full").hidden = false;
}

let coastLines = null;
readHash();
setCamera(state.cam || defaultCam());
resize();
drawGlobe(null);
sync();
basemap.set(state.bm);
requestAnimationFrame(tick);

loadCoastline("110m").then((lines) => { coastLines = lines; drawGlobe(lines); drawStrip(state.zone); builtUps = ""; sync(); });
loadCoastline("50m").then((lines) => { coast50 = lines; drawStrip(state.zone); builtUps = ""; sync(); }).catch(() => {});
fetch(new URL("../data/s2-tiles.json", import.meta.url)).then((r) => r.json()).then((json) => {
  grid = g.tileSet(json);
  builtTiles = false;
  if (state.pt && !state.tile && !location.hash.includes("tile=")) {
    const pt = parsePt(state.pt);
    if (pt) setPoint(pt[0], pt[1], { zone: false });
  }
  sync();
  document.body.classList.add("ready");
});
