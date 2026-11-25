// playproj: navigation
//
// Ways round a 3D scene, tried on GEBCO's relief round Antarctica in polar
// stereographic (EPSG:3031): the sea floor, the land and the ice as one
// exaggerated surface under a see-through sea surface, a section hung down
// a meridian, and a line dropped to the floor where a click picks. The drag
// turns the view as a turntable about the map's upright, as an orbit about
// grid north (three.js's own), or as a free trackball; a double-click turns
// it about the place under the pointer, and Shift-double-click looks
// through the sea surface to what is under it. The geometry is in
// src/core/navigate.js, the gestures in src/scene/pivot.js and stage.js.

import * as THREE from "three";
import { TrackballControls } from "three/addons/controls/TrackballControls.js";
import * as N from "../src/core/navigate.js";
import { elevationTint } from "../src/core/basemap.js";
import { openHeld } from "../src/load/heldrefs.js";
import { readElevation, holdRanges } from "./basemap-load.js";
import { loadCoastline } from "./data.js";
import { makeStage, readParams, hashWriter, shareLinks, oneOf, addPivot, addClickPick, rayAt, nearestOnScreen, nearestHit } from "../src/scene/index.js";

const $ = (id) => document.getElementById(id);
const DEG = "°";
// scene units: one is 1,000 km on the map; heights are drawn times vx
const S = 1e-6, HALF = 4.5e6;
// GEBCO's ranges are held as the store page holds them, in the same table
holdRanges(openHeld({ name: "playproj-held", limit: 1024 * 2 ** 20 }).catch(() => null));

// ---------------------------------------------------------------- state

const ORBITS = {
  turntable: "a turntable about the map's upright: sideways goes round it, up tips the map over its edge and on under it",
  north: "an orbit about grid north (+y, towards 0 E), three.js's own: up and down stop edge-on, at the map's top and bottom",
  trackball: "a trackball: the view turns any way the drag goes, and the horizon rolls with it"
};
const defaults = { orbit: "turntable", zc: 1, sea: 1, cut: 1, sec: 140, vx: 50, n: 512, pick: "", cam: null };
const state = { ...defaults };
const lonLat = (raw) => {
  const v = String(raw).split(",").map(Number);
  return v.length === 2 && v.every(isFinite) && v[1] >= -90 && v[1] <= 90 ? `${+v[0].toFixed(4)},${+v[1].toFixed(4)}` : undefined;
};
function readHash() {
  readParams(state, defaults, { orbit: oneOf(Object.keys(ORBITS), "turntable"), pick: lonLat });
  state.vx = Math.max(1, Math.min(200, state.vx));
  state.n = Math.max(128, Math.min(1024, 64 * Math.round(state.n / 64)));
  state.sec = ((((state.sec + 180) % 360) + 360) % 360) - 180;
}
const writeHash = hashWriter(state, defaults, { digits: 3, camDigits: 3 });

// ---------------------------------------------------------------- stage

let tb = null;
const stage = makeStage($("three"), {
  bg: 0x05070d, fov: 38, near: 0.002, far: 100,
  onCamera: (c) => { state.cam = c; writeHash(); },
  onResize: () => { if (tb) tb.handleResize(); }
});
const { scene, camera, controls, renderer } = stage;
const UPRIGHT = [0, 0, 1], NORTH = [0, 1, 0];
// straight down the upright the way the map faces is only in the camera's
// small offset to one side, which the link rounds: so never quite straight
// down (a degree)
stage.controlsFor(UPRIGHT).minPolarAngle = 0.02;
tb = new TrackballControls(camera, renderer.domElement);
tb.enabled = false;
tb.target = controls.target;
tb.rotateSpeed = 3;
tb.dynamicDampingFactor = 0.15;
for (const type of ["start", "change", "end"]) tb.addEventListener(type, () => controls.dispatchEvent({ type }));
const DEFAULT_CAM = [0, -7.2, 7.6, 0, -0.3, 0];

function setOrbit() {
  const o = state.orbit;
  controls.zoomToCursor = !!state.zc;
  if (o === "trackball") {
    stage.turnAbout(null);
    tb.enabled = true;
    return;
  }
  tb.enabled = false;
  camera.up.fromArray(o === "turntable" ? UPRIGHT : NORTH);
  stage.turnAbout(o === "turntable" ? UPRIGHT : NORTH);
}

