// playproj: the geoid
//
// EGM2008 as a surface over the WGS84 ellipsoid (three.js, top), its
// undulation N exaggerated so the lumps show, and a profile between two
// places (2D canvas, below) that draws the three heights a point has: on
// the ellipsoid (h = 0), the geoid (h = N) and, with GEBCO, the terrain
// (h = H + N). The grid, the bilinear read and the geometry are
// src/core/geoid.js.

import * as THREE from "three";
import * as G from "../src/core/geoid.js";
import { graticule } from "../src/core/geo.js";
import { sampleElev } from "../src/core/basemap.js";
import { loadCoastline, loadGeoid } from "./data.js";
import { basemapControl } from "./basemap-ui.js";
import { makeStage, readParams, hashWriter, shareLinks, oneOf } from "../src/scene/index.js";
import { PLACES } from "../src/core/track.js";

const $ = (id) => document.getElementById(id);
const D2R = Math.PI / 180;
const DEG = "\u00b0";
const A = G.WGS84.a;

const C = {
  bg: 0x05070d, shell: 0xc9d6ea, coast: 0xf2f6fb, grat: 0x2c4a73, line: 0xffd34d, a: 0xff7ab8, b: 0xf2f6fb, cursor: 0x7fe0ff,
  ink: "#dfe7f2", muted: "#8a97ab", axis: "rgba(140,196,255,0.25)", ell: "#c9d6ea", geoid: "#7fe0ff",
  land: "rgba(150,128,96,0.85)", sea: "rgba(28,78,140,0.75)", seaLine: "#5aa0ff"
};

// N (metres) to colour: blue below the ellipsoid, red above
const RAMP = [[-110, 30, 60, 150], [-60, 70, 130, 230], [-20, 160, 200, 240], [0, 236, 236, 236], [20, 250, 205, 140], [50, 245, 150, 70], [90, 200, 50, 50]];
function ramp(n) {
  if (n <= RAMP[0][0]) return RAMP[0].slice(1);
  for (let i = 1; i < RAMP.length; i++) {
    if (n <= RAMP[i][0]) {
      const [z0, r0, g0, b0] = RAMP[i - 1], [z1, r1, g1, b1] = RAMP[i], t = (n - z0) / (z1 - z0);
      return [r0 + t * (r1 - r0), g0 + t * (g1 - g0), b0 + t * (b1 - b0)];
    }
  }
  return RAMP[RAMP.length - 1].slice(1);
}
const css = (n, a = 1) => { const [r, g, b] = ramp(n); return `rgba(${r | 0},${g | 0},${b | 0},${a})`; };

const PROFILES = [
  ["Indian Ocean low", 45, -5, 110, 15],
  ["New Guinea high", 125, -25, 170, 8],
  ["Over the Himalaya", 70, 12, 100, 45],
  ["Across the Andes", -95, -18, -45, -22],
  ["Hobart to Davis", PLACES.hobart.lon, PLACES.hobart.lat, PLACES.davis.lon, PLACES.davis.lat],
  ["Atlantic, north to south", -30, 70, -20, -70]
];

// ---------------------------------------------------------------- state

// nx is the geoid exaggeration as a power of ten (4: ten thousand times)
const defaults = {
  alon: 45, alat: -5, blon: 110, blat: 15, nx: 4, fx: 1, ell: 1, coast: 1, grat: 0, wall: 1, bm: "none", fit: 0, cam: null
};
const state = { ...defaults };
function readHash() {
  readParams(state, defaults, { bm: oneOf(["none", "gebco"], "none") });
  state.alat = Math.max(-89.9, Math.min(89.9, state.alat)); state.blat = Math.max(-89.9, Math.min(89.9, state.blat));
  state.nx = Math.max(0, Math.min(4.3, state.nx));
  state.fx = Math.max(1, Math.min(50, state.fx));
}
readHash();
const writeHash = hashWriter(state, defaults, { digits: 4 });

const exag = () => Math.round(10 ** state.nx);
const ell = () => ({ a: 1, f: G.WGS84.f * state.fx });

// ---------------------------------------------------------------- data

let grid = null, coast = [], world = null, prof = [], terrain = null, hover = null;

// ---------------------------------------------------------------- globe

