// playproj: Icechunk and Zarr.
//
// A store's gridded variable, drawn where its CRS puts it. The grid is a
// mesh over index space (columns and rows), textured with the cells, the
// chunks and a colour (the data as chunks are read, the true area of each
// cell, or the angular distortion of the store's CRS), with its vertices on
// the globe at t = 0 and in a chosen projection at t = 1. The URL hash is
// gridlook's: #<store>::varname=..::projection=..::lat=..::lon=..

import * as THREE from "three";
import * as zarr from "zarrita";
import * as C from "../src/core/storecrs.js";
import * as R from "./store-read.js";
import { factors } from "../src/core/tissot.js";
import { colourScale, paint, quantile } from "../src/core/distortion.js";
import { knownProj4 } from "../src/core/structure.js";
import { PALETTES, rampAt } from "../src/core/palette.js";
import * as spilhaus from "../src/core/families/spilhaus.js";
import { useEqearth } from "../src/core/eqearth.js";
import { graticule } from "../src/core/geo.js";
import { loadCoastline } from "./data.js";
import { makeStage, shareLinks, copyText, isEmbed } from "../src/scene/index.js";

// proj4js's own Equal Earth is the sphere only: a store in EPSG:8857 needs the ellipsoid
const proj4 = useEqearth(window.proj4);
const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";
const D2R = Math.PI / 180;
const TEX = 2048;
const VIRIDIS = PALETTES.viridis;
const AUTO_CHUNKS = 64, AUTO_BYTES = 32 * 2 ** 20, PICK_BYTES = 160 * 2 ** 20, SAMPLE = 24;

const COLORS = {
  bg: 0x05070d,
  frame: "#16233b",
  cell: "rgba(255,255,255,0.22)",
  chunk: "rgba(255,211,77,0.9)",
  chunkFaint: "rgba(255,211,77,0.55)",
  edge: "#6ab787",
  pick: "#ff7ab8",
  coast: 0xd7ecff,
  grat: 0x5b7aa3
};

const fixture = (name) => new URL(`../test/fixtures/store/${name}`, import.meta.url).href;
const PRESETS = [
  { label: "Lambert conformal (synthetic)", url: fixture("lcc.icechunk"), varname: "t2m", projection: "mollweide" },
  { label: "Polar stereographic, km (synthetic)", url: fixture("polar.icechunk"), varname: "ice", projection: "lambert_azimuthal_equal_area" },
  { label: "Global 2 degree (synthetic)", url: fixture("era.icechunk"), varname: "1x91x180/2m_temperature", projection: "equirectangular" },
  { label: "Rotated pole (synthetic)", url: fixture("rotated.icechunk"), varname: "tas", projection: "robinson" },
  { label: "GeoTransform, plain Zarr (synthetic)", url: fixture("glad.zarr"), varname: "lclu", projection: "mercator" },
  { label: "CMIP6 MPI-ESM1-2-HR tas (Gaussian)", url: "https://storage.googleapis.com/cmip6/CMIP6/CMIP/MPI-M/MPI-ESM1-2-HR/historical/r1i1p1f1/Amon/tas/gn/v20190710", varname: "tas", projection: "mollweide" },
  { label: "CMIP6 GFDL-ESM4 tos (tripolar)", url: "https://storage.googleapis.com/cmip6/CMIP6/CMIP/NOAA-GFDL/GFDL-ESM4/historical/r2i1p1f1/Omon/tos/gn/v20180701", varname: "tos", projection: "native" },
  // a virtual Icechunk on source.coop (a scratch bucket, so it may move)
  { label: "ACCESS-ESM1.6 ocean temp (Icechunk)", url: "https://data.source.coop/ausantarctic/ausantarctic-scratch/access-esm/access-esm1-6.historical.ocean-3d-temp-1mon-mean/icechunk", varname: "temp", projection: "equal_earth" },
  // profiles, not a grid: CTD tags on seals (MEOP, through IMOS), virtual refs into IMOS's NetCDF files
  // GRIB messages as chunks, decoded here by gribberish (js/gribberish.js): ECMWF's open
  // data, indexed by dynamical.org, opened at the newest forecast
  { label: "ECMWF ENS 2 m temperature (GRIB)", url: "https://dynamical-ecmwf-ifs-ens.s3.us-west-2.amazonaws.com/ecmwf-ifs-ens-forecast-15-day-0-25-degree-virtual/v0.1.0.icechunk", varname: "temperature_2m", projection: "equal_earth", dims: { init_time: -1 } },
  { label: "Seal CTD profiles, MEOP (Icechunk)", url: "https://data.source.coop/ausantarctic/ausantarctic-scratch/imos-tracking/meop-ctd-2024/icechunk", varname: "TEMP", projection: "lambert_azimuthal_equal_area", lat: -90, lon: 140 }
];

// ---------------------------------------------------------------- state

// gridlook's keys (url, varname, projection, lat, lon, dimIndices_<dim>) and
// this page's own, which gridlook ignores
const defaults = { url: PRESETS[0].url, varname: "", projection: "mollweide", lat: null, lon: null,
  t: 0, colour: "data", chunks: 1, cells: 1, coast: 1, grat: 1, pick: "", cam: null, assume: "" };
const state = { ...defaults, dims: {} };

function readHash() {
  const { url, params } = C.parseHash(location.hash);
  Object.assign(state, defaults, { dims: {} });
  if (url) state.url = url;
  const num = (k) => (params.has(k) && params.get(k) !== "" && isFinite(+params.get(k)) ? +params.get(k) : null);
  state.varname = params.get("varname") || (url ? "" : PRESETS[0].varname);
  const p = params.get("projection");
  if (p && C.DISPLAY_KEYS.includes(p)) state.projection = p;
  else if (!url) state.projection = PRESETS[0].projection;
  state.lat = num("lat"); state.lon = num("lon");
  for (const k of ["t", "chunks", "cells", "coast", "grat"]) { const v = num(k); if (v !== null) state[k] = v; }
  state.t = Math.max(0, Math.min(1, state.t));
  const c = params.get("colour");
  if (["data", "area", "omega", "none", "time", "group"].includes(c)) state.colour = c;
  state.pick = params.get("pick") || "";
  state.assume = R.ASSUME[params.get("assume")] ? params.get("assume") : "";
  const cam = (params.get("cam") || "").split(",").map(Number);
  state.cam = cam.length === 6 && cam.every(isFinite) ? cam : null;
  for (const [k, v] of params) if (k.startsWith("dimIndices_") && isFinite(+v)) state.dims[k.slice(11)] = Math.max(0, Math.round(+v));
}

let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const p = { varname: state.varname, projection: state.projection === defaults.projection ? "" : state.projection };
    if (state.lat !== null) p.lat = +state.lat.toFixed(3);
    if (state.lon !== null) p.lon = +state.lon.toFixed(3);
    for (const [d, i] of Object.entries(state.dims)) if (i) p[`dimIndices_${d}`] = i;
    if (state.t) p.t = +state.t.toFixed(3);
    for (const k of ["colour", "chunks", "cells", "coast", "grat"]) if (state[k] !== defaults[k]) p[k] = state[k];
    // time is to profiles what the data is to a grid: the default, left out
    if (cur && cur.kind === "profiles" && state.colour === "time") delete p.colour;
    if (state.pick) p.pick = state.pick;
    if (state.assume) p.assume = state.assume;
    if (state.cam) p.cam = state.cam.map((x) => +x.toFixed(2)).join(",");
    history.replaceState(null, "", "#" + C.hashString(state.url, p));
    $("open-full").href = location.pathname + location.hash;
    updateGridlook();
  }, 200);
}

// ---------------------------------------------------------------- CRS

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

async function crsOf(v) {
  let crs = v.crs;
  if (crs && crs.epsg && !knownProj4(crs.epsg)) {
    const def = await lookupEpsg(crs.epsg);
    if (def) crs = { ...crs, proj4: def };
  }
  return C.crsFunctions(crs, proj4);
}

// the display: forward (lon, lat) -> [x, y] on a unit sphere, or null
function displayFns(key, lon0, lat0) {
  // Spilhaus is fixed on the oceans: the centre does not move it
  if (key === "spilhaus") return { fwd: (lon, lat) => { const q = spilhaus.project(lon, lat); return q && isFinite(q[0]) && isFinite(q[1]) ? q : null; }, def: spilhaus.projString() };
  const def = C.displayDef(key, lon0, lat0);
  if (!def) return null;
  const tr = proj4("+proj=longlat +R=1 +no_defs", def);
  const fwd = (lon, lat) => {
    let q;
    try { q = tr.forward([lon, lat]); } catch (e) { return null; }
    if (!q || !isFinite(q[0]) || !isFinite(q[1])) return null;
    // proj4js answers beyond an azimuthal's horizon: insist on the way back
    let b;
    try { b = tr.inverse(q); } catch (e) { return null; }
    if (!b || Math.abs(b[1] - lat) > 1e-6) return null;
    return q;
  };
  return { fwd, def };
}

// ---------------------------------------------------------------- scene

const stage = $("three");
const { renderer, scene, camera, controls, setCamera, resize } = makeStage(stage, {
  bg: COLORS.bg, near: 0.01,
  onCamera: (c) => { state.cam = c; writeHash(); }
});
const DEFAULT_CAM = [0, 0, 6.4, 0, 0, 0.3];
const under = new THREE.Mesh(new THREE.SphereGeometry(0.99, 96, 48), new THREE.MeshBasicMaterial({ color: 0x0b1222, transparent: true }));
scene.add(under);
const coastLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COLORS.coast, transparent: true, opacity: 0.75 }));
const gratLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COLORS.grat, transparent: true, opacity: 0.55 }));
scene.add(coastLines, gratLines);

const texCanvas = document.createElement("canvas");
const texture = new THREE.CanvasTexture(texCanvas);
texture.colorSpace = THREE.SRGBColorSpace;
texture.anisotropy = 8;
const gridMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent: true }));
scene.add(gridMesh);

// The frame turns the sphere so lon0, lat0 faces the camera (+z), north up.
function frameAt(lon0, lat0) {
  const p = lat0 * D2R, l = lon0 * D2R;
  const n = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  const e = [-Math.sin(l), Math.cos(l), 0];
  const u = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
  return (lon, lat, r = 1) => {
    const cp = Math.cos(lat * D2R), x = cp * Math.cos(lon * D2R), y = cp * Math.sin(lon * D2R), z = Math.sin(lat * D2R);
    return [r * (x * e[0] + y * e[1] + z * e[2]), r * (x * u[0] + y * u[1] + z * u[2]), r * (x * n[0] + y * n[1] + z * n[2])];
  };
}

let coast = null;
const grat = graticule(10, 1);
let cur = null;   // the open store, variable and everything drawn from it

// ---------------------------------------------------------------- geometry

// lon/lat of every vertex of a lattice over index space
// Where a fractional edge index (fi from 0 to nx, fj from 0 to ny) is in the
// store's own coordinates, and on the earth, for each kind of grid.
function nativeXY(fi, fj) {
  const { g } = cur;
  if (g.kind === "curvilinear") return [fi, fj];
  if (g.kind === "rectilinear") return [g.xc ? C.axisAt(g.xc, fi) : g.x0 + fi * g.dx, g.yc ? C.axisAt(g.yc, fj) : g.y0 + fj * g.dy];
  return C.cellXY(g, fi, fj);
}
function makeAt() {
  const { g, F } = cur;
  if (g.kind === "curvilinear") return (fi, fj) => C.curvAt(g, fi, fj);
  if (!F) return () => null;
  return (fi, fj) => {
    let [x, y] = nativeXY(fi, fj);
    // cells centred on a pole reach past it
    if (F.angular) y = Math.max(-90, Math.min(90, y));
    return F.inv(x, y);
  };
}

