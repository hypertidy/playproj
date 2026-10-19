// playproj: VicGrid
//
// South-east Australia drawn in one grid's own eastings and northings
// (VicGrid, MGA 54 or 55, NSW or SA Lambert, Australian Albers, or
// Vicgrid66 on AGD66), with the state borders, the MGA zone edges, another
// grid's 100 km lines and the scale error shaded. The readout gives the
// point under the pointer in every grid. Projections and datum shifts are
// src/core/vicgrid.js.

import * as V from "../src/core/vicgrid.js";
import { readParams, hashWriter, shareLinks, oneOf } from "../src/scene/index.js";

const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";

const C = {
  bg: "#05070d", land: "#101a2c", vic: "#16253f", border: "rgba(215,236,255,0.7)", vicBorder: "#ffd34d",
  grat: "rgba(140,196,255,0.18)", zone: "#ff7ab8", over: "rgba(127,224,255,0.55)", own: "rgba(106,183,135,0.55)",
  par: "rgba(255,179,71,0.8)", town: "#f2f6fb", pin: "#ffd34d", ink: "#dfe7f2", muted: "#8a97ab"
};

const ORDER = ["vicgrid", "vicgrid94", "vicgrid66", "mga54", "mga55", "nsw", "sa", "albers"];
const TOWNS = [
  ["Melbourne", 144.9631, -37.8136], ["Geelong", 144.3607, -38.1499], ["Ballarat", 143.8503, -37.5622],
  ["Bendigo", 144.2794, -36.757], ["Mildura", 142.1543, -34.2087], ["Wodonga", 146.8888, -36.1218],
  ["Warrnambool", 142.4847, -38.3818], ["Sale", 147.0657, -38.1067], ["Mount Gambier", 140.7807, -37.8284],
  ["Adelaide", 138.6007, -34.9285], ["Canberra", 149.13, -35.2809], ["Sydney", 151.2093, -33.8688], ["Hobart", 147.3272, -42.8821]
];
// standard parallels, for the conics
const PARALLELS = { vicgrid: [-36, -38], vicgrid94: [-36, -38], vicgrid66: [-36, -38], nsw: [-30.75, -35.75], sa: [-28, -36], albers: [-18, -36] };

// ---------------------------------------------------------------- state

const defaults = { crs: "vicgrid", over: "mga", shade: 1, zones: 1, grat: 0, towns: 1, v: "145.3,-37.2,1150", pt: "" };
const state = { ...defaults };
function readHash() {
  readParams(state, defaults, { crs: oneOf(ORDER, "vicgrid"), over: oneOf(["mga", "vicgrid", "map", "none"], "mga"), v: String, pt: String });
}
readHash();
const writeHash = hashWriter(state, defaults);

const parseV = () => {
  const v = state.v.split(",").map(Number);
  return v.length === 3 && v.every(isFinite) && v[2] > 5 ? v : defaults.v.split(",").map(Number);
};
const pinned = () => {
  const v = state.pt.split(",").map(Number);
  return v.length === 2 && v.every(isFinite) ? v : null;
};

// ---------------------------------------------------------------- view

const map = $("map");
let states = [], view = null, hover = null;

// the view: map coordinates to pixels, from the centre and width in the map's own grid
function makeView(w, h) {
  const [lon, lat, km] = parseV();
  const [cx, cy] = V.toGrid(state.crs, lon, lat);
  const s = w / (km * 1000);
  return {
    w, h, cx, cy, s,
    px: (E, N) => [w / 2 + (E - cx) * s, h / 2 - (N - cy) * s],
    en: (x, y) => [cx + (x - w / 2) / s, cy - (y - h / 2) / s]
  };
}
const fwd = (lon, lat) => V.toGrid(state.crs, lon, lat);
const inv = (E, N) => V.fromGrid(state.crs, E, N);

// ---------------------------------------------------------------- drawing

