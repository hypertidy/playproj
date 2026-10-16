// playproj: tiles and overviews.
//
// A raster's structure (structure.js) is drawn level by level: each level is
// a canvas in the source's own CRS, where the pixel grid and the tiles are
// straight, textured on a mesh whose vertices move from the globe (t = 0) to
// the flat native CRS (t = 1), as on the model grids page. Only headers and
// metadata are read.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as S from "./structure.js";
import { loadCoastline, graticule } from "./geo.js";

const DEG = "\u00b0";
const D2R = Math.PI / 180;
const GEBCO = "https://data.source.coop/ausantarctic/gebco/GEBCO_2026.tif";
const BIG_TEX = 4096, SMALL_TEX = 1024;
const MAX_STACK = 24;

const COLORS = {
  bg: 0x05070d,
  frame: "rgba(17,27,46,0.96)",
  image: "#1c3557",
  ghost: "rgba(140,196,255,0.05)",
  coast: "#d7ecff",
  grat: "rgba(140,196,255,0.3)",
  pixel: "rgba(255,255,255,0.22)",
  tile: "rgba(255,211,77,0.85)",
  tileFaint: "rgba(255,211,77,0.45)",
  edge: "#6ab787",
  pad: "rgba(255,93,93,0.18)",
  pick: "#ff7ab8",
  label: "rgba(255,230,160,0.9)"
};

const PRESETS = [
  { label: "GEBCO 2026 COG", src: GEBCO, kind: "tiff" },
  { label: "OpenStreetMap tiles", src: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", kind: "xyz" },
  { label: "Esri World Imagery", src: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer", kind: "arcgis" },
  { label: "GIBS Antarctic WMTS", src: "https://gibs.earthdata.nasa.gov/wmts/epsg3031/best/1.0.0/WMTSCapabilities.xml", kind: "wmts" },
  { label: "Sentinel-2 tile (spec)", spec: { crs: "EPSG:32755", ext: "499980,609780,5190220,5300020", dim: "10980,10980", tile: 1024, lev: 0 } },
  { label: "Antarctic 1 km (spec)", spec: { crs: "EPSG:3031", ext: "-3333000,3333000,-3333000,3333000", dim: "6666,6666", tile: 512, lev: 0 } }
];
const KINDS = ["", "tiff", "zarr", "wmts", "arcgis", "xyz", "tmsjson"];

// ---------------------------------------------------------------- state

const defaults = {
  src: GEBCO, kind: "", var: "", layer: "", tms: "", zmax: 18,
  spec: 0, crs: "", ext: "", dim: "", tile: 512, lev: 0,
  lvl: -1, t: 0, ex: 0, tiles: 1, pix: 1, coast: 1, grat: 1, pick: "", cam: null
};
const STRINGS = new Set(["src", "kind", "var", "layer", "tms", "crs", "ext", "dim", "pick"]);
const SPEC_KEYS = new Set(["crs", "ext", "dim", "tile", "lev"]);
const state = { ...defaults };
const embed = new URLSearchParams(location.search).has("embed");

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  Object.assign(state, defaults);
  for (const k of Object.keys(defaults)) {
    if (!h.has(k)) continue;
    const raw = h.get(k);
    if (STRINGS.has(k)) state[k] = raw;
    else if (k === "cam") {
      const c = raw.split(",").map(Number);
      if (c.length === 6 && c.every(isFinite)) state.cam = c;
    } else if (isFinite(+raw)) state[k] = +raw;
  }
  if (!KINDS.includes(state.kind)) state.kind = "";
  const cl = (k, a, b) => { state[k] = Math.max(a, Math.min(b, state[k])); };
  cl("t", 0, 1); cl("ex", 0, 1); cl("zmax", 0, 24); cl("tile", 1, 1e6); cl("lev", 0, 40);
  state.zmax = Math.round(state.zmax);
  if (state.spec) state.src = h.get("src") || "";
}

let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const h = new URLSearchParams();
    for (const k of Object.keys(defaults)) {
      if (SPEC_KEYS.has(k) && !state.spec) continue;
      if (k === "src" && state.spec) continue;
      if (k === "cam") { if (state.cam) h.set("cam", state.cam.map((x) => +x.toFixed(2)).join(",")); continue; }
      const val = typeof state[k] === "number" ? +state[k].toFixed(3) : state[k];
      if (val !== defaults[k] || (k === "src" && !state.spec && val !== GEBCO)) h.set(k, String(val));
    }
    const s = h.toString();
    history.replaceState(null, "", s ? "#" + s : location.pathname + location.search);
  }, 200);
}

// ---------------------------------------------------------------- reading

let localFile = null;
const jsonCache = new Map();
const reads = { docs: 0, bytes: 0 };

function netError(err, url) {
  if (err && err.name === "TypeError") {
    let host = url;
    try { host = new URL(url, location.href).host; } catch (e) { /* keep url */ }
    return new Error(`could not reach ${host}: offline, or the server does not allow reads from other sites`);
  }
  return err;
}

async function getText(url) {
  let r;
  try { r = await fetch(url); } catch (e) { throw netError(e, url); }
  if (!r.ok) throw new Error(`${r.status} from ${url}`);
  const t = await r.text();
  reads.docs++; reads.bytes += t.length;
  return t;
}

// JSON inside a Zarr store: null where there is nothing (404)
function storeJson(base) {
  return async (path) => {
    const url = base + "/" + path;
    if (jsonCache.has(url)) return jsonCache.get(url);
    let r;
    try { r = await fetch(url); } catch (e) { throw netError(e, url); }
    reads.docs++;
    const v = r.ok ? await r.json().catch(() => null) : null;
    if (v) reads.bytes += JSON.stringify(v).length;
    jsonCache.set(url, v);
    return v;
  };
}

async function sniff(url) {
  let r;
  try { r = await fetch(url, { headers: { Range: "bytes=0-3" } }); } catch (e) { throw netError(e, url); }
  const b = new Uint8Array(await r.arrayBuffer()).slice(0, 4);
  const s = String.fromCharCode(...b);
  if (s.startsWith("II*") || s.startsWith("MM\0*") || s === "II+\0" || s === "MM\0+") return "tiff";
  if (s.trim().startsWith("<")) return "wmts";
  return "tmsjson";
}

