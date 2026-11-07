// playproj: story
//
// A block set down on real ground. A square of terrain (the Tasmania 2 m
// DEM where there is one, GEBCO 2026 round it, or GEBCO alone to see what
// 460 m cells do to a gully) is drawn as a mesh in metres on an
// equal-area plane, draped with Esri World Imagery, and a box of storeys
// (ten storeys of 3 m on a 30 m square: a 30 m cube) stands on the lowest
// ground under its footprint. Double-click the ground to move it.

import * as THREE from "three";
import * as V from "../src/core/voxels.js";
import * as St from "../src/core/story.js";
import { readElevation, readWindow, readTiles } from "./basemap-load.js";
import { sources } from "../src/core/basemap.js";
import { openDem, readDemWindow } from "./dem-load.js";
import { loadCoastline } from "./data.js";
import { makeStage, readParams, hashWriter, shareLinks, oneOf, drawLocator } from "../src/scene/index.js";

const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";
const D2R = Math.PI / 180;

const PLACES = [
  { key: "mcrobies", name: "McRobies Gully, Hobart", lon: 147.2869, lat: -42.8876, ext: 1.5, ox: 147.2869, oy: -42.8876 },
  { key: "kunanyi", name: "kunanyi / Mount Wellington summit", lon: 147.2365, lat: -42.8955, ext: 2, ox: 147.2365, oy: -42.8955 },
  { key: "cove", name: "Sullivans Cove, Hobart", lon: 147.334, lat: -42.8835, ext: 1.5, ox: 147.3305, oy: -42.8822 },
  { key: "cradle", name: "Cradle Mountain and Dove Lake", lon: 145.951, lat: -41.668, ext: 4, ox: 145.9615, oy: -41.6545 }
];

// Stories: a quantity set down somewhere, with what it is and where the
// number comes from. Each sets the place, the block and the caption.
const MP = { lon: 147.3375, lat: -42.8797 };   // the Macquarie Point site, cleared for the stadium
const STORIES = [
  {
    key: "mp-tip", name: "Macquarie Point soil at the tip",
    place: "mcrobies", q: 50000, qu: "t", mat: "soil", shape: "cube",
    text: "About 50,000 t of clean fill and Class 2 contaminated soil from the Macquarie Point stadium site, trucked to the McRobies Gully tip at about 1,325 t a week. As soil in place (1.8 t/m3) that is a cube about 30 m on a side: ten storeys.",
    src: "https://www.newsbeep.com/au/955846/", srcName: "reported 7 November 2026"
  },
  {
    key: "mp-all", name: "All of Macquarie Point's contaminated soil",
    lon: MP.lon, lat: MP.lat, ext: 1.5, ox: MP.lon, oy: MP.lat, q: 298000, qu: "t", mat: "soil", shape: "cube",
    text: "Up to 298,000 t of contaminated material under the Macquarie Point stadium site (the EPA's estimate of June 2026), as one cube of soil in place (1.8 t/m3) standing on the site.",
    src: "https://tasgreensmps.org/parliament/speeches/excavation-and-removal-of-contaminated-soil-at-macquarie-point/", srcName: "EPA figures quoted in the Legislative Council, August 2026"
  },
  {
    key: "mp-pit", name: "The same, scraped out of Macquarie Point",
    lon: MP.lon, lat: MP.lat, ext: 1.5, ox: MP.lon, oy: MP.lat, q: 298000, qu: "t", mat: "soil", shape: "pit", bw: 200, bd: 200,
    text: "The same 298,000 t (about 166,000 m3 of soil in place) as a hole: dug out evenly over a 200 m square of the site it is about 4 m deep. The square is for scale, not the stadium's footprint.",
    src: "https://tasgreensmps.org/parliament/speeches/excavation-and-removal-of-contaminated-soil-at-macquarie-point/", srcName: "EPA figures quoted in the Legislative Council, August 2026"
  },
  {
    key: "tip-year", name: "A year at the tip's limit",
    place: "mcrobies", q: 85000, qu: "t", mat: "waste", shape: "cube",
    text: "McRobies Gully may take up to 85,000 t a year. As mixed waste compacted in a landfill (about 0.8 t/m3, a typical figure) a year at the limit is a cube about 47 m on a side.",
    src: "https://www.newsbeep.com/au/955846/", srcName: "regulatory limit as reported 7 November 2026"
  },
  {
    key: "co2", name: "A tonne of CO2 on Sullivans Cove",
    place: "cove", q: 1, qu: "t", mat: "co2", shape: "cube",
    text: "One tonne of carbon dioxide as a gas at 15 C and sea-level pressure (1.87 kg/m3) fills about 535 m3: a cube about 8 m on a side.",
    src: "", srcName: "ideal gas density"
  }
];

