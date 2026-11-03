// playproj: Cutaway.
//
// A line across Antarctic ice, drawn as a section (the ice surface, the ice
// base, the cavity under a floating shelf, the bed and the sea) and as a
// block diagram cut along the line. Bedmap3 gives surface, thickness, bed,
// the grounding mask and the bed's uncertainty; REMA's surface and GEBCO
// 2026 are drawn beside it along the section. Every source is a COG read in
// place by its byte ranges at the pyramid level the line needs. The pure
// parts (sources, geometry, levels, layering) are in src/core/cutaway.js.

import * as THREE from "three";
import * as C from "../src/core/cutaway.js";
import * as GE from "../src/core/geoid.js";
import { loadScript } from "./basemap-load.js";
import { makeStage, readParams, hashWriter, shareLinks, oneOf } from "../src/scene/index.js";

const proj4 = window.proj4;
proj4.defs("EPSG:3031", "+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs");
const toXY = (lon, lat) => proj4("EPSG:4326", "EPSG:3031", [lon, lat]);
const toLL = (x, y) => proj4("EPSG:3031", "EPSG:4326", [x, y]);
const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";
const GEOTIFF_JS = "https://cdn.jsdelivr.net/npm/geotiff@3.0.5/dist-browser/geotiff.js";
const INK = { rock: "#7a6552", water: "#1d5f9e", ice: "#e3f0fb", sky: "#05070d", bed: "#3a2c20", surface: "#ffffff", base: "#9cc8ec",
  rema: "#ffb347", gebco: "#7fe0ff", unc: "rgba(255,211,77,0.22)", ground: "#ff7ab8", grid: "rgba(160,200,255,0.16)", text: "#c4cedb" };

// ---------------------------------------------------------------- state

const defaults = { at: "amery", a: "", b: "", w: 120, side: 1, ve: 0, ice: "solid", rema: 1, gebco: 1, unc: 1, cam: null };
const state = { ...defaults };
const lonlat = (s) => { const v = String(s).split(",").map(Number); return v.length === 2 && v.every(isFinite) && v[1] < -50 && v[1] >= -90 ? s : undefined; };
readParams(state, defaults, { at: oneOf(C.PRESETS.map((p) => p.key), "amery"), a: lonlat, b: lonlat, ice: oneOf(["solid", "glass", "off"], "solid") });
state.w = Math.max(10, Math.min(600, state.w));
state.side = state.side < 0 ? -1 : 1;
state.ve = Math.max(0, Math.min(500, state.ve));
const writeHash = hashWriter(state, defaults);

const preset = () => C.PRESETS.find((p) => p.key === state.at) || C.PRESETS[0];
const ends = () => {
  const p = preset();
  const a = state.a ? state.a.split(",").map(Number) : p.a, b = state.b ? state.b.split(",").map(Number) : p.b;
  return { a, b, A: toXY(a[0], a[1]), B: toXY(b[0], b[1]) };
};

// ---------------------------------------------------------------- reading

// every request to a source is counted, as the cost of a view
const ledger = { req: 0, bytes: 0 };
const rawFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  const r = await rawFetch(url, init);
  const u = String(url && url.url ? url.url : url);
  if (/source\.coop|githubusercontent/.test(u)) { ledger.req++; ledger.bytes += +(r.headers.get("content-length") || 0); }
  return r;
};