// Read one source into a structure. Returns { s, src }.
async function readSource() {
  reads.docs = 0; reads.bytes = 0;
  if (state.spec) {
    const num = (v) => v.split(/[\s,]+/).filter(Boolean).map(Number);
    const ext = num(state.ext), dim = num(state.dim);
    if (ext.length !== 4 || !ext.every(isFinite)) throw new Error("the extent needs four numbers: xmin, xmax, ymin, ymax");
    if (dim.length !== 2 || !dim.every(isFinite)) throw new Error("the dimension needs two numbers: columns, rows");
    return { s: S.specStructure({ crs: state.crs, extent: ext, dim: dim.map(Math.round), tile: state.tile, levels: state.lev }) };
  }
  if (localFile) {
    const src = S.blobSource(localFile);
    return { s: await S.tiffStructure(src), src };
  }
  const url = state.src.trim();
  if (!url) throw new Error("give a URL, open a local GeoTIFF, or draw a grid spec");
  const kind = state.kind || S.guessKind(url) || (await sniff(url));
  if (kind === "tiff") {
    const src = S.rangeSource(url);
    try { return { s: await S.tiffStructure(src), src }; } catch (e) { throw netError(e, url); }
  }
  if (kind === "xyz") return { s: { ...S.webMercatorQuad(state.zmax), kind: "xyz", template: url } };
  if (kind === "zarr") {
    const base = url.replace(/\/(zarr\.json|\.zmetadata|\.zattrs|\.zgroup|\.zarray)$/, "").replace(/\/+$/, "");
    return { s: { ...(await S.zarrStructure(storeJson(base), { variable: state.var })), base } };
  }
  if (kind === "wmts") return { s: S.wmtsStructure(await getText(url), { layer: state.layer, tms: state.tms }) };
  const jurl = kind === "arcgis" && !/[?&]f=/.test(url) ? url + (url.includes("?") ? "&" : "?") + "f=json" : url;
  const j = JSON.parse(await getText(jurl));
  if (j.tileInfo || j.pixelSizeX || (j.fullExtent && j.spatialReference)) return { s: S.arcgisStructure(j, url) };
  if (j.tileMatrices || j.tileMatrix) return { s: S.tmsJsonStructure(j) };
  if (j.zarr_format || j.node_type) {
    const base = url.replace(/\/zarr\.json$/, "");
    return { s: { ...(await S.zarrStructure(storeJson(base), { variable: state.var })), base } };
  }
  throw new Error("this JSON is not an ArcGIS service, a tile matrix set or Zarr metadata");
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

// forward (lon, lat) -> (x, y) and back, or null where the CRS has no answer
async function resolveProj(crs) {
  if (!crs) return { label: "no CRS: pixel coordinates", def: null };
  const label = crs.epsg ? `EPSG:${crs.epsg}` : crs.proj4 ? "PROJ string" : crs.wkt ? "WKT" : "unknown CRS";
  let def = crs.proj4 || null;
  if (!def && crs.epsg) def = S.knownProj4(crs.epsg) || (proj4.defs("EPSG:" + crs.epsg) ? "EPSG:" + crs.epsg : null) || (await lookupEpsg(crs.epsg));
  if (!def && crs.wkt) def = crs.wkt;
  if (!def) return { label, def: null };
  let P;
  try { P = proj4(def); } catch (e) { return { label, def: null }; }
  const ok = (a) => a && isFinite(a[0]) && isFinite(a[1]);
  const fwd = (lon, lat) => { try { const a = P.forward([lon, lat]); return ok(a) ? a : null; } catch (e) { return null; } };
  const inv = (x, y) => { try { const a = P.inverse([x, y]); return ok(a) && Math.abs(a[1]) <= 90.000001 ? a : null; } catch (e) { return null; } };
  const geographic = !!(P.oProj && P.oProj.projName === "longlat");
  return { label, def: typeof def === "string" && def.startsWith("EPSG:") ? S.knownProj4(crs.epsg) || def : def, fwd, inv, geographic };
}

// ---------------------------------------------------------------- scene

const stage = document.getElementById("three");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(COLORS.bg);
stage.appendChild(renderer.domElement);
const maxTex = Math.min(BIG_TEX, renderer.capabilities.maxTextureSize || BIG_TEX);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const DEFAULT_CAM = [1.2, 1.1, 6.2, 0, 0, 0.4];
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

const group = new THREE.Group();
scene.add(group);
const under = new THREE.Mesh(new THREE.SphereGeometry(0.99, 96, 48), new THREE.MeshBasicMaterial({ color: 0x0b1222, transparent: true }));
group.add(under);
const globeCoast = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x5b7aa3, transparent: true, opacity: 0.6 }));
group.add(globeCoast);

// The frame puts the middle of the extent towards the camera, north up.
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

let cur = null;         // the loaded structure and everything drawn from it
let coast110 = null, coast50 = null;
const gratLines = graticule(10, 1);

// the part of the extent to draw: geographic grids stop at the poles
function drawExtent(s, P) {
  const e = s.extent.slice();
  if (P && P.geographic) { e[1] = Math.max(-90, e[1]); e[3] = Math.min(90, e[3]); }
  return e;
}

function buildMesh() {
  const { P, E } = cur;
  const w = E[2] - E[0], h = E[3] - E[1];
  const MU = Math.max(8, Math.round(160 * Math.min(1, w / h))), MV = Math.max(8, Math.round(160 * Math.min(1, h / w)));
  // the middle of the extent, or the first place in it that is on the earth
  let mid = P.inv ? P.inv(E[0] + w / 2, E[1] + h / 2) : null;
  const n = (MU + 1) * (MV + 1);
  const ll = new Array(n);
  for (let j = 0, m = 0; j <= MV; j++)
    for (let i = 0; i <= MU; i++, m++) {
      const x = E[0] + (i / MU) * w, y = E[1] + (j / MV) * h;
      let q = P.inv ? P.inv(x, y) : null;
      // outside the CRS's domain the inverse can answer anyway: insist on the way back
      if (q) { const b = P.fwd(q[0], q[1]); if (!b || Math.hypot(b[0] - x, b[1] - y) > 1e-6 * Math.max(w, h)) q = null; }
      ll[m] = q;
      if (!mid && q) mid = q;
    }
  cur.mid = mid || [0, 0];
  const frame = frameAt(cur.mid[0], cur.mid[1]);
  cur.frame = frame;
  const sphere = new Float32Array(n * 3), flat = new Float32Array(n * 3), uv = new Float32Array(n * 2), valid = new Uint8Array(n);
  const k = Math.min(3.6 / w, 2.5 / h);
  cur.flatScale = k;
  for (let j = 0, m = 0; j <= MV; j++)
    for (let i = 0; i <= MU; i++, m++) {
      const x = E[0] + (i / MU) * w, y = E[1] + (j / MV) * h;
      flat[3 * m] = (x - E[0] - w / 2) * k; flat[3 * m + 1] = (y - E[1] - h / 2) * k; flat[3 * m + 2] = 1;
      uv[2 * m] = i / MU; uv[2 * m + 1] = j / MV;
      if (ll[m]) { sphere.set(frame(ll[m][0], ll[m][1]), 3 * m); valid[m] = 1; }
      else sphere.set([flat[3 * m], flat[3 * m + 1], flat[3 * m + 2]], 3 * m);
    }
  // triangles on the earth, and none that jump across a seam
  const index = [];
  const far = (a, b) => Math.hypot(sphere[3 * a] - sphere[3 * b], sphere[3 * a + 1] - sphere[3 * b + 1], sphere[3 * a + 2] - sphere[3 * b + 2]) > 0.5;
  const tri = (a, b, c) => {
    if (P.inv && (!valid[a] || !valid[b] || !valid[c] || far(a, b) || far(b, c) || far(a, c))) return;
    index.push(a, b, c);
  };
  for (let j = 0; j < MV; j++)
    for (let i = 0; i < MU; i++) {
      const a = j * (MU + 1) + i, b = a + MU + 1;
      tri(a, a + 1, b); tri(a + 1, b + 1, b);
    }
  cur.mesh = { sphere, flat, uv: new THREE.BufferAttribute(uv, 2), index, n };

  // the coastline on the globe, for where the grid is
  const pos = [];
  for (const line of coast110 || []) {
    for (let i = 2; i < line.length; i += 2) {
      if (Math.abs(line[i] - line[i - 2]) > 180) continue;
      pos.push(...frame(line[i - 2], line[i - 1], 1.002), ...frame(line[i], line[i + 1], 1.002));
    }
  }
  globeCoast.geometry.dispose();
  globeCoast.geometry = new THREE.BufferGeometry();
  globeCoast.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
}