// the state a story sets
function storyState(t) {
  const p = t.place ? PLACES.find((x) => x.key === t.place) : t;
  const out = { lon: p.lon, lat: p.lat, ext: p.ext, ox: p.ox, oy: p.oy, q: t.q, qu: t.qu, mat: t.mat, shape: t.shape, rot: 0 };
  if (t.bw) Object.assign(out, { bw: t.bw, bd: t.bd });
  return out;
}

// as voxels.js: finer DEMs where the ground is over them
const REGIONAL = [
  {
    key: "tas", name: "Tasmania 2 m DEM",
    url: "https://data.source.coop/alexgleith/tasmania-dem-2m/Tasmania_Statewide_2m_DEM_14-08-2021.tif",
    box: { west: 143.5, east: 148.6, south: -43.9, north: -39.3 },
    credit: 'Tasmania 2 m DEM, Mineral Resources Tasmania, The LIST &copy; State of Tasmania (CC BY 3.0 AU), from <a href="https://source.coop/alexgleith/tasmania-dem-2m">Source Cooperative</a>'
  }
];

// ---------------------------------------------------------------- state

const P0 = PLACES[0];
const defaults = {
  lon: P0.lon, lat: P0.lat, ext: P0.ext, n: 384, src: "dem", img: "esri", vx: 1,
  ox: P0.ox, oy: P0.oy, st: 10, sh: 3, bw: 30, bd: 30, rot: 0, bc: "e9e4d8", shadow: 1,
  q: 0, qu: "t", mat: "soil", shape: "cube", story: "", cam: null
};
const state = { ...defaults };
const hex = (raw) => (/^[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : undefined);
function readHash() {
  const h = readParams(state, defaults, { src: oneOf(["dem", "gebco"], "dem"), img: oneOf(["esri", "list", "relief"], "esri"), bc: hex,
    qu: oneOf(["t", "m3"], "t"), mat: oneOf(Object.keys(St.MATERIALS), "soil"), shape: oneOf(["cube", "slab", "pit"], "cube"),
    story: oneOf(["", ...STORIES.map((t) => t.key)], "") });
  // a story in the link brings its own place and quantity, under any key
  // the link also names
  const t = STORIES.find((x) => x.key === state.story);
  if (t) for (const [k, v] of Object.entries(storyState(t))) if (!h.has(k)) state[k] = v;
  state.q = Math.max(0, Math.min(1e12, state.q));
  state.lat = Math.max(-85, Math.min(85, state.lat));
  state.lon = ((state.lon + 540) % 360) - 180;
  state.ext = Math.max(0.2, Math.min(50, state.ext));
  state.n = Math.max(16, Math.min(768, Math.round(state.n)));
  state.vx = Math.max(0.5, Math.min(20, state.vx));
  state.st = Math.max(1, Math.min(200, Math.round(state.st)));
  state.sh = Math.max(1, Math.min(20, state.sh));
  state.bw = Math.max(1, Math.min(2000, state.bw));
  state.bd = Math.max(1, Math.min(2000, state.bd));
  state.rot = ((state.rot % 360) + 360) % 360;
}
const writeHash = hashWriter(state, defaults, { digits: 5 });

// ---------------------------------------------------------------- stage

const stage = makeStage($("three"), { bg: 0xb9d3ea, fov: 35, near: 0.002, far: 50, onCamera: (c) => { state.cam = c; writeHash(); } });
const { scene, camera, controls, renderer } = stage;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// the sun from the north (this is the southern hemisphere's default
// story) and a little west, about 45 degrees up; scene z is south
const SUN = new THREE.Vector3(-0.45, 1.0, -0.75).normalize();
scene.add(new THREE.HemisphereLight(0xdfeaff, 0x5a5040, 0.85));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.9);
sun.position.copy(SUN).multiplyScalar(3);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -1.6, right: 1.6, top: 1.6, bottom: -1.6, near: 0.1, far: 8 });
sun.shadow.bias = -0.0001;
sun.shadow.normalBias = 0.0004;
scene.add(sun, sun.target);

