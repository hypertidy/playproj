// playproj: Spilhaus, the world's oceans in a square.
//
// There is no light, cone or cylinder here. The surface is a grid over the
// square map, each node carried back to its place on the sphere by the
// inverse projection. Unfold moves every node in a straight line from the
// sphere to the square, so at 0 the grid is the globe and at 1 it is the
// map; the square's own grid lines show how a square net wraps a sphere,
// pinched at the four corners where the map stops being conformal.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as fam from "./families/spilhaus.js";
import { loadCoastline, graticule, mulberry32 } from "./geo.js";
import { sources, loadWorld, reprojectBox } from "./basemap.js";
import { writeGeoTIFF } from "./geotiff-write.js";
import { displace, hasElevation } from "./relief.js";

const D2R = Math.PI / 180;
const DEG = "\u00b0";
const LINK_POOL = 4000;
const GRID_N = 256;       // exact inverses per side for the interpolated inverse
const MESH_STEP = 4;      // every 4th grid node becomes a mesh vertex
const NET_DIV = 16;       // square grid lines per side
const TEX = 1024;         // fixed texture size (a WebGL texture cannot be resized)

const COLORS = {
  bg: 0x05070d,
  globe: 0x1e6fd9,
  coastOn: 0xd7ecff,
  grat: 0x2c4a73,
  surface: 0x3fa7a0,
  surfCoast: 0x6ab787,
  surfGrat: 0x2f6b66,
  net: 0xffb347,
  link: 0x9aa3ad,
  corner: 0xff5d73
};

// ---------------------------------------------------------------- state

const defaults = {
  lat: +fam.defaults.lat0.toFixed(4), lon: +fam.defaults.lon0.toFixed(4), azi: +fam.defaults.azi.toFixed(4),
  t: 0.5, links: 120, net: 1, seed: 1, detail: "110m", grat: 1, globe: 1, bm: "none", relief: 0, wire: 0, spin: 0, cam: null
};
const state = { ...defaults };
const embed = new URLSearchParams(location.search).has("embed");

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  for (const k of Object.keys(defaults)) {
    if (!h.has(k)) continue;
    const raw = h.get(k);
    if (k === "detail") state.detail = raw === "50m" ? "50m" : "110m";
    else if (k === "bm") state.bm = raw in sources ? raw : "none";
    else if (k === "cam") {
      const c = raw.split(",").map(Number);
      if (c.length === 6 && c.every(isFinite)) state.cam = c;
    } else if (isFinite(+raw)) state[k] = +raw;
  }
  state.lat = Math.max(-90, Math.min(90, state.lat));
  const wrap = (v) => +(((v + 540) % 360) - 180).toFixed(4);
  state.lon = wrap(state.lon);
  state.azi = wrap(state.azi);
  state.t = Math.max(0, Math.min(1, state.t));
  state.links = Math.max(0, Math.min(1000, Math.round(state.links)));
  state.relief = Math.max(0, Math.min(100, state.relief));
}

let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const h = new URLSearchParams();
    for (const k of Object.keys(defaults)) {
      if (k === "cam") { if (state.cam) h.set("cam", state.cam.map((x) => +x.toFixed(2)).join(",")); continue; }
      const val = typeof state[k] === "number" ? +state[k].toFixed(4) : state[k];
      if (val !== defaults[k]) h.set(k, String(val));
    }
    const s = h.toString();
    history.replaceState(null, "", s ? "#" + s : location.pathname + location.search);
  }, 200);
}

const isSpilhaus = () => state.lat === defaults.lat && state.lon === defaults.lon && state.azi === defaults.azi;
const params = () => isSpilhaus() ? { ...fam.defaults } : { lat0: state.lat, lon0: state.lon, azi: state.azi };
const pkey = (p) => `${p.lat0},${p.lon0},${p.azi}`;

// ---------------------------------------------------------------- geometry

