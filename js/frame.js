// playproj: Frame.
//
// Any scenespec mesh in its own CRS, with the frame a map needs: where it
// is on the Earth (a locator globe), the graticule, what the CRS does to it
// (PROJ's factors at every vertex), and the map unfolded onto the WGS84
// ellipsoid. The scene and its Arrow tables are read by src/load; the two
// homes and the graticule are src/core/meshframe.js; the drawing is
// src/scene/meshlayer.js.

import * as THREE from "three";
import { tableFromIPC } from "apache-arrow";
import * as L from "../src/load/scene.js";
import { palette, PALETTES } from "../src/core/palette.js";
import { mapHome, earthHome, homeGap, graticuleLines, lonLatBox } from "../src/core/meshframe.js";
import { ellipsoid } from "../src/core/ellipsoid.js";
import { knownProj4, parseCrsRef } from "../src/core/structure.js";
import { factors, proj4Forward } from "../src/core/tissot.js";
import { FIELD, colourScale } from "../src/core/distortion.js";
import { loadCoastline } from "./data.js";
import { makeStage, readParams, hashWriter, shareLinks, makeMeshLayer, drawLocator, cssRamp } from "../src/scene/index.js";

const DEFAULT_SCENE = "data/frame/juneau/scene.json";
const WGS84 = ellipsoid(6378137, 1 / 298.257223563);
const DEG = "\u00b0";
const COLORS = { bg: 0x05070d, grat: 0x7f93ab, pick: 0xffd34d };

// ---------------------------------------------------------------- state

const defaults = { scene: DEFAULT_SCENE, t: 0, gx: 0, dz: 0, col: "scene", grat: 1, globe: 1, pick: -1, cam: null };
const state = { ...defaults };
const COLOURS = ["scene", "k", "h", "s", "omega", "conv"];

function readHash() {
  readParams(state, defaults, { scene: String, col: (raw) => (COLOURS.includes(raw) ? raw : "scene") });
  state.t = Math.max(0, Math.min(1, state.t));
  state.gx = Math.max(0, Math.min(4, state.gx));
  state.dz = Math.max(-1, Math.min(2, state.dz));
  state.pick = Math.round(state.pick);
}
const writeHash = hashWriter(state, defaults);

const $ = (id) => document.getElementById(id);
const ui = {
  t: $("t"), tOut: $("t-out"), gx: $("gx"), gxOut: $("gx-out"), dz: $("dz"), dzOut: $("dz-out"), gap: $("gap"),
  colour: $("colour"), legend: $("legend"), ramp: document.querySelector(".legend-ramp"),
  lo: $("legend-lo"), hi: $("legend-hi"), title: $("legend-title"), dist: $("dist"),
  grat: $("grat"), globe: $("globe"), locator: $("locator"),
  crs: $("crs-table").tBodies[0], pick: $("pick-table").tBodies[0], pickHint: $("pick-hint"),
  url: $("scene-url"), load: $("load"), files: $("files"), status: $("status"), credit: $("credit")
};

// ---------------------------------------------------------------- stage

const { renderer, scene: world, camera, controls, setCamera, resize } = makeStage($("three"), {
  bg: COLORS.bg, fov: 35, near: 0.1, far: 1e7,
  onCamera: (cam) => { state.cam = cam; writeHash(); }
});
world.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(-0.6, 1, 0.4);
world.add(sun);

// ---------------------------------------------------------------- the CRS

const lookups = new Map();
async function lookupEpsg(code) {
  if (!lookups.has(code)) {
    lookups.set(code, (async () => {
      for (const u of [`https://spatialreference.org/ref/epsg/${code}/proj4.txt`, `https://epsg.io/${code}.proj4`]) {
        try {
          const r = await fetch(u);
          if (!r.ok) continue;
          const t = (await r.text()).trim();
          if (t.startsWith("+proj")) return t;
        } catch (e) { /* try the next */ }
      }
      return null;
    })());
  }
  return lookups.get(code);
}

