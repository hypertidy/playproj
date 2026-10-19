// playproj: the ellipsoid.
//
// The earth's ellipsoid on a globe (three.js, left) and in the plane of one
// meridian (2D canvas, right), with a slider that multiplies its
// flattening. At 1x it is the true shape, which no screen can tell from a
// sphere; exaggerated, the three latitudes of one point come apart: the
// geodetic (the normal to the surface, which misses the centre), the
// geocentric (the line to the centre) and the parametric (the point
// straight out on the circle of radius a). The numbers are always given
// for the true shape and for the drawn one. Formulas in
// src/core/ellipsoid.js, checked against PROJ.

import * as THREE from "three";
import { loadCoastline } from "./data.js";
import { graticule } from "../src/core/geo.js";
import * as E from "../src/core/ellipsoid.js";
import { makeStage, readParams, hashWriter, oneOf, shareLinks } from "../src/scene/index.js";

const $ = (id) => document.getElementById(id);
const D2R = Math.PI / 180;
const DEG = "\u00b0", PHI = "\u03c6", PSI = "\u03c8", BETA = "\u03b2";

const C = {
  bg: 0x05070d, surf: 0x1e6fd9, coast: "#d7ecff", grat: "#2c4a73", sphere: "#8a97ab",
  axis: "#5b6b85", normal: "#ffd34d", centre: "#7fe0ff", param: "#6ab787", osc: "#ff7ab8", outline: "#ffb347",
  ink: "#dfe7f2", muted: "#8a97ab", line: "#1f2a40"
};

// ---------------------------------------------------------------- state

const IDS = E.ELLIPSOIDS.map((r) => r.id);
const defaults = { ell: "WGS84", x: 1, lat: -45, lon: 147, sph: 1, par: 1, osc: 0, coast: 1, cam: null };
const state = { ...defaults };
function readHash() {
  readParams(state, defaults, { ell: oneOf(IDS, "WGS84") });
  state.x = Math.max(1, Math.min(maxX(), state.x));
  state.lat = Math.max(-90, Math.min(90, state.lat));
  state.lon = ((state.lon + 540) % 360) - 180;
}
const writeHash = hashWriter(state, defaults, { digits: 3 });

const record = () => E.ELLIPSOIDS.find((r) => r.id === state.ell);
const trueE = () => E.fromRecord(record());
const maxX = () => Math.floor(E.maxExaggeration(trueE()));
// the drawn ellipsoid, with a = 1
const drawnUnit = () => { const t = trueE(); return E.ellipsoid(1, Math.min(E.F_MAX, t.f * state.x)); };

// ---------------------------------------------------------------- globe

const stage = $("three");
const { renderer, scene, camera, controls, setCamera, resize } = makeStage(stage, {
  bg: C.bg, fov: 36, far: 100,
  onCamera: (c) => { state.cam = c; writeHash(); }
});
controls.enablePan = false;
controls.minDistance = 1.3;
controls.maxDistance = 8;

// on the drawn ellipsoid (a = 1): y up the polar axis, lon 0 towards +z
let U = drawnUnit();
function toScene(lon, lat, h = 0, out = new THREE.Vector3()) {
  const [p, z] = E.meridianPoint(U, lat, h), l = lon * D2R;
  return out.set(p * Math.sin(l), z, p * Math.cos(l));
}
const sphereScene = (lon, lat, r, out = new THREE.Vector3()) => {
  const p = lat * D2R, l = lon * D2R;
  return out.set(r * Math.cos(p) * Math.sin(l), r * Math.sin(p), r * Math.cos(p) * Math.cos(l));
};

function defaultCam() {
  const vf = camera.fov * D2R, hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
  const d = 1.15 / Math.sin(Math.min(vf, hf) / 2);
  const v = sphereScene(state.lon + 55, 12, d);
  return [v.x, v.y, v.z, 0, 0, 0];
}

scene.add(new THREE.AmbientLight(0xffffff, 0.75));
const sun = new THREE.DirectionalLight(0xffffff, 0.7);
sun.position.set(3, 4, 5);
scene.add(sun);

