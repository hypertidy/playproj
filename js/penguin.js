// playproj: the penguin datum
//
// A king penguin of the earth's volume as the surface that lon/lat is drawn
// on (three.js, top), and the raster that makes in penguin lon/lat (2D
// canvas, below). A direction from the penguin's centre of mass is a
// lon/lat; the surface there is where the ray leaves the bird for the last
// time. The bird, its rays, mesh and table are src/core/penguin.js.

import * as THREE from "three";
import * as P from "../src/core/penguin.js";
import { loadCoastline } from "./data.js";
import { basemapControl } from "./basemap-ui.js";
import { saveBlob } from "./download.js";
import { writeFloatGeoTIFF } from "../src/core/geotiff-write.js";
import { makeStage, readParams, hashWriter, shareLinks, oneOf, copyText } from "../src/scene/index.js";

const $ = (id) => document.getElementById(id);
const D2R = Math.PI / 180;
const DEG = String.fromCharCode(176);

const C = {
  bg: 0x05070d, line: 0xffd34d, coast: 0xf2f6fb, grid: 0x7fb4ff, ray: 0x7fe0ff, exit: 0xffd34d, early: 0xff5a4a, entry: 0x7fe0ff,
  ink: "#dfe7f2", muted: "#8a97ab", axis: "rgba(140,196,255,0.25)", gridCss: "rgba(170,205,255,0.55)", coastCss: "rgba(245,248,252,0.85)",
  sea: [24, 62, 110], land: [150, 168, 108], none: [0.32, 0.33, 0.36]
};

const PRESETS = [
  ["King penguin (the decree)", { beak: 1, flip: 0.35, feet: 1 }],
  ["Flippers half up", { beak: 1, flip: 0.6, feet: 1 }],
  ["Flippers out level", { beak: 1.2, flip: 1, feet: 1 }],
  ["Star-shaped (compliant)", { beak: 0, flip: 0, feet: 0 }]
];

// ---------------------------------------------------------------- state

const defaults = {
  beak: 1, flip: 0.35, feet: 1, orient: "heard", col: "plumage", lay: "world", cell: 10,
  grid: 1, coast: 1, nod: 1, sph: 0, plon: 0, plat: 58, bm: "none", cam: null
};
const state = { ...defaults };
function readHash() {
  readParams(state, defaults, {
    orient: oneOf(["heard", "greenwich"], "heard"),
    col: oneOf(["plumage", "world", "area", "reach"], "plumage"),
    lay: oneOf(["world", "area", "und", "exits"], "world"),
    bm: oneOf(["none", "gebco", "esri"], "none")
  });
  state.beak = Math.max(0, Math.min(1.6, state.beak));
  state.flip = Math.max(0, Math.min(1, state.flip));
  state.feet = Math.max(0, Math.min(1, state.feet));
  if (![1, 5, 10, 15, 30].includes(state.cell)) state.cell = 10;
  state.plat = Math.max(-90, Math.min(90, state.plat));
}
readHash();
const writeHash = hashWriter(state, defaults, { digits: 3 });

let pg = null, reach = null, areas = null, sc = 1, M = P.frame(state.orient);
let coast = [], countries = [], mask = null, world = null;

// ---------------------------------------------------------------- the world image