function buildLattice() {
  const { g } = cur;
  const a = g.nx / g.ny;
  const MU = Math.max(2, Math.min(g.nx, Math.round(a >= 1 ? 240 : 240 * a)));
  const MV = Math.max(2, Math.min(g.ny, Math.round(a >= 1 ? 240 / a : 240)));
  const n = (MU + 1) * (MV + 1), ll = new Array(n);
  for (let j = 0, m = 0; j <= MV; j++)
    for (let i = 0; i <= MU; i++, m++) {
      ll[m] = cur.at((i / MU) * g.nx, (j / MV) * g.ny);
    }
  const mid = cur.earth ? cur.at(g.nx / 2, g.ny / 2) || ll.find(Boolean) : null;
  // the lon/lat box of the grid, for the readout
  let la0 = 90, la1 = -90;
  for (const q of ll) if (q) { la0 = Math.min(la0, q[1]); la1 = Math.max(la1, q[1]); }
  cur.lat = { lo: la0, hi: la1 };
  // which way rows and columns run on the earth (nowhere on it: as stored)
  const dirs = cur.earth ? C.gridDirections(ll, MU, MV) : { rows: null, cols: null };
  Object.assign(cur, { MU, MV, ll, dirs, mid: mid || [0, 0] });
}

// The display's world: its outline's box, so a regional grid sits in context
function worldBox(D) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let lat = -89.5; lat <= 89.5; lat += 1)
    for (let lon = -180; lon <= 180; lon += 1) {
      const q = D.fwd(lon, lat);
      if (!q) continue;
      x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
    }
  return [x0, y0, x1, y1];
}

// where each vertex goes at t = 1, and the scale that fits the view
function buildFlat() {
  if (cur.kind === "profiles") return buildProfilesFlat();
  const { g, F, ll } = cur;
  const lon0 = state.lon ?? cur.mid[0], lat0 = state.lat ?? cur.mid[1];
  cur.frame = frameAt(lon0, lat0);
  const native = state.projection === "native" && cur.earth;
  const D = native ? (F ? { fwd: (lon, lat) => F.fwd(lon, lat) } : { fwd: () => null }) : displayFns(state.projection, lon0, lat0);
  cur.D = D;
  let box;
  if (native) {
    const c = [nativeXY(0, 0), nativeXY(g.nx, 0), nativeXY(0, g.ny), nativeXY(g.nx, g.ny)];
    box = [Math.min(...c.map((q) => q[0])), Math.min(...c.map((q) => q[1])), Math.max(...c.map((q) => q[0])), Math.max(...c.map((q) => q[1]))];
  } else if (!cur.earth) box = C.gridExtent(g);
  else if (D) box = worldBox(D);
  const n = ll.length;
  const sphere = new Float32Array(n * 3), flat = new Float32Array(n * 3), uv = new Float32Array(n * 2), valid = new Uint8Array(n);
  const k = box ? Math.min(3.8 / (box[2] - box[0]), 2.6 / (box[3] - box[1])) : 1;
  const cx = box ? (box[0] + box[2]) / 2 : 0, cy = box ? (box[1] + box[3]) / 2 : 0;
  cur.place = (q) => [(q[0] - cx) * k, (q[1] - cy) * k, 1];
  cur.box = box;
  for (let j = 0, m = 0; j <= cur.MV; j++)
    for (let i = 0; i <= cur.MU; i++, m++) {
      uv[2 * m] = i / cur.MU; uv[2 * m + 1] = 1 - j / cur.MV;
      const q = ll[m];
      if (!cur.earth) {
        // nowhere on the earth: the grid flat in index space, columns right and rows down
        const p = [(i / cur.MU - 0.5) * 3.8, (0.5 - j / cur.MV) * 3.8 * (g.ny / g.nx), 1];
        sphere.set(p, 3 * m); flat.set(p, 3 * m); valid[m] = 1;
        continue;
      }
      if (!q) continue;
      sphere.set(cur.frame(q[0], q[1]), 3 * m);
      if (D) {
        const xy = native ? nativeXY((i / cur.MU) * g.nx, (j / cur.MV) * g.ny) : D.fwd(q[0], q[1]);
        if (!xy) continue;
        flat.set(cur.place(xy), 3 * m);
      } else flat.set(sphere.subarray(3 * m, 3 * m + 3), 3 * m);
      valid[m] = 1;
    }
  // triangles with all three corners on the map, and none across a seam
  const W = box ? (box[2] - box[0]) * k : 4;
  const far = (arr, lim, a, b) => Math.hypot(arr[3 * a] - arr[3 * b], arr[3 * a + 1] - arr[3 * b + 1], arr[3 * a + 2] - arr[3 * b + 2]) > lim;
  const index = [];
  const tri = (a, b, c) => {
    if (!valid[a] || !valid[b] || !valid[c]) return;
    if (far(sphere, 0.5, a, b) || far(sphere, 0.5, b, c) || far(sphere, 0.5, a, c)) return;
    if (far(flat, 0.25 * W, a, b) || far(flat, 0.25 * W, b, c) || far(flat, 0.25 * W, a, c)) return;
    index.push(a, b, c);
  };
  const MU = cur.MU;
  for (let j = 0; j < cur.MV; j++)
    for (let i = 0; i < MU; i++) {
      const a = j * (MU + 1) + i, b = a + MU + 1;
      tri(a, a + 1, b); tri(a + 1, b + 1, b);
    }
  cur.mesh = { sphere, flat };
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(sphere.slice(), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  gridMesh.geometry.dispose();
  gridMesh.geometry = geo;
  buildLines();
}

// coastline and graticule, morphing with the grid; pairs that jump a seam
// in the flat map are left out
function lineGeometry(lines, mesh) {
  const { D, frame, place } = cur;
  const sp = [], fp = [];
  const W = cur.box ? (cur.box[2] - cur.box[0]) : 0;
  const native = state.projection === "native";
  const inBox = (q) => !native || (q[0] >= cur.box[0] - 0.25 * W && q[0] <= cur.box[2] + 0.25 * W && q[1] >= cur.box[1] - 0.25 * (cur.box[3] - cur.box[1]) && q[1] <= cur.box[3] + 0.25 * (cur.box[3] - cur.box[1]));
  for (const l of lines || []) {
    let pq = null;
    for (let i = 0; i < l.length; i += 2) {
      const q = D ? D.fwd(l[i], l[i + 1]) : null;
      const ok = !D || (q && inBox(q));
      if (i && ok && (pq || !D) && Math.abs(l[i] - l[i - 2]) <= 180 && (!D || Math.hypot(q[0] - pq[0], q[1] - pq[1]) < 0.1 * W)) {
        sp.push(...frame(l[i - 2], l[i - 1], 1.003), ...frame(l[i], l[i + 1], 1.003));
        if (D) { const a = place(pq), b = place(q); a[2] = b[2] = 1.003; fp.push(...a, ...b); }
        else fp.push(...frame(l[i - 2], l[i - 1], 1.003), ...frame(l[i], l[i + 1], 1.003));
      }
      pq = ok ? q : null;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(sp.slice(), 3));
  mesh.geometry.dispose();
  mesh.geometry = g;
  mesh.userData = { sphere: new Float32Array(sp), flat: new Float32Array(fp) };
}

function buildLines() {
  if (!cur.earth) { coastLines.visible = gratLines.visible = false; return; }
  // Earth's coastline only on Earth
  lineGeometry(cur.v.crs && cur.v.crs.body ? null : coast, coastLines);
  lineGeometry(grat, gratLines);
}

const ease = (x) => x * x * (3 - 2 * x);
function morph(arr, sphere, flat, e) {
  for (let i = 0; i < arr.length; i++) arr[i] = sphere[i] + (flat[i] - sphere[i]) * e;
}
function place() {
  if (!cur || (!cur.mesh && cur.kind !== "profiles")) return;
  const e = cur.earth && cur.D ? ease(state.t) : cur.earth ? 0 : 1;
  const meshes = cur.kind === "profiles" ? PROF_MESHES.filter((M) => M.visible && M.userData.sphere).map((M) => [M, M.userData]) : [[gridMesh, cur.mesh]];
  for (const [M, u] of meshes) {
    const pos = M.geometry.attributes.position;
    morph(pos.array, u.sphere, u.flat, e);
    pos.needsUpdate = true;
    M.geometry.computeBoundingSphere();
  }
  for (const [L, on] of [[coastLines, state.coast], [gratLines, state.grat]]) {
    L.visible = !!(cur.earth && on);
    if (!L.visible || !L.geometry.attributes.position) continue;
    const u = L.userData, p = L.geometry.attributes.position;
    morph(p.array, u.sphere, u.flat, e);
    p.needsUpdate = true;
    L.geometry.computeBoundingSphere();
  }
  const fade = cur.earth ? Math.max(0, 1 - 3 * e) : 0;
  under.visible = fade > 0;
  under.material.opacity = fade;
}

// ---------------------------------------------------------------- the texture

function texSize() {
  const { g } = cur, a = g.nx / g.ny;
  // never more texels than cells along an axis (small grids stay crisp)
  const T = Math.min(TEX, renderer.capabilities.maxTextureSize || TEX);
  let W = a >= 1 ? T : Math.round(T * a), H = a >= 1 ? Math.round(T / a) : T;
  const up = Math.max(1, Math.floor(Math.min(W / g.nx, H / g.ny)));
  if (W > g.nx * up && H > g.ny * up) { W = g.nx * up; H = g.ny * up; }
  if (W < 256 || H < 256) { const s = Math.ceil(256 / Math.min(W, H)); W *= s; H *= s; }
  return [Math.max(2, W), Math.max(2, H)];
}

// the colour layer: an image of nx x ny (or fewer) samples
function fieldImage() {
  if (state.colour === "data") return cur.dataCanvas;
  if (state.colour === "area" || state.colour === "omega") return distortionImage(state.colour);
  return null;
}

function drawTexture() {
  if (cur.kind === "profiles") return colourProfiles();
  const { g } = cur;
  const [W, H] = texSize();
  if (texCanvas.width !== W || texCanvas.height !== H) { texCanvas.width = W; texCanvas.height = H; texture.dispose(); }
  const ctx = texCanvas.getContext("2d");
  const sx = W / g.nx, sy = H / g.ny, lw = Math.max(1, W / 1400);
  ctx.globalAlpha = 1;
  ctx.fillStyle = COLORS.frame;
  ctx.fillRect(0, 0, W, H);
  const img = fieldImage();
  if (img) {
    ctx.imageSmoothingEnabled = img.width < g.nx / 2;
    ctx.drawImage(img, 0, 0, W, H);
  }
  // cells, then chunks; a line only where they are far enough apart to see
  const lines = (step, n, alongX, style, width) => {
    ctx.strokeStyle = style; ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i <= n; i += step) {
      if (alongX) { const x = Math.min(W, i * sx); ctx.moveTo(x, 0); ctx.lineTo(x, H); } else { const y = Math.min(H, i * sy); ctx.moveTo(0, y); ctx.lineTo(W, y); }
    }
    ctx.stroke();
  };
  cur.drawNote = "";
  if (state.cells) {
    if (sx >= 8 && sy >= 8) { lines(1, g.nx, true, COLORS.cell, lw * 0.7); lines(1, g.ny, false, COLORS.cell, lw * 0.7); }
    else cur.drawNote = "cells too small to outline at this size";
  }
  if (state.chunks) {
    const { cxs, cys } = cur;
    const tx = sx * cxs, ty = sy * cys;
    // every chunk boundary, or every 10th, 100th ... when they crowd
    let every = 1;
    while (Math.min(tx, ty) * every < 16) every *= 10;
    const faint = every > 1;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    const cl = (stepCells, n, alongX) => {
      ctx.strokeStyle = faint ? COLORS.chunkFaint : COLORS.chunk; ctx.lineWidth = 2 * lw;
      ctx.beginPath();
      for (let c = 0; c * stepCells <= n + stepCells; c += every) {
        const v = Math.min(n, c * stepCells);
        if (alongX) { ctx.moveTo(v * sx, 0); ctx.lineTo(v * sx, H); } else { ctx.moveTo(0, v * sy); ctx.lineTo(W, v * sy); }
      }
      ctx.stroke();
    };
    cl(cxs, g.nx, true); cl(cys, g.ny, false);
    ctx.restore();
    if (every > 1) cur.drawNote = (cur.drawNote ? cur.drawNote + "; " : "") + `every ${every}th chunk boundary drawn`;
    // labels where there is room. The texture is the array as stored (row 0
    // at the top), so on a grid stored south first each label is turned
    // over to read upright on the earth, and mirrored where columns run west.
    if (!faint && tx >= 60 && ty >= 24 && cur.cx * cur.cy > 1 && cur.cx * cur.cy <= 2000) {
      ctx.fillStyle = "rgba(255,230,160,0.9)";
      ctx.font = `${Math.min(ty * 0.3, tx * 0.14, 34 * lw)}px ui-monospace, monospace`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const dirs = cur.dirs || {}, fx = dirs.cols === "west" ? -1 : 1, fy = dirs.rows === "north" ? -1 : 1;
      for (let r = 0; r < cur.cy; r++)
        for (let c = 0; c < cur.cx; c++) {
          ctx.save();
          ctx.translate(Math.min(W, (c + 0.5) * tx), Math.min(H, (r + 0.5) * ty));
          ctx.scale(fx, fy);
          ctx.fillText(`${r}, ${c}`, 0, 0);
          ctx.restore();
        }
    }
  }
  ctx.strokeStyle = COLORS.edge; ctx.lineWidth = 3 * lw;
  ctx.strokeRect(0, 0, W, H);
  const p = pickCell();
  if (p) {
    const [ci, cj] = [Math.floor(p[0] / cur.cxs), Math.floor(p[1] / cur.cys)];
    ctx.strokeStyle = COLORS.pick; ctx.lineWidth = 3 * lw;
    ctx.fillStyle = "rgba(255,122,184,0.18)";
    const r = [ci * cur.cxs * sx, cj * cur.cys * sy, Math.min(cur.cxs, g.nx - ci * cur.cxs) * sx, Math.min(cur.cys, g.ny - cj * cur.cys) * sy];
    ctx.fillRect(...r); ctx.strokeRect(...r);
    const m = 6 * lw;
    ctx.fillStyle = COLORS.pick;
    ctx.fillRect((p[0] + 0.5) * sx - Math.max(sx, m) / 2, (p[1] + 0.5) * sy - Math.max(sy, m) / 2, Math.max(sx, m), Math.max(sy, m));
  }
  texture.needsUpdate = true;
}

// ---------------------------------------------------------------- distortion

// area and angular distortion at the centres of a lattice of cells
function distortionField() {
  if (cur.dist) return cur.dist;
  const { g } = cur;
  if (!cur.earth) return null;
  const FW = Math.min(g.nx, 200), FH = Math.min(g.ny, 200);
  const area = new Float32Array(FW * FH).fill(NaN), omega = new Float32Array(FW * FH).fill(NaN);
  const h = new Float32Array(FW * FH).fill(NaN), kk = new Float32Array(FW * FH).fill(NaN);
  for (let j = 0; j < FH; j++)
    for (let i = 0; i < FW; i++) {
      const col = Math.floor(((i + 0.5) / FW) * g.nx), row = Math.floor(((j + 0.5) / FH) * g.ny);
      const m = j * FW + i, c = cellFacts(col, row);
      if (!c) continue;
      area[m] = c.area;
      if (c.f) { omega[m] = c.f.omega; h[m] = c.f.h; kk[m] = c.f.k; } else if (c.shape) omega[m] = c.shape.omega;
    }
  cur.dist = { FW, FH, area, omega, h, k: kk, med: quantile(area, 0.5) };
  return cur.dist;
}

// a cell's ground area (km2) and PROJ's factors at its centre; without a
// CRS (curvilinear), the area of the cell's corners on the sphere and how
// far the cell is from square
const EARTH_KM = 6371.0088;
function cellFacts(col, row) {
  const { g, F } = cur;
  const ll = cur.at(col + 0.5, row + 0.5);
  if (!ll) return null;
  if (!F) {
    const q = [cur.at(col, row), cur.at(col + 1, row), cur.at(col + 1, row + 1), cur.at(col, row + 1)];
    if (q.some((v) => !v)) return { ll, area: NaN };
    // ground steps of a column and a row, east and north in km
    const step = (a, b) => {
      let dl = b[0] - a[0]; dl -= 360 * Math.round(dl / 360);
      return [dl * D2R * Math.cos(((a[1] + b[1]) / 2) * D2R) * EARTH_KM, (b[1] - a[1]) * D2R * EARTH_KM];
    };
    const shape = C.cellShape(step(cur.at(col, row + 0.5), cur.at(col + 1, row + 0.5)), step(cur.at(col + 0.5, row), cur.at(col + 0.5, row + 1)));
    return { ll, shape, area: C.sphereQuadArea(q) * EARTH_KM * EARTH_KM };
  }
  const f = factors(F.unit, ll[0], ll[1], { es: F.es });
  let area;
  const [xa, ya] = nativeXY(col, row), [xb, yb] = nativeXY(col + 1, row + 1);
  if (F.angular && !/ob_tran/.test(F.def)) {
    area = C.lonLatCellArea(xb - xa, ya, yb, F.es) * F.a * F.a;
  } else if (f) {
    const w = Math.abs((xb - xa) * (yb - ya));
    const mapArea = F.angular ? w * D2R * D2R : w / (F.a * F.a);
    area = C.projectedCellArea(mapArea, f.s) * F.a * F.a;
  }
  return area === undefined ? null : { ll, f, area: area / 1e6 };
}

// area as a fraction of the largest cell (sequential, linear: dark is
// small); angular distortion on the distortion page's scale
function distortionImage(key) {
  const d = distortionField();
  if (!d) return null;
  const tag = "dist-" + key;
  if (cur.imgs[tag]) return cur.imgs[tag];
  let rgba, sc;
  if (key === "area") {
    let max = 0;
    for (const v of d.area) if (v > max) max = v;
    rgba = new Uint8ClampedArray(d.area.length * 4);
    d.area.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const c = rampAt(VIRIDIS, v / max);
      rgba.set([c[0], c[1], c[2], 255], 4 * i);
    });
    sc = { max };
  } else {
    sc = colourScale("omega", d.omega);
    rgba = paint(d.omega, sc);
  }
  const cv = document.createElement("canvas");
  cv.width = d.FW; cv.height = d.FH;
  cv.getContext("2d").putImageData(new ImageData(rgba, d.FW, d.FH), 0, 0);
  cv.scale = sc;
  cur.imgs[tag] = cv;
  return cv;
}

