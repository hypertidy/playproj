// playproj: map catastrophes.
//
// One canvas holds the flat map of the rotated sphere. The same canvas is
// the texture on a grid that runs from the globe (unwrap 0) through a
// cylinder to the flat map (unwrap 1), so the seam and the poles of the map
// can be followed back to the globe. On the globe the grid is turned so the
// data stays fixed to the Earth; flat, it is turned upright.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as m from "./mishaps.js";
import { loadCoastline } from "./data.js";

const d3 = window.d3;
const D2R = Math.PI / 180;
const DEG = "\u00b0";
const TEX_W = 2048;

const COLORS = {
  bg: "#05070d",
  ocean: "#0d2240",
  coast: "#d7ecff",
  grat: "#2c4a73",
  naive: "#ff7a59",
  sphere: "#6ab787",
  seam: "#ff3b3b",
  pole: "#ffb347"
};

// ---------------------------------------------------------------- state

const steps = m.catastrophes(d3);
const defaults = { c: "seam", m: "naive", flip: 0, ghost: 1, lon: 0, lat: 0, flat: "eqc", t: 0, coast: 1, grat: 1, cam: null };
const state = { ...defaults };
const embed = new URLSearchParams(location.search).has("embed");

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  Object.assign(state, defaults);
  for (const k of Object.keys(defaults)) {
    if (!h.has(k)) continue;
    const raw = h.get(k);
    if (k === "c") state.c = steps.some((s) => s.id === raw) ? raw : "seam";
    else if (k === "m") state.m = raw === "sphere" ? "sphere" : "naive";
    else if (k === "flat") state.flat = raw in m.flats ? raw : "eqc";
    else if (k === "cam") {
      const c = raw.split(",").map(Number);
      if (c.length === 6 && c.every(isFinite)) state.cam = c;
    } else if (isFinite(+raw)) state[k] = +raw;
  }
  state.lon = ((state.lon + 540) % 360) - 180;
  state.lat = Math.max(-90, Math.min(90, state.lat));
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

const step = () => steps.find((s) => s.id === state.c);
const rot = () => m.rotation(state.lon, state.lat);
const features = () => {
  const fs = step().features;
  return state.flip ? fs.map(m.reverseFeature) : fs;
};

// ---------------------------------------------------------------- the map

let coast = [];
let coastGeo = null;

const tex = document.createElement("canvas");
const tctx = tex.getContext("2d");

function drawSphere(ctx, fr, fs, style) {
  const path = d3.geoPath(m.sphereProjection(d3, state.flat, fr.w, rot()), ctx);
  for (const f of fs) {
    ctx.beginPath(); path(f);
    if (f.type === "Polygon" && style.fill) { ctx.fillStyle = style.fill; ctx.fill(); }
    ctx.stroke();
  }
}

function drawNaive(ctx, fr, fs, style) {
  for (const f of fs) {
    ctx.beginPath(); m.naivePath(ctx, d3, [f], state.flat, fr.w, rot());
    if (f.type === "Polygon" && style.fill) { ctx.fillStyle = style.fill; ctx.fill("evenodd"); }
    ctx.stroke();
  }
}