function draw() {
  const box = map.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, box.width), h = Math.max(10, box.height);
  map.width = Math.round(w * dpr); map.height = Math.round(h * dpr);
  const ctx = map.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
  view = makeView(w, h);

  const ringPath = (ring) => {
    ctx.beginPath();
    for (let i = 0; i < ring.length; i += 2) {
      const [x, y] = view.px(...fwd(ring[i], ring[i + 1]));
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
  };
  for (const st of states) {
    ctx.fillStyle = st.abbr === "VIC" ? C.vic : C.land;
    for (const r of st.rings) { ringPath(r); ctx.fill(); }
  }
  if (state.shade) shade(ctx);
  if (state.grat) {
    for (let lon = 110; lon <= 156; lon++) line(ctx, (t) => [lon, -45 + 37 * t], C.grat, 1);
    for (let lat = -45; lat <= -8; lat++) line(ctx, (t) => [110 + 46 * t, lat], C.grat, 1);
  }
  for (const st of states) {
    ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    for (const r of st.rings) { ringPath(r); ctx.stroke(); }
  }
  const vic = states.find((s) => s.abbr === "VIC");
  if (vic) { ctx.strokeStyle = C.vicBorder; ctx.lineWidth = 2; for (const r of vic.rings) { ringPath(r); ctx.stroke(); } }

  // standard parallels of the map's conic
  const par = PARALLELS[state.crs];
  if (par) for (const lat of par) line(ctx, (t) => [110 + 46 * t, lat], C.par, 1.3, [6, 5], `${-lat}${DEG}S standard parallel`);

  if (state.over !== "none") gridLines(ctx);
  if (state.zones) {
    for (let lon = 108; lon <= 156; lon += 6) line(ctx, (t) => [lon, -46 + 38 * t], C.zone, 2, [], null);
    ctx.font = "bold 13px system-ui, sans-serif"; ctx.fillStyle = C.zone; ctx.textAlign = "center"; ctx.textBaseline = "top";
    // labels along the top of the view
    const top = inv(...view.en(w / 2, 34))[1];
    for (let z = 49; z <= 56; z++) {
      const lon = 6 * z - 183;
      const [x, y] = view.px(...fwd(lon, top));
      if (x > 0 && x < w && y > 0 && y < h) ctx.fillText(`MGA ${z}`, x, y);
    }
  }
  if (state.towns) {
    ctx.font = "12px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    for (const [name, lon, lat] of TOWNS) {
      const [x, y] = view.px(...fwd(lon, lat));
      if (x < -50 || x > w + 50 || y < -20 || y > h + 20) continue;
      ctx.fillStyle = C.town; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = C.ink; ctx.fillText(name, x + 5, y);
    }
  }
  const p = pinned();
  if (p) {
    const [x, y] = view.px(...fwd(p[0], p[1]));
    ctx.strokeStyle = C.pin; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, 2 * Math.PI); ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y); ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10); ctx.stroke();
  }
  scaleBar(ctx);
  $("map-label").textContent = `${V.CRS[state.crs].name} (EPSG:${V.CRS[state.crs].epsg}): eastings and northings as drawn`;
}

// a lon/lat curve t in [0, 1] -> [lon, lat], projected and stroked
function line(ctx, f, colour, width, dash = [], label = null) {
  ctx.beginPath();
  let first = true, last = null;
  for (let i = 0; i <= 200; i++) {
    const [x, y] = view.px(...fwd(...f(i / 200)));
    if (!isFinite(x) || !isFinite(y)) { first = true; continue; }
    first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    first = false;
    if (x > 8 && x < view.w - 160 && y > 8 && y < view.h - 8) last = [x, y];
  }
  ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]);
  if (label && last) {
    ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = colour; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillText(label, last[0] - 150, last[1] - 3);
  }
}

