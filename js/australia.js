// playproj: Australia, faceted
//
// Australia and its external territories, with and without Heard Island
// and the Australian Antarctic Territory, drawn as an overview panel that
// holds the true geography and the footprint of every other panel, and
// well sized panels each in its own CRS: the alternative to insets. Panels
// can be grouped (the Tasman Sea, the Indian Ocean Territories, ...) or one
// per territory, fitted to their land or all at one scale. Core in
// src/core/facets.js.

import * as F from "../src/core/facets.js";
import { centreOf } from "../src/core/inset.js";
import { readParams, hashWriter } from "../src/scene/hash.js";
import { shareLinks } from "../src/scene/share.js";

const $ = (id) => document.getElementById(id);
const COL = {
  bg: "#05070d", sea: "#081120", land: "#101a2c", piece: "#1c3152", edge: "#ffd34d", ctxEdge: "rgba(215,236,255,0.35)",
  frame: "rgba(127,224,255,0.9)", foot: "#ff7ab8", ink: "#dfe7f2", muted: "#8a97ab", grat: "rgba(140,196,255,0.16)"
};
const ALL = Object.keys(F.PIECES);
const NOT = (...xs) => ALL.filter((k) => !xs.includes(k));

const STEPS = [
  {
    title: "Australia in one panel",
    text: "The mainland and Tasmania, with King and Flinders Islands, on the Australian Albers (GDA2020, EPSG:9473). A frame around them is about half land. The left panel is the overview; the right holds the map. With one panel the overview has little to do.",
    set: { on: ["mainland", "tasmania"], split: 0, shared: 0, single: 0 }
  },
  {
    title: "Tasmania's Macquarie Island",
    text: "Macquarie Island is part of Tasmania, 1 500 km south-south-east of Hobart. One frame for the state and its island would be 37 percent land instead of 51. Here it gets a panel of its own on MGA zone 57, fitted to the island at about a hundred times the mainland's scale, and the overview shows where that panel sits.",
    set: { on: ["mainland", "tasmania", "macquarie"], split: 0, shared: 0, single: 0 }
  },
  {
    title: "The external territories, grouped",
    text: "Lord Howe (part of New South Wales) and Norfolk in the Tasman Sea, Christmas and Cocos in the Indian Ocean, Ashmore and Cartier and the Coral Sea Islands on the reefs, Macquarie in the Southern Ocean. One frame for all of them is 7 200 km wide and a fifth land. Grouped by where they are, each panel is a Lambert azimuthal on its group: the overview shows the groups, the panels show the islands are specks even together.",
    set: { on: NOT("heard", "aat"), split: 0, shared: 0, single: 0 }
  },
  {
    title: "One panel each",
    text: "Split the groups and each territory gets a panel in its own GDA2020 MGA zone, fitted to its land. Now every island is legible and the overview's footprints say where each panel is and how much of the world it covers. The specks of the Coral Sea Islands and Ashmore Reef are the size Natural Earth draws them.",
    set: { on: NOT("heard", "aat"), split: 1, shared: 0, single: 0 }
  },
  {
    title: "With Heard and McDonald Islands",
    text: "Heard Island and the McDonald Islands are 4 100 km south-west of Perth, closer to Antarctica and Africa than to Australia. In one frame they make it 280 km taller and 180 km wider for under 400 square kilometres of land. As a panel they cost nothing but a cell in the grid.",
    set: { on: NOT("aat"), split: 0, shared: 0, single: 0 }
  },
  {
    title: "With the Australian Antarctic Territory",
    text: "The AAT is Antarctica from 45 E to 160 E less Adelie Land, 5.9 million square kilometres: three quarters the size of the mainland. Adding it barely changes a single frame's share of land, because it is so big; it is the specks that are expensive. It gets its own panel on the Antarctic polar stereographic (EPSG:3031).",
    set: { on: ALL, split: 0, shared: 0, single: 0 }
  },
  {
    title: "Every panel at one scale",
    text: "Fitted panels are honest about shape and dishonest about size: Norfolk Island fills its panel as the AAT fills its own. Put every panel at the scale of the largest and the islands are what they are on the ground, a few pixels in an empty sea. That is what a single frame does to them too.",
    set: { on: ALL, split: 1, shared: 1, single: 0 }
  },
  {
    title: "One frame for everything",
    text: "All of it in one Lambert azimuthal on the middle of it: 7 700 by 8 700 km, a fifth land, and every territory but the AAT invisible at this size. This is the true-place map the panels and the overview stand in for.",
    set: { on: ALL, split: 0, shared: 0, single: 1 }
  },
  {
    title: "Your own grouping",
    text: "Choose the pieces, group them or split them, fit each panel or share one scale. The table gives each panel's CRS, the width it shows, its scale against the first panel and the share of it that is land, and what one frame for the same land would be.",
    set: { on: ALL, split: 0, shared: 0, single: 0 },
    build: true
  }
];