// { label, def, fwd(lon, lat) -> [x, y], inv(x, y) -> [lon, lat], unit }
async function resolveCrs(crs) {
  const ref = parseCrsRef(typeof crs === "string" ? crs : crs && crs.id ? crs : null);
  if (!ref) throw new Error("the scene's view CRS is not one this page can read");
  const label = ref.epsg ? `EPSG:${ref.epsg}` : "PROJ string";
  const def = ref.proj4 || (ref.epsg && (knownProj4(ref.epsg) || (await lookupEpsg(ref.epsg))));
  if (!def) throw new Error(`no PROJ definition found for ${label}`);
  const tr = proj4("EPSG:4326", def);
  const ok = (q) => q && Number.isFinite(q[0]) && Number.isFinite(q[1]);
  const fwd = (lon, lat) => { try { const q = tr.forward([lon, lat]); return ok(q) ? q : null; } catch (e) { return null; } };
  const inv = (x, y) => { try { const q = tr.inverse([x, y]); return ok(q) && Math.abs(q[1]) <= 90 ? q : null; } catch (e) { return null; } };
  return { label, def, fwd, inv, P: proj4Forward(proj4, def, { check: false }) };
}

// ---------------------------------------------------------------- the scene

let cur = null;   // { loaded, layer, mesh, crs, homes, drawn, box, ... }
let coast = null;
loadCoastline("110m").then((c) => { coast = c; drawGlobe(); });

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toLocaleString("en", { maximumFractionDigits: d, minimumFractionDigits: 0 }) : "");
const metres = (m) => (m >= 1000 ? `${fmt(m / 1000, 2)} km` : m >= 1 ? `${fmt(m, 2)} m` : `${fmt(m * 100, 2)} cm`);
const lonlatText = (ll) => `${fmt(Math.abs(ll[1]), 5)}${DEG}${ll[1] < 0 ? "S" : "N"}, ${fmt(Math.abs(ll[0]), 5)}${DEG}${ll[0] < 0 ? "W" : "E"}`;

async function open(url, fetchFn) {
  ui.status.textContent = "Reading the scene...";
  try {
    const loaded = await L.loadScene(url, { tableFromIPC, fetch: fetchFn });
    const layer = loaded.scene.layers.find((x) => x.kind === "mesh");
    if (!layer) throw new Error("the scene has no mesh layer");
    const mesh = L.meshArrays(loaded, layer);
    const crs = await resolveCrs(mesh.crs);
    show({ loaded, layer, mesh, crs });
    ui.status.textContent = "";
  } catch (e) {
    ui.status.textContent = e.message;
    console.error(e);
  }
}

function show(next) {
  if (cur) { world.remove(cur.drawn.object); cur.drawn.dispose(); if (cur.grat) { world.remove(cur.grat); cur.grat.geometry.dispose(); } }
  cur = next;
  const { mesh, layer, crs } = cur;
  cur.zScale = layer.z_scale ?? 1;
  cur.extent = L.extentOf(mesh.position, mesh.size);
  const full = [cur.extent[0] + mesh.origin[0], cur.extent[1] + mesh.origin[0], cur.extent[2] + mesh.origin[1], cur.extent[3] + mesh.origin[1]];
  cur.box = lonLatBox(crs.inv, full);
  cur.centre = crs.inv((full[0] + full[1]) / 2, (full[2] + full[3]) / 2);
  cur.sceneColour = L.meshColours(mesh, layer, palette);
  cur.fields = null;
  cur.drawn = makeMeshLayer(mesh, cur.sceneColour, { stroke: layer.stroke || null });
  world.add(cur.drawn.object);
  homes();
  colour();
  crsTable();
  drawGlobe();
  ui.credit.textContent = layer.label || "";
  if (state.cam) setCamera(state.cam); else fitView();
  sync();
}

// both homes at the current height; positions follow the sliders
function homes() {
  const { mesh, crs } = cur, z = cur.zScale * 10 ** state.dz;
  cur.map = mapHome(mesh.position, mesh.size, z);
  cur.earth = earthHome(mesh.position, mesh.size, mesh.origin, crs.inv, WGS84, z).out;
  cur.gap = homeGap(cur.map, cur.earth);
  cur.at = new Float32Array(cur.map.length);
  graticule(z);
  place();
}

function place() {
  const f = state.t * 10 ** state.gx, { map, earth, at } = cur;
  for (let i = 0; i < at.length; i++) at[i] = map[i] + (earth[i] - map[i]) * f;
  cur.drawn.setPositions(at);
  if (cur.grat) {
    const g = cur.gratHomes, p = cur.grat.geometry.attributes.position;
    for (let i = 0; i < p.array.length; i++) p.array[i] = g.map[i] + (g.earth[i] - g.map[i]) * f;
    p.needsUpdate = true;
    cur.grat.geometry.computeBoundingSphere();
  }
  pickMark();
}

