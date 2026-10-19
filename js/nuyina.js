// playproj: Nuyina.
//
// RSV Nuyina's voyages on a map: the ship's track from the AADC's underway
// service, the sea ice for the day, and the seafloor from two overlapping
// mosaics (IBCSO in its own polar stereographic, GEBCO in lon/lat) chosen
// per pixel by a plan. The map is either the fixed Antarctic EPSG:3031 or
// an azimuthal projection centred on the ship. Every source is sampled on
// its own grid: map pixel -> lon/lat -> the source's CRS -> its cells.

import * as P from "../src/core/polarstere.js";
import * as S from "../src/core/seaice.js";
import * as M from "../src/core/mosaic.js";
import * as T from "../src/core/track.js";
import * as H from "../src/core/rhumb.js";
import { isolines } from "../src/core/distortion.js";
import { loadCoastline } from "./data.js";
import { loadWorld, readWindow, loadScript } from "./basemap-load.js";
import { readParams, hashWriter, shareLinks, copyText, oneOf } from "../src/scene/index.js";

const proj4 = window.proj4, d3 = window.d3;
const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";
const GEOTIFF_JS = "https://cdn.jsdelivr.net/npm/geotiff@3.0.5/dist-browser/geotiff.js";
const HYPARQUET = "https://cdn.jsdelivr.net/npm/hyparquet@1.31.2/src/index.js";
const FZSTD = "https://cdn.jsdelivr.net/npm/fzstd@0.1.1/+esm";
// sds lists IBCSO as github.com/mdsumner/ibcso-cog/raw/main/...; that
// redirects (without CORS) to the LFS host, which is read directly
const IBCSO = "https://media.githubusercontent.com/media/mdsumner/ibcso-cog/main/IBCSO_v2_ice-surface_cog.tif";
const IBCSO_GRID = { x0: -4800000, y0: 4800000, dx: 500, dy: 500, width: 19200, height: 19200 };
const GEBCO_GRID = { x0: -180, y0: 90, dx: 1 / 240, dy: 1 / 240, width: 86400, height: 43200 };
const MAX_IMAGE = 900;     // map image pixels on the longer side
const LATTICE = 8;         // map pixels between exactly projected nodes

const ps31 = P.polarStere("EPSG:3031"), ps54 = P.polarStere("EPSG:9354");
const TO_IBCSO = P.rescale("EPSG:3031", "EPSG:9354");

const COLORS = {
  bg: "#05070d", coast: "rgba(232,240,250,0.85)", grat: "rgba(160,200,255,0.18)",
  past: "#ffd34d", future: "rgba(255,211,77,0.35)", ship: "#ff7ab8", edge: "#7fe0ff",
  place: "#f2f6fb", gc: "#c9a7ff", rhumb: "#ffb347", cells: { 1: "rgba(96,170,255,0.95)", 2: "rgba(255,170,80,0.95)", ice: "rgba(127,224,255,0.95)" }
};

// ---------------------------------------------------------------- state

const VIEW_SPAN = { ship: 3, polar: Math.log10(7000) };
const defaults = {
  v: T.VOYAGES[0].code, t: 0.3, view: "ship", proj: "laea", up: 0, span: VIEW_SPAN.ship, cx: 0, cy: 0,
  plan: "first", cut: -60, src: 0, ice: 1, cells: 0, coast: 1, rings: 1, by: "", to: "hobart", from: "wfs", pq: ""
};
const state = { ...defaults };

function readHash() {
  readParams(state, defaults, {
    v: (s) => s, view: oneOf(["ship", "polar"], "ship"), proj: oneOf(["laea", "aeqd", "stere"], "laea"),
    plan: oneOf(M.PLANS.map((p) => p.key), "first"), by: (s) => s,
    to: (s) => (s === "" || T.PLACES[s] ? s : undefined), from: oneOf(["wfs", "pq"], "wfs"), pq: (s) => s
  });
  if (!new URLSearchParams(location.hash.slice(1)).has("span")) state.span = VIEW_SPAN[state.view];
  state.t = Math.max(0, Math.min(1, state.t));
  state.span = Math.max(1, Math.min(4, state.span));
  state.cut = Math.max(-75, Math.min(-50, state.cut));
}
const writeHash = hashWriter(state, defaults, { skip: (k) => (k === "cx" || k === "cy") && state.view !== "polar" });

const voyage = () => T.VOYAGES.find((v) => v.code === state.v) || T.VOYAGES[0];

// ---------------------------------------------------------------- data

let track = null, trackKey = "", trackNote = "";
let coast = null, coast110 = null;
const ibcso = { levels: null, base: null, fine: null, pending: null, err: "" };
const gebco = { base: null, fine: null, pending: null, err: "" };
const ice = new Map();   // date -> { grid, conc } | { err }
let iceDay = "", iceShown = null;

async function geotiff() {
  if (typeof GeoTIFF === "undefined") await loadScript(GEOTIFF_JS);
  return window.GeoTIFF;
}

// IBCSO's levels, finest first, and the 8 km level read whole as a base
async function openIbcso() {
  try {
    const GT = await geotiff();
    setStatus("Reading IBCSO v2's header...");
    const tiff = await GT.fromUrl(IBCSO);
    const n = await tiff.getImageCount(), levels = [];
    for (let i = 0; i < n; i++) {
      const img = await tiff.getImage(i), width = img.getWidth();
      levels.push({ img, width, height: img.getHeight(), x0: IBCSO_GRID.x0, y0: IBCSO_GRID.y0, res: (IBCSO_GRID.dx * IBCSO_GRID.width) / width });
    }
    ibcso.levels = levels;
    const k = levels.findIndex((l) => l.width <= 1200);
    ibcso.base = await readIbcso(levels[k < 0 ? levels.length - 1 : k], null);
    setStatus("");
  } catch (e) {
    ibcso.err = `IBCSO did not load (${e.message || e})`;
    setStatus(ibcso.err);
  }
  schedule();
}

async function readIbcso(level, win) {
  win = win || [0, 0, level.width, level.height];
  const [band] = await level.img.readRasters({ window: win, samples: [0] });
  return { data: band, width: win[2] - win[0], height: win[3] - win[1], x0: level.x0 + win[0] * level.res, y0: level.y0 - win[1] * level.res, dx: level.res, dy: level.res, nodata: -32768, level: ibcso.levels.indexOf(level) };
}

async function openGebco() {
  try {
    const world = await loadWorld("gebco", setStatus);
    gebco.base = { data: world.elev, width: world.width, height: world.height, x0: -180, y0: 90, dx: 360 / world.width, dy: 180 / world.height, nodata: -32768, global: true };
    setStatus("");
  } catch (e) {
    gebco.err = `GEBCO did not load (${e.message || e})`;
    setStatus(gebco.err);
  }
  schedule();
}

// Finer windows for what the map shows, read when the map settles.
// While playing the reads are throttled (the newest need is read once the
// wait is up) rather than put off until the map stops.
let fineTimer = 0, fineNeed = null;
function wantFine(need) {
  fineNeed = need;
  if (playing && fineTimer) return;
  clearTimeout(fineTimer);
  fineTimer = setTimeout(() => { fineTimer = 0; fetchFine(fineNeed); }, playing ? 700 : 250);
}

