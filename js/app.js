// playproj: azimuthal perspective playground.
//
// The 3D view is built from the ray construction in families/perspective.js.
// The 2D map is drawn by proj4js from the PROJ string whenever one exists, so
// the two views are independent checks on each other.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import * as persp from "./families/perspective.js";
import * as azi from "./families/azimuthal.js";
import { loadCoastline, graticule, mulberry32, sceneFrame } from "./geo.js";
import { sources, loadWorld, reproject, sampleElev } from "./basemap.js";
import { writeGeoTIFF } from "./geotiff-write.js";

const RAY_REACH = 6;      // rays from lights further than this start at the edge of the scene
const RAY_POOL = 4000;    // candidate ray targets, sampled once per seed
const DEG = "\u00b0";

const CONSTRUCTIONS = ["light", "laea", "aeqd"];

const COLORS = {
  bg: 0x05070d,
  globe: 0x1e6fd9,
  coastOn: 0xd7ecff,
  coastOff: 0x3b5577,
  grat: 0x2c4a73,
  plane: 0xffffff,
  planeCoast: 0x6ab787,
  planeGrat: 0x3d6b52,
  ray: 0x9aa3ad,
  light: 0xffd34d,
  horizon: 0xffb347,
  compass: 0xff7ab8,
  string: 0x7ad7ff
};

// ---------------------------------------------------------------- state

const defaults = { az: "light", v: -0.5, lat: -90, lon: 0, w: 2.5, rays: 120, seed: 1, detail: "110m", grat: 1, globe: 1, bm: "none", relief: 0, wire: 0, spin: 0, cam: null };
const state = { ...defaults };
const embed = new URLSearchParams(location.search).has("embed");

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  for (const k of Object.keys(defaults)) {
    if (!h.has(k)) continue;
    const raw = h.get(k);
    if (k === "detail") state.detail = raw === "50m" ? "50m" : "110m";
    else if (k === "bm") state.bm = raw in sources ? raw : "none";
    else if (k === "az") state.az = CONSTRUCTIONS.includes(raw) ? raw : "light";
    else if (k === "cam") {
      const c = raw.split(",").map(Number);
      if (c.length === 6 && c.every(isFinite)) state.cam = c;
    } else if (isFinite(+raw)) state[k] = +raw;
  }
  state.v = Math.max(-1, Math.min(1, state.v));
  state.lat = Math.max(-90, Math.min(90, state.lat));
  state.lon = ((state.lon + 540) % 360) - 180;
  state.w = Math.max(1, Math.min(8, state.w));
  state.rays = Math.max(0, Math.min(1000, Math.round(state.rays)));
  state.relief = Math.max(0, Math.min(100, state.relief));
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

// The light construction is the perspective family; the compass and string
// constructions are the azimuthal family, on the same sphere and plane.
let fam = persp;
const params = () => {
  fam = state.az === "light" ? persp : azi;
  return { a: persp.lightFromSlider(state.v), mode: state.az, lat0: state.lat, lon0: state.lon };
};

// ---------------------------------------------------------------- scene

const stage = document.getElementById("three");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(COLORS.bg);
stage.appendChild(renderer.domElement);

const labels = new CSS2DRenderer();
labels.domElement.className = "labels";
stage.appendChild(labels.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const DEFAULT_CAM = [4.6, 2.6, 6.2, 0, 0.5, 0];
function setCamera(c) {
  camera.position.set(c[0], c[1], c[2]);
  controls.target.set(c[3], c[4], c[5]);
  controls.update();
}
setCamera(state.cam || DEFAULT_CAM);
controls.addEventListener("end", () => {
  const p = camera.position, t = controls.target;
  state.cam = [p.x, p.y, p.z, t.x, t.y, t.z];
  writeHash();
});

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(3, 5, 4);
scene.add(sun);

// The globe is a lon/lat grid placed by the scene frame, so an
// equirectangular basemap wraps onto it with plain lon/lat texture coordinates.
const globe = new THREE.Mesh(
  new THREE.BufferGeometry(),
  new THREE.MeshPhongMaterial({ color: COLORS.globe, transparent: true, opacity: 0.28, shininess: 40, depthWrite: false })
);
scene.add(globe);

// A plain grid for the smooth globe, a finer one when it carries relief.
function lonLatGrid(nx, ny) {
  const index = [], uv = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + nx + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) uv.push(i / nx, 1 - j / ny);
  return { nx, ny, index, uv };
}
// a wireframe reads better on a coarser grid
const GLOBE_GRID = lonLatGrid(144, 72), RELIEF_GRID = lonLatGrid(360, 180), WIRE_GRID = lonLatGrid(180, 90);
const EARTH_R = 6371000;

