// playproj: Tissot's indicatrix.
//
// Equal small circles on the globe (three.js, left) and what a projection
// makes of them (2D canvas, right). The ellipses come from js/tissot.js,
// which differences the proj4js forward projection the way PROJ's
// proj_factors() does; "Projected circles" instead projects each circle
// point by point, so the two can be compared as the circles grow. The same
// factors, sampled over the whole map by js/distortion.js, colour the
// image and draw its contours, and download as a float GeoTIFF.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadCoastline } from "./data.js";
import { graticule } from "./geo.js";
import * as T from "./tissot.js";
import * as D from "./distortion.js";
import { drawIndicatrix, drawInset, drawContours } from "./tissot-draw.js";
import { writeFloatGeoTIFF, esriGeoKeys, proj4Wkt } from "./geotiff-write.js";
import { saveBlob } from "./download.js";

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
    ["tmerc", "Transverse Mercator", "+proj=tmerc +lat_0={lat} +lon_0={lon}"],
    ["utm55s", "UTM zone 55 south (WGS84)", "+proj=utm +zone=55 +south +ellps=WGS84"]
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

// size is the fixed radius in degrees, fit the share of the spacing an
// auto-sized indicatrix fills; grid is g<degrees> on the globe or
// m<count> across the map
const defaults = {
  proj: "merc", def: "", lon: 0, lat: 0, auto: 1, size: 6, fit: 0.8, grid: "g30", ell: 1, circ: 0, unit: 1, axes: 1,
  norm: 0, efill: 0, inset: 1, grat: 1, field: "s", img: 0, iso: 0, pt: "40,50", cam: null
};
const GRIDS = ["g10", "g15", "g20", "g30", "m8", "m12", "m16", "m24"];
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
    else if (k === "grid") state.grid = GRIDS.includes(raw) ? raw : "g30";
    else if (k === "field") state.field = D.FIELD.has(raw) ? raw : "s";
    else if (k === "cam") {
      const c = raw.split(",").map(Number);
      if (c.length === 6 && c.every(isFinite)) state.cam = c;
    } else if (isFinite(+raw)) state[k] = +raw;
  }
  state.lon = Math.max(-180, Math.min(180, state.lon));
  state.lat = Math.max(-90, Math.min(90, state.lat));
  // links from before the distortion field: step, color, and a size that
  // meant a fixed radius
  if (h.has("step") && !h.has("grid")) state.grid = h.get("step") === "15" ? "g15" : "g30";
  if (h.has("color") && !h.has("field")) {
    const c = h.get("color");
    if (c === "area" || c === "angle") { state.field = c === "area" ? "s" : "omega"; state.img = 1; }
  }
  if (h.has("size") && !h.has("auto")) state.auto = 0;
  state.size = Math.max(0.5, Math.min(20, state.size));
  state.fit = Math.max(0.2, Math.min(1.5, state.fit));
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

// presets are on a sphere unless they name their own ellipsoid
const projDef = () => {
  if (state.proj === "custom") return state.def;
  const t = PRESET.get(state.proj).t.replace("{lon}", state.lon).replace("{lat}", state.lat);
  return /\+(ellps|datum)=/.test(t) ? t : t + ` +R=${R}`;
};

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

// Frame the map on the points where the scale stays under AMAX, and keep
// the samples (lon, lat, factors): all of them for the summary, those in
// the frame for the colour scales.
function frame(p) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const stats = [], samples = [], inFrame = [];
  for (let lat = -88.5; lat < 90; lat += 3) {
    for (let lon = -178.5; lon < 180; lon += 3) {
      const xy = p.fwd(lon, lat);
      if (!xy) continue;
      const f = T.factors(p.fwd, lon, lat, { es: p.es });
      if (!f) continue;
      samples.push([lon, lat, f]);
      if (f.a > AMAX) continue;
      stats.push(f);
      inFrame.push(f);
      x0 = Math.min(x0, xy[0]); x1 = Math.max(x1, xy[0]);
      y0 = Math.min(y0, xy[1]); y1 = Math.max(y1, xy[1]);
    }
  }
  if (!stats.length) return null;
  const px = (x1 - x0) * 0.04, py = (y1 - y0) * 0.04;
  return { x0: x0 - px, x1: x1 + px, y0: y0 - py, y1: y1 + py, cls: T.classify(stats), samples, inFrame, summary: D.summarise(samples) };
}