// a request is tried once: a read that gives nothing finer (or fails) is
// not repeated for the same box
const keyOf = (n) => n.box.map((v) => v.toPrecision(5)).join(",") + "|" + n.px.toPrecision(3);

async function fetchFine(need) {
  if (ibcso.levels && ibcso.base && need.ibcso && !M.covers(ibcso.fine, need.ibcso.box, need.ibcso.px) && !ibcso.pending && ibcso.tried !== keyOf(need.ibcso)) {
    ibcso.tried = keyOf(need.ibcso);
    const { box, px } = need.ibcso, L = ibcso.levels;
    const k = M.chooseLevel(L, px, box[2] - box[0], box[3] - box[1], 1600);
    const win = M.windowOf(L[k], box, 3);
    if (win && L[k].res < ibcso.base.dx) {
      ibcso.pending = readIbcso(L[k], win).then((w) => { ibcso.fine = w; }).catch((e) => { ibcso.err = `IBCSO window failed (${e.message || e})`; })
        .finally(() => { ibcso.pending = null; schedule(); });
    }
  }
  if (gebco.base && need.gebco && !M.covers(gebco.fine, need.gebco.box, need.gebco.px) && !gebco.pending && gebco.tried !== keyOf(need.gebco)) {
    gebco.tried = keyOf(need.gebco);
    const { box, px } = need.gebco;
    if (px < gebco.base.dx) {
      gebco.pending = readWindow("gebco", { west: box[0], east: box[2], south: box[1], north: box[3] }, px)
        .then((w) => {
          if (!w.global) gebco.fine = { data: w.elev, width: w.width, height: w.height, x0: w.west, y0: w.north, dx: w.dx, dy: w.dy, nodata: -32768 };
        })
        .catch(() => {}).finally(() => { gebco.pending = null; schedule(); });
    }
  }
}

// The sea ice of one UTC day, read once.
function loadIce(day) {
  if (ice.has(day)) return ice.get(day);
  const p = (async () => {
    const GT = await geotiff();
    const tiff = await GT.fromUrl(S.nsidcUrl(day));
    const img = await tiff.getImage();
    const [band] = await img.readRasters({ samples: [0] });
    const bits = band.BYTES_PER_ELEMENT === 1 ? 8 : 16;
    let origin = null, resolution = null;
    try { origin = img.getOrigin(); resolution = img.getResolution(); } catch (e) { /* no georeferencing */ }
    const epsg = img.geoKeys && img.geoKeys.ProjectedCSTypeGeoKey;
    const grid = S.gridOf({ width: img.getWidth(), height: img.getHeight(), origin, resolution, epsg: P.fromEpsg(epsg) ? epsg : null });
    if (!grid || !P.CRS[grid.crs]) throw new Error("not on a known sea ice grid");
    const conc = new Float32Array(band.length);
    for (let i = 0; i < band.length; i++) { const c = S.decode(band[i], bits); conc[i] = c === null ? NaN : c; }
    return { day, grid, ps: P.polarStere(grid.crs), raw: band, bits, win: { data: conc, width: grid.width, height: grid.height, x0: grid.x0, y0: grid.y0, dx: grid.dx, dy: grid.dy, nodata: NaN } };
  })().catch((e) => ({ day, err: e.message || String(e) }));
  ice.set(day, p);
  p.then((r) => { if (r.day === iceDay) { iceShown = r; schedule(); } });
  return p;
}

// The track: the CSV header first (one row), to learn the column names,
// then only time, place and the colour column.
async function loadTrack() {
  const v = voyage(), key = `${v.code}|${state.by}|${state.from}|${state.pq}|${pqLocal ? pqLocal.name : ""}`;
  if (key === trackKey) return;
  trackKey = key;
  try {
    if (state.from === "pq") {
      const url = state.pq || T.PARQUET;
      $("csv-link").href = url;
      setTrackStatus(`Reading voyage ${v.label} from the parquet copy...`);
      const pq = pqLocal || await parquetAt(url);
      const tr = await readParquet(pq, v);
      if (trackKey !== key) return;
      track = tr; trackNote = pqLocal ? `from ${pqLocal.name}` : "";
    } else {
      $("csv-link").href = T.wfsUrl(v.code);
      setTrackStatus(`Asking the AADC for voyage ${v.label}...`);
      const head = await fetchText(T.wfsUrl(v.code, { max: 1 }));
      const rows = T.parseCSV(head);
      if (rows.length < 1) throw new Error("no rows");
      const cols = T.detectColumns(rows[0]);
      const names = [cols.time, cols.lon, cols.lat, cols.geom].filter((i) => i >= 0).map((i) => rows[0][i]);
      if (state.by && rows[0].includes(state.by)) names.push(state.by);
      setTrackStatus(`Reading voyage ${v.label}, one fix a minute...`);
      const text = await fetchText(T.wfsUrl(v.code, { props: names.filter((n) => n !== "FID") }));
      const tr = T.trackFromCSV(text, state.by);
      tr.numeric = T.numericColumns(rows, cols);
      if (trackKey !== key) return;
      track = tr; trackNote = "";
    }
    setTrackStatus("");
    $("track-file").hidden = true;
  } catch (e) {
    if (trackKey !== key) return;
    track = T.portsOfCall(v);
    trackNote = "schematic";
    const why = e.message || e;
    setTrackStatus(state.from === "pq"
      ? `The parquet copy could not be read from this page (${why}). GitHub's release downloads send no CORS header, so a page on another site cannot read them: download the file and load it here, or give a copy that allows it as pq= in the link. Shown instead: the ports of call joined by great circles, which is not the ship's track.`
      : `The AADC underway service did not answer this page (${why}). Shown instead: the ports of call joined by great circles, which is not the ship's track. The CSV can be downloaded and loaded here.`);
    $("track-file").hidden = false;
  }
  fillBy();
  schedule();
}

// The parquet copy: its footer once, then for each voyage only the row
// groups its dates fall in, and of those only the columns drawn.
let pqLocal = null;   // a parquet file loaded from disk
const pqByUrl = new Map();
function parquetAt(url) {
  if (!pqByUrl.has(url)) pqByUrl.set(url, openParquet(url).catch((e) => { pqByUrl.delete(url); throw e; }));
  return pqByUrl.get(url);
}
async function openParquet(src) {
  const hp = await import(HYPARQUET);
  const raw = typeof src === "string" ? await hp.asyncBufferFromUrl({ url: src })
    : { byteLength: src.size, slice: (a, b) => src.slice(a, b).arrayBuffer() };
  const file = hp.cachedAsyncBuffer(raw);
  const md = await hp.parquetMetadataAsync(file);
  const skip = new Set(["latitude", "longitude", "xmin", "ymin", "xmax", "ymax"]);
  const numeric = md.schema.filter((c) => c.type === "DOUBLE" && !skip.has(c.name)).map((c) => c.name);
  return { hp, file, md, numeric, name: typeof src === "string" ? "" : src.name };
}