// ---------------------------------------------------------------- data

function fillValues(v) {
  const out = [];
  const f = v.meta.fill;
  if (typeof f === "number") out.push(f);
  // numbers, lists of them, or a float as xarray writes it in Zarr v3 (base64)
  for (const k of ["_FillValue", "missing_value"]) out.push(...C.attrFill(v.meta.attrs[k]));
  return new Set(out);
}

// the index of every other dimension, and the chunk along it
function otherIndex() {
  const v = cur.v, out = {};
  v.meta.shape.forEach((n, d) => { if (d !== v.ix && d !== v.iy) out[d] = Math.min(n - 1, state.dims[v.dims[d]] || 0); });
  return out;
}
function chunkIdx(cj, ci) {
  const v = cur.v, o = otherIndex();
  return v.meta.shape.map((_, d) => (d === v.iy ? cj : d === v.ix ? ci : Math.floor(o[d] / v.meta.chunks[d])));
}

async function loadChunk(cj, ci) {
  const idx = chunkIdx(cj, ci), key = idx.join(",");
  if (cur.chunkData.has(key)) return cur.chunkData.get(key);
  const p = (async () => {
    const a = cur.arr || (cur.arr = await cur.s.open(cur.v.path));
    const c = await a.getChunk(idx);
    cur.reads.chunks++; cur.reads.bytes += c.data.byteLength || c.data.length;
    return c;
  })();
  cur.chunkData.set(key, p);
  try { return await p; } catch (e) { cur.chunkData.delete(key); throw e; }
}

// value of cell col, row in a loaded chunk
function chunkValue(c, cj, ci, col, row) {
  const v = cur.v, o = otherIndex();
  let off = 0;
  for (let d = 0; d < v.meta.shape.length; d++) {
    const local = d === v.iy ? row - cj * cur.cys : d === v.ix ? col - ci * cur.cxs : o[d] - Math.floor(o[d] / v.meta.chunks[d]) * v.meta.chunks[d];
    off += local * c.stride[d];
  }
  const x = c.data[off];
  return typeof x === "bigint" ? Number(x) : x;
}

function chunkSample(c, cj, ci, target) {
  const vals = [], fills = cur.fills;
  const n = Math.min(cur.cys, cur.g.ny - cj * cur.cys), m = Math.min(cur.cxs, cur.g.nx - ci * cur.cxs);
  const step = Math.max(1, Math.floor(Math.sqrt((n * m) / target)));
  for (let r = 0; r < n; r += step) for (let q = 0; q < m; q += step) {
    const x = chunkValue(c, cj, ci, ci * cur.cxs + q, cj * cur.cys + r);
    if (Number.isFinite(x) && !fills.has(x)) vals.push(x);
  }
  return vals;
}
function scaleOf(vals, from) {
  const lo = quantile(vals, 0.02), hi = quantile(vals, 0.98);
  return { lo, hi: hi > lo ? hi : lo + 1, from };
}
function ensureScale(c, cj, ci) {
  if (cur.scale) return;
  const vals = chunkSample(c, cj, ci, 20000);
  if (vals.length) cur.scale = scaleOf(vals, 1);
}
// once several chunks are in, set the scale from all of them and repaint
async function widenScale() {
  if (!cur.scale || cur.scale.from > 1 || cur.painted.size < 2) return;
  const keys = [...cur.painted], vals = [];
  for (const k of keys) {
    const [cj, ci] = k.split(",").map(Number);
    vals.push(...chunkSample(await loadChunk(cj, ci), cj, ci, 20000 / keys.length));
  }
  if (!vals.length) return;
  cur.scale = scaleOf(vals, keys.length);
  for (const k of keys) { const [cj, ci] = k.split(",").map(Number); paintChunk(await loadChunk(cj, ci), cj, ci); }
  if (state.colour === "data") drawTexture();
}

