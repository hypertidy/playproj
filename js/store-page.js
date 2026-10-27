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
import { graticule } from "../src/core/geo.js";
import { loadCoastline } from "./data.js";
import { makeStage, shareLinks, copyText, isEmbed } from "../src/scene/index.js";

const proj4 = window.proj4;
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
  { label: "CMIP6 GFDL-ESM4 tos (tripolar)", url: "https://storage.googleapis.com/cmip6/CMIP6/CMIP/NOAA-GFDL/GFDL-ESM4/historical/r2i1p1f1/Omon/tos/gn/v20180701", varname: "tos", projection: "native" }
];

// ---------------------------------------------------------------- state

// gridlook's keys (url, varname, projection, lat, lon, dimIndices_<dim>) and
// this page's own, which gridlook ignores
const defaults = { url: PRESETS[0].url, varname: "", projection: "mollweide", lat: null, lon: null,
  t: 0, colour: "data", chunks: 1, cells: 1, coast: 1, grat: 1, pick: "", cam: null };
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
  if (["data", "area", "omega", "none"].includes(c)) state.colour = c;
  state.pick = params.get("pick") || "";
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
    if (state.pick) p.pick = state.pick;
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
  Object.assign(cur, { MU, MV, ll, mid: mid || [0, 0] });
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
  if (!cur || !cur.mesh) return;
  const e = cur.earth && cur.D ? ease(state.t) : cur.earth ? 0 : 1;
  const pos = gridMesh.geometry.attributes.position;
  morph(pos.array, cur.mesh.sphere, cur.mesh.flat, e);
  pos.needsUpdate = true;
  gridMesh.geometry.computeBoundingSphere();
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
    // labels where there is room
    if (!faint && tx >= 60 && ty >= 24 && cur.cx * cur.cy > 1 && cur.cx * cur.cy <= 2000) {
      ctx.fillStyle = "rgba(255,230,160,0.9)";
      ctx.font = `${Math.min(ty * 0.3, tx * 0.14, 34 * lw)}px ui-monospace, monospace`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (let r = 0; r < cur.cy; r++)
        for (let c = 0; c < cur.cx; c++) ctx.fillText(`${r}, ${c}`, Math.min(W, (c + 0.5) * tx), Math.min(H, (r + 0.5) * ty));
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
  for (const k of ["_FillValue", "missing_value"]) {
    const a = v.meta.attrs[k];
    if (typeof a === "number") out.push(a);
    if (Array.isArray(a)) out.push(...a.filter((x) => typeof x === "number"));
  }
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
  const [W, H] = [Math.min(cur.g.nx, TEX), Math.min(cur.g.ny, TEX)];
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  cur.dataCanvas = cv;
  cur.scale = null;
  cur.painted = new Set();
}

// read the whole slice when it is small, else a spread of chunks
function autoRead() {
  const { cx, cy } = cur;
  const cost = cur.cost;
  if (cost.chunks <= AUTO_CHUNKS && cost.bytes <= AUTO_BYTES) {
    const list = [];
    for (let r = 0; r < cy; r++) for (let c = 0; c < cx; c++) list.push([r, c]);
    readChunks(list);
  }
}
function sampleList() {
  const { cx, cy } = cur, n = Math.max(1, Math.round(Math.sqrt((SAMPLE * cx) / cy))), m = Math.max(1, Math.round(SAMPLE / n));
  const list = [];
  for (let r = 0; r < Math.min(m, cy); r++) for (let c = 0; c < Math.min(n, cx); c++)
    list.push([Math.floor(((r + 0.5) / Math.min(m, cy)) * cy), Math.floor(((c + 0.5) / Math.min(n, cx)) * cx)]);
  return list;
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
    const v = await R.describeVariable(s, state.varname);
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
    $("sample").textContent = cur.cost.chunks <= AUTO_CHUNKS && cur.cost.bytes <= AUTO_BYTES ? `Read the slice (${cur.cost.chunks} chunk${cur.cost.chunks > 1 ? "s" : ""})` : `Read ${Math.min(SAMPLE, cur.cost.chunks)} chunks across the grid`;
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
    inp.value = Math.min(n - 1, state.dims[name] || 0);
    inp.setAttribute("aria-label", name);
    const out = lab.lastChild;
    const label = () => { out.textContent = `${inp.value} of ${n}`; coordLabel(name, +inp.value).then((t) => { if (t && +inp.value === (state.dims[name] || 0)) out.textContent = `${t} (${inp.value})`; }); };
    label();
    let timer = 0;
    inp.addEventListener("input", () => {
      state.dims[name] = +inp.value;
      label();
      clearTimeout(timer);
      timer = setTimeout(() => { resetData(); drawTexture(); autoRead(); showPick(); writeHash(); }, 150);
    });
    box.append(lab, inp);
  });
}

// the coordinate value at index i of a dimension, as a date where CF units say so
async function coordLabel(dim, i) {
  try {
    const dir = cur.v.path.split("/").slice(0, -1).join("/");
    const p = dir ? `${dir}/${dim}` : dim;
    const a = await cur.s.open(p);
    if (a.shape.length !== 1) return null;
    const out = await zarr.get(a, [zarr.slice(i, i + 1)]);
    let x = out.data[0];
    if (typeof x === "bigint") x = Number(x);
    const m = /^\s*(seconds?|minutes?|hours?|days?)\s+since\s+(\d{4}-\d{1,2}-\d{1,2})(?:[ T](\d{1,2}:\d{2}(?::\d{2})?))?/.exec(a.attrs.units || "");
    if (m && Number.isFinite(x)) {
      const unit = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[1][0]];
      const [Y, M, D] = m[2].split("-").map(Number);
      const t0 = Date.UTC(Y, M - 1, D) + (m[3] ? (() => { const [hh, mm, ss = 0] = m[3].split(":").map(Number); return ((hh * 60 + mm) * 60 + ss) * 1e3; })() : 0);
      const s = new Date(t0 + x * unit).toISOString();
      return s.endsWith("T00:00:00.000Z") ? s.slice(0, 10) : s.slice(0, 16).replace("T", " ");
    }
    return Number.isFinite(x) ? fmtNum(x) : null;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- readouts

function showFacts() {
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
  let t = "";
  if (state.colour === "data") {
    const u = cur.v.meta.attrs.units ? ` ${cur.v.meta.attrs.units}` : "";
    t = cur.scale ? `viridis from ${fmtNum(cur.scale.lo)} to ${fmtNum(cur.scale.hi)}${u} (2% and 98% of ${cur.scale.from > 1 ? `the ${cur.scale.from} chunks first read` : "the first chunk read"})` :
      cur.cost.chunks <= AUTO_CHUNKS ? "" : "Read chunks to see the data, or click the grid to read the chunk there.";
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
  if (!cur || /^(https?:)?\/\/(localhost|127\.)/.test(state.url) || state.url.startsWith("local:") || location.protocol === "file:") { a.hidden = true; return; }
  const path = state.varname, k = path.lastIndexOf("/");
  let url = state.url.replace(/\/+$/, "");
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
    Object.assign(state, defaults, { dims: {}, url: p.url, varname: p.varname, projection: p.projection });
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
  if (!cur) return;
  if (cur.cost.chunks <= AUTO_CHUNKS && cur.cost.bytes <= AUTO_BYTES) autoRead(); else readChunks(sampleList());
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
