// playproj: rasterize.
//
// One polygon, one grid, two answers side by side: the cells whose centre is
// inside (GDAL rasterize, fasterize) and the fraction of each cell covered
// (exactextract), both from rasterize.js. The grid is built round the shape
// in a CRS picked here, or is a window on a real raster's level read by
// structure.js, and the panel counts the tiles and bytes each answer needs.

import * as R from "./rasterize.js";
import * as S from "./structure.js";
import { coastRings, landPolygons } from "./landmesh.js";
import { loadCoastline } from "./data.js";

const proj4 = window.proj4, d3 = window.d3;
const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";
const GEBCO = "https://data.source.coop/ausantarctic/gebco/GEBCO_2026.tif";
const FIT_CELLS = 300;      // a raster level is picked so the window is at most this many cells across
const MAX_CELLS = 1200;     // and never more than this
const MAX_TILE_READS = 800;

const COLORS = {
  bg: "#05070d",
  cellIn: [61, 110, 168],
  cellOut: [13, 18, 32],
  grid: "rgba(140,196,255,0.16)",
  tile: "rgba(255,211,77,0.35)",
  tileOn: "rgba(255,211,77,0.95)",
  shape: "#f2f6fb",
  dotIn: "#6ab787",
  dotOut: "rgba(138,151,171,0.6)",
  pick: "#ff7ab8",
  pickFill: "rgba(255,122,184,0.35)",
  frac: "rgba(255,255,255,0.85)"
};

const SHAPES = [
  { key: "tas", label: "Tasmania", at: [146.6, -42.0] },
  { key: "ice", label: "Iceland", at: [-18.8, 64.9] },
  { key: "mad", label: "Madagascar", at: [46.8, -19.5] },
  { key: "gb", label: "Great Britain", at: [-1.8, 53.0] },
  { key: "ant", label: "Antarctica", at: [0, -85] },
  { key: "star", label: "Star with a hole" }
];

const SOURCES = [
  { label: "GEBCO 2026 COG", src: GEBCO },
  { label: "Sentinel-2 tile (spec)", src: "EPSG:32755; 499980,609780,5190220,5300020; 10980,10980; 1024" },
  { label: "Antarctic 1 km (spec)", src: "EPSG:3031; -3333000,3333000,-3333000,3333000; 6666,6666; 512" }
];

// the star (with its hole) of the test fixture, read as degrees
function starShape() {
  const outer = [], hole = [];
  for (let k = 0; k < 14; k++) {
    const a = (Math.PI * 2 * k) / 14 + 0.13, r = k % 2 === 0 ? 13.7 : 6.3;
    outer.push(20.31 + r * Math.cos(a), 15.17 + r * Math.sin(a));
  }
  for (let k = 0; k < 9; k++) {
    const a = (-Math.PI * 2 * k) / 9;
    hole.push(19.6 + 2.9 * Math.cos(a), 15.9 + 2.2 * Math.sin(a));
  }
  return [{ outer, holes: [hole] }];
}

// ---------------------------------------------------------------- state

const defaults = { at: "tas", detail: "110m", crs: "ll", def: "", n: 24, sx: 0, sy: 0, tile: 8, left: "centre", src: GEBCO, lvl: -1 };
const STRINGS = new Set(["at", "detail", "crs", "def", "left", "src"]);
const CRS_KEYS = ["ll", "laea", "merc", "polar", "utm", "file", "custom"];
const state = { ...defaults };
const embed = new URLSearchParams(location.search).has("embed");

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  Object.assign(state, defaults);
  for (const k of Object.keys(defaults)) {
    if (!h.has(k)) continue;
    const raw = h.get(k);
    if (STRINGS.has(k)) state[k] = raw;
    else if (isFinite(+raw)) state[k] = +raw;
  }
  if (!CRS_KEYS.includes(state.crs)) state.crs = "ll";
  if (state.crs === "custom" && !state.def) state.crs = "ll";
  if (!["centre", "touched", "warp"].includes(state.left)) state.left = "centre";
  if (!["110m", "50m"].includes(state.detail)) state.detail = "110m";
  state.n = Math.max(4, Math.min(240, Math.round(state.n)));
  state.sx = Math.max(-0.5, Math.min(0.5, state.sx));
  state.sy = Math.max(-0.5, Math.min(0.5, state.sy));
  if (![4, 8, 16, 32, 64].includes(state.tile)) state.tile = 8;
}

let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const h = new URLSearchParams();
    for (const k of Object.keys(defaults)) {
      if (k === "def" && state.crs !== "custom") continue;
      if ((k === "src" || k === "lvl") && state.crs !== "file") continue;
      const v = typeof state[k] === "number" ? +state[k].toFixed(3) : state[k];
      if (v !== defaults[k]) h.set(k, String(v));
    }
    const s = h.toString();
    history.replaceState(null, "", s ? "#" + s : location.pathname + location.search);
  }, 200);
}

// ---------------------------------------------------------------- shapes

let countries = null, land50 = null;

// Country parts are stored for the sphere: a ring may jump across 180
// (Fiji) or run the whole way round in longitude (Antarctica). For the plane
// each ring's longitudes are unwrapped so it is continuous, and a ring that
// still ends a turn away from where it started goes round a pole, so it is
// closed through that pole, as landmesh.js closes it.
function planarRing(r) {
  const o = [r[0], r[1]];
  for (let i = 2; i < r.length; i += 2) {
    let x = r[i];
    const prev = o[o.length - 2];
    while (x - prev > 180) x -= 360;
    while (prev - x > 180) x += 360;
    if (x === prev && r[i + 1] === o[o.length - 1]) continue;
    o.push(x, r[i + 1]);
  }
  const n = o.length;
  if (Math.abs(o[n - 2] - o[0]) < 1e-9 && o[n - 1] === o[1]) o.length -= 2;
  if (Math.abs(o[o.length - 2] - o[0]) > 180) {
    let mean = 0;
    for (let i = 1; i < o.length; i += 2) mean += o[i];
    const pole = mean < 0 ? -90 : 90;
    o.push(o[o.length - 2], pole, o[0], pole);
  }
  return o;
}