// paint a loaded chunk into the data image
function paintChunk(c, cj, ci) {
  ensureScale(c, cj, ci);
  if (!cur.scale) return;
  const { g } = cur, cv = cur.dataCanvas, sx = cv.width / g.nx, sy = cv.height / g.ny;
  const c0 = ci * cur.cxs, c1 = Math.min(g.nx, c0 + cur.cxs), r0 = cj * cur.cys, r1 = Math.min(g.ny, r0 + cur.cys);
  const px0 = Math.floor(c0 * sx), px1 = Math.max(px0 + 1, Math.ceil(c1 * sx)), py0 = Math.floor(r0 * sy), py1 = Math.max(py0 + 1, Math.ceil(r1 * sy));
  const w = px1 - px0, h = py1 - py0, im = new ImageData(w, h), { lo, hi } = cur.scale, fills = cur.fills;
  for (let y = 0; y < h; y++) {
    const row = Math.min(r1 - 1, Math.max(r0, Math.floor((py0 + y + 0.5) / sy)));
    for (let x = 0; x < w; x++) {
      const col = Math.min(c1 - 1, Math.max(c0, Math.floor((px0 + x + 0.5) / sx)));
      const val = chunkValue(c, cj, ci, col, row), o = 4 * (y * w + x);
      if (!Number.isFinite(val) || fills.has(val)) { im.data[o + 3] = 0; continue; }
      const rgb = rampAt(VIRIDIS, (val - lo) / (hi - lo));
      im.data[o] = rgb[0]; im.data[o + 1] = rgb[1]; im.data[o + 2] = rgb[2]; im.data[o + 3] = 255;
    }
  }
  cv.getContext("2d").putImageData(im, px0, py0);
}