// The colour scale of a field, fitted to the samples in the map's frame
// (not the view) so the map, the globe and the ellipses all agree whatever
// part is in view, and a singularity off the map does not wash it out.
const scales = new Map();
function scaleOf(p, key) {
  const k = `${Pdef}|${key}`;
  if (!scales.has(k)) {
    const get = D.FIELD.get(key).get;
    scales.set(k, D.colourScale(key, p.frame.inFrame.map(get)));
  }
  return scales.get(k);
}

// ---------------------------------------------------------------- lattice

// The indicatrices: centres (on the globe, or on the part of the map in
// view, so zooming in on a region regrids it), their factors and map
// positions, and the ground radius r (radians) they are drawn at, fixed or
// fitted to the spacing.
let lat0 = { key: "" };
function lattice(p, ext) {
  const onMap = state.grid[0] === "m" && ext;
  const where = onMap ? [ext.x0, ext.x1, ext.y0, ext.y1].map((v) => v.toFixed(5)).join() : "";
  const key = `${Pdef}|${state.grid}|${state.auto}|${state.size}|${state.fit}|${state.norm}|${where}`;
  if (lat0.key === key) return lat0;
  const n = +state.grid.slice(1);
  const ll = !p || !p.frame ? [] : onMap ? D.mapLattice(p.inv, ext, n) : state.grid[0] === "g" ? D.graticuleLattice(n, centreLon()) : [];
  const pts = [];
  for (const [lon, lat] of ll) {
    const xy = p.fwd(lon, lat);
    const f = xy && T.factors(p.raw, lon, lat, { es: p.es });
    if (!f) continue;
    f.x = xy[0]; f.y = xy[1];
    pts.push(f);
  }
  const mode = state.norm ? "shape" : "true";
  let r = state.size * D2R;
  // a centre on the map stands for 1 / s of the globe, one on the
  // graticule for cos(lat), the default
  const weight = state.grid[0] === "m" ? (f) => 1 / f.s : undefined;
  if (state.auto) r = D.autoRadius(pts, { fill: state.fit, mode, weight }) || r;
  // a globe circle past 20 degrees says little about the point
  r = Math.min(r, 20 * D2R);
  lat0 = { key, pts, r, mode };
  return lat0;
}

