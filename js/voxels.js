// playproj: voxels
//
// Topography as a block of voxels. A square of ground is cut into columns
// (lon/lat cells or square metres, src/core/voxels.js), each the mean
// GEBCO elevation over its footprint, rounded to whole voxels and drawn as
// one instanced box per column, its layers coloured and edged in the
// shader. The block saves as a MagicaVoxel .vox file.

import * as THREE from "three";
import * as V from "../src/core/voxels.js";
import { loadCoastline } from "./data.js";
import { readElevation, readWindow } from "./basemap-load.js";
import { sources } from "../src/core/basemap.js";
import { saveBlob } from "./download.js";
import { makeStage, readParams, hashWriter, shareLinks, oneOf, drawLocator } from "../src/scene/index.js";

const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";

const PLACES = [
  { key: "everest", name: "Everest and the Khumbu", lon: 86.925, lat: 27.988, ext: 60 },
  { key: "maunakea", name: "Mauna Kea from the sea floor", lon: -155.5, lat: 19.6, ext: 260 },
  { key: "canyon", name: "Grand Canyon", lon: -112.15, lat: 36.15, ext: 60 },
  { key: "kilimanjaro", name: "Kilimanjaro", lon: 37.355, lat: -3.067, ext: 70 },
  { key: "tasmania", name: "Tasmania", lon: 146.6, lat: -42.0, ext: 420 },
  { key: "erebus", name: "Ross Island and Mount Erebus", lon: 167.0, lat: -77.55, ext: 90 },
  { key: "iceland", name: "Iceland", lon: -18.6, lat: 64.95, ext: 560 },
  { key: "mariana", name: "Challenger Deep", lon: 142.2, lat: 11.35, ext: 300 },
  { key: "alps", name: "Mont Blanc", lon: 6.865, lat: 45.833, ext: 50 },
  { key: "macquarie", name: "Macquarie Island", lon: 158.86, lat: -54.62, ext: 50 },
  { key: "heard", name: "Heard Island and Big Ben", lon: 73.45, lat: -53.08, ext: 60 },
  { key: "scullin", name: "Scullin Monolith", lon: 66.72, lat: -67.79, ext: 30 },
  { key: "concordia", name: "Concordia Station, Dome C", lon: 123.35, lat: -75.1, ext: 200 },
  { key: "seamounts", name: "Tasmanian seamounts", lon: 147.1, lat: -44.3, ext: 60 },
  { key: "galapagos", name: "Galapagos Islands", lon: -90.6, lat: -0.55, ext: 320 }
];

// ---------------------------------------------------------------- state

const defaults = {
  lon: PLACES[0].lon, lat: PLACES[0].lat, ext: PLACES[0].ext, n: 96, crs: "laea",
  vs: 0, vx: 4, cube: 1, water: 1, edges: 1, spin: 0, src: "gebco", tops: "classes", sides: "layers", sc: "6e6258", cam: null
};
const state = { ...defaults };
function readHash() {
  readParams(state, defaults, { crs: oneOf(Object.keys(V.CRS), "laea"), src: oneOf(["gebco", "synth"], "gebco"), tops: oneOf(["classes", "esri", "esritex"], "classes"),
    sides: oneOf(["layers", "colour", "none"], "layers"), sc: (raw) => (/^[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : undefined) });
  state.lat = Math.max(-85, Math.min(85, state.lat));
  state.lon = ((state.lon + 540) % 360) - 180;
  state.ext = Math.max(5, Math.min(3000, state.ext));
  state.n = Math.max(8, Math.min(256, Math.round(state.n)));
  state.vs = Math.max(0, Math.min(1000, state.vs));
  state.vx = Math.max(1, Math.min(100, state.vx));
}
const writeHash = hashWriter(state, defaults, { digits: 4 });

// ---------------------------------------------------------------- stage

const stage = makeStage($("three"), { bg: 0x8fb8de, fov: 35, onCamera: (c) => { state.cam = c; writeHash(); } });
const { scene, camera, controls, renderer } = stage;
const DEFAULT_CAM = [2.1, 1.9, 2.9, 0, -0.1, 0];
controls.autoRotateSpeed = 1.2;
const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);

const pal = V.PALETTE.map((p) => new THREE.Color(p ? `rgb(${p.rgb.join(",")})` : "#000"));
const uniforms = { uPal: { value: pal }, uEdges: { value: 1 }, uImg: { value: 0 }, uSides: { value: 0 }, uSideCol: { value: new THREE.Color() },
  uTex: { value: null }, uTexBox: { value: new THREE.Vector4(0, 0, 1, 1) } };

