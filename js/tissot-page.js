// playproj: Tissot's indicatrix.
//
// Equal small circles on the globe (three.js, left) and what a projection
// makes of them (2D canvas, right). The ellipses come from js/tissot.js,
// which differences the proj4js forward projection the way PROJ's
// proj_factors() does; "Projected circles" instead projects each circle
// point by point, so the two can be compared as the circles grow.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadCoastline, graticule } from "./geo.js";
import * as T from "./tissot.js";

const D2R = Math.PI / 180;
const DEG = "\u00b0";
const R = 6371008.8;   // PROJ strings use a sphere; factors are ratios, so any R will do
const AMAX = 4;        // largest scale kept when framing the map

const COLORS = {
  bg: 0x05070d,
  globe: 0x1b2638,
  coast: "#d7ecff",
  mapCoast: "#6ab787",
  grat: "#2c4a73",
  fill: "rgba(255,153,0,0.42)",
  edge: "#ffb347",
  circ: "#7ad7ff",
  unit: "rgba(220,230,245,0.55)",
  par: "#ff5a5a",
  mer: "#5aa0ff",
  pick: "#ffd34d"
};

// [id, label, template]: {lon} and {lat} are filled from the sliders
const PRESETS = [
  ["Cylindrical", [
    ["merc", "Mercator", "+proj=merc +lon_0={lon}"],
    ["eqc", "Plate carree", "+proj=eqc +lon_0={lon}"],
    ["cea", "Lambert cylindrical equal-area", "+proj=cea +lon_0={lon}"],
    ["gall", "Gall-Peters", "+proj=cea +lat_ts=45 +lon_0={lon}"],
    ["mill", "Miller", "+proj=mill +lon_0={lon}"],
    ["tmerc", "Transverse Mercator", "+proj=tmerc +lat_0={lat} +lon_0={lon}"]
  ]],
  ["Pseudocylindrical", [
    ["sinu", "Sinusoidal", "+proj=sinu +lon_0={lon}"],
    ["moll", "Mollweide", "+proj=moll +lon_0={lon}"],
    ["robin", "Robinson", "+proj=robin +lon_0={lon}"],
    ["eqearth", "Equal Earth", "+proj=eqearth +lon_0={lon}"]
  ]],
  ["Conic", [
    ["lcc", "Lambert conformal conic", "+proj=lcc +lat_1=30 +lat_2=60 +lon_0={lon}"],
    ["aea", "Albers equal-area", "+proj=aea +lat_1=20 +lat_2=50 +lon_0={lon}"],
    ["eqdc", "Equidistant conic", "+proj=eqdc +lat_1=20 +lat_2=60 +lon_0={lon}"],
    ["bonne", "Bonne", "+proj=bonne +lat_1=45 +lon_0={lon}"]
  ]],
  ["Azimuthal", [
    ["stere", "Stereographic", "+proj=stere +lat_0={lat} +lon_0={lon}"],
    ["laea", "Lambert azimuthal equal-area", "+proj=laea +lat_0={lat} +lon_0={lon}"],
    ["aeqd", "Azimuthal equidistant", "+proj=aeqd +lat_0={lat} +lon_0={lon}"],
    ["gnom", "Gnomonic", "+proj=gnom +lat_0={lat} +lon_0={lon}"],
    ["ortho", "Orthographic", "+proj=ortho +lat_0={lat} +lon_0={lon}"]
  ]],
  ["Other", [
    ["vandg", "van der Grinten", "+proj=vandg +lon_0={lon}"]
  ]]
];
const PRESET = new Map(PRESETS.flatMap(([, list]) => list.map(([id, label, t]) => [id, { label, t }])));

// ---------------------------------------------------------------- state

const defaults = { proj: "merc", def: "", lon: 0, lat: 0, size: 6, step: 30, ell: 1, circ: 0, unit: 1, axes: 1, grat: 1, color: "none", pt: "40,50", cam: null };
const state = { ...defaults };
const embed = new URLSearchParams(location.search).has("embed");

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  Object.assign(state, defaults);
  for (const k of Object.keys(defaults)) {
    if (!h.has(k)) continue;
    const raw = h.get(k);
    if (k === "proj") state.proj = PRESET.has(raw) || raw === "custom" ? raw : "merc";
    else if (k === "def" || k === "pt") state[k] = raw;
    else if (k === "color") state.color = ["none", "area", "angle"].includes(raw) ? raw : "none";
    else if (k === "cam") {
      const c = raw.split(",").map(Number);
      if (c.length === 6 && c.every(isFinite)) state.cam = c;
    } else if (isFinite(+raw)) state[k] = +raw;
  }
  state.lon = Math.max(-180, Math.min(180, state.lon));
  state.lat = Math.max(-90, Math.min(90, state.lat));
  state.size = Math.max(1, Math.min(20, state.size));
  state.step = state.step === 15 ? 15 : 30;
  if (state.proj === "custom" && !state.def) state.proj = "merc";
}