async function loadShapes(detail) {
  if (detail === "50m") {
    if (!land50) land50 = landPolygons(coastRings(await loadCoastline("50m")));
    return land50;
  }
  if (!countries) {
    const parts = await fetch(new URL("../data/countries-110m.json", import.meta.url)).then((r) => r.json());
    countries = parts.map((rings) => ({ outer: planarRing(rings[0]), holes: rings.slice(1).map(planarRing) }));
  }
  return countries;
}

function inRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// The smallest polygon holding the point, trying a turn either way for
// polygons whose longitudes run past 180.
function partAt(list, lon, lat) {
  let best = null, bestA = Infinity;
  for (const p of list) {
    const [x0, y0, x1, y1] = R.bbox([p]);
    if (lat < y0 || lat > y1) continue;
    for (const d of [0, 360, -360]) {
      const x = lon + d;
      if (x < x0 || x > x1) continue;
      if (inRing(x, lat, p.outer) && !p.holes.some((h) => inRing(x, lat, h))) {
        const a = (x1 - x0) * (y1 - y0);
        if (a < bestA) { best = p; bestA = a; }
        break;
      }
    }
  }
  return best;
}

function shapeName() {
  const s = SHAPES.find((s) => s.key === state.at);
  if (s) return s.label;
  const [lon, lat] = state.at.split(",").map(Number);
  return `the shape at ${Math.abs(lat).toFixed(1)}${DEG}${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(1)}${DEG}${lon < 0 ? "W" : "E"}`;
}

async function currentShape() {
  if (state.at === "star") return starShape();
  const list = await loadShapes(state.detail);
  const s = SHAPES.find((s) => s.key === state.at);
  const at = s ? s.at : state.at.split(",").map(Number);
  if (at.length !== 2 || !at.every(isFinite)) return null;
  const p = partAt(list, at[0], at[1]);
  return p ? [p] : null;
}

// ---------------------------------------------------------------- CRS

function centreOf(polys) {
  const [x0, y0, x1, y1] = R.bbox(polys);
  let lon = (x0 + x1) / 2;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  const lat = y0 <= -89.9 ? -90 : y1 >= 89.9 ? 90 : (y0 + y1) / 2;
  return [lon, lat];
}

const W84 = "+datum=WGS84 +units=m +no_defs";
function crsFor(key, [lon, lat]) {
  if (key === "ll") return "+proj=longlat +datum=WGS84 +no_defs";
  if (key === "laea") return `+proj=laea +lat_0=${+lat.toFixed(2)} +lon_0=${+lon.toFixed(2)} +x_0=0 +y_0=0 ${W84}`;
  if (key === "merc") return S.knownProj4(3857);
  if (key === "polar") return S.knownProj4(lat < 0 ? 3031 : 3413);
  if (key === "utm") {
    const z = Math.max(1, Math.min(60, Math.floor((lon + 180) / 6) + 1));
    return `+proj=utm +zone=${z}${lat < 0 ? " +south" : ""} ${W84}`;
  }
  return null;
}

const isLonLat = (def) => /\+proj=(longlat|latlong|lonlat|latlon)\b/.test(def) || /^GEOGCS|^GEOGCRS/i.test(def);

function transforms(def) {
  if (isLonLat(def)) return { fwd: (lon, lat) => [lon, lat], inv: (x, y) => [x, y], ll: true };
  const P = proj4(def);
  return { fwd: (lon, lat) => P.forward([lon, lat]), inv: (x, y) => P.inverse([x, y]), ll: false };
}

function crsOfStructure(s) {
  const c = s.crs;
  if (!c) throw new Error("the raster has no CRS");
  if (c.proj4) return c.proj4;
  if (c.epsg) {
    const d = S.knownProj4(c.epsg);
    if (d) return d;
    if (c.wkt) return c.wkt;
    throw new Error(`EPSG:${c.epsg} is not one this page knows; give the grid as a spec with a PROJ string`);
  }
  if (c.wkt) return c.wkt;
  throw new Error("the raster's CRS could not be read");
}

// ---------------------------------------------------------------- raster files

let file = null;          // { key, s, src, def }
let fileErr = "";
const tileByteCache = new Map();

function parseSpec(text) {
  const parts = text.split(";").map((t) => t.trim());
  if (parts.length < 3) throw new Error("a spec is CRS; xmin,xmax,ymin,ymax; cols,rows; tile");
  const ext = parts[1].split(",").map(Number), dim = parts[2].split(",").map(Number);
  if (ext.length !== 4 || !ext.every(isFinite)) throw new Error("the extent needs four numbers, xmin,xmax,ymin,ymax");
  if (dim.length !== 2 || !dim.every(isFinite)) throw new Error("the dimension needs two numbers, cols,rows");
  return S.specStructure({ crs: parts[0], extent: ext, dim, tile: +(parts[3] || 512) || 512 });
}

async function loadFile(text) {
  text = text.trim();
  if (file && file.key === text) return file;
  let s, src = null;
  if (text.includes(";")) s = parseSpec(text);
  else {
    const kind = S.guessKind(text);
    if (kind && kind !== "tiff") throw new Error("this page reads GeoTIFFs and typed specs; the other kinds are on Tiles and overviews");
    src = S.rangeSource(text);
    try { s = await S.tiffStructure(src); } catch (e) {
      if (e && e.name === "TypeError") throw new Error(`could not reach ${new URL(text, location.href).host}: offline, or the server does not allow reads from other sites`);
      throw e;
    }
  }
  file = { key: text, s, src, def: crsOfStructure(s) };
  tileByteCache.clear();
  return file;
}

// ---------------------------------------------------------------- the computation

let shapeLL = null, shapeKey = "";
let cur = null;           // everything about the current grid and its two answers
let fitKey = "";

function windowOn(L, bb) {
  const cs = [(bb[0] - L.x0) / L.dx, (bb[2] - L.x0) / L.dx], rs = [(bb[1] - L.y0) / L.dy, (bb[3] - L.y0) / L.dy];
  const c0 = Math.max(0, Math.floor(Math.min(...cs)) - 1), c1 = Math.min(L.width, Math.ceil(Math.max(...cs)) + 1);
  const r0 = Math.max(0, Math.floor(Math.min(...rs)) - 1), r1 = Math.min(L.height, Math.ceil(Math.max(...rs)) + 1);
  return { c0, r0, w: c1 - c0, h: r1 - r0 };
}