const stage = $("three");
const { renderer, scene, camera, controls, setCamera, resize } = makeStage(stage, {
  bg: C.bg, fov: 36, far: 100,
  onCamera: (c) => { state.cam = c; writeHash(); }
});
controls.enablePan = false;
controls.minDistance = 1.4;
controls.maxDistance = 8;

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
scene.add(sun);

// geocentric X, Y, Z to the scene: y up through the north pole, lon 0 lat 0 towards +z
const xyz = [0, 0, 0];
function place(lon, lat, h, out, i = 0) {
  G.geocentric(lon, lat, h, ell(), xyz);
  out[i] = xyz[1]; out[i + 1] = xyz[2]; out[i + 2] = xyz[0];
  return out;
}
// h on the globe (units of a) for N metres, lifted a little for lines
const hOf = (n, lift = 0) => (n * exag()) / A + lift;

// the 1 degree lon/lat mesh of the grid's own nodes, so uv gives lon/lat back
const NX = 360, NY = 180;
function lonLatMesh() {
  const n = (NX + 1) * (NY + 1), uv = new Float32Array(n * 2), idx = [];
  for (let j = 0, k = 0; j <= NY; j++) for (let i = 0; i <= NX; i++, k++) { uv[2 * k] = i / NX; uv[2 * k + 1] = j / NY; }
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1;
      idx.push(a, c, d, a, d, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
// node k is lon -180 + i, lat 90 - j: the grid's own order
const nodeLonLat = (k) => [-180 + (k % (NX + 1)), 90 - Math.floor(k / (NX + 1))];

const geoidMesh = new THREE.Mesh(lonLatMesh(), new THREE.MeshLambertMaterial({ vertexColors: true }));
geoidMesh.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array((NX + 1) * (NY + 1) * 3), 3));
scene.add(geoidMesh);
const shell = new THREE.Mesh(lonLatMesh(), new THREE.MeshLambertMaterial({
  color: C.shell, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide
}));
scene.add(shell);

function lineObject(color, opacity = 1) {
  const o = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
  scene.add(o);
  return o;
}
const coastLines = lineObject(C.coast, 0.8);
const gratLines = lineObject(C.grat, 0.9);
const profLine = lineObject(C.line);
const cursorLine = lineObject(C.cursor);
const wall = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false
}));
scene.add(wall);
const dot = (color) => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), new THREE.MeshBasicMaterial({ color })); scene.add(m); return m; };
const endA = dot(C.a), endB = dot(C.b), cursorDot = dot(C.cursor);

function buildSurfaces() {
  if (!grid) return;
  const gp = geoidMesh.geometry.attributes.position, col = geoidMesh.geometry.attributes.color, sp = shell.geometry.attributes.position;
  for (let k = 0; k < gp.count; k++) {
    const [lon, lat] = nodeLonLat(k), n = grid.N[k];
    place(lon, lat, hOf(n), gp.array, 3 * k);
    place(lon, lat, 0, sp.array, 3 * k);
    const [r, g, b] = ramp(n);
    col.array[3 * k] = r / 255; col.array[3 * k + 1] = g / 255; col.array[3 * k + 2] = b / 255;
  }
  gp.needsUpdate = sp.needsUpdate = col.needsUpdate = true;
  geoidMesh.geometry.computeVertexNormals();
  shell.geometry.computeVertexNormals();
  geoidMesh.geometry.computeBoundingSphere();
  shell.geometry.computeBoundingSphere();
}

// flat lon/lat polylines to segments on the geoid, cut so no piece is long
function onGeoid(lines, lift = 0.003) {
  const out = [], p = [0, 0, 0], q = [0, 0, 0];
  for (const l of lines) {
    for (let i = 2; i < l.length; i += 2) {
      const [x0, y0, x1, y1] = [l[i - 2], l[i - 1], l[i], l[i + 1]];
      if (Math.abs(x1 - x0) > 180) continue;
      const m = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / 1));
      for (let s = 0; s < m; s++) {
        const lo0 = x0 + (x1 - x0) * s / m, la0 = y0 + (y1 - y0) * s / m;
        const lo1 = x0 + (x1 - x0) * (s + 1) / m, la1 = y0 + (y1 - y0) * (s + 1) / m;
        place(lo0, la0, hOf(G.undulation(grid, lo0, la0), lift), p);
        place(lo1, la1, hOf(G.undulation(grid, lo1, la1), lift), q);
        out.push(...p, ...q);
      }
    }
  }
  return new THREE.Float32BufferAttribute(out, 3);
}

