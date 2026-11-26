// playproj: navigation
//
// Ways round a 3D scene, tried on GEBCO's relief round Antarctica in polar
// stereographic (EPSG:3031): the sea floor, the land and the ice as one
// exaggerated surface under a see-through sea surface, a section hung down
// a meridian, and a line dropped to the floor where a click picks; or on a
// teapot, three linked rings, a globe or a penguin (navigate-scenes.js).
// The drag turns the view as a turntable about the scene's upright, as an
// orbit about +y (three.js's own up; grid north on the map), or as a free
// trackball; a double-click turns it about the place under the pointer,
// and Shift-double-click looks through the sea surface to what is under
// it (on the map) or turns about the middle of the thing double-clicked.
// Any scene draws solid, as a wire mesh, or both. The geometry is in
// src/core/navigate.js, the gestures in src/scene/pivot.js and stage.js.

import * as THREE from "three";
import { TrackballControls } from "three/addons/controls/TrackballControls.js";
import * as N from "../src/core/navigate.js";
import * as SC from "./navigate-scenes.js";
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

// The scenes, and what the turntable's upright and three.js's +y are in
// each: all stand on z, so the drags do the same thing everywhere and only
// what they turn differs.
const SCENES = {
  relief: {
    label: "Antarctic relief (GEBCO 2026)", up: "the map's upright", yShort: "grid north",
    turn: "sideways goes round it, up tips the map over its edge and on under it",
    y: "on this map grid north (towards 0° E), so up and down stop edge-on, at the map's top and bottom",
    shift: "looks through the sea surface and turns about what is under it: the floor, the section, the dropped line. A click drops a line from the surface to the floor there",
    task: "Get under the section and look up at it: Shift-double-click it, then drag up. The orbit stops level; the turntable and trackball go on under."
  },
  teapot: {
    label: "Teapot on a pedestal", up: "the teapot's upright", yShort: "front to back here",
    turn: "sideways goes round it, up looks down into it, down looks up under it, and it stays upright on the screen",
    y: "here it runs from the front of the teapot to the back, as it does for a model made with z up and opened with y up, so a sideways drag spins the teapot on the screen like a clock hand",
    shift: "turns about the middle of the thing, half way through it along the line of sight",
    task: "Go right round the teapot, then look up under its spout. The turntable keeps it upright all the way; the trackball soon has it leaning; the orbit about +y spins it like a clock hand."
  },
  rings: {
    label: "Three linked rings", up: "the red ring's axis (z)", yShort: "the green ring's axis",
    turn: "sideways goes round it, and straight through the red ring is its pole",
    y: "the green ring's axis, so straight through the green ring is its pole",
    shift: "turns about the middle of the ring's tube",
    task: "Look straight through each ring in turn: its axis shrinks to a dot and its angle above to 0°. Every fixed axis has a pole, straight through one of the rings (red for the turntable, green for the orbit), and lining up on it is awkward; the trackball has none."
  },
  globe: {
    label: "Globe", up: "the earth's axis", yShort: "through the equator at 90° E",
    turn: "as a desk globe turns: sideways spins the globe, up and down tip a pole towards you, and north stays up the screen",
    y: "an axis through the equator at 90° E and 90° W, so a drag can go over the poles, and leaves north on its side",
    shift: "turns about the point half way through the globe along the line of sight",
    task: "Look straight down on the North Pole, then come down over Antarctica. The turntable keeps north up but stops a degree short of each pole; the trackball goes straight over, and north wanders (the readout says how far); the orbit about +y goes over both poles and lays north on its side."
  },
  penguin: {
    label: "Penguin (from the Penguin datum page)", up: "the penguin's upright", yShort: "belly to back here",
    turn: "sideways goes round it, up looks down on it, down looks up from under the floe",
    y: "here it runs from the penguin's belly to its back, so the penguin leans as soon as the view is off to one side of it, and a sideways drag spins it on the screen like a clock hand",
    shift: "turns about the middle of the thing, half way through it along the line of sight",
    task: "Look up under the beak, into the inside of a flipper, and down on the tops of the feet: the places no ray from the penguin's centre leaves it last, so no penguin longitude and latitude reaches them (see the Penguin datum page). Double-click a flipper to turn about it."
  }
};
const DRAWS = ["solid", "wire", "both"];
const defaults = { scene: "relief", draw: "solid", orbit: "turntable", zc: 1, sea: 1, cut: 1, sec: 140, vx: 50, n: 512, pick: "", cam: null };
const state = { ...defaults };
const lonLat = (raw) => {
  const v = String(raw).split(",").map(Number);
  return v.length === 2 && v.every(isFinite) && v[1] >= -90 && v[1] <= 90 ? `${+v[0].toFixed(4)},${+v[1].toFixed(4)}` : undefined;
};
function readHash() {
  readParams(state, defaults, {
    scene: oneOf(Object.keys(SCENES), "relief"), draw: oneOf(DRAWS, "solid"),
    orbit: oneOf(["turntable", "north", "trackball"], "turntable"), pick: lonLat
  });
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
// straight down (or up) the upright the way the map faces is only in the
// camera's small offset to one side, which the link rounds: so never quite
// straight down or up (a degree)
const turntable = stage.controlsFor(UPRIGHT);
turntable.minPolarAngle = 0.02;
turntable.maxPolarAngle = Math.PI - 0.02;
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
    // (it starts level, whatever roll the orbit about +y left)
    camera.up.fromArray(UPRIGHT);
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
// off the map, a light from the camera too, so what is looked at is lit
// from wherever it is looked at, below included
const headlight = new THREE.DirectionalLight(0xffffff, 0);
scene.add(headlight, headlight.target);

// the relief, lit from above; seen from beneath it is a dark veil, so what
// hangs in the water above it still shows through
const reliefGroup = new THREE.Group();
scene.add(reliefGroup);
const relief = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }));
const underside = new THREE.Mesh(relief.geometry,
  new THREE.MeshBasicMaterial({ vertexColors: true, color: 0x55657a, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.BackSide }));