// Relief: each point is pushed out along its radius (globe) or along the
// plane's normal (plane) by its elevation times the exaggeration, so sea
// level stays on the sphere and the plane, and coastlines stay on it too.
const reliefOn = () => state.relief > 0 && !!(world && world.elev);
const lift = (z) => (state.relief * z) / EARTH_R;

function placeGlobe(toScene) {
  const relief = reliefOn(), G = !relief ? GLOBE_GRID : state.wire ? WIRE_GRID : RELIEF_GRID;
  const pos = new Float32Array((G.nx + 1) * (G.ny + 1) * 3);
  let k = 0;
  for (let j = 0; j <= G.ny; j++) {
    const lat = 90 - (180 * j) / G.ny;
    for (let i = 0; i <= G.nx; i++, k += 3) {
      const lon = -180 + (360 * i) / G.nx;
      toScene(lon, lat, pos, k);
      if (relief) {
        const r = 1 + lift(sampleElev(world, lon, lat));
        pos[k] *= r; pos[k + 1] *= r; pos[k + 2] *= r;
      }
    }
  }
  globe.geometry.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(G.uv, 2));
  g.setIndex(G.index);
  if (relief) g.computeVertexNormals();
  else g.setAttribute("normal", new THREE.BufferAttribute(pos.slice(), 3));
  globe.geometry = g;
}

const planeMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ color: COLORS.plane, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false })
);
planeMesh.rotation.x = -Math.PI / 2;
scene.add(planeMesh);

// The plane with relief: a grid over the plane square, each node raised by
// the elevation of the place that projects there.
const PLANE_GRID = lonLatGrid(256, 256), PLANE_WIRE_GRID = lonLatGrid(128, 128);
const planeRelief = new THREE.Mesh(
  new THREE.BufferGeometry(),
  new THREE.MeshPhongMaterial({ color: 0xffffff, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide, shininess: 10 })
);
planeRelief.visible = false;
scene.add(planeRelief);

function placePlaneRelief(p) {
  const G = state.wire ? PLANE_WIRE_GRID : PLANE_GRID, w = state.w, n = G.nx;
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  for (let j = 0, k = 0; j <= n; j++) {
    const y = w - (2 * w * j) / n;
    for (let i = 0; i <= n; i++, k += 3) {
      const x = -w + (2 * w * i) / n;
      const ll = fam.inverse(x, y, p);
      pos[k] = x; pos[k + 1] = 1 + (ll ? lift(sampleElev(world, ll[0], ll[1])) : 0); pos[k + 2] = -y;
    }
  }
  planeRelief.geometry.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(G.uv, 2));
  g.setIndex(G.index);
  g.computeVertexNormals();
  planeRelief.geometry = g;
}

const lightMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.055, 24, 16),
  new THREE.MeshBasicMaterial({ color: COLORS.light })
);
const glow = new THREE.Mesh(
  new THREE.SphereGeometry(0.12, 24, 16),
  new THREE.MeshBasicMaterial({ color: COLORS.light, transparent: true, opacity: 0.25, depthWrite: false })
);
lightMarker.add(glow);
scene.add(lightMarker);

function label(text, cls = "") {
  const div = document.createElement("div");
  div.className = "label " + cls;
  div.textContent = text;
  return new CSS2DObject(div);
}
const lightLabel = label("light", "light");
lightLabel.position.set(0, 0.14, 0);
lightMarker.add(lightLabel);
const planeLabel = label("tangent plane", "plane");
scene.add(planeLabel);
const tangentLabel = label("tangent point", "tangent");
scene.add(tangentLabel);

// Named line layers, rebuilt from flat position arrays on every change.
const layers = {};
function setLines(name, positions, color, opacity = 1, extra = {}) {
  let obj = layers[name];
  if (!obj) {
    const Mat = extra.dashed ? THREE.LineDashedMaterial : THREE.LineBasicMaterial;
    obj = new THREE.LineSegments(new THREE.BufferGeometry(), new Mat({
      color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, ...(extra.dashed ? { dashSize: 0.06, gapSize: 0.05 } : {})
    }));
    obj.renderOrder = extra.order || 0;
    layers[name] = obj;
    scene.add(obj);
  }
  obj.geometry.dispose();
  obj.geometry = new THREE.BufferGeometry();
  obj.geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (extra.dashed) obj.computeLineDistances();
  return obj;
}