let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const h = new URLSearchParams();
    for (const k of Object.keys(defaults)) {
      if (k === "cam") { if (state.cam) h.set("cam", state.cam.map((x) => +x.toFixed(2)).join(",")); continue; }
      if (k === "def" && state.proj !== "custom") continue;
      const val = typeof state[k] === "number" ? +state[k].toFixed(3) : state[k];
      if (val !== defaults[k]) h.set(k, String(val));
    }
    const s = h.toString();
    history.replaceState(null, "", s ? "#" + s : location.pathname + location.search);
  }, 200);
}

const projDef = () => state.proj === "custom"
  ? state.def
  : PRESET.get(state.proj).t.replace("{lon}", state.lon).replace("{lat}", state.lat) + ` +R=${R}`;

// the central meridian, read back from a custom string
const centreLon = () => state.proj === "custom"
  ? +(/\+lon_0=(-?[\d.]+)/.exec(state.def) || [0, 0])[1] || 0
  : state.lon;

const pickedLonLat = () => {
  const v = state.pt.split(",").map(Number);
  return v.length === 2 && v.every(isFinite) && Math.abs(v[1]) <= 90 ? v : null;
};

// ---------------------------------------------------------------- projection

let P = null, Pdef = "";

// The forward function with the round trip check (for drawing) and a bare
// one for the factors of points already known to be on the map.
function projection() {
  const d = projDef();
  if (d === Pdef) return P;
  Pdef = d;
  P = typeof proj4 === "undefined" ? null : T.proj4Forward(proj4, d);
  if (P) {
    P.raw = T.proj4Forward(proj4, d, { check: false }).fwd;
    P.frame = frame(P);
  }
  return P;
}

// Centres of the indicatrices: a lon/lat lattice about the central meridian,
// stopping short of the seam and the poles.
function centres(step, lon0) {
  const out = [];
  for (let lat = -90 + step; lat < 90; lat += step) {
    for (let dl = -180 + step; dl < 180; dl += step) out.push([((lon0 + dl + 540) % 360) - 180, lat]);
  }
  return out;
}

// Frame the map on the points where the scale stays under AMAX, and note
// the range of the factors for the badge.
function frame(p) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const stats = [];
  for (let lat = -88.5; lat < 90; lat += 3) {
    for (let lon = -178.5; lon < 180; lon += 3) {
      const xy = p.fwd(lon, lat);
      if (!xy) continue;
      const f = T.factors(p.fwd, lon, lat, { es: p.es });
      if (!f || f.a > AMAX) continue;
      stats.push(f);
      x0 = Math.min(x0, xy[0]); x1 = Math.max(x1, xy[0]);
      y0 = Math.min(y0, xy[1]); y1 = Math.max(y1, xy[1]);
    }
  }
  if (!stats.length) return null;
  const px = (x1 - x0) * 0.04, py = (y1 - y0) * 0.04;
  return { x0: x0 - px, x1: x1 + px, y0: y0 - py, y1: y1 + py, cls: T.classify(stats) };
}

// ---------------------------------------------------------------- colour

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const NEUTRAL = [27, 38, 56];
function colorOf(f) {
  if (!f) return null;
  if (state.color === "area") {
    // log2 areal scale, -2 (a quarter) to +2 (four times)
    const t = Math.max(-1, Math.min(1, Math.log2(f.s) / 2));
    return t < 0 ? mix(NEUTRAL, [70, 120, 230], -t) : mix(NEUTRAL, [235, 120, 40], t);
  }
  // angular distortion, 0 to 90 degrees
  const t = Math.min(1, f.omega / 90);
  return t < 0.5 ? mix(NEUTRAL, [150, 60, 170], t * 2) : mix([150, 60, 170], [255, 210, 90], (t - 0.5) * 2);
}
const LEGEND = {
  none: "",
  area: "Blue: shrunk (to a quarter); orange: swollen (to four times); dark: true area.",
  angle: "Dark: angles kept; purple to yellow: up to 90" + DEG + " of angular distortion."
};