// meridians and parallels through the mesh's extent, at its lowest height
function graticule(z) {
  if (cur.grat) { world.remove(cur.grat); cur.grat.geometry.dispose(); cur.grat = null; }
  const { mesh, crs, extent, box } = cur;
  const { lines, step } = graticuleLines(box.west, box.east, box.south, box.north, { n: 5, res: 64 });
  cur.gratStep = step;
  let h0 = 0;
  if (mesh.size > 2) { h0 = Infinity; for (let i = 2; i < mesh.position.length; i += 3) h0 = Math.min(h0, mesh.position[i]); }
  const inside = (x, y) => x >= extent[0] && x <= extent[1] && y >= extent[2] && y <= extent[3];
  const segs = [];
  for (const line of lines) {
    let prev = null;
    for (const [lon, lat] of line.points) {
      const q = crs.fwd(lon, lat);
      const p = q && [q[0] - mesh.origin[0], q[1] - mesh.origin[1]];
      if (p && prev && inside(p[0], p[1]) && inside(prev[0], prev[1])) segs.push(prev[0], prev[1], h0, p[0], p[1], h0);
      prev = p;
    }
  }
  if (!segs.length) return;
  const pos = new Float32Array(segs);
  const map = mapHome(pos, 3, z), earth = earthHome(pos, 3, mesh.origin, crs.inv, WGS84, z).out;
  cur.gratHomes = { map, earth };
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(map.length), 3));
  // drawn over the surface (it lies at the lowest height, under the terrain)
  cur.grat = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: COLORS.grat, transparent: true, opacity: 0.7, depthTest: false }));
  cur.grat.renderOrder = 1;
  cur.grat.visible = !!state.grat;
  world.add(cur.grat);
}

// ---------------------------------------------------------------- colour

// PROJ's factors at every vertex, once per scene
function vertexFactors() {
  if (cur.fields) return cur.fields;
  const { mesh, crs } = cur, P = crs.P, n = mesh.nv;
  const out = {};
  for (const k of COLOURS.slice(1)) out[k] = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const ll = crs.inv(mesh.position[i * mesh.size] + mesh.origin[0], mesh.position[i * mesh.size + 1] + mesh.origin[1]);
    const f = ll && P && factors(P.fwd, ll[0], ll[1], { es: P.es });
    if (!f) continue;
    for (const k of COLOURS.slice(1)) out[k][i] = FIELD.get(k).get(f);
  }
  cur.fields = out;
  return out;
}

const range = (a) => { let lo = Infinity, hi = -Infinity; for (const v of a) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } return [lo, hi]; };

function colour() {
  const { layer, mesh } = cur;
  const k = state.col;
  if (k === "scene") {
    cur.drawn.setColours(cur.sceneColour);
    const fb = layer.fill_by;
    ui.legend.hidden = !fb;
    if (fb) {
      const lg = (cur.loaded.scene.legends || []).find((x) => x.layer === layer.id);
      ui.ramp.style.background = cssRamp(PALETTES[fb.palette.name] || PALETTES.grey);
      ui.lo.textContent = fmt(fb.palette.range[0]); ui.hi.textContent = fmt(fb.palette.range[1]);
      ui.title.textContent = (lg && lg.title) || `${fb.column} (${fb.table === "faces" ? "per triangle" : "per vertex"})`;
    }
  } else {
    const values = vertexFactors()[k];
    const sc = colourScale(k, values);
    const out = new Float32Array(mesh.nv * 3);
    for (let i = 0; i < mesh.nv; i++) {
      const c = Number.isFinite(values[i]) ? sc.rgb(values[i]) : [92, 84, 102];
      out[3 * i] = c[0] / 255; out[3 * i + 1] = c[1] / 255; out[3 * i + 2] = c[2] / 255;
    }
    cur.drawn.setColours({ colour: out, flat: false });
    const stops = Array.from({ length: 9 }, (_, j) => sc.rgb(sc.at(j / 8)).map(Math.round));
    ui.legend.hidden = false;
    ui.ramp.style.background = cssRamp(stops);
    ui.lo.textContent = fmt(sc.lo, 5); ui.hi.textContent = fmt(sc.hi, 5);
    ui.title.textContent = FIELD.get(k).label;
  }
  distText();
}

