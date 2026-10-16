// playproj: cones and cylinders.
//
// The surface is built from the flat map itself: every lon/lat grid point is
// projected to the flat map, turned into polar coordinates about the cone's
// apex, and rolled up onto a cone whose opening depends on the unroll
// slider. At unroll 0 it is the cone touching the sphere along the standard
// parallel; at 1 it is the flat map lying in the tangent plane.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as fam from "./families/conic.js";
import { samplePoints, evenSpacing, SAMPLE_MODES } from "./landmesh.js";
import { loadCoastline, graticule } from "./geo.js";
import { sources, loadWorld, reprojectBox } from "./basemap.js";
import { writeGeoTIFF } from "./geotiff-write.js";
import { displace, hasElevation } from "./relief.js";
import { drawLattice } from "./tissot.js";

const D2R = Math.PI / 180;
const DEG = "\u00b0";
const LIMIT = 3.2;        // how far (sphere radii) the surface reaches from the standard parallel
const MAX_RAYS = 5000; // the slider's top end
const LINK_POOL = MAX_RAYS;

const COLORS = {
  bg: 0x05070d,
  globe: 0x1e6fd9,
  coastOn: 0xd7ecff,
  grat: 0x2c4a73,
  surface: 0xd9a441,
  surfCoast: 0x6ab787,
  surfGrat: 0x8a6a2a,
  link: 0x9aa3ad,
  parallel: 0xffb347
};

// ---------------------------------------------------------------- state

const defaults = { prop: "conf", lat1: 40, lon: 0, tilt: 0, t: 0, links: 120, seed: 1, from: "tri", detail: "110m", grat: 1, tissot: 0, globe: 1, bm: "none", relief: 0, wire: 0, spin: 0, cam: null };
const state = { ...defaults };
const embed = new URLSearchParams(location.search).has("embed");

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  for (const k of Object.keys(defaults)) {
    if (!h.has(k)) continue;
    const raw = h.get(k);
    if (k === "detail") state.detail = raw === "50m" ? "50m" : "110m";
    else if (k === "from") state.from = SAMPLE_MODES.includes(raw) ? raw : "tri";
    else if (k === "bm") state.bm = raw in sources ? raw : "none";
    else if (k === "prop") state.prop = fam.properties.some((q) => q.id === raw) ? raw : "conf";
    else if (k === "cam") {
      const c = raw.split(",").map(Number);
      if (c.length === 6 && c.every(isFinite)) state.cam = c;
    } else if (isFinite(+raw)) state[k] = +raw;
  }
  state.lat1 = Math.max(-90, Math.min(90, state.lat1));
  state.lon = ((state.lon + 540) % 360) - 180;
  state.tilt = Math.max(-90, Math.min(90, state.tilt));
  state.t = Math.max(0, Math.min(1, state.t));
  state.links = Math.max(0, Math.min(MAX_RAYS, Math.round(state.links)));
  state.relief = Math.max(0, Math.min(100, state.relief));
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

const params = () => ({ prop: state.prop, lat1: state.lat1, lon0: state.lon, tilt: state.tilt });

// ---------------------------------------------------------------- geometry

// Globe: the central point (0, lon) faces the camera (+z) and the surface's
// axis is +y; with no tilt that is the north pole. The globe turns about z.
function onGlobe(lon, lat, out, i = 0) {
  const cp = Math.cos(lat * D2R), dl = (lon - state.lon) * D2R, t = state.tilt * D2R;
  const e = cp * Math.sin(dl), n = Math.sin(lat * D2R);
  out[i] = e * Math.cos(t) + n * Math.sin(t);
  out[i + 1] = -e * Math.sin(t) + n * Math.cos(t);
  out[i + 2] = cp * Math.cos(dl);
  return out;
}

// A point given in the surface's own frame (lon relative to the centre).
function onGlobeAxis(lonA, latA, out, i = 0) {
  const cp = Math.cos(latA * D2R);
  out[i] = cp * Math.sin(lonA * D2R); out[i + 1] = Math.sin(latA * D2R); out[i + 2] = cp * Math.cos(lonA * D2R);
  return out;
}