scene.add(new THREE.HemisphereLight(0xe8eef8, 0x202a3c, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-1, 1.3, 1.8);
scene.add(sun);

// the relief, lit from above; seen from beneath it is a dark veil, so what
// hangs in the water above it still shows through
const relief = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }));
const underside = new THREE.Mesh(relief.geometry,
  new THREE.MeshBasicMaterial({ vertexColors: true, color: 0x55657a, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.BackSide }));
underside.renderOrder = 3;
scene.add(relief, underside);
// the sea surface, see-through, with the coast and graticule draped on the
// surface (the sea's, or the land's where that is higher)
const sea = new THREE.Mesh(new THREE.PlaneGeometry(2 * HALF * S, 2 * HALF * S),
  new THREE.MeshBasicMaterial({ color: 0x5b9bd5, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
sea.renderOrder = 2;
scene.add(sea);
const coastLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xf1f4f8, transparent: true, opacity: 0.8 }));
const gratLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x8fa3bd, transparent: true, opacity: 0.45 }));
scene.add(coastLines, gratLines);
// the section: the water column down a meridian, light at the top, dark at the floor
const curtain = new THREE.Mesh(new THREE.BufferGeometry(),
  new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }));
curtain.renderOrder = 1;
const curtainEdge = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd166 }));
scene.add(curtain, curtainEdge);
// the picked place: a line from the surface to the floor, a bead at each end
const drop = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff6b5a }));
const beads = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xff6b5a, size: 9, sizeAttenuation: false }));
scene.add(drop, beads);

// ---------------------------------------------------------------- the relief

const status = (s) => { $("status").textContent = s; };
let world = null, job = 0, coast = null;
const tris = new Map();

// GEBCO south of the square's corners in two halves of the world, each at
// about a third of a mesh cell (not finer than 4 arc minutes: two windows
// of 2,700 x 840 cells)
async function readGebco(n) {
  const cellDeg = (2 * HALF) / n / 111e3, res = Math.max(1 / 15, cellDeg / 3), box = N.squareBox(HALF);
  const wins = [];
  for (const [west, east] of [[-180, 0], [0, 180]]) wins.push(await readElevation({ ...box, west, east }, res, status));
  return wins;
}

const ICE = [[0, 188, 205, 222], [1500, 226, 234, 243], [4000, 250, 252, 255]];
function iceTint(z) {
  let i = 1;
  while (i < ICE.length - 1 && z > ICE[i][0]) i++;
  const [z0, ...a] = ICE[i - 1], [z1, ...b] = ICE[i], t = Math.max(0, Math.min(1, (z - z0) / (z1 - z0)));
  return a.map((v, k) => v + t * (b[k] - v));
}

async function build() {
  const my = ++job;
  status("Reading GEBCO 2026...");
  let wins;
  try { wins = await readGebco(state.n); } catch (e) {
    if (my === job) status(`GEBCO 2026 not read: ${e.message}`);
    return;
  }
  if (my !== job) return;
  const grid = N.lattice(state.n, HALF), ll = N.latticeLonLat(grid), sample = N.stripSampler(wins);
  const M = grid.xy.length / 2, z = new Float32Array(M), col = new Float32Array(M * 3);
  for (let k = 0; k < M; k++) {
    const lat = ll[2 * k + 1], h = sample(ll[2 * k], lat);
    z[k] = h;
    const c = h > 0 && lat < -60 ? iceTint(h) : elevationTint(h);
    col[3 * k] = c[0] / 255; col[3 * k + 1] = c[1] / 255; col[3 * k + 2] = c[2] / 255;
  }
  let lo = Infinity, hi = -Infinity;
  for (const h of z) { if (h < lo) lo = h; if (h > hi) hi = h; }
  world = { grid, z, col, sample, wins, lo, hi };
  status("");
  drawRelief();
  drawLines(); drawCurtain(); drawDrop(); readout();
}

// heights in scene units
const up = (h) => h * state.vx * S;

