// playproj: peeling the orange
//
// The globe cut into gores, or into one spiral strip, peeled off and laid
// flat. Left, the peel coming off the orange in 3D; right, the pieces flat,
// with the Euler spiral the spiral peel tends to. Geometry in
// src/core/peel.js.

import * as THREE from "three";
import * as P from "../src/core/peel.js";
import { coastRings, landPolygons } from "../src/core/landmesh.js";
import { sources } from "../src/core/basemap.js";
import { loadCoastline } from "./data.js";
import { loadWorld } from "./basemap-load.js";
import { makeStage, readParams, hashWriter, shareLinks, oneOf } from "../src/scene/index.js";

const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";
const PI = Math.PI, D2R = PI / 180, R2D = 180 / PI;
const EARTH_KM = 6371;

const C = { bg: 0x05070d, pith: 0xf3ead2, fruit: 0xf2a33a, euler: 0x7fe0ff, centre: 0xffd34d, edge: 0xffffff };

// ---------------------------------------------------------------- state

const defaults = { cut: "gores", n: 12, method: "sinu", lay: "flower", turns: 6, p: 0.6, lon0: 0, skin: "earth", euler: 1, fruit: 1, spin: 0, cam: null };
const state = { ...defaults };
function readHash() {
  readParams(state, defaults, {
    cut: oneOf(["gores", "spiral"], "gores"), method: oneOf(P.METHOD_KEYS, "sinu"), lay: oneOf(["flower", "row"], "flower"),
    skin: oneOf(["earth", "orange", "gebco", "esri"], "earth")
  });
  state.n = Math.max(3, Math.min(36, Math.round(state.n)));
  state.turns = Math.max(2, Math.min(30, Math.round(state.turns)));
  state.p = Math.max(0, Math.min(1, state.p));
  state.lon0 = Math.max(-180, Math.min(180, state.lon0));
}
readHash();
const writeHash = hashWriter(state, defaults, { digits: 3 });

// ---------------------------------------------------------------- stages

const { renderer, scene, camera, controls, setCamera, resize } = makeStage($("three"), {
  bg: C.bg, fov: 36, far: 600,
  onCamera: (c) => { state.cam = c; writeHash(); }
});
scene.add(new THREE.AmbientLight(0xffffff, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(3, 4, 5);
scene.add(sun);
const back = new THREE.DirectionalLight(0xffffff, 0.6);
back.position.set(-3, -2, -4);
scene.add(back);

// the flat pieces: their own renderer, looking down on z = 0
const flatEl = $("flat");
const flat = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
flat.setPixelRatio(Math.min(window.devicePixelRatio, 2));
flat.setClearColor(C.bg);
flatEl.appendChild(flat.domElement);
const flatScene = new THREE.Scene();
flatScene.add(new THREE.AmbientLight(0xffffff, 3));
const flatCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);

// ---------------------------------------------------------------- skins

// equirectangular canvases, u = (lon + 180) / 360 repeating, so pieces can
// carry unwrapped longitudes across the antimeridian
let land = null, coast = null;
const W = 2048, H = 1024;
const X = (lon) => ((lon + 180) / 360) * W, Y = (lat) => ((90 - lat) / 180) * H;
function ringPath(g, ring) {
  for (let i = 0; i < ring.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(ring[i]), Y(ring[i + 1]));
  g.closePath();
}
function graticule(g, colour, width) {
  g.strokeStyle = colour; g.lineWidth = width;
  for (let lon = -180; lon <= 180; lon += 15) { g.beginPath(); g.moveTo(X(lon), 0); g.lineTo(X(lon), H); g.stroke(); }
  for (let lat = -75; lat <= 75; lat += 15) { g.beginPath(); g.moveTo(0, Y(lat)); g.lineTo(W, Y(lat)); g.stroke(); }
}
function fillLand(g) {
  if (!land) return;
  // land rings carry unwrapped longitudes: draw each a turn either side too
  for (const shift of [-W, 0, W]) {
    g.save(); g.translate(shift, 0);
    g.beginPath();
    for (const p of land) { ringPath(g, p.outer); for (const h of p.holes) ringPath(g, h); }
    g.fill("evenodd");
    g.restore();
  }
}
function strokeCoast(g) {
  if (!coast) return;
  g.beginPath();
  for (const l of coast) {
    for (let i = 0; i < l.length; i += 2) {
      if (i && Math.abs(l[i] - l[i - 2]) > 180) g.moveTo(X(l[i]), Y(l[i + 1]));
      else (i ? g.lineTo : g.moveTo).call(g, X(l[i]), Y(l[i + 1]));
    }
  }
  g.stroke();
}
function earthCanvas() {
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  g.fillStyle = "#123a66"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#c8b47a"; fillLand(g);
  graticule(g, "rgba(255,255,255,0.28)", 1.5);
  g.strokeStyle = "rgba(255,255,255,0.75)"; g.lineWidth = 2; g.lineJoin = "round"; strokeCoast(g);
  return cv;
}
function orangeCanvas() {
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  g.fillStyle = "#f08a1c"; g.fillRect(0, 0, W, H);
  // dimples, a fixed pattern
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 26000; k++) {
    const x = rnd() * W, y = rnd() * H, r = 1 + rnd() * 2.2;
    g.fillStyle = rnd() < 0.5 ? "rgba(150,60,0,0.22)" : "rgba(255,190,90,0.25)";
    g.beginPath(); g.ellipse(x, y, r / Math.max(0.15, Math.cos(((90 - (y / H) * 180)) * D2R)), r, 0, 0, 2 * PI); g.fill();
  }
  g.fillStyle = "rgba(255,170,60,0.35)"; fillLand(g);
  g.strokeStyle = "rgba(110,40,0,0.7)"; g.lineWidth = 2; strokeCoast(g);
  return cv;
}
const texture = new THREE.CanvasTexture(document.createElement("canvas"));
const credits = { earth: 'Coastlines: <a href="https://www.naturalearthdata.com/">Natural Earth</a>', orange: 'Coastlines: <a href="https://www.naturalearthdata.com/">Natural Earth</a>' };
let skinReq = 0;
async function setSkin() {
  const id = state.skin, req = ++skinReq;
  let img;
  $("bm-status").textContent = "";
  if (id === "gebco" || id === "esri") {
    $("credit").innerHTML = sources[id].credit || "";
    try {
      const w = await loadWorld(id, (msg) => { if (req === skinReq) $("bm-status").textContent = msg; });
      if (req !== skinReq) return;
      img = w.canvas;
      $("bm-status").textContent = "";
    } catch (e) {
      if (req !== skinReq) return;
      $("bm-status").textContent = `${sources[id].label} did not load (${e.message}); showing the plain Earth.`;
      img = earthCanvas();
    }
  } else {
    $("credit").innerHTML = credits[id];
    img = id === "orange" ? orangeCanvas() : earthCanvas();
  }
  texture.image = img;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
}