function drawTexture() {
  const fr = m.frame(state.flat, TEX_W);
  if (tex.width !== fr.w || tex.height !== fr.h) {
    tex.width = fr.w; tex.height = fr.h;
    texture.dispose();   // reallocate at the new size
  }
  const ctx = tctx, s = fr.w / 1024;
  ctx.setLineDash([]);
  ctx.fillStyle = COLORS.ocean;
  ctx.fillRect(0, 0, fr.w, fr.h);

  if (state.grat) {
    ctx.strokeStyle = COLORS.grat; ctx.lineWidth = 1 * s;
    ctx.beginPath();
    d3.geoPath(m.sphereProjection(d3, state.flat, fr.w, rot()), ctx)(d3.geoGraticule10());
    ctx.stroke();
  }
  if (state.coast && coastGeo) {
    ctx.strokeStyle = COLORS.coast; ctx.lineWidth = 0.9 * s; ctx.globalAlpha = 0.8;
    (state.m === "sphere" ? drawSphere : drawNaive)(ctx, fr, [coastGeo], {});
    ctx.globalAlpha = 1;
    if (state.m === "naive") {
      // pick out the coastline edges that jump the seam
      ctx.strokeStyle = COLORS.naive; ctx.lineWidth = 2 * s;
      ctx.beginPath(); m.seamJumps(ctx, d3, coastGeo.coordinates, state.flat, fr.w, rot()); ctx.stroke();
    }
  }

  const fs = features();
  const other = state.m === "sphere" ? "naive" : "sphere";
  if (state.ghost && fs.length) {
    ctx.strokeStyle = COLORS[other]; ctx.lineWidth = 1.5 * s; ctx.setLineDash([6 * s, 5 * s]); ctx.globalAlpha = 0.85;
    (other === "sphere" ? drawSphere : drawNaive)(ctx, fr, fs, {});
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = COLORS[state.m]; ctx.lineWidth = 2.5 * s;
  const fill = state.m === "sphere" ? "rgba(106,183,135,0.5)" : "rgba(255,122,89,0.5)";
  (state.m === "sphere" ? drawSphere : drawNaive)(ctx, fr, fs, { fill });

  // the vertices, the same either way
  const r = d3.geoRotation(rot());
  ctx.fillStyle = "#ffffff";
  for (const f of fs) {
    const rings = f.type === "Polygon" ? f.coordinates : [f.coordinates];
    for (const rg of rings) for (const ll of rg) {
      const [x, y] = fr.px(...r(ll));
      ctx.beginPath(); ctx.arc(x, y, 3 * s, 0, 2 * Math.PI); ctx.fill();
    }
  }

  // the seam and the poles of the map
  ctx.lineWidth = 3 * s;
  ctx.strokeStyle = COLORS.seam;
  ctx.beginPath(); ctx.moveTo(1.5 * s, 0); ctx.lineTo(1.5 * s, fr.h); ctx.moveTo(fr.w - 1.5 * s, 0); ctx.lineTo(fr.w - 1.5 * s, fr.h); ctx.stroke();
  ctx.strokeStyle = COLORS.pole;
  ctx.beginPath(); ctx.moveTo(0, 1.5 * s); ctx.lineTo(fr.w, 1.5 * s); ctx.moveTo(0, fr.h - 1.5 * s); ctx.lineTo(fr.w, fr.h - 1.5 * s); ctx.stroke();
}

// ---------------------------------------------------------------- scene

const stage = document.getElementById("three");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(COLORS.bg);
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const DEFAULT_CAM = [0, 0.5, 8.4, 0, 0, 0];
function setCamera(c) {
  camera.position.set(c[0], c[1], c[2]);
  controls.target.set(c[3], c[4], c[5]);
  controls.update();
}
setCamera(DEFAULT_CAM);
controls.addEventListener("end", () => {
  const p = camera.position, t = controls.target;
  state.cam = [p.x, p.y, p.z, t.x, t.y, t.z];
  writeHash();
});

const texture = new THREE.CanvasTexture(tex);
texture.colorSpace = THREE.SRGBColorSpace;
texture.anisotropy = 4;

// everything in the rotated frame of the map lives in this group
const group = new THREE.Group();
scene.add(group);

const NX = 180, NY = 90;
const sheet = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
group.add(sheet);

const seamLine = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COLORS.seam }));
const poleLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COLORS.pole }));
const poleDots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: COLORS.pole, size: 0.09 }));
group.add(seamLine, poleLines, poleDots);

// Rotated lon/lat (radians) to the unwrapping surface. The first half of
// unwrap swells the globe out to a cylinder, the second half opens the
// cylinder flat, keeping the central meridian fixed.
function unwrapper(t, flat) {
  const s = Math.min(1, 2 * t), u = Math.min(0.9995, Math.max(0, 2 * t - 1));
  const R = 1 / (1 - u);
  return (lam, phi, out, i = 0) => {
    const h = Math.cos(phi) * (1 - s) + s;
    const th = lam * (1 - u);
    out[i] = h * R * Math.sin(th);
    out[i + 1] = Math.sin(phi) * (1 - s) + flat.y(phi) * s;
    out[i + 2] = h * (R * Math.cos(th) - R + 1);
    return out;
  };
}