// Roll flat polar coordinates onto a cone opened by t, keeping the apex
// and the generator along the central meridian fixed. Works in the
// meridian plane (y up the axis, z out to the standard parallel), for a
// northern cone; southern cones are mirrored in y.
function makeRoller(p, t) {
  const n = Math.max(fam.N_MIN, fam.coneConstant(p));
  const phi1 = Math.asin(n);
  const nv = Math.min(1, n / (1 - t * (1 - n)));
  const beta = Math.asin(nv), cb = Math.cos(beta), sb = Math.sin(beta);
  const rho0 = fam.kind(p) === 2 ? 0 : 1 / Math.tan(phi1);
  const T = [Math.sin(phi1), Math.cos(phi1)];          // (y, z)
  const m = [Math.cos(phi1), -Math.sin(phi1)];         // up the generator
  const apex = [T[0] + rho0 * m[0], T[1] + rho0 * m[1]];
  const ang = Math.PI - phi1 + beta;
  const d = [Math.cos(ang), Math.sin(ang)];            // axis, from the apex
  const e1 = [(-m[0] - cb * d[0]) / sb, (-m[1] - cb * d[1]) / sb];
  const sgn = p.lat1 < 0 ? -1 : 1;
  return (fp, out, i = 0) => {
    const [rho, alpha] = fp;
    const th = alpha / nv;
    const c = Math.cos(th), s = Math.sin(th);
    out[i] = rho * sb * s;
    out[i + 1] = sgn * (apex[0] + rho * (cb * d[0] + sb * c * e1[0]));
    out[i + 2] = apex[1] + rho * (cb * d[1] + sb * c * e1[1]);
    return out;
  };
}

function inReach(fp) {
  return fp && Math.abs(fp[0] - fp[2]) <= LIMIT;
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

const DEFAULT_CAM = [4.8, 2.4, 6.4, 0, 0.3, 0];
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
  new THREE.MeshPhongMaterial({ color: COLORS.globe, transparent: true, opacity: 0.3, shininess: 30, depthWrite: false })
);
scene.add(globe);

const surface = new THREE.Mesh(
  new THREE.BufferGeometry(),
  new THREE.MeshBasicMaterial({ color: COLORS.surface, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false })
);
scene.add(surface);

// lon/lat grids for the globe and the surface
const GLOBE_NX = 144;
const SURF_DLON = 2, SURF_DLAT = 1;
const SURF_NX = 360 / SURF_DLON, SURF_NY = 178 / SURF_DLAT;

function gridIndex(nx, ny, ok) {
  const idx = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + nx + 1;
      if (!ok || (ok[a] && ok[b] && ok[a + 1])) idx.push(a, b, a + 1);
      if (!ok || (ok[a + 1] && ok[b] && ok[b + 1])) idx.push(a + 1, b, b + 1);
    }
  return idx;
}

// Longitude about the surface's axis, relative to the centre.
const axisLon = (lon, lat) => (state.tilt ? fam.toAxis(lon, lat, params())[0] : ((lon - state.lon + 540) % 360) - 180);

// Give triangles that cross the antimeridian (in texture u) their own
// vertices, with u carried past 1 so the texture does not smear back.
function seamSplit(pos, uv, ll, ok, index) {
  const P = Array.from(pos), U = Array.from(uv), L = Array.from(ll), O = Array.from(ok), idx = [];
  for (let t = 0; t < index.length; t += 3) {
    const tri = [index[t], index[t + 1], index[t + 2]];
    const us = tri.map((v) => U[2 * v]);
    if (Math.max(...us) - Math.min(...us) <= 0.5) { idx.push(...tri); continue; }
    for (const v of tri) {
      const nvx = P.length / 3;
      P.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]);
      U.push(U[2 * v] < 0.5 ? U[2 * v] + 1 : U[2 * v], U[2 * v + 1]);
      L.push(L[2 * v], L[2 * v + 1]); O.push(O[v]);
      idx.push(nvx);
    }
  }
  return { pos: new Float32Array(P), uv: U, ll: L, ok: O, index: idx };
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