function buildLines() {
  if (!grid) return;
  coastLines.visible = !!state.coast;
  gratLines.visible = !!state.grat;
  if (state.coast && coast.length) coastLines.geometry.setAttribute("position", onGeoid(coast));
  if (state.grat) gratLines.geometry.setAttribute("position", onGeoid(graticule(15, 1), 0.002));
}

function buildProfile() {
  if (!grid) return;
  prof = G.profile(grid, state.alon, state.alat, state.blon, state.blat, 600);
  terrain = world ? prof.map((p) => sampleElev(world, p.lon, p.lat)) : null;
  const line = [], tri = [], col = [], p = [0, 0, 0], q = [0, 0, 0], e = [0, 0, 0], f = [0, 0, 0];
  for (let i = 1; i < prof.length; i++) {
    const u = prof[i - 1], v = prof[i];
    place(u.lon, u.lat, hOf(u.N, 0.004), p);
    place(v.lon, v.lat, hOf(v.N, 0.004), q);
    line.push(...p, ...q);
    // the wall: ellipsoid to geoid, coloured as the surface is
    place(u.lon, u.lat, hOf(u.N), p); place(v.lon, v.lat, hOf(v.N), q);
    place(u.lon, u.lat, 0, e); place(v.lon, v.lat, 0, f);
    tri.push(...e, ...p, ...q, ...e, ...q, ...f);
    const cu = ramp(u.N).map((c) => c / 255), cv = ramp(v.N).map((c) => c / 255);
    col.push(...cu, ...cu, ...cv, ...cu, ...cv, ...cv);
  }
  profLine.geometry.setAttribute("position", new THREE.Float32BufferAttribute(line, 3));
  wall.geometry.setAttribute("position", new THREE.Float32BufferAttribute(tri, 3));
  wall.geometry.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  wall.visible = !!state.wall;
  const a = prof[0], b = prof[prof.length - 1];
  endA.position.fromArray(place(a.lon, a.lat, hOf(a.N, 0.004), p));
  endB.position.fromArray(place(b.lon, b.lat, hOf(b.N, 0.004), p));
}

function buildCursor() {
  const on = !!(hover && grid);
  cursorDot.visible = cursorLine.visible = on;
  if (!on) return;
  const p = [0, 0, 0], q = [0, 0, 0];
  place(hover.lon, hover.lat, hOf(hover.N, 0.004), p);
  cursorDot.position.fromArray(p);
  // a tick straight out along the normal through the geoid point, from the ellipsoid
  place(hover.lon, hover.lat, Math.min(0, hOf(hover.N)) - 0.02, p);
  place(hover.lon, hover.lat, Math.max(0, hOf(hover.N)) + 0.05, q);
  cursorLine.geometry.setAttribute("position", new THREE.Float32BufferAttribute([...p, ...q], 3));
}

// far enough back that the globe fits the narrower side of the view, over the profile's middle
function defaultCam() {
  const vf = camera.fov * D2R, hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
  const d = 1.35 / Math.sin(Math.min(vf, hf) / 2);
  const m = prof.length ? prof[prof.length >> 1] : { lon: state.alon, lat: state.alat };
  const lat = Math.max(-60, Math.min(60, m.lat)) * D2R, lon = m.lon * D2R;
  return [d * Math.cos(lat) * Math.sin(lon), d * Math.sin(lat), d * Math.cos(lat) * Math.cos(lon), 0, 0, 0];
}

// ---------------------------------------------------------------- profile

const map = $("map");
let frame = null;   // the profile's pixel frame, for hovering