const dots = {};
function setPoints(name, positions, color, size) {
  let obj = dots[name];
  if (!obj) {
    obj = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color, size, sizeAttenuation: false }));
    dots[name] = obj;
    scene.add(obj);
  }
  obj.geometry.dispose();
  obj.geometry = new THREE.BufferGeometry();
  obj.geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
}

// ---------------------------------------------------------------- data

let coast = [];
const grat = graticule(15, 2);
let rayPool = [];

function buildRayPool() {
  const rand = mulberry32(state.seed);
  rayPool = [];
  const total = coast.reduce((s, l) => s + l.length / 2, 0);
  for (let k = 0; k < RAY_POOL; k++) {
    let idx = Math.floor(rand() * total);
    for (const line of coast) {
      const n = line.length / 2;
      if (idx < n) { rayPool.push([line[2 * idx], line[2 * idx + 1]]); break; }
      idx -= n;
    }
  }
}

// ---------------------------------------------------------------- rebuild

const inPlane = (xy) => xy && Math.abs(xy[0]) <= state.w && Math.abs(xy[1]) <= state.w;

function rebuild() {
  const p = params();
  const toScene = sceneFrame(p.lat0, p.lon0);
  const thr = fam.horizonCos(p.a);
  const A = [0, 0, 0], B = [0, 0, 0];
  placeGlobe(toScene);
  scheduleBasemap(p);

  // coastline on the sphere, bright where it reaches the plane
  const on = [], off = [], flat = [];
  for (const line of coast) {
    let prevXY = null, prevOk = false;
    for (let i = 0; i < line.length; i += 2) {
      toScene(line[i], line[i + 1], B);
      const ok = B[1] > thr + 1e-6;
      const xy = fam.project(line[i], line[i + 1], p);
      if (i > 0) {
        (ok && prevOk ? on : off).push(A[0], A[1], A[2], B[0], B[1], B[2]);
        if (inPlane(xy) && inPlane(prevXY)) flat.push(prevXY[0], 1, -prevXY[1], xy[0], 1, -xy[1]);
      }
      A[0] = B[0]; A[1] = B[1]; A[2] = B[2];
      prevOk = ok; prevXY = xy;
    }
  }
  setLines("coastOn", on, COLORS.coastOn, 0.95).visible = !!state.globe;
  setLines("coastOff", off, COLORS.coastOff, 0.55).visible = !!state.globe;
  setLines("planeCoast", flat, COLORS.planeCoast, 1, { order: 2 });

  // graticule on the sphere and the plane
  const gs = [], gp = [];
  for (const line of grat) {
    let prevXY = null;
    for (let i = 0; i < line.length; i += 2) {
      toScene(line[i], line[i + 1], B);
      const xy = fam.project(line[i], line[i + 1], p);
      if (i > 0) {
        gs.push(A[0], A[1], A[2], B[0], B[1], B[2]);
        if (inPlane(xy) && inPlane(prevXY)) gp.push(prevXY[0], 1, -prevXY[1], xy[0], 1, -xy[1]);
      }
      A[0] = B[0]; A[1] = B[1]; A[2] = B[2];
      prevXY = xy;
    }
  }
  setLines("gratSphere", gs, COLORS.grat, 0.5).visible = !!state.grat && !!state.globe;
  setLines("gratPlane", gp, COLORS.planeGrat, 0.6).visible = !!state.grat;

  // horizon: the circle on the sphere beyond which nothing reaches the plane
  const hz = [];
  if (thr > -1 + 1e-9) {
    const r = Math.sqrt(1 - thr * thr);
    for (let k = 0; k < 128; k++) {
      const t0 = (k / 128) * 2 * Math.PI, t1 = ((k + 1) / 128) * 2 * Math.PI;
      hz.push(r * Math.cos(t0), thr, r * Math.sin(t0), r * Math.cos(t1), thr, r * Math.sin(t1));
    }
  }
  // compass and string maps end where the antipode lands, a circle on the plane
  if (fam.edgeRadius) {
    const r = fam.edgeRadius(p);
    for (let k = 0; k < 128; k++) {
      const t0 = (k / 128) * 2 * Math.PI, t1 = ((k + 1) / 128) * 2 * Math.PI;
      hz.push(r * Math.cos(t0), 1.002, r * Math.sin(t0), r * Math.cos(t1), 1.002, r * Math.sin(t1));
    }
  }
  setLines("horizon", hz, COLORS.horizon, 0.9);

  // plane, axis and light
  const w = state.w;
  planeMesh.scale.set(2 * w, 2 * w, 1);
  planeMesh.position.set(0, 1, 0);
  const relief = reliefOn();
  planeRelief.visible = relief;
  planeMesh.visible = !relief;
  if (relief) placePlaneRelief(p);
  globe.material.wireframe = planeRelief.material.wireframe = relief && !!state.wire;
  // a raised globe has to hide its own far side, so it is drawn solid
  globe.material.depthWrite = relief;
  globe.material.opacity = relief ? 0.95 : world ? 0.7 : 0.28;
  setLines("planeEdge", [
    -w, 1, -w, w, 1, -w, w, 1, -w, w, 1, w, w, 1, w, -w, 1, w, -w, 1, w, -w, 1, -w
  ], 0x8899aa, 0.8);
  planeLabel.position.set(w * 0.98, 1.05, w * 0.98);
  tangentLabel.position.set(0, 1.02, 0);

  const lit = state.az === "light";
  const finite = lit && isFinite(p.a) && Math.abs(p.a) <= RAY_REACH;
  lightMarker.visible = lightLabel.visible = finite;
  if (finite) lightMarker.position.set(0, p.a, 0);
  const top = !lit ? 1.6 : Math.max(1.6, finite ? p.a : RAY_REACH);
  const bottom = !lit ? -1.4 : Math.min(-1.4, finite ? p.a : -RAY_REACH);
  setLines("axis", [0, bottom, 0, 0, top, 0], 0x667788, 0.7, { dashed: true });

  // rays: light -> sphere point -> plane point (or light -> plane -> sphere),
  // or the compass and string constructions, one per sampled point
  const rays = [], arcs = [], hitsS = [], hitsP = [];
  let n = 0;
  for (const [lon, lat] of rayPool) {
    if (n >= state.rays) break;
    const xy = fam.project(lon, lat, p);
    if (!inPlane(xy)) continue;
    toScene(lon, lat, B);
    const P = [xy[0], 1, -xy[1]];
    if (!lit) {
      construct(state.az, B, P, rays, arcs);
      hitsS.push(B[0], B[1], B[2]);
      hitsP.push(P[0], P[1], P[2]);
      n++;
      continue;
    }
    let start;
    if (finite) start = [0, p.a, 0];
    else {
      // walk back from the plane point to the edge of the scene
      const dir = isFinite(p.a) ? [P[0], P[1] - p.a, P[2]] : [0, p.a > 0 ? -1 : 1, 0];
      const yEdge = (p.a > 0 ? 1 : -1) * RAY_REACH;
      const t = (P[1] - yEdge) / dir[1];
      start = [P[0] - dir[0] * t, yEdge, P[2] - dir[2] * t];
    }
    const dS = Math.hypot(B[0] - start[0], B[1] - start[1], B[2] - start[2]);
    const dP = Math.hypot(P[0] - start[0], P[1] - start[1], P[2] - start[2]);
    const end = dS > dP ? B : P;
    rays.push(start[0], start[1], start[2], end[0], end[1], end[2]);
    hitsS.push(B[0], B[1], B[2]);
    hitsP.push(P[0], P[1], P[2]);
    n++;
  }
  setLines("rays", rays, COLORS.ray, 0.35, { order: 1 });
  setLines("arcs", arcs, state.az === "aeqd" ? COLORS.string : COLORS.compass, 0.55, { order: 1 });
  setPoints("hitsS", hitsS, 0xffffff, 3);
  setPoints("hitsP", hitsP, COLORS.planeCoast, 4);

  drawMap(p);
  updatePanel(p);
}