// ---------------------------------------------------------------- meshes

const skinMat = new THREE.MeshLambertMaterial({ map: texture, side: THREE.FrontSide });
const pithMat = new THREE.MeshLambertMaterial({ color: C.pith, side: THREE.BackSide });
const flatMat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });

const geom = new THREE.BufferGeometry();
const skinMesh = new THREE.Mesh(geom, skinMat), pithMesh = new THREE.Mesh(geom, pithMat);
scene.add(skinMesh, pithMesh);
const fruit = new THREE.Mesh(new THREE.SphereGeometry(0.975, 64, 32), new THREE.MeshLambertMaterial({ color: C.fruit }));
scene.add(fruit);

const flatGeom = new THREE.BufferGeometry();
flatScene.add(new THREE.Mesh(flatGeom, flatMat));
const lineMat = (color, opacity = 1) => new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
const eulerLine = new THREE.Line(new THREE.BufferGeometry(), lineMat(C.euler));
const centreLine = new THREE.Line(new THREE.BufferGeometry(), lineMat(C.centre, 0.8));
const outlines = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat(C.edge, 0.5));
eulerLine.position.z = centreLine.position.z = outlines.position.z = 0.01;
flatScene.add(eulerLine, centreLine, outlines);

// The model built for the current cut: its grid (uv, the flat positions,
// and what each vertex needs to be placed at any peel), and a place(p) that
// writes the 3D positions.
let model = null;

