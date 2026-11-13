// playproj: how long is the Antarctic coast?
//
// The coast of Antarctica (or the Australian Antarctic Territory's part of
// it) against Australia's mainland, two ways: across, along the parallel,
// where Mercator draws everything sec(lat) too long; and around, with
// Richardson's dividers at rulers from 1 to 2000 km. Four panels: Mercator,
// a globe, the lengths as bars, and length against ruler on log scales.
// The arithmetic is in src/core/coastlen.js.

import * as K from "../src/core/coastlen.js";
import { loadCoastline } from "./data.js";
import { readParams, hashWriter, oneOf } from "../src/scene/hash.js";
import { shareLinks } from "../src/scene/share.js";

const d3 = window.d3;
const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";

const C = {
  bg: "#05070d", ocean: "#0b1426", world: "rgba(215,236,255,0.28)", grat: "rgba(140,196,255,0.14)", edge: "rgba(140,196,255,0.4)",
  ant: "#7fe0ff", antDim: "rgba(127,224,255,0.35)", aus: "#ffb35c", ausDim: "rgba(255,179,92,0.35)", par: "#ff7ab8", sector: "rgba(255,255,255,0.35)",
  step: "rgba(255,255,255,0.9)", merc: "#ffd34d", truth: "#6ab787", ink: "#dfe7f2", muted: "#8a97ab", axis: "rgba(223,231,242,0.35)", shade: "rgba(140,150,170,0.12)"
};

// Geoscience Australia, Border lengths (GEODATA Coast 100K 2004): mainland
const GA_MAINLAND = 35821;

// ---------------------------------------------------------------- state

const RULERS = K.RULERS;
const defaults = { ant: "aat", edge: "front", r: 50, lat: -66.5, div: 1, rot: "" };
const state = { ...defaults };
function readHash() {
  readParams(state, defaults, {
    ant: oneOf(["aat", "all"], "aat"), edge: oneOf(["front", "ground"], "front"),
    rot: (s) => (/^-?[\d.]+,-?[\d.]+$/.test(s) ? s : undefined)
  });
  if (!RULERS.includes(state.r)) state.r = RULERS.reduce((a, b) => (Math.abs(Math.log(b / state.r)) < Math.abs(Math.log(a / state.r)) ? b : a));
  state.lat = Math.max(-80, Math.min(-10, state.lat));
}
const writeHash = hashWriter(state, defaults, { digits: 2 });

const km = (v) => `${Math.round(v).toLocaleString("en")} km`;
const x2 = (v) => `${v.toFixed(v < 10 ? 2 : 1)} times`;
const latS = (lat) => `${Math.abs(lat).toFixed(1)}${DEG}${lat < 0 ? "S" : "N"}`;

// ---------------------------------------------------------------- data

let world = null, D = null;
const cache = new Map();
const memo = (k, f) => { if (!cache.has(k)) cache.set(k, f()); return cache.get(k); };

// the lines of a coast: aus, or ant with edge and aat/all
function lines(which, edge = state.edge, ant = state.ant) {
  if (which === "aus") return memo("aus", () => [D.aus]);
  return memo(`ant-${edge}-${ant}`, () => (ant === "aat" ? K.sectorPieces(D[edge], K.AAT) : [D[edge]]));
}
const keyOf = (which, edge = state.edge, ant = state.ant) => (which === "aus" ? "aus" : `ant-${edge}-${ant}`);

function stats(which, edge = state.edge, ant = state.ant) {
  return memo(`stats-${keyOf(which, edge, ant)}`, () => {
    const ls = lines(which, edge, ant);
    const len = ls.reduce((s, l) => s + K.length(l), 0);
    let w = 0, lat = 0;
    for (const l of ls) { const d = K.length(l); w += d; lat += d * K.meanLat(l); }
    const span = which === "aus" ? K.lonSpan(ls[0]).span : ant === "aat" ? K.AAT.reduce((s, [a, b]) => s + b - a, 0) : 360;
    return { len, lat: lat / w, span, rich: K.richardson(ls), step: K.medianStep(ls) };
  });
}