// another grid's 100 km lines, drawn in the map's grid; MGA's are clipped to their zones
function gridLines(ctx) {
  const lists = state.over === "mga" ? [["mga54", 138, 144], ["mga55", 144, 150]]
    : state.over === "vicgrid" ? [["vicgrid", 136, 155]] : [[state.crs, -180, 180]];
  const colour = state.over === "map" ? C.own : C.over;
  for (const [id, lo0, lo1] of lists) {
    // the grid's extent over the region, in its own coordinates
    let e0 = Infinity, e1 = -Infinity, n0 = Infinity, n1 = -Infinity;
    if (id === state.crs) {
      [e0, n1] = view.en(0, 0); [e1, n0] = view.en(view.w, view.h);
    } else {
      for (let lon = Math.max(lo0, 134); lon <= Math.min(lo1, 154); lon += 1) for (let lat = -44; lat <= -28; lat += 1) {
        const [E, N] = V.toGrid(id, lon, lat);
        e0 = Math.min(e0, E); e1 = Math.max(e1, E); n0 = Math.min(n0, N); n1 = Math.max(n1, N);
      }
    }
    // 100 km lines, or 500 km when the view is wider than a few thousand km
    const step = view.w / view.s > 2.5e6 ? 5e5 : 1e5;
    const clip = (E, N) => { const [lon] = V.fromGrid(id, E, N); return lon >= lo0 - 1e-9 && lon <= lo1 + 1e-9; };
    ctx.strokeStyle = colour; ctx.lineWidth = 1;
    const seg = (pts) => {
      ctx.beginPath(); let on = false;
      for (const [E, N] of pts) {
        if (!clip(E, N)) { on = false; continue; }
        const [lon, lat] = V.fromGrid(id, E, N), [x, y] = view.px(...fwd(lon, lat));
        on ? ctx.lineTo(x, y) : ctx.moveTo(x, y); on = true;
      }
      ctx.stroke();
    };
    const n = 60;
    for (let E = Math.ceil(e0 / step) * step; E <= e1; E += step) seg(Array.from({ length: n + 1 }, (_, i) => [E, n0 + (n1 - n0) * i / n]));
    for (let N = Math.ceil(n0 / step) * step; N <= n1; N += step) seg(Array.from({ length: n + 1 }, (_, i) => [e0 + (e1 - e0) * i / n, N]));
  }
}

// scale error (k - 1, parts per million) of the map's grid, every few pixels
const SHADE = [[-1000, 40, 80, 200], [-300, 70, 130, 230], [-100, 150, 190, 240], [0, 240, 240, 240], [100, 250, 205, 140], [300, 245, 150, 70], [1000, 200, 50, 50]];
function shadeColour(v) {
  if (v <= SHADE[0][0]) return SHADE[0].slice(1);
  for (let i = 1; i < SHADE.length; i++) if (v <= SHADE[i][0]) {
    const [z0, r0, g0, b0] = SHADE[i - 1], [z1, r1, g1, b1] = SHADE[i], t = (v - z0) / (z1 - z0);
    return [r0 + t * (r1 - r0), g0 + t * (g1 - g0), b0 + t * (b1 - b0)];
  }
  return SHADE[SHADE.length - 1].slice(1);
}
function shade(ctx) {
  const step = 4, W = Math.ceil(view.w / step), H = Math.ceil(view.h / step);
  const off = document.createElement("canvas"); off.width = W; off.height = H;
  const oc = off.getContext("2d"), img = oc.createImageData(W, H), c = V.CRS[state.crs];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const [E, N] = view.en((i + 0.5) * step, (j + 0.5) * step);
    const [lon, lat] = c.inverse(E, N);
    if (!isFinite(lon) || !isFinite(lat) || Math.abs(lat) > 89) continue;
    const ppm = (c.k(lon, lat) - 1) * 1e6, [r, g, b] = shadeColour(ppm), o = 4 * (j * W + i);
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 52;
  }
  oc.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, W * step, H * step);
}

function scaleBar(ctx) {
  const km = [10, 20, 50, 100, 200, 500, 1000].find((k) => k * 1000 * view.s > 80) || 1000;
  const L = km * 1000 * view.s, x = view.w - L - 16, y = view.h - 36;
  ctx.strokeStyle = C.ink; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + L, y); ctx.lineTo(x + L, y - 5); ctx.stroke();
  ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = C.ink; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  ctx.fillText(`${km} grid km`, x + L / 2, y - 4);
  if (state.shade) {
    ctx.textAlign = "right"; ctx.textBaseline = "top"; ctx.fillStyle = C.muted;
    ctx.fillText("Scale error: blue, distances too short; red, too long", view.w - 12, 10);
  }
}

// ---------------------------------------------------------------- readout

const fmtLL = (lon, lat) => `${Math.abs(lat).toFixed(5)}${DEG}${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(5)}${DEG}E`;
const num = (v) => Math.round(v).toLocaleString("en");
const ppm = (k) => `${k >= 1 ? "+" : "-"}${Math.abs((k - 1) * 1e6).toFixed(0)} ppm`;