async function readParquet(pq, v) {
  const { hp, file, md, numeric } = pq;
  const { decompress } = await import(FZSTD);
  const stat = (g) => { const c = g.columns.find((k) => k.meta_data.path_in_schema[0] === "datetime"); return c && c.meta_data.statistics; };
  const groups = md.row_groups.map((g) => { const st = stat(g); return { rows: Number(g.num_rows), min: st ? Number(st.min_value) : -Infinity, max: st ? Number(st.max_value) : Infinity }; });
  const ranges = T.rowRanges(groups, Date.parse(v.from) - 3 * 864e5, Date.parse(v.to) + 4 * 864e5);
  const by = numeric.includes(state.by) ? state.by : "";
  const columns = ["datetime", "longitude", "latitude", "set_code", ...(by ? [by] : [])];
  const rows = [];
  for (const r of ranges) {
    await hp.parquetRead({ file, metadata: md, columns, ...r, compressors: { ZSTD: (input) => decompress(input) }, onComplete: (d) => { for (const x of d) rows.push(x); } });
  }
  return T.trackFromRows(rows, v, { by, numeric, columns: md.schema.map((c) => c.name) });
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

$("csv-btn").addEventListener("click", () => $("csv").click());
$("csv").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    if (/\.parquet$/i.test(f.name)) {
      // keep the file, so another voyage reads from it too
      setTrackStatus(`Reading ${f.name}...`);
      pqLocal = await openParquet(f);
      state.from = "pq";
      trackKey = "";
      await loadTrack();
      return;
    }
    track = T.trackFromCSV(await f.text(), state.by);
    trackNote = `from ${f.name}`;
    setTrackStatus("");
  } catch (err) { setTrackStatus(`could not read ${f.name}: ${err.message || err}`); }
  fillBy();
  schedule();
});

// ---------------------------------------------------------------- the view

const canvas = $("map"), img = document.createElement("canvas");
let view = null;

function shipAt() {
  if (!track) return null;
  return T.at(track, track.start + state.t * (track.end - track.start));
}

function makeView() {
  const cssW = canvas.clientWidth || 800, cssH = canvas.clientHeight || 600;
  const span = 10 ** state.span * 1000, mpp = span / cssW;
  const ship = shipAt();
  let fwd, inv, def, cx = 0, cy = 0, rot = 0, label;
  if (state.view === "polar" || !ship) {
    fwd = (lon, lat) => ps31.forward(lon, lat);
    inv = (x, y) => ps31.inverse(x, y);
    def = ps31.proj; cx = state.cx * 1000; cy = state.cy * 1000;
    label = "EPSG:3031, Antarctic polar stereographic";
  } else {
    def = `+proj=${state.proj} +lat_0=${ship.lat.toFixed(5)} +lon_0=${ship.lon.toFixed(5)} +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs`;
    const p = proj4("EPSG:4326", def);
    fwd = (lon, lat) => p.forward([lon, lat]);
    // proj4js 2.12.1's ellipsoidal aeqd inverse gives latitude + 180 in
    // the south; fold it back (test/check-nuyina.mjs checks against PROJ)
    inv = (x, y) => {
      const ll = p.inverse([x, y]);
      if (ll[1] > 90) ll[1] -= 180; else if (ll[1] < -90) ll[1] += 180;
      return ll;
    };
    if (state.up && ship.heading !== null) rot = ship.heading * Math.PI / 180;
    label = `${state.proj} centred on the ship${rot ? ", heading up" : ", north up"}`;
  }
  const c = Math.cos(rot), s = Math.sin(rot);
  return {
    cssW, cssH, mpp, def, label, ship, rot, fwd, inv,
    toMap(sx, sy) {
      const dx = (sx - cssW / 2) * mpp, dy = (cssH / 2 - sy) * mpp;
      return [cx + dx * c + dy * s, cy - dx * s + dy * c];
    },
    toScreen(x, y) {
      const ux = x - cx, uy = y - cy;
      return [cssW / 2 + (ux * c - uy * s) / mpp, cssH / 2 - (ux * s + uy * c) / mpp];
    },
    project(lon, lat) {
      const q = fwd(lon, lat);
      if (!q || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) return null;
      return this.toScreen(q[0], q[1]);
    },
    unproject(sx, sy) {
      const q = this.toMap(sx, sy), ll = inv(q[0], q[1]);
      return ll && Number.isFinite(ll[0]) && Number.isFinite(ll[1]) ? ll : null;
    }
  };
}

// ---------------------------------------------------------------- the map image

let frame = null;   // what the last render sampled, for the readouts