// Compass (laea): the straight chord from the tangent point T to the sphere
// point S, then the arc a compass centred on T would swing, at that radius,
// from S down to the plane point P. The chord is |TS| = 2 sin(c / 2) and the
// map distance is the same, so P is S swung onto the plane.
//
// String (aeqd): the great-circle arc from T to S on the sphere, of length c,
// and the same length laid flat on the plane from T to P.
const ARC_STEPS = 24;
function construct(mode, S, P, lines, arcs) {
  const T = [0, 1, 0];
  if (mode === "laea") {
    lines.push(T[0], T[1], T[2], S[0], S[1], S[2]);
    const u = [S[0] - T[0], S[1] - T[1], S[2] - T[2]], v = [P[0] - T[0], P[1] - T[1], P[2] - T[2]];
    slerpArc(T, u, v, arcs);
  } else {
    slerpArc([0, 0, 0], T, S, arcs);
    arcs.push(T[0], T[1], T[2], P[0], P[1], P[2]);
  }
}

// Arc about centre O from O + u to O + v (|u| = |v|), as line segments.
function slerpArc(O, u, v, out) {
  const r = Math.hypot(u[0], u[1], u[2]);
  if (r < 1e-9) return;
  const dot = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (r * Math.hypot(v[0], v[1], v[2]));
  const om = Math.acos(Math.max(-1, Math.min(1, dot)));
  const so = Math.sin(om);
  let prev = [O[0] + u[0], O[1] + u[1], O[2] + u[2]];
  for (let k = 1; k <= ARC_STEPS; k++) {
    const t = k / ARC_STEPS;
    const a = so < 1e-9 ? 1 - t : Math.sin((1 - t) * om) / so, b = so < 1e-9 ? t : Math.sin(t * om) / so;
    const q = [O[0] + a * u[0] + b * v[0], O[1] + a * u[1] + b * v[1], O[2] + a * u[2] + b * v[2]];
    out.push(prev[0], prev[1], prev[2], q[0], q[1], q[2]);
    prev = q;
  }
}