function buildGores() {
  const n = state.n, cols = Math.max(3, Math.round(60 / n)), rows = 72, per = (rows + 1) * (cols + 1);
  const nv = n * per, uv = new Float32Array(nv * 2), flatPos = new Float32Array(nv * 3), pos = new Float32Array(nv * 3);
  const gx = new Float64Array(nv), gy = new Float64Array(nv), lam = new Float64Array(nv), phi = new Float64Array(nv), gi = new Uint16Array(nv);
  const index = [], seg = [];
  for (let i = 0; i < n; i++) {
    const g = P.goreGrid(n, state.method, { rows, cols, i, lon0: state.lon0 });
    for (let k = 0; k < per; k++) {
      const q = i * per + k;
      uv[2 * q] = (g.lon[k] + 180) / 360; uv[2 * q + 1] = (g.lat[k] + 90) / 180;
      gx[q] = g.x[k]; gy[q] = g.y[k]; lam[q] = g.lon[k] * D2R; phi[q] = g.lat[k] * D2R; gi[q] = i;
      const f = P.layout(state.lay, i, n, state.lon0, g.x[k], g.y[k]);
      flatPos[3 * q] = f[0]; flatPos[3 * q + 1] = f[1];
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const a = i * per + r * (cols + 1) + c, b = a + 1, d = a + cols + 1, e = d + 1;
      index.push(a, b, d, b, e, d);
    }
    // the outline in the flat view
    for (let r = 0; r < rows; r++) {
      const w0 = i * per + r * (cols + 1), e0 = w0 + cols;
      seg.push(w0, w0 + cols + 1, e0, e0 + cols + 1);
    }
  }
  const place = (p) => {
    for (let q = 0; q < nv; q++) {
      const v = P.peelGore(gi[q], n, state.lon0, gx[q], gy[q], lam[q], phi[q], p);
      pos[3 * q] = v[0]; pos[3 * q + 1] = v[1]; pos[3 * q + 2] = v[2];
    }
  };
  const segPos = new Float32Array(seg.length * 3);
  seg.forEach((q, k) => { segPos[3 * k] = flatPos[3 * q]; segPos[3 * k + 1] = flatPos[3 * q + 1]; });
  return { nv, uv, pos, flatPos, index, place, segPos, centre: null, euler: null };
}

function buildSpiral() {
  const sp = P.spiral(state.turns), m = 2 * Math.ceil(80 * state.turns), line = P.spiralLine(sp, m);
  const across = 5, nk = line.length, nv = nk * across;
  const uv = new Float32Array(nv * 2), flatPos = new Float32Array(nv * 3), pos = new Float32Array(nv * 3);
  const sph = new Float64Array(nv * 3), fl = new Float64Array(nv * 2);
  const index = [];
  for (let k = 0; k < nk; k++) {
    const s = line[k];
    for (let j = 0; j < across; j++) {
      const q = k * across + j, v = P.clampOffset(s, sp.w * (j / (across - 1) - 0.5));
      const [l, ph] = P.spiralSphere(sp, s.th, v), lon = l + state.lon0 * D2R;
      uv[2 * q] = (lon * R2D + 180) / 360; uv[2 * q + 1] = (ph * R2D + 90) / 180;
      sph[3 * q] = Math.cos(ph) * Math.sin(lon); sph[3 * q + 1] = Math.sin(ph); sph[3 * q + 2] = Math.cos(ph) * Math.cos(lon);
      const f = P.spiralFlat(s, v);
      fl[2 * q] = f[0]; fl[2 * q + 1] = f[1];
      flatPos[3 * q] = f[0]; flatPos[3 * q + 1] = f[1];
    }
    if (k < nk - 1) for (let j = 0; j < across - 1; j++) {
      const a = k * across + j, b = a + across, d = a + 1, e = b + 1;
      index.push(a, b, d, b, e, d);
    }
  }
  // the centre line on the sphere, for the peel's front
  const mid = (k) => { const q = k * across + (across >> 1); return new THREE.Vector3(sph[3 * q], sph[3 * q + 1], sph[3 * q + 2]); };
  const place = (p) => {
    const kp = Math.round(p * (nk - 1));
    // the front's frame on the sphere: tangent along the line, north across
    // it, outward; the flat strip is turned and moved to match it there
    const c = mid(kp), T3 = mid(Math.min(nk - 1, kp + 1)).sub(mid(Math.max(0, kp - 1))).normalize();
    const out = c.clone().normalize(), N3 = out.clone().cross(T3).normalize();
    const s = line[kp], ct = Math.cos(s.psi), st = Math.sin(s.psi);
    for (let k = 0; k < nk; k++) for (let j = 0; j < across; j++) {
      const q = k * across + j;
      if (k >= kp && p < 1) { pos[3 * q] = sph[3 * q]; pos[3 * q + 1] = sph[3 * q + 1]; pos[3 * q + 2] = sph[3 * q + 2]; continue; }
      const dx = fl[2 * q] - s.x, dy = fl[2 * q + 1] - s.y, a = dx * ct + dy * st, b = -dx * st + dy * ct;
      pos[3 * q] = c.x + a * T3.x + b * N3.x; pos[3 * q + 1] = c.y + a * T3.y + b * N3.y; pos[3 * q + 2] = c.z + a * T3.z + b * N3.z;
    }
  };
  const fit = P.eulerFit(sp, line);
  return { nv, uv, pos, flatPos, index, place, segPos: new Float32Array(0), sp, line, fit };
}