// the block: storey lines and windows on its sides, a flat roof, drawn in
// its own metres (uSize) so the bands stay at true storey height
const blockUniforms = {
  uSize: { value: new THREE.Vector3(30, 30, 30) }, uStorey: { value: 3 }, uCol: { value: new THREE.Color() },
  uSun: { value: SUN.clone() }, uPlain: { value: 0 }, uAlpha: { value: 1 }
};
const blockMat = new THREE.ShaderMaterial({
  uniforms: blockUniforms,
  vertexShader: /* glsl */ `
    uniform vec3 uSize;
    varying vec3 vLocal;
    varying vec3 vN;
    varying vec3 vObjN;
    void main() {
      vLocal = (position + vec3(0.5, 0.0, 0.5)) * uSize;
      vObjN = normal;
      vN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uSize;
    uniform float uStorey;
    uniform vec3 uCol;
    uniform vec3 uSun;
    uniform float uPlain;
    uniform float uAlpha;
    varying vec3 vLocal;
    varying vec3 vN;
    varying vec3 vObjN;
    void main() {
      vec3 col = uCol;
      if (uPlain < 0.5 && vObjN.y < 0.5 && vObjN.y > -0.5) {
        // along the face, in metres, and up it in storeys
        float along = abs(vObjN.x) > 0.5 ? vLocal.z : vLocal.x;
        float s = vLocal.y / uStorey, f = fract(s);
        float bay = fract(along / 1.6);
        float glass = step(0.3, f) * step(f, 0.82) * step(0.12, bay) * step(bay, 0.88);
        // no windows within half a metre of the corners, nor in the top storey's parapet
        float width = abs(vObjN.x) > 0.5 ? uSize.z : uSize.x;
        glass *= step(0.6, along) * step(along, width - 0.6);
        col = mix(col, vec3(0.16, 0.22, 0.30), glass * 0.85);
        float line = 1.0 - smoothstep(0.0, 1.5, min(f, 1.0 - f) / max(fwidth(s), 1e-5));
        col *= 1.0 - 0.35 * line;
      }
      float light = 0.45 + 0.55 * max(dot(normalize(vN), uSun), 0.0);
      gl_FragColor = vec4(col * light, uAlpha);
      #include <colorspace_fragment>
    }`
});
const block = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), blockMat);
block.castShadow = true;
const blockEdges = new THREE.LineSegments(new THREE.EdgesGeometry(block.geometry), new THREE.LineBasicMaterial({ color: 0x2b2b2b }));
block.add(blockEdges);
scene.add(block);
// a thin pin above the block, to find it from far away
const pin = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)]),
  new THREE.LineBasicMaterial({ color: 0xd2342a }));
scene.add(pin);

let ground = null, skirt = null;
const groundMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
const skirtMat = new THREE.MeshLambertMaterial({ color: 0x6e6258 });

// ---------------------------------------------------------------- sources

const cache = new Map();
let coast = null;
const status = (s) => { $("status").textContent = s; };
// texels across the square: more for the LIST orthophoto, which goes to
// about 0.2 m at zoom 19
const TEX = { esri: 2048, list: 4096 };

function once(k, f) {
  if (!cache.has(k)) {
    const p = f();
    p.catch(() => cache.delete(k));
    cache.set(k, p);
  }
  return cache.get(k);
}

// GEBCO round the ground, always: it is the fallback, and the comparison
function gebcoFor(cellM) {
  const res = Math.max(1 / 240, cellM / 2 / (V.R * D2R));
  return once(`gebco:${state.lon},${state.lat},${state.ext},${Math.round(Math.log2(res * 240))}`, () =>
    readElevation(V.groundBox(state.lon, state.lat, state.ext * 1000 * 1.45), res, status));
}

function demFor(cellM) {
  if (state.src !== "dem") return null;
  const b = V.groundBox(state.lon, state.lat, state.ext * 1000);
  const reg = REGIONAL.find((r) => b.west < r.box.east && b.east > r.box.west && b.south < r.box.north && b.north > r.box.south);
  if (!reg) return null;
  return once(`${reg.key}:${state.lon},${state.lat},${state.ext},${state.n}`, async () => {
    const dem = await openDem(reg.url, status);
    const pts = V.blockOutline(state.lon, state.lat, state.ext * 1000 * 1.02, "laea");
    const win = await readDemWindow(dem, pts, cellM, state.lat, status);
    return win && { reg, win, dem };
  });
}

