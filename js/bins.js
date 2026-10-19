// playproj: L3 bins.
//
// The texture is a plate carree map with the bin edges of the drawn grid on
// it. The surface is one strip per row of that grid, so the rows can part:
// it runs from the globe (unwrap 0) to a cylinder, opens with each row
// shrunk to its bin count (the integerized sinusoidal, 2/3), and then slides
// every row to the left edge, the ragged array the bins are stored in (1).

import * as THREE from "three";
import * as l3 from "../src/core/l3bin.js";
import { loadCoastline } from "./data.js";
import { basemapControl, exportControl } from "./basemap-ui.js";
import { makeStage, readParams, hashWriter, shareLinks, copyText } from "../src/scene/index.js";

const D2R = Math.PI / 180;
const DEG = "\u00b0";
const TEX_W = 2048, TEX_H = 1024;
const DRAWN = [6, 12, 18, 24, 36, 48, 72, 90, 180];
const NU = 64;   // segments along each row strip

const COLORS = {
  bg: 0x05070d,
  rowA: "#10284a",
  rowB: "#14305a",
  coast: "#d7ecff",
  edge: "rgba(215,236,255,0.45)",
  pick: "#ffd34d"
};

// ---------------------------------------------------------------- state

const defaults = { rows: 3, t: 0, grid: "2160", bin: "", lines: 1, coast: 1, bm: "none", cam: null };
const state = { ...defaults };

function readHash() {
  readParams(state, defaults, {
    grid: (raw) => (raw === "drawn" || /^\d+$/.test(raw) ? raw : "2160"),
    bin: String,
    bm: String
  });
  state.rows = Math.max(0, Math.min(DRAWN.length - 1, Math.round(state.rows)));
  state.t = Math.max(0, Math.min(1, state.t));
}

const writeHash = hashWriter(state, defaults);

const drawnGrid = () => l3.grid(DRAWN[state.rows]);
const lookupGrid = () => l3.grid(state.grid === "drawn" ? DRAWN[state.rows] : Math.max(2, Math.min(1e6, +state.grid)));

// The picked bin, from a bin number or "lon, lat"
function picked() {
  const g = lookupGrid(), raw = state.bin.trim();
  if (!raw) return null;
  let bin;
  const ll = raw.split(/[\s,]+/).map(Number);
  if (ll.length === 2 && ll.every(isFinite)) bin = l3.binOf(g, ll[0], Math.max(-90, Math.min(90, ll[1])));
  else if (/^\d+$/.test(raw)) bin = +raw;
  const b = bin && l3.binBounds(g, bin);
  return b ? { ...b, bin, g, at: ll.length === 2 && ll.every(isFinite) ? ll : null } : { bad: true };
}

// ---------------------------------------------------------------- texture

let coastPath = null;
const tex = document.createElement("canvas");
tex.width = TEX_W; tex.height = TEX_H;
const px = (lon, lat) => [((lon + 180) / 360) * TEX_W, ((90 - lat) / 180) * TEX_H];