// the surface: a lon/lat grid whose normals are the geodetic normals
const NX = 144, NY = 72;
const surfGeom = new THREE.BufferGeometry();
{
  const idx = [];
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1;
    idx.push(a, b, d, a, d, c);
  }
  const n = (NX + 1) * (NY + 1);
  surfGeom.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  surfGeom.setAttribute("normal", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  surfGeom.setIndex(idx);
}
function buildSurface() {
  const pos = surfGeom.attributes.position, nor = surfGeom.attributes.normal, v = new THREE.Vector3();
  for (let j = 0, k = 0; j <= NY; j++) {
    const lat = -90 + (180 * j) / NY;
    for (let i = 0; i <= NX; i++, k++) {
      const lon = -180 + (360 * i) / NX;
      toScene(lon, lat, 0, v); pos.setXYZ(k, v.x, v.y, v.z);
      sphereScene(lon, lat, 1, v); nor.setXYZ(k, v.x, v.y, v.z);
    }
  }
  pos.needsUpdate = nor.needsUpdate = true;
  surfGeom.computeBoundingSphere();
}
const surface = new THREE.Mesh(surfGeom, new THREE.MeshPhongMaterial({
  color: C.surf, transparent: true, opacity: 0.55, shininess: 30, depthWrite: false, side: THREE.DoubleSide
}));
scene.add(surface);

function lineObject(color, opacity = 1, Kind = THREE.LineSegments) {
  const o = new Kind(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
  scene.add(o);
  return o;
}
const coastLines = lineObject(C.coast, 0.9);
const gratLines = lineObject(C.grat, 0.9);
const sphereLines = lineObject(C.sphere, 0.35);
const axisLine = lineObject(C.axis, 0.9);
const outline = lineObject(C.outline, 0.9, THREE.LineLoop);
const normalLine = lineObject(C.normal);
const centreLine = lineObject(C.centre);
const paramLine = lineObject(C.param);
const marker = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 12), new THREE.MeshBasicMaterial({ color: C.normal }));
const axisDot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), new THREE.MeshBasicMaterial({ color: C.normal }));
scene.add(marker, axisDot);