const GLOBE_OPACITY = 0.3, GLOBE_OPACITY_MAP = 0.7;

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

// ---------------------------------------------------------------- data

let coast = [];
const grat = graticule(15, 2);
let linkPool = [];

function buildLinkPool() {
  linkPool = samplePoints(coast, state.from, state.seed, LINK_POOL);
}

// ---------------------------------------------------------------- rebuild

function rebuild() {
  const p = params();
  const roll = makeRoller(p, state.t);
  const A = [0, 0, 0], B = [0, 0, 0];

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

  // surface: a grid in the surface's own lon/lat, from the back meridian
  // round to the back meridian, textured by the geographic lon/lat of each
  // vertex (triangles across the antimeridian get their own copies of it)
  const latStart = 89;
  const nv = (SURF_NX + 1) * (SURF_NY + 1);
  const sp = new Float32Array(nv * 3), ok = new Uint8Array(nv), ll = new Float32Array(nv * 2), uv = new Float32Array(nv * 2);
  for (let j = 0, k = 0; j <= SURF_NY; j++)
    for (let i = 0; i <= SURF_NX; i++, k++) {
      const lonA = Math.max(-179.999, Math.min(-180 + i * SURF_DLON, 179.999));
      const latA = latStart - j * SURF_DLAT;
      const [lon, lat] = state.tilt ? fam.fromAxis(lonA, latA, p) : [state.lon + lonA, latA];
      ll[2 * k] = lon; ll[2 * k + 1] = lat;
      uv[2 * k] = (lon + 180) / 360; uv[2 * k + 1] = (lat + 90) / 180;
      const fp = fam.flatPolar(lon, lat, p);
      if (inReach(fp)) { roll(fp, sp, k * 3); ok[k] = 1; }
    }
  const surf = seamSplit(sp, uv, ll, ok, gridIndex(SURF_NX, SURF_NY, ok));
  if (relief) displace(surf.pos, surf.index, (k) => (surf.ok[k] ? [surf.ll[2 * k], surf.ll[2 * k + 1]] : null), world, state.relief);
  setMesh(surface, surf.pos, surf.uv, surf.index);

  // coastlines on the globe and the surface, and the graticule
  const drawOn = (lines, globeOut, surfOut) => {
    for (const line of lines) {
      let prevF = null, prevLon = 0, prevLat = 0;
      for (let i = 0; i < line.length; i += 2) {
        const lon = line[i], lat = line[i + 1];
        onGlobe(lon, lat, B);
        const fp = fam.flatPolar(lon, lat, p);
        const f = inReach(fp) ? roll(fp, [0, 0, 0]) : null;
        if (i > 0) {
          if (globeOut) globeOut.push(A[0], A[1], A[2], B[0], B[1], B[2]);
          const dl = Math.abs(axisLon(lon, lat) - axisLon(prevLon, prevLat));
          if (f && prevF && dl < 90) surfOut.push(prevF[0], prevF[1], prevF[2], f[0], f[1], f[2]);
        }
        A[0] = B[0]; A[1] = B[1]; A[2] = B[2];
        prevF = f; prevLon = lon; prevLat = lat;
      }
    }
  };
  const cg = [], cs = [], gg = [], gs = [];
  drawOn(coast, cg, cs);
  drawOn(grat, gg, gs);
  setLines("coastGlobe", cg, COLORS.coastOn, 0.9).visible = !!state.globe;
  setLines("coastSurf", cs, COLORS.surfCoast, 1, 2);
  setLines("gratGlobe", gg, COLORS.grat, 0.5).visible = !!state.grat && !!state.globe;
  setLines("gratSurf", gs, COLORS.surfGrat, 0.7, 1).visible = !!state.grat;

  // the standard parallel, where the cone touches the sphere
  const sp1 = [];
  for (let k = 0; k < 180; k++) {
    onGlobeAxis(-180 + 2 * k, p.lat1, A); onGlobeAxis(-178 + 2 * k, p.lat1, B);
    sp1.push(A[0], A[1], A[2], B[0], B[1], B[2]);
  }
  setLines("stdParallel", sp1, COLORS.parallel, 0.95, 3);

  // links from the globe to the surface
  const links = [];
  let count = 0;
  for (const [lon, lat] of linkPool) {
    // the even lattice is all drawn: its density is what the slider sets
    if (count >= state.links && state.from !== "even") break;
    const fp = fam.flatPolar(lon, lat, p);
    if (!inReach(fp)) continue;
    roll(fp, A); onGlobe(lon, lat, B);
    links.push(B[0], B[1], B[2], A[0], A[1], A[2]);
    count++;
  }
  setLines("links", links, COLORS.link, 0.4, 1);

  scheduleBasemap(p);
  drawMap(p);
  updatePanel(p);
}