async function geotiff() {
  if (typeof GeoTIFF === "undefined") await loadScript(GEOTIFF_JS);
  return window.GeoTIFF;
}
// a COG's pyramid, finest first, each level with its image
const opened = new Map();
function openCog(url) {
  if (!opened.has(url)) {
    const p = (async () => {
      const GT = await geotiff();
      const tiff = await GT.fromUrl(url);
      const n = await tiff.getImageCount(), imgs = [];
      for (let i = 0; i < n; i++) imgs.push(await tiff.getImage(i));
      const [x0, y0] = imgs[0].getOrigin(), [res] = imgs[0].getResolution();
      const L = C.levelsOf(x0, y0, res, imgs.map((im) => [im.getWidth(), im.getHeight()]));
      L.forEach((l, i) => { l.img = imgs[i]; });
      return L;
    })();
    p.catch(() => opened.delete(url));
    opened.set(url, p);
  }
  return opened.get(url);
}
// REMA: three files, one level each
async function remaLevels() {
  const each = await Promise.all(C.SOURCES.rema.files.map(openCog));
  return each.map((L) => L[0]);
}
// A box of a pyramid at about px per pixel, as a sampling window.
async function readBox(levels, box, px, nodata, max = 1600) {
  const p = C.plan(levels, box, px, max);
  if (!p.win) return null;
  const [data] = await p.level.img.readRasters({ window: p.win, samples: [0] });
  const g = C.windowGrid(p.level, p.win, data, nodata);
  g.level = p.k;
  return g;
}

let geoid = null;
async function loadGeoid() {
  if (!geoid) geoid = fetch(new URL("../data/geoid-egm2008-1deg.bin", import.meta.url)).then((r) => r.arrayBuffer()).then((b) => GE.fromInt16(b));
  return geoid;
}

// ---------------------------------------------------------------- the section

let current = null;   // { f, blk, rows, grid, floor, top, ... }
let building = 0;

async function build() {
  const ticket = ++building;
  const { A, B } = ends();
  const f = C.lineFrame(A, B), blk = C.blockOf(f, state.w * 1000, state.side);
  const req0 = ledger.req, b0 = ledger.bytes, t0 = performance.now();
  setStatus("Reading Bedmap3...");
  try {
    const bedmap = {};
    const pxBlock = Math.max(500, Math.max(blk.box[2] - blk.box[0], blk.box[3] - blk.box[1]) / 1400);
    await Promise.all(C.SOURCES.bedmap.arrays.map(async (a) => {
      bedmap[a] = await readBox(await openCog(C.SOURCES.bedmap.url(a)), blk.box, pxBlock, C.SOURCES.bedmap.nodata);
    }));
    if (ticket !== building) return;
    const res = bedmap.bed_topography.dx;
    const N = Math.max(200, Math.min(1200, Math.round(f.L / res)));
    const layerAt = ([x, y]) => C.layer(C.sample(bedmap.surface_topography, x, y), C.sample(bedmap.ice_thickness, x, y),
      C.sample(bedmap.bed_topography, x, y), C.nearest(bedmap.mask, x, y));
    const rows = C.samplesAlong(f, N).map((r) => ({ ...r, l: layerAt(r.p), unc: C.sample(bedmap.bed_uncertainty, r.p[0], r.p[1]), ll: toLL(r.p[0], r.p[1]) }));
    // the block's grid
    const nu = Math.max(40, Math.min(220, Math.round(f.L / res))), nv = Math.max(8, Math.min(120, Math.round((state.w * 1000) / res)));
    const grid = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const s = (f.L * i) / nu, t = (state.w * 1000 * state.side * j) / nv;
      grid.push({ s, t, l: layerAt(C.at(f, s, t)) });
    }
    const all = rows.map((r) => r.l).concat(grid.map((g) => g.l));
    const floor = C.floorOf(all);
    let top = 0;
    for (const l of all) if (l.top === l.top && l.top > top) top = l.top;
    top = Math.ceil((top + 200) / 100) * 100;
    current = { f, blk, rows, grid, nu, nv, floor, top, res, N, levels: { bedmap: bedmap.bed_topography.level }, cost: null };
    drawAll();
    // REMA and GEBCO along the section, after the first picture
    const lineBox = [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[0], B[0]), Math.max(A[1], B[1])];
    const spacing = f.L / N;
    const extras = [];
    if (state.rema) extras.push((async () => {
      setStatus("Reading REMA...");
      const [L, g] = await Promise.all([remaLevels(), loadGeoid()]);
      const w = await readBox(L, lineBox, spacing, C.SOURCES.rema.nodata, 2400);
      if (!w) return;
      current.levels.rema = L[w.level].res;
      for (const r of rows) { const v = C.sample(w, r.p[0], r.p[1]); r.rema = v === v ? v - GE.undulation(g, r.ll[0], r.ll[1]) : NaN; }
    })().catch((e) => { current.remaErr = e.message || String(e); }));
    if (state.gebco) extras.push((async () => {
      setStatus("Reading GEBCO 2026...");
      const L = await openCog(C.SOURCES.gebco.url);
      // one box, or two either side of the antimeridian
      const boxes = C.lonBoxes(rows.map((r) => r.ll[0]), rows.map((r) => r.ll[1]));
      const ws = (await Promise.all(boxes.map((b) => readBox(L, b, spacing / 111320, C.SOURCES.gebco.nodata, 2400)))).filter(Boolean);
      if (!ws.length) return;
      current.levels.gebco = Math.min(...ws.map((w) => L[w.level].res)) * 111320;
      for (const r of rows) {
        const w = ws.find((q) => r.ll[0] >= q.x0 && r.ll[0] <= q.x0 + q.width * q.dx) || ws[0];
        r.gebco = C.sample(w, r.ll[0], r.ll[1]);
      }
    })().catch((e) => { current.gebcoErr = e.message || String(e); }));
    await Promise.all(extras);
    if (ticket !== building) return;
    current.cost = { req: ledger.req - req0, bytes: ledger.bytes - b0, ms: performance.now() - t0 };
    setStatus("");
    drawSection(); renderReadout();
  } catch (e) {
    if (ticket === building) setStatus(`The read failed: ${e.message || e}`);
  }
}