// Land and sea from the Natural Earth countries, as a lon/lat RGBA image
// (the same layout as a basemap's world), for when no basemap is chosen.
function landMask() {
  const W = 1080, H = 540, cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = `rgb(${C.sea})`; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = `rgb(${C.land})`;
  for (const country of countries) for (const ring of country) {
    ctx.beginPath();
    for (let i = 0; i < ring.length; i += 2) {
      const x = (ring[i] + 180) / 360 * W, y = (90 - ring[i + 1]) / 180 * H;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath(); ctx.fill();
  }
  return { width: W, height: H, data: ctx.getImageData(0, 0, W, H).data };
}

// RGB 0..255 at earth lon, lat (nearest pixel)
function worldRGB(lon, lat, out) {
  const w = world || mask;
  if (!w) { out[0] = C.sea[0]; out[1] = C.sea[1]; out[2] = C.sea[2]; return out; }
  let i = Math.floor((lon + 180) / 360 * w.width); i = ((i % w.width) + w.width) % w.width;
  const j = Math.max(0, Math.min(w.height - 1, Math.floor((90 - lat) / 180 * w.height)));
  const k = (j * w.width + i) * 4;
  out[0] = w.data[k]; out[1] = w.data[k + 1]; out[2] = w.data[k + 2];
  return out;
}

// ---------------------------------------------------------------- ramps

// diverging: blue below zero, white at zero, red above, t from -1 to 1
function diverge(t) {
  t = Math.max(-1, Math.min(1, t));
  const W = [236, 236, 236], B = [40, 96, 205], R = [205, 52, 44];
  const e = t < 0 ? B : R, a = Math.abs(t);
  return [W[0] + (e[0] - W[0]) * a, W[1] + (e[1] - W[1]) * a, W[2] + (e[2] - W[2]) * a];
}
const areaRGB = (f) => diverge(Math.log2(Math.max(1e-6, f)) / 3);
const undRGB = (km) => diverge(km / 6000);
const EXITS = [[0, 0, 0], [38, 58, 82], [240, 170, 60], [235, 90, 60], [220, 70, 210]];
const exitsRGB = (n) => EXITS[Math.max(0, Math.min(4, n))];

// ---------------------------------------------------------------- table reads

// penguin lon/lat of a table cell's centre, and the radius at a direction
// (bilinear in the table, wrapping in longitude)
function rAt(lon, lat) {
  const t = pg.table;
  const x = (lon + 180) / t.step - 0.5, y = Math.max(0, Math.min(t.ny - 1, (90 - lat) / t.step - 0.5));
  const i0 = Math.floor(x), j0 = Math.min(t.ny - 2, Math.floor(y)), u = x - i0, v = y - j0;
  const a = ((i0 % t.nx) + t.nx) % t.nx, b = (a + 1) % t.nx;
  const r = (j, i) => t.rOut[j * t.nx + i];
  return (r(j0, a) * (1 - u) + r(j0, b) * u) * (1 - v) + (r(j0 + 1, a) * (1 - u) + r(j0 + 1, b) * u) * v;
}

// The exact ray: its crossings (model units) from the centre
function rayAt(lon, lat) {
  const u = P.dirOf(lon, lat);
  return { u, xs: P.rayCrossings(pg.field.F, pg.centroid, u) };
}

// geodetic to geocentric latitude on WGS84
const geocentricLat = (lat) => Math.atan((1 - P.WGS84.f) ** 2 * Math.tan(lat * D2R)) / D2R;

// ---------------------------------------------------------------- 3D

const stage = $("three");
const { renderer, scene, camera, controls, setCamera, resize } = makeStage(stage, {
  bg: C.bg, fov: 36, far: 100,
  onCamera: (c) => { state.cam = c; writeHash(); }
});
controls.enablePan = false;
controls.minDistance = 1.2;
controls.maxDistance = 12;
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.05);
scene.add(sun);

// body frame (x belly, y left, z crown) to the scene (y up, belly to +z)
const toScene = (x, y, z, out, i = 0) => { out[i] = y; out[i + 1] = z; out[i + 2] = x; return out; };

const bird = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
scene.add(bird);
function lineObject(color, opacity = 1) {
  const o = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
  scene.add(o);
  return o;
}
const gridLines = lineObject(C.grid, 0.55);
const coastLines = lineObject(C.coast, 0.9);
const rayLine = lineObject(C.ray, 0.9);
const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshBasicMaterial({ color: 0x7fb4ff, wireframe: true, transparent: true, opacity: 0.18 }));
scene.add(sphere);
const dots = [];
function dot(i) {
  if (!dots[i]) { dots[i] = new THREE.Mesh(new THREE.SphereGeometry(0.022, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffffff })); scene.add(dots[i]); }
  return dots[i];
}

function buildMesh() {
  const { positions, index } = pg.mesh, o = pg.centroid, F = pg.field.F, nv = positions.length / 3;
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3);
  for (let q = 0; q < nv; q++) {
    const x = positions[3 * q], y = positions[3 * q + 1], z = positions[3 * q + 2];
    toScene(x - o[0], y - o[1], z - o[2], pos, 3 * q);
    const n = P.normalAt(F, x, y, z);
    toScene(n[0], n[1], n[2], nrm, 3 * q);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  bird.geometry.dispose();
  bird.geometry = g;
  sphere.scale.setScalar(pg.Rv);
}