// ---------------------------------------------------------------- flat map extent

// The flat map box: everything within reach of the standard parallel.
function mapBox(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let latA = -89; latA <= 89; latA += 1)
    for (let lonA = -180; lonA <= 180; lonA += 2) {
      const [l, lat] = fam.fromAxis(Math.max(-179.999, Math.min(179.999, lonA)), latA, p);
      const fp = fam.flatPolar(l, lat, p);
      if (!inReach(fp)) continue;
      const xy = fam.project(l, lat, p);
      x0 = Math.min(x0, xy[0]); x1 = Math.max(x1, xy[0]); y0 = Math.min(y0, xy[1]); y1 = Math.max(y1, xy[1]);
    }
  const pad = 0.03 * Math.max(x1 - x0, y1 - y0);
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

// ---------------------------------------------------------------- basemap

let world = null, worldTexture = null;
const flatCanvas = document.createElement("canvas");
let flatBox = null, basemapTimer = 0;

function renderFlat(p, longSide) {
  if (!world) return;
  flatBox = mapBox(p);
  const [x0, y0, x1, y1] = flatBox;
  const ar = (x1 - x0) / (y1 - y0);
  const nx = Math.max(1, Math.round(ar >= 1 ? longSide : longSide * ar));
  const ny = Math.max(1, Math.round(ar >= 1 ? longSide / ar : longSide));
  const rgba = reprojectBox(world, fam.inverse, p, flatBox, nx, ny);
  flatCanvas.width = nx; flatCanvas.height = ny;
  flatCanvas.getContext("2d").putImageData(new ImageData(rgba, nx, ny), 0, 0);
}

function scheduleBasemap(p) {
  if (!world) return;
  renderFlat(p, 200);
  clearTimeout(basemapTimer);
  basemapTimer = setTimeout(() => { renderFlat(params(), 700); drawMap(params()); }, 250);
}

function applyBasemapMaterials() {
  const gm = globe.material, sm = surface.material;
  if (world) {
    if (!worldTexture || worldTexture.image !== world.canvas) {
      worldTexture = new THREE.CanvasTexture(world.canvas);
      worldTexture.colorSpace = THREE.SRGBColorSpace;
      worldTexture.wrapS = THREE.RepeatWrapping;
    }
    gm.map = worldTexture; gm.color.set(0xffffff); gm.opacity = 0.7;
    sm.map = worldTexture; sm.color.set(0xffffff); sm.opacity = 0.9;
  } else {
    gm.map = null; gm.color.set(COLORS.globe); gm.opacity = 0.3;
    sm.map = null; sm.color.set(COLORS.surface); sm.opacity = 0.18;
  }
  gm.needsUpdate = sm.needsUpdate = true;
}