// ---------------------------------------------------------------- drawing a section

// A section into a 2D context over [x0, x1] x [y0, y1] pixels: rock, water
// and ice as filled runs, then the surface, base and bed lines. rows have
// s (metres along) and l (a layer). Shared by the panel's section and the
// faces of the block, so the two always agree.
function paintBands(g, rows, floor, top, X, Y) {
  const st = rows.map((r) => C.stack(r.l, floor));
  for (const [band, ink] of [["rock", INK.rock], ["water", INK.water], ["ice", INK.ice]]) {
    g.fillStyle = ink;
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        g.beginPath();
        run.forEach((i, k) => (k ? g.lineTo(X(rows[i].s), Y(st[i][band][1])) : g.moveTo(X(rows[i].s), Y(st[i][band][1]))));
        for (let k = run.length - 1; k >= 0; k--) g.lineTo(X(rows[run[k]].s), Y(st[run[k]][band][0]));
        g.closePath(); g.fill();
      }
      run = [];
    };
    rows.forEach((r, i) => (st[i] ? run.push(i) : flush()));
    flush();
  }
  // the ice base under floating ice, a fine line
  g.strokeStyle = INK.base; g.lineWidth = 1;
  g.beginPath();
  let pen = false;
  rows.forEach((r) => {
    if (r.l.kind === "floating") { const x = X(r.s), y = Y(r.l.base); pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true; } else pen = false;
  });
  g.stroke();
}

function line(g, rows, get, X, Y, ink, width = 1.5, dash = []) {
  g.strokeStyle = ink; g.lineWidth = width; g.setLineDash(dash);
  g.beginPath();
  let pen = false;
  for (const r of rows) {
    const v = get(r);
    if (v === v && v !== undefined) { pen ? g.lineTo(X(r.s), Y(v)) : g.moveTo(X(r.s), Y(v)); pen = true; } else pen = false;
  }
  g.stroke(); g.setLineDash([]);
}