const defaults = { s: 0, on: "", split: 0, shared: 0, single: 0, grat: 0, ctx: 1 };
const state = { ...defaults };
const parseOn = () => state.on.split(",").filter((k) => F.PIECES[k]);
function readHash() {
  const h = readParams(state, defaults, { on: String, s: (r) => Math.max(0, Math.min(STEPS.length - 1, Math.round(+r) || 0)) });
  if (!h.has("on")) applyStep(STEPS[state.s].set);
}
function applyStep(st) { Object.assign(state, { on: st.on.join(","), split: st.split, shared: st.shared, single: st.single }); }
readHash();
const writeHash = hashWriter(state, defaults, {});

let data = null;
const map = $("map");

// ---------------------------------------------------------------- drawing

function ringPath(ctx, xy, P) {
  ctx.beginPath();
  let pen = false, lx = 0;
  for (let i = 0; i < xy.length; i += 2) {
    const [x, y] = P(xy[i], xy[i + 1]);
    if (!isFinite(x) || !isFinite(y) || (pen && Math.abs(x - lx) > 2000)) { pen = false; continue; }
    pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    pen = true; lx = x;
  }
  ctx.closePath();
}
function halo(ctx, text, x, y, colour = COL.ink) {
  ctx.strokeStyle = "rgba(5,7,13,0.85)"; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.strokeText(text, x, y);
  ctx.fillStyle = colour; ctx.fillText(text, x, y);
}
const NICE = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
function bar(ctx, x, y, pxPerKm, max) {
  const km = [...NICE].reverse().find((k) => k * pxPerKm <= max) || 0.5, L = km * pxPerKm;
  ctx.strokeStyle = COL.ink; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + L, y); ctx.lineTo(x + L, y - 4); ctx.stroke();
  ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
  halo(ctx, `${km.toLocaleString("en")} km`, x, y - 4);
}

// draw land in a cell: `proj` (lon, lat) -> metres, a centre and pixels per metre
function drawCell(ctx, cell, proj, cx, cy, s, pieceKeys, grat) {
  const [X, Y, W, H] = cell;
  const P = (lon, lat) => { const [x, y] = proj(lon, lat); return [X + W / 2 + (x - cx) * s, Y + H / 2 + 8 - (y - cy) * s]; };
  ctx.save();
  ctx.beginPath(); ctx.rect(X, Y, W, H); ctx.fillStyle = COL.sea; ctx.fill(); ctx.clip();
  if (grat) {
    ctx.strokeStyle = COL.grat; ctx.lineWidth = 1;
    for (let lon = 0; lon <= 180; lon += 10) { const xy = []; for (let lat = -90; lat <= 0; lat += 2) xy.push(lon, lat); open(ctx, xy, P); }
    for (let lat = -80; lat <= 0; lat += 10) { const xy = []; for (let lon = 30; lon <= 180; lon += 2) xy.push(lon, lat); open(ctx, xy, P); }
  }
  if (state.ctx) {
    ctx.fillStyle = COL.land; ctx.strokeStyle = COL.ctxEdge; ctx.lineWidth = 0.8;
    for (const u of data.context) for (const r of u.rings) { ringPath(ctx, r, P); ctx.fill(); ctx.stroke(); }
  }
  ctx.fillStyle = COL.piece; ctx.strokeStyle = COL.edge; ctx.lineWidth = 1;
  for (const k of pieceKeys) for (const r of data.pieces[k]) { ringPath(ctx, r, P); ctx.fill("evenodd"); ctx.stroke(); }
  ctx.restore();
  return P;
}
function open(ctx, xy, P) {
  ctx.beginPath();
  let pen = false, lx = 0;
  for (let i = 0; i < xy.length; i += 2) {
    const [x, y] = P(xy[i], xy[i + 1]);
    if (!isFinite(x) || !isFinite(y) || (pen && Math.abs(x - lx) > 2000)) { pen = false; continue; }
    pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true; lx = x;
  }
  ctx.stroke();
}