function rebuild() {
  model = state.cut === "gores" ? buildGores() : buildSpiral();
  for (const g of [geom, flatGeom]) {
    g.setIndex(model.index);
    g.setAttribute("uv", new THREE.BufferAttribute(model.uv, 2));
  }
  geom.setAttribute("position", new THREE.BufferAttribute(model.pos, 3));
  flatGeom.setAttribute("position", new THREE.BufferAttribute(model.flatPos, 3));
  flatGeom.computeBoundingBox();
  outlines.geometry.setAttribute("position", new THREE.BufferAttribute(model.segPos, 3));
  if (model.line) {
    const cl = new Float32Array(model.line.length * 3), el = new Float32Array(model.line.length * 3);
    model.line.forEach((s, k) => { cl[3 * k] = s.x; cl[3 * k + 1] = s.y; el[3 * k] = model.fit.euler[k][0]; el[3 * k + 1] = model.fit.euler[k][1]; });
    centreLine.geometry.setAttribute("position", new THREE.BufferAttribute(cl, 3));
    eulerLine.geometry.setAttribute("position", new THREE.BufferAttribute(el, 3));
  }
  centreLine.visible = !!model.line;
  place();
  fitFlat();
  readout();
}

function place() {
  model.place(state.p);
  geom.attributes.position.needsUpdate = true;
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
}

function fitFlat() {
  const w = flatEl.clientWidth || 1, h = flatEl.clientHeight || 1;
  const bb = flatGeom.boundingBox;
  if (!bb) return;
  if (model.line && state.euler) {
    for (const e of model.fit.euler) { bb.expandByPoint(new THREE.Vector3(e[0], e[1], 0)); }
  }
  const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2;
  const sx = (bb.max.x - bb.min.x) * 1.08 / 2, sy = (bb.max.y - bb.min.y) * 1.08 / 2;
  const k = Math.max(sx / w, sy / h);
  flatCam.left = cx - k * w; flatCam.right = cx + k * w; flatCam.top = cy + k * h; flatCam.bottom = cy - k * h;
  flatCam.updateProjectionMatrix();
  flat.setSize(w, h);
}

// ---------------------------------------------------------------- readout

const pct = (x, d = 1) => `${(100 * x).toFixed(d)}%`;
function readout() {
  const rows = [];
  if (state.cut === "gores") {
    const w = 360 / state.n;
    rows.push(["Gores", `${state.n}, each ${w.toFixed(w % 1 ? 1 : 0)}${DEG} wide`]);
    rows.push(["Width at the equator", `${Math.round((2 * PI * EARTH_KM) / state.n).toLocaleString("en")} km on the Earth`]);
    $("out").innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("");
    const stats = P.METHOD_KEYS.map((k) => [k, P.goreStats(state.n, k)]);
    $("cmp").innerHTML = '<tr><th></th><th>area</th><th>angles</th><th>stretch</th><th>edge</th></tr>' + stats.map(([k, s]) =>
      `<tr${k === state.method ? ' class="on"' : ""}><td>${k}</td><td>${s.area < 1e-6 ? "kept" : `+${pct(s.area)}`}</td><td>${s.omega < 1e-3 ? "kept" : `${s.omega.toFixed(1)}${DEG}`}</td><td>${pct(s.scale)}</td><td>+${pct(s.edge - 1, 2)}</td></tr>`).join("");
    $("cmp").hidden = false;
    $("flat-label").textContent = state.lay === "flower"
      ? `${state.n} gores flat (${state.method}), joined at the south pole`
      : state.method === "sinu" ? `${state.n} gores: the interrupted sinusoidal` : `${state.n} gores flat (${state.method}), joined at the equator`;
    $("scene-label").textContent = "Peeled from the north, joined at the south pole";
  } else {
    const { sp, fit } = model, wdeg = sp.w * R2D;
    rows.push(["Strip", `${state.turns} turns, ${wdeg.toFixed(1)}${DEG} wide (${Math.round(sp.w * EARTH_KM).toLocaleString("en")} km)`]);
    rows.push(["Length", `${sp.length.toFixed(1)} radii (${Math.round(sp.length * EARTH_KM).toLocaleString("en")} km): the area 4 pi over the width`]);
    rows.push(["Euler spiral fits", `the middle ${pct(fit.fraction, 0)} of it, within half the strip's width`]);
    $("out").innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("");
    $("cmp").hidden = true;
    $("flat-label").textContent = state.euler ? "Flat: centre line (yellow), Euler spiral (blue)" : "Flat, with its centre line";
    $("scene-label").textContent = "Peeled from the south pole, flat where it comes away";
  }
}