let hoverS = null;
function drawSection() {
  const c = $("section"), g = c.getContext("2d");
  const W = (c.width = c.clientWidth * devicePixelRatio), H = (c.height = c.clientHeight * devicePixelRatio);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = INK.sky; g.fillRect(0, 0, W, H);
  if (!current) return;
  const k = devicePixelRatio, m = { l: 52 * k, r: 12 * k, t: 18 * k, b: 26 * k };
  const { rows, floor, top, f } = current;
  const X = (s) => m.l + (s / f.L) * (W - m.l - m.r), Y = (z) => m.t + ((top - z) / (top - floor)) * (H - m.t - m.b);
  paintBands(g, rows, floor, top, X, Y);
  // the bed's uncertainty, as a band about it
  if (state.unc) {
    g.fillStyle = INK.unc;
    g.beginPath();
    const ok = rows.filter((r) => r.unc === r.unc && r.l.bed === r.l.bed);
    ok.forEach((r, i) => (i ? g.lineTo(X(r.s), Y(r.l.bed + r.unc)) : g.moveTo(X(r.s), Y(r.l.bed + r.unc))));
    for (let i = ok.length - 1; i >= 0; i--) g.lineTo(X(ok[i].s), Y(ok[i].l.bed - ok[i].unc));
    g.closePath(); g.fill();
  }
  line(g, rows, (r) => r.l.bed, X, Y, INK.bed, 1.2 * k);
  line(g, rows, (r) => (r.l.ice > 0 ? r.l.top : NaN), X, Y, INK.surface, 1 * k);
  if (state.gebco) line(g, rows, (r) => r.gebco, X, Y, INK.gebco, 1.2 * k, [4 * k, 3 * k]);
  if (state.rema) line(g, rows, (r) => r.rema, X, Y, INK.rema, 1.2 * k);
  // sea level, grid and labels
  g.font = `${11 * k}px system-ui, sans-serif`;
  g.strokeStyle = INK.grid; g.fillStyle = INK.text; g.lineWidth = 1;
  const step = niceStep((top - floor) / 5);
  g.textAlign = "right";
  for (let z = Math.ceil(floor / step) * step; z <= top; z += step) {
    g.beginPath(); g.moveTo(m.l, Y(z)); g.lineTo(W - m.r, Y(z)); g.stroke();
    g.fillText(`${z} m`, m.l - 4 * k, Y(z) + 4 * k);
  }
  const xs = niceStep(f.L / 1000 / 6);
  g.textAlign = "center";
  for (let d = 0; d <= f.L / 1000; d += xs) g.fillText(`${d} km`, X(d * 1000), H - 8 * k);
  g.strokeStyle = "rgba(127,224,255,0.6)"; g.setLineDash([2 * k, 3 * k]);
  g.beginPath(); g.moveTo(m.l, Y(0)); g.lineTo(W - m.r, Y(0)); g.stroke(); g.setLineDash([]);
  // grounding lines
  const S = C.summary(rows);
  g.strokeStyle = INK.ground; g.lineWidth = 1.2 * k;
  for (const s of S.grounding) { g.beginPath(); g.moveTo(X(s), m.t); g.lineTo(X(s), H - m.b); g.stroke(); }
  // the vertical exaggeration as drawn
  const ve = ((f.L / (W - m.l - m.r)) / ((top - floor) / (H - m.t - m.b)));
  g.textAlign = "left"; g.fillStyle = INK.text;
  g.fillText(`A  (vertical x ${ve.toFixed(0)})`, m.l + 4 * k, m.t - 5 * k);
  g.textAlign = "right"; g.fillText("B", W - m.r, m.t - 5 * k);
  // the hovered sample
  if (hoverS !== null) {
    const i = Math.round((hoverS / f.L) * (rows.length - 1)), r = rows[i], l = r.l;
    g.strokeStyle = "rgba(255,255,255,0.7)"; g.beginPath(); g.moveTo(X(r.s), m.t); g.lineTo(X(r.s), H - m.b); g.stroke();
    const parts = [`${(r.s / 1000).toFixed(1)} km`, l.kind];
    if (l.ice > 0) parts.push(`ice ${l.ice.toFixed(0)} m`);
    if (l.top === l.top) parts.push(`surface ${l.top.toFixed(0)} m`);
    if (l.water && l.kind === "floating") parts.push(`cavity ${(l.water[0] - l.water[1]).toFixed(0)} m`);
    if (l.bed === l.bed) parts.push(`bed ${l.bed.toFixed(0)}${r.unc === r.unc ? ` \u00b1 ${r.unc.toFixed(0)}` : ""} m`);
    if (r.rema === r.rema && r.rema !== undefined) parts.push(`REMA ${r.rema.toFixed(0)} m`);
    if (r.gebco === r.gebco && r.gebco !== undefined) parts.push(`GEBCO ${r.gebco.toFixed(0)} m`);
    g.textAlign = "right"; g.fillStyle = "#fff";
    g.fillText(parts.join(", "), W - m.r - 30 * k, m.t - 5 * k);
  }
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

$("section").addEventListener("mousemove", (e) => {
  if (!current) return;
  const r = e.target.getBoundingClientRect(), x = e.clientX - r.left;
  hoverS = Math.max(0, Math.min(1, (x - 52) / (r.width - 64))) * current.f.L;
  drawSection(); drawMap(); placePin();
});
$("section").addEventListener("mouseleave", () => { hoverS = null; drawSection(); drawMap(); placePin(); });

// ---------------------------------------------------------------- the map

const MAP = { half: 3333500 };
let overview = null;
async function loadOverview() {
  const read = async (a) => {
    const L = await openCog(C.SOURCES.bedmap.url(a));
    const lv = L[L.length - 2];
    const [data] = await lv.img.readRasters({ samples: [0] });
    return { data, width: lv.width, height: lv.height };
  };
  const [s, b, m] = await Promise.all(["surface_topography", "bed_topography", "mask"].map(read));
  const { width: W, height: H } = s, img = new ImageData(W, H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, o = k * 4, z = s.data[k], bed = b.data[k], mk = m.data[k];
    let c;
    if (mk === 3 || mk === 2) c = [150, 190, 220];
    else if (mk === 4) c = [130, 105, 85];
    else if (z !== -9999) {
      const e = j > 0 && i > 0 && s.data[k - 1] !== -9999 && s.data[k - W] !== -9999 ? (z - s.data[k - 1]) + (z - s.data[k - W]) : 0;
      const v = Math.max(120, Math.min(255, 205 + z / 60 + e * 0.8));
      c = [v, v, Math.min(255, v + 12)];
    } else if (bed !== -9999) { const d = Math.max(0, Math.min(1, -bed / 4500)); c = [20 * (1 - d) + 5, 70 * (1 - d) + 20, 140 * (1 - d) + 50]; }
    else c = [5, 7, 13];
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
  }
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  cv.getContext("2d").putImageData(img, 0, 0);
  overview = cv;
  drawMap();
}
function drawMap() {
  const c = $("cut-map"), g = c.getContext("2d"), W = c.width, H = c.height;
  g.fillStyle = INK.sky; g.fillRect(0, 0, W, H);
  if (overview) g.drawImage(overview, 0, 0, W, H);
  const P = (p) => [((p[0] + MAP.half) / (2 * MAP.half)) * W, ((MAP.half - p[1]) / (2 * MAP.half)) * H];
  const { A, B } = ends();
  if (current) {
    g.fillStyle = "rgba(255,211,77,0.25)"; g.strokeStyle = "rgba(255,211,77,0.9)"; g.lineWidth = 1;
    g.beginPath(); current.blk.corners.forEach((q, i) => { const [x, y] = P(q); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); g.fill(); g.stroke();
  }
  g.strokeStyle = "#ff7ab8"; g.lineWidth = 2;
  const pa = P(A), pb = pending ? P(pending) : P(B);
  g.beginPath(); g.moveTo(pa[0], pa[1]); if (!pending) g.lineTo(pb[0], pb[1]); g.stroke();
  g.fillStyle = "#fff"; g.font = "11px system-ui, sans-serif";
  g.fillText("A", pa[0] + 4, pa[1] - 4); if (!pending) g.fillText("B", pb[0] + 4, pb[1] - 4);
  if (hoverS !== null && current) {
    const [x, y] = P(C.at(current.f, hoverS, 0));
    g.beginPath(); g.arc(x, y, 3.5, 0, 7); g.fill();
  }
}
// two clicks: the first sets A, the second B
let pending = null;
$("cut-map").addEventListener("click", (e) => {
  const r = e.target.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 2 * MAP.half - MAP.half, y = MAP.half - ((e.clientY - r.top) / r.height) * 2 * MAP.half;
  const ll = toLL(x, y), s = `${ll[0].toFixed(3)},${ll[1].toFixed(3)}`;
  if (!pending) { pending = [x, y]; state.a = s; $("map-hint").textContent = "Now click the other end (B)."; drawMap(); return; }
  pending = null; state.b = s; $("map-hint").textContent = "Click twice on the map for a new line: A, then B.";
  state.cam = null; syncInputs(); writeHash(); build();
});

// ---------------------------------------------------------------- the block

const { renderer, scene, camera, controls, setCamera, resize } = makeStage($("three"), {
  bg: 0x05070d, fov: 35, near: 0.5, far: 60000,
  onCamera: (cam) => { state.cam = cam.map((v) => +v.toFixed(1)); writeHash(); }
});
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(-0.4, 1, 0.6);
scene.add(sun);
const block = new THREE.Group();
scene.add(block);
const pin = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]), new THREE.LineBasicMaterial({ color: 0xffffff }));
pin.visible = false; scene.add(pin);