underside.renderOrder = 3;
// the relief as a wire mesh: its cells' edges, in its own colours, or dark
// over the solid
const WIRE_LIT = new THREE.LineBasicMaterial({ vertexColors: true });
const WIRE_DARK = new THREE.LineBasicMaterial({ color: 0x0b1220, transparent: true, opacity: 0.3 });
const reliefWire = new THREE.LineSegments(new THREE.BufferGeometry(), WIRE_LIT);
reliefGroup.add(relief, underside, reliefWire);
// the sea surface, see-through, with the coast and graticule draped on the
// surface (the sea's, or the land's where that is higher)
const sea = new THREE.Mesh(new THREE.PlaneGeometry(2 * HALF * S, 2 * HALF * S),
  new THREE.MeshBasicMaterial({ color: 0x5b9bd5, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
sea.renderOrder = 2;
reliefGroup.add(sea);
const coastLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xf1f4f8, transparent: true, opacity: 0.8 }));
const gratLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x8fa3bd, transparent: true, opacity: 0.45 }));
reliefGroup.add(coastLines, gratLines);
// the section: the water column down a meridian, light at the top, dark at the floor
const curtain = new THREE.Mesh(new THREE.BufferGeometry(),
  new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }));
curtain.renderOrder = 1;
const curtainEdge = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd166 }));
reliefGroup.add(curtain, curtainEdge);
// the picked place: a line from the surface to the floor, a bead at each end
const drop = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff6b5a }));
const beads = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xff6b5a, size: 9, sizeAttenuation: false }));
reliefGroup.add(drop, beads);

// the other scenes, made the first time they are shown
const shapes = {};
const BUILD = { teapot: SC.teapotScene, rings: SC.ringsScene, globe: SC.globeScene, penguin: SC.penguinScene };
function shape() {
  const k = state.scene;
  if (k === "relief") return null;
  if (!shapes[k]) {
    shapes[k] = BUILD[k]();
    if (k === "globe" && coast) shapes[k].setCoast(coast.world, coast.south);
    scene.add(shapes[k].group);
    SC.drawAs(shapes[k].meshes, state.draw);
  }
  return shapes[k];
}
const sceneCam = () => (state.scene === "relief" ? DEFAULT_CAM : shape().cam);

// ---------------------------------------------------------------- the relief

// (the relief's progress shows only while the relief is the scene)
let said = "";
const status = (s) => { said = s; if (state.scene === "relief") $("status").textContent = s; };
let world = null, job = 0, coast = null, started = false;
const tris = new Map(), wires = new Map();

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
  started = true;
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
  if (!wires.has(grid.n)) wires.set(grid.n, new THREE.BufferAttribute(N.latticeLines(grid.n), 1));
  const w = new THREE.BufferGeometry();
  w.setAttribute("position", g.attributes.position);
  w.setAttribute("color", g.attributes.color);
  w.setIndex(wires.get(grid.n));
  w.boundingSphere = g.boundingSphere;
  reliefWire.geometry.dispose();
  reliefWire.geometry = w;
}