let model = null;
const centreCache = new Map();
function centreOfPanel(p) {
  const k = p.pieces.join(",");
  if (!centreCache.has(k)) centreCache.set(k, centreOf(p.pieces.flatMap((q) => data.pieces[q])));
  return centreCache.get(k);
}
function build(w, h) {
  const on = parseOn();
  const ps = state.single ? [] : F.panels(data, on, !!state.split);
  const geo = ps.map((p) => F.panelGeometry(data, p));
  const L = F.layout(ps.length, w, h, ps.length ? 0.42 : 1);
  const scales = geo.map((g, i) => F.fitScale(g.box, L.cells[i]));
  const shared = Math.min(...scales);
  const one = on.length ? F.oneFrame(data, on) : null;
  return { on, ps, geo, L, scales: state.shared ? scales.map(() => shared) : scales, one };
}

function draw() {
  const box = map.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, box.width), h = Math.max(10, box.height);
  map.width = Math.round(w * dpr); map.height = Math.round(h * dpr);
  const ctx = map.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, w, h);
  if (!data) return;
  model = build(w, h);
  const { ps, geo, L, scales, one, on } = model;
  if (!one) return;

  // panels first, so their rectangles are known to the overview
  const rects = [];
  ps.forEach((p, i) => {
    const cell = L.cells[i], g = geo[i], s = scales[i];
    const cx = (g.box[0] + g.box[2]) / 2, cy = (g.box[1] + g.box[3]) / 2;
    drawCell(ctx, cell, p.crs.forward, cx, cy, s, p.pieces, state.grat);
    // what the panel shows, in its own metres
    const hw = cell[2] / 2 / s, hh = cell[3] / 2 / s;
    rects.push([cx - hw, cy + 8 / s - hh, cx + hw, cy + 8 / s + hh]);
    ctx.strokeStyle = COL.frame; ctx.lineWidth = 1.2; ctx.strokeRect(cell[0] + 0.5, cell[1] + 0.5, cell[2] - 1, cell[3] - 1);
    ctx.font = "bold 12px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top";
    halo(ctx, `${i + 1}  ${p.name}`, cell[0] + 6, cell[1] + 5, COL.frame);
    ctx.font = "10px system-ui, sans-serif";
    halo(ctx, p.epsg ? `${p.crsName} (${p.epsg})` : p.crsName, cell[0] + 6, cell[1] + 20, COL.muted);
    bar(ctx, cell[0] + 8, cell[1] + cell[3] - 8, 1000 * s, Math.min(110, cell[2] * 0.45));
  });

  // the overview: true geography and the footprint of every panel
  const ov = L.overview, og = one.crs, ob = one.box;
  const os = F.fitScale(ob, ov, 0.08, 24);
  const ocx = (ob[0] + ob[2]) / 2, ocy = (ob[1] + ob[3]) / 2;
  const P = drawCell(ctx, ov, og.forward, ocx, ocy, os, on, state.grat || state.single);
  ctx.save(); ctx.beginPath(); ctx.rect(...ov); ctx.clip();
  ctx.font = "bold 12px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ps.forEach((p, i) => {
    const fp = F.footprint(p, rects[i]);
    const pts = fp.map(([lon, lat]) => P(lon, lat)).filter(([x, y]) => isFinite(x) && isFinite(y));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    ctx.strokeStyle = COL.foot; ctx.lineWidth = 1.4;
    if (x1 - x0 < 10 && y1 - y0 < 10) {
      ctx.beginPath(); ctx.arc((x0 + x1) / 2, (y0 + y1) / 2, 7, 0, 2 * Math.PI); ctx.stroke();
    } else {
      ctx.beginPath(); pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke();
    }
    // the number goes next to the panel's land, which is always on the overview
    const [lx, ly] = P(...centreOfPanel(p));
    halo(ctx, String(i + 1), lx + 14, ly - 10, COL.foot);
  });
  ctx.restore();
  ctx.strokeStyle = COL.ink; ctx.lineWidth = 1.2; ctx.strokeRect(ov[0] + 0.5, ov[1] + 0.5, ov[2] - 1, ov[3] - 1);
  ctx.font = "bold 12px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top";
  halo(ctx, state.single ? "One frame for everything" : "Overview", ov[0] + 6, ov[1] + 5);
  ctx.font = "10px system-ui, sans-serif";
  halo(ctx, og.proj.replace(" +ellps=GRS80 +units=m +no_defs", ""), ov[0] + 6, ov[1] + 20, COL.muted);
  bar(ctx, ov[0] + 8, ov[1] + ov[3] - 8, 1000 * os, Math.min(130, ov[2] * 0.4));
}