function colourMesh() {
  const { positions } = pg.mesh, nv = positions.length / 3, col = bird.geometry.attributes.color.array;
  const nrm = bird.geometry.attributes.normal.array, P0 = pg.field.parts, rgb = [0, 0, 0];
  for (let q = 0; q < nv; q++) {
    let c;
    const hid = reach.hidden[q];
    if (state.col === "plumage") {
      const x = positions[3 * q], y = positions[3 * q + 1], z = positions[3 * q + 2];
      const part = P0[pg.field.which(x, y, z)].id;
      c = P.plumage(part, [x, y, z], [nrm[3 * q + 2], nrm[3 * q], nrm[3 * q + 1]]);
    } else if (state.col === "reach") {
      const e = pg.table.exits[P.cellAt(pg.table, reach.lon[q], reach.lat[q]).k];
      c = hid ? [0.9, 0.25, 0.2] : e > 1 ? [0.95, 0.75, 0.3] : [0.3, 0.72, 0.68];
    } else if (hid && state.nod) {
      c = C.none;
    } else if (state.col === "world") {
      const [el, ep] = P.penguinToEarth(M, reach.lon[q], reach.lat[q]);
      c = worldRGB(el, ep, rgb).map((v) => v / 255);
    } else {
      c = areaRGB(pg.table.area[P.cellAt(pg.table, reach.lon[q], reach.lat[q]).k]).map((v) => v / 255);
    }
    col[3 * q] = c[0]; col[3 * q + 1] = c[1]; col[3 * q + 2] = c[2];
  }
  bird.geometry.attributes.color.needsUpdate = true;
}

// a penguin lon/lat on the decree surface, in the scene (lifted a touch)
const onDecree = (lon, lat, out, i, lift = 1.006) => {
  const u = P.dirOf(lon, lat), r = rAt(lon, lat) * lift;
  return toScene(u[0] * r, u[1] * r, u[2] * r, out, i);
};

function buildLines() {
  gridLines.visible = !!state.grid;
  coastLines.visible = !!state.coast;
  const p = [0, 0, 0], q = [0, 0, 0];
  if (state.grid) {
    const seg = [], c = state.cell, d = 1;
    for (let lon = -180; lon < 180; lon += c) for (let lat = -90; lat < 90; lat += d) {
      onDecree(lon, lat, p, 0); onDecree(lon, Math.min(90, lat + d), q, 0); seg.push(...p, ...q);
    }
    for (let lat = -90 + c; lat < 90; lat += c) for (let lon = -180; lon < 180; lon += d) {
      onDecree(lon, lat, p, 0); onDecree(lon + d, lat, q, 0); seg.push(...p, ...q);
    }
    gridLines.geometry.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
  }
  if (state.coast && coast.length) {
    const seg = [];
    for (const l of penguinCoast()) for (let i = 2; i < l.length; i += 2) {
      onDecree(l[i - 2], l[i - 1], p, 0, 1.008); onDecree(l[i], l[i + 1], q, 0, 1.008); seg.push(...p, ...q);
    }
    coastLines.geometry.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
  }
}

// the coastline in penguin lon/lat, cut where a piece jumps the seam
let pcoast = null;
function penguinCoast() {
  if (pcoast) return pcoast;
  pcoast = [];
  for (const l of coast) {
    let cur = [];
    for (let i = 0; i < l.length; i += 2) {
      const [a, b] = P.earthToPenguin(M, l[i], l[i + 1]);
      if (cur.length && Math.abs(a - cur[cur.length - 2]) > 90) { if (cur.length > 2) pcoast.push(cur); cur = []; }
      cur.push(a, b);
    }
    if (cur.length > 2) pcoast.push(cur);
  }
  return pcoast;
}

let ray = null;
function buildRay() {
  ray = rayAt(state.plon, state.plat);
  const { u, xs } = ray, p = [0, 0, 0], q = [0, 0, 0], R = (xs.length ? xs[xs.length - 1].r : 1) + 0.35;
  toScene(u[0] * R, u[1] * R, u[2] * R, q, 0);
  rayLine.geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, ...q], 3));
  const exits = xs.filter((c) => c.exit).length;
  let seen = 0;
  xs.forEach((c, i) => {
    const m = dot(i);
    m.visible = true;
    m.position.fromArray(toScene(u[0] * c.r, u[1] * c.r, u[2] * c.r, p, 0));
    if (c.exit) seen++;
    m.material.color.setHex(!c.exit ? C.entry : seen === exits ? C.exit : C.early);
    m.scale.setScalar(c.exit && seen === exits ? 1.4 : 1);
  });
  for (let i = xs.length; i < dots.length; i++) dots[i].visible = false;
  // the centre
  const m = dot(xs.length);
  m.visible = true; m.position.set(0, 0, 0); m.material.color.setHex(0xffffff); m.scale.setScalar(0.8);
  for (let i = xs.length + 1; i < dots.length; i++) dots[i].visible = false;
}