function compute() {
  const err = (m) => { cur = null; setStatus(m); };
  if (!shapeLL) return err("no shape here: pick one, or click land on the globe");
  const centre = centreOf(shapeLL);
  let def, T, G, levelNote = "", L = null, win = null;
  if (state.crs === "file") {
    if (!file) return err(fileErr || "read a raster, or pick one above");
    def = file.def;
  } else def = state.crs === "custom" ? state.def : crsFor(state.crs, centre);
  let tf;
  try { tf = transforms(def); } catch (e) { return err(`the CRS did not parse: ${e.message || e}`); }
  let polys = R.projectPolys(shapeLL, tf.fwd);
  if (!polys.length) return err(`${shapeName()} does not project in this CRS (it reaches a pole, or past the projection's edge)`);
  // longitudes in a raster file run -180 to 180: a shape past 180 comes back a turn
  if (state.crs === "file" && tf.ll) {
    const bb = R.bbox(polys);
    const lv = file.s.levels[0], ext = S.levelExtent(lv);
    const d = bb[0] >= ext[2] ? -360 : bb[2] <= ext[0] ? 360 : 0;
    if (d) polys = polys.map((p) => ({ outer: p.outer.map((v, i) => (i % 2 ? v : v + d)), holes: p.holes.map((h) => h.map((v, i) => (i % 2 ? v : v + d))) }));
  }
  const bb = R.bbox(polys);
  if (state.crs === "file") {
    const levels = file.s.levels;
    let k = state.lvl;
    if (!(k >= 0 && k < levels.length)) {
      k = levels.findIndex((lv) => { const w = windowOn(lv, bb); return Math.max(w.w, w.h) <= FIT_CELLS; });
      if (k < 0) k = levels.length - 1;
    }
    L = levels[k];
    win = windowOn(L, bb);
    if (win.w <= 0 || win.h <= 0) return err(`${shapeName()} is outside this raster`);
    if (Math.max(win.w, win.h) > MAX_CELLS) return err(`at ${L.name} the shape covers ${win.w} x ${win.h} cells; pick a coarser level`);
    G = { x0: L.x0 + win.c0 * L.dx, y0: L.y0 + win.r0 * L.dy, dx: L.dx, dy: L.dy, width: win.w, height: win.h };
    T = { tw: L.tileW, th: L.tileH, ox: win.c0, oy: win.r0, tilesX: L.tilesX };
    const full = windowOn(levels[0], bb);
    levelNote = `${L.name}${k ? ` (1/${Math.round(L.factor || 2 ** k)})` : ""}: the shape spans ${win.w} x ${win.h} of its cells` +
      (k > 0 ? `, ${full.w} x ${full.h} at full resolution` : "") + `, in tiles of ${L.tileW} x ${L.tileH}.`;
  } else {
    const g0 = R.gridAround(bb, state.n);
    G = { ...g0, x0: g0.x0 + state.sx * g0.dx, y0: g0.y0 + state.sy * g0.dy };
    T = { tw: state.tile, ox: 0, oy: 0 };
  }
  const W = G.width, H = G.height;
  const px = R.toPixel(polys, G);
  const mask = R.centreIn(px, W, H);
  const cov = R.coverage(px, W, H);
  const sum = R.summarise(mask, cov, W, H, T);
  cur = { def, tf, polys, G, T, L, win, px, mask, cov, sum, centre, levelNote, warp: null, areas: null };
  if (state.left === "warp") cur.warp = warped(cur);
  setStatus("");
}

// Rasterize in longitude and latitude, then take each cell of this grid from
// the longitude-latitude cell under its centre (nearest neighbour).
function warped(c) {
  const { G, tf } = c, W = G.width, H = G.height;
  // a source cell about as big as this grid's middle cell
  const mid = cellRing(G, Math.floor(W / 2), Math.floor(H / 2)).map((p) => tf.inv(p[0], p[1]));
  const lats = mid.map((p) => p[1]), lons = mid.map((p) => p[0]);
  let dd = Math.max(Math.max(...lats) - Math.min(...lats), 1e-9);
  if (tf.ll) dd = Math.abs(G.dx);
  else dd = Math.max(dd, (Math.max(...lons) - Math.min(...lons)) * Math.cos((lats[0] * Math.PI) / 180));
  const [bx0, by0, bx1, by1] = R.bbox(shapeLL);
  dd = Math.max(dd, (bx1 - bx0) / 2000, (by1 - by0) / 2000);
  // a global grid: a whole number of cells from 90N to 90S, columns from 180W
  dd = 180 / Math.max(1, Math.round(180 / dd));
  const k0 = Math.floor((bx0 + 180) / dd) - 1, k1 = Math.ceil((bx1 + 180) / dd) + 1;
  const j0 = Math.max(0, Math.floor((90 - by1) / dd) - 1), j1 = Math.min(Math.round(180 / dd), Math.ceil((90 - by0) / dd) + 1);
  const sx0 = -180 + k0 * dd, sy1 = 90 - j0 * dd, Ws = k1 - k0, Hs = j1 - j0;
  const Gs = { x0: sx0, y0: sy1, dx: dd, dy: -dd, width: Ws, height: Hs };
  const src = R.centreIn(R.toPixel(shapeLL, Gs), Ws, Hs);
  const out = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) for (let col = 0; col < W; col++) {
    const p = tf.inv(G.x0 + (col + 0.5) * G.dx, G.y0 + (r + 0.5) * G.dy);
    if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
    let lon = p[0];
    for (const d of [0, 360, -360]) if (lon + d >= sx0 && lon + d < sx0 + Ws * dd) { lon += d; break; }
    const sc = Math.floor((lon - sx0) / dd), sr = Math.floor((sy1 - p[1]) / dd);
    if (sc >= 0 && sr >= 0 && sc < Ws && sr < Hs && src[sr * Ws + sc]) out[r * W + col] = 1;
  }
  return { mask: out, dd };
}