async function setBasemap() {
  const id = state.bm;
  writeHash();
  ui.credit.innerHTML = sources[id].credit || "";
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
  const p = params(), size = +ui.tifSize.value, R = fam.R;
  const box = mapBox(p);
  const [x0, y0, x1, y1] = box;
  const px = Math.max(x1 - x0, y1 - y0) / size;
  const nx = Math.round((x1 - x0) / px), ny = Math.round((y1 - y0) / px);
  const label = ui.tif.textContent;
  ui.tif.textContent = "Rendering...";
  ui.tif.disabled = true;
  try {
    const rgba = reprojectBox(world, fam.inverse, p, [x0, y1 - ny * px, x0 + nx * px, y1], nx, ny);
    const blob = await writeGeoTIFF({
      width: nx, height: ny, rgba,
      origin: [x0 * R, y1 * R], pixelSize: [px * R, px * R],
      geoKeys: fam.geoKeys(p)
    });
    const kind = fam.projString(p).split(" ")[0].slice(6);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `playproj-${kind}-lat1_${state.lat1}-lon${state.lon}-${state.bm}-${size}.tif`;
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
const badge = document.getElementById("badge");
let transformer = null, transformerFor = "";

function projector(p) {
  const s = fam.proj4String(p);
  if (typeof proj4 === "undefined") return null;
  if (s !== transformerFor) {
    try { transformer = proj4(`+proj=longlat +R=${fam.R}`, s); transformerFor = s; }
    catch (e) { transformer = null; transformerFor = ""; }
  }
  return transformer;
}

function drawMap(p) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = mapCanvas.clientWidth, ch = mapCanvas.clientHeight;
  if (!cw || !ch) return;
  if (mapCanvas.width !== Math.round(cw * dpr)) { mapCanvas.width = Math.round(cw * dpr); mapCanvas.height = Math.round(ch * dpr); }
  const ctx = mapCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#05070d";
  ctx.fillRect(0, 0, cw, ch);

  const box = mapBox(p);
  const [bx0, by0, bx1, by1] = box;
  const s = Math.min(cw / (bx1 - bx0), ch / (by1 - by0)) * 0.96;
  const ox = cw / 2 - ((bx0 + bx1) / 2) * s, oy = ch / 2 + ((by0 + by1) / 2) * s;
  const X = (x) => ox + x * s, Y = (y) => oy - y * s;
  const tr = projector(p);

  if (world && flatBox) {
    ctx.imageSmoothingEnabled = true;
    const [fx0, fy0, fx1, fy1] = flatBox;
    ctx.drawImage(flatCanvas, X(fx0), Y(fy1), (fx1 - fx0) * s, (fy1 - fy0) * s);
  }

  let maxDiff = 0, compared = 0;
  const fwd = (lon, lat) => {
    // the cut meridian belongs to either edge; leave it out of the check
    const lonA = fam.toAxis(lon, lat, p)[0];
    if (Math.abs(lonA) > 179.9) return null;
    const fp = fam.flatPolar(lon, lat, p);
    if (!inReach(fp)) return null;
    const geo = fam.project(lon, lat, p);
    if (!tr) return geo;
    // proj4js's omerc flips sign exactly 90 degrees round the axis from the
    // centre (it divides by zero there; PROJ does not): skip those points
    if (p.tilt && Math.abs(Math.abs(lonA) - 90) < 1e-9) return geo;
    let q;
    try { q = tr.forward([lon, lat]); } catch (e) { return null; }
    if (!q || !isFinite(q[0]) || !isFinite(q[1])) return null;
    const xy = [q[0] / fam.R, q[1] / fam.R];
    maxDiff = Math.max(maxDiff, Math.hypot(xy[0] - geo[0], xy[1] - geo[1]) * fam.R);
    compared++;
    return xy;
  };
  const stroke = (lines, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath();
    for (const line of lines) {
      let prev = null;
      for (let i = 0; i < line.length; i += 2) {
        const xy = fwd(line[i], line[i + 1]);
        if (xy && prev && Math.hypot(xy[0] - prev[0], xy[1] - prev[1]) < 1) ctx.lineTo(X(xy[0]), Y(xy[1]));
        else if (xy) ctx.moveTo(X(xy[0]), Y(xy[1]));
        prev = xy;
      }
    }
    ctx.stroke();
  };
  if (state.grat) stroke(grat, "rgba(217,164,65,0.55)", 0.8);
  stroke(coast, "#6ab787", 1.1);

  // Tissot's indicatrix, from the construction itself (so tilted cones,
  // which proj4js cannot draw, get them too)
  if (state.tissot) {
    const geo = (lon, lat) => {
      if (Math.abs(fam.toAxis(lon, lat, p)[0]) > 179.9) return null;
      if (!inReach(fam.flatPolar(lon, lat, p))) return null;
      return fam.project(lon, lat, p);
    };
    drawLattice(ctx, geo, (x, y) => [X(x), Y(y)], { lon0: p.lon0, maxR: 0.25 * (bx1 - bx0) });
  }

  if (tr) {
    badge.className = "badge ok";
    badge.textContent = `Drawn by proj4js. Agrees with the construction to ${maxDiff < 1e-6 ? "< 1e-6" : maxDiff.toExponential(1)} m over ${compared} points.`;
  } else if (!fam.proj4String(p)) {
    badge.className = "badge none";
    badge.textContent = "proj4js has no ob_tran: map drawn from the construction (checked against PROJ in the tests).";
  } else {
    badge.className = "badge none";
    badge.textContent = "proj4js unavailable: map drawn from the construction.";
  }
}

// ---------------------------------------------------------------- panel

const $ = (id) => document.getElementById(id);
const ui = {
  lat1: $("lat1"), t: $("t"), lon: $("lon"), tilt: $("tilt"), tiltOut: $("tilt-out"), links: $("links"),
  lat1Out: $("lat1-out"), tOut: $("t-out"), lonOut: $("lon-out"), linksOut: $("links-out"),
  proj: $("projstring"), describe: $("describe"), props: $("props"),
  grat: $("grat"), tissot: $("tissot"), globe: $("globe"), detail: $("detail"), from: $("from"),
  spin: $("spin"), relief: $("relief"), reliefOut: $("relief-out"), wire: $("wire"), bm: $("basemap"), bmStatus: $("bm-status"), credit: $("credit"), tifSize: $("tif-size"), tif: $("download-tif")
};

for (const q of fam.properties) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = q.label; b.dataset.prop = q.id;
  b.addEventListener("click", () => { state.prop = q.id; sync(); });
  ui.props.appendChild(b);
}
for (const [id, src] of Object.entries(sources)) {
  const o = document.createElement("option");
  o.value = id; o.textContent = src.label;
  ui.bm.appendChild(o);
}