// The lattice for the current view, and the globe's circles and the size
// readout brought up to date when it (or how the circles look) changed.
let globeKey = "";
function refreshLattice(p, ext) {
  const L = lattice(p, ext);
  const efill = state.efill && p && p.frame;
  const gk = `${L.key}|${efill ? state.field : ""}|${state.ell}|${state.circ}|${state.pt}`;
  if (gk !== globeKey) {
    globeKey = gk;
    updateSize(L);
    buildGlobeCircles(L.pts, L.r / D2R, efill ? colourOf(p) : null);
  }
  return L;
}

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
  new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
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
// the globe instead of cutting under it as a flat fan would. With a colour
// function each cap takes its point's colour.
function buildGlobeCircles(list, rDeg, colour = null) {
  const rings = [], tri = [], col = [], K = 5, N = 48, rr = 1.003;
  const v = new THREE.Vector3();
  let rgb = [1, 0.6, 0];
  const push = (lon, lat) => { toScene(lon, lat, rr, v); tri.push(v.x, v.y, v.z); col.push(rgb[0], rgb[1], rgb[2]); };
  for (const f of list) {
    const { lon, lat } = f, layer = [];
    if (colour) rgb = colour(f).map((c) => (c / 255) ** 2.2);
    for (let k = 1; k <= K; k++) layer.push(T.smallCircle(lon, lat, (rDeg * k) / K, N));
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
  discs.geometry.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  discs.geometry.computeBoundingSphere();
  discs.material.opacity = colour ? 0.8 : 0.45;
  discs.visible = !!state.ell || !!state.circ;
  ringLines.visible = discs.visible;
  const pt = pickedLonLat();
  setSegments(pickLines, pt ? [T.smallCircle(pt[0], pt[1], rDeg, 64)] : [], 1.006);
}

const GET = D.FIELDS.map((d) => [d.key, d.get]);
const OFF = [10, 12, 18];

// Paint values into a canvas through a colour scale, `none` where NaN.
function paintCanvas(cv, values, w, h, scale, none = null) {
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(w, h);
  D.paint(values, scale, img.data);
  if (none) {
    for (let i = 0; i < values.length; i++) {
      if (Number.isFinite(values[i])) continue;
      img.data.set([none[0], none[1], none[2], 255], 4 * i);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// The globe texture: every field sampled on a lon/lat grid (coarse while
// things move), coloured by the chosen one.
let texGrid = { key: "" }, texKey = "";
const texSmall = document.createElement("canvas");
function paintGlobeTexture(p) {
  const B = rasterStep > 3 ? 3 : 1;
  const show = p && p.frame && state.img;
  const key = show ? `${Pdef}|${state.field}|${B}` : "plain";
  if (key === texKey) return;
  texKey = key;
  const ctx = texCanvas.getContext("2d"), w = texCanvas.width, h = texCanvas.height;
  if (!show) {
    ctx.fillStyle = "#1b2638"; ctx.fillRect(0, 0, w, h);
  } else {
    const nx = w / B, ny = h / B, gk = `${Pdef}|${B}`;
    if (texGrid.key !== gk) {
      texGrid = { key: gk, f: D.sample(p.raw, D.lonLatCells(nx, ny, (lon, lat) => !!p.fwd(lon, lat)), nx, ny, GET, { es: p.es }) };
    }
    paintCanvas(texSmall, texGrid.f[state.field], nx, ny, scaleOf(p, state.field), OFF);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(texSmall, 0, 0, w, h);
  }
  texture.needsUpdate = true;
}

// ---------------------------------------------------------------- map

const mapCanvas = document.getElementById("map");
const raster = document.createElement("canvas");
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

// Every field on a grid of screen cells (STEP pixels each), kept until the
// view or projection changes; the image and the contours both come from it.
let mapGrid = { key: "" }, rasterKey = "";
function fieldGrid(p, v, cw, ch) {
  const STEP = rasterStep, w = Math.ceil(cw / STEP), h = Math.ceil(ch / STEP);
  const key = `${Pdef}|${w}x${h}|${zoom.k},${zoom.cx},${zoom.cy}`;
  if (mapGrid.key !== key) {
    const [x0, y1] = v.inv(0, 0), [x1, y0] = v.inv(w * STEP, h * STEP);
    const e = { x0, x1, y0, y1 };
    mapGrid = { key, w, h, step: STEP, e, f: D.sample(p.raw, D.mapCells(p.inv, e, w, h), w, h, GET, { es: p.es }) };
  }
  return mapGrid;
}

function paintRaster(p, g) {
  const key = `${g.key}|${state.field}`;
  if (key === rasterKey) return;
  rasterKey = key;
  paintCanvas(raster, g.f[state.field], g.w, g.h, scaleOf(p, state.field));
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
  if (!p || !p.frame) { view = null; refreshLattice(p, null); return; }
  const v = view = mapTransform(p.frame, cw, ch);
  const jump = 0.3 * (p.frame.x1 - p.frame.x0);
  const lon0 = +(/\+lon_0=(-?[\d.]+)/.exec(Pdef) || [0, 0])[1] || 0;
  const rel = (lon) => ((lon - lon0 + 540) % 360) - 180;
  const toPx = (x, y) => [v.X(x), v.Y(y)];

  if (state.img || state.iso) {
    const g = fieldGrid(p, v, cw, ch);
    if (state.img) {
      paintRaster(p, g);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(raster, 0, 0, g.w * g.step, g.h * g.step);
    }
    if (state.iso) drawIsolines(ctx, p, g);
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

  const [ex0, ey1] = v.inv(0, 0), [ex1, ey0] = v.inv(cw, ch);
  const L = refreshLattice(p, { x0: ex0, x1: ex1, y0: ey0, y1: ey1 }), sc = state.efill ? scaleOf(p, state.field) : null, get = D.FIELD.get(state.field).get;
  const drawOne = (f, pick) => {
    const r = L.r * D.sizeFactor(f, L.mode);
    if (state.unit) {
      ctx.setLineDash([3, 3]); ctx.strokeStyle = COLORS.unit; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(v.X(f.x), v.Y(f.y), r * v.s, 0, 2 * Math.PI); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (state.ell) {
      const c = sc && !pick && sc.rgb(get(f));
      drawIndicatrix(ctx, f, toPx, r, {
        fill: pick ? "rgba(255,211,77,0.35)" : c ? `rgba(${c[0]},${c[1]},${c[2]},0.85)` : COLORS.fill,
        stroke: pick ? COLORS.pick : c ? "rgba(235,240,250,0.55)" : COLORS.edge, width: pick ? 2 : 1,
        axes: state.axes ? [COLORS.par, COLORS.mer] : null
      });
    } else if (state.axes) {
      drawIndicatrix(ctx, f, toPx, r, { axes: [COLORS.par, COLORS.mer] });
    }
    if (state.circ) {
      // the circle itself, projected point by point (shrunk about its
      // centre along with the ellipse when every one is drawn the same area)
      const ring = T.smallCircle(f.lon, f.lat, L.r / D2R, 64), g = D.sizeFactor(f, L.mode);
      ctx.strokeStyle = pick ? COLORS.pick : COLORS.circ; ctx.lineWidth = pick ? 2 : 1.3;
      ctx.beginPath();
      let on = false;
      for (let i = 0; i < ring.length; i += 2) {
        const xy = p.fwd(ring[i], ring[i + 1]);
        if (!xy || Math.hypot(xy[0] - f.x, xy[1] - f.y) > jump) { on = false; continue; }
        const X = v.X(f.x + (xy[0] - f.x) * g), Y = v.Y(f.y + (xy[1] - f.y) * g);
        if (on) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
        on = true;
      }
      ctx.stroke();
    }
  };

  for (const f of L.pts) {
    if (f.a * L.r * D.sizeFactor(f, L.mode) > 0.5 * (p.frame.x1 - p.frame.x0)) continue;
    drawOne(f, false);
  }
  const pt = pickedLonLat(), pxy = pt && p.fwd(pt[0], pt[1]);
  const pf = pxy && T.factors(p.raw, pt[0], pt[1], { es: p.es });
  if (pf) {
    pf.x = pxy[0]; pf.y = pxy[1];
    drawOne(pf, true);
    if (state.inset) {
      const size = Math.max(96, Math.min(150, Math.min(cw, ch) * 0.28));
      drawInset(ctx, pf, cw - size - 8, ch - size - 8, size, { par: COLORS.par, mer: COLORS.mer });
    }
  }
}

// Contours of the chosen field, at round values, with the true value (1,
// or 0 for convergence) drawn heavier.
function drawIsolines(ctx, p, g) {
  const key = state.field, sc = scaleOf(p, key), tf = D.contourTransform(key);
  const vals = g.f[key], unit = D.FIELD.get(key).kind === "angle" || key === "conv" ? DEG : "";
  const toPx = (x, y) => [x * g.step, y * g.step], taken = [];
  for (const lv of D.levels(sc)) {
    const segs = D.isolines(vals, g.w, g.h, lv, tf);
    const main = lv === 1 || (key === "conv" && lv === 0);
    drawContours(ctx, segs, toPx, {
      color: main ? "rgba(255,255,255,0.9)" : "rgba(225,232,245,0.6)", width: main ? 1.6 : 0.9,
      label: levelText(lv) + unit, taken
    });
  }
}
const levelText = (v) => (Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : Math.abs(v) < 1 ? String(+v.toFixed(2)) : String(+v.toFixed(2)));

// ---------------------------------------------------------------- panel

const $ = (id) => document.getElementById(id);
const ui = {
  proj: $("proj"), def: $("def"), badge: $("badge"), lon: $("lon"), lat: $("lat"), lonOut: $("lon-out"), latOut: $("lat-out"),
  size: $("size"), sizeOut: $("size-out"), sizeLabel: $("size-label"), sizing: $("sizing"), grid: $("grid"),
  field: $("field"), legend: $("legend"), cbar: $("cbar"), summary: $("summary"),
  readout: $("readout"), ptOut: $("pt-out")
};
const TOGGLES = ["ell", "circ", "unit", "axes", "norm", "efill", "inset", "grat", "img", "iso"];
for (const k of TOGGLES) ui[k] = $(k);

for (const d of D.FIELDS) {
  const o = document.createElement("option");
  o.value = d.key; o.textContent = `${d.sym}, ${d.label}`;
  ui.field.appendChild(o);
}

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

// Range and area-weighted mean of the main factors over the globe, the
// summary() of the R tissot package.
function updateSummary(p) {
  if (!p || !p.frame) { ui.summary.innerHTML = ""; return; }
  const sm = p.frame.summary;
  const row = (key, d = 3, u = "") => {
    const q = sm[key], df = D.FIELD.get(key);
    return q ? `<tr><td>${df.sym}, ${df.label}</td><td>${fmt(q.min, d)}${u}</td><td>${fmt(q.mean, d)}${u}</td><td>${fmt(q.max, d)}${u}</td></tr>` : "";
  };
  ui.summary.innerHTML = "<tr><th></th><th>min</th><th>mean</th><th>max</th></tr>" +
    row("s") + row("omega", 2, DEG) + row("h") + row("k");
}

// The colour bar for the chosen field, with its contour levels as ticks.
function drawColourBar(p) {
  const cv = ui.cbar, dpr = Math.min(window.devicePixelRatio || 1, 2);
  const show = p && p.frame && (state.img || state.iso || state.efill);
  cv.hidden = !show;
  const w = cv.clientWidth;
  const d = D.FIELD.get(state.field);
  if (!show) {
    ui.legend.textContent = "Show the field as an image, as contours, or as the colour of the indicatrices.";
    return;
  }
  if (!w) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(34 * dpr);
  const ctx = cv.getContext("2d"), sc = scaleOf(p, state.field), H = 12, pad = 8, bw = w - 2 * pad;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, 34);
  for (let i = 0; i < bw; i++) {
    const c = sc.rgb(sc.at((i + 0.5) / bw));
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.fillRect(pad + i, 2, 1, H);
  }
  ctx.strokeStyle = "#2c4a73"; ctx.strokeRect(pad + 0.5, 2.5, bw - 1, H - 1);
  const unit = d.kind === "angle" || d.kind === "signed" ? DEG : "";
  ctx.font = "10px system-ui, sans-serif"; ctx.textBaseline = "top"; ctx.fillStyle = "#9fb3c8"; ctx.strokeStyle = "#9fb3c8";
  const ticks = [[sc.lo, "left"], ...D.levels(sc).map((v) => [v, "center"]), [sc.hi, "right"]];
  let last = -Infinity;
  for (const [v, align] of ticks) {
    const x = pad + sc.pos(v) * bw;
    if (align === "center" && (x - last < 26 || x > pad + bw - 22 || x < pad + 22)) continue;
    ctx.beginPath(); ctx.moveTo(x, 2 + H); ctx.lineTo(x, 5 + H); ctx.stroke();
    ctx.textAlign = align;
    ctx.fillText(levelText(+v.toPrecision(3)) + unit, align === "left" ? pad : align === "right" ? pad + bw : x, 7 + H);
    last = x;
  }
  const how = {
    scale: "log scale: blue below 1 (shrunk), orange above (swollen), dark at true scale",
    ratio: "log scale from 1 (a circle), dark, to the most flattened",
    angle: "dark where angles are kept, purple to yellow as the error grows",
    signed: "blue west of north, orange east, dark along map north"
  }[d.kind];
  ui.legend.textContent = `${d.sym}, ${d.label}${d.proj ? ` (PROJ ${d.proj})` : ""}: ${how}. The ends are the 2nd and 98th percentiles over the map, where the scale is under ${AMAX}.`;
}

function updateBadge(p) {
  if (typeof proj4 === "undefined") { ui.badge.className = "badge"; ui.badge.textContent = "proj4js did not load."; return; }
  if (!p || !p.frame) { ui.badge.className = "badge"; ui.badge.textContent = "proj4js cannot use this string."; return; }
  const c = p.frame.cls;
  ui.badge.className = "badge ok";
  ui.badge.textContent = (c.kind === "conformal"
    ? `Conformal: every ellipse is a circle (\u03c9 < 0.0001${DEG}).`
    : c.kind === "equal-area"
      ? "Equal-area: every ellipse has the same area."
      : "Neither conformal nor equal-area.") + ` Over the globe, every 3${DEG}:`;
}

const colourOf = (p) => {
  const sc = scaleOf(p, state.field), get = D.FIELD.get(state.field).get;
  return (f) => sc.rgb(get(f));
};

// The one slider sets the share of the spacing an auto-sized indicatrix
// fills, or the fixed radius in degrees; either way the output shows the
// ground radius it comes to.
function updateSize(L) {
  const km = (L.r * R) / 1000, deg = L.r / D2R;
  const ground = `${deg < 10 ? deg.toFixed(1) : deg.toFixed(0)}${DEG}, ${km < 100 ? km.toFixed(1) : km.toFixed(0)} km`;
  if (state.auto) {
    ui.sizeLabel.textContent = "Fill of the spacing";
    Object.assign(ui.size, { min: 0.2, max: 1.5, step: 0.05 });
    ui.size.value = state.fit;
    ui.sizeOut.textContent = `${Math.round(state.fit * 100)}% (${ground})`;
  } else {
    ui.sizeLabel.textContent = "Circle radius";
    Object.assign(ui.size, { min: 0.5, max: 20, step: 0.5 });
    ui.size.value = state.size;
    ui.sizeOut.textContent = ground;
  }
}

function sync() {
  const custom = state.proj === "custom";
  ui.proj.value = state.proj;
  if (document.activeElement !== ui.def) ui.def.value = custom ? state.def : projDef().replace(` +R=${R}`, "");
  const tmpl = custom ? "" : PRESET.get(state.proj).t;
  ui.lon.value = state.lon; ui.lonOut.textContent = `${state.lon}${DEG}`;
  ui.lat.value = state.lat; ui.latOut.textContent = `${state.lat}${DEG}`;
  ui.lon.disabled = custom || !tmpl.includes("{lon}");
  ui.lat.disabled = custom || !tmpl.includes("{lat}");
  ui.grid.value = state.grid;
  ui.sizing.value = String(state.auto);
  ui.field.value = state.field;
  for (const k of TOGGLES) ui[k].checked = !!state[k];

  const p = projection();
  ui.def.classList.toggle("bad", !p || !p.frame);
  updateBadge(p);
  updateSummary(p);
  updateReadout(p);
  gratLines.visible = !!state.grat;
  paintGlobeTexture(p);
  drawColourBar(p);
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
ui.size.addEventListener("input", () => { state[state.auto ? "fit" : "size"] = +ui.size.value; sync(); });
ui.sizing.addEventListener("change", () => {
  // keep the circles the size they are when switching to a fixed radius
  if (!+ui.sizing.value) state.size = Math.max(0.5, Math.min(20, Math.round(lat0.r / D2R * 2) / 2));
  state.auto = +ui.sizing.value;
  sync();
});
ui.grid.addEventListener("change", () => { state.grid = ui.grid.value; sync(); });
ui.field.addEventListener("change", () => { state.field = ui.field.value; sync(); });
for (const k of TOGGLES) ui[k].addEventListener("change", () => { state[k] = ui[k].checked ? 1 : 0; sync(); });
// Every factor PROJ reports, over what the map shows, as float32 bands in
// the map's own CRS (metres), named as proj_factors() names them.
$("save-tif").addEventListener("click", async (e) => {
  const p = projection(), btn = e.target;
  if (!p || !view) return;
  const cw = mapCanvas.clientWidth, ch = mapCanvas.clientHeight;
  // about 1.5 cells a pixel, at most 600 000 cells (a few seconds' work)
  const k = Math.min(1.5, Math.sqrt(6e5 / (cw * ch))), nx = Math.round(cw * k), ny = Math.round(ch * k);
  const [x0, y1] = view.inv(0, 0), [x1, y0] = view.inv(cw, ch), e0 = { x0, x1, y0, y1 };
  btn.disabled = true; btn.textContent = "Sampling...";
  await new Promise((r) => setTimeout(r, 30));
  const g = D.sample(p.raw, D.mapCells(p.inv, e0, nx, ny), nx, ny, D.BANDS, { es: p.es });
  const A = p.a, invf = p.es ? 1 / (1 - Math.sqrt(1 - p.es)) : 0, b = A * Math.sqrt(1 - p.es);
  const def = Pdef.replace(/\s+/g, " ").trim(), name = (/\+proj=(\w+)/.exec(def) || [0, "proj"])[1];
  const blob = await writeFloatGeoTIFF({
    width: nx, height: ny, bands: D.BANDS.map(([n]) => g[n]), names: D.BANDS.map(([n]) => n),
    origin: [x0 * A, y1 * A], pixelSize: [((x1 - x0) * A) / nx, ((y1 - y0) * A) / ny],
    geoKeys: esriGeoKeys(proj4Wkt(name, def, A, invf), A, `playproj factors ${def}`, b)
  });
  saveBlob(blob, `factors-${name}.tif`);
  btn.disabled = false; btn.textContent = "Factors GeoTIFF";
});
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
  `<iframe src="${pageUrl()}?embed=1${location.hash}" width="100%" height="480" style="border:0" loading="lazy" title="Distortion"></iframe>`,
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