function setPositions(obj, arr) {
  obj.geometry.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
  obj.geometry.computeBoundingSphere();
}
// flat lon/lat polylines to segments just above the surface (or on a sphere)
function segments(lines, place) {
  const out = [], a = new THREE.Vector3(), b = new THREE.Vector3();
  for (const l of lines) for (let i = 2; i < l.length; i += 2) {
    place(l[i - 2], l[i - 1], a); place(l[i], l[i + 1], b);
    out.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  return out;
}
const GRAT = graticule(15, 2);
let coast = null;

function buildGlobe() {
  U = drawnUnit();
  buildSurface();
  const lift = (lon, lat, v) => toScene(lon, lat, 0.003, v);
  setPositions(gratLines, segments(GRAT, lift));
  if (coast) setPositions(coastLines, segments(coast, lift));
  setPositions(sphereLines, segments(GRAT, (lon, lat, v) => sphereScene(lon, lat, 1, v)));
  setPositions(axisLine, [0, -1.25, 0, 0, 1.25, 0]);
  buildPoint();
}

function buildPoint() {
  const { lon, lat } = state, l = lon * D2R, v = new THREE.Vector3();
  // the meridian ellipse through the point
  setPositions(outline, E.meridianOutline(U, 180).concat(E.meridianOutline(U, 180).reverse().slice(1, -1).map(([p, z]) => [-p, z]))
    .flatMap(([p, z]) => [p * Math.sin(l), z, p * Math.cos(l)]));
  const P = toScene(lon, lat, 0, new THREE.Vector3());
  marker.position.copy(P);
  // the normal: out from the surface and in to where it meets the axis
  const zAx = E.normalAxisZ(U, lat), out = sphereScene(lon, lat, 0.22, v);
  setPositions(normalLine, [P.x + out.x, P.y + out.y, P.z + out.z, 0, zAx, 0]);
  axisDot.position.set(0, zAx, 0);
  setPositions(centreLine, [0, 0, 0, P.x, P.y, P.z]);
  // the parametric point: straight out from P, parallel to the equator, on the sphere of radius a
  const beta = E.parametricLatitude(U, lat), Q = sphereScene(lon, beta, 1, new THREE.Vector3());
  setPositions(paramLine, [P.x, P.y, P.z, Q.x, Q.y, Q.z, Q.x, Q.y, Q.z, 0, 0, 0]);
  paramLine.visible = !!state.par;
}

// ---------------------------------------------------------------- section

const sec = $("section");
const sctx = sec.getContext("2d");
let view = null;

function drawSection() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2), w = sec.clientWidth, h = sec.clientHeight;
  if (!w || !h) return;
  if (sec.width !== Math.round(w * dpr)) sec.width = Math.round(w * dpr);
  if (sec.height !== Math.round(h * dpr)) sec.height = Math.round(h * dpr);
  const g = sctx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = "#05070d"; g.fillRect(0, 0, w, h);
  const s = Math.min(w / 2.7, h / 2.7), cx = w / 2, cy = h / 2;
  view = { s, cx, cy };
  const X = (p) => cx + p * s, Y = (z) => cy - z * s;
  const line = (pts, color, width = 1.5, dash = []) => {
    g.beginPath(); pts.forEach(([p, z], i) => (i ? g.lineTo(X(p), Y(z)) : g.moveTo(X(p), Y(z))));
    g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash); g.stroke(); g.setLineDash([]);
  };
  const dot = ([p, z], color, r = 4) => { g.beginPath(); g.arc(X(p), Y(z), r, 0, 2 * Math.PI); g.fillStyle = color; g.fill(); };
  const text = (str, [p, z], color, dx = 6, dy = -6, align = "left") => {
    g.font = "13px system-ui, sans-serif"; g.textAlign = align; g.fillStyle = color; g.fillText(str, X(p) + dx, Y(z) + dy);
  };
  // an angle arc at o from the +p direction to angle t (radians), radius r px
  const arc = (o, t, r, color, label) => {
    g.beginPath(); g.arc(X(o[0]), Y(o[1]), r, 0, -t, t > 0); g.strokeStyle = color; g.lineWidth = 1.2; g.stroke();
    const m = t / 2;
    g.font = "13px system-ui, sans-serif"; g.textAlign = "center"; g.fillStyle = color;
    g.fillText(label, X(o[0]) + (r + 11) * Math.cos(m), Y(o[1]) - (r + 11) * Math.sin(m) + 4);
  };

  // axes and the circle of radius a
  line([[-1.3, 0], [1.3, 0]], C.line, 1);
  line([[0, -1.3], [0, 1.3]], C.axis, 1);
  if (state.sph) {
    g.beginPath(); g.arc(cx, cy, s, 0, 2 * Math.PI); g.strokeStyle = "rgba(138,151,171,0.55)"; g.lineWidth = 1; g.setLineDash([4, 4]); g.stroke(); g.setLineDash([]);
  }
  // the meridian ellipse
  const half = E.meridianOutline(U, 180);
  line(half.concat(half.slice().reverse().map(([p, z]) => [-p, z])), C.outline, 2);
  text("a", [1, 0], C.muted, 6, 16);
  text("b", [0, U.b], C.muted, 6, -6);

  const lat = state.lat, phi = lat * D2R, P = E.meridianPoint(U, lat);
  const zAx = E.normalAxisZ(U, lat), { M } = E.radii(U, lat);
  const n = [Math.cos(phi), Math.sin(phi)];
  if (state.osc && Math.abs(lat) < 89.999) {
    const Cc = [P[0] - M * n[0], P[1] - M * n[1]];
    g.beginPath(); g.arc(X(Cc[0]), Y(Cc[1]), M * s, 0, 2 * Math.PI); g.strokeStyle = "rgba(255,122,184,0.6)"; g.lineWidth = 1.2; g.stroke();
    line([Cc, P], C.osc, 1.2, [3, 3]);
    dot(Cc, C.osc, 3);
    text("M", [P[0] - (M / 2) * n[0], P[1] - (M / 2) * n[1]], C.osc, -10, 4, "right");
  }
  // parametric: straight out from P to the circle, and back to the centre
  const beta = E.parametricLatitude(U, lat) * D2R, Q = [Math.cos(beta), Math.sin(beta)];
  if (state.par) {
    line([P, Q], C.param, 1.2, [2, 3]);
    line([[0, 0], Q], C.param, 1.4);
    dot(Q, C.param, 3);
    arc([0, 0], beta, 50, C.param, BETA);
  }
  // geocentric
  const psi = Math.atan2(P[1], P[0]);
  line([[0, 0], P], C.centre, 1.8);
  arc([0, 0], psi, 30, C.centre, PSI);
  // geodetic: the normal, out past the surface and in to the axis
  line([[P[0] + 0.25 * n[0], P[1] + 0.25 * n[1]], [0, zAx]], C.normal, 2);
  dot([0, zAx], C.normal, 3);
  const zEq = Math.abs(Math.sin(phi)) > 1e-9 ? P[0] - P[1] / Math.tan(phi) : null;
  if (zEq !== null && Math.abs(lat) > 0.5) arc([zEq, 0], phi, 72, C.normal, PHI);
  // N labelled past the end of M when both are drawn, since M is the shorter
  const { N } = E.radii(U, lat), tN = state.osc ? (M + N) / 2 : N / 2;
  text("N", [P[0] - tN * n[0], P[1] - tN * n[1]], C.normal, 10, 4);
  dot(P, C.ink, 4.5);
}