function drawProfile() {
  const box = map.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, box.width), h = Math.max(10, box.height);
  map.width = Math.round(w * dpr); map.height = Math.round(h * dpr);
  const ctx = map.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#05070d"; ctx.fillRect(0, 0, w, h);
  if (!prof.length) return;
  const S = prof[prof.length - 1].s;
  const land = terrain ? prof.map((p, i) => Math.max(0, terrain[i])) : null;
  let lo = Math.min(0, ...prof.map((p) => p.N)), hi = Math.max(0, ...prof.map((p) => p.N));
  if (terrain && state.fit) {
    for (let i = 0; i < prof.length; i++) { lo = Math.min(lo, terrain[i] + prof[i].N); hi = Math.max(hi, terrain[i] + prof[i].N); }
  }
  const pad = (hi - lo) * 0.12 || 10;
  lo -= pad; hi += pad;
  const L = 60, R = 16, T = 14, B = 52;
  const X = (s) => L + (s / S) * (w - L - R), Y = (z) => T + (hi - z) / (hi - lo) * (h - T - B);
  frame = { X, Y, L, R, S, w };
  ctx.save();
  ctx.beginPath(); ctx.rect(L, T, w - L - R, h - T - B); ctx.clip();

  if (terrain) {
    // the sea from the floor up to the geoid, the land from the geoid up
    ctx.beginPath();
    prof.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(p.s), Y(p.N + Math.min(0, terrain[i]))));
    for (let i = prof.length - 1; i >= 0; i--) ctx.lineTo(X(prof[i].s), Y(prof[i].N));
    ctx.closePath(); ctx.fillStyle = C.sea; ctx.fill();
    ctx.beginPath();
    prof.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(p.s), Y(p.N + land[i])));
    for (let i = prof.length - 1; i >= 0; i--) ctx.lineTo(X(prof[i].s), Y(prof[i].N));
    ctx.closePath(); ctx.fillStyle = C.land; ctx.fill();
  }
  // the geoid's departure from the ellipsoid, coloured by height as on the globe
  const grad = ctx.createLinearGradient(0, Y(hi), 0, Y(lo));
  for (let k = 0; k <= 16; k++) { const z = hi + (lo - hi) * k / 16; grad.addColorStop(k / 16, css(z, terrain ? 0.4 : 0.45)); }
  ctx.beginPath(); ctx.moveTo(X(0), Y(0));
  for (const p of prof) ctx.lineTo(X(p.s), Y(p.N));
  ctx.lineTo(X(S), Y(0)); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  // the ellipsoid and the geoid
  ctx.setLineDash([5, 4]); ctx.strokeStyle = C.ell; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(L, Y(0)); ctx.lineTo(w - R, Y(0)); ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); prof.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(p.s), Y(p.N)));
  ctx.strokeStyle = C.geoid; ctx.lineWidth = 2.2; ctx.stroke();
  ctx.restore();

  // axes
  ctx.font = "12px system-ui, sans-serif"; ctx.fillStyle = C.muted; ctx.strokeStyle = C.axis; ctx.lineWidth = 1;
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const z of ticks(lo, hi, 6)) {
    ctx.beginPath(); ctx.moveTo(L, Y(z)); ctx.lineTo(w - R, Y(z)); ctx.stroke();
    ctx.fillText(`${z.toLocaleString("en")} m`, L - 6, Y(z));
  }
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (const s of ticks(0, S / 1000, Math.max(2, Math.min(8, Math.floor((w - L - R) / 80))))) ctx.fillText(`${s.toLocaleString("en")} km`, X(s * 1000), h - B + 6);
  ctx.textBaseline = "top"; ctx.font = "bold 12px system-ui, sans-serif";
  ctx.textAlign = "left"; ctx.fillStyle = "#ff7ab8"; ctx.fillText("A", L + 4, T + 2);
  ctx.textAlign = "right"; ctx.fillStyle = C.ink; ctx.fillText("B", w - R - 4, T + 2);
  ctx.font = "12px system-ui, sans-serif";
  // labels on the lines, at the left
  ctx.textAlign = "left"; ctx.textBaseline = "bottom";
  ctx.fillStyle = C.ell; ctx.fillText("ellipsoid, h = 0", L + 6, Y(0) - 3);
  const q = prof[Math.round(prof.length * 0.18)];
  ctx.fillStyle = C.geoid; ctx.fillText("geoid, h = N (H = 0)", X(q.s) + 4, Y(q.N) - 4);

  if (hover) {
    const x = X(hover.s);
    ctx.strokeStyle = "rgba(127,224,255,0.7)"; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, h - B); ctx.stroke();
    const mark = (z, c) => { ctx.beginPath(); ctx.arc(x, Y(z), 3.5, 0, 2 * Math.PI); ctx.fillStyle = c; ctx.fill(); };
    mark(0, C.ell); mark(hover.N, C.geoid);
    if (hover.H != null && hover.N + hover.H >= lo && hover.N + hover.H <= hi) mark(hover.N + hover.H, hover.H > 0 ? "#e0c090" : C.seaLine);
  }
}