// The cell's outline in grid coordinates: corners and edge midpoints.
function cellRing(G, c, r) {
  const x = (i) => G.x0 + i * G.dx, y = (j) => G.y0 + j * G.dy;
  const pts = [];
  for (const [a, b] of [[c, r], [c + 0.5, r], [c + 1, r], [c + 1, r + 0.5], [c + 1, r + 1], [c + 0.5, r + 1], [c, r + 1], [c, r + 0.5]]) pts.push([x(a), y(b)]);
  return pts;
}

// True areas: every cell any answer uses, and the shape, on the ellipsoid
// through an equal-area projection centred on the shape.
function areas(c) {
  const ea = proj4(`+proj=laea +lat_0=${c.centre[1]} +lon_0=${c.centre[0]} +x_0=0 +y_0=0 ${W84}`);
  const toEA = (lon, lat) => ea.forward([lon, lat]);
  const W = c.G.width, H = c.G.height;
  // the shape, or the part of it inside the grid when the grid cuts it
  const [px0, py0, px1, py1] = R.bbox(c.px);
  const clipped = px0 < 0 || py0 < 0 || px1 > W || py1 > H;
  let shape;
  if (!clipped) shape = R.polygonArea(R.projectPolys(shapeLL, toEA, 0.1));
  else {
    const toLL = (x, y) => c.tf.inv(c.G.x0 + x * c.G.dx, c.G.y0 + y * c.G.dy);
    const inside = R.clipRect(c.px, 0, 0, W, H);
    // edges are straight in the grid, so densify there (a tenth of a cell)
    shape = R.polygonArea(R.projectPolys(inside, (x, y) => { const q = toLL(x, y); return toEA(q[0], q[1]); }, 0.1));
  }
  const cell = new Float64Array(W * H);
  const use = c.warp ? c.warp.mask : null;
  for (let i = 0; i < W * H; i++) {
    if (!(c.cov[i] > 0 || c.mask[i] || (use && use[i]))) continue;
    const ring = cellRing(c.G, i % W, Math.floor(i / W)).flatMap((p) => {
      const q = c.tf.inv(p[0], p[1]);
      return toEA(q[0], q[1]);
    });
    cell[i] = Math.abs(R.ringArea2(ring)) / 2;
  }
  let aIn = 0, aCov = 0, aTouch = 0, aWarp = 0;
  for (let i = 0; i < W * H; i++) {
    if (c.mask[i]) aIn += cell[i];
    if (c.cov[i] > 0) { aCov += c.cov[i] * cell[i]; aTouch += cell[i]; }
    if (use && use[i]) aWarp += cell[i];
  }
  return { shape, clipped, cell, aIn, aCov, aTouch, aWarp };
}

// ---------------------------------------------------------------- view

const canvases = { left: $("left"), right: $("right") };
let view = null;          // { s, x, y }: cell (c, r) is at CSS pixel (x + c s, y + r s)
let hover = null;         // [col, row]

function fit() {
  if (!cur) return;
  const cv = canvases.left, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  const { width: W, height: H } = cur.G, m = 18;
  const s = Math.min((w - 2 * m) / W, (h - 2 * m) / H);
  view = { s, x: (w - W * s) / 2, y: (h - H * s) / 2 };
}

const images = { left: document.createElement("canvas"), right: document.createElement("canvas") };