// coastline and graticule in the native CRS, split where the CRS breaks them
function projectLines(lines) {
  const { P } = cur, out = [];
  if (!P.fwd) return out;
  for (const l of lines) {
    let part = [];
    for (let i = 0; i < l.length; i += 2) {
      const q = P.fwd(l[i], l[i + 1]);
      if (!q || (i && Math.abs(l[i] - l[i - 2]) > 180)) { if (part.length > 2) out.push(part); part = []; }
      if (q) part.push(q[0], q[1]);
    }
    if (part.length > 2) out.push(part);
  }
  return out;
}

// ---------------------------------------------------------------- level drawings

function texSize(big) {
  const [x0, y0, x1, y1] = cur.E, a = (x1 - x0) / (y1 - y0), T = big ? maxTex : SMALL_TEX;
  return a >= 1 ? [T, Math.max(32, Math.round(T / a))] : [Math.max(32, Math.round(T * a)), T];
}

function levelRec(k) {
  if (!cur.recs[k]) {
    const canvas = document.createElement("canvas");
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(cur.mesh.sphere.slice(), 3));
    g.setAttribute("uv", cur.mesh.uv);
    g.setIndex(cur.mesh.index);
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent: true }));
    mesh.userData.k = k;
    group.add(mesh);
    cur.recs[k] = { canvas, texture, mesh, big: null, drawn: "" };
  }
  return cur.recs[k];
}

function tileLabel(L, col, row) {
  const s = cur.s;
  if (s.kind === "xyz" || s.kind === "arcgis") return `${L.z}/${col}/${row}`;
  if (s.kind === "wmts" || s.kind === "tms") return `${L.id ?? L.z}/${row}/${col}`;
  return `${col},${row}`;
}

function drawLevel(k, rec, selected, pick) {
  const L = cur.levels[k], E = cur.E;
  const [W, H] = texSize(selected);
  if (rec.canvas.width !== W || rec.canvas.height !== H) { rec.canvas.width = W; rec.canvas.height = H; rec.texture.dispose(); }
  const ctx = rec.canvas.getContext("2d");
  const sx = W / (E[2] - E[0]), sy = H / (E[3] - E[1]);
  const X = (x) => (x - E[0]) * sx, Y = (y) => (E[3] - y) * sy;
  const fade = selected ? 1 : 0.55;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = selected ? COLORS.frame : COLORS.ghost;
  ctx.fillRect(0, 0, W, H);

  // the level's pixels, and the padding of its edge tiles beyond them
  const ie = S.levelExtent(L);
  const tileExt = S.levelExtent({ x0: L.x0, y0: L.y0, dx: L.dx, dy: L.dy, width: L.tilesX * L.tileW, height: L.tilesY * L.tileH });
  if (selected) {
    ctx.fillStyle = COLORS.pad;
    ctx.fillRect(X(tileExt[0]), Y(tileExt[3]), (tileExt[2] - tileExt[0]) * sx, (tileExt[3] - tileExt[1]) * sy);
    ctx.fillStyle = COLORS.image;
    ctx.fillRect(X(ie[0]), Y(ie[3]), (ie[2] - ie[0]) * sx, (ie[3] - ie[1]) * sy);
  }
  const lw = Math.max(1, W / 2048);
  const stroke = (lines, style, width) => {
    ctx.strokeStyle = style; ctx.lineWidth = width;
    ctx.beginPath();
    for (const l of lines) { ctx.moveTo(X(l[0]), Y(l[1])); for (let i = 2; i < l.length; i += 2) ctx.lineTo(X(l[i]), Y(l[i + 1])); }
    ctx.stroke();
  };
  ctx.globalAlpha = fade;
  if (state.grat && cur.grat) stroke(cur.grat, COLORS.grat, lw);
  if (state.coast && cur.coast) stroke(cur.coast, COLORS.coast, 1.6 * lw);

  // a line at each multiple of step from the origin, within the canvas
  const gridLines = (x0, d, n, alongX, style, width) => {
    ctx.strokeStyle = style; ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const v = x0 + i * d;
      if (alongX) { const x = X(v); if (x < -1 || x > W + 1) continue; ctx.moveTo(x, Math.max(0, Y(tileExt[3]))); ctx.lineTo(x, Math.min(H, Y(tileExt[1]))); }
      else { const y = Y(v); if (y < -1 || y > H + 1) continue; ctx.moveTo(Math.max(0, X(tileExt[0])), y); ctx.lineTo(Math.min(W, X(tileExt[2])), y); }
    }
    ctx.stroke();
  };
  const pxW = Math.abs(L.dx) * sx, pxH = Math.abs(L.dy) * sy;
  rec.note = "";
  if (state.pix && pxW >= 4 && pxH >= 4) {
    gridLines(L.x0, L.dx, L.width, true, COLORS.pixel, lw * 0.8);
    gridLines(L.y0, L.dy, L.height, false, COLORS.pixel, lw * 0.8);
  } else if (state.pix && selected) rec.note = "pixels";
  const tW = pxW * L.tileW, tH = pxH * L.tileH;
  // chunks inside a Zarr shard
  if (state.tiles && selected && L.inner && pxW * L.inner[0] >= 4 && pxH * L.inner[1] >= 4) {
    ctx.setLineDash([6 * lw, 4 * lw]);
    gridLines(L.x0, L.dx * L.inner[0], Math.ceil(L.width / L.inner[0]), true, COLORS.tileFaint, lw);
    gridLines(L.y0, L.dy * L.inner[1], Math.ceil(L.height / L.inner[1]), false, COLORS.tileFaint, lw);
    ctx.setLineDash([]);
  }
  if (state.tiles && tW >= 3 && tH >= 3) {
    const style = selected ? COLORS.tile : COLORS.tileFaint;
    gridLines(L.x0, L.dx * L.tileW, L.tilesX, true, style, (selected ? 2 : 1.5) * lw);
    gridLines(L.y0, L.dy * L.tileH, L.tilesY, false, style, (selected ? 2 : 1.5) * lw);
    if (selected && tW >= 70 && tH >= 26 && L.tilesX * L.tilesY <= 4000) {
      ctx.fillStyle = COLORS.label;
      ctx.font = `${Math.min(tH * 0.28, tW * 0.16, 40 * lw)}px ui-monospace, monospace`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (let r = 0; r < L.tilesY; r++)
        for (let c = 0; c < L.tilesX; c++) {
          const cx = X(L.x0 + (c + 0.5) * L.tileW * L.dx), cy = Y(L.y0 + (r + 0.5) * L.tileH * L.dy);
          if (cx > -tW && cx < W + tW && cy > -tH && cy < H + tH) ctx.fillText(tileLabel(L, c + L.col0, r + L.row0), cx, cy);
        }
    }
  } else if (state.tiles && selected) rec.note = rec.note ? "tiles or pixels" : "tiles";
  // the edge of the pixels
  ctx.strokeStyle = COLORS.edge; ctx.lineWidth = 3 * lw;
  ctx.strokeRect(X(ie[0]), Y(ie[3]), (ie[2] - ie[0]) * sx, (ie[3] - ie[1]) * sy);
  ctx.globalAlpha = 1;

  if (selected && pick && pick.p.inTiles) {
    const p = pick.p;
    const tx = L.x0 + (p.tileCol - L.col0) * L.tileW * L.dx, ty = L.y0 + (p.tileRow - L.row0) * L.tileH * L.dy;
    const r = (x, y, ddx, ddy) => {
      const a = X(Math.min(x, x + ddx)), b = Y(Math.max(y, y + ddy));
      return [a, b, Math.abs(ddx) * sx, Math.abs(ddy) * sy];
    };
    ctx.strokeStyle = COLORS.pick; ctx.lineWidth = 4 * lw;
    ctx.fillStyle = "rgba(255,122,184,0.22)";
    const t = r(tx, ty, L.tileW * L.dx, L.tileH * L.dy);
    ctx.fillRect(...t); ctx.strokeRect(...t);
    const q = r(L.x0 + p.col * L.dx, L.y0 + p.row * L.dy, L.dx, L.dy);
    const m = 5 * lw;
    ctx.fillStyle = COLORS.pick;
    ctx.fillRect(q[0] + q[2] / 2 - Math.max(q[2], m) / 2, q[1] + q[3] / 2 - Math.max(q[3], m) / 2, Math.max(q[2], m), Math.max(q[3], m));
  }
  rec.texture.needsUpdate = true;
}