// about n round numbers from lo to hi
function ticks(lo, hi, n) {
  const step0 = (hi - lo) / n, p = 10 ** Math.floor(Math.log10(step0 || 1));
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= step0) || p * 10;
  const out = [];
  for (let z = Math.ceil(lo / step) * step; z <= hi + 1e-9; z += step) out.push(+z.toFixed(6));
  return out;
}

function hoverAt(clientX) {
  if (!frame || !prof.length) return null;
  const r = map.getBoundingClientRect(), x = clientX - r.left;
  const t = (x - frame.L) / (frame.w - frame.L - frame.R);
  if (t < 0 || t > 1) return null;
  const i = Math.round(t * (prof.length - 1)), p = prof[i];
  return { ...p, H: terrain ? terrain[i] : null };
}
map.addEventListener("pointermove", (e) => { hover = hoverAt(e.clientX); buildCursor(); drawProfile(); readout(); });
map.addEventListener("pointerleave", () => { hover = null; buildCursor(); drawProfile(); readout(); });

// ---------------------------------------------------------------- readout

const fmtLL = (lon, lat) => `${Math.abs(lat).toFixed(2)}${DEG}${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(2)}${DEG}${lon < 0 ? "W" : "E"}`;
const m = (v) => `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(2)} m`;
const km = (v) => `${Math.round(v / 1000).toLocaleString("en")} km`;

function readout() {
  if (!grid || !prof.length) return;
  const pt = hover || { ...prof[0], H: terrain ? terrain[0] : null };
  const ns = prof.map((p) => p.N), lo = Math.min(...ns), hi = Math.max(...ns);
  const d = G.deflection(grid, pt.lon, pt.lat);
  const rows = [
    ["Profile", `A ${fmtLL(state.alon, state.alat)} to B ${fmtLL(state.blon, state.blat)}`],
    ["Length (WGS84 geodesic)", km(prof[prof.length - 1].s)],
    ["Geoid along it", `${m(lo)} to ${m(hi)}`],
    [hover ? `<span style="color:${C.geoid}">At the cursor</span>` : "At A", `${fmtLL(pt.lon, pt.lat)}, ${km(pt.s)} along`],
    ["Geoid undulation N", m(pt.N)]
  ];
  if (pt.H != null) {
    const H = pt.H;
    rows.push([H > 0 ? "Terrain H (above the geoid)" : "Sea floor H (below the geoid)", m(H)]);
    rows.push(["Ellipsoidal height h = H + N", m(H + pt.N)]);
  } else {
    rows.push(["Terrain H", "choose GEBCO above"]);
  }
  rows.push(["Deflection of the vertical", `${d.total.toFixed(1)}" (north ${d.xi.toFixed(1)}", east ${d.eta.toFixed(1)}")`]);
  rows.push(["EGM2008 on this grid", `${m(grid.min)} at ${fmtLL(...grid.minAt)}, ${m(grid.max)} at ${fmtLL(...grid.maxAt)}`]);
  rows.push(["On the globe", `N x ${exag().toLocaleString("en")}, flattening x ${state.fx}`]);
  $("out").innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("") +
    `<tr><td colspan="2" style="text-align:left"><span class="hint">PROJ, h to EGM2008 height:</span><br><code style="font-size:11px;word-break:break-all">${G.PIPELINE}</code></td></tr>`;
}

// ---------------------------------------------------------------- UI

for (const [name, alon, alat, blon, blat] of PROFILES) {
  const bt = document.createElement("button");
  bt.type = "button"; bt.textContent = name;
  bt.addEventListener("click", () => {
    Object.assign(state, { alon, alat, blon, blat });
    hover = null; buildProfile(); buildCursor();
    state.cam = null; setCamera(defaultCam());
    sync();
  });
  $("presets").appendChild(bt);
}