function defaultCam() {
  const vf = camera.fov * D2R, hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
  const d = 1.3 / Math.sin(Math.min(vf, hf) / 2);
  const az = 35 * D2R, el = 12 * D2R;
  return [d * Math.cos(el) * Math.sin(az), d * Math.sin(el), d * Math.cos(el) * Math.cos(az), 0, 0, 0];
}

// ---------------------------------------------------------------- raster

const map = $("map");
let frame = null, raster = null;

// the chosen layer as an image in penguin lon/lat (rows from the north)
function makeRaster() {
  const t = pg.table, world_ = state.lay === "world";
  const W = world_ ? 720 : t.nx, H = world_ ? 360 : t.ny;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(W, H), d = img.data, rgb = [0, 0, 0];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const lon = -180 + (i + 0.5) * 360 / W, lat = 90 - (j + 0.5) * 180 / H;
    const k = P.cellAt(t, lon, lat).k;
    let c;
    if (state.lay === "world") {
      const [el, ep] = P.penguinToEarth(M, lon, lat);
      c = worldRGB(el, ep, rgb);
    } else if (state.lay === "area") c = areaRGB(t.area[k]);
    else if (state.lay === "exits") c = exitsRGB(t.exits[k]);
    else {
      const [, ep] = P.penguinToEarth(M, lon, lat);
      c = undRGB((t.rOut[k] * sc - P.ellipsoidRadius(ep)) / 1000);
    }
    const q = (j * W + i) * 4;
    d[q] = c[0]; d[q + 1] = c[1]; d[q + 2] = c[2]; d[q + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  raster = cv;
}

function draw() {
  const box = map.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, box.width), h = Math.max(10, box.height);
  map.width = Math.round(w * dpr); map.height = Math.round(h * dpr);
  const ctx = map.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#05070d"; ctx.fillRect(0, 0, w, h);
  if (!raster) return;
  const L = 46, R = 18, T = 12, B = 44;
  const s = Math.min((w - L - R) / 360, (h - T - B) / 180);
  const x0 = L + ((w - L - R) - 360 * s) / 2, y0 = T + ((h - T - B) - 180 * s) / 2;
  const X = (lon) => x0 + (lon + 180) * s, Y = (lat) => y0 + (90 - lat) * s;
  frame = { x0, y0, s };
  ctx.imageSmoothingEnabled = state.lay === "world";
  ctx.drawImage(raster, x0, y0, 360 * s, 180 * s);
  ctx.save();
  ctx.beginPath(); ctx.rect(x0, y0, 360 * s, 180 * s); ctx.clip();
  // the cells, as a COG or Zarr array in penguin lon/lat would have them
  const c = state.cell;
  if (c * s >= 3) {
    ctx.strokeStyle = C.gridCss; ctx.lineWidth = 0.8; ctx.beginPath();
    for (let lon = -180; lon <= 180; lon += c) { ctx.moveTo(X(lon), Y(90)); ctx.lineTo(X(lon), Y(-90)); }
    for (let lat = -90; lat <= 90; lat += c) { ctx.moveTo(X(-180), Y(lat)); ctx.lineTo(X(180), Y(lat)); }
    ctx.stroke();
  }
  if (state.coast && coast.length) {
    ctx.strokeStyle = C.coastCss; ctx.lineWidth = 0.9; ctx.beginPath();
    for (const l of penguinCoast()) { ctx.moveTo(X(l[0]), Y(l[1])); for (let i = 2; i < l.length; i += 2) ctx.lineTo(X(l[i]), Y(l[i + 1])); }
    ctx.stroke();
  }
  // Heard Island and the ray
  const [hl, hp] = P.earthToPenguin(M, P.HEARD.lon, P.HEARD.lat);
  ctx.fillStyle = "#ff7ab8"; ctx.beginPath(); ctx.arc(X(hl), Y(hp), 4, 0, 2 * Math.PI); ctx.fill();
  ctx.font = "12px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
  ctx.fillText("Heard Island", X(hl) + 6, Y(hp) - 3);
  const rx = X(state.plon), ry = Y(state.plat);
  ctx.strokeStyle = "rgba(127,224,255,0.9)"; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(rx - 9, ry); ctx.lineTo(rx + 9, ry); ctx.moveTo(rx, ry - 9); ctx.lineTo(rx, ry + 9); ctx.stroke();
  ctx.restore();
  // axes
  ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = C.muted;
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let lon = -180; lon <= 180; lon += 60) ctx.fillText(`${lon}${DEG}`, X(lon), y0 + 180 * s + 5);
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let lat = -90; lat <= 90; lat += 30) ctx.fillText(`${lat}${DEG}`, x0 - 5, Y(lat));
}