const ve = () => (state.ve > 0 ? state.ve : current ? C.autoExaggeration(current.f.L, current.top - current.floor) : 25);
// the block's frame: x along the line (km), z off it (km, the block on
// the far side from where the camera starts), y up (km, exaggerated)
const posOf = (s, t, m) => [s / 1000, C.zOf(m, ve()), -t / 1000];

function clearBlock() {
  for (const o of [...block.children]) {
    block.remove(o); o.geometry.dispose();
    if (o.material.map) o.material.map.dispose();
    o.material.dispose();
  }
}

// a surface over the block's grid: height(l) in metres or NaN, colour(l)
// as [r, g, b] in 0..1; triangles only where all three corners have height
function surface(heightOf, colourOf, material) {
  const { grid, nu, nv } = current, n = grid.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), ok = new Uint8Array(n);
  grid.forEach((g, k) => {
    const h = heightOf(g.l);
    if (h === h) { ok[k] = 1; pos.set(posOf(g.s, g.t, h), 3 * k); col.set(colourOf(g.l, h), 3 * k); }
  });
  const idx = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    if (ok[a] && ok[b] && ok[d]) idx.push(a, b, d);
    if (ok[a] && ok[d] && ok[c]) idx.push(a, d, c);
  }
  if (!idx.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  block.add(mesh);
  return mesh;
}