function renderImage(v) {
  const q = Math.min(1, (playing ? 600 : MAX_IMAGE) / Math.max(v.cssW, v.cssH));
  const W = Math.max(2, Math.round(v.cssW * q)), H = Math.max(2, Math.round(v.cssH * q));
  // exactly projected lattice, in the hub CRS (EPSG:3031)
  const nx = Math.ceil(W / LATTICE) + 1, ny = Math.ceil(H / LATTICE) + 1;
  const hx = new Float64Array(nx * ny), hy = new Float64Array(nx * ny);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  let lonMin = Infinity, lonMax = -Infinity, latMin = 90, latMax = -90, anyPole = false;
  const lon0 = v.ship && state.view === "ship" ? v.ship.lon : 0;
  for (let b = 0; b < ny; b++) {
    for (let a = 0; a < nx; a++) {
      const k = b * nx + a, ll = v.unproject((a * LATTICE) / q, (b * LATTICE) / q);
      if (!ll || ll[1] > 0) { hx[k] = hy[k] = NaN; continue; }
      const [x, y] = ps31.forward(ll[0], ll[1]);
      hx[k] = x; hy[k] = y;
      bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y);
      const lu = lon0 + ((((ll[0] - lon0 + 180) % 360) + 360) % 360) - 180;
      lonMin = Math.min(lonMin, lu); lonMax = Math.max(lonMax, lu);
      latMin = Math.min(latMin, ll[1]); latMax = Math.max(latMax, ll[1]);
    }
  }
  // the pole in view: every longitude
  const pole = v.toScreen(...v.fwd(0, -90) || [NaN, NaN]);
  if (pole && pole[0] >= 0 && pole[0] <= v.cssW && pole[1] >= 0 && pole[1] <= v.cssH) anyPole = true;
  if (anyPole || lonMax - lonMin > 300) { lonMin = -180; lonMax = 180; latMin = -90; }

  const pxM = v.mpp / q;
  const need = {
    ibcso: Number.isFinite(bx0) ? { box: [bx0 * TO_IBCSO, by0 * TO_IBCSO, bx1 * TO_IBCSO, by1 * TO_IBCSO], px: pxM } : null,
    gebco: Number.isFinite(lonMin) ? { box: [lonMin, latMin, lonMax, Math.min(0, latMax)], px: pxM / 111320 } : null
  };
  wantFine(need);
  const w1 = ibcso.fine && need.ibcso && M.covers(ibcso.fine, need.ibcso.box, Infinity) ? ibcso.fine : ibcso.base;
  const w2 = gebco.fine && need.gebco && M.covers(gebco.fine, need.gebco.box, Infinity) ? gebco.fine : gebco.base;
  const iceW = state.ice && iceShown && !iceShown.err ? iceShown : null;

  const N = W * H;
  const elev = new Float32Array(N), src = new Uint8Array(N), lat = new Float32Array(N), conc = new Float32Array(N);
  const d1 = new Float32Array(N), d2 = new Float32Array(N);
  for (let j = 0; j < H; j++) {
    const fb = j / LATTICE, b = Math.min(ny - 2, Math.floor(fb)), tv = fb - b;
    for (let i = 0; i < W; i++) {
      const fa = i / LATTICE, a = Math.min(nx - 2, Math.floor(fa)), tu = fa - a;
      const k0 = b * nx + a, k = j * W + i;
      const x = (hx[k0] * (1 - tu) + hx[k0 + 1] * tu) * (1 - tv) + (hx[k0 + nx] * (1 - tu) + hx[k0 + nx + 1] * tu) * tv;
      const y = (hy[k0] * (1 - tu) + hy[k0 + 1] * tu) * (1 - tv) + (hy[k0 + nx] * (1 - tu) + hy[k0 + nx + 1] * tu) * tv;
      if (!Number.isFinite(x) || !Number.isFinite(y)) { elev[k] = NaN; lat[k] = NaN; conc[k] = NaN; d1[k] = d2[k] = NaN; continue; }
      const [lo, la] = ps31.inverse(x, y);
      lat[k] = la;
      const e1 = M.sample(w1, x * TO_IBCSO, y * TO_IBCSO);
      const e2 = w2 ? M.sample(w2, w2.global ? lo : w2.x0 + ((((lo - w2.x0) % 360) + 360) % 360), la) : NaN;
      d1[k] = e1; d2[k] = e2;
      const s = M.pick(state.plan, la, Number.isFinite(e1), Number.isFinite(e2), state.cut);
      src[k] = s;
      elev[k] = s === 1 ? e1 : s === 2 ? e2 : s === 3 ? e1 - e2 : NaN;
      if (iceW) {
        const [ix, iy] = iceW.ps.forward(lo, la);
        // sea ice only on the sea
        conc[k] = elev[k] > 0 && s !== 3 ? NaN : M.sampleValid(iceW.win, ix, iy);
      } else conc[k] = NaN;
    }
  }
  const mode = state.plan === "diff" ? "diff" : state.src ? "source" : "relief";
  const rgba = M.shade(elev, src, lat, W, H, pxM, mode, 100);
  // the ice is drawn over relief only; over the source or difference map
  // just its edge, so the plan stays readable
  if (iceW && mode === "relief") for (let k = 0; k < N; k++) if (Number.isFinite(conc[k])) S.iceColour(conc[k], rgba, k * 4);
  img.width = W; img.height = H;
  img.getContext("2d").putImageData(new ImageData(rgba, W, H), 0, 0);
  const edge = iceW ? isolines(conc, W, H, 0.15) : [];
  frame = { q, W, H, w1, w2, iceW, edge, d1, d2, conc, src };
}

// ---------------------------------------------------------------- vectors

function polyline(ctx, v, pts, n, get) {
  let on = false, px = 0, py = 0;
  const jump = Math.max(v.cssW, v.cssH);
  for (let i = 0; i < n; i++) {
    const [lon, lat] = get(pts, i);
    const p = v.project(lon, lat);
    if (!p || Math.abs(p[0]) > 1e5 || Math.abs(p[1]) > 1e5) { on = false; continue; }
    if (on && Math.hypot(p[0] - px, p[1] - py) < jump) ctx.lineTo(p[0], p[1]);
    else ctx.moveTo(p[0], p[1]);
    on = true; px = p[0]; py = p[1];
  }
}
const flat = (a, i) => [a[2 * i], a[2 * i + 1]];

let gratLines = null;
function graticuleLines() {
  if (gratLines) return gratLines;
  gratLines = [];
  for (let lon = -180; lon < 180; lon += 30) { const l = []; for (let lat = -90; lat <= -30; lat += 0.5) l.push(lon, lat); gratLines.push(l); }
  for (let lat = -80; lat <= -40; lat += 10) { const l = []; for (let lon = -180; lon <= 180; lon += 0.5) l.push(lon, lat); gratLines.push(l); }
  return gratLines;
}

// a point d km from lon, lat on bearing (degrees), on the sphere
function ahead(lon, lat, brg, km) {
  const R = 6371.0088, d = km / R, b = brg * Math.PI / 180, p = lat * Math.PI / 180, l = lon * Math.PI / 180;
  const p2 = Math.asin(Math.sin(p) * Math.cos(d) + Math.cos(p) * Math.sin(d) * Math.cos(b));
  const l2 = l + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p), Math.cos(d) - Math.sin(p) * Math.sin(p2));
  return [l2 * 180 / Math.PI, p2 * 180 / Math.PI];
}

function valueRange() {
  if (!track || !track.by) return null;
  const vals = Array.from(track.value).filter(Number.isFinite).sort((a, b) => a - b);
  if (vals.length < 2) return null;
  return [vals[Math.floor(vals.length * 0.02)], vals[Math.floor(vals.length * 0.98)]];
}

// a perceptually even ramp (dark blue -> teal -> yellow) for track values
function rampColour(t) {
  const stops = [[0, 68, 1, 84], [0.25, 59, 82, 139], [0.5, 33, 145, 140], [0.75, 94, 201, 98], [1, 253, 231, 37]];
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
    const [t0, r0, g0, b0] = stops[i - 1], [t1, r1, g1, b1] = stops[i], f = (t - t0) / (t1 - t0);
    return `rgb(${Math.round(r0 + f * (r1 - r0))},${Math.round(g0 + f * (g1 - g0))},${Math.round(b0 + f * (b1 - b0))})`;
  }
  return "rgb(253,231,37)";
}