function imageryFor(kind) {
  const ext = state.ext * 1000, res = ext / TEX[kind] / (V.R * D2R), box = V.groundBox(state.lon, state.lat, ext * 1.1);
  return once(`${kind}:${state.lon},${state.lat},${state.ext}`, () => kind === "list"
    ? readTiles("list", box, res, status, { maxTiles: 256 })
    : readWindow("esri", box, res, status, { maxTiles: 196 }));
}

// ---------------------------------------------------------------- build

let built = null, job = 0;
async function build() {
  const my = ++job;
  const ext = state.ext * 1000;
  const grid = St.terrainGrid(state.lon, state.lat, ext, state.n);
  let gebco;
  try { gebco = await gebcoFor(grid.cellM); } catch (e) {
    if (my === job) status(`Could not read GEBCO (${e.message}).`);
    return;
  }
  if (my !== job) return;
  const notes = [];
  let fine = null;
  try { fine = await demFor(grid.cellM); } catch (e) { notes.push(`the 2 m DEM did not load (${e.message}), so this is GEBCO alone`); }
  if (my !== job) return;
  let img = null, drape = state.img;
  if (drape === "list") {
    // the state orthophoto, or Esri where it does not load
    try { img = await imageryFor("list"); } catch (e) { notes.push(`the LIST orthophoto did not load (${e.message}), so this is Esri`); drape = "esri"; }
  }
  if (drape === "esri" && !img) {
    try {
      img = await imageryFor("esri");
      if (img.note) notes.push(`Esri imagery: ${img.note}`);
    } catch (e) { notes.push(`the imagery did not load (${e.message})`); }
  }
  if (my !== job) return;
  status(notes.length ? notes.join(". ") + "." : "Double-click the ground to move the block.");
  const gebcoSample = V.sampler(gebco);
  const sample = fine ? V.fallbackSampler(V.gridSampler(fine.win, fine.dem.fwd), gebcoSample) : gebcoSample;
  const h = St.gridHeights(grid, sample);
  let tex = null;
  if (img) {
    const flat = { cols: [{ x: 0, y: 0, wx: ext, wy: ext }], toLonLat: (x, y) => grid.P.inverse(x, y) };
    tex = V.topTexture(flat, img, TEX[drape]);
  }
  built = { grid, h, sample, gebcoSample, gebco, fine, tex, drape };
  drawGround();
  placeBlock();
  readout();
  locator();
}

// scene units: the square is 2 across, heights about the middle of the
// ground's range, times the exaggeration
const S = () => 2 / (state.ext * 1000);
const zMid = () => (built.h.lo + built.h.hi) / 2;
const yOf = (z) => (z - zMid()) * state.vx * S();