function surfaceName(p) {
  const k = fam.kind(p);
  return k === 0 ? "cylinder" : k === 2 ? "plane" : `cone, n = ${fam.coneConstant(p).toFixed(3)}`;
}

function updatePanel(p) {
  ui.lat1.value = state.lat1; ui.t.value = state.t; ui.lon.value = state.lon; ui.links.value = state.links;
  ui.lat1Out.textContent = `${state.lat1}${DEG} (${surfaceName(p)})`;
  ui.tOut.textContent = state.t === 0 ? "wrapped" : state.t === 1 ? "flat" : `${Math.round(state.t * 100)}%`;
  ui.lonOut.textContent = state.lon + DEG;
  ui.tilt.value = state.tilt;
  ui.tiltOut.textContent = state.tilt === 0 ? "0\u00b0 (normal)" : Math.abs(state.tilt) === 90 ? `${state.tilt}${DEG} (transverse)` : `${state.tilt}${DEG} (oblique)`;
  ui.linksOut.textContent = state.from === "even" && coast.length
    ? `${state.links} on land, ${evenSpacing(coast, state.links).toFixed(1)}${DEG} apart`
    : state.links;
  ui.grat.checked = !!state.grat; ui.tissot.checked = !!state.tissot; ui.globe.checked = !!state.globe; ui.detail.value = state.detail; ui.from.value = state.from;
  ui.bm.value = state.bm;
  ui.spin.checked = !!state.spin;
  ui.relief.value = state.relief; ui.wire.checked = !!state.wire;
  ui.relief.disabled = ui.wire.disabled = !hasElevation(world);
  ui.reliefOut.textContent = !hasElevation(world) ? "needs GEBCO" : state.relief ? `${state.relief}x` : "off";
  ui.tif.disabled = !world;
  ui.proj.textContent = fam.projString(p);
  ui.describe.textContent = fam.describe(p);
  for (const b of ui.props.children) b.classList.toggle("active", b.dataset.prop === state.prop);
}