// The scene puts the map's centre at +z on the unit sphere, with the map's
// x and y along the scene's x and y there, and the square in the plane
// z = 1 scaled to match the sphere at the centre. So the globe and the
// square touch at the centre and agree in scale and direction there.
let frame = null;
function makeFrame(p) {
  const lam = p.lon0 * D2R, phi = p.lat0 * D2R;
  const C = [Math.cos(phi) * Math.cos(lam), Math.cos(phi) * Math.sin(lam), Math.sin(phi)];
  const E = [-Math.sin(lam), Math.cos(lam), 0];
  const N = [-Math.sin(phi) * Math.cos(lam), -Math.sin(phi) * Math.sin(lam), Math.cos(phi)];
  const h = 1e-5;
  const c = fam.project(p.lon0, p.lat0, p), e = fam.project(p.lon0 + h / Math.cos(phi), p.lat0, p);
  const ex = (e[0] - c[0]) / (h * D2R), ey = (e[1] - c[1]) / (h * D2R);
  const th = Math.atan2(ey, ex), k = 1 / Math.hypot(ex, ey);
  const ct = Math.cos(th), st = Math.sin(th);
  const X = E.map((v, i) => ct * v - st * N[i]), Y = E.map((v, i) => st * v + ct * N[i]);
  return { C, X, Y, k, c };
}

function onGlobe(lon, lat, out, i = 0) {
  const cp = Math.cos(lat * D2R);
  const g = [cp * Math.cos(lon * D2R), cp * Math.sin(lon * D2R), Math.sin(lat * D2R)];
  return fromUnit(g, out, i);
}

function fromUnit(g, out, i = 0) {
  const { X, Y, C } = frame;
  out[i] = g[0] * X[0] + g[1] * X[1] + g[2] * X[2];
  out[i + 1] = g[0] * Y[0] + g[1] * Y[1] + g[2] * Y[2];
  out[i + 2] = g[0] * C[0] + g[1] * C[1] + g[2] * C[2];
  return out;
}

// Straight line from the sphere point S to the square point (x, y).
function morph(S, x, y, t, out, i = 0) {
  const fx = frame.k * (x - frame.c[0]), fy = frame.k * (y - frame.c[1]);
  out[i] = (1 - t) * S[0] + t * fx;
  out[i + 1] = (1 - t) * S[1] + t * fy;
  out[i + 2] = (1 - t) * S[2] + t;
  return out;
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

const DEFAULT_CAM = [6.5, 5.5, 15, 0, 0, 0.5];
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

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(3, 5, 4);
scene.add(sun);

const globe = new THREE.Mesh(
  new THREE.BufferGeometry(),
  new THREE.MeshPhongMaterial({ color: COLORS.globe, transparent: true, opacity: 0.25, shininess: 30, depthWrite: false })
);
scene.add(globe);

const surface = new THREE.Mesh(
  new THREE.BufferGeometry(),
  new THREE.MeshBasicMaterial({ color: COLORS.surface, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false })
);
scene.add(surface);

const GLOBE_NX = 144;
function gridIndex(nx, ny) {
  const idx = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + nx + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  return idx;
}

// the surface mesh takes every step-th grid node: finer when it carries relief
const meshGrids = {};
function meshGrid(step) {
  if (!meshGrids[step]) {
    const n = GRID_N / step, uv = [];
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) uv.push(i / n, 1 - j / n);
    meshGrids[step] = { n, index: gridIndex(n, n), uv };
  }
  return meshGrids[step];
}

// lon/lat grids for the globe, cached by size
const globeGrids = {};
function globeGrid(nx, ny) {
  if (!globeGrids[nx]) {
    const uv = [];
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++) uv.push(i / nx, 1 - j / ny);
    globeGrids[nx] = { index: gridIndex(nx, ny), uv };
  }
  return globeGrids[nx];
}
const reliefOn = () => state.relief > 0 && hasElevation(world);