// one side of the block: a vertical rectangle from p (s, t) to q, from the
// floor to the top, painted with the section along it (sky transparent)
function face(rows, s0, t0, s1, t1) {
  const { floor, top } = current;
  const cv = document.createElement("canvas");
  cv.width = 1024; cv.height = 512;
  const g = cv.getContext("2d"), len = Math.hypot(s1 - s0, t1 - t0) || 1;
  const along = (r) => Math.hypot(r.s0 - s0, r.t0 - t0);
  const rr = rows.map((r) => ({ s: along(r), l: r.l }));
  paintBands(g, rr, floor, top, (d) => (d / len) * cv.width, (z) => ((top - z) / (top - floor)) * cv.height);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const a = posOf(s0, t0, floor), b = posOf(s1, t1, floor), c = posOf(s1, t1, top), d = posOf(s0, t0, top);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(Float32Array.from([...a, ...b, ...c, ...d]), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(Float32Array.of(0, 0, 1, 0, 1, 1, 0, 1), 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  block.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide })));
}

function bedColour(l, h) {
  if (h < 0) { const d = Math.max(0, Math.min(1, -h / 3000)); return [0.35 - 0.25 * d, 0.5 - 0.3 * d, 0.62 - 0.25 * d]; }
  const u = Math.max(0, Math.min(1, h / 3000));
  return [0.48 + 0.3 * u, 0.4 + 0.3 * u, 0.32 + 0.3 * u];
}