// ---------------------------------------------------------------- basemap

let world = null;          // the loaded source as a lon/lat RGBA image
let worldTexture = null;
// Fixed size, because a WebGL texture cannot change size once uploaded;
// coarse renders are drawn into it scaled up.
const PROJ_SIZE = 1024;
const projCanvas = document.createElement("canvas");
projCanvas.width = projCanvas.height = PROJ_SIZE;
const scratch = document.createElement("canvas");
const planeTexture = new THREE.CanvasTexture(projCanvas);
planeTexture.colorSpace = THREE.SRGBColorSpace;
let basemapTimer = 0;

function renderBasemap(p, size) {
  if (!world) return;
  const rgba = reproject(world, fam.inverse, p, state.w, size);
  const ctx = projCanvas.getContext("2d");
  if (size === PROJ_SIZE) ctx.putImageData(new ImageData(rgba, size, size), 0, 0);
  else {
    scratch.width = scratch.height = size;
    scratch.getContext("2d").putImageData(new ImageData(rgba, size, size), 0, 0);
    ctx.clearRect(0, 0, PROJ_SIZE, PROJ_SIZE);
    ctx.drawImage(scratch, 0, 0, PROJ_SIZE, PROJ_SIZE);
  }
  planeTexture.needsUpdate = true;
}

// A quick coarse image while things move, then a sharp one once they settle.
function scheduleBasemap(p) {
  if (!world) return;
  renderBasemap(p, 256);
  clearTimeout(basemapTimer);
  basemapTimer = setTimeout(() => { renderBasemap(params(), PROJ_SIZE); drawMap(params()); }, 250);
}

function applyBasemapMaterials() {
  const gm = globe.material, pm = planeMesh.material;
  if (world) {
    if (!worldTexture || worldTexture.image !== world.canvas) {
      worldTexture = new THREE.CanvasTexture(world.canvas);
      worldTexture.colorSpace = THREE.SRGBColorSpace;
    }
    gm.map = worldTexture; gm.color.set(0xffffff); gm.opacity = 0.7;
    pm.map = planeTexture; pm.color.set(0xffffff); pm.opacity = 0.85;
    planeRelief.material.map = planeTexture; planeRelief.material.needsUpdate = true;
  } else {
    gm.map = null; gm.color.set(COLORS.globe); gm.opacity = 0.28;
    pm.map = null; pm.color.set(COLORS.plane); pm.opacity = 0.07;
  }
  gm.needsUpdate = pm.needsUpdate = true;
}

async function setBasemap() {
  const id = state.bm;
  writeHash();
  ui.credit.innerHTML = sources[id].credit || "";
  if (id === "none") {
    world = null; ui.bmStatus.textContent = ""; applyBasemapMaterials(); sync();
    return;
  }
  try {
    const w = await loadWorld(id, (msg) => { if (state.bm === id) ui.bmStatus.textContent = msg; });
    if (state.bm !== id) return;
    world = w;
    ui.bmStatus.textContent = "";
  } catch (e) {
    if (state.bm !== id) return;
    world = null;
    ui.bmStatus.textContent = `${sources[id].label} did not load (${e.message}). Check the connection and try again.`;
  }
  applyBasemapMaterials();
  sync();
}