function drawTexture(pick) {
  const ctx = tex.getContext("2d"), g = drawnGrid(), n = g.nrows, rh = TEX_H / n;
  // the basemap is already plate carree, like the texture
  const world = basemap && basemap.world;
  if (world) ctx.drawImage(world.canvas, 0, 0, TEX_W, TEX_H);
  ctx.globalAlpha = world ? 0.3 : 1;
  for (let r = 0; r < n; r++) {
    ctx.fillStyle = r % 2 ? COLORS.rowB : COLORS.rowA;
    ctx.fillRect(0, TEX_H - (r + 1) * rh, TEX_W, rh + 0.5);
  }
  ctx.globalAlpha = 1;
  if (state.coast && coastPath) {
    ctx.strokeStyle = COLORS.coast; ctx.lineWidth = 1.4; ctx.globalAlpha = 0.85;
    ctx.stroke(coastPath); ctx.globalAlpha = 1;
  }
  if (state.lines) {
    ctx.strokeStyle = COLORS.edge; ctx.lineWidth = n > 72 ? 0.7 : 1.4;
    ctx.beginPath();
    for (let r = 0; r <= n; r++) { const y = TEX_H - r * rh; ctx.moveTo(0, y); ctx.lineTo(TEX_W, y); }
    if (n <= 90) {
      for (let r = 0; r < n; r++) {
        const y0 = TEX_H - (r + 1) * rh, nb = g.numbin[r];
        for (let c = 1; c < nb; c++) { const x = (c / nb) * TEX_W; ctx.moveTo(x, y0); ctx.lineTo(x, y0 + rh); }
      }
    }
    ctx.stroke();
  }
  if (pick && !pick.bad) {
    // the drawn bin holding the pick, then the picked bin itself
    const at = pick.at || pick.centre;
    const db = l3.binBounds(g, l3.binOf(g, at[0], at[1]));
    if (pick.g !== g) {
      const [x0, y0] = px(db.west, db.north), [x1, y1] = px(db.east, db.south);
      ctx.fillStyle = "rgba(255,211,77,0.18)"; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    const [x0, y0] = px(pick.west, pick.north), [x1, y1] = px(pick.east, pick.south);
    ctx.strokeStyle = COLORS.pick; ctx.lineWidth = 3;
    if (x1 - x0 > 8) {
      ctx.fillStyle = "rgba(255,211,77,0.35)"; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    } else {
      const [x, y] = px(...pick.centre);
      ctx.beginPath(); ctx.arc(x, y, 10, 0, 2 * Math.PI); ctx.stroke();
      ctx.fillStyle = COLORS.pick; ctx.fillRect(x0, y0, Math.max(2, x1 - x0), Math.max(2, y1 - y0));
    }
  }
  texture.needsUpdate = true;
}

// ---------------------------------------------------------------- scene

const stage = document.getElementById("three");
const { renderer, scene, camera, controls, setCamera, resize } = makeStage(stage, {
  bg: COLORS.bg,
  onCamera: (c) => { state.cam = c; writeHash(); }
});

const DEFAULT_CAM = [0, 0.6, 8.2, 0, 0, 0];
setCamera(DEFAULT_CAM);

const texture = new THREE.CanvasTexture(tex);
texture.colorSpace = THREE.SRGBColorSpace;
texture.anisotropy = 4;
const sheet = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
scene.add(sheet);

// lon/lat (radians) in row r to the surface at unwrap t
function placer(t, g) {
  const a = Math.min(1, Math.max(0, 3 * t)), b = Math.min(1, Math.max(0, 3 * t - 1)), c = Math.min(1, Math.max(0, 3 * t - 2));
  const ub = Math.min(b, 0.9995), R = 1 / (1 - ub);
  return (lam, phi, r, out, i) => {
    const kr = g.numbin[r] / (2 * g.nrows), k = 1 + (kr - 1) * b;
    const h = Math.cos(phi) * (1 - a) + a;
    const th = lam * k * (1 - ub);
    out[i] = h * R * Math.sin(th) + c * Math.PI * (kr - 1);
    out[i + 1] = Math.sin(phi) * (1 - a) + phi * a;
    out[i + 2] = h * (R * Math.cos(th) - R + 1);
  };
}

let builtFor = -1, idx = null, uvs = null, verts = null;
function buildStrips(g) {
  // vertices per row: (NU + 1) x (NV + 1), rows kept apart so they can part
  const n = g.nrows, NV = Math.max(1, Math.round(36 / n));
  const v = [], uv = [], index = [];
  for (let r = 0; r < n; r++) {
    const base = v.length;
    const lat0 = -90 + (180 * r) / n, lat1 = lat0 + 180 / n;
    for (let j = 0; j <= NV; j++) {
      const lat = lat0 + ((lat1 - lat0) * j) / NV;
      for (let i = 0; i <= NU; i++) {
        const u = i / NU;
        v.push([(u - 0.5) * 2 * Math.PI, lat * D2R, r]);
        uv.push(u, (lat + 90) / 180);
      }
    }
    for (let j = 0; j < NV; j++)
      for (let i = 0; i < NU; i++) {
        const p = base + j * (NU + 1) + i, q = p + NU + 1;
        index.push(p, p + 1, q, p + 1, q + 1, q);
      }
  }
  verts = v; uvs = new Float32Array(uv); idx = index; builtFor = n;
}

function rebuildScene() {
  const g = drawnGrid();
  if (builtFor !== g.nrows) buildStrips(g);
  const place = placer(state.t, g), pos = new Float32Array(verts.length * 3);
  verts.forEach(([lam, phi, r], k) => place(lam, phi, r, pos, 3 * k));
  sheet.geometry.dispose();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  sheet.geometry = geo;
  // shrink the flat stages to fit the frame
  const b = Math.min(1, Math.max(0, 3 * state.t - 1));
  sheet.scale.setScalar(1 - 0.3 * b * b * (3 - 2 * b));
}

// ---------------------------------------------------------------- panel

const $ = (id) => document.getElementById(id);
const ui = {
  rows: $("rows"), rowsOut: $("rows-out"), t: $("t"), tOut: $("t-out"),
  grid: $("grid-rows"), bin: $("bin"), binRow: $("bin-row"), info: $("bin-info"), gridInfo: $("grid-info"),
  lines: $("gridlines"), coast: $("coast"), geojson: $("copy-geojson"),
  bm: $("basemap"), tif: $("download-tif")
};

// The picked bin as a GeoTIFF: a box in longitude and latitude.
const basemap = basemapControl({
  select: ui.bm, status: $("bm-status"), credit: $("credit"),
  onWorld: () => sync()
});
const ident = (a, b) => [a, b];
const tifOut = exportControl({
  button: ui.tif, size: $("tif-size"), status: $("bm-status"), bm: () => basemap.id,
  job: () => {
    const p = picked();
    if (!p || p.bad) return null;
    return {
      name: `playproj-l3bin-${p.g.nrows}-${p.bin}`, crs: { geographic: true },
      forward: ident, inverse: ident, box: [p.west, p.south, p.east, p.north]
    };
  }
});

const fmtArea = (a) => (a >= 100 ? Math.round(a).toLocaleString("en") : a.toPrecision(3)) + " km2";
const fmt = (x) => x.toFixed(4) + DEG;

function updatePanel(pick) {
  const dg = drawnGrid(), lg = lookupGrid();
  ui.rows.value = state.rows;
  ui.rowsOut.textContent = `${dg.nrows} (${dg.totbins.toLocaleString("en")} bins)`;
  ui.t.value = state.t;
  ui.tOut.textContent = state.t === 0 ? "globe" : state.t < 1 / 3 ? "to a cylinder" : state.t < 2 / 3 ? "opening"
    : Math.abs(state.t - 2 / 3) < 0.01 ? "sinusoidal rows" : state.t < 1 ? "sliding left" : "rows as stored";
  ui.grid.value = state.grid;
  ui.lines.checked = !!state.lines; ui.coast.checked = !!state.coast;
  if (document.activeElement !== ui.bin) ui.bin.value = state.bin;
  ui.bin.classList.toggle("bad", !!(pick && pick.bad));
  const side = Math.sqrt(l3.EARTH_AREA / lg.totbins);
  ui.gridInfo.textContent = `${lg.nrows.toLocaleString("en")} rows, ${lg.totbins.toLocaleString("en")} bins, about ` +
    `${side.toFixed(2)} km across; ${lg.numbin[lg.nrows >> 1].toLocaleString("en")} bins at the equator, ${lg.numbin[0]} at each pole.`;
  ui.geojson.disabled = !pick || pick.bad;
  if (!tifOut.busy) ui.tif.disabled = !pick || !!pick.bad || !basemap.world;
  if (pick && !pick.bad) {
    ui.binRow.textContent = `row ${pick.row + 1} of ${lg.nrows}, column ${pick.col + 1} of ${pick.numbin}`;
    ui.info.textContent = `Bin ${pick.bin.toLocaleString("en")}: centre ${fmt(pick.centre[0])}, ${fmt(pick.centre[1])}; ` +
      `${fmt(pick.west)} to ${fmt(pick.east)}, ${fmt(pick.south)} to ${fmt(pick.north)}; area ${fmtArea(l3.binArea(pick))}.`;
  } else {
    ui.binRow.textContent = "";
    ui.info.textContent = pick && pick.bad ? "Not a bin on this grid." : "Click the globe for the bin under the pointer.";
  }
}

let rafPending = false, redrawTex = true;
function sync(tex = true) {
  writeHash();
  redrawTex = redrawTex || tex;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const pick = picked();
    if (redrawTex) drawTexture(pick);
    redrawTex = false;
    rebuildScene();
    updatePanel(pick);
  });
}