// ---------------------------------------------------------------- globe

const stage = document.getElementById("three");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(COLORS.bg);
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 1.4;
controls.maxDistance = 8;

// lon/lat to the scene: y up, lon 0 lat 0 towards +z
function toScene(lon, lat, r = 1, out = new THREE.Vector3()) {
  const p = lat * D2R, l = lon * D2R;
  return out.set(r * Math.cos(p) * Math.sin(l), r * Math.sin(p), r * Math.cos(p) * Math.cos(l));
}

// far enough back that the globe fits the narrower side of the view
function defaultCam() {
  const vf = camera.fov * D2R, hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
  const d = 1.12 / Math.sin(Math.min(vf, hf) / 2);
  const v = toScene(centreLon(), Math.max(-50, Math.min(50, state.lat || 20)), d);
  return [v.x, v.y, v.z, 0, 0, 0];
}
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

scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 0.6);
sun.position.set(3, 4, 5);
scene.add(sun);

// a lon/lat grid, so an equirectangular canvas wraps on with plain uv
function lonLatSphere(nx = 180, ny = 90) {
  const pos = [], uv = [], idx = [], v = new THREE.Vector3();
  for (let j = 0; j <= ny; j++) {
    const lat = -90 + (180 * j) / ny;
    for (let i = 0; i <= nx; i++) {
      const lon = -180 + (360 * i) / nx;
      toScene(lon, lat, 1, v);
      pos.push(v.x, v.y, v.z);
      uv.push(i / nx, j / ny);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

const texCanvas = document.createElement("canvas");
texCanvas.width = 240; texCanvas.height = 120;
const texture = new THREE.CanvasTexture(texCanvas);
texture.colorSpace = THREE.SRGBColorSpace;
texture.flipY = false;
const globe = new THREE.Mesh(lonLatSphere(), new THREE.MeshLambertMaterial({ color: 0xffffff, map: texture }));
scene.add(globe);

function lineObject(color, opacity = 1) {
  const m = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  const o = new THREE.LineSegments(new THREE.BufferGeometry(), m);
  scene.add(o);
  return o;
}
const coastLines = lineObject(COLORS.coast, 0.9);
const gratLines = lineObject(COLORS.grat, 0.9);
const ringLines = lineObject(COLORS.edge);
const pickLines = lineObject(COLORS.pick);
const discs = new THREE.Mesh(new THREE.BufferGeometry(),
  new THREE.MeshBasicMaterial({ color: 0xff9900, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
scene.add(discs);

// flat lon/lat polylines to line segments just above the surface
function segments(lines, r = 1.002) {
  const out = [], a = new THREE.Vector3(), b = new THREE.Vector3();
  for (const l of lines) {
    for (let i = 2; i < l.length; i += 2) {
      toScene(l[i - 2], l[i - 1], r, a); toScene(l[i], l[i + 1], r, b);
      out.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  return new THREE.Float32BufferAttribute(out, 3);
}
function setSegments(obj, lines, r) {
  obj.geometry.setAttribute("position", segments(lines, r));
  obj.geometry.computeBoundingSphere();
}

// Each circle is a filled cap: concentric rings, so it follows the curve of
// the globe instead of cutting under it as a flat fan would.
function buildGlobeCircles(list) {
  const rings = [], tri = [], K = 5, N = 48, rr = 1.003;
  const v = new THREE.Vector3();
  const push = (lon, lat) => { toScene(lon, lat, rr, v); tri.push(v.x, v.y, v.z); };
  for (const [lon, lat] of list) {
    const layer = [];
    for (let k = 1; k <= K; k++) layer.push(T.smallCircle(lon, lat, (state.size * k) / K, N));
    rings.push(layer[K - 1]);
    for (let i = 0; i < N; i++) {
      const a = 2 * i, b = 2 * i + 2;
      push(lon, lat); push(layer[0][a], layer[0][a + 1]); push(layer[0][b], layer[0][b + 1]);
      for (let k = 1; k < K; k++) {
        const p = layer[k - 1], q = layer[k];
        push(p[a], p[a + 1]); push(q[a], q[a + 1]); push(q[b], q[b + 1]);
        push(p[a], p[a + 1]); push(q[b], q[b + 1]); push(p[b], p[b + 1]);
      }
    }
  }
  setSegments(ringLines, rings, 1.004);
  discs.geometry.setAttribute("position", new THREE.Float32BufferAttribute(tri, 3));
  discs.geometry.computeBoundingSphere();
  discs.visible = !!state.ell || !!state.circ;
  ringLines.visible = discs.visible;
  const pt = pickedLonLat();
  setSegments(pickLines, pt ? [T.smallCircle(pt[0], pt[1], state.size, 64)] : [], 1.006);
}

let texKey = "";
function paintGlobeTexture(p) {
  const B = rasterStep > 3 ? 3 : 1;  // coarse blocks while things move
  const key = `${Pdef}|${state.color}|${B}`;
  if (key === texKey) return;
  texKey = key;
  const ctx = texCanvas.getContext("2d"), w = texCanvas.width, h = texCanvas.height;
  if (state.color === "none" || !p) {
    ctx.fillStyle = "#1b2638"; ctx.fillRect(0, 0, w, h);
  } else {
    const img = ctx.createImageData(w, h);
    for (let j = 0; j < h; j += B) {
      const lat = -90 + (180 * (j + B / 2)) / h;
      for (let i = 0; i < w; i += B) {
        const lon = -180 + (360 * (i + B / 2)) / w;
        const c = colorOf(p.fwd(lon, lat) && T.factors(p.raw, lon, lat, { es: p.es })) || [10, 12, 18];
        for (let jj = j; jj < Math.min(h, j + B); jj++) {
          for (let ii = i; ii < Math.min(w, i + B); ii++) {
            const o = 4 * (jj * w + ii);
            img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  texture.needsUpdate = true;
}

// ---------------------------------------------------------------- map

const mapCanvas = document.getElementById("map");
const raster = document.createElement("canvas");
let rasterKey = "";
let view = null; // pixel transform of the last drawn map

// zoom and pan of the map, in plane units; reset when the projection changes
const zoom = { k: 1, cx: 0, cy: 0, def: "" };

function mapTransform(fr, cw, ch) {
  const key = state.proj === "custom" ? Pdef : state.proj;
  if (zoom.def !== key) Object.assign(zoom, { k: 1, cx: (fr.x0 + fr.x1) / 2, cy: (fr.y0 + fr.y1) / 2, def: key });
  const s = Math.min(cw / (fr.x1 - fr.x0), ch / (fr.y1 - fr.y0)) * 0.96 * zoom.k;
  const xc = zoom.cx, yc = zoom.cy;
  return {
    s,
    X: (x) => cw / 2 + (x - xc) * s,
    Y: (y) => ch / 2 - (y - yc) * s,
    inv: (px, py) => [xc + (px - cw / 2) / s, yc - (py - ch / 2) / s]
  };
}

// The colour layer costs a few microseconds a pixel, so while anything is
// moving it is painted coarse, and sharpened once things settle.
let rasterStep = 3, sharpen = 0;
function settle() {
  rasterStep = 9;
  clearTimeout(sharpen);
  sharpen = setTimeout(() => { rasterStep = 3; paintGlobeTexture(projection()); drawMap(); }, 250);
}

function paintRaster(p, v, cw, ch) {
  const STEP = rasterStep, w = Math.ceil(cw / STEP), h = Math.ceil(ch / STEP);
  const key = `${Pdef}|${state.color}|${w}x${h}|${zoom.k},${zoom.cx},${zoom.cy}`;
  if (key === rasterKey) return;
  rasterKey = key;
  raster.width = w; raster.height = h;
  const ctx = raster.getContext("2d"), img = ctx.createImageData(w, h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [x, y] = v.inv((i + 0.5) * STEP, (j + 0.5) * STEP);
      const ll = p.inv(x, y);
      const c = ll && colorOf(T.factors(p.raw, ll[0], ll[1], { es: p.es }));
      if (!c) continue;
      const o = 4 * (j * w + i);
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  raster.step = STEP;
}

let coast = [];
const grat = graticule(15, 1);

function drawMap() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = mapCanvas.clientWidth, ch = mapCanvas.clientHeight;
  if (!cw || !ch) return;
  if (mapCanvas.width !== Math.round(cw * dpr) || mapCanvas.height !== Math.round(ch * dpr)) {
    mapCanvas.width = Math.round(cw * dpr); mapCanvas.height = Math.round(ch * dpr);
  }
  const ctx = mapCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#05070d";
  ctx.fillRect(0, 0, cw, ch);

  const p = projection();
  if (!p || !p.frame) { view = null; return; }
  const v = view = mapTransform(p.frame, cw, ch);
  const jump = 0.3 * (p.frame.x1 - p.frame.x0);
  const lon0 = +(/\+lon_0=(-?[\d.]+)/.exec(Pdef) || [0, 0])[1] || 0;
  const rel = (lon) => ((lon - lon0 + 540) % 360) - 180;
  const toPx = (x, y) => [v.X(x), v.Y(y)];

  if (state.color !== "none") {
    paintRaster(p, v, cw, ch);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(raster, 0, 0, raster.width * raster.step, raster.height * raster.step);
  }

  const stroke = (lines, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath();
    for (const line of lines) {
      // break at the seam (the meridian opposite lon_0) and at any jump
      let prev = null, pl = 0;
      for (let i = 0; i < line.length; i += 2) {
        const l = rel(line[i]);
        // a point on the seam itself could land on either edge
        if (Math.abs(l) > 180 - 1e-9) { prev = null; continue; }
        const xy = p.fwd(line[i], line[i + 1]);
        if (xy && prev && Math.abs(l - pl) < 180 && Math.hypot(xy[0] - prev[0], xy[1] - prev[1]) < jump) ctx.lineTo(v.X(xy[0]), v.Y(xy[1]));
        else if (xy) ctx.moveTo(v.X(xy[0]), v.Y(xy[1]));
        prev = xy; pl = l;
      }
    }
    ctx.stroke();
  };
  if (state.grat) stroke(grat, COLORS.grat, 0.8);
  stroke(coast, COLORS.mapCoast, 1);

  const r = state.size * D2R;
  const drawOne = (f, pick) => {
    if (state.unit) {
      ctx.setLineDash([3, 3]); ctx.strokeStyle = COLORS.unit; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(v.X(f.x), v.Y(f.y), r * v.s, 0, 2 * Math.PI); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (state.ell) {
      T.drawIndicatrix(ctx, f, toPx, r, {
        fill: pick ? "rgba(255,211,77,0.35)" : COLORS.fill,
        stroke: pick ? COLORS.pick : COLORS.edge, width: pick ? 2 : 1,
        axes: state.axes ? [COLORS.par, COLORS.mer] : null
      });
    } else if (state.axes) {
      T.drawIndicatrix(ctx, f, toPx, r, { axes: [COLORS.par, COLORS.mer] });
    }
    if (state.circ) stroke([T.smallCircle(f.lon, f.lat, state.size, 64)], pick ? COLORS.pick : COLORS.circ, pick ? 2 : 1.3);
  };

  const list = centres(state.step, centreLon());
  for (const [lon, lat] of list) {
    const xy = p.fwd(lon, lat);
    const f = xy && T.factors(p.raw, lon, lat, { es: p.es });
    if (!f || f.a * r > 0.5 * (p.frame.x1 - p.frame.x0)) continue;
    f.x = xy[0]; f.y = xy[1];
    drawOne(f, false);
  }
  const pt = pickedLonLat(), pxy = pt && p.fwd(pt[0], pt[1]);
  const pf = pxy && T.factors(p.raw, pt[0], pt[1], { es: p.es });
  if (pf) { pf.x = pxy[0]; pf.y = pxy[1]; drawOne(pf, true); }
}

// ---------------------------------------------------------------- panel

const $ = (id) => document.getElementById(id);
const ui = {
  proj: $("proj"), def: $("def"), badge: $("badge"), lon: $("lon"), lat: $("lat"), lonOut: $("lon-out"), latOut: $("lat-out"),
  size: $("size"), sizeOut: $("size-out"), step: $("step"), color: $("color"), legend: $("legend"),
  ell: $("ell"), circ: $("circ"), unit: $("unit"), axes: $("axes"), grat: $("grat"), readout: $("readout"), ptOut: $("pt-out")
};

for (const [group, list] of PRESETS) {
  const g = document.createElement("optgroup");
  g.label = group;
  for (const [id, label] of list) {
    const o = document.createElement("option");
    o.value = id; o.textContent = label;
    g.appendChild(o);
  }
  ui.proj.appendChild(g);
}
const custom = document.createElement("option");
custom.value = "custom"; custom.textContent = "Custom PROJ string";
ui.proj.appendChild(custom);

const fmt = (x, d = 4) => (Math.abs(x) >= 1e4 ? x.toExponential(2) : x.toFixed(d));
const lonLatText = (lon, lat) => `${Math.abs(lat).toFixed(1)}${DEG}${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(1)}${DEG}${lon < 0 ? "W" : "E"}`;

function updateReadout(p) {
  const pt = pickedLonLat();
  const f = p && pt && p.fwd(pt[0], pt[1]) && T.factors(p.raw, pt[0], pt[1], { es: p.es });
  ui.ptOut.textContent = pt ? lonLatText(pt[0], pt[1]) : "";
  if (!f) { ui.readout.innerHTML = "<tr><td>off the map</td><td></td></tr>"; return; }
  const rows = [
    ["h, scale along the meridian", fmt(f.h)],
    ["k, scale along the parallel", fmt(f.k)],
    ["a, largest scale", fmt(f.a)],
    ["b, smallest scale", fmt(f.b)],
    ["s, areal scale", fmt(f.s)],
    ["\u03c9, angular distortion", fmt(f.omega, 3) + DEG],
    ["\u03b8\u2032, meridian to parallel", fmt(f.thetap, 3) + DEG],
    ["convergence", fmt(f.conv, 3) + DEG]
  ];
  ui.readout.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
}

function updateBadge(p) {
  if (typeof proj4 === "undefined") { ui.badge.className = "badge"; ui.badge.textContent = "proj4js did not load."; return; }
  if (!p || !p.frame) { ui.badge.className = "badge"; ui.badge.textContent = "proj4js cannot use this string."; return; }
  const c = p.frame.cls;
  ui.badge.className = "badge ok";
  const range = `areal scale ${fmt(c.smin, 3)} to ${fmt(c.smax, 3)}`;
  ui.badge.textContent = c.kind === "conformal"
    ? `Conformal: every ellipse is a circle (\u03c9 < 0.0001${DEG}); ${range}.`
    : c.kind === "equal-area"
      ? `Equal-area: every ellipse has the same area; \u03c9 up to ${c.wmax.toFixed(1)}${DEG}.`
      : `Neither conformal nor equal-area: \u03c9 up to ${c.wmax.toFixed(1)}${DEG}, ${range}.`;
}

function sync() {
  const custom = state.proj === "custom";
  ui.proj.value = state.proj;
  if (document.activeElement !== ui.def) ui.def.value = custom ? state.def : projDef().replace(` +R=${R}`, "");
  const tmpl = custom ? "" : PRESET.get(state.proj).t;
  ui.lon.value = state.lon; ui.lonOut.textContent = `${state.lon}${DEG}`;
  ui.lat.value = state.lat; ui.latOut.textContent = `${state.lat}${DEG}`;
  ui.lon.disabled = custom;
  ui.lat.disabled = custom || !tmpl.includes("{lat}");
  ui.size.value = state.size; ui.sizeOut.textContent = `${state.size}${DEG}`;
  ui.step.value = String(state.step);
  ui.color.value = state.color;
  ui.legend.textContent = LEGEND[state.color];
  for (const k of ["ell", "circ", "unit", "axes", "grat"]) ui[k].checked = !!state[k];

  const p = projection();
  ui.def.classList.toggle("bad", !p || !p.frame);
  updateBadge(p);
  updateReadout(p);
  buildGlobeCircles(centres(state.step, centreLon()));
  gratLines.visible = !!state.grat;
  paintGlobeTexture(p);
  drawMap();
  writeHash();
}

ui.proj.addEventListener("change", () => {
  if (ui.proj.value === "custom") { state.def = state.def || ui.def.value; state.proj = "custom"; }
  else state.proj = ui.proj.value;
  sync();
});
ui.def.addEventListener("change", () => {
  const d = ui.def.value.trim();
  const preset = state.proj !== "custom" && projDef().replace(` +R=${R}`, "");
  if (d && d !== preset) { state.proj = "custom"; state.def = d; }
  sync();
});
ui.def.addEventListener("keydown", (e) => { if (e.key === "Enter") ui.def.blur(); });
ui.lon.addEventListener("input", () => { state.lon = +ui.lon.value; settle(); sync(); });
ui.lat.addEventListener("input", () => { state.lat = +ui.lat.value; settle(); sync(); });
ui.size.addEventListener("input", () => { state.size = +ui.size.value; sync(); });
ui.step.addEventListener("change", () => { state.step = +ui.step.value; sync(); });
ui.color.addEventListener("change", () => { state.color = ui.color.value; sync(); });
for (const k of ["ell", "circ", "unit", "axes", "grat"]) ui[k].addEventListener("change", () => { state[k] = ui[k].checked ? 1 : 0; sync(); });
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(defaultCam()); writeHash(); });

function pick(lon, lat) {
  state.pt = `${+lon.toFixed(2)},${+lat.toFixed(2)}`;
  sync();
}
// drag to pan, wheel to zoom, click to pick
let drag = null;
mapCanvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, cx: zoom.cx, cy: zoom.cy, moved: false };
  mapCanvas.setPointerCapture(e.pointerId);
});
mapCanvas.addEventListener("pointermove", (e) => {
  if (!drag || !view) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  zoom.cx = drag.cx - dx / view.s; zoom.cy = drag.cy + dy / view.s;
  settle(); drawMap();
});
mapCanvas.addEventListener("pointerup", (e) => {
  const d = drag;
  drag = null;
  if (!d || d.moved) return;
  const p = projection();
  if (!p || !view) return;
  const b = mapCanvas.getBoundingClientRect();
  const ll = p.inv(...view.inv(e.clientX - b.left, e.clientY - b.top));
  if (ll) pick(ll[0], ll[1]);
});
mapCanvas.addEventListener("wheel", (e) => {
  if (!view) return;
  e.preventDefault();
  const b = mapCanvas.getBoundingClientRect();
  const [x, y] = view.inv(e.clientX - b.left, e.clientY - b.top);
  const f = Math.exp(-e.deltaY * 0.0015), k = Math.max(0.5, Math.min(40, zoom.k * f)), g = zoom.k / k;
  // keep the point under the cursor where it is
  zoom.cx = x + (zoom.cx - x) * g; zoom.cy = y + (zoom.cy - y) * g; zoom.k = k;
  settle(); drawMap();
}, { passive: false });
mapCanvas.addEventListener("dblclick", () => { zoom.def = ""; drawMap(); });

// a click (not a drag) on the globe picks the point under it
const ray = new THREE.Raycaster();
let down = null;
renderer.domElement.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
  const b = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1), camera);
  const hit = ray.intersectObject(globe)[0];
  if (!hit) return;
  const q = hit.point.clone().normalize();
  pick(Math.atan2(q.x, q.z) / D2R, Math.asin(Math.max(-1, Math.min(1, q.y))) / D2R);
});

function copy(text, btn) {
  const done = () => { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1200); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => prompt("Copy:", text));
  else prompt("Copy:", text);
}
const pageUrl = () => location.origin + location.pathname;
$("copy-link").addEventListener("click", (e) => copy(pageUrl() + location.hash, e.target));
$("copy-embed").addEventListener("click", (e) => copy(
  `<iframe src="${pageUrl()}?embed=1${location.hash}" width="100%" height="480" style="border:0" loading="lazy" title="Tissot's indicatrix"></iframe>`,
  e.target));
$("copy-def").addEventListener("click", (e) => copy(ui.def.value, e.target));
$("open-full").href = pageUrl() + location.hash;

// ---------------------------------------------------------------- loop

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
const main = document.getElementById("stage");
new ResizeObserver(() => main.classList.toggle("stacked", main.clientHeight > main.clientWidth)).observe(main);
new ResizeObserver(() => drawMap()).observe(mapCanvas);

function tick() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

window.addEventListener("hashchange", () => { readHash(); setCamera(state.cam || defaultCam()); sync(); });

if (embed) {
  document.body.classList.add("embed");
  $("open-full").hidden = false;
}

readHash();
setSegments(gratLines, graticule(30, 2), 1.001);
resize();
setCamera(state.cam || defaultCam());
sync();
loadCoastline("110m").then((c) => {
  coast = c;
  setSegments(coastLines, c, 1.002);
  drawMap();
  document.body.classList.add("ready");
});
requestAnimationFrame(tick);