function paintImages() {
  if (!cur) return;
  const { width: W, height: H } = cur.G;
  const leftMask = state.left === "warp" && cur.warp ? cur.warp.mask : null;
  for (const which of ["left", "right"]) {
    const im = images[which];
    im.width = W; im.height = H;
    const ctx = im.getContext("2d");
    const data = ctx.createImageData(W, H), d = data.data;
    for (let i = 0; i < W * H; i++) {
      let f;
      if (which === "right") f = cur.cov[i];
      else if (leftMask) f = leftMask[i];
      else if (state.left === "touched") f = cur.cov[i] > 0 ? 1 : 0;
      else f = cur.mask[i];
      for (let k = 0; k < 3; k++) d[4 * i + k] = Math.round(COLORS.cellOut[k] + f * (COLORS.cellIn[k] - COLORS.cellOut[k]));
      d[4 * i + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
  }
}

function inLeft(i) {
  if (state.left === "warp" && cur.warp) return cur.warp.mask[i];
  if (state.left === "touched") return cur.cov[i] > 0;
  return cur.mask[i];
}

function ringPath(ctx, r, X, Y) {
  for (let i = 0; i < r.length; i += 2) {
    const x = X(r[i]), y = Y(r[i + 1]);
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.closePath();
}

function draw(which) {
  const cv = canvases[which], dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  if (!cur || !view) return;
  const { width: W, height: H } = cur.G, { s } = view;
  const X = (c) => view.x + c * s, Y = (r) => view.y + r * s;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(images[which], X(0), Y(0), W * s, H * s);

  // cell lines, when cells are big enough to see
  const c0 = Math.max(0, Math.floor(-view.x / s)), c1 = Math.min(W, Math.ceil((w - view.x) / s));
  const r0 = Math.max(0, Math.floor(-view.y / s)), r1 = Math.min(H, Math.ceil((h - view.y) / s));
  if (s >= 5) {
    ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = c0; c <= c1; c++) { ctx.moveTo(X(c), Y(r0)); ctx.lineTo(X(c), Y(r1)); }
    for (let r = r0; r <= r1; r++) { ctx.moveTo(X(c0), Y(r)); ctx.lineTo(X(c1), Y(r)); }
    ctx.stroke();
  }

  // tiles: all of them faint, the ones this answer needs bright
  const T = cur.T, th = T.th || T.tw;
  const tset = which === "right" ? cur.sum.tilesAny : (state.left === "centre" ? cur.sum.tilesIn
    : R.tilesTouched((i) => inLeft(i), W, H, T));
  const tx0 = Math.floor(T.ox / T.tw), tx1 = Math.floor((W - 1 + T.ox) / T.tw);
  const ty0 = Math.floor(T.oy / th), ty1 = Math.floor((H - 1 + T.oy) / th);
  const tilesX = T.tilesX || Math.ceil((W + T.ox) / T.tw);
  ctx.lineWidth = 1;
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const a = Math.max(0, tx * T.tw - T.ox), b = Math.min(W, (tx + 1) * T.tw - T.ox);
    const c = Math.max(0, ty * th - T.oy), d = Math.min(H, (ty + 1) * th - T.oy);
    const on = tset.has(ty * tilesX + tx);
    ctx.strokeStyle = on ? COLORS.tileOn : COLORS.tile;
    ctx.lineWidth = on ? 1.6 : 1;
    ctx.strokeRect(X(a) + 0.5, Y(c) + 0.5, (b - a) * s - 1, (d - c) * s - 1);
  }

  // cell centres on the left
  if (which === "left" && s >= 7 && state.left === "centre") {
    const rad = Math.min(3, s / 7);
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
      ctx.fillStyle = cur.mask[r * W + c] ? COLORS.dotIn : COLORS.dotOut;
      ctx.beginPath(); ctx.arc(X(c + 0.5), Y(r + 0.5), rad, 0, 2 * Math.PI); ctx.fill();
    }
  }

  // where the warp and centre in disagree
  if (which === "left" && state.left === "warp" && cur.warp) {
    ctx.strokeStyle = COLORS.pick; ctx.lineWidth = Math.max(1, Math.min(2, s / 8));
    const k = Math.min(s / 4, 4);
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
      const i = r * W + c;
      if (cur.warp.mask[i] !== cur.mask[i]) ctx.strokeRect(X(c) + k, Y(r) + k, s - 2 * k, s - 2 * k);
    }
  }

  // fractions on the right, when they fit
  if (which === "right" && s >= 30) {
    ctx.fillStyle = COLORS.frac;
    ctx.font = `${Math.min(13, s / 3.2)}px system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
      const f = cur.cov[r * W + c];
      if (f > 0 && f < 1) ctx.fillText(f < 0.005 ? "<.01" : f > 0.995 ? ">.99" : f.toFixed(2).slice(1), X(c + 0.5), Y(r + 0.5));
    }
  }

  // the polygon
  ctx.strokeStyle = COLORS.shape; ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (const p of cur.px) for (const r of [p.outer, ...p.holes]) ringPath(ctx, r, X, Y);
  ctx.stroke();

  // the cell under the pointer
  if (hover) {
    const [hc, hr] = hover;
    if (which === "left") {
      const yc = hr + 0.5, xs = R.crossings(cur.px, yc);
      ctx.strokeStyle = COLORS.pick; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X(0), Y(yc)); ctx.lineTo(X(W), Y(yc)); ctx.stroke();
      ctx.lineWidth = 3;
      for (let k = 0; k + 1 < xs.length; k += 2) { ctx.beginPath(); ctx.moveTo(X(xs[k]), Y(yc)); ctx.lineTo(X(xs[k + 1]), Y(yc)); ctx.stroke(); }
      ctx.fillStyle = COLORS.pick;
      for (const x of xs) { ctx.beginPath(); ctx.arc(X(x), Y(yc), 3.5, 0, 2 * Math.PI); ctx.fill(); }
    } else {
      ctx.fillStyle = COLORS.pickFill;
      ctx.beginPath();
      for (const p of R.cellPiece(cur.px, hc, hr)) for (const r of [p.outer, ...p.holes]) ringPath(ctx, r, X, Y);
      ctx.fill("evenodd");
    }
    ctx.strokeStyle = COLORS.pick; ctx.lineWidth = 2;
    ctx.strokeRect(X(hc), Y(hr), s, s);
  }
}

function drawAll() { draw("left"); draw("right"); }

// ---------------------------------------------------------------- readouts

const km2 = (m2) => {
  const v = m2 / 1e6;
  return (v >= 1e5 ? Math.round(v).toLocaleString("en-US") : v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toPrecision(2)) + " km2";
};
const pct = (a, b) => {
  const p = (100 * (a - b)) / b, t = Math.abs(p).toFixed(Math.abs(p) < 10 ? 1 : 0);
  return (+t === 0 ? "" : p > 0 ? "+" : "-") + t + "%";
};
const bytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
const num = (n) => Math.round(n).toLocaleString("en-US");

function rows(el, list, head = null) {
  el.innerHTML = "";
  for (const [k, row] of (head ? [head, ...list] : list).entries()) {
    const tr = document.createElement("tr");
    if (head && k === 0) tr.className = "head";
    for (const v of row) { const td = document.createElement("td"); td.textContent = v; tr.appendChild(td); }
    el.appendChild(tr);
  }
}

function readouts() {
  if (!cur) {
    rows($("counts"), []); rows($("bytes"), []);
    for (const id of ["grid-info", "bytes-note", "counts-note"]) $(id).textContent = "";
    return;
  }
  const { G, sum: m, tf } = cur;
  const size = Math.abs(G.dx);
  const sizeText = tf.ll ? `${+size.toPrecision(3)}${DEG}` : size >= 1000 ? `${+(size / 1000).toPrecision(3)} km` : `${+size.toPrecision(3)} m`;
  $("grid-info").textContent = (cur.levelNote ? cur.levelNote + " " : "") +
    `${G.width} x ${G.height} cells of ${sizeText}` + (tf.ll ? "" : `, nominally ${km2(size * size)} each`) + ".";
  const A = cur.areas;
  const area = (a) => (A ? km2(a) : "..."), err = (a) => (A ? pct(a, A.shape) : "");
  const list = [
    [A && A.clipped ? "Shape in the grid" : "Shape", "", area(A && A.shape), ""],
    ["Centre in", num(m.nIn), area(A && A.aIn), err(A && A.aIn)],
    ["All touched", num(m.nAny), area(A && A.aTouch), err(A && A.aTouch)],
    ["Exact coverage", m.sum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), area(A && A.aCov), err(A && A.aCov)]
  ];
  if (cur.warp) {
    const n = cur.warp.mask.reduce((a, b) => a + b, 0);
    list.push(["Warped", num(n), area(A && A.aWarp), err(A && A.aWarp)]);
  }
  if (!tf.ll) list.push(["Centre in, nominal", num(m.nIn), km2(m.nIn * size * size), err(m.nIn * size * size)]);
  rows($("counts"), list, ["", "cells", "area", "error"]);
  let note = `Exact coverage: ${num(m.nFull)} whole cells and ${num(m.nEdge)} edge cells.`;
  if (cur.warp) {
    let diff = 0;
    for (let i = 0; i < cur.mask.length; i++) if (cur.warp.mask[i] !== cur.mask[i]) diff++;
    note += ` Warped from a ${+cur.warp.dd.toPrecision(3)}${DEG} longitude-latitude grid, ${num(diff)} cells differ from centre in (outlined).`;
  }
  if (!tf.ll) note += " Nominal: cells times the cell size squared, as if the CRS were equal-area.";
  $("counts-note").textContent = note;

  const b = m.bytes;
  const tw = cur.T.tw, th = cur.T.th || tw;
  const bl = [
    ["Tiles, centre in", `${num(m.tilesIn.size)} of ${num(m.tilesAll)}`],
    ["Tiles, coverage", `${num(m.tilesAny.size)} of ${num(m.tilesAll)}`],
    ["Dense mask, 1 B a cell", bytes(b.denseMask)],
    [`Touched tiles, ${tw} x ${th} B`, bytes(b.tilesMask)],
    [`Runs (row, first, last): ${num(m.runsIn)}`, bytes(b.runsMask)],
    [`Cell numbers: ${num(m.nIn)}`, bytes(b.indexMask)],
    ["Dense coverage, float32", bytes(b.denseCov)],
    [`Bounding box floats (exactextract): ${num(m.bboxCells)}`, bytes(b.bboxCov)],
    [`Cell number and fraction: ${num(m.nAny)}`, bytes(b.listCov)],
    [`Runs of whole cells and edge fractions`, bytes(b.runsEdges)]
  ];
  if (cur.fileBytes) bl.unshift(...cur.fileBytes);
  rows($("bytes"), bl);
  $("bytes-note").textContent = cur.L
    ? (file.src ? "Byte ranges are the tiles' own, from the file's tile offsets and byte counts (compressed)." :
      "A typed spec has no file, so tile bytes are not known; the counts are the tiles a reader would fetch.")
    : "Tiles here are a tiling of this grid, to show which pieces a reader or writer would need.";
}

function pickInfo() {
  if (!cur || !hover) { $("pick-info").textContent = "Point at a cell to see its scanline and its piece of the shape."; return; }
  const [c, r] = hover, W = cur.G.width, i = r * W + c;
  const A = cur.areas;
  const gc = cur.win ? `${c + cur.win.c0}, ${r + cur.win.r0}` : `${c}, ${r}`;
  let t = `Cell ${gc}: centre ${cur.mask[i] ? "in" : "out"}, coverage ${cur.cov[i].toFixed(4)}`;
  if (A && A.cell[i]) t += `, ${km2(A.cell[i])}`;
  if (cur.L) {
    const tc = Math.floor((c + cur.T.ox) / cur.T.tw), tr = Math.floor((r + cur.T.oy) / (cur.T.th || cur.T.tw));
    t += `; tile ${tc}, ${tr}`;
  }
  $("pick-info").textContent = t + ".";
}

// Byte ranges of the tiles each answer touches, from the TIFF's offsets.
let bytesToken = 0;
async function fileBytes() {
  const c = cur;
  if (!c || !c.L || !file || !file.src) return;
  const token = ++bytesToken;
  const L = c.L, list = [...c.sum.tilesAny].sort((a, b) => a - b);
  if (list.length > MAX_TILE_READS) {
    c.fileBytes = [["From the file", `${num(list.length)} tiles, too many to look up here`]];
    readouts(); return;
  }
  const got = [];
  for (const idx of list) {
    const key = `${L.ifd}:${idx}`;
    if (!tileByteCache.has(key)) tileByteCache.set(key, await S.tileBytes(file.src, file.s, L, idx));
    if (token !== bytesToken) return;
    got.push([idx, tileByteCache.get(key)]);
  }
  const sumOf = (set) => {
    const rs = got.filter(([i, b]) => b && set.has(i)).map(([, b]) => b).sort((a, b) => a.offset - b.offset);
    let total = 0, reqs = 0, end = -1;
    for (const b of rs) { total += b.length; if (b.offset !== end) reqs++; end = b.offset + b.length; }
    return { total, reqs, n: rs.length, empty: set.size - rs.length };
  };
  const a = sumOf(c.sum.tilesIn), b = sumOf(c.sum.tilesAny);
  const sparse = (x) => (x.empty ? `, ${x.empty} empty` : "");
  c.fileBytes = [
    ["File bytes, centre in", `${bytes(a.total)} in ${a.reqs} range${a.reqs === 1 ? "" : "s"}${sparse(a)}`],
    ["File bytes, coverage", `${bytes(b.total)} in ${b.reqs} range${b.reqs === 1 ? "" : "s"}${sparse(b)}`]
  ];
  if (cur === c) readouts();
}

// ---------------------------------------------------------------- the globe inset

const inset = $("inset");
let insetProj = null;

function drawInset() {
  const ctx = inset.getContext("2d"), w = inset.width, h = inset.height;
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, w, h);
  if (!shapeLL) return;
  const [lon, lat] = centreOf(shapeLL);
  const proj = d3.geoOrthographic().rotate([-lon, -lat]).fitExtent([[10, 10], [w - 10, h - 10]], { type: "Sphere" });
  insetProj = proj;
  const path = d3.geoPath(proj, ctx);
  ctx.beginPath(); path({ type: "Sphere" }); ctx.fillStyle = "#0b1426"; ctx.fill();
  ctx.beginPath(); path(d3.geoGraticule10()); ctx.strokeStyle = "rgba(140,196,255,0.15)"; ctx.lineWidth = 1; ctx.stroke();
  const pts = (r) => { const o = []; for (let i = 0; i < r.length; i += 2) o.push([r[i], r[i + 1]]); return o; };
  if (countries) {
    ctx.beginPath();
    for (const p of countries) path({ type: "LineString", coordinates: pts(p.outer) });
    ctx.strokeStyle = "rgba(215,236,255,0.45)"; ctx.stroke();
  }
  // the shape, wound the way d3 wants (small area outside)
  const geom = { type: "MultiPolygon", coordinates: shapeLL.map((p) => [pts(p.outer), ...p.holes.map(pts)]) };
  geom.coordinates = geom.coordinates.map((poly) => poly.map((ring, k) => {
    const a = d3.geoArea({ type: "Polygon", coordinates: [ring] });
    return (k === 0) === (a > 2 * Math.PI) ? ring.slice().reverse() : ring;
  }));
  ctx.beginPath(); path(geom); ctx.fillStyle = "rgba(61,110,168,0.9)"; ctx.fill();
  ctx.strokeStyle = COLORS.shape; ctx.lineWidth = 1; ctx.stroke();
  // the grid's edge, through the inverse projection
  if (cur) {
    const { G, tf } = cur, W = G.width, H = G.height, line = [];
    const k = 24;
    const edge = (c, r) => { const q = tf.inv(G.x0 + c * G.dx, G.y0 + r * G.dy); if (q && isFinite(q[0]) && isFinite(q[1])) line.push(q); };
    for (let i = 0; i <= k; i++) edge((W * i) / k, 0);
    for (let i = 0; i <= k; i++) edge(W, (H * i) / k);
    for (let i = k; i >= 0; i--) edge((W * i) / k, H);
    for (let i = k; i >= 0; i--) edge(0, (H * i) / k);
    ctx.beginPath(); path({ type: "LineString", coordinates: line });
    ctx.strokeStyle = COLORS.tileOn; ctx.lineWidth = 1.5; ctx.stroke();
  }
  ctx.beginPath(); path({ type: "Sphere" }); ctx.strokeStyle = "rgba(140,196,255,0.4)"; ctx.lineWidth = 1; ctx.stroke();
}

inset.addEventListener("click", (e) => {
  if (!insetProj) return;
  const b = inset.getBoundingClientRect();
  const x = ((e.clientX - b.left) / b.width) * inset.width, y = ((e.clientY - b.top) / b.height) * inset.height;
  const p = insetProj.invert([x, y]);
  if (!p || !isFinite(p[0])) return;
  const [cx, cy] = insetProj([p[0], p[1]]);
  if (Math.hypot(cx - x, cy - y) > 1) return;     // off the globe
  state.at = `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  if (state.crs === "file") state.lvl = -1;
  update({ shape: true });
});