// ---------------------------------------------------------------- placing

const ease = (x) => x * x * (3 - 2 * x);
const selected = () => (cur ? Math.max(0, Math.min(cur.levels.length - 1, state.lvl < 0 ? cur.autoLevel : state.lvl)) : 0);
// levels drawn: the selected one, or the whole stack
function visibleLevels() {
  const sel = selected(), n = cur.levels.length;
  if (state.ex <= 0) return [sel];
  const out = [];
  for (let k = 0; k < Math.min(n, MAX_STACK); k++) out.push(k);
  if (!out.includes(sel)) out.push(sel);
  return out;
}

function placeMeshes() {
  if (!cur || !cur.mesh) return;
  const e = ease(cur.P.inv ? state.t : 1), vis = new Set(visibleLevels()), sel = selected();
  const gap = 0.32 * state.ex, shell = 0.05 * state.ex;
  const { sphere, flat } = cur.mesh;
  cur.recs.forEach((rec, k) => {
    if (!rec) return;
    rec.mesh.visible = vis.has(k);
    if (!rec.mesh.visible) return;
    const pos = rec.mesh.geometry.attributes.position.array, rs = 1 + k * shell, dz = k * gap;
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] = sphere[i] * rs + (flat[i] - sphere[i] * rs) * e;
      pos[i + 1] = sphere[i + 1] * rs + (flat[i + 1] - sphere[i + 1] * rs) * e;
      pos[i + 2] = sphere[i + 2] * rs + (flat[i + 2] + dz - sphere[i + 2] * rs) * e;
    }
    rec.mesh.geometry.attributes.position.needsUpdate = true;
    rec.mesh.geometry.computeBoundingSphere();
    rec.mesh.renderOrder = k === sel ? 0 : 1 + k;
    rec.mesh.material.depthWrite = k === sel;
  });
  const fadeGlobe = Math.max(0, 1 - 3 * e);
  under.visible = globeCoast.visible = fadeGlobe > 0;
  under.material.opacity = fadeGlobe;
  globeCoast.material.opacity = 0.6 * fadeGlobe;
}

// ---------------------------------------------------------------- picking

function currentPick() {
  if (!state.pick || !cur) return null;
  const xy = state.pick.split(",").map(Number);
  if (xy.length !== 2 || !xy.every(isFinite)) return null;
  const L = cur.levels[selected()];
  return { x: xy[0], y: xy[1], L, p: S.locate(L, xy[0], xy[1]) };
}

function fill(template, L, col, row) {
  const z = L.z ?? L.id;
  return template.replace(/\{z\}/gi, z).replace(/\{x\}/gi, col).replace(/\{-y\}/gi, (L.tilesY - 1 - row)).replace(/\{y\}/gi, row)
    .replace(/\{TileMatrix\}/g, L.id ?? z).replace(/\{TileRow\}/g, row).replace(/\{TileCol\}/g, col)
    .replace(/\{TileMatrixSet\}/g, cur.s.tms || "").replace(/\{Style\}/g, "default").replace(/\{Time\}/g, "default");
}

// the chunk a Zarr pixel is in, with any other dimensions at their first chunk
function chunkKey(L, p) {
  const nd = 2 + (L.extra ? L.extra.length : 0), idx = new Array(nd).fill(0);
  idx[nd - 2] = p.tileRow; idx[nd - 1] = p.tileCol;
  const v3 = /v3/.test(cur.s.info.format);
  return (L.path ? L.path + "/" : "") + (v3 ? "c/" + idx.join("/") : idx.join("."));
}