function distText() {
  if (!cur.fields && state.col === "scene") {
    ui.dist.textContent = "Choose a distortion field to colour the mesh by what its CRS does to it.";
    return;
  }
  const f = vertexFactors(), [k0, k1] = range(f.k), [h0, h1] = range(f.h), [, w1] = range(f.omega), [c0, c1] = range(f.conv);
  const cmin = c0 <= 0 && c1 >= 0 ? 0 : Math.min(Math.abs(c0), Math.abs(c1)), cmax = Math.max(Math.abs(c0), Math.abs(c1));
  const conv = cmax < 1e-4 ? "Grid north is true north." :
    `Grid north is ${fmt(cmin, 3)}${DEG} to ${fmt(cmax, 3)}${DEG} from true north.`;
  ui.dist.textContent = `Over this mesh ${cur.crs.label} scales by ${fmt(Math.min(k0, h0), 6)} to ${fmt(Math.max(k1, h1), 6)}` +
    (w1 < 1e-3 ? ", conformally (no angular distortion). " : `, with angular distortion up to ${fmt(w1, 3)}${DEG}. `) + conv;
}

// ---------------------------------------------------------------- readouts

function crsTable() {
  const { crs, mesh, centre, box, gap } = cur;
  const rows = [
    ["View CRS", crs.label],
    ["Local origin", `${fmt(mesh.origin[0], 2)}, ${fmt(mesh.origin[1], 2)}`],
    ["Centre", centre ? lonlatText(centre) : ""],
    ["Extent", `${metres(cur.extent[1] - cur.extent[0])} by ${metres(cur.extent[3] - cur.extent[2])}`],
    ["Triangles", fmt(mesh.ntri, 0)],
    ["Graticule", `every ${cur.gratStep >= 1 ? fmt(cur.gratStep, 0) + DEG : cur.gratStep >= 1 / 60 ? fmt(cur.gratStep * 60, 2) + "'" : fmt(cur.gratStep * 3600, 2) + "\""}`]
  ];
  ui.crs.innerHTML = "";
  for (const [a, b] of rows) ui.crs.insertRow().append(Object.assign(document.createElement("td"), { textContent: a }), Object.assign(document.createElement("td"), { textContent: b }));
  ui.gap.textContent = `Map and Earth differ by up to ${metres(gap.max)} here (root mean square ${metres(gap.rms)}).`;
  void box;
}

function drawGlobe() {
  ui.locator.hidden = !state.globe;
  if (!cur || !cur.centre || !state.globe) return;
  const b = cur.box;
  const outline = b.polar
    ? Array.from({ length: 73 }, (_, i) => [-180 + 5 * i, b.north < 0 ? b.north : b.south])
    : [[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north]];
  drawLocator(ui.locator, coast, cur.centre[0], cur.centre[1], outline);
}

// ---------------------------------------------------------------- picking

const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let mark = null;

function pickMark() {
  if (mark) { world.remove(mark); mark.geometry.dispose(); mark = null; }
  if (!cur || state.pick < 0 || state.pick >= cur.mesh.ntri) return;
  const t = state.pick, idx = cur.mesh.index, p = [];
  for (const k of [0, 1, 2, 0]) { const v = 3 * idx[3 * t + k]; p.push(cur.at[v], cur.at[v + 1], cur.at[v + 2]); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(p), 3));
  mark = new THREE.Line(g, new THREE.LineBasicMaterial({ color: COLORS.pick, depthTest: false }));
  mark.renderOrder = 2;
  world.add(mark);
}

function pickTable() {
  ui.pick.innerHTML = "";
  if (!cur || state.pick < 0 || state.pick >= cur.mesh.ntri) { ui.pickHint.hidden = false; return; }
  ui.pickHint.hidden = true;
  const { mesh, layer, crs } = cur, t = state.pick, idx = mesh.index, s = mesh.size;
  let x = 0, y = 0, h = 0;
  for (let k = 0; k < 3; k++) { const v = idx[3 * t + k] * s; x += mesh.position[v] / 3; y += mesh.position[v + 1] / 3; if (s > 2) h += mesh.position[v + 2] / 3; }
  const ll = crs.inv(x + mesh.origin[0], y + mesh.origin[1]);
  const rows = [
    ["Triangle (face row)", fmt(t, 0)],
    ["Vertices", `${idx[3 * t]}, ${idx[3 * t + 1]}, ${idx[3 * t + 2]}`],
    ["Centre in the CRS", `${fmt(x + mesh.origin[0], 2)}, ${fmt(y + mesh.origin[1], 2)}`],
    ["Centre", ll ? lonlatText(ll) : ""],
    ...(s > 2 ? [["Height", fmt(h, 2)]] : []),
    ...L.facePopup(mesh, layer, t).map(([k, v]) => [k, typeof v === "number" ? fmt(v, 4) : String(v)])
  ];
  for (const [a, b] of rows) ui.pick.insertRow().append(Object.assign(document.createElement("td"), { textContent: a }), Object.assign(document.createElement("td"), { textContent: b }));
}