map.addEventListener("pointermove", (e) => {
  if (!frame || !pg) return;
  const r = map.getBoundingClientRect();
  const lon = (e.clientX - r.left - frame.x0) / frame.s - 180, lat = 90 - (e.clientY - r.top - frame.y0) / frame.s;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return;
  setRay(lon, lat);
});

function setRay(lon, lat) {
  state.plon = +lon.toFixed(2); state.plat = +lat.toFixed(2);
  buildRay(); draw(); readout(); writeHash();
}

// click (not drag) on the bird: the ray through that point
const caster = new THREE.Raycaster(), ptr = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || !pg || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  caster.setFromCamera(ptr, camera);
  const hit = caster.intersectObject(bird)[0];
  if (!hit) return;
  const [lon, lat] = P.lonLatOf([hit.point.z, hit.point.x, hit.point.y]);
  setRay(lon, lat);
});

// ---------------------------------------------------------------- readout

const fmtLL = (lon, lat) => `${Math.abs(lat).toFixed(1)}${DEG}${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(1)}${DEG}${lon < 0 ? "W" : "E"}`;
const km = (m) => `${Math.round(m / 1000).toLocaleString("en")} km`;
const km2 = (m2) => `${(m2 / 1e6).toLocaleString("en", { maximumSignificantDigits: 3 })} km${String.fromCharCode(178)}`;
const pct = (f) => `${(f * 100).toFixed(1)}%`;

// a cell of the chosen size at lon, lat: its area on the penguin (the
// table's cells whose centres fall in it) and on the sphere of equal volume
function cellArea(lon, lat) {
  const c = state.cell, t = pg.table, R2 = P.R_EARTH ** 2;
  const w = Math.floor((lon + 180) / c) * c - 180, s = Math.min(90 - c, Math.floor((lat + 90) / c) * c - 90);
  let a = 0, ref = 0;
  for (let j = 0; j < t.ny; j++) {
    const la = 90 - (j + 0.5) * t.step;
    if (la < s || la >= s + c) continue;
    const dO = t.step * D2R * (Math.sin((la + t.step / 2) * D2R) - Math.sin((la - t.step / 2) * D2R));
    for (let i = 0; i < t.nx; i++) {
      const lo = -180 + (i + 0.5) * t.step;
      if (lo < w || lo >= w + c) continue;
      a += t.area[j * t.nx + i] * dO * R2; ref += dO * R2;
    }
  }
  return { w, s, a, ref };
}