let gridIndex = null;
function buildGrid() {
  const idx = [];
  for (let j = 0; j < NY; j++)
    for (let i = 0; i < NX; i++) {
      const a = j * (NX + 1) + i, b = a + NX + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  gridIndex = idx;
}
buildGrid();

// the rotation taking the map's frame to the Earth's, as a quaternion
function earthQuaternion() {
  const inv = d3.geoRotation(rot()).invert;
  const toThree = (lon, lat) => {
    const cp = Math.cos(lat * D2R);
    return new THREE.Vector3(cp * Math.sin(lon * D2R), Math.sin(lat * D2R), cp * Math.cos(lon * D2R));
  };
  const img = (v) => {
    const [lon, lat] = inv([Math.atan2(v[0], v[2]) / D2R, Math.asin(v[1]) / D2R]);
    return toThree(lon, lat);
  };
  const ex = img([1, 0, 0]), ey = img([0, 1, 0]), ez = img([0, 0, 1]);
  const mat = new THREE.Matrix4().makeBasis(ex, ey, ez);
  return new THREE.Quaternion().setFromRotationMatrix(mat);
}

const ease = (x) => x * x * (3 - 2 * x);

function rebuildScene() {
  const flat = m.flats[state.flat];
  const pm = flat.phimax * D2R;
  const f = unwrapper(state.t, flat);

  const pos = new Float32Array((NX + 1) * (NY + 1) * 3);
  const uv = new Float32Array((NX + 1) * (NY + 1) * 2);
  const ymax = flat.ymax;
  for (let j = 0, k = 0; j <= NY; j++) {
    const phi = pm - (2 * pm * j) / NY;
    const v = 0.5 + flat.y(phi) / (2 * ymax);
    for (let i = 0; i <= NX; i++, k++) {
      const lam = -Math.PI + (2 * Math.PI * i) / NX;
      f(lam, phi, pos, 3 * k);
      uv[2 * k] = i / NX; uv[2 * k + 1] = v;
    }
  }
  sheet.geometry.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(gridIndex);
  sheet.geometry = g;

  // seam: both edges of the cut, lifted a hair off the surface
  const lift = 1.004;
  const seam = [];
  for (const lam of [-Math.PI, Math.PI])
    for (let j = 0; j < NY; j++) {
      const a = f(lam, pm - (2 * pm * j) / NY, [0, 0, 0]);
      const b = f(lam, pm - (2 * pm * (j + 1)) / NY, [0, 0, 0]);
      seam.push(...a.map((x) => x * lift), ...b.map((x) => x * lift));
    }
  seamLine.geometry.dispose();
  seamLine.geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(seam, 3));

  // poles of the map: the top and bottom rows
  const pl = [], pd = [];
  for (const phi of [pm, -pm]) {
    for (let i = 0; i < NX; i++) {
      const a = f(-Math.PI + (2 * Math.PI * i) / NX, phi, [0, 0, 0]);
      const b = f(-Math.PI + (2 * Math.PI * (i + 1)) / NX, phi, [0, 0, 0]);
      pl.push(...a.map((x) => x * lift), ...b.map((x) => x * lift));
    }
    pd.push(...f(0, phi, [0, 0, 0]).map((x) => x * lift));
  }
  poleLines.geometry.dispose();
  poleLines.geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pl, 3));
  poleDots.geometry.dispose();
  poleDots.geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pd, 3));
  poleDots.visible = state.t < 0.02;

  // on the globe, turn the step's place of interest to face the camera
  const [llon, llat] = step().look || [0, 0];
  const look = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), llat * D2R)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -llon * D2R));
  group.quaternion.copy(look.multiply(earthQuaternion())).slerp(new THREE.Quaternion(), ease(state.t));
  // shrink the taller flat maps (Mercator) to the frame as they open
  const fit = Math.min(1, (0.6 * Math.PI) / flat.ymax);
  group.scale.setScalar(1 - (1 - fit) * ease(state.t));
}

// ---------------------------------------------------------------- panel

const $ = (id) => document.getElementById(id);
const ui = {
  steps: $("steps"), modes: $("modes"), t: $("t"), tOut: $("t-out"),
  lon: $("lon"), lonOut: $("lon-out"), lat: $("lat"), latOut: $("lat-out"),
  flat: $("flat"), flip: $("flip"), ghost: $("ghost"), coast: $("coast"), grat: $("grat"),
  caption: $("caption"), badge: $("badge"), map: $("map2d")
};

for (const s of steps) {
  const b = document.createElement("button");
  b.type = "button"; b.dataset.c = s.id; b.textContent = s.name;
  b.addEventListener("click", () => choose(s.id));
  ui.steps.appendChild(b);
}

function choose(id) {
  const s = steps.find((x) => x.id === id);
  state.c = id; state.flip = 0;
  state.lon = s.view.lon; state.lat = s.view.lat;
  if (s.coast) state.coast = 1;
  sync();
}

const pct = (x) => (x >= 0.995 || x < 0.005 ? (100 * x).toFixed(2) : (100 * x).toFixed(1)) + "%";

function drawPanelMap() {
  const c = ui.map, w = c.clientWidth;
  if (!w) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const h = Math.round((w * tex.height) / tex.width);
  c.style.height = h + "px";
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(tex, 0, 0, c.width, c.height);
}