function walk(which, r, edge = state.edge, ant = state.ant) {
  return memo(`walk-${keyOf(which, edge, ant)}-${r}`, () => {
    const ws = lines(which, edge, ant).map((l) => K.divider(l, r));
    return {
      length: ws.reduce((s, w) => s + w.length, 0),
      merc: ws.reduce((s, w) => s + K.mercatorLength(w.marks), 0),
      marks: ws.map((w) => w.marks)
    };
  });
}

// ---------------------------------------------------------------- maps

const ML = (ls) => ({ type: "MultiLineString", coordinates: ls });
const parallel = (lat, w = -180, e = 180) => ({ type: "LineString", coordinates: Array.from({ length: 181 }, (_, i) => [w + (e - w) * i / 180, lat]) });
const meridian = (lon) => ({ type: "LineString", coordinates: [[lon, -60], [lon, -86]] });

let rot = null, drag = null;
const MAPS = {
  merc: {
    make: (w, h) => {
      const c = state.ant === "all" ? 105 : 110, half = state.ant === "all" ? 179.9 : 85;
      const p = d3.geoMercator().rotate([-c, 0]);
      return p.fitExtent([[10, 26], [w - 10, h - 10]], { type: "MultiPoint", coordinates: [[c - half, -84], [c + half, -8]] }).clipExtent([[0, 0], [w, h]]);
    },
    label: () => {
      const s = 1 / Math.cos(state.lat * Math.PI / 180);
      return `Mercator: ${latS(state.lat)} is drawn ${x2(s)} its true length`;
    }
  },
  globe: {
    make: (w, h) => d3.geoOrthographic().rotate(rot || [-110, 52]).fitExtent([[12, 26], [w - 12, h - 12]], { type: "Sphere" }),
    label: () => "Globe (orthographic): drag to turn"
  }
};

function drawMap(key) {
  const cv = $(`m-${key}`), { ctx, w, h } = canvas(cv);
  const proj = MAPS[key].make(w, h);
  MAPS[key].proj = proj;
  const path = d3.geoPath(proj, ctx);
  const stroke = (g, col, width = 1, dash = []) => { ctx.beginPath(); path(g); ctx.strokeStyle = col; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]); };
  ctx.beginPath(); path({ type: "Sphere" }); ctx.fillStyle = C.ocean; ctx.fill();
  stroke(d3.geoGraticule10(), C.grat);
  if (world) stroke(world, C.world);
  if (state.ant === "aat") for (const lon of [45, 136, 142, 160]) stroke(meridian(lon), C.sector, 1, [3, 4]);
  const other = state.edge === "front" ? "ground" : "front";
  stroke(ML(lines("ant", other)), C.antDim, 1, [2, 3]);
  stroke(ML(lines("ant")), state.div ? C.antDim : C.ant, state.div ? 3 : 1.6);
  stroke(ML(lines("aus")), state.div ? C.ausDim : C.aus, state.div ? 3 : 1.6);
  stroke(parallel(state.lat), C.par, 1.4, [5, 4]);
  if (state.div) {
    for (const [which, col] of [["ant", C.ant], ["aus", C.aus]]) {
      const wk = walk(which, state.r);
      stroke(ML(wk.marks), col, 1.2);
      ctx.fillStyle = C.step;
      if (state.r >= 100) for (const m of wk.marks) for (const p of m) { const q = proj(p); if (q && visible(proj, p)) { ctx.beginPath(); ctx.arc(q[0], q[1], 1.8, 0, 2 * Math.PI); ctx.fill(); } }
    }
  }
  stroke({ type: "Sphere" }, C.edge);
  $(`l-${key}`).textContent = MAPS[key].label();
}

function visible(proj, [lon, lat]) {
  let seen = false;
  proj.stream({ point() { seen = true; }, lineStart() {}, lineEnd() {}, polygonStart() {}, polygonEnd() {}, sphere() {} }).point(lon, lat);
  return seen;
}

function canvas(cv) {
  const box = cv.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, box.width), h = Math.max(10, box.height);
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
  return { ctx, w, h };
}

const antName = () => (state.ant === "aat" ? "AAT" : "Antarctica");