const VERT = /* glsl */ `
  attribute vec2 aSpan;
  attribute float aClass;
  attribute vec3 aRgb;
  varying vec3 vRgb;
  varying float vLayer;
  varying float vTop;
  varying float vClass;
  varying vec3 vN;
  varying vec2 vUv;
  varying vec2 vCol;
  varying vec2 vPos;
  void main() {
    vPos = (instanceMatrix * vec4(position, 1.0)).xz;
    vLayer = mix(aSpan.x, aSpan.y, position.y);
    vTop = aSpan.y;
    vClass = aClass;
    vRgb = aRgb;
    vN = normal;
    vUv = uv;
    vCol = instanceMatrix[3].xz;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }`;

// Minecraft's face shading (top bright, sides darker), a darker line at
// each voxel's edges, and a little noise per voxel.
const FRAG_COMMON = /* glsl */ `
  uniform vec3 uPal[${pal.length}];
  uniform float uEdges;
  uniform float uImg;
  uniform float uSides;
  uniform vec3 uSideCol;
  uniform sampler2D uTex;
  uniform vec4 uTexBox;
  varying vec2 vPos;
  varying vec3 vRgb;
  varying float vLayer;
  varying float vTop;
  varying float vClass;
  varying vec3 vN;
  varying vec2 vUv;
  varying vec2 vCol;
  vec3 palette(float c) {
    vec3 out_c = uPal[0];
    for (int k = 0; k < ${pal.length}; k++) if (abs(float(k) - c) < 0.5) out_c = uPal[k];
    return out_c;
  }
  float faceShade() {
    if (vN.y > 0.5) return 1.0;
    if (vN.y < -0.5) return 0.5;
    return abs(vN.z) > 0.5 ? 0.82 : 0.66;
  }
  float edgeLine() {
    float d;
    if (abs(vN.y) > 0.5) {
      vec2 e = min(vUv, 1.0 - vUv) / max(fwidth(vUv), vec2(1e-5));
      d = min(e.x, e.y);
    } else {
      float f = fract(vLayer);
      float h = min(f, 1.0 - f) / max(fwidth(vLayer), 1e-5);
      float w = min(vUv.x, 1.0 - vUv.x) / max(fwidth(vUv.x), 1e-5);
      d = min(h, w);
    }
    return 1.0 - smoothstep(0.0, 1.3, d);
  }
  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }`;

const solidMat = new THREE.ShaderMaterial({
  uniforms, vertexShader: VERT,
  fragmentShader: FRAG_COMMON + /* glsl */ `
  void main() {
    float d = max(0.0, ceil(vTop - vLayer - 1e-4) - 1.0);
    float c = vClass;
    if (d > 0.5) {
      if (abs(vClass - ${V.CLASS.grass}.0) < 0.5 && d < 2.5) c = ${V.CLASS.dirt}.0;
      else if (abs(vClass - ${V.CLASS.ice}.0) < 0.5 && d < 3.5) c = ${V.CLASS.ice}.0;
      else c = ${V.CLASS.stone}.0;
    }
    vec3 col = palette(c) * faceShade();
    // imagery on the land's top faces (aRgb.r < 0 where there is none)
    // imagery on the land's top faces (aRgb.r < 0 where there is none): the
    // column's mean colour, or the imagery itself as a texture over the block
    if (uImg > 0.5 && vN.y > 0.5 && d < 0.5 && vRgb.r >= 0.0)
      col = uImg > 1.5 ? texture2D(uTex, (vPos - uTexBox.xy) / uTexBox.zw).rgb : vRgb;
    // sides (and bottoms): the layers, one colour, or not drawn
    if (vN.y < 0.5) {
      if (uSides > 1.5) discard;
      if (uSides > 0.5) col = uSideCol * faceShade();
    }
    col *= 0.94 + 0.12 * hash(vec3(floor(vCol * 997.0), floor(vLayer)));
    col *= 1.0 - 0.32 * uEdges * edgeLine();
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`
});