// Solid, wire mesh, or both: on the relief its cells' edges, on the other
// scenes their triangles' (navigate-scenes.js). The solid is still there
// to pick when only the wire is drawn.
function applyDraw() {
  const d = state.draw;
  relief.material.visible = underside.visible = d !== "wire";
  relief.material.polygonOffset = d === "both";
  relief.material.polygonOffsetFactor = relief.material.polygonOffsetUnits = 1;
  relief.material.needsUpdate = true;
  reliefWire.visible = d !== "solid";
  reliefWire.material = d === "wire" ? WIRE_LIT : WIRE_DARK;
  for (const s of Object.values(shapes)) SC.drawAs(s.meshes, d);
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
  const s = shape();
  if (s) return shapePivot(s, px, py, through);
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
// In the other scenes a double-click turns about the nearest place on a
// thing under the pointer, and with Shift about the middle of that thing
// along the line of sight: half way from where the line goes in to where
// it next comes out.
function shapePivot(s, px, py, through) {
  rayAt(stage, px, py, ray);
  const sides = s.meshes.map((m) => m.material.side);
  for (const m of s.meshes) m.material.side = THREE.DoubleSide;
  const hits = ray.intersectObjects(s.meshes, false);
  s.meshes.forEach((m, i) => { m.material.side = sides[i]; });
  if (!hits.length) return null;
  const a = hits[0];
  if (!through) return a.point;
  const b = hits.find((h) => h.object === a.object && h.distance > a.distance + 1e-6);
  return b ? a.point.clone().lerp(b.point, 0.5) : a.point;
}
const pivot = addPivot(stage, { pivotAt, onCamera: (c) => { state.cam = c; writeHash(); } });
// a click drops a line to the floor at the place on the relief under it
addClickPick(stage, (px, py) => {
  if (state.scene !== "relief" || !world) return null;
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
function dragWords() {
  const m = SCENES[state.scene];
  if (state.orbit === "turntable") return `a turntable about ${m.up}: ${m.turn}`;
  if (state.orbit === "north") return `an orbit about +y, three.js's own up: ${m.y}`;
  return "a trackball: the view turns any way the drag goes, and the horizon rolls with it";
}
// the screen's right and up as world directions
const _r = new THREE.Vector3(), _u = new THREE.Vector3();
function screenAxes() {
  return [_r.set(1, 0, 0).applyQuaternion(camera.quaternion).toArray(), _u.set(0, 1, 0).applyQuaternion(camera.quaternion).toArray()];
}
const fmtBearing = (b) => (b === null ? "along the line of sight" : Math.abs(b) < 1 ? "straight up the screen"
  : `${Math.round(Math.abs(b))}${DEG} ${b > 0 ? "clockwise" : "anticlockwise"} from straight up the screen`);
const shortBearing = (b) => (b === null ? "end on" : Math.abs(b) < 1 ? "up" : `${Math.round(Math.abs(b))}${DEG} ${b > 0 ? "right" : "left"}`);
// the other scenes: tilt, which way the upright (or north, on the globe)
// is on the screen, how far the camera is, and on the rings how near the
// line of sight is to each ring's axis
function shapeView(s) {
  const c = camera.position.toArray(), t = controls.target.toArray(), d = [t[0] - c[0], t[1] - c[1], t[2] - c[2]];
  const [R, U] = screenAxes(), dist = Math.hypot(...d);
  const v = { tilt: N.viewAngles(c, t).tilt, up: N.screenBearing([0, 0, 1], R, U), dist, below: c[2] < 0 };
  if (s.rings) v.rings = s.rings.map((q) => N.axisAngle(d, q.axis));
  if (state.scene === "globe") {
    const p = N.sphereHit(c, d, SC.GLOBE_R), north = p && N.northAt(p);
    v.at = p && N.globeLonLat(p);
    v.atTilt = p ? Math.acos(Math.max(-1, Math.min(1, -(d[0] * p[0] + d[1] * p[1] + d[2] * p[2]) / (dist * SC.GLOBE_R)))) * 180 / Math.PI : null;
    v.north = p && !north ? "pole" : north ? N.screenBearing(north, R, U) : null;
    v.over = N.globeLonLat(c);
    v.alt = (Math.hypot(...c) / SC.GLOBE_R - 1) * 6371e3;
  }
  return v;
}
function shapeHud(s) {
  const v = shapeView(s);
  if (v.rings) return `through: ${v.rings.map((a, k) => `${SC.RING_COLOURS[k][1]} ${Math.round(a)}${DEG}`).join(" · ")} · tilt ${Math.round(v.tilt)}${DEG}`;
  if (v.alt !== undefined) {
    const n = v.north === "pole" ? "at a pole" : v.north === null ? "off the globe" : `north ${shortBearing(v.north)}`;
    return `${v.at ? fmtLL(...v.at) : "space"} · ${n}${v.atTilt === null ? "" : ` · tilt ${Math.round(v.atTilt)}${DEG}`} · ${fmtKm(v.alt)} up`;
  }
  return `tilt ${Math.round(v.tilt)}${DEG} (${tiltWords(v.tilt)}) · upright ${shortBearing(v.up)} · ${v.dist.toFixed(2)} from the pivot`;
}
function shapeRows(s) {
  const v = shapeView(s), m = SCENES[state.scene], rows = [["Drag", dragWords()]];
  if (v.alt !== undefined) {
    rows.push(["Looking at", v.at ? `${fmtLL(...v.at)} in the middle of the view, ${Math.round(v.atTilt)}${DEG} from straight down there` : "space: the middle of the view misses the globe"]);
    rows.push(["North", v.north === "pole" ? "none: the middle of the view is a pole" : v.north === null ? "" : fmtBearing(v.north)]);
    rows.push(["Camera", `${fmtKm(v.alt)} up, over ${fmtLL(...v.over)}, at the earth's scale`]);
  } else {
    if (v.rings) rows.push(["Through the rings", `${v.rings.map((a, k) => `${SC.RING_COLOURS[k][1]} ${Math.round(a)}${DEG}`).join(", ")} off their axes (0${DEG} is straight through)`]);
    rows.push(["Looking", `${Math.round(v.tilt)}${DEG} from straight down (${tiltWords(v.tilt)})`]);
    rows.push([v.rings ? "Red ring's axis" : "Upright", `${fmtBearing(v.up)}${v.up === null ? "" : Math.abs(v.up) < 1 ? ": no roll" : ": rolled"}`]);
    rows.push(["Camera", `${v.dist.toFixed(2)} from the pivot; the ${s.what} is ${s.size.toFixed(1)} across${v.below && s.height ? ", and the camera is below its floor" : ""}`]);
  }
  rows.push(["Try", m.task]);
  return rows;
}
function hud() {
  const s = shape();
  if (s) { $("hud").textContent = shapeHud(s); return; }
  const v = view();
  const head = v.heading === null ? "" : ` · heading ${Math.round(v.heading)}${DEG} ${N.compass(v.heading)}${v.grid ? " (grid)" : ""}`;
  $("hud").textContent = `tilt ${Math.round(v.tilt)}${DEG} (${tiltWords(v.tilt)})${head} · ${fmtKm(v.dist)} from the pivot${v.below ? " · under the sea surface" : ""}`;
}
function readout() {
  const s = shape();
  if (s) { $("out").innerHTML = shapeRows(s).map(([k, val]) => `<tr><th>${k}</th><td>${val}</td></tr>`).join(""); return; }
  const v = view(), p = picked();
  const rows = [
    ["Drag", dragWords()],
    ["Turning about", `${fmtLL(v.lon, v.lat)}, ${fmtH(v.h)}`],
    ["Looking", `${Math.round(v.tilt)}${DEG} from straight down (${tiltWords(v.tilt)})${v.heading === null ? "" : `, heading ${Math.round(v.heading)}${DEG} ${N.compass(v.heading)}${v.grid ? " from grid north" : " true"}`}`],
    ["Camera", `${fmtKm(v.dist)} from the pivot at the map's scale, ${v.below ? "under" : "above"} the sea surface`],
    p && ["Picked", `${fmtLL(p.lon, p.lat)}: GEBCO ${p.h < 0 ? `${Math.round(-p.h).toLocaleString()} m deep` : `${Math.round(p.h).toLocaleString()} m up`}`],
    world && ["Relief", `${state.n} x ${state.n} cells of ${fmtKm((2 * HALF) / state.n)}, ${Math.round(world.lo).toLocaleString()} to ${Math.round(world.hi).toLocaleString()} m, drawn x ${state.vx}; GEBCO read at ${Math.round(world.wins[0].dx * 60)} arc minutes`],
    ["Try", SCENES.relief.task]
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

// what changes with the scene: what is shown, the panel's map controls,
// the orbits' names, the hint and the credit
const GEBCO_CREDIT = $("credit").innerHTML;
const CREDITS = {
  relief: GEBCO_CREDIT, globe: "Coastlines from Natural Earth", rings: "",
  teapot: "The Utah teapot (Martin Newell, 1975), as three.js's TeapotGeometry makes it",
  penguin: "The king penguin of the Penguin datum page"
};
function showScene() {
  const k = state.scene, m = SCENES[k];
  shape();
  reliefGroup.visible = k === "relief";
  headlight.intensity = k === "relief" ? 0 : 1.1;
  for (const [key, s] of Object.entries(shapes)) s.group.visible = key === k;
  $("relief-controls").hidden = k !== "relief";
  $("below").hidden = k === "globe";
  const o = $("orbit").options;
  o[0].textContent = `A turntable about ${m.up}`;
  o[1].textContent = `An orbit about +y (three.js's own): ${m.yShort}`;
  $("shift-hint").textContent = m.shift;
  $("credit").innerHTML = CREDITS[k];
  $("credit").hidden = !CREDITS[k];
  $("status").textContent = k === "relief" ? said : "";
  if (k === "relief" && !started) build();
  lastCam = "";
  readout();
}
function syncControls() {
  $("scene").value = state.scene;
  $("draw").value = state.draw;
  $("orbit").value = state.orbit;
  $("zc").checked = !!state.zc; $("sea").checked = !!state.sea; $("cut").checked = !!state.cut;
  $("sec").value = state.sec; $("sec").disabled = !state.cut;
  $("vx").value = Math.log10(state.vx); $("vx-out").textContent = `x ${state.vx}`;
  $("n").value = state.n; $("n-out").textContent = state.n;
}
// a new scene or Reset view also levels the trackball's roll
const level = () => { if (state.orbit === "trackball") camera.up.set(0, 0, 1); };
$("scene").addEventListener("change", (e) => {
  state.scene = e.target.value;
  state.cam = null;
  showScene();
  level();
  stage.setCamera(sceneCam());
  writeHash();
});
$("draw").addEventListener("change", (e) => { state.draw = e.target.value; applyDraw(); writeHash(); });
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
$("reset-view").addEventListener("click", () => { state.cam = null; level(); stage.setCamera(sceneCam()); writeHash(); });
// Straight down the upright; on the globe straight down onto the pivot
// where it is on the surface, and where it is inside, the camera at the
// same height over the place in the middle of the view. (Over a pole, a
// hair to one side, as on the map: the turntable's pole.)
$("down").addEventListener("click", () => {
  const t = controls.target, d = distNow();
  if (state.scene === "globe") {
    const c = camera.position, R = SC.GLOBE_R, onIt = t.length() > 0.5 * R;
    const at = onIt ? t.toArray() : N.sphereHit(c.toArray(), t.clone().sub(c).toArray(), R) || c.toArray();
    const u = new THREE.Vector3(...at).normalize();
    if (Math.abs(u.z) > 0.9999) u.y -= 0.001;
    const p = onIt ? u.clone().multiplyScalar(d).add(t) : u.clone().multiplyScalar(c.length());
    stage.setCamera([p.x, p.y, p.z, t.x, t.y, t.z]);
  } else stage.setCamera([t.x, t.y - 0.001 * d, t.z + d, t.x, t.y, t.z]);
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
showScene();
applyDraw();
stage.setCamera(state.cam || sceneCam());
stage.resize();
shareLinks("Navigation", { height: 560 });
window.addEventListener("hashchange", () => {
  const n = state.n;
  readHash(); syncControls(); setOrbit(); showScene(); applyDraw();
  stage.setCamera(state.cam || sceneCam());
  if (state.scene !== "relief" || !world) return;
  if (state.n !== n) build();
  else { drawRelief(); drawLines(); drawCurtain(); drawDrop(); readout(); }
});
Promise.all([
  loadCoastline("50m"),
  fetch(new URL("../data/coast-south-10m.json", import.meta.url)).then((r) => r.json())
]).then(([c, s]) => {
  const ring = (a) => Array.from(a);
  coast = { world: c, south: [ring(s.grounding), ring(s.front)] };
  drawLines();
  if (shapes.globe) shapes.globe.setCoast(coast.world, coast.south);
}).catch(() => {});
renderer.setAnimationLoop((now) => {
  pivot.step(now);
  controls.update();
  if (state.orbit === "trackball") tb.update();
  headlight.position.copy(camera.position);
  headlight.target.position.copy(controls.target);
  follow(now);
  renderer.render(scene, camera);
});