function updatePanel() {
  const s = step();
  ui.t.value = state.t;
  ui.tOut.textContent = state.t === 0 ? "globe" : state.t === 1 ? "flat" : state.t <= 0.5 ? "to a cylinder" : "opening";
  ui.lon.value = state.lon; ui.lonOut.textContent = state.lon + DEG + " (seam at " + (((state.lon + 360) % 360) - 180) + DEG + ")";
  ui.lat.value = state.lat; ui.latOut.textContent = state.lat + DEG;
  ui.flat.value = state.flat;
  ui.flip.checked = !!state.flip; ui.ghost.checked = !!state.ghost;
  ui.coast.checked = !!state.coast; ui.grat.checked = !!state.grat;
  ui.caption.textContent = s.caption;
  for (const b of ui.steps.children) b.classList.toggle("active", b.dataset.c === state.c);
  for (const b of ui.modes.children) b.classList.toggle("active", b.dataset.mode === state.m);

  const poly = features().find((f) => f.type === "Polygon");
  const a = poly && m.areas(d3, poly, rot());
  if (a) {
    ui.badge.textContent = `Inside: ${pct(a.sphere)} of the globe on the sphere, ${pct(a.planar)} of the map vertex by vertex.`;
  } else if (features().length) {
    const len = features().map((f) => Math.round(d3.geoLength(f) * 6371)).join(" and ");
    ui.badge.textContent = `Great circle ${len} km.`;
  } else ui.badge.textContent = "";
}

let rafPending = false;
function sync() {
  writeHash();
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    drawTexture();
    texture.needsUpdate = true;
    rebuildScene();
    drawPanelMap();
    updatePanel();
  });
}

for (const b of ui.modes.children) b.addEventListener("click", () => { state.m = b.dataset.mode; sync(); });
ui.t.addEventListener("input", () => { stopAnim(); state.t = +ui.t.value; sync(); });
ui.lon.addEventListener("input", () => { state.lon = +ui.lon.value; sync(); });
ui.lat.addEventListener("input", () => { state.lat = +ui.lat.value; sync(); });
ui.flat.addEventListener("change", () => { state.flat = ui.flat.value; sync(); });
ui.flip.addEventListener("change", () => { state.flip = ui.flip.checked ? 1 : 0; sync(); });
ui.ghost.addEventListener("change", () => { state.ghost = ui.ghost.checked ? 1 : 0; sync(); });
ui.coast.addEventListener("change", () => { state.coast = ui.coast.checked ? 1 : 0; sync(); });
ui.grat.addEventListener("change", () => { state.grat = ui.grat.checked ? 1 : 0; sync(); });
$("next").addEventListener("click", () => {
  const i = steps.findIndex((s) => s.id === state.c);
  choose(steps[(i + 1) % steps.length].id);
});
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(DEFAULT_CAM); writeHash(); });

let anim = false, dir = 1, lastT = 0;
const playBtn = $("play");
function stopAnim() { anim = false; playBtn.textContent = state.t >= 1 ? "Wrap" : "Unwrap"; }
playBtn.addEventListener("click", () => {
  if (anim) return stopAnim();
  anim = true; dir = state.t >= 1 ? -1 : 1; playBtn.textContent = "Stop"; lastT = performance.now();
});

function copy(text, btn) {
  const done = () => { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1200); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {});
}
const pageUrl = () => location.origin + location.pathname;
$("copy-link").addEventListener("click", (e) => copy(pageUrl() + location.hash, e.target));
$("copy-embed").addEventListener("click", (e) => copy(
  `<iframe src="${pageUrl()}?embed=1${location.hash}" width="100%" height="480" style="border:0" loading="lazy" title="Map catastrophes"></iframe>`,
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
new ResizeObserver(drawPanelMap).observe(ui.map);

function tick(now) {
  if (anim) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    state.t = Math.max(0, Math.min(1, state.t + dir * dt * 0.3));
    if (state.t === 1 || state.t === 0) stopAnim();
    sync();
  }
  lastT = now;
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

async function loadData() {
  coast = await loadCoastline("110m");
  const lines = coast.map((l) => {
    const pts = [];
    for (let i = 0; i < l.length; i += 2) pts.push([l[i], l[i + 1]]);
    return pts;
  });
  coastGeo = { type: "MultiLineString", coordinates: lines };
}

window.addEventListener("hashchange", () => { readHash(); if (state.cam) setCamera(state.cam); sync(); });

if (embed) {
  document.body.classList.add("embed");
  $("open-full").hidden = false;
}

readHash();
if (state.cam) setCamera(state.cam);
resize();
sync();
loadData().then(() => { sync(); document.body.classList.add("ready"); });
requestAnimationFrame(tick);