// ---------------------------------------------------------------- UI

function setStatus(t) { $("status").textContent = t; }

const shapeBox = $("shapes");
for (const s of SHAPES) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = s.label; b.dataset.key = s.key;
  b.addEventListener("click", () => { state.at = s.key; state.lvl = -1; update({ shape: true }); });
  shapeBox.appendChild(b);
}
for (const s of SOURCES) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "small"; b.textContent = s.label; b.dataset.src = s.src;
  b.addEventListener("click", () => { state.src = s.src; state.lvl = -1; $("src").value = s.src; update({ file: true }); });
  $("sources").appendChild(b);
}
for (const b of $("modes").children) b.addEventListener("click", () => { state.left = b.dataset.left; update({}); });

$("n").addEventListener("input", (e) => { state.n = +e.target.value; update({ refit: true }); });
$("sx").addEventListener("input", (e) => { state.sx = +e.target.value; update({ quick: true }); });
$("sy").addEventListener("input", (e) => { state.sy = +e.target.value; update({ quick: true }); });
$("tile").addEventListener("change", (e) => { state.tile = +e.target.value; update({}); });
$("detail").addEventListener("change", (e) => { state.detail = e.target.value; update({ shape: true }); });
$("crs").addEventListener("change", (e) => { state.crs = e.target.value; state.lvl = -1; update({ file: state.crs === "file", refit: true }); });
$("def").addEventListener("change", (e) => {
  const v = e.target.value.trim();
  if (!v) return;
  state.crs = "custom"; state.def = v; update({ refit: true });
});
$("load").addEventListener("click", () => { state.src = $("src").value.trim(); state.lvl = -1; update({ file: true }); });
$("src").addEventListener("keydown", (e) => { if (e.key === "Enter") $("load").click(); });
$("lvl").addEventListener("change", (e) => { state.lvl = +e.target.value; update({ refit: true }); });