function readout() {
  if (!pg) return;
  const H = P.heightOf(pg) * sc, xs = ray.xs, ex = xs.filter((c) => c.exit);
  const rOut = ex.length ? ex[ex.length - 1].r * sc : 0;
  const [el, ep] = P.penguinToEarth(M, state.plon, state.plat);
  const und = rOut - P.ellipsoidRadius(ep);
  const cell = cellArea(state.plon, state.plat);
  // Mawson Peak against the penguin surface in its direction
  const [hl, hp] = P.earthToPenguin(M, P.HEARD.lon, P.HEARD.lat);
  const hx = rayAt(hl, hp).xs.filter((c) => c.exit), rH = hx[hx.length - 1].r * sc;
  const heardR = P.ellipsoidRadius(geocentricLat(P.HEARD.lat)) + 2745;
  const rows = [
    ["The penguin", `${km(H)} tall, the earth's volume`],
    ["Directions with more than one exit", pct(pg.contestedFraction)],
    ["Surface no lon/lat reaches", `${pct(areas.hidden / areas.area)} of ${km2(areas.area * sc * sc)}`],
    ["Decree surface encloses", pg.decreeVolume / pg.volume - 1 < 0.005 ? "the bird, no more" : `${pct(pg.decreeVolume / pg.volume - 1)} more than the bird`],
    [`<span style="color:#7fe0ff">The ray</span>`, `penguin ${fmtLL(state.plon, state.plat)}`],
    ["Earth direction", fmtLL(el, ep)],
    ["Exits along it", `${ex.length}${ex.length > 1 ? ` (${ex.map((c) => Math.round(c.r * sc / 1000).toLocaleString("en")).join(", ")} km out)` : ""}`],
    ["Radius (last exit)", km(rOut)],
    ["Penguin undulation", `${und >= 0 ? "+" : "-"}${km(Math.abs(und))}`],
    [`Its ${state.cell}${DEG} cell on the penguin`, `${km2(cell.a)}, ${(cell.a / cell.ref).toFixed(2)} x the same cell on the sphere`],
    ["Mawson Peak, Heard Island", `${km(Math.abs(rH - heardR))} ${rH > heardR ? "below" : "above"} the penguin's surface`]
  ];
  $("out").innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("") +
    `<tr><td colspan="2" style="text-align:left"><span class="hint">PROJ, earth to penguin lon/lat:</span><br><code style="font-size:11px;word-break:break-all">${P.projString(M)}</code></td></tr>`;
  $("pj").textContent = JSON.stringify(P.projjson(M, pg), null, 2);
}

// ---------------------------------------------------------------- the GeoTIFF

$("save-tif").addEventListener("click", async () => {
  if (!pg || pg.table.step !== 1) return;
  const t = pg.table, n = t.nx * t.ny;
  const radius = new Float32Array(n), exits = new Float32Array(n), area = new Float32Array(n);
  for (let k = 0; k < n; k++) { radius[k] = t.rOut[k] * sc; exits[k] = t.exits[k]; area[k] = t.area[k]; }
  const R = P.R_EARTH, cite = `Penguin CRS (Republic of Heard Island decree): ${P.projString(M)}`;
  const blob = await writeFloatGeoTIFF({
    width: t.nx, height: t.ny, bands: [radius, exits, area], names: ["radius_m", "exits", "area_factor"],
    origin: [-180, 90], pixelSize: [1, 1],
    geoKeys: [[1024, 2], [1025, 1], [2048, 32767], [2049, { ascii: cite }], [2050, 32767], [2051, 8901], [2054, 9102],
      [2056, 32767], [2057, { double: R }], [2058, { double: R }]]
  });
  saveBlob(blob, "penguin_radius_1deg.tif");
  $("tif-status").textContent = `Written: ${t.nx} x ${t.ny}, radius in metres, exits and cell area factor, in penguin lon/lat.`;
});
$("copy-pj").addEventListener("click", (e) => copyText($("pj").textContent, e.target));

// ---------------------------------------------------------------- shaping

let busy = false, again = null;
// Build the penguin: coarse while a slider moves, fine when it stops.
function shape(fine) {
  if (busy) { again = fine; return; }
  busy = true;
  $("status").textContent = fine ? "Shaping the penguin..." : "";
  setTimeout(() => {
    pg = P.buildPenguin({ beak: state.beak, flip: state.flip, feet: state.feet }, fine ? { n: 112, step: 1 } : { n: 56, step: 3 });
    reach = P.vertexReach(pg);
    areas = P.meshAreas(pg.mesh, reach.hidden);
    sc = P.scale(pg);
    buildMesh(); colourMesh(); buildLines(); buildRay(); makeRaster(); draw(); readout(); sync();
    $("save-tif").disabled = pg.table.step !== 1;
    $("status").textContent = "";
    busy = false;
    if (again !== null) { const f = again; again = null; shape(f); }
  }, 20);
}

// ---------------------------------------------------------------- UI

for (const [name, prm] of PRESETS) {
  const bt = document.createElement("button");
  bt.type = "button"; bt.textContent = name;
  bt.addEventListener("click", () => { Object.assign(state, prm); sync(); shape(true); });
  $("presets").appendChild(bt);
}