function readout() {
  const p = hover || pinned() || [144.9631, -37.8136];
  const [lon, lat] = p, zone = V.mgaZone(lon);
  const rows = [[hover ? "Under the pointer" : pinned() ? "Pinned" : "Melbourne", `${fmtLL(lon, lat)} GDA2020`]];
  for (const id of ORDER) {
    const c = V.CRS[id], [E, N] = V.toGrid(id, lon, lat), ll = c.datum === "GDA2020" ? [lon, lat] : V.shift(lon, lat, "GDA2020", c.datum);
    const k = c.k(ll[0], ll[1]);
    const inZone = !id.startsWith("mga") || +id.slice(3) === zone;
    const name = `${c.name}<br><span class="hint">EPSG:${c.epsg}${inZone ? "" : ", outside its zone"}</span>`;
    rows.push([id === state.crs ? `<b>${name}</b>` : name, `E ${num(E)}<br>N ${num(N)}<br><span class="hint">k ${ppm(k)}${c.kind === "equal-area" ? " along the parallel" : ""}</span>`]);
  }
  const a = V.shift(lon, lat, "GDA2020", "AGD66"), b = V.shift(lon, lat, "GDA2020", "GDA94");
  rows.push(["MGA zone here", `${zone}`]);
  rows.push(["Same point on GDA94", `${V.nearDistance(b[0], b[1], lon, lat).toFixed(2)} m away in lon/lat`]);
  rows.push(["Same point on AGD66", `${V.nearDistance(a[0], a[1], lon, lat).toFixed(0)} m away in lon/lat`]);
  $("out").innerHTML = rows.map(([x, y]) => `<tr><td>${x}</td><td>${y}</td></tr>`).join("") +
    `<tr><td colspan="2" style="text-align:left"><span class="hint">PROJ string of the map:</span><br><code style="font-size:11px;word-break:break-all">${V.CRS[state.crs].proj}</code></td></tr>`;
}

// ---------------------------------------------------------------- UI

const sel = $("crs");
for (const id of ORDER) sel.add(new Option(`${V.CRS[id].name} (EPSG:${V.CRS[id].epsg})`, id));
sel.addEventListener("change", () => { state.crs = sel.value; sync(); });
$("over").addEventListener("change", (e) => { state.over = e.target.value; sync(); });
for (const k of ["shade", "zones", "grat", "towns"]) $(k).addEventListener("change", (e) => { state[k] = e.target.checked ? 1 : 0; sync(); });
$("reset-view").addEventListener("click", () => { state.v = defaults.v; sync(); });

// pan and zoom keep the view as a lon/lat centre and a width, so it survives a change of grid
function setView(cE, cN, widthM) {
  const [lon, lat] = inv(cE, cN);
  state.v = `${lon.toFixed(4)},${lat.toFixed(4)},${Math.round(widthM / 1000)}`;
}
let drag = null;
map.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, moved: false, cx: view.cx, cy: view.cy }; map.setPointerCapture(e.pointerId); });
map.addEventListener("pointermove", (e) => {
  const r = map.getBoundingClientRect();
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 3) drag.moved = true;
    if (drag.moved) { setView(drag.cx - dx / view.s, drag.cy + dy / view.s, view.w / view.s); draw(); }
    return;
  }
  hover = inv(...view.en(e.clientX - r.left, e.clientY - r.top));
  readout();
});
map.addEventListener("pointerup", (e) => {
  if (drag && !drag.moved) {
    const r = map.getBoundingClientRect(), [lon, lat] = inv(...view.en(e.clientX - r.left, e.clientY - r.top));
    state.pt = `${lon.toFixed(5)},${lat.toFixed(5)}`;
  }
  drag = null; sync();
});
map.addEventListener("pointerleave", () => { hover = null; readout(); });
map.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = map.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const f = Math.exp(e.deltaY * 0.0015), [E, N] = view.en(mx, my);
  const s = Math.max(view.w / 6e6, Math.min(view.w / 2e4, view.s / f));
  // keep the point under the pointer still
  setView(E - (mx - view.w / 2) / s, N + (my - view.h / 2) / s, view.w / s);
  sync();
}, { passive: false });

function sync() {
  sel.value = state.crs; $("over").value = state.over;
  for (const k of ["shade", "zones", "grat", "towns"]) $(k).checked = !!state[k];
  draw(); readout(); writeHash();
}

window.addEventListener("hashchange", () => { readHash(); sync(); });
new ResizeObserver(() => { if (states.length) draw(); }).observe(map.parentElement);
shareLinks("playproj: VicGrid", { height: 560 });

fetch(new URL("../data/aus-states-10m.json", import.meta.url))
  .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
  .then((d) => { states = d; sync(); })
  .catch((e) => { $("out").innerHTML = `<tr><td>The state borders did not load (${e.message}).</td></tr>`; sync(); });