let drifting = false, driftT0 = 0;
function driftFrame(t) {
  if (!drifting) return;
  const a = (t - driftT0) / 2400;
  state.sx = +(0.45 * Math.cos(a)).toFixed(3);
  state.sy = +(0.45 * Math.sin(a * 0.73)).toFixed(3);
  update({ quick: true });
  requestAnimationFrame(driftFrame);
}
$("drift").addEventListener("click", () => {
  drifting = !drifting && state.crs !== "file";
  $("drift").classList.toggle("active", drifting);
  if (drifting) { driftT0 = performance.now(); requestAnimationFrame(driftFrame); }
  else update({});
});

// pan, zoom and point at cells, the same on both canvases
for (const cv of Object.values(canvases)) {
  let drag = null;
  cv.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY, view ? view.x : 0, view ? view.y : 0]; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener("pointerup", () => { drag = null; });
  cv.addEventListener("pointermove", (e) => {
    if (!view || !cur) return;
    if (drag) {
      view.x = drag[2] + e.clientX - drag[0]; view.y = drag[3] + e.clientY - drag[1];
      drawAll(); return;
    }
    const b = cv.getBoundingClientRect();
    const c = Math.floor((e.clientX - b.left - view.x) / view.s), r = Math.floor((e.clientY - b.top - view.y) / view.s);
    const h = c >= 0 && r >= 0 && c < cur.G.width && r < cur.G.height ? [c, r] : null;
    if (String(h) !== String(hover)) { hover = h; drawAll(); pickInfo(); }
  });
  cv.addEventListener("pointerleave", () => { if (hover) { hover = null; drawAll(); pickInfo(); } });
  cv.addEventListener("wheel", (e) => {
    if (!view) return;
    e.preventDefault();
    const b = cv.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top;
    const k = Math.exp(-e.deltaY * 0.0015);
    view.x = mx - (mx - view.x) * k; view.y = my - (my - view.y) * k; view.s *= k;
    drawAll();
  }, { passive: false });
  cv.addEventListener("dblclick", () => { fit(); drawAll(); });
}