const GLOBE_OPACITY = 0.25, GLOBE_OPACITY_MAP = 0.35;

function setMesh(mesh, pos, uv, index, normals) {
  mesh.geometry.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  if (normals) g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  mesh.geometry = g;
}

const layers = {};
function setLines(name, positions, color, opacity = 1, order = 0) {
  let obj = layers[name];
  if (!obj) {
    obj = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }));
    obj.renderOrder = order;
    layers[name] = obj;
    scene.add(obj);
  }
  obj.geometry.dispose();
  obj.geometry = new THREE.BufferGeometry();
  obj.geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return obj;
}

const cornerDots = new THREE.Points(
  new THREE.BufferGeometry(),
  new THREE.PointsMaterial({ color: COLORS.corner, size: 9, sizeAttenuation: false, depthTest: false })
);
cornerDots.renderOrder = 5;
scene.add(cornerDots);

// ---------------------------------------------------------------- data

let coast = [];
const grat = graticule(15, 2);
let linkPool = [];

function buildLinkPool() {
  const rand = mulberry32(state.seed);
  const total = coast.reduce((s, l) => s + l.length / 2, 0);
  linkPool = [];
  for (let k = 0; k < LINK_POOL; k++) {
    let idx = Math.floor(rand() * total);
    for (const line of coast) {
      const n = line.length / 2;
      if (idx < n) { linkPool.push([line[2 * idx], line[2 * idx + 1]]); break; }
      idx -= n;
    }
  }
}

// The interpolated inverse depends only on the centre and azimuth.
let inv = null, invKey = "";
function inverseFor(p) {
  const key = pkey(p);
  if (key !== invKey) { inv = fam.inverseGrid(p, GRID_N); invKey = key; }
  return inv;
}

// ---------------------------------------------------------------- rebuild