function drawTrack(ctx, v) {
  if (!track) return;
  const idx = T.thin(track, 8000), ship = v.ship, cut = ship ? ship.i : track.n;
  const range = valueRange();
  const get = (a, i) => [track.lon[a[i]], track.lat[a[i]]];
  const future = idx.filter((i) => i >= cut), past = idx.filter((i) => i <= cut + 1);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.setLineDash(track.schematic ? [6, 5] : []);
  ctx.beginPath(); polyline(ctx, v, future, future.length, get);
  ctx.strokeStyle = COLORS.future; ctx.lineWidth = 1.5; ctx.stroke();
  if (range) {
    // past track coloured by value, in runs of one colour bin
    const bins = 24;
    let run = [], bin = -1;
    const flush = () => {
      if (run.length > 1) { ctx.beginPath(); polyline(ctx, v, run, run.length, get); ctx.strokeStyle = rampColour((bin + 0.5) / bins); ctx.lineWidth = 3; ctx.stroke(); }
    };
    for (const i of past) {
      const val = track.value[i];
      const b = Number.isFinite(val) ? Math.max(0, Math.min(bins - 1, Math.floor(((val - range[0]) / (range[1] - range[0])) * bins))) : -2;
      if (b !== bin) { const last = run[run.length - 1]; flush(); run = last !== undefined ? [last] : []; bin = b; }
      run.push(i);
    }
    flush();
  } else {
    ctx.beginPath(); polyline(ctx, v, past, past.length, get);
    ctx.strokeStyle = COLORS.past; ctx.lineWidth = 2.2; ctx.stroke();
  }
  ctx.setLineDash([]);
  if (!ship) return;
  const p = v.project(ship.lon, ship.lat);
  if (!p) return;
  let ang = 0;
  if (ship.heading !== null) {
    const a2 = ahead(ship.lon, ship.lat, ship.heading, 2), p2 = v.project(a2[0], a2[1]);
    if (p2) ang = Math.atan2(p2[0] - p[0], -(p2[1] - p[1]));
  }
  ctx.save(); ctx.translate(p[0], p[1]); ctx.rotate(ang);
  ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(6.5, 8); ctx.lineTo(0, 4.5); ctx.lineTo(-6.5, 8); ctx.closePath();
  ctx.fillStyle = COLORS.ship; ctx.fill(); ctx.strokeStyle = "#05070d"; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.restore();
}

function drawPlaces(ctx, v) {
  ctx.font = "12px system-ui, sans-serif"; ctx.textBaseline = "middle";
  for (const pl of Object.values(T.PLACES)) {
    const p = v.project(pl.lon, pl.lat);
    if (!p || p[0] < -50 || p[1] < -20 || p[0] > v.cssW + 50 || p[1] > v.cssH + 20) continue;
    ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, 2 * Math.PI); ctx.fillStyle = COLORS.place; ctx.fill();
    ctx.strokeStyle = "#05070d"; ctx.lineWidth = 3; ctx.strokeText(pl.name, p[0] + 6, p[1]);
    ctx.fillText(pl.name, p[0] + 6, p[1]);
  }
}

// Each source's own cells round the ship, where they are big enough to see.
function cellGrids(v) {
  const g = [
    { key: 1, name: "IBCSO", grid: IBCSO_GRID, size: IBCSO_GRID.dx, to: (lon, lat) => ps54.forward(lon, lat), from: (x, y) => ps54.inverse(x, y) },
    { key: 2, name: "GEBCO", grid: GEBCO_GRID, size: GEBCO_GRID.dy * 111320, to: (lon, lat) => [lon, lat], from: (x, y) => [x, y] }
  ];
  const iceG = iceShown && !iceShown.err ? iceShown : null;
  const grid = iceG ? iceG.grid : S.SOUTH, ps = iceG ? iceG.ps : P.polarStere(S.SOUTH.crs);
  g.push({ key: "ice", name: "Sea ice", grid, size: grid.dx, to: (lon, lat) => ps.forward(lon, lat), from: (x, y) => ps.inverse(x, y) });
  for (const s of g) s.px = s.size / v.mpp;
  return g;
}

function drawCells(ctx, v) {
  const ship = v.ship;
  if (!state.cells || !ship) return;
  for (const s of cellGrids(v)) {
    if (s.px < 5) continue;
    const n = Math.max(1, Math.min(14, Math.floor((Math.min(v.cssW, v.cssH) * 0.3) / s.px)));
    const [x, y] = s.to(ship.lon, ship.lat);
    const L = M.gridLines(s.grid, x, y, n, 200);
    if (!L) continue;
    ctx.beginPath();
    const dens = 12;
    const line = (pts) => polyline(ctx, v, pts, pts.length, (a, i) => s.from(a[i][0], a[i][1]));
    const x0 = L.xs[0], x1 = L.xs[L.xs.length - 1], y0 = L.ys[0], y1 = L.ys[L.ys.length - 1];
    for (const xx of L.xs) line(Array.from({ length: dens + 1 }, (_, k) => [xx, y0 + ((y1 - y0) * k) / dens]));
    for (const yy of L.ys) line(Array.from({ length: dens + 1 }, (_, k) => [x0 + ((x1 - x0) * k) / dens, yy]));
    ctx.strokeStyle = COLORS.cells[s.key]; ctx.lineWidth = s.key === "ice" ? 1.6 : 1; ctx.globalAlpha = 0.8; ctx.stroke(); ctx.globalAlpha = 1;
  }
}

// text with a dark edge, readable over ice and sea
function halo(ctx, text, x, y, fill) {
  ctx.strokeStyle = "rgba(5,7,13,0.85)"; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.strokeText(text, x, y);
  ctx.fillStyle = fill; ctx.fillText(text, x, y);
}

// Circles of true distance round the ship (geodesics on the sphere, drawn
// through the projection): round in aeqd, where distance from the centre is
// true, and pulled out of round in a map centred elsewhere.
function ringRadii(v) {
  const r = (Math.min(v.cssW, v.cssH) * 0.42 * v.mpp) / 1000, p = 10 ** Math.floor(Math.log10(r / 2));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => r / x <= 4) || p * 10;
  const out = [];
  for (let d = step; d <= r * 1.6 && out.length < 6; d += step) out.push(d);
  return out;
}

function drawRings(ctx, v) {
  const ship = v.ship;
  if (!state.rings || !ship) return;
  ctx.font = "11px system-ui, sans-serif"; ctx.textBaseline = "bottom";
  for (const km of ringRadii(v)) {
    const pts = [];
    for (let b = 0; b <= 360; b += 3) pts.push(ahead(ship.lon, ship.lat, b, km));
    ctx.beginPath(); polyline(ctx, v, pts, pts.length, (a, i) => a[i]);
    ctx.strokeStyle = "rgba(255,122,184,0.55)"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    const lab = v.project(...ahead(ship.lon, ship.lat, (v.rot * 180) / Math.PI, km));
    if (lab) halo(ctx, `${km.toLocaleString("en")} km`, lab[0] + 4, lab[1] - 2, "rgba(255,190,220,0.95)");
  }
}

// Crow lines from the ship to a place: the great circle and the rhumb line
// (src/core/rhumb.js), recomputed as the ship moves.
function crow(v) {
  const ship = v.ship, tg = T.PLACES[state.to];
  if (!ship || !tg) return null;
  return {
    tg, c: H.compare(ship.lon, ship.lat, tg.lon, tg.lat),
    gc: H.greatCirclePoints(ship.lon, ship.lat, tg.lon, tg.lat, 128),
    rh: H.rhumbPoints(ship.lon, ship.lat, tg.lon, tg.lat, 256)
  };
}

function drawCrow(ctx, v, cr) {
  if (!cr) return;
  const get = (a, i) => a[i];
  ctx.lineCap = "round";
  ctx.beginPath(); polyline(ctx, v, cr.rh, cr.rh.length, get);
  ctx.strokeStyle = COLORS.rhumb; ctx.lineWidth = 1.8; ctx.setLineDash([7, 5]); ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); polyline(ctx, v, cr.gc, cr.gc.length, get);
  ctx.strokeStyle = COLORS.gc; ctx.lineWidth = 1.8; ctx.stroke();
}