function drawBlock() {
  clearBlock();
  if (!current) return;
  const { grid, nu, nv, rows, f } = current, W = state.w * 1000 * state.side;
  // the bed, everywhere
  surface((l) => l.bed, bedColour, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  // the sea's surface over open water
  surface((l) => (l.kind === "sea" ? 0 : NaN), () => [0.12, 0.38, 0.62], new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
  if (state.ice !== "off") {
    const glass = state.ice === "glass";
    const iceMat = () => new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: glass, opacity: glass ? 0.35 : 1, depthWrite: !glass });
    surface((l) => (l.ice > 0 ? l.top : NaN), () => [0.92, 0.96, 1], iceMat());
    surface((l) => (l.kind === "floating" ? l.base : NaN), () => [0.62, 0.78, 0.92], iceMat());
  }
  // the four sides: the cut along the line from the section itself, the
  // others from the block's grid
  const edge = (pick) => grid.filter(pick).map((g) => ({ s0: g.s, t0: g.t, l: g.l }));
  face(rows.map((r) => ({ s0: r.s, t0: 0, l: r.l })), 0, 0, f.L, 0);
  face(edge((g, k) => Math.floor(k / (nu + 1)) === nv), 0, W, f.L, W);
  face(edge((g, k) => k % (nu + 1) === 0), 0, 0, 0, W);
  face(edge((g, k) => k % (nu + 1) === nu), f.L, 0, f.L, W);
  placePin();
}

function defaultCamera() {
  if (!current) return [0, 200, 800, 0, 0, 0];
  const L = current.f.L / 1000, w = state.w * state.side, z = C.zOf((current.top + current.floor) / 2, ve());
  // in front of the cut face, a little above it and towards A
  const back = Math.max(L, Math.abs(w)) * 0.8;
  return [L * 0.35, z + back * 0.45, state.side * back * 0.9, L / 2, z, -w / 2];
}

function placePin() {
  if (!current || hoverS === null) { pin.visible = false; return; }
  const a = posOf(hoverS, 0, current.floor), b = posOf(hoverS, 0, current.top);
  pin.geometry.setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
  pin.visible = true;
}

// ---------------------------------------------------------------- panel

function setStatus(s) { $("status").textContent = s; }

function renderReadout() {
  const tb = $("readout").tBodies[0];
  tb.innerHTML = "";
  if (!current) return;
  const row = (k, v) => { const tr = tb.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = v; };
  const { f, rows, levels, cost } = current, S = C.summary(rows), km = (m) => `${(m / 1000).toFixed(0)} km`;
  const { a, b } = ends();
  row("A", `${a[1].toFixed(2)}${DEG}, ${a[0].toFixed(2)}${DEG}`);
  row("B", `${b[1].toFixed(2)}${DEG}, ${b[0].toFixed(2)}${DEG}`);
  row("Length", `${km(f.L)} (in the projection's plane)`);
  row("Floating / grounded", `${km(S.floating)} / ${km(S.grounded)}${S.sea ? `, open sea ${km(S.sea)}` : ""}`);
  row("Thickest ice", `${S.maxIce.toFixed(0)} m`);
  row("Deepest bed", Number.isFinite(S.minBed) ? `${S.minBed.toFixed(0)} m` : "none");
  if (S.maxCavity) row("Deepest cavity", `${S.maxCavity.toFixed(0)} m of water under the shelf`);
  row("Grounding lines", S.grounding.length ? S.grounding.map((s) => `${(s / 1000).toFixed(0)} km`).join(", ") : "none crossed");
  row("Bedmap3 read at", `${(current.res / 1000).toFixed(current.res < 1000 ? 1 : 0)} km (${current.N + 1} samples)`);
  if (state.rema) row("REMA read at", levels.rema ? `${levels.rema} m, minus EGM2008` : current.remaErr || "reading");
  if (state.gebco) row("GEBCO read at", levels.gebco ? `about ${(levels.gebco / 1000).toFixed(1)} km north to south` : current.gebcoErr || "reading");
  if (cost) row("Cost", `${cost.req} requests, ${(cost.bytes / 2 ** 20).toFixed(1)} MB, ${(cost.ms / 1000).toFixed(1)} s`);
  $("vert").textContent = `x ${ve()}${state.ve ? "" : " (auto)"}`;
}