ui.rows.addEventListener("input", () => { state.rows = +ui.rows.value; sync(); });
ui.t.addEventListener("input", () => { stopAnim(); state.t = +ui.t.value; sync(false); });
ui.grid.addEventListener("change", () => {
  // keep the same place when the grid changes
  const p = picked();
  state.grid = ui.grid.value;
  if (p && !p.bad && !p.at) state.bin = p.centre.map((x) => +x.toFixed(5)).join(", ");
  sync();
});
ui.bin.addEventListener("change", () => { state.bin = ui.bin.value.trim(); sync(); });
ui.lines.addEventListener("change", () => { state.lines = ui.lines.checked ? 1 : 0; sync(); });
ui.coast.addEventListener("change", () => { state.coast = ui.coast.checked ? 1 : 0; sync(); });
ui.geojson.addEventListener("click", (e) => {
  const p = picked();
  if (!p || p.bad) return;
  // edges along parallels are not great circles: give them points
  const ring = [], k = 8;
  for (let i = 0; i <= k; i++) ring.push([p.west + ((p.east - p.west) * i) / k, p.south]);
  for (let i = 0; i <= k; i++) ring.push([p.east - ((p.east - p.west) * i) / k, p.north]);
  ring.push(ring[0]);
  copyText(JSON.stringify({ type: "Feature", properties: { bin: p.bin, nrows: p.g.nrows, row: p.row + 1, col: p.col + 1 },
    geometry: { type: "Polygon", coordinates: [ring.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)])] } }), e.target);
});
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(DEFAULT_CAM); writeHash(); });