// What is near the ship: the closest ice edge (15 percent) on today's map,
// and the closest station or place, as distance and bearing.
function nearest(v) {
  const ship = v.ship, out = {};
  if (!ship) return out;
  let best = Infinity, bl = null;
  for (const pl of Object.values(T.PLACES)) {
    const d = T.greatCircle(ship.lon, ship.lat, pl.lon, pl.lat);
    if (d < best) { best = d; bl = pl; }
  }
  if (bl) out.place = { name: bl.name, km: best, brg: T.bearing(ship.lon, ship.lat, bl.lon, bl.lat) };
  if (frame && frame.edge.length) {
    const e = frame.edge, s = 1 / frame.q;
    let bd = Infinity, bp = null;
    for (let i = 0; i < e.length; i += 8) {
      const ll = v.unproject(e[i] * s, e[i + 1] * s);
      if (!ll) continue;
      const d = T.greatCircle(ship.lon, ship.lat, ll[0], ll[1]);
      if (d < bd) { bd = d; bp = ll; }
    }
    if (bp) out.edge = { km: bd, brg: T.bearing(ship.lon, ship.lat, bp[0], bp[1]), inIce: Number.isFinite(depthAt(ship.lon, ship.lat).c) && depthAt(ship.lon, ship.lat).c >= 0.15 };
  }
  return out;
}

function drawScale(ctx, v) {
  const target = v.cssW * 0.22 * v.mpp / 1000, p = 10 ** Math.floor(Math.log10(target));
  const km = [1, 2, 5, 10].map((m) => m * p).filter((x) => x <= target).pop() || p;
  const len = (km * 1000) / v.mpp, x = 16, y = v.cssH - 18;
  ctx.strokeStyle = "rgba(5,7,13,0.85)"; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 5); ctx.stroke();
  ctx.strokeStyle = "#f2f6fb"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 5); ctx.stroke();
  ctx.font = "12px system-ui, sans-serif"; ctx.textBaseline = "bottom";
  halo(ctx, `${km.toLocaleString("en")} km${state.view === "polar" ? " (true at 71" + DEG + "S)" : ""}`, x, y - 6, "#f2f6fb");
}

function drawAll() {
  const v = view, ctx = canvas.getContext("2d"), dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(v.cssW * dpr); canvas.height = Math.round(v.cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, v.cssW, v.cssH);
  ctx.imageSmoothingEnabled = true;
  if (frame) ctx.drawImage(img, 0, 0, v.cssW, v.cssH);
  ctx.beginPath();
  for (const l of graticuleLines()) polyline(ctx, v, l, l.length / 2, flat);
  ctx.strokeStyle = COLORS.grat; ctx.lineWidth = 1; ctx.stroke();
  if (state.coast && coast) {
    ctx.beginPath();
    for (const l of coast) polyline(ctx, v, l, l.length / 2, flat);
    ctx.strokeStyle = COLORS.coast; ctx.lineWidth = 1; ctx.stroke();
  }
  if (frame && frame.edge.length) {
    const e = frame.edge, s = 1 / frame.q;
    ctx.beginPath();
    for (let i = 0; i < e.length; i += 4) { ctx.moveTo(e[i] * s, e[i + 1] * s); ctx.lineTo(e[i + 2] * s, e[i + 3] * s); }
    ctx.strokeStyle = COLORS.edge; ctx.lineWidth = 1.3; ctx.stroke();
  }
  drawCells(ctx, v);
  drawRings(ctx, v);
  drawCrow(ctx, v, crow(v));
  drawPlaces(ctx, v);
  drawTrack(ctx, v);
  drawScale(ctx, v);
  $("map-label").textContent = v.label;
}

// ---------------------------------------------------------------- readouts

function depthAt(lon, lat) {
  const f = frame;
  if (!f) return {};
  const [x, y] = ps31.forward(lon, lat);
  const e1 = M.sample(f.w1, x * TO_IBCSO, y * TO_IBCSO);
  const w2 = f.w2;
  const e2 = w2 ? M.sample(w2, w2.global ? lon : w2.x0 + ((((lon - w2.x0) % 360) + 360) % 360), lat) : NaN;
  let c = NaN, cell = null, raw = null;
  if (f.iceW) {
    const [ix, iy] = f.iceW.ps.forward(lon, lat);
    c = M.sample(f.iceW.win, ix, iy);
    cell = S.cellOf(f.iceW.grid, ix, iy);
    if (cell) raw = f.iceW.raw[cell[1] * f.iceW.grid.width + cell[0]];
  }
  return { e1, e2, c, cell, raw };
}

const m = (z) => (Number.isFinite(z) ? `${Math.round(z).toLocaleString("en")} m` : "no data");
const fmtLL = (lon, lat) => `${Math.abs(lat).toFixed(3)}${DEG}${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(3)}${DEG}${lon < 0 ? "W" : "E"}`;
const fmtTime = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";

function readouts() {
  const v = view, ship = v && v.ship, rows = [];
  if (ship) {
    rows.push(["Time", fmtTime(ship.time)]);
    rows.push(["Ship", fmtLL(ship.lon, ship.lat)]);
    rows.push(["Course, speed", ship.heading === null ? "stopped" : `${Math.round(ship.heading)}${DEG}, ${ship.knots.toFixed(1)} kn`]);
    rows.push(["Distance run", `${Math.round(ship.dist).toLocaleString("en")} km`]);
    if (track && track.by) rows.push([track.by, Number.isFinite(ship.value) ? String(+ship.value.toFixed(3)) : "no value"]);
    const d = depthAt(ship.lon, ship.lat);
    rows.push(["IBCSO under the ship", m(d.e1)]);
    rows.push(["GEBCO under the ship", m(d.e2)]);
    if (Number.isFinite(d.e1) && Number.isFinite(d.e2)) rows.push(["IBCSO minus GEBCO", m(d.e1 - d.e2)]);
    const flag = d.raw !== null && d.raw !== undefined ? S.flagOf(d.raw, frame.iceW.bits) : "";
    rows.push([`Sea ice, ${iceDay}`, frame && frame.iceW ? (flag || (Number.isFinite(d.c) ? `${Math.round(d.c * 100)} percent` : "no data")) : iceShown && iceShown.err ? "did not load" : state.ice ? "loading" : "off"]);
    const near = nearest(v);
    if (near.place) rows.push([`Nearest place`, `${near.place.name}, ${Math.round(near.place.km).toLocaleString("en")} km at ${Math.round(near.place.brg)}${DEG}`]);
    const cr = crow(v);
    if (cr) {
      const g = cr.c.geodesic, r = cr.c.rhumb, k = (x) => `${Math.round(x / 1000).toLocaleString("en")} km`;
      rows.push([`<span style="color:${COLORS.gc}">Great circle to ${cr.tg.name}</span>`, `${k(g.s)}, course ${Math.round(g.azi1)}${DEG}`]);
      rows.push([`<span style="color:${COLORS.rhumb}">Rhumb line to ${cr.tg.name}</span>`, `${k(r.s)}, course ${Math.round(r.azi)}${DEG}, ${(cr.c.extra * 100).toFixed(1)} percent longer`]);
      const f = (x) => +x.toFixed(4);
      rows.push(["", `<a href="./rhumb.html#alon=${f(ship.lon)}&alat=${f(ship.lat)}&blon=${f(cr.tg.lon)}&blat=${f(cr.tg.lat)}">Both on four maps</a>`]);
    }
    if (track && !track.schematic) {
      const s0 = H.geodesicInverse(track.lon[0], track.lat[0], ship.lon, ship.lat).s / 1000;
      if (s0 > 1) rows.push(["Run so far, and the great circle from the start", `${Math.round(ship.dist).toLocaleString("en")} km, ${Math.round(s0).toLocaleString("en")} km: ${((ship.dist / s0 - 1) * 100).toFixed(0)} percent more`]);
    }
    if (near.edge) rows.push([near.edge.inIce ? "Open water (ice under 15 percent)" : "Ice edge (15 percent)", `${Math.round(near.edge.km).toLocaleString("en")} km at ${Math.round(near.edge.brg)}${DEG}, on this map`]);
    // the same place as a cell of each grid
    const [ix, iy] = ps54.forward(ship.lon, ship.lat);
    const c1 = M.cellIndex(IBCSO_GRID, ix, iy), c2 = M.cellIndex(GEBCO_GRID, ship.lon, ship.lat);
    rows.push(["IBCSO cell (500 m)", c1 ? `${c1[0]}, ${c1[1]}` : "outside"]);
    rows.push(["GEBCO cell (15\")", c2 ? `${c2[0]}, ${c2[1]}` : "outside"]);
    if (d.cell) rows.push(["Sea ice cell (25 km)", `${d.cell[0]}, ${d.cell[1]}`]);
  }
  $("ship").innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("");
}