const ui = { nx: $("nx"), fx: $("fx"), ell: $("ell"), coast: $("coast"), grat: $("grat"), wall: $("wall"), fit: $("fit") };
ui.nx.addEventListener("input", () => { state.nx = +ui.nx.value; rebuild(); });
ui.fx.addEventListener("input", () => { state.fx = +ui.fx.value; rebuild(); });
for (const k of ["ell", "coast", "grat", "wall", "fit"]) {
  if (!ui[k]) continue;
  ui[k].addEventListener("change", () => { state[k] = ui[k].checked ? 1 : 0; if (k === "coast" || k === "grat") buildLines(); sync(); });
}
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(defaultCam()); writeHash(); });

const bmSelect = $("basemap");
const basemap = basemapControl({
  select: bmSelect, status: $("bm-status"), credit: $("credit"),
  onWorld: (wd) => { world = wd; buildProfile(); sync(); }
});
// only GEBCO carries heights
for (const o of [...bmSelect.options]) if (o.value !== "none" && o.value !== "gebco") o.remove();
bmSelect.options[0].textContent = "None";
bmSelect.addEventListener("change", () => { state.bm = bmSelect.value; basemap.set(state.bm); writeHash(); });

// click (not drag): move the nearer end of the profile there
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObject(geoidMesh)[0];
  if (!hit || !hit.uv) return;
  const lon = hit.uv.x * 360 - 180, lat = Math.max(-89.9, Math.min(89.9, 90 - hit.uv.y * 180));
  const ang = (lo, la) => Math.acos(Math.max(-1, Math.min(1,
    Math.sin(la * D2R) * Math.sin(lat * D2R) + Math.cos(la * D2R) * Math.cos(lat * D2R) * Math.cos((lo - lon) * D2R))));
  const end = ang(state.alon, state.alat) <= ang(state.blon, state.blat) ? "a" : "b";
  state[`${end}lon`] = +lon.toFixed(3); state[`${end}lat`] = +lat.toFixed(3);
  hover = null; buildProfile(); buildCursor(); sync();
});

function rebuild() {
  buildSurfaces(); buildLines(); buildProfile(); buildCursor(); sync();
}

function sync() {
  ui.nx.value = state.nx; ui.fx.value = state.fx;
  $("nx-out").textContent = `${exag().toLocaleString("en")} x`;
  $("fx-out").textContent = state.fx === 1 ? "1 x (true)" : `${state.fx} x`;
  for (const k of ["ell", "coast", "grat", "wall", "fit"]) if (ui[k]) ui[k].checked = !!state[k];
  if (ui.fit) ui.fit.disabled = !world;
  shell.visible = !!state.ell;
  wall.visible = !!state.wall;
  $("globe-label").textContent = `EGM2008 geoid, N x ${exag().toLocaleString("en")}, over the WGS84 ellipsoid` +
    (state.fx > 1 ? ` (flattening x ${state.fx})` : "");
  $("profile-label").textContent = "Heights along the great circle from A to B, in metres" + (terrain ? ", with GEBCO terrain" : "");
  drawProfile();
  readout();
  writeHash();
}

// ---------------------------------------------------------------- start

window.addEventListener("hashchange", () => { readHash(); rebuild(); if (state.bm !== basemap.id) basemap.set(state.bm); });
new ResizeObserver(() => drawProfile()).observe(map.parentElement);
shareLinks("playproj: Geoid", { height: 640 });

function tick() {
  sun.position.copy(camera.position).add(new THREE.Vector3(1.5, 2, 0)).normalize().multiplyScalar(5);
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

(async () => {
  try {
    grid = G.fromInt16(await loadGeoid());
  } catch (e) {
    $("out").innerHTML = `<tr><td>The geoid grid did not load (${e.message}).</td></tr>`;
    return;
  }
  rebuild();
  resize();
  setCamera(state.cam || defaultCam());
  requestAnimationFrame(tick);
  coast = await loadCoastline("110m").catch(() => []);
  buildLines();
  if (state.bm !== "none") basemap.set(state.bm);
})();