// click (not drag): the bin under the pointer
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObject(sheet)[0];
  if (!hit) return;
  state.bin = `${(hit.uv.x * 360 - 180).toFixed(4)}, ${(hit.uv.y * 180 - 90).toFixed(4)}`;
  sync();
});

let anim = false, dir = 1, lastT = 0;
const playBtn = $("play");
function stopAnim() { anim = false; playBtn.textContent = state.t >= 1 ? "Wrap" : "Unwrap"; }
playBtn.addEventListener("click", () => {
  if (anim) return stopAnim();
  anim = true; dir = state.t >= 1 ? -1 : 1; playBtn.textContent = "Stop"; lastT = performance.now();
});

shareLinks("L3 bins");

// ---------------------------------------------------------------- loop

function tick(now) {
  if (anim) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    state.t = Math.max(0, Math.min(1, state.t + dir * dt * 0.2));
    if (state.t === 1 || state.t === 0) stopAnim();
    sync(false);
  }
  lastT = now;
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

ui.bm.addEventListener("change", () => { state.bm = ui.bm.value; writeHash(); basemap.set(state.bm); });

window.addEventListener("hashchange", () => { readHash(); if (state.cam) setCamera(state.cam); basemap.set(state.bm); sync(); });

readHash();
if (state.cam) setCamera(state.cam);
resize();
sync();
basemap.set(state.bm);
loadCoastline("110m").then((lines) => {
  coastPath = new Path2D();
  for (const l of lines)
    for (let i = 0; i < l.length; i += 2) {
      const [x, y] = px(l[i], l[i + 1]);
      if (i && Math.abs(l[i] - l[i - 2]) < 180) coastPath.lineTo(x, y); else coastPath.moveTo(x, y);
    }
  sync();
  document.body.classList.add("ready");
});
requestAnimationFrame(tick);