function drawLegend() {
  const c = $("legend"), ctx = c.getContext("2d"), w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  ctx.font = "20px system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.fillStyle = "#8a97ab";
  if (state.plan === "diff") {
    for (let i = 0; i < w; i++) {
      const t = (i / (w - 1)) * 2 - 1, a = Math.abs(t), col = t < 0 ? [40, 110, 230] : [230, 70, 50];
      ctx.fillStyle = `rgb(${236 + (col[0] - 236) * a},${236 + (col[1] - 236) * a},${236 + (col[2] - 236) * a})`;
      ctx.fillRect(i, 0, 1, 12);
    }
    ctx.fillStyle = "#8a97ab"; ctx.fillText("IBCSO deeper by 100 m", 0, 25); ctx.textAlign = "right"; ctx.fillText("shallower by 100 m", w, 25); ctx.textAlign = "left";
  } else if (state.src) {
    const items = [[1, "IBCSO"], [2, "GEBCO"]];
    items.forEach(([k, name], n) => {
      const rgb = M.SOURCE_RGB[k];
      ctx.fillStyle = `rgb(${rgb})`; ctx.fillRect(n * 180, 4, 26, 18);
      ctx.fillStyle = "#c4cedb"; ctx.fillText(name, n * 180 + 34, 14);
    });
  } else {
    const out = new Uint8ClampedArray(4);
    for (let i = 0; i < w; i++) {
      const z = -6000 + (i / (w - 1)) * 9000;
      M.tint(z, -70, out, 0);
      ctx.fillStyle = `rgb(${out[0]},${out[1]},${out[2]})`; ctx.fillRect(i, 0, 1, 12);
    }
    ctx.fillStyle = "#8a97ab"; ctx.fillText("-6000 m", 0, 25); ctx.textAlign = "center"; ctx.fillText("0", w * 6 / 9, 25);
    ctx.textAlign = "right"; ctx.fillText("3000 m ice", w, 25); ctx.textAlign = "left";
  }
}

// ---------------------------------------------------------------- inset globe

function drawInset() {
  const cv = $("inset"), ctx = cv.getContext("2d"), w = cv.width, h = cv.height, v = view;
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, w, h);
  if (!d3 || !v) return;
  const lon = v.ship ? v.ship.lon : 110;
  const proj = d3.geoOrthographic().rotate([-lon, 60]).fitExtent([[10, 10], [w - 10, h - 10]], { type: "Sphere" });
  const path = d3.geoPath(proj, ctx);
  ctx.beginPath(); path({ type: "Sphere" }); ctx.fillStyle = "#0b1426"; ctx.fill();
  ctx.beginPath(); path(d3.geoGraticule10()); ctx.strokeStyle = "rgba(140,196,255,0.15)"; ctx.lineWidth = 1; ctx.stroke();
  const pairs = (r) => { const o = []; for (let i = 0; i < r.length; i += 2) o.push([r[i], r[i + 1]]); return o; };
  if (coast110) { ctx.beginPath(); path({ type: "MultiLineString", coordinates: coast110.map(pairs) }); ctx.strokeStyle = "rgba(215,236,255,0.5)"; ctx.stroke(); }
  if (track) {
    const idx = T.thin(track, 1500);
    ctx.beginPath(); path({ type: "LineString", coordinates: idx.map((i) => [track.lon[i], track.lat[i]]) });
    ctx.strokeStyle = COLORS.past; ctx.lineWidth = 1.5; ctx.stroke();
  }
  // the map's edge
  const k = 24, ring = [];
  const add = (sx, sy) => { const ll = v.unproject(sx, sy); if (ll) ring.push(ll); };
  for (let i = 0; i <= k; i++) add((v.cssW * i) / k, 0);
  for (let i = 0; i <= k; i++) add(v.cssW, (v.cssH * i) / k);
  for (let i = k; i >= 0; i--) add((v.cssW * i) / k, v.cssH);
  for (let i = k; i >= 0; i--) add(0, (v.cssH * i) / k);
  ctx.beginPath(); path({ type: "LineString", coordinates: ring }); ctx.strokeStyle = "rgba(255,122,184,0.9)"; ctx.lineWidth = 1.5; ctx.stroke();
  if (v.ship) { const p = proj([v.ship.lon, v.ship.lat]); if (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 4, 0, 2 * Math.PI); ctx.fillStyle = COLORS.ship; ctx.fill(); } }
  ctx.beginPath(); path({ type: "Sphere" }); ctx.strokeStyle = "rgba(140,196,255,0.4)"; ctx.stroke();
}

// ---------------------------------------------------------------- UI

function setStatus(t) {
  const errs = [ibcso.err, gebco.err].filter(Boolean);
  $("status").textContent = [t, ...errs.filter((e) => e !== t)].filter(Boolean).join(" ");
}
function setTrackStatus(t) { $("track-status").textContent = t; }

for (const v of T.VOYAGES) {
  const o = document.createElement("option");
  o.value = v.code; o.textContent = `${v.label}: ${v.about}`;
  $("voyage").appendChild(o);
}
for (const p of M.PLANS) {
  const o = document.createElement("option");
  o.value = p.key; o.textContent = p.label;
  $("plan").appendChild(o);
}

for (const [k, p] of Object.entries(T.PLACES)) $("to").insertAdjacentHTML("beforeend", `<option value="${k}">${p.name}</option>`);