let readSerial = 0;
async function readChunks(list) {
  const serial = ++readSerial, todo = list.slice();
  const worker = async () => {
    while (todo.length && serial === readSerial) {
      const [cj, ci] = todo.shift();
      try {
        const c = await loadChunk(cj, ci);
        if (serial !== readSerial) return;
        paintChunk(c, cj, ci);
        cur.painted.add(`${cj},${ci}`);
        if (state.colour === "data") drawTexture();
        showReads();
      } catch (e) {
        status(`could not read chunk ${cj}, ${ci}: ${e.message}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (serial === readSerial) { await widenScale(); showLegend(); showPick(); }
}

function resetData() {
  readSerial++;
  if (cur.kind === "profiles") return;
  const [W, H] = [Math.min(cur.g.nx, TEX), Math.min(cur.g.ny, TEX)];
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  cur.dataCanvas = cv;
  cur.scale = null;
  cur.painted = new Set();
}

// read the whole slice when it is small, else a spread of chunks
const smallSlice = () => cur.cost.chunks <= AUTO_CHUNKS && cur.cost.bytes <= AUTO_BYTES;
const plural = (n, w) => `${n.toLocaleString("en")} ${w}${n === 1 ? "" : "s"}`;
function autoRead() {
  const { cx, cy } = cur;
  if (smallSlice()) {
    const list = [];
    for (let r = 0; r < cy; r++) for (let c = 0; c < cx; c++) list.push([r, c]);
    readChunks(list);
  }
}
// the read button: the slice, or a spread of chunks across it, and its size
function sampleLabel() {
  const c = cur.cost;
  if (smallSlice()) return `Read the slice (${plural(c.chunks, "chunk")})`;
  const n = sampleList().length;
  return n >= c.chunks ? `Read the slice (${plural(c.chunks, "chunk")}, ${fmtBytes(c.bytes)})` :
    `Read ${plural(n, "chunk")} across the grid (${fmtBytes(n * c.chunkBytes)})`;
}

// why a slice is not read by itself: its size, and what else its chunks hold
function notReadHint() {
  const { v, cost } = cur;
  const also = v.meta.shape.map((len, d) => [d, v.meta.chunks[d]]).filter(([d, k]) => d !== v.ix && d !== v.iy && k > 1)
    .map(([d, k]) => `${k} ${v.dims[d]} steps`);
  return `Not read yet: this slice is ${plural(cost.chunks, "chunk")}, ${fmtBytes(cost.bytes)} decoded` +
    (also.length ? `, because each chunk also holds ${also.join(" and ")}` : "") +
    `. The page reads a slice by itself only up to ${fmtBytes(AUTO_BYTES)} and ${AUTO_CHUNKS} chunks: use the button above, or click the grid to read the chunk there.`;
}
function sampleList() {
  const { cx, cy } = cur, n = Math.max(1, Math.round(Math.sqrt((SAMPLE * cx) / cy))), m = Math.max(1, Math.round(SAMPLE / n));
  const list = [];
  for (let r = 0; r < Math.min(m, cy); r++) for (let c = 0; c < Math.min(n, cx); c++)
    list.push([Math.floor(((r + 0.5) / Math.min(m, cy)) * cy), Math.floor(((c + 0.5) / Math.min(n, cx)) * cx)]);
  return list;
}

// ---------------------------------------------------------------- profiles

// A collection of profiles (Argo, MEOP: storecrs.profileRoles) is not a
// grid: it is a point per profile where it was taken, coloured by when or by
// the platform it came from, on the same globe and projections. A click
// reads that one profile (a row of the variable: a single chunk where the
// store keeps one per profile) and plots it against pressure or depth.
const pointsMesh = (size, color) => {
  const m = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size, sizeAttenuation: false, ...(color === undefined ? { vertexColors: true } : { color }) }));
  m.visible = false;
  scene.add(m);
  return m;
};
const profPoints = pointsMesh(2.5), profTrack = pointsMesh(4, 0xffffff), profMark = pointsMesh(12, COLORS.pick);
const PROF_MESHES = [profPoints, profTrack, profMark];
const PROFILE_COLOURS = [["time", "Time of the profile"], ["group", "Platform or file it came from"], ["none", "Nothing"]];
const GRID_COLOURS = [["data", "The data (chunks read so far)"], ["area", "Cell area on the earth"], ["omega", "Angular distortion of the store's CRS"], ["none", "Nothing"]];
const SECTION_MAX = 4000;
const tmpColour = new THREE.Color();

// the controls each kind of store has
function setMode(kind) {
  const prof = kind === "profiles";
  gridMesh.visible = !prof;
  for (const M of PROF_MESHES) M.visible = false;
  profPoints.visible = prof;
  $("sample").hidden = prof;
  for (const k of ["chunks", "cells"]) $(k).closest("label").hidden = prof;
  $("colour-label").textContent = prof ? "Colour the profiles by" : "Colour the cells by";
  const opts = prof ? PROFILE_COLOURS.filter(([k]) => k !== "group" || cur.group) : GRID_COLOURS;
  ui.colour.innerHTML = "";
  for (const [k, label] of opts) { const o = document.createElement("option"); o.value = k; o.textContent = label; ui.colour.appendChild(o); }
  if (!opts.some(([k]) => k === state.colour)) state.colour = opts[0][0];
  ui.colour.value = state.colour;
  $("profile-box").hidden = !prof;
  $("centre-grid").textContent = prof ? "On the profiles" : "On the grid";
  if (prof) $("dims").innerHTML = "";
}

async function openProfiles(s, v, p, serial) {
  status(`a collection of ${p.n.toLocaleString("en")} profiles: reading where each was taken ...`);
  const names = [p.lat, p.lon, p.time, p.group].filter(Boolean);
  const got = await Promise.all(names.map((n) => R.readPerProfile(s, p.by[n]).catch(() => null)));
  if (serial !== openSerial) return;
  const val = Object.fromEntries(names.map((n, i) => [n, got[i]]));
  if (!val[p.lat] || !val[p.lon]) throw new Error(`could not read ${p.lat} and ${p.lon}, the position of each profile`);
  const lon = val[p.lon].values, lat = val[p.lat].values;
  // the middle: mean latitude, and the mean direction of the longitudes
  let sx = 0, sy = 0, sl = 0, n = 0;
  for (let i = 0; i < lon.length; i++) if (Number.isFinite(lon[i]) && Math.abs(lat[i]) <= 90) { sx += Math.cos(lon[i] * D2R); sy += Math.sin(lon[i] * D2R); sl += lat[i]; n++; }
  cur = {
    kind: "profiles", s, v, p, F: null, earth: true, lon, lat, time: p.time ? val[p.time] : null, group: p.group ? val[p.group] : null,
    mid: n ? [Math.atan2(sy, sx) / D2R, sl / n] : [0, 0], placed: n, extra: new Map(), reads: { chunks: 0, bytes: 0 },
    chunkBytes: v.meta.chunks.reduce((a, b) => a * b, 1) * C.dtypeBytes(v.meta.dtype), fills: new Set()
  };
  const li = v.dims.indexOf(p.level), ii = v.dims.indexOf(p.instance);
  cur.perProfileChunks = Math.ceil(v.meta.shape[li] / v.meta.chunks[li]);
  cur.levelChunks = Math.ceil(v.meta.shape[ii] / v.meta.chunks[ii]);
  if (cur.time) { let lo = Infinity, hi = -Infinity; for (const t of cur.time.values) if (Number.isFinite(t)) { lo = Math.min(lo, t); hi = Math.max(hi, t); } cur.timeRange = lo <= hi ? [lo, hi] : null; }
  if (cur.group) cur.groups = new Set(Array.from(cur.group.values).filter(Number.isFinite)).size;
  const za = p.z && p.by[p.z];
  if (za && za.dims.length === 1) { const r = await R.readPerProfile(s, za).catch(() => null); if (r) cur.zLevels = r.values; }
  if (serial !== openSerial) return;
  setMode("profiles");
  buildFlat();
  place();
  showFacts();
  showLegend();
  showPick();
  showReads();
  status("");
  writeHash();
}

// every profile with a position on this map, on the sphere and flat
function buildProfilesFlat() {
  const lon0 = state.lon ?? cur.mid[0], lat0 = state.lat ?? cur.mid[1];
  cur.frame = frameAt(lon0, lat0);
  // the store's own coordinates are longitude and latitude: drawn as they are
  const D = displayFns(state.projection === "native" ? "equirectangular" : state.projection, lon0, lat0);
  cur.D = D;
  const box = D ? worldBox(D) : null;
  const k = box ? Math.min(3.8 / (box[2] - box[0]), 2.6 / (box[3] - box[1])) : 1;
  const cx = box ? (box[0] + box[2]) / 2 : 0, cy = box ? (box[1] + box[3]) / 2 : 0;
  cur.place = (q) => [(q[0] - cx) * k, (q[1] - cy) * k, 1];
  cur.box = box;
  const n = cur.lon.length, sp = new Float32Array(n * 3), fp = new Float32Array(n * 3), on = new Int32Array(n), at = new Int32Array(n).fill(-1);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const lo = cur.lon[i], la = cur.lat[i];
    if (!Number.isFinite(lo) || !(Math.abs(la) <= 90)) continue;
    const q = D ? D.fwd(lo, la) : null;
    if (D && !q) continue;
    sp.set(cur.frame(lo, la, 1.003), 3 * m);
    if (q) { const f = cur.place(q); fp[3 * m] = f[0]; fp[3 * m + 1] = f[1]; fp[3 * m + 2] = 1.003; } else fp.set(sp.subarray(3 * m, 3 * m + 3), 3 * m);
    on[m] = i; at[i] = m; m++;
  }
  cur.on = on.slice(0, m); cur.pointOf = at;
  setPoints(profPoints, sp.slice(0, 3 * m), fp.slice(0, 3 * m));
  colourProfiles();
  buildLines();
  markProfiles();
}

function setPoints(M, sphere, flat, lift = 0) {
  if (lift) for (const a of [sphere, flat]) for (let i = 0; i < a.length; i += 3) { const r = 1 + lift / Math.hypot(a[i], a[i + 1], a[i + 2]); if (a === sphere) { a[i] *= r; a[i + 1] *= r; a[i + 2] *= r; } else a[i + 2] += lift; }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(sphere.slice(), 3));
  if (M === profPoints) g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(sphere.length), 3));
  M.geometry.dispose();
  M.geometry = g;
  M.userData = { sphere, flat };
}

// a colour per platform or file, far apart around the hue circle
const groupColour = (g) => tmpColour.setHSL((((g * 0.6180339887) % 1) + 1) % 1, 0.7, 0.6, THREE.SRGBColorSpace);
function colourProfiles() {
  const col = profPoints.geometry.attributes.color;
  if (!col) return;
  const mode = state.colour, tr = cur.timeRange;
  for (let m = 0; m < cur.on.length; m++) {
    const i = cur.on[m];
    if (mode === "time" && cur.time && tr) {
      const t = cur.time.values[i];
      if (Number.isFinite(t)) { const rgb = rampAt(VIRIDIS, tr[1] > tr[0] ? (t - tr[0]) / (tr[1] - tr[0]) : 0.5); tmpColour.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace); }
      else tmpColour.setRGB(0.5, 0.5, 0.5, THREE.SRGBColorSpace);
    } else if (mode === "group" && cur.group && Number.isFinite(cur.group.values[i])) groupColour(cur.group.values[i]);
    else tmpColour.setRGB(0.82, 0.86, 0.92, THREE.SRGBColorSpace);
    col.array[3 * m] = tmpColour.r; col.array[3 * m + 1] = tmpColour.g; col.array[3 * m + 2] = tmpColour.b;
  }
  col.needsUpdate = true;
}

const profilePick = () => {
  if (!cur || cur.kind !== "profiles" || !/^\d+$/.test(state.pick)) return null;
  const i = +state.pick;
  return i < cur.p.n ? i : null;
};
// the profiles of the picked one's platform or file
function sameGroup(i) {
  if (!cur.group || !Number.isFinite(cur.group.values[i])) return [];
  const g = cur.group.values[i], out = [];
  for (let k = 0; k < cur.group.values.length; k++) if (cur.group.values[k] === g) out.push(k);
  return out;
}
// the picked profile, and its platform's other profiles, drawn over the rest
function markProfiles() {
  const i = profilePick(), u = profPoints.userData;
  profMark.visible = profTrack.visible = false;
  if (i === null || !u.sphere) return;
  const pts = (list, lift, M) => {
    const ms = list.map((k) => cur.pointOf[k]).filter((m) => m >= 0);
    if (!ms.length) return;
    const sp = new Float32Array(ms.length * 3), fp = new Float32Array(ms.length * 3);
    ms.forEach((m, j) => { sp.set(u.sphere.subarray(3 * m, 3 * m + 3), 3 * j); fp.set(u.flat.subarray(3 * m, 3 * m + 3), 3 * j); });
    setPoints(M, sp, fp, lift);
    M.visible = true;
  };
  pts(sameGroup(i), 0.002, profTrack);
  pts([i], 0.004, profMark);
  place();
}

// the profile under the pointer: nearest on screen, within 10 px, and on
// the globe only those on the side facing the camera
function nearestProfile(px, py) {
  const pos = profPoints.geometry.attributes.position;
  if (!pos) return null;
  const a = pos.array, r = renderer.domElement.getBoundingClientRect();
  const M = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
  const c = camera.position, globe = under.visible;
  let best = -1, bd = 100;
  for (let m = 0; m < a.length / 3; m++) {
    const x = a[3 * m], y = a[3 * m + 1], z = a[3 * m + 2];
    if (globe && x * c.x + y * c.y + z * c.z < x * x + y * y + z * z) continue;
    const w = M[3] * x + M[7] * y + M[11] * z + M[15];
    if (w <= 0) continue;
    const sx = (((M[0] * x + M[4] * y + M[8] * z + M[12]) / w + 1) / 2) * r.width;
    const sy = ((1 - (M[1] * x + M[5] * y + M[9] * z + M[13]) / w) / 2) * r.height;
    const d = (sx - px) ** 2 + (sy - py) ** 2;
    if (d < bd) { bd = d; best = m; }
  }
  return best < 0 ? null : cur.on[best];
}

const timeLabel = (i) => {
  const t = cur.time && cur.time.values[i];
  return Number.isFinite(t) ? C.cfTime(t, cur.time.attrs.units, cur.time.attrs.calendar) || fmtNum(t) : "none";
};
const groupLabel = (i) => {
  const g = cur.group && cur.group.values[i];
  if (!Number.isFinite(g)) return "none";
  const names = cur.group.attrs.source_names;
  return Array.isArray(names) && names[g] !== undefined ? `${names[g]} (${g})` : fmtNum(g);
};
// a value kept per profile: a date where CF units say so, a letter where a
// one-byte code is one (Argo's "A", "D")
const shown = (x, a) => (!Number.isFinite(x) ? "none" : (a && C.cfTime(x, a.attrs.units, a.attrs.calendar)) ||
  (a && a.dtype === "uint8" && x >= 33 && x <= 126 ? `${String.fromCharCode(x)} (${x})` : fmtNum(x)));

let pickSerial = 0;
async function showProfilePick() {
  const tbl = $("pick"), info = $("pick-info"), plot = $("profile-plot"), serial = ++pickSerial;
  tbl.innerHTML = "";
  markProfiles();
  const i = profilePick();
  plot.hidden = true;
  showSectionButton(i);
  if (i === null) { info.textContent = "Click a point for its profile."; $("prof-extra").innerHTML = ""; return; }
  const { p, v } = cur;
  info.textContent = `Profile ${i.toLocaleString("en")} of ${p.n.toLocaleString("en")}: index ${i} along ${p.instance}.`;
  const rows = [["Lon, lat", Number.isFinite(cur.lon[i]) && Math.abs(cur.lat[i]) <= 90 ? `${cur.lon[i].toFixed(4)}${DEG}, ${cur.lat[i].toFixed(4)}${DEG}` : "none: not on the map"]];
  if (cur.time) rows.push([`Time (${p.time})`, timeLabel(i)]);
  if (cur.group) rows.push([`From (${p.group})`, groupLabel(i)]);
  const idx = v.dims.map((d, k) => (d === p.instance ? Math.floor(i / v.meta.chunks[k]) : 0));
  rows.push(["Chunk", `${C.chunkKey(idx, { version: v.meta.version, separator: v.meta.separator })}` + (cur.perProfileChunks > 1 ? ` and ${cur.perProfileChunks - 1} more` : "")]);
  const put = (list) => { for (const [k, val] of list) { const tr = tbl.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = val; } };
  put(rows);
  showExtra(i);
  let r;
  try {
    r = cur.profiles && cur.profiles.get(i);
    if (!r) {
      r = await R.readProfile(cur.s, v, p, i);
      // its z too, where z is per profile (a chunk of the same size, as MEOP's PRES)
      const k = r.z ? 2 : 1;
      cur.reads.chunks += k * cur.perProfileChunks; cur.reads.bytes += k * cur.perProfileChunks * cur.chunkBytes;
      (cur.profiles || (cur.profiles = new Map())).set(i, r);
      showReads();
    }
  } catch (e) { if (serial === pickSerial) put([["Values", `not read: ${e.message}`]]); return; }
  if (serial !== pickSerial || cur.kind !== "profiles") return;
  const z = zFor(i);
  const ok = [];
  for (let k = 0; k < r.values.length; k++) if (Number.isFinite(r.values[k])) ok.push(k);
  const u = v.meta.attrs.units ? ` ${v.meta.attrs.units}` : "", zu = zUnits();
  if (!ok.length) { put([["Values", `none: every level is a fill value${cur.perProfileChunks === 1 ? " (or the store has no chunk for it)" : ""}`]]); return; }
  let lo = Infinity, hi = -Infinity;
  for (const k of ok) { lo = Math.min(lo, r.values[k]); hi = Math.max(hi, r.values[k]); }
  put([["Levels with data", `${ok.length.toLocaleString("en")} of ${r.values.length.toLocaleString("en")}, ${fmtNum(z[ok[0]])} to ${fmtNum(z[ok[ok.length - 1]])}${zu}`],
    [v.path.split("/").pop(), `${fmtNum(lo)} to ${fmtNum(hi)}${u}`]]);
  plot.hidden = false;
  drawProfile(plot, r.values, z, { title: `${v.path.split("/").pop()}${u}`, zTitle: `${p.z || p.level}${zu}`, down: zDown() });
}

// the z of profile i's levels: its own where z is per profile, else the
// collection's (or, with no z, the level's index)
const zFor = (i) => (i !== null && cur.profiles && cur.profiles.get(i) && cur.profiles.get(i).z) || zLevels();
function zLevels() {
  const n = cur.p.nLevels;
  if (cur.zLevels && cur.zLevels.length === n) return cur.zLevels;
  return Float64Array.from({ length: n }, (_, k) => k);
}
const zAttrs = () => (cur.p.z ? cur.p.by[cur.p.z].attrs || {} : {});
const zUnits = () => (zAttrs().units ? ` ${zAttrs().units}` : "");
// pressure and depth grow downwards; an altitude (positive up) does not
const zDown = () => zAttrs().positive !== "up";

// every value kept per profile, read whole the first time it is opened
async function showExtra(i) {
  const tbl = $("prof-extra");
  if (!$("prof-more").open) return;
  const skip = new Set([cur.p.lat, cur.p.lon, cur.p.time, cur.p.group]);
  const list = cur.p.perProfile.filter((a) => !skip.has(a.name));
  await Promise.all(list.map(async (a) => { if (!cur.extra.has(a.name)) cur.extra.set(a.name, R.readPerProfile(cur.s, a).catch(() => null)); return cur.extra.get(a.name); }));
  if (profilePick() !== i) return;
  tbl.innerHTML = "";
  for (const a of list) {
    const r = await cur.extra.get(a.name), tr = tbl.insertRow();
    tr.insertCell().textContent = a.name;
    tr.insertCell().textContent = r ? shown(r.values[i], a) : "not read";
    tr.title = a.attrs.long_name || "";
  }
}
$("prof-more").addEventListener("toggle", () => { const i = profilePick(); if (cur && cur.kind === "profiles" && i !== null) showExtra(i); });

// values (x) against z (y, down for pressure and depth), as a line
function niceTicks(lo, hi, n = 5) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n, p10 = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 5, 10].map((m) => m * p10).find((s) => s >= raw);
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(+t.toPrecision(12));
  return out;
}
function plotFrame(cv) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 300, H = cv.clientHeight || 260;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.font = "11px system-ui, sans-serif";
  return { ctx, W, H, L: 46, R: 10, T: 22, B: 22 };
}
function drawProfile(cv, x, z, { title, zTitle, down }) {
  const { ctx, W, H, L, R: Rm, T, B } = plotFrame(cv);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let k = 0; k < x.length; k++) if (Number.isFinite(x[k]) && Number.isFinite(z[k])) { x0 = Math.min(x0, x[k]); x1 = Math.max(x1, x[k]); z0 = Math.min(z0, z[k]); z1 = Math.max(z1, z[k]); }
  if (!(x1 >= x0)) return;
  if (x1 === x0) { x0 -= 0.5; x1 += 0.5; }
  if (z1 === z0) { z0 -= 0.5; z1 += 0.5; }
  const pad = (x1 - x0) * 0.05; x0 -= pad; x1 += pad;
  const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - Rm);
  const Y = (v) => (down ? T + ((v - z0) / (z1 - z0)) * (H - T - B) : H - B - ((v - z0) / (z1 - z0)) * (H - T - B));
  ctx.strokeStyle = "#1f2a40"; ctx.fillStyle = "#8a97ab"; ctx.lineWidth = 1;
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (const t of niceTicks(x0, x1)) { ctx.beginPath(); ctx.moveTo(X(t), T); ctx.lineTo(X(t), H - B); ctx.stroke(); ctx.fillText(fmtNum(t), X(t), H - B + 4); }
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const t of niceTicks(z0, z1)) { ctx.beginPath(); ctx.moveTo(L, Y(t)); ctx.lineTo(W - Rm, Y(t)); ctx.stroke(); ctx.fillText(fmtNum(t), L - 4, Y(t)); }
  ctx.fillStyle = "#dfe7f2"; ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText(title, L, 4);
  ctx.save(); ctx.translate(10, (T + H - B) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillStyle = "#8a97ab"; ctx.fillText(zTitle, 0, -4); ctx.restore();
  ctx.strokeStyle = "#ffd34d"; ctx.lineWidth = 1.5; ctx.beginPath();
  let pen = false;
  for (let k = 0; k < x.length; k++) {
    if (!Number.isFinite(x[k]) || !Number.isFinite(z[k])) { pen = false; continue; }
    if (pen) ctx.lineTo(X(x[k]), Y(z[k])); else ctx.moveTo(X(x[k]), Y(z[k]));
    pen = true;
  }
  ctx.stroke();
}

// The section along one platform: all its profiles side by side, in time,
// coloured by the value at each level. One read per profile.
let sectionSerial = 0;
function showSectionButton(i) {
  const b = $("section"), list = i === null ? [] : sameGroup(i);
  sectionSerial++;
  $("section-plot").hidden = true; $("section-info").textContent = "";
  b.hidden = list.length < 2;
  if (b.hidden) return;
  const n = Math.min(list.length, SECTION_MAX), c = n * cur.perProfileChunks;
  b.textContent = `Read its ${plural(n, "profile")} as a section (${plural(c, "chunk")}, ${fmtBytes(c * cur.chunkBytes)})`;
}
$("section").addEventListener("click", async () => {
  const i = profilePick();
  if (!cur || cur.kind !== "profiles" || i === null) return;
  const serial = ++sectionSerial, { s, v, p } = cur;
  let list = sameGroup(i);
  if (cur.time) list.sort((a, b) => (cur.time.values[a] || 0) - (cur.time.values[b] || 0));
  list = list.slice(0, SECTION_MAX);
  const info = $("section-info"), cv = $("section-plot"), rows = new Array(list.length);
  let done = 0, next = 0;
  const say = () => { info.textContent = `${done} of ${list.length} profiles read`; };
  say();
  const worker = async () => {
    while (next < list.length && serial === sectionSerial) {
      const j = next++, k = list[j];
      try {
        let r = cur.profiles && cur.profiles.get(k);
        if (!r) { r = await R.readProfile(s, v, { ...p, z: null }, k); cur.reads.chunks += cur.perProfileChunks; cur.reads.bytes += cur.perProfileChunks * cur.chunkBytes; }
        rows[j] = r.values;
      } catch (e) { rows[j] = null; }
      done++;
      if (done % 20 === 0 || done === list.length) { say(); showReads(); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (serial !== sectionSerial) return;
  drawSection(cv, list, rows);
});
function drawSection(cv, list, rows) {
  const vals = [];
  for (const r of rows) if (r) for (let k = 0; k < r.length; k += 7) if (Number.isFinite(r[k])) vals.push(r[k]);
  const info = $("section-info");
  if (!vals.length) { info.textContent = `${list.length} profiles read: no values in any of them`; return; }
  const lo = quantile(vals, 0.02), hi0 = quantile(vals, 0.98), hi = hi0 > lo ? hi0 : lo + 1;
  // the deepest level any profile reaches
  let deep = 0;
  for (const r of rows) if (r) for (let k = r.length - 1; k > deep; k--) if (Number.isFinite(r[k])) { deep = k; break; }
  const nx = list.length, ny = deep + 1, im = new ImageData(nx, ny);
  rows.forEach((r, x) => {
    for (let y = 0; y < ny; y++) {
      const val = r ? r[y] : NaN, o = 4 * (y * nx + x);
      if (!Number.isFinite(val)) continue;
      const rgb = rampAt(VIRIDIS, (val - lo) / (hi - lo));
      im.data[o] = rgb[0]; im.data[o + 1] = rgb[1]; im.data[o + 2] = rgb[2]; im.data[o + 3] = 255;
    }
  });
  const off = document.createElement("canvas");
  off.width = nx; off.height = ny;
  off.getContext("2d").putImageData(im, 0, 0);
  cv.hidden = false;
  const { ctx, W, H, L, R: Rm, T, B } = plotFrame(cv);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, L, T, W - L - Rm, H - T - B);
  const z = zFor(profilePick()), zu = zUnits(), Y = (k) => T + (k / ny) * (H - T - B);
  // ticks at round values of z, placed where the levels reach them
  ctx.fillStyle = "#8a97ab"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  const z0 = Number.isFinite(z[0]) ? z[0] : 0, z1 = Number.isFinite(z[deep]) ? z[deep] : deep;
  for (const t of niceTicks(Math.min(z0, z1), Math.max(z0, z1))) {
    let k = 0;
    while (k < deep && Math.abs(z[k + 1] - t) <= Math.abs(z[k] - t)) k++;
    ctx.fillText(fmtNum(t), L - 4, Y(k + 0.5));
  }
  ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillStyle = "#dfe7f2";
  const u = cur.v.meta.attrs.units ? ` ${cur.v.meta.attrs.units}` : "";
  ctx.fillText(`${cur.v.path.split("/").pop()}: ${lo.toPrecision(3)} to ${hi.toPrecision(3)}${u}`, L, 4);
  ctx.fillStyle = "#8a97ab"; ctx.textBaseline = "top";
  ctx.fillText(timeLabel(list[0]), L, H - B + 4);
  ctx.textAlign = "right"; ctx.fillText(timeLabel(list[list.length - 1]), W - Rm, H - B + 4);
  ctx.save(); ctx.translate(10, (T + H - B) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillText(`${cur.p.z || cur.p.level}${zu}`, 0, -4); ctx.restore();
  info.textContent = `${list.length} profiles of ${groupLabel(list[0])}, in time order, down to ${fmtNum(z[deep] ?? deep)}${zu}: ` +
    `colour is the value at each level, 2% to 98% of them (levels drawn as the picked profile has them).`;
}

function showProfileFacts() {
  const { v, p } = cur, tbl = $("facts");
  const rows = [
    ["Store", cur.s.kind === "icechunk" ? "Icechunk" : cur.s.kind === "zarr3" ? "Zarr v3" : "Zarr v2"],
    ["Array", `${v.meta.shape.map((n, i) => `${v.dims[i]} ${n}`).join(", ")}`],
    ["Type", `${v.meta.dtype}${v.meta.codecs.length ? ", " + v.meta.codecs.join(", ") : ""}`],
    ["Profiles", `${p.n.toLocaleString("en")} along ${p.instance}, placed by ${p.lat} and ${p.lon}` + (cur.placed < p.n ? ` (${(p.n - cur.placed).toLocaleString("en")} with no position)` : "")],
    ["Levels", `${p.nLevels.toLocaleString("en")} along ${p.level}` + (p.z ? `, at ${p.z}` : "")]
  ];
  if (cur.time && cur.timeRange) {
    const a = cur.time.attrs, cal = C.oddCalendar(a.calendar) ? `, ${a.calendar} calendar` : "";
    rows.push(["Time", `${C.cfTime(cur.timeRange[0], a.units, a.calendar) || fmtNum(cur.timeRange[0])} to ${C.cfTime(cur.timeRange[1], a.units, a.calendar) || fmtNum(cur.timeRange[1])} (${p.time}${cal})`]);
  }
  if (cur.group) rows.push(["From", `${cur.groups.toLocaleString("en")} platforms or files (${p.group})`]);
  let la0 = 90, la1 = -90;
  for (const la of cur.lat) if (Math.abs(la) <= 90) { la0 = Math.min(la0, la); la1 = Math.max(la1, la); }
  rows.push(["Latitudes", `${la0.toFixed(2)}${DEG} to ${la1.toFixed(2)}${DEG}`]);
  rows.push(["Chunk", `${v.meta.chunks.join(" x ")}, ${fmtBytes(cur.chunkBytes)} decoded`]);
  rows.push(["One profile reads", `${plural(cur.perProfileChunks, "chunk")} (${fmtBytes(cur.perProfileChunks * cur.chunkBytes)})`]);
  rows.push(["One level everywhere reads", `${plural(cur.levelChunks, "chunk")} (${fmtBytes(cur.levelChunks * cur.chunkBytes)})`]);
  tbl.innerHTML = "";
  for (const [k, val] of rows) { const tr = tbl.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = val; }
  $("projstring").textContent = "no CRS: a longitude and latitude per profile";
  $("projstring").classList.add("none");
  $("describe").textContent = "";
  $("notes").textContent = `A collection of profiles: ${p.lat} and ${p.lon} give one position per ${p.instance}, so each profile is drawn as a point (WGS 84 assumed), not as cells.`;
}

function showProfileLegend() {
  const el = $("legend"), p = cur.p;
  if (state.colour === "time" && cur.time && cur.timeRange) {
    const a = cur.time.attrs;
    el.textContent = `Points coloured by ${p.time}, viridis from ${C.cfTime(cur.timeRange[0], a.units, a.calendar) || fmtNum(cur.timeRange[0])} (dark) to ${C.cfTime(cur.timeRange[1], a.units, a.calendar) || fmtNum(cur.timeRange[1])} (yellow). Click one for its profile.`;
  } else if (state.colour === "group" && cur.group) el.textContent = `Points coloured by ${p.group}: a colour for each of the ${cur.groups} platforms or files. Click one for its profile.`;
  else el.textContent = "Click a point for its profile.";
}

// ---------------------------------------------------------------- opening

function status(t) { $("status").textContent = t || ""; }
const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);
const fmtNum = (v) => { const a = Math.abs(v); return a === 0 ? "0" : a >= 1e6 || a < 1e-3 ? v.toPrecision(6) : String(+v.toPrecision(7)); };
const fmtArea = (km2) => (km2 >= 100 ? `${Math.round(km2).toLocaleString("en")} km2` : km2 >= 0.01 ? `${km2.toPrecision(3)} km2` : `${(km2 * 1e6).toPrecision(3)} m2`);
function showReads() {
  if (!cur) { $("reads").textContent = ""; return; }
  const r = cur.reads;
  $("reads").textContent = r.chunks ? `${r.chunks} chunk${r.chunks > 1 ? "s" : ""} read, ${fmtBytes(r.bytes)} decoded` : "";
}

let openSerial = 0, openedUrl = "", opened = null;
async function open() {
  const serial = ++openSerial;
  status("opening ...");
  try {
    if (!opened || openedUrl !== state.url) {
      if (state.url.startsWith("local:")) throw new Error("a local folder is not in the link: choose it again with Local folder");
      opened = await R.openStore(state.url);
      openedUrl = state.url;
    }
    if (serial !== openSerial) return;
    const s = opened, list = R.dataArrays(s.listArrays ? await s.listArrays() : s.arrays());
    const sel = $("var");
    sel.innerHTML = "";
    for (const a of list) {
      const o = document.createElement("option");
      o.value = a.path; o.textContent = `${a.path} (${(a.dims || a.shape.map((_, i) => "dim_" + i)).map((d, i) => `${d} ${a.shape[i]}`).join(", ")})`;
      sel.appendChild(o);
    }
    if (!state.varname || (list.length && !list.some((a) => a.path === state.varname))) state.varname = list.length ? list[0].path : state.varname;
    if (!state.varname) throw new Error("the store lists no arrays: add ::varname=<array> to the address");
    if (![...sel.options].some((o) => o.value === state.varname)) { const o = document.createElement("option"); o.value = o.textContent = state.varname; sel.appendChild(o); }
    sel.value = state.varname;
    const v = await R.describeVariable(s, state.varname, { assume: state.assume });
    // the choice of satellite, offered only where the store leaves it open
    $("assume-row").hidden = !(v.abiLike || (v.crs && v.crs.assumed));
    $("assume").value = state.assume;
    const prof = v.grid ? null : await R.describeProfiles(s, v);
    if (serial !== openSerial) return;
    if (prof) { $("sample").disabled = true; $("gridlook").hidden = true; await openProfiles(s, v, prof, serial); return; }
    const F = v.grid ? await crsOf(v) : null;
    if (serial !== openSerial) return;
    const g = v.grid || { x0: 0, dx: 1, y0: 0, dy: 1, nx: v.meta.shape[v.ix], ny: v.meta.shape[v.iy] };
    const chunks = v.meta.chunks || v.meta.shape;
    cur = {
      s, v, F: v.grid ? F : null, g, imgs: {}, dist: null, chunkData: new Map(), reads: { chunks: 0, bytes: 0 }, fills: fillValues(v),
      cxs: chunks[v.ix], cys: chunks[v.iy], cx: Math.ceil(g.nx / chunks[v.ix]), cy: Math.ceil(g.ny / chunks[v.iy]),
      cost: C.sliceCost(v.meta.shape, chunks, v.iy, v.ix, C.dtypeBytes(v.meta.dtype))
    };
    cur.earth = !!(cur.F || g.kind === "curvilinear");
    cur.kind = "grid";
    setMode("grid");
    cur.at = makeAt();
    status(v.grid && !F && v.crs ? "proj4js could not read this CRS: drawn in index space" : "");
    buildDims();
    buildLattice();
    buildFlat();
    resetData();
    drawTexture();
    place();
    showFacts();
    showPick();
    showLegend();
    showReads();
    $("sample").disabled = false;
    $("sample").textContent = sampleLabel();
    autoRead();
    writeHash();
  } catch (e) {
    if (serial !== openSerial) return;
    status(e.message || String(e));
  }
}

// a slider per dimension that is not the grid, as gridlook's dimIndices
function buildDims() {
  const box = $("dims"), v = cur.v;
  box.innerHTML = "";
  v.meta.shape.forEach((n, d) => {
    if (d === v.ix || d === v.iy) return;
    const name = v.dims[d];
    const lab = document.createElement("label");
    lab.className = "row";
    lab.innerHTML = `<span></span><output></output>`;
    lab.firstChild.textContent = name;
    const inp = document.createElement("input");
    inp.type = "range"; inp.min = 0; inp.max = n - 1; inp.step = 1;
    // a preset may count from the end (-1: the last, as the newest forecast)
    if (state.dims[name] < 0) state.dims[name] = Math.max(0, n + state.dims[name]);
    inp.value = Math.min(n - 1, state.dims[name] || 0);
    inp.setAttribute("aria-label", name);
    const out = lab.lastChild;
    const label = () => { out.textContent = `${inp.value} of ${n}`; coordLabel(name, +inp.value).then((t) => { if (t && +inp.value === (state.dims[name] || 0)) out.textContent = `${t} (${inp.value})`; }); };
    label();
    // a coordinate out of order (files joined in the wrong order): the slider steps through it as stored
    const warn = document.createElement("p");
    warn.className = "hint";
    warn.hidden = true;
    const c0 = cur;
    coordValues(name).then(async (c) => {
      if (!c || cur !== c0) return;
      // a calendar whose dates are not Gregorian ones (2000-02-30 on 360_day) is named by the slider
      const cal = C.cfTime(0, c.attrs.units, c.attrs.calendar) && C.oddCalendar(c.attrs.calendar) ? String(c.attrs.calendar).trim() : "";
      if (cal) { lab.firstChild.textContent = `${name} (${cal})`; lab.firstChild.title = `dates on the ${cal} calendar, as the store's calendar attribute says`; }
      const o = C.coordOrder(c.values);
      if (o.order !== "unordered") return;
      const [first, lo] = await Promise.all([coordLabel(name, 0), coordLabel(name, o.lo)]);
      warn.textContent = `${name} is not in order in this store: it turns back ${plural(o.against, "time")}. Index 0 is ${first}; ` +
        `the earliest, ${lo}, is at index ${o.lo}. The slider steps through it as stored.`;
      warn.hidden = false;
    });
    let timer = 0;
    inp.addEventListener("input", () => {
      state.dims[name] = +inp.value;
      label();
      clearTimeout(timer);
      timer = setTimeout(() => { resetData(); drawTexture(); autoRead(); showPick(); writeHash(); }, 150);
    });
    box.append(lab, inp, warn);
  });
}