function rebuild() {
  const p = params();
  frame = makeFrame(p);
  const g = inverseFor(p);
  const t = state.t, H = fam.HALF;
  const A = [0, 0, 0], B = [0, 0, 0], S = [0, 0, 0];

  // globe, on a finer grid and raised when it carries relief
  const relief = reliefOn();
  const GX = relief ? (state.wire ? 180 : 360) : GLOBE_NX, GY = GX / 2, gGrid = globeGrid(GX, GY);
  const gp = new Float32Array((GX + 1) * (GY + 1) * 3);
  for (let j = 0, k = 0; j <= GY; j++)
    for (let i = 0; i <= GX; i++, k += 3) onGlobe(-180 + (360 * i) / GX, 90 - (180 * j) / GY, gp, k);
  const gn = relief
    ? displace(gp, gGrid.index, (k) => [-180 + (360 * (k % (GX + 1))) / GX, 90 - (180 * Math.floor(k / (GX + 1))) / GY], world, state.relief)
    : gp.slice();
  setMesh(globe, gp, gGrid.uv, gGrid.index, gn);
  globe.visible = !!state.globe;
  globe.material.wireframe = surface.material.wireframe = relief && !!state.wire;
  // a raised globe has to hide its own far side, so it is drawn solid
  globe.material.depthWrite = relief;
  globe.material.opacity = relief ? 0.95 : world ? GLOBE_OPACITY_MAP : GLOBE_OPACITY;

  // the unfolding surface: a grid over the square, every node from the sphere to the map
  const m = GRID_N + 1, nodePos = (i, j, out, o = 0) => {
    const k = j * m + i;
    fromUnit([g.grid[3 * k], g.grid[3 * k + 1], g.grid[3 * k + 2]], S);
    return morph(S, -H + i * g.step, H - j * g.step, t, out, o);
  };
  const step = !relief ? MESH_STEP : state.wire ? 2 : 1, mg = meshGrid(step), mn = mg.n;
  const sp = new Float32Array((mn + 1) * (mn + 1) * 3);
  for (let j = 0, k = 0; j <= mn; j++)
    for (let i = 0; i <= mn; i++, k += 3) nodePos(i * step, j * step, sp, k);
  if (relief) displace(sp, mg.index, (k) => {
    const node = Math.floor(k / (mn + 1)) * step * m + (k % (mn + 1)) * step;
    return [g.lonlat[2 * node], g.lonlat[2 * node + 1]];
  }, world, state.relief);
  setMesh(surface, sp, mg.uv, mg.index);

  // the square's own grid, carried with the surface
  const net = [];
  if (state.net) {
    const every = GRID_N / NET_DIV;
    for (let a = 0; a <= GRID_N; a += every)
      for (let b = 0; b < GRID_N; b++) {
        nodePos(a, b, A); nodePos(a, b + 1, B); net.push(...A, ...B);
        nodePos(b, a, A); nodePos(b + 1, a, B); net.push(...A, ...B);
      }
  }
  setLines("net", net, COLORS.net, 0.7, 2).visible = !!state.net;

  // the four corners, where the map is not conformal
  const dots = [];
  for (const [i, j] of [[0, 0], [GRID_N, 0], [0, GRID_N], [GRID_N, GRID_N]]) dots.push(...nodePos(i, j, A));
  cornerDots.geometry.dispose();
  cornerDots.geometry = new THREE.BufferGeometry();
  cornerDots.geometry.setAttribute("position", new THREE.Float32BufferAttribute(dots, 3));

  // coastlines and graticule on the globe and on the surface
  const drawOn = (lines, globeOut, surfOut) => {
    for (const line of lines) {
      let prev = null;
      for (let i = 0; i < line.length; i += 2) {
        const lon = line[i], lat = line[i + 1];
        onGlobe(lon, lat, B);
        const xy = fam.project(lon, lat, p);
        const f = morph(B, xy[0], xy[1], t, [0, 0, 0]);
        if (i > 0) {
          if (globeOut) globeOut.push(A[0], A[1], A[2], B[0], B[1], B[2]);
          if (Math.hypot(xy[0] - prev.xy[0], xy[1] - prev.xy[1]) < 0.3) surfOut.push(...prev.f, ...f);
        }
        A[0] = B[0]; A[1] = B[1]; A[2] = B[2];
        prev = { xy, f };
      }
    }
  };
  const cg = [], cs = [], gg = [], gs = [];
  drawOn(coast, cg, cs);
  drawOn(grat, gg, gs);
  setLines("coastGlobe", cg, COLORS.coastOn, 0.6).visible = !!state.globe;
  setLines("coastSurf", cs, COLORS.surfCoast, 1, 3);
  setLines("gratGlobe", gg, COLORS.grat, 0.45).visible = !!state.grat && !!state.globe;
  setLines("gratSurf", gs, COLORS.surfGrat, 0.8, 1).visible = !!state.grat;

  // links from the globe to the surface
  const links = [];
  let count = 0;
  for (const [lon, lat] of linkPool) {
    if (count >= state.links) break;
    onGlobe(lon, lat, B);
    const xy = fam.project(lon, lat, p);
    morph(B, xy[0], xy[1], t, A);
    links.push(B[0], B[1], B[2], A[0], A[1], A[2]);
    count++;
  }
  setLines("links", links, COLORS.link, 0.35, 1);

  scheduleBasemap(p);
  drawMap(p);
  updatePanel(p);
}

// ---------------------------------------------------------------- basemap

let world = null, worldTexture = null, basemapTimer = 0;
const flatCanvas = document.createElement("canvas");
flatCanvas.width = flatCanvas.height = TEX;
const scratch = document.createElement("canvas");
const flatTexture = new THREE.CanvasTexture(flatCanvas);
flatTexture.colorSpace = THREE.SRGBColorSpace;
let flatFor = "";