function syncUI() {
  for (const b of shapeBox.children) b.classList.toggle("active", b.dataset.key === state.at);
  for (const b of $("modes").children) b.classList.toggle("active", b.dataset.left === state.left);
  for (const b of $("sources").children) b.classList.toggle("active", b.dataset.src === state.src);
  $("n").value = state.n; $("n-out").textContent = state.n;
  $("sx").value = state.sx; $("sy").value = state.sy;
  $("shift-out").textContent = `${state.sx.toFixed(2)}, ${state.sy.toFixed(2)} of a cell`;
  $("tile").value = String(state.tile);
  $("detail").value = state.detail;
  const isFile = state.crs === "file";
  let opt = $("crs").querySelector('option[value="custom"]');
  if (state.crs === "custom" && !opt) {
    opt = document.createElement("option"); opt.value = "custom"; opt.textContent = "PROJ string, as typed";
    $("crs").appendChild(opt);
  }
  $("crs").value = state.crs;
  $("file-ctl").hidden = !isFile;
  for (const id of ["n", "sx", "sy", "drift"]) $(id).disabled = isFile;
  $("tile-row").hidden = isFile;
  if (isFile && $("src").value !== state.src) $("src").value = state.src;
  const def = cur ? cur.def : state.crs === "custom" ? state.def : shapeLL ? crsFor(state.crs, centreOf(shapeLL)) || "" : "";
  if (document.activeElement !== $("def")) $("def").value = def || "";
  $("left-label").textContent = state.left === "warp" ? "Warped: rasterized in lon/lat, then resampled"
    : state.left === "touched" ? "All touched: GDAL ALL_TOUCHED" : "Centre in: GDAL rasterize, fasterize";
  // levels of the raster
  const sel = $("lvl");
  if (isFile && file) {
    const want = file.s.levels.map((L, i) => `${i}:${L.name}`).join("|");
    if (sel.dataset.levels !== want) {
      sel.innerHTML = "";
      const a = document.createElement("option"); a.value = "-1"; a.textContent = "Auto: the finest that fits"; sel.appendChild(a);
      file.s.levels.forEach((L, i) => {
        const o = document.createElement("option"); o.value = String(i);
        o.textContent = `${L.name}: ${L.width} x ${L.height}, tiles ${L.tileW} x ${L.tileH}`;
        sel.appendChild(o);
      });
      sel.dataset.levels = want;
    }
    sel.value = String(state.lvl >= 0 && state.lvl < file.s.levels.length ? state.lvl : -1);
    $("lvl-out").textContent = cur && cur.L ? cur.L.name : "";
  }
}

// ---------------------------------------------------------------- update

let areaTimer = 0, busy = Promise.resolve();

async function prepare(opts) {
  const key = `${state.at}|${state.detail}`;
  if (opts.shape || key !== shapeKey || !shapeLL) {
    try { shapeLL = await currentShape(); } catch (e) { shapeLL = null; setStatus(`could not load the shapes: ${e.message || e}`); }
    shapeKey = key;
  }
  if (state.crs === "file" && (opts.file || !file || file.key !== state.src.trim())) {
    fileErr = "";
    setStatus("reading the raster's header...");
    try { await loadFile(state.src); } catch (e) { file = null; fileErr = `could not read the raster: ${e.message || e}`; }
  }
}

function update(opts = {}) {
  busy = busy.then(async () => {
    await prepare(opts);
    const before = cur && `${cur.G.width}x${cur.G.height}|${cur.def}|${shapeKey}`;
    compute();
    const after = cur && `${cur.G.width}x${cur.G.height}|${cur.def}|${shapeKey}`;
    if (cur && (opts.refit || opts.shape || opts.file || before !== after || after !== fitKey || !view)) { fit(); fitKey = after; }
    if (hover && cur && (hover[0] >= cur.G.width || hover[1] >= cur.G.height)) hover = null;
    paintImages();
    drawAll();
    syncUI();
    readouts();
    pickInfo();
    if (!opts.quick || !drifting) drawInset();
    writeHash();
    clearTimeout(areaTimer);
    const c = cur;
    const measure = () => {
      if (cur !== c) return;
      c.areas = areas(c);
      readouts(); pickInfo();
      document.body.classList.add("ready");
    };
    // small grids are measured at once (so drifting shows the areas move),
    // big ones once the changes stop
    if (c && drifting && c.sum.nAny < 3000) measure();
    else if (c) areaTimer = setTimeout(measure, 60);
    if (c && c.L) fileBytes();
    if (!c) document.body.classList.add("ready");
  }).catch((e) => { setStatus(String(e && e.message || e)); console.error(e); });
  return busy;
}

// ---------------------------------------------------------------- share and boot

function copy(text, btn) {
  const done = () => { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1200); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => prompt("Copy:", text));
  else prompt("Copy:", text);
}
const pageUrl = () => location.origin + location.pathname;
$("copy-link").addEventListener("click", (e) => copy(pageUrl() + location.hash, e.target));
$("copy-embed").addEventListener("click", (e) => copy(
  `<iframe src="${pageUrl()}?embed=1${location.hash}" width="100%" height="480" style="border:0" loading="lazy" title="Rasterize: centre in and exact coverage"></iframe>`,
  e.target));
$("copy-def").addEventListener("click", (e) => copy($("def").value, e.target));

const main = $("stage");
new ResizeObserver(() => {
  main.classList.toggle("stacked", main.clientHeight > main.clientWidth);
  if (cur) { fit(); drawAll(); }
}).observe(main);

window.addEventListener("hashchange", () => { readHash(); update({ shape: true, file: state.crs === "file", refit: true }); });

if (embed) {
  document.body.classList.add("embed");
  $("open-full").hidden = false;
  $("open-full").href = pageUrl() + location.hash;
}

readHash();
syncUI();
loadShapes("110m").catch(() => {}).then(() => update({ shape: true, file: state.crs === "file", refit: true }));