function syncInputs() {
  const { a, b } = ends();
  $("preset").value = state.at;
  $("a").value = `${a[0]},${a[1]}`; $("b").value = `${b[0]},${b[1]}`;
  $("width").value = state.w; $("width-out").textContent = `${state.w} km`;
  $("side").value = String(state.side);
  $("ve").value = state.ve; $("vert").textContent = state.ve ? `x ${state.ve}` : "auto";
  $("ice").value = state.ice;
  $("rema").checked = !!state.rema; $("gebco").checked = !!state.gebco; $("unc").checked = !!state.unc;
}

for (const p of C.PRESETS) { const o = document.createElement("option"); o.value = p.key; o.textContent = p.label; $("preset").append(o); }
$("preset").addEventListener("change", () => { state.at = $("preset").value; state.a = state.b = ""; state.cam = null; syncInputs(); writeHash(); build(); });
const endInput = (id) => $(id).addEventListener("change", () => {
  const v = lonlat($(id).value.replace(/\s+/g, ""));
  if (!v) { setStatus("ends: longitude,latitude in degrees, south of 50S"); return; }
  state[id] = v; state.cam = null; writeHash(); build();
});
endInput("a"); endInput("b");
$("swap").addEventListener("click", () => { const { a, b } = ends(); state.a = `${b[0]},${b[1]}`; state.b = `${a[0]},${a[1]}`; state.cam = null; syncInputs(); writeHash(); build(); });
$("width").addEventListener("input", () => { $("width-out").textContent = `${$("width").value} km`; });
$("width").addEventListener("change", () => { state.w = +$("width").value; state.cam = null; writeHash(); build(); });
$("side").addEventListener("change", () => { state.side = +$("side").value; state.cam = null; writeHash(); build(); });
$("ve").addEventListener("input", () => { state.ve = +$("ve").value; $("vert").textContent = state.ve ? `x ${state.ve}` : "auto"; });
$("ve").addEventListener("change", () => { writeHash(); drawBlock(); renderReadout(); });
$("ice").addEventListener("change", () => { state.ice = $("ice").value; writeHash(); drawBlock(); });
for (const id of ["rema", "gebco", "unc"]) $(id).addEventListener("change", () => { state[id] = $(id).checked ? 1 : 0; writeHash(); if (id === "unc") drawSection(); else build(); });
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(defaultCamera()); writeHash(); });
$("csv").addEventListener("click", () => {
  if (!current) return;
  const out = ["dist_km,x,y,lon,lat,kind,surface_m,ice_thickness_m,ice_base_m,bed_m,bed_uncertainty_m,cavity_m,rema_m,gebco_m"];
  const n = (v, d = 1) => (v === v && v !== undefined && v !== null ? (+v).toFixed(d) : "");
  for (const r of current.rows) {
    const l = r.l;
    out.push([n(r.s / 1000, 3), n(r.p[0], 0), n(r.p[1], 0), n(r.ll[0], 5), n(r.ll[1], 5), l.kind, n(l.top), n(l.ice), n(l.base), n(l.bed), n(r.unc),
      l.kind === "floating" && l.water ? n(l.water[0] - l.water[1]) : "", n(r.rema), n(r.gebco)].join(","));
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out.join("\n") + "\n"], { type: "text/csv" }));
  a.download = `cutaway_${state.at}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

function drawAll() {
  drawSection(); drawMap(); drawBlock(); renderReadout();
  setCamera(state.cam || defaultCamera());
}

// ---------------------------------------------------------------- start

new ResizeObserver(() => drawSection()).observe($("section"));
$("credit").textContent = [C.SOURCES.bedmap.credit, C.SOURCES.rema.credit, C.SOURCES.gebco.credit].join(". ") + ".";
syncInputs();
resize();
function frame() { controls.update(); renderer.render(scene, camera); requestAnimationFrame(frame); }
requestAnimationFrame(frame);
shareLinks("playproj: Cutaway");
loadOverview().catch((e) => setStatus(`The overview map did not load (${e.message || e})`));
build().then(() => { window.__cutaway = { state, get current() { return current; }, ready: true }; });