function pickFromSection(e) {
  if (!view) return;
  const b = sec.getBoundingClientRect(), p = (e.clientX - b.left - view.cx) / view.s, z = -(e.clientY - b.top - view.cy) / view.s;
  if (Math.hypot(p, z) < 0.05) return;
  // the angle at the centre is the geocentric latitude of the point under the pointer
  const psi = Math.atan2(z, Math.abs(p)) / D2R;
  state.lat = +E.geodeticFromGeocentric(U, psi).toFixed(2);
  update();
}
let dragging = false;
sec.addEventListener("pointerdown", (e) => { dragging = true; sec.setPointerCapture(e.pointerId); pickFromSection(e); });
sec.addEventListener("pointermove", (e) => { if (dragging) pickFromSection(e); });
sec.addEventListener("pointerup", () => { dragging = false; });

// ---------------------------------------------------------------- numbers

const km = (m, d = 1) => `${(m / 1000).toLocaleString("en", { minimumFractionDigits: d, maximumFractionDigits: d })} km`;
const deg = (x, d = 3) => `${x.toFixed(d)}${DEG}`;
const angle = (x) => (Math.abs(x) < 1 ? `${(x * 60).toFixed(2)}'` : deg(x, 2));
const flat = (f) => (f === 0 ? "0" : f < 0.05 ? `1/${(1 / f).toFixed(3)}` : f.toFixed(3));

function readout() {
  const T = trueE(), D = E.exaggerate(T, state.x), lat = state.lat;
  const both = (fn) => [fn(T), fn(D)];
  const rows = [
    ["Polar radius b", both((e) => km(e.b))],
    ["a minus b", both((e) => km(e.a - e.b))],
    ["Flattening f", both((e) => flat(e.f))],
    ["Eccentricity e", both((e) => e.e.toFixed(5))],
    [`Largest ${PHI} minus ${PSI}`, both((e) => { const m = E.maxLatitudeDifference(e); return `${angle(m.diff)} at ${deg(m.lat, 1)}`; })],
    ["Quarter meridian", both((e) => km(E.meridianArc(e, 90)))],
    [`At ${PHI} = ${deg(lat, 2)}`, null],
    [`Geocentric ${PSI}`, both((e) => deg(E.geocentricLatitude(e, lat)))],
    [`Parametric ${BETA}`, both((e) => deg(E.parametricLatitude(e, lat)))],
    [`${PHI} minus ${PSI}`, both((e) => angle(lat - E.geocentricLatitude(e, lat)))],
    ["N, normal to the axis", both((e) => km(E.radii(e, lat).N))],
    ["M, meridian radius", both((e) => km(E.radii(e, lat).M))],
    ["Normal misses the centre by", both((e) => km(Math.abs(E.normalAxisZ(e, lat))))],
    [`1${DEG} of latitude`, both((e) => km((E.radii(e, lat).M * D2R), 3))],
    [`1${DEG} of longitude`, both((e) => km((E.radii(e, lat).N * Math.cos(lat * D2R) * D2R), 3))],
    ["Meridian distance from equator", both((e) => km(E.meridianArc(e, lat)))]
  ];
  const xs = state.x === 1 ? "1x" : `${+state.x.toFixed(1)}x`;
  $("out").innerHTML = `<tr><td></td><td class="num">True</td><td class="num">Drawn (${xs})</td></tr>` +
    rows.map(([k, v]) => (v ? `<tr><td>${k}</td><td class="num">${v[0]}</td><td class="num">${v[1]}</td></tr>`
      : `<tr class="sub"><td colspan="3">${k}</td></tr>`)).join("");
  const mm = ((T.a - T.b) / T.a) * 150;
  $("globe-mm").textContent = `On a globe 30 cm across, a minus b at the true shape is ${mm.toFixed(2)} mm; ` +
    (state.x > 1 ? `drawn, it is ${(((D.a - D.b) / D.a) * 150).toFixed(1)} mm.` : "the slider multiplies it.");
  $("proj").textContent = `${E.projString(T, record().id)}  (a = ${T.a} m, 1/f = ${T.rf.toFixed(9)})` +
    (state.x > 1 ? `\ndrawn: +a=${T.a} +rf=${+D.rf.toFixed(6)}` : "");
}