function drawRelief() {
  const { grid, z, col } = world, M = z.length, pos = new Float32Array(M * 3);
  for (let k = 0; k < M; k++) { pos[3 * k] = grid.xy[2 * k] * S; pos[3 * k + 1] = grid.xy[2 * k + 1] * S; pos[3 * k + 2] = up(z[k]); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  if (!tris.has(grid.n)) tris.set(grid.n, new THREE.BufferAttribute(N.latticeTriangles(grid.n), 1));
  g.setIndex(tris.get(grid.n));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  relief.geometry.dispose();
  relief.geometry = underside.geometry = g;
}

// a lon/lat polyline as segments on the surface, cut where it leaves the
// square or jumps
function drapeLine(pts, out) {
  let prev = null;
  for (let i = 0; i < pts.length; i += 2) {
    const [x, y] = N.PS.forward(pts[i], pts[i + 1]);
    const inside = Math.abs(x) <= HALF && Math.abs(y) <= HALF;
    const p = inside ? [x * S, y * S, up(Math.max(0, world.sample(pts[i], pts[i + 1]))) + 0.002] : null;
    if (p && prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < 0.3) out.push(...prev, ...p);
    prev = p;
  }
}
function drawLines() {
  if (!world) return;
  const cl = [], gl = [];
  if (coast) {
    for (const l of coast.world) if (l.some((v, i) => i % 2 === 1 && v < -30)) drapeLine(l, cl);
    for (const ring of coast.south) drapeLine([...ring, ring[0], ring[1]], cl);
  }
  for (let lat = -80; lat <= -40; lat += 10) {
    const l = [];
    for (let lon = -180; lon <= 180; lon += 1) l.push(lon, lat);
    drapeLine(l, gl);
  }
  for (let lon = -180; lon < 180; lon += 30) {
    const l = [];
    for (let lat = -89; lat <= -30; lat += 0.5) l.push(lon, lat);
    drapeLine(l, gl);
  }
  for (const [L, a] of [[coastLines, cl], [gratLines, gl]]) {
    L.geometry.dispose();
    L.geometry = new THREE.BufferGeometry();
    L.geometry.setAttribute("position", new THREE.Float32BufferAttribute(a, 3));
  }
  coastLines.visible = gratLines.visible = sea.visible = !!state.sea;
}

function drawCurtain() {
  curtain.visible = curtainEdge.visible = !!(world && state.cut);
  if (!curtain.visible) return;
  const pts = N.meridianPoints(state.sec, HALF, (2 * HALF) / state.n / 2);
  const pos = [], colr = [], idx = [], edge = [];
  const TOP = new THREE.Color(0x9fd3f0), BOT = new THREE.Color(0x0d3b66);
  let prev = -1;
  pts.forEach((p, k) => {
    const h = world.sample(p.lon, p.lat);
    if (h >= 0) { prev = -1; return; }
    const v = pos.length / 3, x = p.x * S, y = p.y * S, zf = up(h);
    pos.push(x, y, 0, x, y, zf);
    colr.push(TOP.r, TOP.g, TOP.b, BOT.r, BOT.g, BOT.b);
    if (prev >= 0) {
      idx.push(prev, prev + 1, v, v, prev + 1, v + 1);
      edge.push(...pos.slice(3 * prev, 3 * prev + 3), x, y, 0, ...pos.slice(3 * prev + 3, 3 * prev + 6), x, y, zf);
    }
    prev = v;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colr, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  curtain.geometry.dispose();
  curtain.geometry = g;
  curtainEdge.geometry.dispose();
  curtainEdge.geometry = new THREE.BufferGeometry();
  curtainEdge.geometry.setAttribute("position", new THREE.Float32BufferAttribute(edge, 3));
}

function picked() {
  if (!state.pick || !world) return null;
  const [lon, lat] = state.pick.split(",").map(Number), [x, y] = N.PS.forward(lon, lat);
  if (Math.abs(x) > HALF || Math.abs(y) > HALF) return null;
  return { lon, lat, x, y, h: world.sample(lon, lat) };
}
function drawDrop() {
  const p = picked();
  drop.visible = beads.visible = !!p;
  if (!p) return;
  const x = p.x * S, y = p.y * S;
  // in the sea, from the surface to the floor; on land, a pin up from the ground
  const a = p.h < 0 ? [x, y, 0] : [x, y, up(p.h) + 0.25], b = [x, y, up(p.h)];
  for (const [M, arr] of [[drop, [...a, ...b]], [beads, [...a, ...b]]]) {
    M.geometry.dispose();
    M.geometry = new THREE.BufferGeometry();
    M.geometry.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
  }
}

// ---------------------------------------------------------------- pointer

const ray = new THREE.Raycaster();
const SEA_PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const inSquare = (p) => Math.abs(p.x) <= HALF * S && Math.abs(p.y) <= HALF * S;
function hitOf(M) {
  if (!M.visible || !M.geometry.attributes.position) return null;
  const h = ray.intersectObject(M)[0];
  return h ? [h.point, h.distance] : null;
}
// the relief's nearest hit from above (a face looking at the camera) and
// from beneath, in one pass over its triangles
function reliefHits() {
  const out = { top: null, under: null };
  if (!relief.geometry.attributes.position) return out;
  relief.material.side = THREE.DoubleSide;
  const hits = ray.intersectObject(relief);
  relief.material.side = THREE.FrontSide;
  for (const h of hits) {
    const k = h.face.normal.dot(ray.ray.direction) < 0 ? "top" : "under";
    if (!out[k]) out[k] = [h.point, h.distance];
  }
  return out;
}
// A double-click turns about the nearest thing under the pointer: the sea
// surface, the relief (from above or beneath), the section or the picked
// line. With Shift the surfaces that cover the water are not in the way,
// the sea surface from above and the floor's underside from beneath: the
// view turns about what is in or under the water.
function pivotAt(px, py, through) {
  if (!world) return null;
  rayAt(stage, px, py, ray);
  const r = reliefHits();
  const below = [r.top, hitOf(curtain), nearestOnScreen(stage, drop, px, py, { lines: true }), nearestOnScreen(stage, beads, px, py)];
  const surface = [r.under];
  const h = new THREE.Vector3();
  if (sea.visible && ray.ray.intersectPlane(SEA_PLANE, h) && inSquare(h)) surface.push([h, h.distanceTo(camera.position)]);
  const got = (through && nearestHit(below)) || nearestHit([...surface, ...below]);
  return got ? got[0] : null;
}
const pivot = addPivot(stage, { pivotAt, onCamera: (c) => { state.cam = c; writeHash(); } });
// a click drops a line to the floor at the place on the relief under it
addClickPick(stage, (px, py) => {
  if (!world) return null;
  rayAt(stage, px, py, ray);
  const r = reliefHits(), h = nearestHit([r.top, r.under]);
  if (!h) return null;
  const [lon, lat] = N.PS.inverse(h[0].x / S, h[0].y / S);
  return () => { state.pick = lonLat(`${lon},${lat}`); drawDrop(); readout(); writeHash(); };
});

// ---------------------------------------------------------------- readout

const fmtLL = (lon, lat) => `${Math.abs(lat).toFixed(2)}${DEG}${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(2)}${DEG}${Math.abs(lon) > 179.995 || lon === 0 ? "" : lon < 0 ? "W" : "E"}`;
const fmtKm = (m) => (Math.abs(m) >= 1e4 ? `${Math.round(m / 1000).toLocaleString()} km` : `${Math.round(m).toLocaleString()} m`);
const fmtH = (h) => (Math.abs(h) < 0.5 ? "sea level" : h < 0 ? `${Math.round(-h).toLocaleString()} m deep` : `${Math.round(h).toLocaleString()} m up`);

function view() {
  const c = camera.position, t = controls.target;
  const a = N.viewAngles([c.x, c.y, c.z], [t.x, t.y, t.z]);
  const [lon, lat] = N.PS.inverse(t.x / S, t.y / S);
  return { ...a, lon, lat, h: t.z / (state.vx * S), dist: c.distanceTo(t) / S };
}
function tiltWords(t) {
  return t < 2 ? "straight down" : t > 178 ? "straight up" : t < 88 ? "down" : t > 92 ? "up, from below" : "level";
}
function hud() {
  const v = view();
  const head = v.heading === null ? "" : ` · heading ${Math.round(v.heading)}${DEG} ${N.compass(v.heading)}${v.grid ? " (grid)" : ""}`;
  $("hud").textContent = `tilt ${Math.round(v.tilt)}${DEG} (${tiltWords(v.tilt)})${head} · ${fmtKm(v.dist)} from the pivot${v.below ? " · under the sea surface" : ""}`;
}
function readout() {
  const v = view(), p = picked();
  const rows = [
    ["Drag", ORBITS[state.orbit]],
    ["Turning about", `${fmtLL(v.lon, v.lat)}, ${fmtH(v.h)}`],
    ["Looking", `${Math.round(v.tilt)}${DEG} from straight down (${tiltWords(v.tilt)})${v.heading === null ? "" : `, heading ${Math.round(v.heading)}${DEG} ${N.compass(v.heading)}${v.grid ? " from grid north" : " true"}`}`],
    ["Camera", `${fmtKm(v.dist)} from the pivot at the map's scale, ${v.below ? "under" : "above"} the sea surface`],
    p && ["Picked", `${fmtLL(p.lon, p.lat)}: GEBCO ${p.h < 0 ? `${Math.round(-p.h).toLocaleString()} m deep` : `${Math.round(p.h).toLocaleString()} m up`}`],
    world && ["Relief", `${state.n} x ${state.n} cells of ${fmtKm((2 * HALF) / state.n)}, ${Math.round(world.lo).toLocaleString()} to ${Math.round(world.hi).toLocaleString()} m, drawn x ${state.vx}; GEBCO read at ${Math.round(world.wins[0].dx * 60)} arc minutes`]
  ];
  $("out").innerHTML = rows.filter(Boolean).map(([k, val]) => `<tr><th>${k}</th><td>${val}</td></tr>`).join("");
}
// the readout and the overlay follow the camera, a few times a second
let lastCam = "", lastAt = 0;
function follow(now) {
  if (now - lastAt < 120) return;
  lastAt = now;
  const k = [...camera.position.toArray(), ...controls.target.toArray()].map((x) => x.toFixed(4)).join();
  if (k === lastCam) return;
  lastCam = k;
  hud(); readout();
}

// ---------------------------------------------------------------- controls

function syncControls() {
  $("orbit").value = state.orbit;
  $("zc").checked = !!state.zc; $("sea").checked = !!state.sea; $("cut").checked = !!state.cut;
  $("sec").value = state.sec; $("sec").disabled = !state.cut;
  $("vx").value = Math.log10(state.vx); $("vx-out").textContent = `x ${state.vx}`;
  $("n").value = state.n; $("n-out").textContent = state.n;
}
$("orbit").addEventListener("change", (e) => { state.orbit = e.target.value; setOrbit(); readout(); writeHash(); });
$("zc").addEventListener("change", (e) => { state.zc = e.target.checked ? 1 : 0; setOrbit(); writeHash(); });
$("sea").addEventListener("change", (e) => { state.sea = e.target.checked ? 1 : 0; drawLines(); writeHash(); });
$("cut").addEventListener("change", (e) => { state.cut = e.target.checked ? 1 : 0; syncControls(); drawCurtain(); writeHash(); });
$("sec").addEventListener("change", (e) => {
  const v = +e.target.value;
  if (isFinite(v)) state.sec = ((((v + 180) % 360) + 360) % 360) - 180;
  syncControls(); drawCurtain(); writeHash();
});
// the exaggeration keeps the pivot on the same thing: its height scales too
$("vx").addEventListener("input", (e) => {
  const before = state.vx;
  state.vx = Math.round(10 ** +e.target.value);
  $("vx-out").textContent = `x ${state.vx}`;
  if (!world || state.vx === before) return;
  const k = state.vx / before;
  camera.position.z += controls.target.z * (k - 1);
  controls.target.z *= k;
  drawRelief(); drawLines(); drawCurtain(); drawDrop(); readout(); writeHash();
});
$("n").addEventListener("input", (e) => { $("n-out").textContent = e.target.value; });
$("n").addEventListener("change", (e) => { state.n = +e.target.value; writeHash(); build(); });
const distNow = () => camera.position.distanceTo(controls.target);
$("reset-view").addEventListener("click", () => { state.cam = null; stage.setCamera(DEFAULT_CAM); writeHash(); });
$("down").addEventListener("click", () => {
  const t = controls.target, d = distNow();
  stage.setCamera([t.x, t.y - 0.001 * d, t.z + d, t.x, t.y, t.z]);
  state.cam = stage.getCamera(); writeHash();
});
$("below").addEventListener("click", () => {
  const t = controls.target, d = distNow();
  stage.setCamera([t.x, t.y - 0.35 * d, t.z - 0.94 * d, t.x, t.y, t.z]);
  state.cam = stage.getCamera(); writeHash();
});

// ---------------------------------------------------------------- go

readHash();
syncControls();
setOrbit();
stage.setCamera(state.cam || DEFAULT_CAM);
stage.resize();
shareLinks("Navigation", { height: 560 });
window.addEventListener("hashchange", () => {
  const n = state.n;
  readHash(); syncControls(); setOrbit();
  stage.setCamera(state.cam || DEFAULT_CAM);
  if (state.n !== n || !world) build();
  else { drawRelief(); drawLines(); drawCurtain(); drawDrop(); readout(); }
});
Promise.all([
  loadCoastline("50m"),
  fetch(new URL("../data/coast-south-10m.json", import.meta.url)).then((r) => r.json())
]).then(([c, s]) => {
  const ring = (a) => Array.from(a);
  coast = { world: c, south: [ring(s.grounding), ring(s.front)] };
  drawLines();
}).catch(() => {});
renderer.setAnimationLoop((now) => {
  pivot.step(now);
  controls.update();
  if (state.orbit === "trackball") tb.update();
  follow(now);
  renderer.render(scene, camera);
});
build();