function drawGround() {
  const { grid, h, tex } = built, { m, xy } = grid, s = S();
  const N = m * m, pos = new Float32Array(N * 3), uv = new Float32Array(N * 2), col = new Float32Array(N * 3);
  const span = Math.max(1, h.hi - h.lo);
  for (let k = 0; k < N; k++) {
    const x = xy[2 * k], y = xy[2 * k + 1];
    pos[3 * k] = x * s; pos[3 * k + 1] = yOf(h.z[k]); pos[3 * k + 2] = -y * s;
    uv[2 * k] = (x + grid.ext / 2) / grid.ext; uv[2 * k + 1] = (grid.ext / 2 - y) / grid.ext;
    // relief: low green to high stone, for when there is no imagery
    const t = (h.z[k] - h.lo) / span;
    col[3 * k] = 0.36 + 0.42 * t; col[3 * k + 1] = 0.52 + 0.2 * t; col[3 * k + 2] = 0.3 + 0.42 * t;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(St.gridTriangles(m, h.z), 1));
  g.computeVertexNormals();
  if (ground) { scene.remove(ground); ground.geometry.dispose(); }
  if (groundMat.map) { groundMat.map.dispose(); groundMat.map = null; }
  if (tex) {
    const t = new THREE.DataTexture(tex.data, tex.width, tex.height, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    t.needsUpdate = true;
    groundMat.map = t;
    groundMat.vertexColors = false;
  } else groundMat.vertexColors = true;
  groundMat.needsUpdate = true;
  ground = new THREE.Mesh(g, groundMat);
  ground.receiveShadow = true;
  scene.add(ground);
  drawSkirt();
}

// walls round the square down to a floor below its lowest ground
function drawSkirt() {
  const { grid, h } = built, { m, xy } = grid, s = S();
  const floor = yOf(h.lo) - 0.04 - 0.06 * Math.min(1, ((h.hi - h.lo) * state.vx * s) / 0.5);
  const edges = [
    Array.from({ length: m }, (_, i) => i),                         // north, west to east
    Array.from({ length: m }, (_, j) => j * m + m - 1),             // east, north to south
    Array.from({ length: m }, (_, i) => (m - 1) * m + (m - 1 - i)), // south, east to west
    Array.from({ length: m }, (_, j) => (m - 1 - j) * m)            // west, south to north
  ];
  const pos = [], idx = [];
  for (const e of edges) {
    const base = pos.length / 3;
    for (const k of e) {
      const x = xy[2 * k] * s, z = -xy[2 * k + 1] * s;
      pos.push(x, yOf(h.z[k]), z, x, floor, z);
    }
    for (let t = 0; t < e.length - 1; t++) {
      const a = base + 2 * t;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (skirt) { scene.remove(skirt); skirt.geometry.dispose(); }
  skirt = new THREE.Mesh(g, skirtMat);
  skirtMat.side = THREE.DoubleSide;
  scene.add(skirt);
}

function blockXY() { return built.grid.P.forward(state.ox, state.oy); }

function placeBlock() {
  if (!built) return;
  const s = S(), [x, y] = blockXY();
  // a quantity sets the block's shape; otherwise it is storeys
  const qty = state.q > 0 ? St.shapeFor(St.volumeOf(state.q, state.qu, state.mat), state.shape, state.bw, state.bd) : null;
  const bw = qty ? qty.w : state.bw, bd = qty ? qty.d : state.bd;
  const height = qty ? qty.h : St.blockHeight(state.st, state.sh);
  const sit = St.seat(built.sample, built.grid.P, x, y, bw, bd, state.rot) || { min: 0, max: 0, mean: 0 };
  const gsit = St.seat(built.gebcoSample, built.grid.P, x, y, bw, bd, state.rot);
  built.seat = sit; built.gseat = gsit; built.height = height; built.qty = qty; built.bw = bw; built.bd = bd;
  // a pit hangs down from the highest ground over its footprint, and shows
  // through the ground over it
  const pit = qty && qty.pit, base = pit ? sit.max - height : sit.min;
  block.scale.set(bw * s, Math.max(1e-6, height * state.vx * s), bd * s);
  block.position.set(x * s, yOf(base), -y * s);
  block.rotation.y = -state.rot * D2R;
  blockUniforms.uSize.value.set(bw, height, bd);
  blockUniforms.uStorey.value = state.sh;
  blockUniforms.uPlain.value = qty ? 1 : 0;
  blockUniforms.uAlpha.value = pit ? 0.6 : 1;
  blockMat.transparent = !!pit; blockMat.depthTest = !pit; blockMat.depthWrite = !pit;
  block.renderOrder = pit ? 2 : 0;
  block.castShadow = !pit;
  blockUniforms.uCol.value.set("#" + (qty ? (pit ? "d2342a" : St.MATERIALS[state.mat].rgb) : state.bc));
  const top = yOf(pit ? sit.max : sit.min + height);
  pin.position.set(x * s, top, -y * s);
  pin.scale.set(1, 0.06, 1);
  sun.castShadow = !!state.shadow;
  block.visible = pin.visible = Math.abs(x) <= state.ext * 500 && Math.abs(y) <= state.ext * 500;
}

// ---------------------------------------------------------------- readout

const fmtM = (m) => (Math.abs(m) >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${+m.toFixed(Math.abs(m) < 10 ? 1 : 0)} m`);
const fmtLL = (lon, lat) => `${Math.abs(lat).toFixed(4)}${DEG}${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(4)}${DEG}${lon < 0 ? "W" : "E"}`;

function readout() {
  if (!built) return;
  const { grid, h, gebco, fine, seat, gseat, height, qty } = built;
  const gebcoM = gebco.dy * V.R * D2R;
  const src = fine
    ? `${fine.reg.name}, read at ${fmtM(fine.win.cellM)}${h.missing ? ", GEBCO where it has none" : ""}`
    : `GEBCO 2026 at ${fmtM(gebcoM)}: one cell is ${(gebcoM / grid.ext).toFixed(2)} of this square across`;
  const rows = [
    ["Ground", `${fmtM(grid.ext)} square at ${fmtLL(state.lon, state.lat)}, ${state.n} x ${state.n} cells of ${fmtM(grid.cellM)}`],
    ["Elevation", src],
    ["Relief", `${Math.round(h.lo)} to ${Math.round(h.hi)} m${state.vx !== 1 ? `, drawn x ${state.vx}` : ", true scale"}`],
    qty ? ["Quantity", quantityLine()]
      : ["Block", `${state.st} storeys of ${fmtM(state.sh)} = ${fmtM(height)} tall, ${fmtM(state.bw)} x ${fmtM(state.bd)}${state.rot ? `, turned ${Math.round(state.rot)}${DEG}` : ""}`],
    ["At", fmtLL(state.ox, state.oy)],
    qty && qty.pit
      ? ["Dug from", `${Math.round(seat.max)} m down to ${Math.round(seat.max - height)} m (the ground over it falls ${fmtM(seat.max - seat.min)})`]
      : ["Stands on", `${Math.round(seat.min)} m (the ground under it climbs ${fmtM(seat.max - seat.min)}); ${qty ? "top" : "roof"} at ${Math.round(seat.min + height)} m`],
    fine && ["GEBCO here", gseat ? `${Math.round(gseat.mean)} m, ${fmtM(Math.abs(seat.mean - gseat.mean))} ${seat.mean > gseat.mean ? "below" : "above"} the ground drawn` : "none"]
  ];
  $("out").innerHTML = rows.filter(Boolean).map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("");
  caption();
  $("credit").innerHTML = [fine && fine.reg.credit,
    'GEBCO Compilation Group (2026) GEBCO 2026 Grid, from <a href="https://source.coop/ausantarctic/gebco">Source Cooperative</a>',
    built.tex && sources[built.drape].credit].filter(Boolean).join("; ");
}

const fmtN = (v) => (v >= 100 ? Math.round(v).toLocaleString("en") : String(+v.toPrecision(3)));
function quantityLine() {
  const m = St.MATERIALS[state.mat], v = St.volumeOf(state.q, state.qu, state.mat), b = built;
  const amount = state.qu === "t" ? `${fmtN(state.q)} t of ${m.name.toLowerCase()} (${m.t} t/m3) = ${fmtN(v)} m3` : `${fmtN(v)} m3`;
  const shape = state.shape === "cube" ? `a cube ${fmtM(b.height)} on a side`
    : state.shape === "pit" ? `a pit ${fmtM(b.height)} deep over ${fmtM(b.bw)} x ${fmtM(b.bd)}`
      : `a slab ${fmtM(b.height)} high on ${fmtM(b.bw)} x ${fmtM(b.bd)}`;
  return `${amount}: ${shape}`;
}

// the story's caption over the view, and in a saved picture
function caption() {
  const t = STORIES.find((x) => x.key === state.story);
  const el = $("caption");
  if (!t) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<b>${t.name}</b><br>${t.text}<br><span class="src">${t.src ? `<a href="${t.src}" target="_blank" rel="noopener">${t.srcName}</a>` : t.srcName}</span>`;
}

function locator() {
  if (!coast) return;
  const b = V.groundBox(state.lon, state.lat, Math.max(state.ext * 1000, 40000));
  drawLocator($("locator"), coast, state.lon, state.lat,
    [[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]);
}

// ---------------------------------------------------------------- views

const WHOLE = [1.5, 1.25, 2.1, 0, -0.1, 0];
function lookAtBlock() {
  if (!built) return;
  const s = S(), [x, y] = blockXY(), d = Math.max(state.bw, state.bd, built.height * state.vx) * s;
  const t = new THREE.Vector3(x * s, yOf(built.seat.min) + built.height * state.vx * s * 0.4, -y * s);
  const r = Math.max(0.05, d * 16);
  stage.setCamera([t.x + r * 0.55, t.y + r * 0.42, t.z + r * 0.75, t.x, t.y, t.z]);
  state.cam = stage.getCamera(); writeHash();
}

// ---------------------------------------------------------------- controls

function syncControls() {
  const place = PLACES.find((p) => Math.abs(p.lon - state.lon) < 1e-4 && Math.abs(p.lat - state.lat) < 1e-4 && p.ext === state.ext);
  $("place").value = place ? place.key : "";
  $("lonlat").value = `${+state.lon.toFixed(5)}, ${+state.lat.toFixed(5)}`;
  $("ext").value = Math.log10(state.ext); $("ext-out").textContent = fmtM(state.ext * 1000);
  $("n").value = state.n; $("n-out").textContent = state.n;
  $("src").value = state.src; $("img").value = state.img;
  $("vx").value = Math.log10(state.vx); $("vx-out").textContent = state.vx === 1 ? "true scale" : `x ${state.vx}`;
  $("st").value = state.st; $("sh").value = state.sh; $("bw").value = state.bw; $("bd").value = state.bd;
  $("rot").value = state.rot; $("rot-out").textContent = `${Math.round(state.rot)}${DEG}`;
  $("bc").value = "#" + state.bc; $("shadow").checked = !!state.shadow;
  $("blockll").value = `${+state.ox.toFixed(5)}, ${+state.oy.toFixed(5)}`;
  $("story").value = state.story;
  $("q").value = state.q || ""; $("qu").value = state.qu; $("mat").value = state.mat; $("shape").value = state.shape;
  $("mat").disabled = state.qu !== "t";
}

function changed({ rebuild = true, ground = false } = {}) {
  writeHash(); syncControls();
  if (rebuild) build();
  else if (built) { if (ground) drawGround(); placeBlock(); readout(); }
}

$("story").innerHTML = '<option value="">None, my own</option>' + STORIES.map((t) => `<option value="${t.key}">${t.name}</option>`).join("");
$("mat").innerHTML = Object.entries(St.MATERIALS).map(([k, m]) => `<option value="${k}">${m.name}, ${m.t} t/m3</option>`).join("");
$("story").addEventListener("change", (e) => {
  const t = STORIES.find((x) => x.key === e.target.value);
  state.story = t ? t.key : "";
  if (t) {
    Object.assign(state, storyState(t), { cam: null });
    stage.setCamera(WHOLE);
    changed();
  } else changed({ rebuild: false });
});
$("q").addEventListener("change", (e) => { const v = +e.target.value; state.q = isFinite(v) && v > 0 ? v : 0; state.story = ""; changed({ rebuild: false }); });
for (const k of ["qu", "mat", "shape"]) $(k).addEventListener("change", (e) => { state[k] = e.target.value; state.story = ""; changed({ rebuild: false }); });

$("place").innerHTML = '<option value="">Somewhere else</option>' + PLACES.map((p) => `<option value="${p.key}">${p.name}</option>`).join("");
$("place").addEventListener("change", (e) => {
  const p = PLACES.find((q) => q.key === e.target.value);
  if (!p) return;
  Object.assign(state, { lon: p.lon, lat: p.lat, ext: p.ext, ox: p.ox, oy: p.oy, cam: null });
  stage.setCamera(WHOLE);
  changed();
});
const pair = (v) => { const a = v.split(/[ ,]+/).map(Number); return a.length >= 2 && a.every(isFinite) ? a : null; };
$("lonlat").addEventListener("change", (e) => {
  const v = pair(e.target.value);
  if (v) { state.lon = ((v[0] + 540) % 360) - 180; state.lat = Math.max(-85, Math.min(85, v[1])); state.ox = state.lon; state.oy = state.lat; }
  changed();
});
$("blockll").addEventListener("change", (e) => {
  const v = pair(e.target.value);
  if (v) { state.ox = v[0]; state.oy = v[1]; }
  changed({ rebuild: false });
});
$("ext").addEventListener("input", (e) => { $("ext-out").textContent = fmtM(1000 * 10 ** +e.target.value); });
$("ext").addEventListener("change", (e) => { state.ext = +(10 ** +e.target.value).toFixed(2); changed(); });
$("n").addEventListener("change", (e) => { state.n = +e.target.value; changed(); });
$("n").addEventListener("input", (e) => { $("n-out").textContent = e.target.value; });
$("src").addEventListener("change", (e) => { state.src = e.target.value; changed(); });
$("img").addEventListener("change", (e) => { state.img = e.target.value; changed(); });
$("vx").addEventListener("input", (e) => { state.vx = +(10 ** +e.target.value).toFixed(1); changed({ rebuild: false, ground: true }); });
for (const k of ["st", "sh", "bw", "bd"]) $(k).addEventListener("change", (e) => { if (isFinite(+e.target.value) && +e.target.value > 0) state[k] = +e.target.value; changed({ rebuild: false }); });
$("rot").addEventListener("input", (e) => { state.rot = +e.target.value; changed({ rebuild: false }); });
$("bc").addEventListener("input", (e) => { state.bc = e.target.value.slice(1); changed({ rebuild: false }); });
$("shadow").addEventListener("change", (e) => { state.shadow = e.target.checked ? 1 : 0; changed({ rebuild: false }); });
$("cube").addEventListener("click", () => { Object.assign(state, { st: 10, sh: 3, bw: 30, bd: 30, rot: 0, q: 0, story: "" }); changed({ rebuild: false }); });
$("to-block").addEventListener("click", lookAtBlock);
$("whole").addEventListener("click", () => { state.cam = null; stage.setCamera(WHOLE); writeHash(); });
$("save-png").addEventListener("click", () => {
  renderer.render(scene, camera);
  const src = renderer.domElement, c = document.createElement("canvas");
  c.width = src.width; c.height = src.height;
  const g = c.getContext("2d");
  g.drawImage(src, 0, 0);
  const t = STORIES.find((x) => x.key === state.story);
  if (t) drawCaption(g, c.width, [t.name, t.text, t.srcName + (t.src ? ` (${t.src})` : "")]);
  const a = document.createElement("a");
  a.href = c.toDataURL("image/png");
  a.download = `story-${(PLACES.find((p) => p.key === $("place").value) || { key: "ground" }).key}.png`;
  a.click();
});

// the caption in a box at the top left, wrapped to about half the width
function drawCaption(g, W, [title, text, src]) {
  const k = W / 1000, pad = 14 * k, maxW = Math.min(W * 0.55, 560 * k);
  const wrap = (str, font) => {
    g.font = font;
    const out = [];
    let line = "";
    for (const w of str.split(" ")) {
      const next = line ? line + " " + w : w;
      if (g.measureText(next).width > maxW && line) { out.push(line); line = w; } else line = next;
    }
    if (line) out.push(line);
    return out;
  };
  const fT = `600 ${18 * k}px system-ui, sans-serif`, fB = `${14 * k}px system-ui, sans-serif`, fS = `${11 * k}px system-ui, sans-serif`;
  const lines = [...wrap(title, fT).map((l) => [l, fT, 24 * k]), ...wrap(text, fB).map((l) => [l, fB, 19 * k]), ...wrap(src, fS).map((l) => [l, fS, 16 * k])];
  const h = lines.reduce((a, l) => a + l[2], 0) + 2 * pad;
  g.fillStyle = "rgba(13, 23, 38, 0.82)";
  g.fillRect(pad, pad, maxW + 2 * pad, h);
  let y = 2 * pad;
  g.fillStyle = "#f2f5f9"; g.textBaseline = "top";
  for (const [l, f, lh] of lines) { g.font = f; g.fillText(l, 2 * pad, y); y += lh; }
}

// double-click the ground: the block moves there
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
renderer.domElement.addEventListener("dblclick", (e) => {
  if (!ground || !built) return;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(ground)[0];
  if (!hit) return;
  const s = S(), [lon, lat] = built.grid.P.inverse(hit.point.x / s, -hit.point.z / s);
  state.ox = +lon.toFixed(6); state.oy = +lat.toFixed(6);
  changed({ rebuild: false });
});

// ---------------------------------------------------------------- go

readHash();
syncControls();
stage.setCamera(state.cam || WHOLE);
stage.resize();
shareLinks("Story", { height: 560 });
window.addEventListener("hashchange", () => { readHash(); syncControls(); build(); });
loadCoastline("50m").then((c) => { coast = c; locator(); }).catch(() => {});
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
build().then(() => { if (!state.cam && built) lookAtBlock(); });