// a dimension's 1D coordinate, read whole once per variable (null if it has none)
function coordValues(dim) {
  const memo = cur.coords || (cur.coords = new Map());
  if (!memo.has(dim)) memo.set(dim, (async () => {
    try {
      const dir = cur.v.path.split("/").slice(0, -1).join("/");
      const a = await cur.s.open(dir ? `${dir}/${dim}` : dim);
      if (a.shape.length !== 1 || a.shape[0] > 1e6) return null;
      const out = await zarr.get(a);
      return { values: Array.from(out.data, Number), attrs: a.attrs };
    } catch (e) { return null; }
  })());
  return memo.get(dim);
}

// the coordinate value at index i of a dimension, as a date where CF units
// say so, on the CF calendar the store names (noleap, 360_day, ...)
async function coordLabel(dim, i) {
  const c = await coordValues(dim);
  if (!c || !(i >= 0 && i < c.values.length)) return null;
  const x = c.values[i];
  return C.cfTime(x, c.attrs.units, c.attrs.calendar) || C.cfDuration(x, c.attrs.units) || (Number.isFinite(x) ? fmtNum(x) : null);
}

// ---------------------------------------------------------------- readouts

function showFacts() {
  if (cur.kind === "profiles") return showProfileFacts();
  const { v, g, F } = cur, tbl = $("facts");
  const units = F ? (F.angular ? DEG : " m") : "";
  const sz = (a) => (Math.abs(g.dx) === Math.abs(g.dy) ? `${fmtNum(Math.abs(g.dx))}${units}` : `${fmtNum(Math.abs(g.dx))} x ${fmtNum(Math.abs(g.dy))}${units}`);
  const rows = [
    ["Store", cur.s.kind === "icechunk" ? "Icechunk" : cur.s.kind === "zarr3" ? "Zarr v3" : "Zarr v2"],
    ["Array", `${v.meta.shape.map((n, i) => `${v.dims[i]} ${n}`).join(", ")}`],
    ["Type", `${v.meta.dtype}${v.meta.codecs.length ? ", " + v.meta.codecs.join(", ") : ""}`],
    ["Grid", g.kind === "curvilinear" ? `${g.nx} x ${g.ny} curvilinear cells` : `${g.nx} x ${g.ny} cells of ${v.grid ? sz() : "?"}${g.kind === "rectilinear" ? " on average (uneven)" : ""}`],
    ["Chunk", `${v.meta.chunks.join(" x ")}${v.meta.inner ? ` (inner ${v.meta.inner.join(" x ")})` : ""}, ${fmtBytes(cur.cost.chunkBytes)} decoded`],
    ["Chunks per slice", `${cur.cx} x ${cur.cy} = ${cur.cost.chunks.toLocaleString("en")}`]
  ];
  // a harvested copy (harvest_store.py) records the source's own chunking
  const hs = v.meta.attrs.harvest_source_shape, hc = v.meta.attrs.harvest_source_chunks;
  if (Array.isArray(hs) && Array.isArray(hc) && hs.length === v.meta.shape.length && hc.length === hs.length) {
    const el = cur.cost.chunkBytes / v.meta.chunks.reduce((a, b) => a * b, 1);
    const one = hc.reduce((a, b) => a * b, 1) * el;
    const n = hs.reduce((a, len, i) => a * (v.meta.shape[i] > 1 ? Math.ceil(len / hc[i]) : 1), 1);
    rows.push(["Source array", hs.map((len, i) => `${v.dims[i]} ${len}`).join(", ")],
      ["Source chunk", `${hc.join(" x ")}, ${fmtBytes(one)} decoded; one slice reads ${n.toLocaleString("en")} of them (${fmtBytes(n * one)})`]);
  }
  if (cur.earth) {
    // the order the rows and columns are stored in, on the earth
    const od = cur.dirs || {};
    rows.push(["Rows", od.rows === "north" ? "south first: row 0 is the southern edge (chunk labels are turned to read upright)" :
      od.rows === "south" ? "north first: row 0 is the northern edge, as in an image" : "neither north nor south first (they cross a pole)"]);
    if (od.cols === "west") rows.push(["Columns", "east first: column 0 is the eastern edge (chunk labels are mirrored to read)"]);
    const e = C.gridExtent(g);
    if (F) rows.push(["Extent", `${fmtNum(e[0])} to ${fmtNum(e[2])}, ${fmtNum(e[1])} to ${fmtNum(e[3])}`]);
    rows.push(["Latitudes", `${cur.lat.lo.toFixed(2)}${DEG} to ${cur.lat.hi.toFixed(2)}${DEG}`]);
    const d = distortionField();
    const fin = Array.from(d.area).filter(Number.isFinite);
    if (fin.length) {
      const lo = Math.min(...fin), hi = Math.max(...fin);
      rows.push(["Cell area", `${fmtArea(lo)} to ${fmtArea(hi)}` + (lo > 0 ? ` (x${(hi / lo).toPrecision(3)})` : "")]);
    }
    const om = Array.from(d.omega).filter(Number.isFinite);
    if (om.length) rows.push([F ? "Angular distortion" : "Cell shape", `up to ${Math.max(...om).toPrecision(3)}${DEG}` + (F ? "" : " from square")]);
  }
  tbl.innerHTML = "";
  for (const [k, val] of rows) {
    const tr = tbl.insertRow();
    tr.insertCell().textContent = k; tr.insertCell().textContent = val;
  }
  $("projstring").textContent = F ? (F.def.length > 300 ? F.def.slice(0, 300) + " ..." : F.def) : g.kind === "curvilinear" ? "no CRS: lon/lat per cell" : "no CRS";
  $("projstring").classList.toggle("none", !F);
  $("describe").textContent = F ? `${F.label}, from ${v.crsFrom || "the store"}.` + (v.grid && v.grid.geo ? ` Cells placed by ${v.grid.geo}.` : "") : "";
  $("notes").textContent = v.notes.join(". ") + (v.notes.length ? "." : "");
}