function renderFlat(p, size) {
  if (!world) return;
  const H = fam.HALF, g = inverseFor(p);
  const rgba = reprojectBox(world, g.inverse, p, [-H, -H, H, H], size, size);
  const ctx = flatCanvas.getContext("2d");
  if (size === TEX) ctx.putImageData(new ImageData(rgba, size, size), 0, 0);
  else {
    scratch.width = scratch.height = size;
    scratch.getContext("2d").putImageData(new ImageData(rgba, size, size), 0, 0);
    ctx.clearRect(0, 0, TEX, TEX);
    ctx.drawImage(scratch, 0, 0, TEX, TEX);
  }
  flatTexture.needsUpdate = true;
  flatFor = pkey(p) + state.bm + size;
}

// The square image only changes with the centre or the basemap.
function scheduleBasemap(p) {
  if (!world || flatFor === pkey(p) + state.bm + TEX) return;
  if (!flatFor.startsWith(pkey(p) + state.bm)) renderFlat(p, 256);
  clearTimeout(basemapTimer);
  basemapTimer = setTimeout(() => { renderFlat(params(), TEX); drawMap(params()); }, 250);
}

function applyBasemapMaterials() {
  const gm = globe.material, sm = surface.material;
  if (world) {
    if (!worldTexture || worldTexture.image !== world.canvas) {
      worldTexture = new THREE.CanvasTexture(world.canvas);
      worldTexture.colorSpace = THREE.SRGBColorSpace;
    }
    gm.map = worldTexture; gm.color.set(0xffffff); gm.opacity = 0.35;
    sm.map = flatTexture; sm.color.set(0xffffff); sm.opacity = 0.92;
  } else {
    gm.map = null; gm.color.set(COLORS.globe); gm.opacity = 0.25;
    sm.map = null; sm.color.set(COLORS.surface); sm.opacity = 0.2;
  }
  gm.needsUpdate = sm.needsUpdate = true;
}

async function setBasemap() {
  const id = state.bm;
  writeHash();
  ui.credit.innerHTML = sources[id].credit || "";
  flatFor = "";
  if (id === "none") {
    world = null; ui.bmStatus.textContent = ""; applyBasemapMaterials(); sync();
    return;
  }
  try {
    const w = await loadWorld(id, (msg) => { if (state.bm === id) ui.bmStatus.textContent = msg; });
    if (state.bm !== id) return;
    world = w;
    ui.bmStatus.textContent = "";
  } catch (e) {
    if (state.bm !== id) return;
    world = null;
    ui.bmStatus.textContent = `${sources[id].label} did not load (${e.message}). Check the connection and try again.`;
  }
  applyBasemapMaterials();
  sync();
}