let rafPending = false;
function sync() {
  writeHash();
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; rebuild(); });
}

// snap the standard parallel to the cylinder and the planes
const snapLat = (v) => (Math.abs(v) < 1 ? 0 : Math.abs(Math.abs(v) - 90) < 1 ? Math.sign(v) * 90 : v);

ui.lat1.addEventListener("input", () => { stopAnim(); state.lat1 = snapLat(+ui.lat1.value); sync(); });
ui.t.addEventListener("input", () => { stopAnim(); state.t = +ui.t.value; sync(); });
ui.lon.addEventListener("input", () => { state.lon = +ui.lon.value; sync(); });
ui.tilt.addEventListener("input", () => { state.tilt = +ui.tilt.value; sync(); });
ui.links.addEventListener("input", () => { state.links = +ui.links.value; if (state.from === "even") buildLinkPool(); sync(); });
ui.grat.addEventListener("change", () => { state.grat = ui.grat.checked ? 1 : 0; sync(); });
ui.tissot.addEventListener("change", () => { state.tissot = ui.tissot.checked ? 1 : 0; sync(); });
ui.globe.addEventListener("change", () => { state.globe = ui.globe.checked ? 1 : 0; sync(); });
ui.detail.addEventListener("change", async () => { state.detail = ui.detail.value; await loadData(); sync(); });
ui.from.addEventListener("change", () => { state.from = ui.from.value; buildLinkPool(); sync(); });
ui.bm.addEventListener("change", () => { state.bm = ui.bm.value; setBasemap(); });
ui.spin.addEventListener("change", () => { state.spin = ui.spin.checked ? 1 : 0; controls.autoRotate = !!state.spin; writeHash(); });
ui.tif.addEventListener("click", downloadTIF);
ui.relief.addEventListener("input", () => { state.relief = +ui.relief.value; sync(); });
ui.wire.addEventListener("change", () => { state.wire = ui.wire.checked ? 1 : 0; sync(); });
$("reseed").addEventListener("click", () => { state.seed = (state.seed % 9999) + 1; buildLinkPool(); sync(); });
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(DEFAULT_CAM); writeHash(); });

// animations: unroll and back, or sweep the standard parallel pole to pole
let anim = null, dir = 1, lastT = 0;
const unrollBtn = $("play-unroll"), sweepBtn = $("sweep");
function stopAnim() {
  anim = null;
  unrollBtn.textContent = "Unroll";
  sweepBtn.textContent = "Sweep cone";
}
unrollBtn.addEventListener("click", () => {
  if (anim === "unroll") return stopAnim();
  stopAnim(); anim = "unroll"; dir = state.t >= 1 ? -1 : 1; unrollBtn.textContent = "Stop"; lastT = performance.now();
});
sweepBtn.addEventListener("click", () => {
  if (anim === "sweep") return stopAnim();
  stopAnim(); anim = "sweep"; dir = state.lat1 >= 90 ? -1 : 1; sweepBtn.textContent = "Stop"; lastT = performance.now();
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
    if (anim === "unroll") {
      state.t = Math.max(0, Math.min(1, state.t + dir * dt * 0.3));
      if (state.t === 1 || state.t === 0) stopAnim();
    } else {
      let v = state.lat1 + dir * dt * 14;
      if (v >= 90) { v = 90; dir = -1; }
      if (v <= -90) { v = -90; dir = 1; }
      state.lat1 = Math.round(v * 10) / 10;
    }
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