async function downloadTIF() {
  if (!world) return;
  const p = params(), n = +ui.tifSize.value, w = state.w, R = fam.R;
  const label = ui.tif.textContent;
  ui.tif.textContent = "Rendering...";
  ui.tif.disabled = true;
  try {
    const rgba = reproject(world, fam.inverse, p, w, n);
    const blob = await writeGeoTIFF({
      width: n, height: n, rgba,
      origin: [-w * R, w * R], pixelSize: [(2 * w * R) / n, (2 * w * R) / n],
      geoKeys: fam.geoKeys(p)
    });
    const kind = (fam.projString(p) || "+proj=perspective").split(" ")[0].slice(6);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `playproj-${kind}-lat${state.lat}-lon${state.lon}-${state.bm}-${n}.tif`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } finally {
    ui.tif.textContent = label;
    ui.tif.disabled = !world;
  }
}

// ---------------------------------------------------------------- 2D map

const mapCanvas = document.getElementById("map2d");
const badge = document.getElementById("badge");
let transformer = null, transformerFor = "";

function projector(p) {
  const s = fam.proj4String(p);
  if (!s || typeof proj4 === "undefined") return null;
  if (s !== transformerFor) {
    try {
      transformer = proj4(`+proj=longlat +R=${fam.R}`, s);
      transformerFor = s;
    } catch (e) {
      transformer = null; transformerFor = "";
    }
  }
  return transformer;
}