let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!cur || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObject(cur.drawn.mesh, false)[0];
  state.pick = hit ? hit.faceIndex : -1;
  pickMark(); pickTable(); writeHash();
});

// ---------------------------------------------------------------- view

// fit the mesh where it is now (unfolded and exaggerated, or not)
function fitView() {
  const b = cur.drawn.mesh.geometry.boundingBox, size = Math.max(b.max.x - b.min.x, b.max.z - b.min.z, b.max.y - b.min.y);
  camera.near = size / 2000; camera.far = size * 2000; camera.updateProjectionMatrix();
  const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2, cz = (b.min.z + b.max.z) / 2;
  setCamera([cx + 0.55 * size, cy + 0.75 * size, cz + 0.95 * size, cx, cy, cz]);
}

function sync() {
  ui.t.value = state.t; ui.tOut.textContent = `${Math.round(state.t * 100)}%`;
  ui.gx.value = state.gx; ui.gxOut.textContent = `x ${fmt(10 ** state.gx, 0)}`;
  ui.dz.value = state.dz; ui.dzOut.textContent = cur ? `x ${fmt(cur.zScale * 10 ** state.dz, 2)}` : "";
  ui.colour.value = state.col;
  ui.grat.checked = !!state.grat; ui.globe.checked = !!state.globe;
  ui.url.value = state.scene.startsWith("local:") ? "" : state.scene;
  if (cur && cur.grat) cur.grat.visible = !!state.grat;
  pickTable();
}

// ---------------------------------------------------------------- controls

ui.t.addEventListener("input", () => { state.t = +ui.t.value; if (cur) place(); sync(); writeHash(); });
ui.gx.addEventListener("input", () => { state.gx = +ui.gx.value; if (cur) place(); sync(); writeHash(); });
ui.dz.addEventListener("input", () => { state.dz = +ui.dz.value; if (cur) homes(); sync(); writeHash(); });
ui.colour.addEventListener("change", () => { state.col = ui.colour.value; if (cur) colour(); writeHash(); });
ui.grat.addEventListener("change", () => { state.grat = ui.grat.checked ? 1 : 0; sync(); writeHash(); });
ui.globe.addEventListener("change", () => { state.globe = ui.globe.checked ? 1 : 0; drawGlobe(); writeHash(); });
$("reset-view").addEventListener("click", () => { state.cam = null; if (cur) fitView(); writeHash(); });

function loadUrl() {
  const u = ui.url.value.trim();
  if (!u) return;
  state.scene = u; state.cam = null; state.pick = -1; writeHash();
  open(new URL(u, location.href).href);
}
ui.load.addEventListener("click", loadUrl);
ui.url.addEventListener("keydown", (e) => { if (e.key === "Enter") loadUrl(); });

// a scene and its tables chosen together: each is fetched by its file name
ui.files.addEventListener("change", () => {
  const files = new Map([...ui.files.files].map((f) => [f.name, f]));
  const sceneFile = [...files.values()].find((f) => f.name.endsWith(".json"));
  if (!sceneFile) { ui.status.textContent = "Choose the scene's .json file with its .arrows files."; return; }
  const local = (u) => {
    const f = files.get(decodeURIComponent(u.split("/").pop()));
    return Promise.resolve(f ? new Response(f) : new Response(null, { status: 404 }));
  };
  state.scene = "local:" + sceneFile.name; state.cam = null; state.pick = -1;
  open("https://local.invalid/" + sceneFile.name, local);
});

shareLinks("Frame");
window.addEventListener("hashchange", () => {
  const was = state.scene;
  readHash();
  if (state.scene !== was && !state.scene.startsWith("local:")) open(new URL(state.scene, location.href).href);
  else if (cur) { homes(); colour(); drawGlobe(); if (state.cam) setCamera(state.cam); }
  sync();
});

readHash();
sync();
resize();
if (typeof proj4 === "undefined") ui.status.textContent = "proj4js did not load.";
else open(new URL(state.scene.startsWith("local:") ? DEFAULT_SCENE : state.scene, location.href).href);

renderer.setAnimationLoop(() => { controls.update(); renderer.render(world, camera); });