const ui = { beak: $("beak"), flip: $("flip"), feet: $("feet") };
for (const k of ["beak", "flip", "feet"]) {
  ui[k].addEventListener("input", () => { state[k] = +ui[k].value; sync(); shape(false); });
  ui[k].addEventListener("change", () => { state[k] = +ui[k].value; shape(true); });
}
$("orient").addEventListener("change", () => {
  state.orient = $("orient").value; M = P.frame(state.orient); pcoast = null;
  colourMesh(); buildLines(); makeRaster(); draw(); readout(); sync();
});
$("col").addEventListener("change", () => { state.col = $("col").value; colourMesh(); sync(); });
$("lay").addEventListener("change", () => { state.lay = $("lay").value; makeRaster(); draw(); sync(); });
$("cell").addEventListener("change", () => { state.cell = +$("cell").value; buildLines(); draw(); readout(); sync(); });
for (const k of ["grid", "coast", "nod", "sph"]) {
  $(k).addEventListener("change", () => {
    state[k] = $(k).checked ? 1 : 0;
    if (k === "grid" || k === "coast") { buildLines(); draw(); }
    if (k === "nod") colourMesh();
    sync();
  });
}
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(defaultCam()); writeHash(); });

const bmSelect = $("basemap");
const basemap = basemapControl({
  select: bmSelect, status: $("bm-status"), credit: $("credit"),
  onWorld: (wd) => { world = wd; if (pg) { colourMesh(); makeRaster(); draw(); } }
});
bmSelect.options[0].textContent = "Land and sea (Natural Earth)";
bmSelect.addEventListener("change", () => { state.bm = bmSelect.value; basemap.set(state.bm); writeHash(); });

const NAMES = { beak: (v) => (v ? `${v.toFixed(2)} x` : "none"), flip: (v) => `${Math.round(4 + 76 * v)}${DEG} out`, feet: (v) => (v ? `${Math.round(v * 100)}%` : "tucked in") };
function sync() {
  for (const k of ["beak", "flip", "feet"]) { ui[k].value = state[k]; $(`${k}-out`).textContent = NAMES[k](state[k]); }
  $("orient").value = state.orient; $("col").value = state.col; $("lay").value = state.lay; $("cell").value = String(state.cell);
  for (const k of ["grid", "coast", "nod", "sph"]) $(k).checked = !!state[k];
  $("nod").disabled = state.col === "plumage" || state.col === "reach";
  sphere.visible = !!state.sph;
  const COL = {
    plumage: "a king penguin", world: "the world through the decree", area: "lon/lat cell area (blue smaller, red bigger)",
    reach: "red: no lon/lat reaches; gold: reached past an earlier exit"
  };
  const LAY = {
    world: "the world", area: "cell area against the sphere of equal volume, log2 from 1/8 (blue) to 8 (red)",
    und: "penguin minus WGS84 radius, -6,000 km (blue) to +6,000 km (red)", exits: "exits along the ray: 1 slate, 2 amber, 3 orange, 4+ magenta"
  };
  $("globe-label").textContent = `The penguin datum: ${COL[state.col]}`;
  $("map-label").textContent = `Penguin CRS lon/lat raster: ${LAY[state.lay]}`;
  writeHash();
}

// ---------------------------------------------------------------- start

window.addEventListener("hashchange", () => {
  const before = JSON.stringify([state.beak, state.flip, state.feet]);
  readHash(); M = P.frame(state.orient); pcoast = null;
  if (JSON.stringify([state.beak, state.flip, state.feet]) !== before) shape(true);
  else if (pg) { colourMesh(); buildLines(); buildRay(); makeRaster(); draw(); readout(); sync(); }
  if (state.bm !== basemap.id) basemap.set(state.bm);
});
new ResizeObserver(() => draw()).observe(map.parentElement);
shareLinks("playproj: Penguin datum", { height: 640 });

function tick() {
  sun.position.copy(camera.position).add(new THREE.Vector3(1.5, 2, 0)).normalize().multiplyScalar(5);
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

sync();
resize();
setCamera(state.cam || defaultCam());
requestAnimationFrame(tick);
shape(true);
(async () => {
  [coast, countries] = await Promise.all([
    loadCoastline("110m").catch(() => []),
    fetch(new URL("../data/countries-110m.json", import.meta.url)).then((r) => (r.ok ? r.json() : [])).catch(() => [])
  ]);
  mask = landMask(); pcoast = null;
  if (pg) { colourMesh(); buildLines(); makeRaster(); draw(); }
  if (state.bm !== "none") basemap.set(state.bm);
})();