function showLegend() {
  const el = $("legend");
  if (!cur) { el.textContent = ""; return; }
  if (cur.kind === "profiles") return showProfileLegend();
  let t = "";
  if (state.colour === "data") {
    const u = cur.v.meta.attrs.units ? ` ${cur.v.meta.attrs.units}` : "";
    t = cur.scale ? `viridis from ${fmtNum(cur.scale.lo)} to ${fmtNum(cur.scale.hi)}${u} (2% and 98% of ${cur.scale.from > 1 ? `the ${cur.scale.from} chunks first read` : "the first chunk read"})` :
      // read, and nothing in them: a store with no chunk there (a field that starts later) reads as its fill value
      cur.painted && cur.painted.size ? `No values in the ${plural(cur.painted.size, "chunk")} read: every cell is the fill value, as where the store holds no chunk at all` :
      smallSlice() ? "" : notReadHint();
  } else if (state.colour === "area" && cur.dist) {
    const sc = distortionImage("area").scale;
    t = `cell area on the earth as a share of the largest cell (${fmtArea(sc.max)}): dark is small, yellow is the largest`;
  } else if (state.colour === "omega" && cur.dist) {
    const sc = distortionImage("omega").scale;
    t = cur.F ? `angular distortion of the store's CRS, 0 to ${sc.hi.toPrecision(3)}${DEG}: none means the CRS keeps shapes (conformal) there` :
      `how far each cell is from square on the ground, 0 to ${sc.hi.toPrecision(3)}${DEG} (the grid has no CRS, so this is the cells' own shape)`;
  }
  if (cur.drawNote) t = (t ? t.replace(/\.$/, "") + ". " : "") + cur.drawNote[0].toUpperCase() + cur.drawNote.slice(1) + ".";
  el.textContent = t;
}