function drawMap(p) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = mapCanvas.clientWidth, ch = mapCanvas.clientHeight;
  if (!cw || !ch) return;
  if (mapCanvas.width !== Math.round(cw * dpr)) { mapCanvas.width = Math.round(cw * dpr); mapCanvas.height = Math.round(ch * dpr); }
  const ctx = mapCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#05070d";
  ctx.fillRect(0, 0, cw, ch);

  const w = state.w, s = (Math.min(cw, ch) / (2 * w)) * 0.94;
  const X = (x) => cw / 2 + x * s, Y = (y) => ch / 2 - y * s;
  const tr = projector(p);

  // PROJ (via proj4js) when there is a string; the ray construction otherwise
  let maxDiff = 0, compared = 0;
  const fwd = (lon, lat) => {
    const geo = fam.project(lon, lat, p);
    if (!tr) return geo;
    let q;
    try { q = tr.forward([lon, lat]); } catch (e) { return null; }
    if (!q || !isFinite(q[0]) || !isFinite(q[1])) return null;
    const xy = [q[0] / fam.R, q[1] / fam.R];
    if (geo && inPlane(geo)) {
      maxDiff = Math.max(maxDiff, Math.hypot(xy[0] - geo[0], xy[1] - geo[1]) * fam.R);
      compared++;
    }
    return geo ? xy : null; // proj4js happily returns points past the horizon; keep to the construction's domain
  };

  ctx.save();
  ctx.beginPath();
  ctx.rect(X(-w), Y(w), 2 * w * s, 2 * w * s);
  ctx.clip();

  const stroke = (lines, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath();
    for (const line of lines) {
      let prev = null;
      for (let i = 0; i < line.length; i += 2) {
        const xy = fwd(line[i], line[i + 1]);
        if (xy && prev && Math.hypot(xy[0] - prev[0], xy[1] - prev[1]) < w) {
          ctx.lineTo(X(xy[0]), Y(xy[1]));
        } else if (xy) ctx.moveTo(X(xy[0]), Y(xy[1]));
        prev = xy;
      }
    }
    ctx.stroke();
  };
  if (world) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(projCanvas, X(-w), Y(w), 2 * w * s, 2 * w * s);
  }
  if (state.grat) stroke(grat, "#3d6b52", 0.8);
  stroke(coast, "#6ab787", 1.1);

  // horizon circle
  const thr = fam.horizonCos(p.a);
  if (thr > -1 + 1e-9 || fam.edgeRadius) {
    const k = isFinite(p.a) ? (1 - p.a) / (thr - p.a) : 1;
    const rho = fam.edgeRadius ? fam.edgeRadius(p) : k * Math.sqrt(1 - thr * thr);
    if (isFinite(rho) && rho < 4 * w) {
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = "#ffb347"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(X(0), Y(0), rho * s, 0, 2 * Math.PI); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();

  ctx.strokeStyle = "#8899aa"; ctx.lineWidth = 1;
  ctx.strokeRect(X(-w), Y(w), 2 * w * s, 2 * w * s);
  ctx.strokeStyle = "#ffffff"; ctx.beginPath();
  ctx.moveTo(X(0) - 5, Y(0)); ctx.lineTo(X(0) + 5, Y(0)); ctx.moveTo(X(0), Y(0) - 5); ctx.lineTo(X(0), Y(0) + 5); ctx.stroke();
  ctx.fillStyle = "#8899aa"; ctx.font = "11px system-ui, sans-serif";
  ctx.fillText("x east", X(w) - 40, Y(0) - 6);
  ctx.fillText("y north", X(0) + 6, Y(w) + 14);

  if (!fam.projString(p)) {
    badge.className = "badge none";
    badge.textContent = "No PROJ equivalent: map drawn from the ray construction.";
  } else if (!tr) {
    badge.className = "badge none";
    badge.textContent = "proj4js unavailable: map drawn from the ray construction.";
  } else {
    badge.className = "badge ok";
    badge.textContent = `Drawn by proj4js. Agrees with the rays to ${maxDiff < 1e-6 ? "< 1e-6" : maxDiff.toExponential(1)} m over ${compared} points.`;
  }
}

// ---------------------------------------------------------------- panel

const $ = (id) => document.getElementById(id);
const ui = {
  v: $("v"), lat: $("lat"), lon: $("lon"), w: $("w"), rays: $("rays"),
  vOut: $("v-out"), latOut: $("lat-out"), lonOut: $("lon-out"), wOut: $("w-out"), raysOut: $("rays-out"),
  proj: $("projstring"), describe: $("describe"), presets: $("presets"), az: $("construction"), lightControls: $("light-controls"),
  grat: $("grat"), globe: $("globe"), detail: $("detail"),
  spin: $("spin"), relief: $("relief"), reliefOut: $("relief-out"), wire: $("wire"), bm: $("basemap"), bmStatus: $("bm-status"), credit: $("credit"), tifSize: $("tif-size"), tif: $("download-tif")
};

for (const [id, src] of Object.entries(sources)) {
  const o = document.createElement("option");
  o.value = id; o.textContent = src.label;
  ui.bm.appendChild(o);
}

for (const b of ui.az.children) {
  b.addEventListener("click", () => { stopSweep(); state.az = b.dataset.az; sync(); });
}

for (const pr of persp.presets) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = pr.label; b.dataset.v = pr.v;
  b.addEventListener("click", () => { stopSweep(); state.v = pr.v; sync(); });
  ui.presets.appendChild(b);
}

function lightText(a) {
  if (!isFinite(a)) return "infinitely far";
  if (Math.abs(a + 1) < 1e-9) return "-1 R (antipode)";
  if (a === 0) return "0 (centre)";
  return `${a.toFixed(2)} R`;
}

function updatePanel(p) {
  ui.v.value = state.v; ui.lat.value = state.lat; ui.lon.value = state.lon; ui.w.value = state.w; ui.rays.value = state.rays;
  ui.vOut.textContent = lightText(p.a);
  ui.latOut.textContent = state.lat + DEG;
  ui.lonOut.textContent = state.lon + DEG;
  ui.wOut.textContent = `${state.w} R`;
  ui.raysOut.textContent = state.rays;
  ui.grat.checked = !!state.grat; ui.globe.checked = !!state.globe; ui.detail.value = state.detail;
  ui.bm.value = state.bm;
  ui.spin.checked = !!state.spin;
  ui.relief.value = state.relief; ui.wire.checked = !!state.wire;
  const hasElev = !!(world && world.elev);
  ui.relief.disabled = ui.wire.disabled = !hasElev;
  ui.reliefOut.textContent = !hasElev ? "needs GEBCO" : state.relief ? `${state.relief}x` : "off";
  ui.tif.disabled = !world;
  const s = fam.projString(p);
  ui.proj.textContent = s || "(no PROJ equivalent)";
  ui.proj.classList.toggle("none", !s);
  ui.describe.textContent = fam.describe(p);
  for (const b of ui.presets.children) b.classList.toggle("active", +b.dataset.v === state.v);
  for (const b of ui.az.children) b.classList.toggle("active", b.dataset.az === state.az);
  ui.lightControls.hidden = state.az !== "light";
  sweepBtn.hidden = state.az !== "light";
}