async function downloadTIF() {
  if (!world) return;
  const p = params(), size = +ui.tifSize.value, R = fam.R, H = fam.HALF;
  const label = ui.tif.textContent;
  ui.tif.textContent = "Rendering...";
  ui.tif.disabled = true;
  await new Promise((r) => setTimeout(r, 20));
  try {
    // a finer exact grid than the screen needs, for a sharp export
    const g = fam.inverseGrid(p, 512);
    const rgba = reprojectBox(world, g.inverse, p, [-H, -H, H, H], size, size);
    const px = (2 * H) / size;
    const blob = await writeGeoTIFF({
      width: size, height: size, rgba,
      origin: [-H * R, H * R], pixelSize: [px * R, px * R],
      geoKeys: fam.geoKeys(p)
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `playproj-spilhaus${isSpilhaus() ? "" : `-lat${state.lat}-lon${state.lon}-azi${state.azi}`}-${state.bm}-${size}.tif`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } finally {
    ui.tif.textContent = label;
    ui.tif.disabled = !world;
  }
}

// ---------------------------------------------------------------- 2D map

const mapCanvas = document.getElementById("map2d");

function drawMap(p) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = mapCanvas.clientWidth, ch = mapCanvas.clientHeight;
  if (!cw || !ch) return;
  if (mapCanvas.width !== Math.round(cw * dpr)) { mapCanvas.width = Math.round(cw * dpr); mapCanvas.height = Math.round(ch * dpr); }
  const ctx = mapCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#05070d";
  ctx.fillRect(0, 0, cw, ch);

  const H = fam.HALF;
  const s = (Math.min(cw, ch) / (2 * H)) * 0.94;
  const X = (x) => cw / 2 + x * s, Y = (y) => ch / 2 - y * s;
  if (world && flatFor.startsWith(pkey(p) + state.bm)) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(flatCanvas, X(-H), Y(H), 2 * H * s, 2 * H * s);
  }
  const stroke = (lines, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath();
    for (const line of lines) {
      let prev = null;
      for (let i = 0; i < line.length; i += 2) {
        const xy = fam.project(line[i], line[i + 1], p);
        if (prev && Math.hypot(xy[0] - prev[0], xy[1] - prev[1]) < 0.3) ctx.lineTo(X(xy[0]), Y(xy[1]));
        else ctx.moveTo(X(xy[0]), Y(xy[1]));
        prev = xy;
      }
    }
    ctx.stroke();
  };
  if (state.grat) stroke(grat, "rgba(63,167,160,0.6)", 0.8);
  stroke(coast, "#6ab787", 1.1);
  if (state.net) {
    ctx.strokeStyle = "rgba(255,179,71,0.35)"; ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let a = 0; a <= NET_DIV; a++) {
      const v = -H + (2 * H * a) / NET_DIV;
      ctx.moveTo(X(v), Y(-H)); ctx.lineTo(X(v), Y(H));
      ctx.moveTo(X(-H), Y(v)); ctx.lineTo(X(H), Y(v));
    }
    ctx.stroke();
  }
  ctx.strokeStyle = "#8899aa"; ctx.lineWidth = 1;
  ctx.strokeRect(X(-H), Y(H), 2 * H * s, 2 * H * s);
}

// ---------------------------------------------------------------- panel

const $ = (id) => document.getElementById(id);
const ui = {
  t: $("t"), lat: $("lat"), lon: $("lon"), azi: $("azi"), links: $("links"),
  tOut: $("t-out"), latOut: $("lat-out"), lonOut: $("lon-out"), aziOut: $("azi-out"), linksOut: $("links-out"),
  proj: $("projstring"), describe: $("describe"), centre: $("centre"),
  net: $("net"), grat: $("grat"), globe: $("globe"), detail: $("detail"),
  spin: $("spin"), relief: $("relief"), reliefOut: $("relief-out"), wire: $("wire"), bm: $("basemap"), bmStatus: $("bm-status"), credit: $("credit"), tifSize: $("tif-size"), tif: $("download-tif")
};

for (const [id, src] of Object.entries(sources)) {
  const o = document.createElement("option");
  o.value = id; o.textContent = src.label;
  ui.bm.appendChild(o);
}

function updatePanel(p) {
  ui.t.value = state.t; ui.lat.value = state.lat; ui.lon.value = state.lon; ui.azi.value = state.azi; ui.links.value = state.links;
  ui.tOut.textContent = state.t === 0 ? "globe" : state.t === 1 ? "square" : `${Math.round(state.t * 100)}%`;
  ui.latOut.textContent = (+state.lat.toFixed(2)) + DEG;
  ui.lonOut.textContent = (+state.lon.toFixed(2)) + DEG;
  ui.aziOut.textContent = (+state.azi.toFixed(2)) + DEG;
  ui.linksOut.textContent = state.links;
  ui.net.checked = !!state.net; ui.grat.checked = !!state.grat; ui.globe.checked = !!state.globe; ui.detail.value = state.detail;
  ui.bm.value = state.bm;
  ui.spin.checked = !!state.spin;
  ui.relief.value = state.relief; ui.wire.checked = !!state.wire;
  ui.relief.disabled = ui.wire.disabled = !hasElevation(world);
  ui.reliefOut.textContent = !hasElevation(world) ? "needs GEBCO" : state.relief ? `${state.relief}x` : "off";
  ui.tif.disabled = !world;
  ui.proj.textContent = fam.projString(p);
  ui.describe.textContent = fam.describe(p);
  ui.centre.classList.toggle("active", isSpilhaus());
}