// ---------------------------------------------------------------- bars

function drawBars() {
  const { ctx, w, h } = canvas($("m-bars"));
  const A = stats("ant"), U = stats("aus"), wa = walk("ant", state.r), wu = walk("aus", state.r);
  const across = (s) => ({ t: K.parallelLength(s.lat, s.span), m: K.R * s.span * Math.PI / 180 });
  const aA = across(A), aU = across(U);
  const groups = [
    { title: `Across: the longitude span along the coast's mean parallel`, a: aA, u: aU },
    { title: `Around: dividers opened to ${state.r} km`, a: { t: wa.length, m: wa.merc }, u: { t: wu.length, m: wu.merc } }
  ];
  const left = 12, right = 12, top = 30, labelW = Math.min(170, w * 0.36);
  const rowH = Math.max(12, Math.min(22, (h - top - 20) / 13));
  const max = Math.max(...groups.flatMap((g) => [g.a.t, g.a.m, g.u.t, g.u.m]));
  const sx = (v) => (w - left - right - labelW - 70) * v / max;
  ctx.font = "12px system-ui, sans-serif"; ctx.textBaseline = "middle";
  let y = top;
  for (const g of groups) {
    ctx.fillStyle = C.ink; ctx.textAlign = "left"; ctx.fillText(g.title, left, y); y += rowH;
    const rows = [
      [`${antName()}, true`, g.a.t, C.truth, C.ant], [`${antName()}, on Mercator`, g.a.m, C.merc, C.ant],
      ["Australia, true", g.u.t, C.truth, C.aus], ["Australia, on Mercator", g.u.m, C.merc, C.aus]
    ];
    for (const [lab, v, col, who] of rows) {
      ctx.fillStyle = who; ctx.fillText(lab, left, y);
      ctx.fillStyle = col; ctx.fillRect(left + labelW, y - rowH * 0.32, Math.max(1, sx(v)), rowH * 0.64);
      ctx.fillStyle = C.ink; ctx.fillText(km(v), left + labelW + sx(v) + 6, y);
      y += rowH;
    }
    ctx.fillStyle = C.muted;
    ctx.fillText(`${antName()} / Australia: ${(g.a.t / g.u.t).toFixed(2)} true, ${(g.a.m / g.u.m).toFixed(2)} on Mercator`, left, y);
    y += rowH * 1.6;
  }
  $("l-bars").textContent = "Lengths: true (green) and as Mercator draws them at its equator scale (yellow)";
}

// ---------------------------------------------------------------- plot