// ---------------------------------------------------------------- controls

$("ell").innerHTML = E.ELLIPSOIDS.map((r) => `<option value="${r.id}">${r.name} (${r.id})</option>`).join("");
const XS = [1, 10, 30, 100];
for (const k of XS) {
  const bt = document.createElement("button");
  bt.type = "button"; bt.dataset.x = k; bt.textContent = k === 1 ? "True shape" : `${k}x`;
  bt.addEventListener("click", () => { state.x = k; update(true); });
  $("xs").appendChild(bt);
}

function syncUI() {
  $("ell").value = state.ell;
  const r = $("x");
  r.max = Math.log10(maxX()).toFixed(3);
  r.value = Math.log10(state.x);
  $("x-out").textContent = `${state.x < 10 ? +state.x.toFixed(2) : Math.round(state.x)}x`;
  for (const bt of $("xs").querySelectorAll("button")) bt.classList.toggle("active", Math.abs(state.x - +bt.dataset.x) < 1e-9);
  $("lat").value = state.lat; $("lat-out").textContent = `${Math.abs(state.lat).toFixed(2)}${DEG}${state.lat < 0 ? "S" : "N"}`;
  $("lon").value = state.lon; $("lon-out").textContent = `${Math.abs(state.lon).toFixed(1)}${DEG}${state.lon < 0 ? "W" : "E"}`;
  for (const k of ["sph", "par", "osc", "coast"]) $(k).checked = !!state[k];
  sphereLines.visible = !!state.sph;
  coastLines.visible = !!state.coast;
  $("l-sec").textContent = `The meridian at ${Math.abs(state.lon).toFixed(1)}${DEG}${state.lon < 0 ? "W" : "E"}, ${state.x === 1 ? "true shape" : `flattening ${+state.x.toFixed(1)}x`}`;
}

// shape: rebuild the globe; otherwise only the point moved
function update(shape = false) {
  if (shape) buildGlobe(); else buildPoint();
  syncUI(); readout(); drawSection(); writeHash();
}

$("ell").addEventListener("change", (e) => { state.ell = e.target.value; state.x = Math.min(state.x, maxX()); update(true); });
$("x").addEventListener("input", (e) => { const v = 10 ** +e.target.value; state.x = v < 10 ? +v.toFixed(2) : Math.round(v); update(true); });
$("lat").addEventListener("input", (e) => { state.lat = +e.target.value; update(); });
$("lon").addEventListener("input", (e) => { state.lon = +e.target.value; update(); });
for (const k of ["sph", "par", "osc", "coast"]) $(k).addEventListener("change", (e) => { state[k] = e.target.checked ? 1 : 0; update(); });

// click the globe to pick a point
const ray = new THREE.Raycaster();
let down = null;
renderer.domElement.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
  const b = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1), camera);
  const hit = ray.intersectObject(surface)[0];
  if (!hit) return;
  const q = hit.point, [lon, lat] = E.fromXYZ(U, q.z, q.x, q.y);
  state.lon = +lon.toFixed(2); state.lat = +lat.toFixed(2);
  update();
});

shareLinks("The ellipsoid");

// ---------------------------------------------------------------- loop

const main = $("stage");
new ResizeObserver(() => main.classList.toggle("stacked", main.clientHeight > main.clientWidth)).observe(main);
new ResizeObserver(() => drawSection()).observe(sec);

function tick() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

window.addEventListener("hashchange", () => { readHash(); setCamera(state.cam || defaultCam()); update(true); });

readHash();
resize();
setCamera(state.cam || defaultCam());
update(true);
loadCoastline("110m").then((c) => {
  coast = c;
  buildGlobe();
  document.body.classList.add("ready");
});
requestAnimationFrame(tick);