const waterMat = new THREE.ShaderMaterial({
  uniforms, vertexShader: VERT, transparent: true, depthWrite: false,
  fragmentShader: FRAG_COMMON + /* glsl */ `
  void main() {
    // the sea's surface and the block's outer walls, not the walls between
    // columns: vClass holds which sides face out (1 west, 2 east, 4 south,
    // 8 north; scene z is south)
    float top = vN.y > 0.5 ? 1.0 : 0.0;
    float side = vN.x < -0.5 ? 1.0 : vN.x > 0.5 ? 2.0 : vN.z > 0.5 ? 4.0 : 8.0;
    if (vN.y < -0.5 || (top < 0.5 && mod(floor(vClass / side), 2.0) < 0.5)) discard;
    vec3 col = palette(${V.CLASS.water}.0) * (0.75 + 0.25 * faceShade());
    col *= 1.0 - 0.18 * uEdges * edgeLine() * top;
    gl_FragColor = vec4(col, top > 0.5 ? 0.55 : 0.35);
    #include <colorspace_fragment>
  }`
});

let solid = null, water = null;
function instanced(mat, count) {
  const g = box.clone();
  g.setAttribute("aSpan", new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2));
  g.setAttribute("aClass", new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
  g.setAttribute("aRgb", new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(-1), 3));
  const m = new THREE.InstancedMesh(g, mat, count);
  m.frustumCulled = false;
  scene.add(m);
  return m;
}
function dispose(m) { if (m) { scene.remove(m); m.geometry.dispose(); m.dispose(); } }

// ---------------------------------------------------------------- elevation

const cache = new Map();
let coast = null;

// The elevation window over the block, at the source level its columns
// need, kept for the next change that needs the same ground.
async function windowFor(cellDeg) {
  if (state.src === "synth") {
    const k = `synth:${state.lon},${state.lat},${state.ext}`;
    if (!cache.has(k)) cache.set(k, { ...V.syntheticWindow(state.lon, state.lat, state.ext * 1000), label: "synthetic island" });
    return cache.get(k);
  }
  // ask for half a column, or GEBCO's finest, then let the file pick its level
  const res = Math.max(1 / 240, cellDeg / 2);
  const lev = Math.round(Math.log2(res * 240));
  const k = `gebco:${state.lon},${state.lat},${state.ext},${lev}`;
  if (!cache.has(k)) {
    const b = V.groundBox(state.lon, state.lat, state.ext * 1000 * 1.45);
    const p = readElevation(b, res, status).then((w) => ({ ...w, label: "GEBCO 2026" }));
    p.catch(() => cache.delete(k));
    cache.set(k, p);
  }
  return cache.get(k);
}

// Esri imagery over the block, about two pixels a column, kept likewise.
async function imageryFor(res) {
  const lev = Math.round(Math.log2(res * 3600));
  const k = `esri:${state.lon},${state.lat},${state.ext},${lev}`;
  if (!cache.has(k)) {
    const b = V.groundBox(state.lon, state.lat, state.ext * 1000 * 1.45);
    const p = readWindow("esri", b, res, status);
    p.catch(() => cache.delete(k));
    cache.set(k, p);
  }
  return cache.get(k);
}

const status = (s) => { $("status").textContent = s; };
const TEX = 1024;   // texels on a side, for imagery textured on the tops

// ---------------------------------------------------------------- build

let built = null, job = 0;
async function build() {
  const my = ++job;
  const ext = state.ext * 1000;
  const grid = V.columnGrid(state.lon, state.lat, ext, state.n, state.crs);
  const cellDeg = grid.cellDeg || (grid.cellM / (V.R * Math.PI / 180));
  let win;
  try { win = await windowFor(cellDeg); } catch (e) {
    if (my === job) status(`Could not read GEBCO (${e.message}). The synthetic island works without it.`);
    return;
  }
  if (my !== job) return;
  let tops = null, imgNote = "";
  let tex = null;
  if (state.tops !== "classes") {
    try {
      // a texture wants about a pixel a texel, the mean colour two a column
      const textured = state.tops === "esritex";
      const img = await imageryFor(textured ? Math.min(cellDeg / 2, ext / TEX / (V.R * Math.PI / 180)) : cellDeg / 2);
      if (my !== job) return;
      tops = V.columnColours(grid, img, 2);
      if (textured) tex = V.topTexture(grid, img, TEX);
      if (img.note) imgNote = img.note;
    } catch (e) { imgNote = `the imagery did not load (${e.message})`; }
  }
  if (my !== job) return;
  status(imgNote ? `Esri imagery: ${imgNote}.` : "");
  const srcM = win.dy * (V.R * Math.PI / 180);
  const { z, s } = V.columnMeans(grid, V.sampler(win), srcM);
  let lo = Infinity, hi = -Infinity;
  for (const v of z) if (v === v) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  // the block runs from its lowest column (or sea floor) to its highest (or
  // the sea), in at most 400 layers, and drawn as cubes no taller than one
  // and a half times its width; a set height is raised to keep to that
  const relief = Math.max(hi, 0) - lo;
  const most = state.cube ? Math.min(400, Math.round(1.5 * state.n)) : 400;
  const least = autoStep((relief * 40) / most);
  const step = Math.max(state.vs > 0 ? state.vs : autoStep(relief), least);
  const raised = state.vs > 0 && step > state.vs;
  const q = V.quantise(z, step);
  const surface = new Uint8Array(z.length);
  const P = V.laea(grid.centre[0], grid.centre[1]);
  grid.cols.forEach((c, k) => { surface[k] = V.surfaceClass(z[k], c.lat !== undefined ? c.lat : P.inverse(c.x, c.y)[1]); });
  const exag = state.cube ? grid.cellM / step : state.vx;
  built = { grid, z, q, surface, step, exag, win, s, srcM, lo, hi, tops, tex, raised, most };
  draw();
  readout();
  locator();
}