let rafPending = false;
function sync() {
  writeHash();
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; rebuild(); });
}

ui.v.addEventListener("input", () => { stopSweep(); state.v = persp.snapSlider(+ui.v.value); sync(); });
ui.lat.addEventListener("input", () => { state.lat = +ui.lat.value; sync(); });
ui.lon.addEventListener("input", () => { state.lon = +ui.lon.value; sync(); });
ui.w.addEventListener("input", () => { state.w = +ui.w.value; sync(); });
ui.rays.addEventListener("input", () => { state.rays = +ui.rays.value; sync(); });
ui.grat.addEventListener("change", () => { state.grat = ui.grat.checked ? 1 : 0; sync(); });
ui.globe.addEventListener("change", () => { state.globe = ui.globe.checked ? 1 : 0; globe.visible = !!state.globe; sync(); });
ui.detail.addEventListener("change", async () => { state.detail = ui.detail.value; await loadData(); sync(); });
ui.bm.addEventListener("change", () => { state.bm = ui.bm.value; setBasemap(); });
ui.spin.addEventListener("change", () => { state.spin = ui.spin.checked ? 1 : 0; controls.autoRotate = !!state.spin; writeHash(); });
ui.tif.addEventListener("click", downloadTIF);
ui.relief.addEventListener("input", () => { state.relief = +ui.relief.value; sync(); });
ui.wire.addEventListener("change", () => { state.wire = ui.wire.checked ? 1 : 0; sync(); });
$("reseed").addEventListener("click", () => { state.seed = (state.seed % 9999) + 1; buildRayPool(); sync(); });
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(DEFAULT_CAM); writeHash(); });

// sweep the light from one end of the axis to the other
let sweeping = false, sweepDir = 1, lastT = 0;
const sweepBtn = $("sweep");
function stopSweep() { sweeping = false; sweepBtn.textContent = "Sweep light"; }
sweepBtn.addEventListener("click", () => {
  sweeping = !sweeping;
  sweepBtn.textContent = sweeping ? "Stop" : "Sweep light";
  lastT = performance.now();
});

function copy(text, btn) {
  const done = () => { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1200); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => prompt("Copy:", text));
  else prompt("Copy:", text);
}
const pageUrl = () => location.origin + location.pathname;
$("copy-link").addEventListener("click", (e) => copy(pageUrl() + location.hash, e.target));
$("copy-embed").addEventListener("click", (e) => copy(
  `<iframe src="${pageUrl()}?embed=1${location.hash}" width="100%" height="480" style="border:0" loading="lazy" title="Map projection playground"></iframe>`,
  e.target));
$("copy-proj").addEventListener("click", (e) => copy(ui.proj.textContent, e.target));
$("open-full").href = pageUrl() + location.hash;

// ---------------------------------------------------------------- loop

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h);
  labels.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  drawMap(params());
}
new ResizeObserver(resize).observe(stage);
new ResizeObserver(() => drawMap(params())).observe(mapCanvas);

function tick(t) {
  if (sweeping) {
    const dt = Math.min(0.1, (t - lastT) / 1000);
    let v = state.v + sweepDir * dt * 0.18;
    if (v >= 1) { v = 1; sweepDir = -1; }
    if (v <= -1) { v = -1; sweepDir = 1; }
    state.v = v;
    sync();
  }
  lastT = t;
  controls.update();
  renderer.render(scene, camera);
  labels.render(scene, camera);
  requestAnimationFrame(tick);
}

async function loadData() {
  coast = await loadCoastline(state.detail);
  buildRayPool();
}

window.addEventListener("hashchange", () => { readHash(); globe.visible = !!state.globe; controls.autoRotate = !!state.spin; if (state.cam) setCamera(state.cam); setBasemap(); loadData().then(sync); });

if (embed) {
  document.body.classList.add("embed");
  $("open-full").hidden = false;
}

readHash();
globe.visible = !!state.globe;
controls.autoRotate = !!state.spin;
controls.autoRotateSpeed = 0.8;
if (state.cam) setCamera(state.cam);
resize();
loadData().then(() => { rebuild(); document.body.classList.add("ready"); });
setBasemap();
requestAnimationFrame(tick);