function fillBy() {
  const sel = $("by"), cols = (track && track.numeric) || [];
  const want = state.by;
  sel.innerHTML = '<option value="">Nothing</option>' + cols.map((c) => `<option value="${c}">${c}</option>`).join("");
  if (want && !cols.includes(want)) sel.insertAdjacentHTML("beforeend", `<option value="${want}">${want}</option>`);
  sel.value = want;
}

function syncUI() {
  const v = voyage();
  $("voyage").value = v.code;
  $("voyage-about").innerHTML = `${v.from} to ${v.to}. <a href="${v.record}" target="_blank" rel="noopener">Data record</a>${trackNote && trackNote !== "schematic" ? `; track ${trackNote}` : ""}`;
  $("t").value = state.t;
  $("t-out").textContent = view && view.ship ? fmtTime(view.ship.time) : "";
  for (const b of $("views").querySelectorAll("button")) b.classList.toggle("active", b.dataset.view === state.view);
  $("ship-ctl").hidden = state.view !== "ship";
  $("proj").value = state.proj;
  $("up").checked = !!state.up;
  $("span").value = state.span;
  const km = 10 ** state.span;
  $("span-out").textContent = `${km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString("en")} km`;
  $("def").value = view ? view.def : "";
  $("plan").value = state.plan;
  $("cut").hidden = state.plan !== "cut";
  $("cut-out").textContent = state.plan === "cut" ? `IBCSO south of ${Math.abs(state.cut)}${DEG}S` : "";
  $("by-source").checked = !!state.src; $("by-source").disabled = state.plan === "diff";
  $("ice").checked = !!state.ice;
  $("cells-on").checked = !!state.cells;
  $("coast").checked = !!state.coast;
  $("rings").checked = !!state.rings;
  $("to").value = state.to;
  $("from").value = state.from;
  $("play").textContent = playing ? "Pause" : "Play";
}

function hoverAt(e) {
  if (!view) return;
  const b = canvas.getBoundingClientRect(), ll = view.unproject(e.clientX - b.left, e.clientY - b.top);
  if (!ll) { $("hover").textContent = ""; return; }
  const d = depthAt(ll[0], ll[1]);
  const parts = [fmtLL(ll[0], ll[1]), `IBCSO ${m(d.e1)}`, `GEBCO ${m(d.e2)}`];
  if (frame && frame.iceW) parts.push(Number.isFinite(d.c) ? `ice ${Math.round(d.c * 100)}%` : "no ice value");
  $("hover").textContent = parts.join(", ");
}

// redraw at most once a frame
let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; render(); });
}

function render() {
  view = makeView();
  const ship = view.ship;
  if (ship && state.ice) {
    const day = new Date(ship.time).toISOString().slice(0, 10);
    if (day !== iceDay) {
      iceDay = day;
      loadIce(day).then((r) => { if (r.day === iceDay) { iceShown = r; if (r.err) setStatus(`Sea ice for ${day} did not load (${r.err}); the NSIDC server may not allow reads from other sites.`); schedule(); } });
    }
  }
  renderImage(view);
  drawAll();
  syncUI();
  readouts();
  drawInset();
  drawLegend();
  writeHash();
  document.body.classList.add("ready");
}

// play: time runs at speed voyage-days a second
let playing = false, last = 0;
function tick(now) {
  if (!playing || !track) return;
  const dt = last ? (now - last) / 1000 : 0;
  last = now;
  const days = (track.end - track.start) / 864e5;
  state.t += (dt * +$("speed").value) / Math.max(days, 1e-3);
  if (state.t >= 1) { state.t = 1; playing = false; }
  render();
  if (playing) requestAnimationFrame(tick);
  else syncUI();
}

$("play").addEventListener("click", () => {
  playing = !playing;
  if (playing && state.t >= 1) state.t = 0;
  last = 0;
  syncUI();
  if (playing) requestAnimationFrame(tick);
});
$("t").addEventListener("input", (e) => { state.t = +e.target.value; schedule(); });
$("voyage").addEventListener("change", (e) => { state.v = e.target.value; state.t = defaults.t; loadTrack().then(schedule); schedule(); });
for (const b of $("views").querySelectorAll("button")) b.addEventListener("click", () => {
  if (state.view === b.dataset.view) return;
  state.view = b.dataset.view; state.span = VIEW_SPAN[state.view]; state.cx = state.cy = 0;
  schedule();
});
$("proj").addEventListener("change", (e) => { state.proj = e.target.value; schedule(); });
$("up").addEventListener("change", (e) => { state.up = e.target.checked ? 1 : 0; schedule(); });
$("span").addEventListener("input", (e) => { state.span = +e.target.value; schedule(); });
$("plan").addEventListener("change", (e) => { state.plan = e.target.value; schedule(); });
$("cut").addEventListener("input", (e) => { state.cut = +e.target.value; schedule(); });
$("by-source").addEventListener("change", (e) => { state.src = e.target.checked ? 1 : 0; schedule(); });
$("ice").addEventListener("change", (e) => { state.ice = e.target.checked ? 1 : 0; if (!state.ice) iceDay = ""; schedule(); });
$("cells-on").addEventListener("change", (e) => { state.cells = e.target.checked ? 1 : 0; schedule(); });
$("coast").addEventListener("change", (e) => { state.coast = e.target.checked ? 1 : 0; schedule(); });
$("rings").addEventListener("change", (e) => { state.rings = e.target.checked ? 1 : 0; schedule(); });
$("by").addEventListener("change", (e) => { state.by = e.target.value; loadTrack(); });
$("to").addEventListener("change", (e) => { state.to = e.target.value; schedule(); });
$("from").addEventListener("change", (e) => { state.from = e.target.value; loadTrack(); schedule(); });
$("copy-def").addEventListener("click", (e) => copyText($("def").value, e.target));

// drag pans the Antarctic map; the wheel zooms either
let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  if (state.view !== "polar") return;
  drag = { x: e.clientX, y: e.clientY, cx: state.cx, cy: state.cy };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (drag && view) {
    const km = view.mpp / 1000;
    state.cx = drag.cx - (e.clientX - drag.x) * km; state.cy = drag.cy + (e.clientY - drag.y) * km;
    schedule();
  } else hoverAt(e);
});
canvas.addEventListener("pointerup", () => { drag = null; });
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  state.span = Math.max(1, Math.min(4, state.span + (e.deltaY > 0 ? 0.05 : -0.05)));
  schedule();
}, { passive: false });

new ResizeObserver(() => schedule()).observe($("stage"));
window.addEventListener("hashchange", () => { readHash(); loadTrack(); schedule(); });

shareLinks("Nuyina: sea ice, two bathymetry mosaics and the ship's track", { height: 560 });
readHash();
syncUI();
loadCoastline("50m").then((c) => { coast = c.filter((l) => { for (let i = 1; i < l.length; i += 2) if (l[i] < -30) return true; return false; }); schedule(); }).catch(() => {});
loadCoastline("110m").then((c) => { coast110 = c; schedule(); }).catch(() => {});
openIbcso();
openGebco();
loadTrack().then(schedule);
schedule();