function pickCell() {
  if (!state.pick || !cur) return null;
  const p = state.pick.split(",").map(Number);
  if (p.length !== 2 || !p.every(Number.isInteger) || p[0] < 0 || p[1] < 0 || p[0] >= cur.g.nx || p[1] >= cur.g.ny) return null;
  return p;
}

async function showPick() {
  if (cur && cur.kind === "profiles") return showProfilePick();
  const tbl = $("pick"), info = $("pick-info");
  tbl.innerHTML = "";
  const p = cur && pickCell();
  if (!p) { info.textContent = cur ? "Click the grid for the cell and chunk under the pointer." : ""; return; }
  const [col, row] = p, { v, g, F } = cur;
  const ci = Math.floor(col / cur.cxs), cj = Math.floor(row / cur.cys);
  const idx = chunkIdx(cj, ci);
  info.textContent = `Cell ${col}, ${row}: index ${col} along ${v.dims[v.ix]}, ${row} along ${v.dims[v.iy]}.`;
  const rows = [["Chunk", `${C.chunkKey(idx, { version: v.meta.version, separator: v.meta.separator })}`]];
  const [x, y] = nativeXY(col + 0.5, row + 0.5);
  if (v.grid && g.kind !== "curvilinear") rows.push(["x, y", `${fmtNum(x)}, ${fmtNum(y)}`]);
  if (cur.earth) {
    const c = cellFacts(col, row);
    if (c) {
      rows.push(["Lon, lat", `${c.ll[0].toFixed(4)}${DEG}, ${c.ll[1].toFixed(4)}${DEG}`]);
      rows.push(["Cell area", `${fmtArea(c.area)}` + (cur.dist && cur.dist.med ? ` (x${(c.area / cur.dist.med).toPrecision(3)} the median)` : "")]);
      if (c.f) rows.push(["Scale h, k", `${c.f.h.toPrecision(5)}, ${c.f.k.toPrecision(5)}`], ["Angular distortion", `${c.f.omega.toPrecision(3)}${DEG}`]);
      else if (c.shape) rows.push(["Cell sides", `${c.shape.a.toPrecision(4)} by ${c.shape.b.toPrecision(4)} km`], ["Cell shape", `${c.shape.omega.toPrecision(3)}${DEG} from square`]);
    } else rows.push(["Lon, lat", "not on the earth"]);
  }
  const key = idx.join(",");
  let val = "";
  if (cur.chunkData.has(key) || cur.cost.chunkBytes <= PICK_BYTES) {
    try {
      const c = await loadChunk(cj, ci);
      if (!cur.painted.has(`${cj},${ci}`)) { paintChunk(c, cj, ci); cur.painted.add(`${cj},${ci}`); drawTexture(); showReads(); showLegend(); }
      const x0 = chunkValue(c, cj, ci, col, row);
      val = Number.isFinite(x0) && !cur.fills.has(x0) ? `${fmtNum(x0)}${v.meta.attrs.units ? " " + v.meta.attrs.units : ""}` : "no data";
    } catch (e) { val = `not read: ${e.message}`; }
  } else val = `chunk of ${fmtBytes(cur.cost.chunkBytes)} not read`;
  rows.push(["Value", val]);
  if (pickCell() !== null && pickCell().join() !== p.join()) return;
  tbl.innerHTML = "";
  for (const [k, val2] of rows) { const tr = tbl.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = val2; }
}

// the same view in gridlook, where it has the projection
function updateGridlook() {
  const a = $("gridlook");
  if (!cur || cur.kind === "profiles" || /^(https?:)?\/\/(localhost|127\.)/.test(state.url) || state.url.startsWith("local:") || location.protocol === "file:") { a.hidden = true; return; }
  const path = state.varname, k = path.lastIndexOf("/");
  let url = R.absoluteUrl(state.url).replace(/\/+$/, "");
  if (k > 0) url += "/" + path.slice(0, k);
  if (cur.s.kind === "icechunk" && !/\.icechunk$/.test(state.url)) url = "icechunk+" + url;
  const gl = ["nearside_perspective", "equirectangular", "mercator", "robinson", "mollweide", "cylindrical_equal_area", "azimuthal_equidistant"];
  const p = { varname: k > 0 ? path.slice(k + 1) : path, projection: gl.includes(state.projection) && state.t > 0.5 ? state.projection : "" };
  if (state.lat !== null) p.lat = state.lat;
  if (state.lon !== null) p.lon = state.lon;
  for (const [d, i] of Object.entries(state.dims)) if (i) p[`dimIndices_${d}`] = i;
  a.href = "https://gridlook.pages.dev/#" + C.hashString(url, p);
  a.hidden = false;
}

// ---------------------------------------------------------------- controls

const ui = { t: $("t"), proj: $("proj"), colour: $("colour"), clon: $("clon"), clat: $("clat") };
for (const d of C.DISPLAY) { const o = document.createElement("option"); o.value = d.key; o.textContent = d.label; ui.proj.appendChild(o); }
for (const p of PRESETS) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "small"; b.textContent = p.label;
  b.addEventListener("click", () => {
    Object.assign(state, defaults, { dims: { ...(p.dims || {}) }, url: p.url, varname: p.varname, projection: p.projection, lat: p.lat ?? null, lon: p.lon ?? null });
    syncControls(); setCamera(DEFAULT_CAM); open();
  });
  $("presets").appendChild(b);
}

function syncControls() {
  $("src").value = state.url;
  ui.t.value = state.t;
  ui.proj.value = state.projection;
  ui.colour.value = state.colour;
  for (const k of ["chunks", "cells", "coast", "grat"]) $(k).checked = !!state[k];
  ui.clon.value = state.lon ?? ""; ui.clat.value = state.lat ?? "";
  const globe = state.projection === "nearside_perspective";
  ui.t.disabled = $("play").disabled = globe;
  $("t-out").textContent = globe ? "globe" : state.t === 0 ? "globe" : state.t === 1 ? ui.proj.selectedOptions[0].textContent : "unfolding";
  ui.clat.disabled = !(C.DISPLAY.find((d) => d.key === state.projection) || {}).centred && !globe;
}

$("load").addEventListener("click", () => {
  const u = $("src").value.trim();
  if (!u) return;
  if (u !== state.url) { state.url = u; state.varname = ""; state.dims = {}; state.pick = ""; }
  open();
});
$("folder-btn").addEventListener("click", () => $("folder").click());
$("folder").addEventListener("change", () => {
  const files = $("folder").files;
  if (!files || !files.length) return;
  opened = R.openFiles(files);
  openedUrl = state.url = opened.url;
  state.varname = ""; state.dims = {}; state.pick = "";
  $("src").value = state.url;
  open();
});
$("src").addEventListener("keydown", (e) => { if (e.key === "Enter") $("load").click(); });
$("var").addEventListener("change", () => { state.varname = $("var").value; state.dims = {}; state.pick = ""; open(); });
$("sample").addEventListener("click", () => {
  if (!cur || cur.kind === "profiles") return;
  if (smallSlice()) autoRead(); else readChunks(sampleList());
});
ui.proj.addEventListener("change", () => {
  state.projection = ui.proj.value;
  if (state.projection !== "nearside_perspective" && state.t === 0) startAnim(1);
  syncControls();
  if (cur) { buildFlat(); place(); }
  writeHash();
});
ui.t.addEventListener("input", () => { state.t = +ui.t.value; syncControls(); place(); writeHash(); });
const centre = () => {
  const lon = ui.clon.value === "" ? null : Math.max(-180, Math.min(180, +ui.clon.value));
  const lat = ui.clat.value === "" ? null : Math.max(-90, Math.min(90, +ui.clat.value));
  state.lon = lon; state.lat = lat;
  if (cur) { buildFlat(); place(); }
  writeHash();
};
ui.clon.addEventListener("change", centre);
ui.clat.addEventListener("change", centre);
$("centre-grid").addEventListener("click", () => {
  state.lon = state.lat = null; syncControls();
  if (cur) { buildFlat(); place(); }
  writeHash();
});
$("assume").addEventListener("change", (e) => { state.assume = e.target.value; writeHash(); open(); });
ui.colour.addEventListener("change", () => { state.colour = ui.colour.value; if (cur) { drawTexture(); showLegend(); } writeHash(); });
for (const k of ["chunks", "cells", "coast", "grat"])
  $(k).addEventListener("change", () => { state[k] = $(k).checked ? 1 : 0; if (cur) { drawTexture(); place(); showLegend(); } writeHash(); });
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(DEFAULT_CAM); writeHash(); });
$("copy-proj").addEventListener("click", (e) => copyText(cur && cur.F ? cur.F.def : "", e.target));

// a click (not a drag) on the grid picks the cell under the pointer
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!cur || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  if (cur.kind === "profiles") {
    const i = nearestProfile(e.clientX - r.left, e.clientY - r.top);
    if (i === null) return;
    state.pick = String(i);
    showPick(); writeHash();
    return;
  }
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObject(gridMesh)[0];
  if (!hit) return;
  const col = Math.min(cur.g.nx - 1, Math.floor(hit.uv.x * cur.g.nx)), row = Math.min(cur.g.ny - 1, Math.floor((1 - hit.uv.y) * cur.g.ny));
  state.pick = `${col},${row}`;
  drawTexture(); showPick(); writeHash();
});

let anim = false, dir = 1, lastT = 0;
const playBtn = $("play");
function stopAnim() { anim = false; playBtn.textContent = state.t >= 1 ? "Fold" : "Unfold"; }
function startAnim(to) { anim = true; dir = to > state.t ? 1 : -1; playBtn.textContent = "Stop"; lastT = performance.now(); }
playBtn.addEventListener("click", () => { if (anim) return stopAnim(); startAnim(state.t >= 1 ? 0 : 1); });

shareLinks("playproj: Icechunk and Zarr");

function tick(now) {
  if (anim) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    state.t = Math.max(0, Math.min(1, state.t + dir * dt * 0.35));
    if (state.t === 1 || state.t === 0) stopAnim();
    place(); syncControls(); writeHash();
  }
  lastT = now;
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

window.addEventListener("hashchange", () => {
  const before = state.url + "|" + state.varname;
  readHash(); syncControls(); setCamera(state.cam || DEFAULT_CAM);
  if (state.url + "|" + state.varname !== before || !cur) open();
  else if (cur && cur.kind === "profiles") { buildFlat(); place(); showPick(); showLegend(); }
  else if (cur) { buildFlat(); resetData(); drawTexture(); place(); autoRead(); showPick(); showLegend(); }
});

readHash();
syncControls();
setCamera(state.cam || DEFAULT_CAM);
resize();
if (isEmbed()) controls.enableZoom = true;
loadCoastline("110m").then((l) => { coast = l; if (cur) { buildLines(); place(); } }, () => {});
open();
requestAnimationFrame(tick);