// About forty voxels of relief, on a round number.
function autoStep(relief) {
  const raw = Math.max(1, relief / 40), p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= raw);
}

function draw() {
  const { grid, q, surface, step, exag, tops, tex } = built;
  const S = 2 / (state.ext * 1000), vh = step * exag * S;
  const { cols } = grid, { top, base } = q;
  dispose(solid); dispose(water);
  solid = instanced(solidMat, cols.length);
  const sea = cols.map((c, k) => k).filter((k) => top[k] < 0);
  water = state.water && sea.length ? instanced(waterMat, sea.length) : null;
  const m = new THREE.Matrix4(), span = solid.geometry.attributes.aSpan, cls = solid.geometry.attributes.aClass;
  const rgb = solid.geometry.attributes.aRgb;
  const yOff = -((base + Math.max(q.hi, 0)) / 2) * vh;
  cols.forEach((c, k) => {
    const h = (top[k] - base) * vh;
    m.makeScale(c.wx * S, Math.max(h, 1e-6), c.wy * S).setPosition(c.x * S, base * vh + yOff, -c.y * S);
    solid.setMatrixAt(k, m);
    span.setXY(k, base, top[k]);
    cls.setX(k, surface[k]);
    if (tops && tops.has[k] && top[k] > 0) rgb.setXYZ(k, ...[0, 1, 2].map((c) => (tops.rgb[3 * k + c] / 255) ** 2.2));
  });
  if (water) {
    const ws = water.geometry.attributes.aSpan, wc = water.geometry.attributes.aClass;
    sea.forEach((k, w) => {
      const c = cols[k];
      wc.setX(w, (c.i === 0 ? 1 : 0) + (c.i === grid.ni - 1 ? 2 : 0) + (c.j === 0 ? 4 : 0) + (c.j === grid.nj - 1 ? 8 : 0));
      m.makeScale(c.wx * S, -top[k] * vh, c.wy * S).setPosition(c.x * S, top[k] * vh + yOff, -c.y * S);
      water.setMatrixAt(w, m);
      ws.setXY(w, top[k], 0);
    });
    water.renderOrder = 1;
  }
  uniforms.uEdges.value = state.edges ? 1 : 0;
  uniforms.uImg.value = tex ? 2 : tops ? 1 : 0;
  if (uniforms.uTex.value) uniforms.uTex.value.dispose();
  uniforms.uTex.value = null;
  if (tex) {
    const t = new THREE.DataTexture(tex.data, tex.width, tex.height, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    uniforms.uTex.value = t;
    const b = tex.box;
    uniforms.uTexBox.value.set(b.x0 * S, -b.y1 * S, (b.x1 - b.x0) * S, (b.y1 - b.y0) * S);
  }
  uniforms.uSides.value = { layers: 0, colour: 1, none: 2 }[state.sides];
  uniforms.uSideCol.value.set("#" + state.sc);
}

// ---------------------------------------------------------------- readout

const fmtM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 2)} km` : `${Math.round(m)} m`);
const fmtLL = (lon, lat) => `${Math.abs(lat).toFixed(3)}${DEG}${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(3)}${DEG}${lon < 0 ? "W" : "E"}`;
const arcsec = (d) => { const s = d * 3600; return s >= 60 ? `${+(s / 60).toFixed(2)} arc minutes` : `${+s.toFixed(1)} arc seconds`; };

function readout() {
  const { grid, q, step, exag, win, s, srcM, lo, hi, raised, most } = built;
  const c = grid.cols, mid = c[(grid.nj >> 1) * grid.ni + (grid.ni >> 1)];
  const foot = grid.crs === "array"
    ? `${arcsec(grid.cellDeg)} square (drawn ${fmtM(mid.wx)} wide)`
    : grid.crs === "lonlat"
      ? `${arcsec(grid.cellDeg)}: ${fmtM(c[0].wx)} x ${fmtM(c[0].wy)} at the south edge, ${fmtM(c[c.length - 1].wx)} x ${fmtM(c[c.length - 1].wy)} at the north`
      : `${fmtM(grid.cellM)} square`;
  const finer = grid.cellM < srcM * 0.95;
  const srcLine = win.label === "GEBCO 2026"
    ? `GEBCO 2026 at ${arcsec(win.dy)} (${fmtM(srcM)})`
    : `synthetic island, ${fmtM(srcM)} cells`;
  const rows = [
    ["Centre", fmtLL(state.lon, state.lat)],
    ["Source", srcLine],
    ["Columns", `${grid.ni} x ${grid.nj} = ${(grid.ni * grid.nj).toLocaleString("en")}`],
    ["Footprint", foot],
    ["Each column", finer ? "finer than the source: neighbours share its cells" : `the mean of ${s * s} sample${s > 1 ? "s" : ""}`],
    ["Voxel height", `${fmtM(step)}${raised ? ` (raised from ${fmtM(state.vs)}, to keep the block in ${most} layers)` : state.vs ? "" : " (automatic)"}`],
    ["Drawn", exag > 1.005 ? `heights x ${exag.toFixed(exag < 10 ? 1 : 0)}` : "true scale"],
    ["Elevation", `${Math.round(lo).toLocaleString("en")} to ${Math.round(hi).toLocaleString("en")} m`],
    ["Layers", `${q.lo} to ${q.hi} (${q.hi - q.base} with the floor)`],
    ["Voxels", `${q.solid.toLocaleString("en")} ground${q.water ? `, ${q.water.toLocaleString("en")} water` : ""}`]
  ];
  $("out").innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("");
  $("credit").innerHTML = (win.label === "GEBCO 2026"
    ? 'GEBCO Compilation Group (2026) GEBCO 2026 Grid, from <a href="https://source.coop/ausantarctic/gebco">Source Cooperative</a>'
    : "A synthetic island") + (built.tops ? `; ${sources.esri.credit}` : "");
}

function locator() {
  if (!coast) return;
  const b = V.groundBox(state.lon, state.lat, state.ext * 1000), o = [];
  for (let t = 0; t <= 40; t++) {
    const f = t / 10, e = Math.floor(f), u = f - e;
    const pts = [[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]];
    const [a, c] = [pts[e], pts[Math.min(4, e + 1)]];
    o.push([a[0] + (c[0] - a[0]) * u, a[1] + (c[1] - a[1]) * u]);
  }
  drawLocator($("locator"), coast, state.lon, state.lat, o);
}

// ---------------------------------------------------------------- controls

function syncControls() {
  const place = PLACES.find((p) => Math.abs(p.lon - state.lon) < 1e-4 && Math.abs(p.lat - state.lat) < 1e-4 && p.ext === state.ext);
  $("place").value = place ? place.key : "";
  $("n").value = state.n; $("n-out").textContent = state.n;
  $("crs").value = state.crs;
  $("vs").value = state.vs > 0 ? Math.log10(state.vs) : 0;
  $("vs-out").textContent = state.vs > 0 ? fmtM(state.vs) : "automatic";
  $("vx").value = Math.log10(state.vx); $("vx").disabled = !!state.cube;
  $("vx-out").textContent = state.cube ? "for cubes" : `x ${state.vx.toFixed(state.vx < 10 ? 1 : 0)}`;
  $("cube").checked = !!state.cube; $("water").checked = !!state.water; $("edges").checked = !!state.edges;
  $("spin").checked = !!state.spin;
  controls.autoRotate = !!state.spin;
  $("lonlat").value = `${+state.lon.toFixed(4)}, ${+state.lat.toFixed(4)}`;
  $("ext").value = Math.log10(state.ext); $("ext-out").textContent = `${+state.ext.toFixed(state.ext < 100 ? 1 : 0)} km`;
  $("src").value = state.src;
  $("tops").value = state.tops;
  $("sides").value = state.sides;
  $("sc").value = "#" + state.sc; $("sc").hidden = state.sides !== "colour";
}

function changed({ rebuild = true, view = false } = {}) {
  writeHash(); syncControls();
  if (view) { state.cam = null; stage.setCamera(DEFAULT_CAM); }
  if (rebuild) build(); else if (built) { draw(); readout(); }
}

$("place").innerHTML = '<option value="">Somewhere else</option>' + PLACES.map((p) => `<option value="${p.key}">${p.name}</option>`).join("");
$("crs").innerHTML = Object.entries(V.CRS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");

$("place").addEventListener("change", (e) => {
  const p = PLACES.find((q) => q.key === e.target.value);
  if (!p) return;
  Object.assign(state, { lon: p.lon, lat: p.lat, ext: p.ext });
  changed({ view: true });
});
$("n").addEventListener("input", (e) => { stopSweep(); state.n = +e.target.value; changed(); });
$("crs").addEventListener("change", (e) => { state.crs = e.target.value; changed(); });
$("vs").addEventListener("input", (e) => { const v = +e.target.value; state.vs = v < 0.02 ? 0 : Math.round(10 ** v); changed(); });
$("vx").addEventListener("input", (e) => { state.vx = +(10 ** +e.target.value).toFixed(2); changed(); });
$("cube").addEventListener("change", (e) => { state.cube = e.target.checked ? 1 : 0; changed(); });
$("water").addEventListener("change", (e) => { state.water = e.target.checked ? 1 : 0; changed({ rebuild: false }); });
$("edges").addEventListener("change", (e) => { state.edges = e.target.checked ? 1 : 0; changed({ rebuild: false }); });
$("spin").addEventListener("change", (e) => { state.spin = e.target.checked ? 1 : 0; writeHash(); syncControls(); });
$("src").addEventListener("change", (e) => { state.src = e.target.value; changed(); });
$("tops").addEventListener("change", (e) => { state.tops = e.target.value; changed(); });
$("sides").addEventListener("change", (e) => { state.sides = e.target.value; changed({ rebuild: false }); });
$("sc").addEventListener("input", (e) => { state.sc = e.target.value.slice(1); changed({ rebuild: false }); });
$("ext").addEventListener("change", (e) => { state.ext = +(10 ** +e.target.value).toFixed(1); changed(); });
$("ext").addEventListener("input", (e) => { $("ext-out").textContent = `${+(10 ** +e.target.value).toFixed(1)} km`; });
$("lonlat").addEventListener("change", (e) => {
  const v = e.target.value.split(/[ ,]+/).map(Number);
  if (v.length >= 2 && v.every(isFinite)) {
    state.lon = ((v[0] + 540) % 360) - 180;
    state.lat = Math.max(-85, Math.min(85, v[1]));
  }
  changed();
});
$("reset-view").addEventListener("click", () => { state.cam = null; stage.setCamera(DEFAULT_CAM); writeHash(); });

let sweep = 0;
function stopSweep() { clearTimeout(sweep); sweep = 0; $("sweep").textContent = "Sweep 8 to 256"; }
$("sweep").addEventListener("click", () => {
  if (sweep) return stopSweep();
  const ns = [8, 16, 32, 64, 128, 256];
  let i = 0;
  $("sweep").textContent = "Stop";
  const next = () => {
    state.n = ns[i++]; changed();
    sweep = i < ns.length ? setTimeout(next, 1100) : (stopSweep(), 0);
  };
  next();
});

$("save-vox").addEventListener("click", () => {
  if (!built) return;
  try {
    const { bytes, count, size } = V.writeVox(built.q, built.grid.ni, built.grid.nj, built.surface, {
      water: !!state.water, tops: built.tops, sides: state.sides,
      sideRgb: [0, 2, 4].map((o) => parseInt(state.sc.slice(o, o + 2), 16))
    });
    const name = (PLACES.find((p) => p.key === $("place").value) || { key: "voxels" }).key;
    saveBlob(new Blob([bytes], { type: "application/octet-stream" }), `${name}-${state.crs}-${state.n}.vox`);
    $("vox-status").textContent = `${size.join(" x ")} voxels, ${count.toLocaleString("en")} written (the shell of each column).`;
  } catch (e) {
    $("vox-status").textContent = `Not written: ${e.message}. Fewer columns or a taller voxel will fit.`;
  }
});

// ---------------------------------------------------------------- go

readHash();
syncControls();
stage.setCamera(state.cam || DEFAULT_CAM);
stage.resize();
shareLinks("Voxels", { height: 560 });
window.addEventListener("hashchange", () => { readHash(); syncControls(); build(); });
loadCoastline("110m").then((c) => { coast = c; locator(); }).catch(() => {});
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
build();