function drawPlot() {
  const { ctx, w, h } = canvas($("m-plot"));
  const series = [
    { k: "aus", name: "Australia, mainland", col: C.aus, s: stats("aus"), bold: true },
    { k: "front", name: `${antName()}, ice front`, col: state.edge === "front" ? C.ant : C.antDim, s: stats("ant", "front"), bold: state.edge === "front" },
    { k: "ground", name: `${antName()}, grounding line`, col: state.edge === "ground" ? C.ant : C.antDim, s: stats("ant", "ground"), bold: state.edge === "ground" }
  ];
  const ys = series.flatMap((o) => o.s.rich.rows.map((r) => r.L)).concat([GA_MAINLAND]);
  const x0 = RULERS[0], x1 = RULERS[RULERS.length - 1];
  const y0 = Math.min(...ys) / 1.15, y1 = Math.max(...ys) * 1.15;
  const m = { l: 58, r: 14, t: 34, b: 58 };
  const X = (v) => m.l + (w - m.l - m.r) * Math.log(v / x0) / Math.log(x1 / x0);
  const Y = (v) => h - m.b - (h - m.t - m.b) * Math.log(v / y0) / Math.log(y1 / y0);
  ctx.font = "11px system-ui, sans-serif"; ctx.textBaseline = "middle";
  // below the data's own detail
  const detail = 2 * Math.max(...series.map((o) => o.s.step));
  ctx.fillStyle = C.shade; ctx.fillRect(X(x0), m.t, X(detail) - X(x0), h - m.t - m.b);
  ctx.fillStyle = C.muted; ctx.textAlign = "left"; ctx.fillText("finer than", X(x0) + 4, m.t + 10); ctx.fillText("the data", X(x0) + 4, m.t + 24);
  // axes, ticks at 1, 2, 5
  ctx.strokeStyle = C.axis; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(m.l, m.t); ctx.lineTo(m.l, h - m.b); ctx.lineTo(w - m.r, h - m.b); ctx.stroke();
  ctx.fillStyle = C.muted; ctx.textAlign = "center";
  for (const v of RULERS) { ctx.fillText(v >= 1000 ? `${v / 1000}k` : `${v}`, X(v), h - m.b + 12); }
  ctx.fillText("ruler, km (log)", (m.l + w - m.r) / 2, h - m.b + 28);
  ctx.textAlign = "right";
  for (let e = Math.floor(Math.log10(y0)); e <= Math.ceil(Math.log10(y1)); e++) for (const f of [1, 2, 5]) {
    const v = f * 10 ** e;
    if (v < y0 || v > y1) continue;
    ctx.fillText(v >= 1000 ? `${v / 1000}k` : `${v}`, m.l - 6, Y(v));
    ctx.beginPath(); ctx.moveTo(m.l - 3, Y(v)); ctx.lineTo(m.l, Y(v)); ctx.stroke();
  }
  ctx.save(); ctx.translate(14, (m.t + h - m.b) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillText("length, km (log)", 0, 0); ctx.restore();
  // Geoscience Australia's mainland length, from 1:100 000 maps
  ctx.strokeStyle = C.aus; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(m.l, Y(GA_MAINLAND)); ctx.lineTo(w - m.r, Y(GA_MAINLAND)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = C.aus; ctx.textAlign = "right"; ctx.fillText("Geoscience Australia, mainland from 1:100 000 data: 35 821 km", w - m.r - 2, Y(GA_MAINLAND) - 8);
  // the selected ruler
  ctx.strokeStyle = C.merc; ctx.beginPath(); ctx.moveTo(X(state.r), m.t); ctx.lineTo(X(state.r), h - m.b); ctx.stroke();
  // the series and their fits
  for (const o of series) {
    const rows = o.s.rich.rows;
    ctx.strokeStyle = o.col; ctx.lineWidth = o.bold ? 2 : 1.2;
    ctx.beginPath(); rows.forEach((r, i) => (i ? ctx.lineTo(X(r.r), Y(r.L)) : ctx.moveTo(X(r.r), Y(r.L)))); ctx.stroke();
    ctx.fillStyle = o.col;
    for (const r of rows) { ctx.beginPath(); ctx.arc(X(r.r), Y(r.L), o.bold ? 3 : 2, 0, 2 * Math.PI); ctx.fill(); }
    const f = o.s.rich, fy = (v) => Math.exp(f.intercept + f.slope * Math.log(v));
    ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(f.fitMin), Y(fy(f.fitMin))); ctx.lineTo(X(f.fitMax), Y(fy(f.fitMax))); ctx.stroke(); ctx.setLineDash([]);
  }
  // legend
  ctx.textAlign = "right"; ctx.font = "12px system-ui, sans-serif";
  let ly = Y(GA_MAINLAND) + 16;
  const lx = w - m.r - 4;
  for (const o of series) {
    ctx.fillStyle = C.bg; ctx.fillRect(lx - 250, ly - 8, 250, 16);
    ctx.fillStyle = o.col; ctx.fillRect(lx - 14, ly - 1, 14, 3);
    ctx.fillText(`${o.name}: D = ${o.s.rich.D.toFixed(2)}`, lx - 20, ly); ly += 16;
  }
  $("l-plot").textContent = "Richardson plot: length against ruler; dashed, the fit from 10 to 500 km";
}

// ---------------------------------------------------------------- readout

function readout() {
  const A = stats("ant"), U = stats("aus"), wa = walk("ant", state.r), wu = walk("aus", state.r);
  const r = (a, b, c) => `<tr><td>${a}</td><td style="text-align:right">${b}</td><td>${c}</td></tr>`;
  const sec = 1 / Math.cos(state.lat * Math.PI / 180);
  $("out").innerHTML = [
    r("", `<span style="color:${C.ant}">${antName()}</span>`, `<span style="color:${C.aus}">Australia</span>`),
    r("Longitude span", `${A.span.toFixed(1)}${DEG}`, `${U.span.toFixed(1)}${DEG}`),
    r("Mean latitude of the coast", latS(A.lat), latS(U.lat)),
    r("Across, true", km(K.parallelLength(A.lat, A.span)), km(K.parallelLength(U.lat, U.span))),
    r("Across, as Mercator draws it", km(K.R * A.span * Math.PI / 180), km(K.R * U.span * Math.PI / 180)),
    r(`Around, ${state.r} km ruler`, km(wa.length), km(wu.length)),
    r("Around, as Mercator draws it", km(wa.merc), km(wu.merc)),
    r("Mercator's stretch, overall", x2(wa.merc / wa.length), x2(wu.merc / wu.length)),
    r("Fractal dimension D", A.rich.D.toFixed(2), U.rich.D.toFixed(2)),
    r(`${latS(state.lat)}, all the way round`, km(K.parallelLength(state.lat, 360)), `drawn ${x2(sec)}`)
  ].join("");
}

// ---------------------------------------------------------------- UI

function syncUI() {
  $("ant").value = state.ant; $("edge").value = state.edge;
  $("ri").value = RULERS.indexOf(state.r); $("ri-out").textContent = `${state.r} km`;
  $("lat").value = state.lat; $("lat-out").textContent = latS(state.lat);
  $("div").checked = !!state.div;
}
$("ri").max = RULERS.length - 1;
$("ant").addEventListener("change", (e) => { state.ant = e.target.value; schedule(); });
$("edge").addEventListener("change", (e) => { state.edge = e.target.value; schedule(); });
$("ri").addEventListener("input", (e) => { state.r = RULERS[+e.target.value]; schedule(); });
$("lat").addEventListener("input", (e) => { state.lat = +e.target.value; schedule(); });
$("div").addEventListener("change", (e) => { state.div = e.target.checked ? 1 : 0; schedule(); });

const gcv = $("m-globe");
gcv.addEventListener("pointerdown", (e) => {
  const p = MAPS.globe.proj; if (!p) return;
  drag = { x: e.clientX, y: e.clientY, rot: p.rotate(), k: 180 / (Math.PI * p.scale()) };
  gcv.setPointerCapture(e.pointerId);
});
gcv.addEventListener("pointermove", (e) => {
  if (!drag) return;
  rot = [drag.rot[0] + (e.clientX - drag.x) * drag.k, Math.max(-90, Math.min(90, drag.rot[1] - (e.clientY - drag.y) * drag.k))];
  state.rot = `${(-rot[0]).toFixed(1)},${(-rot[1]).toFixed(1)}`;
  schedule();
});
gcv.addEventListener("pointerup", () => { drag = null; });

let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; render(); });
}

function render() {
  syncUI();
  writeHash();
  if (!D) return;
  drawMap("merc"); drawMap("globe"); drawBars(); drawPlot(); readout();
  document.body.classList.add("ready");
}

function rotFromState() {
  if (!state.rot) { rot = null; return; }
  const [lon, lat] = state.rot.split(",").map(Number);
  rot = [-lon, -lat];
}

new ResizeObserver(() => schedule()).observe($("stage"));
window.addEventListener("hashchange", () => { readHash(); rotFromState(); schedule(); });

shareLinks("How long is the Antarctic coast?", { height: 620 });
readHash();
rotFromState();
syncUI();
const pairs = (r) => { const o = []; for (let i = 0; i < r.length; i += 2) o.push([r[i], r[i + 1]]); return o; };
loadCoastline("50m").then((c) => { world = { type: "MultiLineString", coordinates: c.map(pairs) }; schedule(); }).catch(() => {});
fetch(new URL("../data/coast-south-10m.json", import.meta.url)).then((r) => r.json()).then((j) => {
  D = { aus: K.fromFlat(j.australia), ground: K.fromFlat(j.grounding), front: K.fromFlat(j.front) };
  schedule();
});