// ---------------------------------------------------------------- readouts

const km = (m) => Math.round(m / 1000).toLocaleString("en");
const pct = (v) => (v > 0 && v < 0.001 ? "under 0.1%" : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`);
const fmtX = (v) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2));
function readouts() {
  if (!model || !model.one) { $("stats").innerHTML = ""; $("panels").innerHTML = ""; return; }
  const { ps, geo, scales, one } = model;
  const rows = [
    ["One frame for this land", `${km(one.width)} x ${km(one.height)} km`],
    ["Share of that frame that is land", pct(one.fill)],
    ["Land", `${Math.round(one.ground / 1e6).toLocaleString("en")} km\u00b2`]
  ];
  $("stats").innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("");
  if (!ps.length) { $("panels").innerHTML = ""; return; }
  const head = `<tr><td><b>Panel</b></td><td><b>Shows</b></td><td><b>Scale</b></td><td><b>Land in it</b></td></tr>`;
  $("panels").innerHTML = head + ps.map((p, i) => {
    const cell = model.L.cells[i], s = scales[i], shownW = cell[2] / s, shownH = cell[3] / s;
    return `<tr><td>${i + 1} ${p.name}<br><span class="hint">${p.epsg || p.crsName}</span></td><td>${km(shownW)} km wide</td><td>x${fmtX(s / scales[0])}</td><td>${pct(geo[i].area / (shownW * shownH))}</td></tr>`;
  }).join("");
}

// ---------------------------------------------------------------- UI

function buildPicker() {
  const on = parseOn();
  $("picker").innerHTML = ALL.map((k) => `<label><input type="checkbox" data-k="${k}" ${on.includes(k) ? "checked" : ""}> ${F.PIECES[k].name}</label>`).join("");
  for (const el of $("picker").querySelectorAll("input")) el.addEventListener("change", () => {
    const set = new Set(parseOn());
    el.checked ? set.add(el.dataset.k) : set.delete(el.dataset.k);
    state.on = ALL.filter((k) => set.has(k)).join(",");
    sync();
  });
}
for (const k of ["split", "shared", "single", "grat", "ctx"]) $(k).addEventListener("change", (e) => { state[k] = e.target.checked ? 1 : 0; sync(); });

STEPS.forEach((st, k) => {
  const li = document.createElement("li");
  li.textContent = st.title;
  li.addEventListener("click", () => goStep(k));
  $("steps").appendChild(li);
});
function goStep(k) {
  state.s = Math.max(0, Math.min(STEPS.length - 1, k));
  applyStep(STEPS[state.s].set);
  sync();
}
$("prev").addEventListener("click", () => goStep(state.s - 1));
$("next").addEventListener("click", () => goStep(state.s + 1));

function sync() {
  const st = STEPS[state.s];
  $("step-title").textContent = st.title;
  $("caption").textContent = st.text;
  $("count").textContent = `${state.s + 1} of ${STEPS.length}`;
  $("prev").disabled = state.s === 0;
  $("next").disabled = state.s === STEPS.length - 1;
  [...$("steps").children].forEach((li, k) => li.classList.toggle("active", k === state.s));
  for (const k of ["split", "shared", "single", "grat", "ctx"]) $(k).checked = !!state[k];
  buildPicker();
  draw(); readouts(); writeHash();
}

window.addEventListener("hashchange", () => { readHash(); sync(); });
new ResizeObserver(() => { if (data) { draw(); readouts(); } }).observe(map.parentElement);
shareLinks("playproj: Australia, faceted", { height: 620 });
sync();
fetch(new URL("../data/australia-10m.json", import.meta.url))
  .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
  .then((d) => { data = d; sync(); })
  .catch((e) => { $("stats").innerHTML = `<tr><td>The coastlines did not load (${e.message}).</td></tr>`; });