// ---------------------------------------------------------------- UI

const ui = {
  cut: $("cut"), n: $("n"), method: $("method"), lay: $("lay"), turns: $("turns"), p: $("p"), lon0: $("lon0"),
  skin: $("skin"), euler: $("euler"), fruit: $("fruit"), spin: $("spin")
};
for (const k of P.METHOD_KEYS) ui.method.add(new Option(P.GORE_METHODS[k].label, k));

function sync() {
  for (const k of ["cut", "method", "lay", "skin"]) ui[k].value = state[k];
  for (const k of ["n", "turns", "p", "lon0"]) ui[k].value = state[k];
  for (const k of ["euler", "fruit", "spin"]) ui[k].checked = !!state[k];
  $("n-out").textContent = state.n; $("turns-out").textContent = state.turns;
  $("p-out").textContent = state.p === 0 ? "on the orange" : state.p === 1 ? "flat" : pct(state.p, 0);
  $("lon0-out").textContent = `${state.lon0}${DEG}`;
  const g = state.cut === "gores";
  $("gore-ctl").hidden = !g; $("spiral-ctl").hidden = g;
  eulerLine.visible = !g && !!state.euler;
  outlines.visible = g;
  fruit.visible = !!state.fruit;
  writeHash();
}

for (const k of ["cut", "method", "lay"]) ui[k].addEventListener("change", () => { state[k] = ui[k].value; sync(); rebuild(); });
for (const k of ["n", "turns", "lon0"]) ui[k].addEventListener("input", () => { state[k] = +ui[k].value; sync(); rebuild(); });
ui.turns.addEventListener("change", () => { if (!state.cam) setCamera(defaultCam()); });
ui.p.addEventListener("input", () => { stopPlay(); state.p = +ui.p.value; sync(); place(); });
ui.skin.addEventListener("change", () => { state.skin = ui.skin.value; sync(); setSkin(); });
ui.euler.addEventListener("change", () => { state.euler = ui.euler.checked ? 1 : 0; sync(); fitFlat(); readout(); });
for (const k of ["fruit", "spin"]) ui[k].addEventListener("change", () => { state[k] = ui[k].checked ? 1 : 0; sync(); });

let play = null;
function stopPlay() { if (play) { cancelAnimationFrame(play.raf); play = null; $("play").textContent = "Peel"; } }
$("play").addEventListener("click", () => {
  if (play) return stopPlay();
  const from = state.p >= 1 ? 0 : state.p, t0 = performance.now(), dur = 6000 * (1 - from);
  $("play").textContent = "Stop";
  const step = (now) => {
    const f = Math.min(1, (now - t0) / dur);
    state.p = +(from + (1 - from) * f).toFixed(4);
    ui.p.value = state.p; $("p-out").textContent = pct(state.p, 0);
    place();
    if (f < 1) play.raf = requestAnimationFrame(step);
    else { play = null; $("play").textContent = "Peel"; sync(); }
  };
  play = { raf: requestAnimationFrame(step) };
});

// the flat spiral grows as the square root of its length
const defaultCam = () => {
  if (state.cut === "gores") return [4.6, 3.4, 8.4, 0, -0.5, 0];
  const k = Math.max(1, Math.sqrt(state.turns / 6));
  return [8 * k, 6.5 * k, 14 * k, 0, 0.8, 0];
};
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(defaultCam()); writeHash(); });
ui.cut.addEventListener("change", () => { state.cam = null; setCamera(defaultCam()); writeHash(); });

const main = $("stage");
new ResizeObserver(() => { main.classList.toggle("stacked", main.clientHeight > main.clientWidth); fitFlat(); }).observe(main);
window.addEventListener("hashchange", () => { readHash(); sync(); rebuild(); setSkin(); });
shareLinks("playproj: Peeling the orange", { height: 620 });

function tick() {
  if (state.spin) { skinMesh.rotation.y += 0.003; pithMesh.rotation.y = fruit.rotation.y = skinMesh.rotation.y; }
  controls.update();
  renderer.render(scene, camera);
  flat.render(flatScene, flatCam);
  requestAnimationFrame(tick);
}

sync();
rebuild();
resize();
setCamera(state.cam || defaultCam());
setSkin();
requestAnimationFrame(tick);
loadCoastline("110m").then((c) => {
  coast = c;
  land = landPolygons(coastRings(c));
  setSkin();
  document.body.classList.add("ready");
}).catch(() => document.body.classList.add("ready"));