const fmtBytes = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`;
const fmtNum = (v) => { const a = Math.abs(v); return a === 0 ? "0" : a >= 1e5 || a < 1e-3 ? v.toPrecision(7) : +v.toPrecision(8) + ""; };
const fmtCell = (L) => { const a = Math.abs(L.dx), b = Math.abs(L.dy); const u = cur.P.geographic ? DEG : cur.P.fwd ? " m" : ""; return a === b || Math.abs(a - b) < 1e-9 * a ? `${fmtNum(a)}${u}` : `${fmtNum(a)} x ${fmtNum(b)}${u}`; };

let pickSerial = 0;
async function updatePick(pick) {
  const info = $("pick-info"), tbl = $("pick-levels"), inset = $("inset");
  if (!pick) { info.textContent = cur ? "Click the grid for the pixel and tile under the pointer." : ""; tbl.innerHTML = ""; inset.hidden = true; $("inset-cap").textContent = ""; return; }
  const { L, p, x, y } = pick, s = cur.s;
  const ll = cur.P.inv ? cur.P.inv(x, y) : null;
  let text = `x ${fmtNum(x)}, y ${fmtNum(y)}` + (ll ? ` (${ll[0].toFixed(4)}${DEG}, ${ll[1].toFixed(4)}${DEG})` : "") + `. ${L.name}: `;
  if (!p.inTiles) text += "outside the grid.";
  else {
    text += p.inside ? `pixel column ${p.col}, row ${p.row}` : "past the last pixel, in a padded tile";
    text += `; ${L.tiled === false ? "strip" : s.kind === "zarr" ? "chunk" : "tile"} ${p.tileCol}, ${p.tileRow}`;
    if (s.kind === "tiff") text += ` (number ${p.tileIndex} of ${L.tilesX * L.tilesY}, counting rows from the top left)`;
    if (p.inside) text += `, pixel ${p.inTile[0]}, ${p.inTile[1]} in it`;
    text += ".";
    if (s.kind === "zarr") {
      text += ` Chunk key ${chunkKey(L, p)}`;
      if (L.inner) text += `, inner chunk ${Math.floor(p.inTile[0] / L.inner[0])}, ${Math.floor(p.inTile[1] / L.inner[1])} of the shard`;
      text += ".";
    }
    if (s.template) text += ` ${fill(s.template, L, p.tileCol, p.tileRow)}`;
  }
  info.textContent = text;
  // the same place at every level
  const rows = cur.levels.map((M, k) => {
    const q = S.locate(M, x, y);
    return `<tr class="${k === selected() ? "active" : ""}" data-k="${k}"><td>${M.name}</td><td>${q.inside ? `${q.col}, ${q.row}` : "-"}</td><td>${q.inTiles ? `${q.tileCol}, ${q.tileRow}` : "-"}</td></tr>`;
  });
  tbl.innerHTML = `<tr><td>Level</td><td>Pixel</td><td>${s.kind === "zarr" ? "Chunk" : "Tile"}</td></tr>` + rows.join("");
  drawInset(pick);
  if (s.kind === "tiff" && p.inTiles && cur.src) {
    const serial = ++pickSerial;
    try {
      const b = await S.tileBytes(cur.src, s, L, p.tileIndex);
      if (serial !== pickSerial || !b) return;
      info.textContent = text + (b.length ? ` Its bytes are ${b.offset.toLocaleString("en")} to ${(b.offset + b.length - 1).toLocaleString("en")} of the file (${fmtBytes(b.length)}).`
        : " It is sparse: no bytes are stored, and it reads as nodata.");
      showReads();
    } catch (e) { /* the offsets could not be read; the rest stands */ }
  }
}

// Two close looks at the pick: the tiles round it, and the pixels round it.
function drawInset(pick) {
  const c = $("inset"), cap = $("inset-cap"), { L, p } = pick;
  if (!p.inTiles) { c.hidden = true; cap.textContent = ""; return; }
  c.hidden = false;
  const ctx = c.getContext("2d"), H = c.height, half = c.width / 2;
  ctx.fillStyle = "#0b1222"; ctx.fillRect(0, 0, c.width, H);
  const tw = Math.max(L.tileW, L.tileH);
  const nTile = Math.min(Math.max(L.width, L.height) + 2, Math.ceil(tw * 1.6));
  // centre the tile view on the picked tile, the pixel view on the pixel
  const tc = (p.tileCol - L.col0 + 0.5) * L.tileW, tr = (p.tileRow - L.row0 + 0.5) * L.tileH;
  panel(ctx, L, p, 0, half - 4, H, tc - nTile / 2, tr - nTile / 2, nTile);
  panel(ctx, L, p, half + 4, half - 4, H, p.col + 0.5 - 12, p.row + 0.5 - 12, 24);
  cap.textContent = `Left: ${Math.round(nTile)} pixels across, round the ${cur.s.kind === "zarr" ? "chunk" : "tile"}. Right: 24 pixels across, round the pixel. A pixel is ${fmtCell(L)}; yellow lines are ${cur.s.kind === "zarr" ? "chunk" : "tile"} edges, red is padding past the last pixel.`;
}

function panel(ctx, L, p, ox, size, H, c0, r0, n) {
  const cell = size / n;
  ctx.save();
  ctx.beginPath(); ctx.rect(ox, 0, size, H); ctx.clip();
  ctx.translate(ox, (H - size) / 2);
  const X = (col) => (col - c0) * cell, Y = (row) => (row - r0) * cell;
  const fullT = [L.tilesX * L.tileW, L.tilesY * L.tileH];
  // tiles checkered, padding red, beyond the grid dark
  const tc0 = Math.max(0, Math.floor(c0 / L.tileW)), tc1 = Math.min(L.tilesX - 1, Math.floor((c0 + n) / L.tileW));
  const tr0 = Math.max(0, Math.floor(r0 / L.tileH)), tr1 = Math.min(L.tilesY - 1, Math.floor((r0 + n) / L.tileH));
  for (let tr = tr0; tr <= tr1; tr++)
    for (let tc = tc0; tc <= tc1; tc++) {
      ctx.fillStyle = (tc + tr) % 2 ? "#1c3557" : "#22406a";
      ctx.fillRect(X(tc * L.tileW), Y(tr * L.tileH), L.tileW * cell, L.tileH * cell);
    }
  ctx.fillStyle = "rgba(255,93,93,0.35)";
  ctx.fillRect(X(L.width), Y(0), (fullT[0] - L.width) * cell, fullT[1] * cell);
  ctx.fillRect(X(0), Y(L.height), L.width * cell, (fullT[1] - L.height) * cell);
  if (cell >= 3) {
    ctx.strokeStyle = COLORS.pixel; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let q = Math.max(0, Math.ceil(c0)); q <= Math.min(fullT[0], c0 + n); q++) { ctx.moveTo(X(q), Y(Math.max(0, r0))); ctx.lineTo(X(q), Y(Math.min(fullT[1], r0 + n))); }
    for (let r = Math.max(0, Math.ceil(r0)); r <= Math.min(fullT[1], r0 + n); r++) { ctx.moveTo(X(Math.max(0, c0)), Y(r)); ctx.lineTo(X(Math.min(fullT[0], c0 + n)), Y(r)); }
    ctx.stroke();
  }
  ctx.strokeStyle = COLORS.tile; ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (let tc = tc0; tc <= tc1 + 1; tc++) { ctx.moveTo(X(tc * L.tileW), Y(tr0 * L.tileH)); ctx.lineTo(X(tc * L.tileW), Y((tr1 + 1) * L.tileH)); }
  for (let tr = tr0; tr <= tr1 + 1; tr++) { ctx.moveTo(X(tc0 * L.tileW), Y(tr * L.tileH)); ctx.lineTo(X((tc1 + 1) * L.tileW), Y(tr * L.tileH)); }
  ctx.stroke();
  if (state.coast && cur.coast) {
    // coastline from the CRS into pixel columns and rows
    const cx = (x) => X((x - L.x0) / L.dx), cy = (y) => Y((y - L.y0) / L.dy);
    ctx.strokeStyle = COLORS.coast; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const l of cur.coast) { ctx.moveTo(cx(l[0]), cy(l[1])); for (let i = 2; i < l.length; i += 2) ctx.lineTo(cx(l[i]), cy(l[i + 1])); }
    ctx.stroke();
  }
  const m = Math.max(cell, 5);
  ctx.strokeStyle = COLORS.pick; ctx.lineWidth = 3;
  ctx.strokeRect(X(p.col + 0.5) - m / 2, Y(p.row + 0.5) - m / 2, m, m);
  ctx.restore();
}

// ---------------------------------------------------------------- panel

const $ = (id) => document.getElementById(id);
const ui = {
  src: $("src"), kind: $("kind"), var: $("var"), layer: $("layer"), tms: $("tms"), zmax: $("zmax"),
  t: $("t"), lvl: $("lvl"), ex: $("ex"), tiles: $("tiles"), pix: $("pix"), coast: $("coast"), grat: $("grat"),
  crs: $("s-crs"), ext: $("s-ext"), dim: $("s-dim"), tile: $("s-tile"), lev: $("s-lev")
};

for (const pr of PRESETS) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = pr.label; b.className = "small";
  b.addEventListener("click", () => {
    localFile = null;
    Object.assign(state, { lvl: -1, pick: "", var: "", layer: "", tms: "" });
    if (pr.spec) Object.assign(state, { spec: 1, src: "", ...pr.spec });
    else Object.assign(state, { spec: 0, src: pr.src, kind: pr.kind });
    sync();
  });
  b.dataset.key = pr.spec ? "spec:" + pr.spec.crs + pr.spec.dim : pr.src;
  $("presets").appendChild(b);
}

const fmtExt = (L) => { const e = S.levelExtent(L); return [e[0], e[2], e[1], e[3]].map(fmtNum).join(", "); };

function describe() {
  const s = cur.s, L0 = cur.levels[0], n = cur.levels.length, i = s.info || {};
  const tile = `${L0.tileW} x ${L0.tileH}`;
  if (s.kind === "tiff") {
    const kind = i.cog ? "Cloud-optimized GeoTIFF" : L0.tiled ? "Tiled GeoTIFF" : "Striped GeoTIFF";
    return `${kind} (${i.format}, ${i.byteOrder}): ${i.bands} band${i.bands > 1 ? "s" : ""} of ${i.dtype}, ${i.compression}` +
      `${i.predictor > 1 ? " with predictor " + i.predictor : ""}, ${L0.tiled ? tile + " tiles" : "strips of " + L0.tileH + " rows"}, ` +
      `${n} level${n > 1 ? "s" : ""}${i.masks ? ` and ${i.masks} mask${i.masks > 1 ? "s" : ""}` : ""}.` +
      (i.nodata !== undefined ? ` Nodata ${i.nodata}.` : "") + (i.rotated ? " The file has a rotation term, drawn here without it." : "");
  }
  if (s.kind === "zarr")
    return `${i.format}${i.consolidated ? ", consolidated" : ""}: ${i.variable} (${i.dims.join(", ")}) of ${i.dtype}, ${i.codec}, chunks of ${tile}` +
      (L0.inner ? ` in shards, inner chunks of ${L0.inner.join(" x ")}` : "") +
      (L0.extra && L0.extra.length ? `; also ${L0.extra.map((e) => `${e.dim} ${e.size} in chunks of ${e.chunk}`).join(", ")}` : "") +
      `; ${n} level${n > 1 ? "s" : ""}. Placed by ${i.georef}.`;
  if (s.kind === "xyz") return `An XYZ template: Web Mercator tiles of 256 x 256, zoom 0 to ${state.zmax}, each zoom four times the tiles of the one before.`;
  if (s.kind === "wmts") return `WMTS ${i.title ? `layer "${i.title}"` : ""} in tile matrix set ${s.tms}: ${n} matrices, ${tile} tiles.`;
  if (s.kind === "arcgis") return `${i.scheme}${i.title ? `, ${i.title}` : ""}: ${n} level${n > 1 ? "s" : ""} of ${tile} tiles from the origin ${i.origin ? i.origin.map(fmtNum).join(", ") : ""}; the full extent is a window on each.`;
  if (s.kind === "tms") return `Tile matrix set ${s.tms}: ${n} matrices of ${tile} tiles.${i.note ? " " + i.note + "." : ""}`;
  return `A typed grid: ${L0.width} x ${L0.height} pixels of ${fmtCell(L0)}, ${tile} tiles and ${n} level${n > 1 ? "s" : ""}, each half the one before, rounding up as GDAL does.`;
}

function levelTable() {
  const s = cur.s, sel = selected();
  const bytes = new Map((cur.layout || []).filter((g) => g.level).map((g) => [g.level, g.end - g.start]));
  const head = `<tr><td>Level</td><td>Pixels</td><td>Pixel size</td><td>${s.kind === "zarr" ? "Chunks" : L0Tiled() ? "Tiles" : "Strips"}</td>${bytes.size ? "<td>Bytes</td>" : ""}</tr>`;
  const rows = cur.levels.map((L, k) => `<tr class="${k === sel ? "active" : ""}" data-k="${k}"><td>${L.name}</td><td>${L.width.toLocaleString("en")} x ${L.height.toLocaleString("en")}</td>` +
    `<td>${fmtCell(L)}</td><td>${L.tilesX.toLocaleString("en")} x ${L.tilesY.toLocaleString("en")}</td>${bytes.size ? `<td>${bytes.has(L) ? fmtBytes(bytes.get(L)) : "-"}</td>` : ""}</tr>`);
  $("levels").innerHTML = head + rows.join("");
}
const L0Tiled = () => cur.levels[0].tiled !== false;

function layoutBar() {
  const box = $("layout-box");
  if (!cur.layout) { box.hidden = true; return; }
  box.hidden = false;
  const segs = cur.layout.slice().sort((a, b) => a.start - b.start);
  const size = Math.max(cur.src.size || 0, ...segs.map((g) => g.end));
  const bar = $("layout");
  bar.innerHTML = "";
  let at = 0;
  const add = (w, cls, title, k) => {
    const d = document.createElement("div");
    d.className = cls; d.style.flexGrow = String(Math.max(w, size * 0.004)); d.title = title;
    if (k !== undefined) { d.dataset.k = k; if (k === selected()) d.classList.add("active"); }
    bar.appendChild(d);
  };
  for (const g of segs) {
    if (g.start > at) add(g.start - at, "gap", `${fmtBytes(g.start - at)} between`);
    const k = g.level ? cur.levels.indexOf(g.level) : undefined;
    add(g.end - g.start, g.level ? "lvl" : "head", `${g.label}: bytes ${g.start.toLocaleString("en")} to ${g.end.toLocaleString("en")} (${fmtBytes(g.end - g.start)})`, k);
    at = Math.max(at, g.end);
  }
  const order = segs.filter((g) => g.level).map((g) => g.label);
  const head = segs.find((g) => !g.level);
  $("layout-note").textContent = `${fmtBytes(head.end)} of header and IFDs, then ${order.join(", then ")}` +
    (cur.s.info.cog ? ": smallest first, so a reader gets an overview from the start of the file." : ".") + ` ${fmtBytes(size)} in all.`;
}

function showReads() {
  const r = $("reads");
  if (!cur) { r.textContent = ""; return; }
  if (cur.src) r.textContent = `Read ${cur.src.requests} range request${cur.src.requests === 1 ? "" : "s"}, ${fmtBytes(cur.src.bytes)}${cur.src.size ? ` of a ${fmtBytes(cur.src.size)} file` : ""}.`;
  else if (reads.docs) r.textContent = `Read ${reads.docs} metadata document${reads.docs === 1 ? "" : "s"}, ${fmtBytes(reads.bytes)}.`;
  else r.textContent = cur.s.kind === "xyz" ? "Nothing to read: the template is the whole structure." : "";
}

function fillSpec(force) {
  if (!cur || (state.spec && !force)) return;
  const L = cur.levels[0], c = cur.s.crs;
  state.crs = c ? (c.epsg ? `EPSG:${c.epsg}` : c.proj4 || "") : "";
  state.ext = fmtExt(L); state.dim = `${L.width}, ${L.height}`; state.tile = L.tileW; state.lev = cur.levels.length;
}

function updatePanel() {
  ui.src.value = localFile ? localFile.name : state.spec ? "" : state.src;
  ui.kind.value = state.kind; ui.var.value = state.var;
  ui.zmax.value = state.zmax; $("zmax-out").textContent = String(state.zmax);
  for (const k of ["crs", "ext", "dim"]) if (document.activeElement !== ui[k]) ui[k].value = state[k];
  ui.tile.value = state.tile; ui.lev.value = state.lev || "";
  ui.t.value = state.t; ui.ex.value = state.ex;
  ui.tiles.checked = !!state.tiles; ui.pix.checked = !!state.pix; ui.coast.checked = !!state.coast; ui.grat.checked = !!state.grat;
  for (const b of $("presets").children) b.classList.toggle("active", state.spec ? b.dataset.key === "spec:" + state.crs + state.dim : b.dataset.key === state.src && !localFile);
  const k = cur && cur.s.kind;
  $("zarr-ctl").hidden = k !== "zarr" && state.kind !== "zarr";
  $("xyz-ctl").hidden = k !== "xyz";
  $("wmts-ctl").hidden = k !== "wmts";
  $("ex-out").textContent = state.ex ? `${Math.round(state.ex * 100)}%` : "off";
  if (!cur) return;
  if (k === "wmts") {
    const opts = (sel, list, val) => { sel.innerHTML = list.map((x) => `<option value="${x.id ?? x}">${x.title ? x.title + " (" + x.id + ")" : x.id ?? x}</option>`).join(""); sel.value = val; };
    opts(ui.layer, cur.s.layers, cur.s.layer || ""); opts(ui.tms, cur.s.sets, cur.s.tms || "");
  }
  const sel = selected(), L = cur.levels[sel];
  ui.lvl.max = cur.levels.length - 1; ui.lvl.value = sel;
  $("lvl-out").textContent = `${L.name} (${sel + 1} of ${cur.levels.length})`;
  const flatOnly = !cur.P.inv;
  ui.t.disabled = flatOnly; $("play").disabled = flatOnly;
  $("t-out").textContent = flatOnly ? "native only" : state.t === 0 ? "globe" : state.t === 1 ? cur.P.label : "unfolding";
  const proj = $("projstring");
  proj.textContent = cur.P.def ? (cur.P.label.startsWith("EPSG") ? `${cur.P.label}  ${cur.P.def}` : cur.P.def) : cur.P.label;
  proj.classList.toggle("none", !cur.P.def);
  const rec = cur.recs[sel];
  $("describe").textContent = describe() + (rec && rec.note ? ` At this level the ${rec.note} are too small to draw over the whole extent: click for a close look.` : "") +
    (flatOnly && cur.s.crs ? " The CRS could not be read, so the grid is drawn flat: type a PROJ string in the grid spec to place it on the globe." : "");
  const gh = cur.s.info && cur.s.info.ghost;
  $("ghost").textContent = gh ? "GDAL's notes after the header: " + gh.split("\n").join(", ") : "";
  levelTable();
  layoutBar();
  showReads();
}

// ---------------------------------------------------------------- sync

let loadKey = "", loading = null, rafPending = false;
const sourceKey = () => state.spec ? ["spec", state.crs, state.ext, state.dim, state.tile, state.lev].join("|")
  : [localFile ? "file:" + localFile.name + localFile.size : state.src, state.kind, state.var, state.layer, state.tms, state.zmax].join("|");

function setStatus(t) { $("status").textContent = t; }

async function load() {
  const key = sourceKey();
  loadKey = key;
  setStatus("Reading the header...");
  try {
    const { s, src } = await readSource();
    if (key !== loadKey) return;
    const P = await resolveProj(s.crs);
    if (key !== loadKey) return;
    if (cur) for (const r of cur.recs) if (r) { group.remove(r.mesh); r.mesh.geometry.dispose(); r.mesh.material.dispose(); r.texture.dispose(); }
    const E = drawExtent(s, P);
    cur = { s, src, P, E, levels: s.levels, recs: [], layout: null };
    // a level whose tiles can be seen: the finest for files, a coarse zoom for tile services
    cur.autoLevel = ["xyz", "wmts", "arcgis", "tms"].includes(s.kind)
      ? Math.max(0, s.levels.findIndex((L) => L.tilesX <= 16 && L.tilesY <= 16)) : 0;
    const small = Math.max(E[2] - E[0], E[3] - E[1]) * (P.geographic ? 1 : 1 / 111000) < 25;
    if (small && !coast50) coast50 = await loadCoastline("50m").catch(() => null);
    buildMesh();
    cur.coast = projectLines((small && coast50) || coast110 || []);
    cur.grat = projectLines(gratLines);
    fillSpec();
    setStatus(P.def || !s.crs ? "" : `${P.label} is not one this page knows, and it could not be looked up.`);
    if (src && s.kind === "tiff") S.tiffLayout(src, s).then((g) => { if (cur && cur.s === s) { cur.layout = g; updatePanel(); } }).catch(() => {});
    if (s.kind === "wmts") { state.layer = s.layer || ""; state.tms = s.tms || ""; loadKey = sourceKey(); }
    if (!state.cam) setCamera(DEFAULT_CAM);
    document.body.classList.add("ready");
  } catch (e) {
    if (key !== loadKey) return;
    setStatus(e.message || String(e));
  }
  sync();
}

function sync() {
  writeHash();
  if (sourceKey() !== loadKey) { loading = load(); updatePanel(); return; }
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (!cur) { updatePanel(); return; }
    const sel = selected(), pick = currentPick();
    const key = [state.tiles, state.pix, state.coast, state.grat].join();
    for (const k of visibleLevels()) {
      const rec = levelRec(k), big = k === sel;
      const want = key + (big ? "|big|" + state.pick : "|small");
      if (rec.drawn !== want) { drawLevel(k, rec, big, big ? pick : null); rec.drawn = want; }
    }
    placeMeshes();
    updatePanel();
    updatePick(pick);
  });
}

ui.t.addEventListener("input", () => { stopAnim(); state.t = +ui.t.value; sync(); });
ui.ex.addEventListener("input", () => { state.ex = +ui.ex.value; sync(); });
ui.lvl.addEventListener("input", () => { state.lvl = +ui.lvl.value; sync(); });
ui.zmax.addEventListener("input", () => { state.zmax = +ui.zmax.value; sync(); });
for (const k of ["tiles", "pix", "coast", "grat"]) ui[k].addEventListener("change", () => { state[k] = ui[k].checked ? 1 : 0; sync(); });
const readUrl = () => {
  localFile = null;
  Object.assign(state, { spec: 0, src: ui.src.value.trim(), kind: ui.kind.value, var: ui.var.value.trim(), lvl: -1, pick: "" });
  if (sourceKey() === loadKey) loadKey = "";
  sync();
};
$("load").addEventListener("click", readUrl);
ui.src.addEventListener("keydown", (e) => { if (e.key === "Enter") readUrl(); });
ui.var.addEventListener("keydown", (e) => { if (e.key === "Enter") readUrl(); });
ui.kind.addEventListener("change", () => { state.kind = ui.kind.value; $("zarr-ctl").hidden = state.kind !== "zarr"; });
ui.layer.addEventListener("change", () => { state.layer = ui.layer.value; state.tms = ""; state.lvl = -1; state.pick = ""; sync(); });
ui.tms.addEventListener("change", () => { state.tms = ui.tms.value; state.lvl = -1; state.pick = ""; sync(); });
$("file-btn").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  localFile = f;
  Object.assign(state, { spec: 0, lvl: -1, pick: "" });
  sync();
});
$("s-draw").addEventListener("click", () => {
  localFile = null;
  Object.assign(state, { spec: 1, crs: ui.crs.value.trim(), ext: ui.ext.value.trim(), dim: ui.dim.value.trim(), tile: +ui.tile.value || 512, lev: +ui.lev.value || 0, lvl: -1, pick: "" });
  sync();
});
const tablePick = (e) => { const tr = e.target.closest("[data-k]"); if (tr) { state.lvl = +tr.dataset.k; sync(); } };
$("levels").addEventListener("click", tablePick);
$("pick-levels").addEventListener("click", tablePick);
$("layout").addEventListener("click", tablePick);
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(DEFAULT_CAM); writeHash(); });
$("copy-proj").addEventListener("click", (e) => copy(cur && cur.P.def ? cur.P.def : "", e.target));

// click (not drag) on a level picks the pixel under the pointer
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!cur || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const meshes = cur.recs.filter((x) => x && x.mesh.visible).map((x) => x.mesh);
  const hit = ray.intersectObjects(meshes)[0];
  if (!hit) return;
  const E = cur.E, x = E[0] + hit.uv.x * (E[2] - E[0]), y = E[1] + hit.uv.y * (E[3] - E[1]);
  state.lvl = hit.object.userData.k;
  state.pick = `${+x.toPrecision(10)},${+y.toPrecision(10)}`;
  sync();
});

let anim = false, dir = 1, lastT = 0;
const playBtn = $("play");
function stopAnim() { anim = false; playBtn.textContent = state.t >= 1 ? "Fold" : "Unfold"; }
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
  `<iframe src="${pageUrl()}?embed=1${location.hash}" width="100%" height="480" style="border:0" loading="lazy" title="Tiles and overviews"></iframe>`,
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

function tick(now) {
  if (anim) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    state.t = Math.max(0, Math.min(1, state.t + dir * dt * 0.3));
    if (state.t === 1 || state.t === 0) stopAnim();
    placeMeshes();
    ui.t.value = state.t;
    $("t-out").textContent = state.t === 0 ? "globe" : state.t === 1 ? cur.P.label : "unfolding";
    writeHash();
  }
  lastT = now;
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

window.addEventListener("hashchange", () => { readHash(); setCamera(state.cam || DEFAULT_CAM); sync(); });

if (embed) {
  document.body.classList.add("embed");
  $("open-full").hidden = false;
}

readHash();
setCamera(state.cam || DEFAULT_CAM);
resize();
loadCoastline("110m").then((lines) => { coast110 = lines; loadKey = ""; sync(); }, () => sync());
requestAnimationFrame(tick);