let rafPending = false;
function sync() {
  writeHash();
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; rebuild(); });
}

ui.t.addEventListener("input", () => { stopAnim(); state.t = +ui.t.value; sync(); });
ui.lat.addEventListener("input", () => { state.lat = +ui.lat.value; sync(); });
ui.lon.addEventListener("input", () => { state.lon = +ui.lon.value; sync(); });
ui.azi.addEventListener("input", () => { state.azi = +ui.azi.value; sync(); });
ui.links.addEventListener("input", () => { state.links = +ui.links.value; sync(); });
ui.centre.addEventListener("click", () => { state.lat = defaults.lat; state.lon = defaults.lon; state.azi = defaults.azi; sync(); });
ui.net.addEventListener("change", () => { state.net = ui.net.checked ? 1 : 0; sync(); });
ui.grat.addEventListener("change", () => { state.grat = ui.grat.checked ? 1 : 0; sync(); });
ui.globe.addEventListener("change", () => { state.globe = ui.globe.checked ? 1 : 0; sync(); });
ui.detail.addEventListener("change", async () => { state.detail = ui.detail.value; await loadData(); sync(); });
ui.bm.addEventListener("change", () => { state.bm = ui.bm.value; setBasemap(); });
ui.spin.addEventListener("change", () => { state.spin = ui.spin.checked ? 1 : 0; controls.autoRotate = !!state.spin; writeHash(); });
ui.tif.addEventListener("click", downloadTIF);
ui.relief.addEventListener("input", () => { state.relief = +ui.relief.value; sync(); });
ui.wire.addEventListener("change", () => { state.wire = ui.wire.checked ? 1 : 0; sync(); });
$("reseed").addEventListener("click", () => { state.seed = (state.seed % 9999) + 1; buildLinkPool(); sync(); });
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(DEFAULT_CAM); writeHash(); });

// unfold to the square and back
let anim = false, dir = 1, lastT = 0;
const playBtn = $("play-unfold");
function stopAnim() { anim = false; playBtn.textContent = "Unfold"; }
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
  `<iframe src="${pageUrl()}?embed=1${location.hash}" width="100%" height="480" style="border:0" loading="lazy" title="Map projection playground"></iframe>`,
  e.target));
$("copy-proj").addEventListener("click", (e) => copy(ui.proj.textContent, e.target));
$("open-full").href = pageUrl() + location.hash;

// ---------------------------------------------------------------- loop

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (coast.length) drawMap(params());
}
new ResizeObserver(resize).observe(stage);
new ResizeObserver(() => { if (coast.length) drawMap(params()); }).observe(mapCanvas);

function tick(now) {
  if (anim) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    state.t = Math.max(0, Math.min(1, state.t + dir * dt * 0.25));
    if (state.t === 1 || state.t === 0) stopAnim();
    sync();
  }
  lastT = now;
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

async function loadData() {
  coast = await loadCoastline(state.detail);
  buildLinkPool();
}

window.addEventListener("hashchange", () => { readHash(); controls.autoRotate = !!state.spin; if (state.cam) setCamera(state.cam); setBasemap(); loadData().then(sync); });

if (embed) {
  document.body.classList.add("embed");
  $("open-full").hidden = false;
}

readHash();
if (state.cam) setCamera(state.cam);
controls.autoRotate = !!state.spin;
controls.autoRotateSpeed = 0.8;
resize();
loadData().then(() => { rebuild(); document.body.classList.add("ready"); });
setBasemap();
requestAnimationFrame(tick);
