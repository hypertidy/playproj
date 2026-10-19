// playproj: rhumb lines and great circles
//
// Two places and the two ways between them, the rhumb line (one compass
// course) and the great circle (the shortest way), drawn on four maps at
// once: a globe, Mercator (the rhumb line is straight), gnomonic (the great
// circle is straight), and either an azimuthal equidistant map on the start
// or a south polar stereographic. Lengths and courses on WGS84 come from
// src/core/rhumb.js.

import * as H from "../src/core/rhumb.js";
import { PLACES } from "../src/core/track.js";
import { loadCoastline } from "./data.js";
import { readParams, hashWriter, shareLinks, oneOf } from "../src/scene/index.js";

const d3 = window.d3;
const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";

const C = {
  bg: "#05070d", ocean: "#0b1426", coast: "rgba(215,236,255,0.6)", grat: "rgba(140,196,255,0.16)", edge: "rgba(140,196,255,0.4)",
  gc: "#7fe0ff", rhumb: "#ffd34d", lox: "rgba(255,211,77,0.35)", comp: "#6ab787", lim: "rgba(255,93,93,0.75)",
  a: "#ff7ab8", b: "#f2f6fb", ink: "#dfe7f2", muted: "#8a97ab"
};

// the Antarctic gateways and stations
const SITES = {
  ...PLACES,
  capetown: { name: "Cape Town", lon: 18.4241, lat: -33.9249 },
  fremantle: { name: "Fremantle", lon: 115.7439, lat: -32.0569 },
  lyttelton: { name: "Lyttelton", lon: 172.7194, lat: -43.6033 },
  puntaarenas: { name: "Punta Arenas", lon: -70.9171, lat: -53.1638 },
  ushuaia: { name: "Ushuaia", lon: -68.3029, lat: -54.8019 }
};
const ROUTES = [
  ["hobart", "davis"], ["hobart", "mawson"], ["casey", "davis"],
  ["hobart", "macquarie"], ["hobart", "capetown"], ["lyttelton", "puntaarenas"]
];

// ---------------------------------------------------------------- state

const defaults = {
  alon: SITES.hobart.lon, alat: SITES.hobart.lat, blon: SITES.mawson.lon, blat: SITES.mawson.lat,
  four: "aeqd", lox: 0, comp: 0, lim: -60
};
const state = { ...defaults };
function readHash() {
  readParams(state, defaults, { four: oneOf(["aeqd", "polar"], "aeqd") });
  state.alat = Math.max(-89.5, Math.min(89.5, state.alat)); state.blat = Math.max(-89.5, Math.min(89.5, state.blat));
  state.lim = Math.max(-75, Math.min(-40, state.lim));
}
const writeHash = hashWriter(state, defaults, { digits: 4 });

const siteAt = (lon, lat) => Object.keys(SITES).find((k) => Math.abs(SITES[k].lon - lon) < 1e-3 && Math.abs(SITES[k].lat - lat) < 1e-3);
const nameAt = (lon, lat) => { const k = siteAt(lon, lat); return k ? SITES[k].name : fmtLL(lon, lat); };
const fmtLL = (lon, lat) => `${Math.abs(lat).toFixed(2)}${DEG}${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(2)}${DEG}${lon < 0 ? "W" : "E"}`;
const km = (m) => `${Math.round(m / 1000).toLocaleString("en")} km`;
const nmi = (m) => `${Math.round(m / 1852).toLocaleString("en")} nmi`;
const deg = (a) => `${a.toFixed(1)}${DEG}`;

// ---------------------------------------------------------------- geometry

let coast = null, lines = null, info = null;
function compute() {
  const { alon, alat, blon, blat } = state;
  info = H.compare(alon, alat, blon, blat, { lim: state.comp ? state.lim : 0 });
  lines = {
    gc: H.greatCirclePoints(alon, alat, blon, blat, 256),
    rhumb: H.rhumbPoints(alon, alat, blon, blat, 512),
    lox: state.lox ? H.loxodrome(alon, alat, info.rhumb.azi) : null,
    comp: info.composite ? info.composite.points : null
  };
}

const LS = (pts) => ({ type: "LineString", coordinates: pts });
const parallel = (lat) => LS(Array.from({ length: 361 }, (_, i) => [i - 180, lat]));

// the midpoint of the great circle, where Mercator, gnomonic and the globe centre
const centre = () => lines.gc[lines.gc.length >> 1];

// ---------------------------------------------------------------- maps

const PANELS = {
  globe: {
    make: (w, h) => {
      const c = rot || [-centre()[0], -centre()[1]];
      return d3.geoOrthographic().rotate(c).fitExtent([[12, 12], [w - 12, h - 12]], { type: "Sphere" });
    },
    label: () => rot ? "Globe (orthographic)" : "Globe (orthographic), seen from over the middle of the great circle, so it looks straight"
  },
  merc: {
    make: (w, h) => {
      const p = d3.geoMercator().rotate([-centre()[0], 0]);
      const fit = { type: "MultiLineString", coordinates: [lines.gc, lines.rhumb, ...(lines.comp ? [lines.comp] : [])].map(clampLat) };
      return p.fitExtent(PAD(w, h), fit).clipExtent([[0, 0], [w, h]]);
    },
    label: () => "Mercator (+proj=merc): the rhumb line is straight"
  },
  gnom: {
    make: (w, h) => {
      const c = centre(), p = d3.geoGnomonic().rotate([-c[0], -c[1]]).clipAngle(80);
      p.fitExtent(PAD(w, h), { type: "MultiLineString", coordinates: [lines.gc, [lines.gc[0], lines.gc[lines.gc.length - 1]]] });
      // the rhumb line fits too where it stays near enough the centre
      return p.scale(p.scale() * 0.8).clipExtent([[0, 0], [w, h]]);
    },
    label: () => "Gnomonic (+proj=gnom): the great circle is straight"
  },
  four: {
    make: (w, h) => {
      if (state.four === "polar") {
        const p = d3.geoStereographic().rotate([0, 90]).clipAngle(120);
        const fit = { type: "MultiLineString", coordinates: [lines.gc, lines.rhumb, [[0, -90], [0, -89.9]]] };
        return p.fitExtent(PAD(w, h), fit).clipExtent([[0, 0], [w, h]]);
      }
      const p = d3.geoAzimuthalEquidistant().rotate([-state.alon, -state.alat]).clipAngle(179.9);
      return p.fitExtent(PAD(w, h), { type: "MultiLineString", coordinates: [lines.gc, lines.rhumb] }).clipExtent([[0, 0], [w, h]]);
    },
    label: () => state.four === "polar"
      ? "South polar stereographic: the rhumb line spirals round the pole"
      : "Azimuthal equidistant on the start: the great circle is the straight line out"
  }
};
const PAD = (w, h) => [[30, 30], [w - 30, h - 46]];
const clampLat = (pts) => pts.map(([lo, la]) => [lo, Math.max(-85, Math.min(85, la))]);

let rot = null;         // the globe's rotation once dragged
const frozen = {};      // projections held while an end is dragged

function drawPanel(key) {
  const cv = $(`m-${key}`), box = cv.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, box.width), h = Math.max(10, box.height);
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
  const proj = (drag && frozen[key]) || PANELS[key].make(w, h);
  PANELS[key].proj = proj;
  const path = d3.geoPath(proj, ctx);
  const stroke = (geom, colour, width = 1, dash = []) => { ctx.beginPath(); path(geom); ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]); };
  ctx.beginPath(); path({ type: "Sphere" }); ctx.fillStyle = C.ocean; ctx.fill();
  stroke(d3.geoGraticule10(), C.grat);
  if (coast) stroke(coast, C.coast);
  if (state.comp) stroke(parallel(state.lim), C.lim, 1.2, [3, 4]);
  if (lines.lox) stroke(LS(lines.lox), C.lox, 1);
  if (lines.comp) stroke(LS(lines.comp), C.comp, 2.4);
  stroke(LS(lines.rhumb), C.rhumb, 2.4);
  stroke(LS(lines.gc), C.gc, 2.4);
  stroke({ type: "Sphere" }, C.edge);
  // the great circle's vertex, where it is nearest the pole, when it lies between the ends
  if (info.vertex.between) dot(ctx, proj, info.vertex.lon, info.vertex.latOnPath, 3.5, C.gc);
  ctx.font = "12px system-ui, sans-serif"; ctx.textBaseline = "middle";
  dot(ctx, proj, state.alon, state.alat, 5.5, C.a, nameAt(state.alon, state.alat));
  dot(ctx, proj, state.blon, state.blat, 5.5, C.b, nameAt(state.blon, state.blat));
  $(`l-${key}`).textContent = PANELS[key].label();
}

function visible(proj, lon, lat) {
  const p = proj([lon, lat]);
  if (!p) return null;
  // d3's clipping hides lines, not points: test the point against the clip
  let seen = false;
  proj.stream({ point() { seen = true; }, lineStart() {}, lineEnd() {}, polygonStart() {}, polygonEnd() {}, sphere() {} }).point(lon, lat);
  return seen ? p : null;
}

function dot(ctx, proj, lon, lat, r, fill, text) {
  const p = visible(proj, lon, lat);
  if (!p) return;
  ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 2 * Math.PI);
  ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = C.bg; ctx.lineWidth = 1.5; ctx.stroke();
  if (!text) return;
  // labels near the right edge go on the left of the point
  const left = p[0] + 8 + ctx.measureText(text).width > ctx.canvas.width / (window.devicePixelRatio || 1) - 4;
  const x = left ? p[0] - 8 : p[0] + 8;
  ctx.textAlign = left ? "right" : "left";
  ctx.strokeStyle = C.bg; ctx.lineWidth = 3; ctx.strokeText(text, x, p[1]); ctx.fillStyle = C.ink; ctx.fillText(text, x, p[1]);
  ctx.textAlign = "left";
}

// ---------------------------------------------------------------- readout

function readout() {
  const g = info.geodesic, r = info.rhumb, rows = [];
  rows.push([`<span style="color:${C.gc}">Great circle</span>`, `${km(g.s)}, ${nmi(g.s)}`]);
  rows.push(["Course leaving, arriving", `${deg(g.azi1)}, ${deg(g.azi2)}`]);
  rows.push([`<span style="color:${C.rhumb}">Rhumb line</span>`, `${km(r.s)}, ${nmi(r.s)}`]);
  rows.push(["Course, all the way", deg(r.azi)]);
  rows.push(["Rhumb line is longer by", `${km(r.s - g.s)} (${(info.extra * 100).toFixed(2)} percent)`]);
  rows.push(["Farthest apart", `${km(info.apart.s)}, at ${fmtLL(info.apart.lon, info.apart.lat)}`]);
  const v = info.vertex;
  rows.push(["Great circle's vertex", v.between ? `${fmtLL(v.lon, v.lat)}, between the ends` : `${Math.abs(v.lat).toFixed(2)}${DEG}${v.lat < 0 ? "S" : "N"}, beyond the ends`]);
  if (state.comp) {
    const c = info.composite, lim = `${Math.abs(state.lim)}${DEG}S`;
    const sg = Math.sign(state.lim), beyond = sg * state.alat >= sg * state.lim || sg * state.blat >= sg * state.lim;
    rows.push([`<span style="color:${C.comp}">Keeping north of ${lim}</span>`,
      c ? `${km(c.s)}, ${(100 * (c.s / H.greatCircle(state.alon, state.alat, state.blon, state.blat).s - 1)).toFixed(2)} percent over the great circle`
        : beyond ? "an end is south of the limit" : "the great circle already does"]);
  }
  if (state.lox) rows.push(["The whole loxodrome", `${km(H.loxodromeLength(r.azi))}, pole to pole`]);
  $("out").innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("");
}

// ---------------------------------------------------------------- UI

for (const [a, b] of ROUTES) {
  const bt = document.createElement("button");
  bt.type = "button"; bt.textContent = `${SITES[a].name} to ${SITES[b].name}`; bt.dataset.a = a; bt.dataset.b = b;
  bt.addEventListener("click", () => { setEnd("a", SITES[a]); setEnd("b", SITES[b]); rot = null; render(); });
  $("presets").appendChild(bt);
}
for (const id of ["from", "to"]) {
  $(id).innerHTML = Object.entries(SITES).map(([k, s]) => `<option value="${k}">${s.name}</option>`).join("") + '<option value="">A point dragged on the map</option>';
  $(id).addEventListener("change", (e) => { if (e.target.value) { setEnd(id === "from" ? "a" : "b", SITES[e.target.value]); rot = null; render(); } });
}
function setEnd(which, p) { state[`${which}lon`] = p.lon; state[`${which}lat`] = p.lat; }

function syncUI() {
  $("from").value = siteAt(state.alon, state.alat) || "";
  $("to").value = siteAt(state.blon, state.blat) || "";
  for (const bt of $("presets").querySelectorAll("button")) bt.classList.toggle("active", siteAt(state.alon, state.alat) === bt.dataset.a && siteAt(state.blon, state.blat) === bt.dataset.b);
  $("four").value = state.four;
  $("lox").checked = !!state.lox;
  $("comp").checked = !!state.comp;
  $("lim").value = state.lim; $("lim").disabled = !state.comp;
  $("lim-out").textContent = `${Math.abs(state.lim)}${DEG}S`;
}

$("four").addEventListener("change", (e) => { state.four = e.target.value; render(); });
$("lox").addEventListener("change", (e) => { state.lox = e.target.checked ? 1 : 0; render(); });
$("comp").addEventListener("change", (e) => { state.comp = e.target.checked ? 1 : 0; render(); });
$("lim").addEventListener("input", (e) => { state.lim = +e.target.value; render(); });

// drag an end on any map, or turn the globe
let drag = null;
for (const key of Object.keys(PANELS)) {
  const cv = $(`m-${key}`);
  cv.addEventListener("pointerdown", (e) => {
    const proj = PANELS[key].proj, b = cv.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    if (!proj) return;
    let end = null, best = 14;
    for (const w of ["a", "b"]) {
      const p = visible(proj, state[`${w}lon`], state[`${w}lat`]);
      if (p && Math.hypot(p[0] - x, p[1] - y) < best) { best = Math.hypot(p[0] - x, p[1] - y); end = w; }
    }
    if (!end && key !== "globe") return;
    drag = { key, end, x, y, rot: proj.rotate() };
    for (const k of Object.keys(PANELS)) frozen[k] = PANELS[k].proj;
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener("pointermove", (e) => {
    if (!drag || drag.key !== key) return;
    const b = cv.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top, proj = frozen[key];
    if (drag.end) {
      const ll = proj.invert([x, y]);
      if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return;
      state[`${drag.end}lon`] = +ll[0].toFixed(4); state[`${drag.end}lat`] = +Math.max(-89.5, Math.min(89.5, ll[1])).toFixed(4);
    } else {
      const k = 180 / (Math.PI * proj.scale());
      rot = [drag.rot[0] + (x - drag.x) * k, Math.max(-90, Math.min(90, drag.rot[1] - (y - drag.y) * k))];
      frozen.globe = null;
    }
    schedule();
  });
  cv.addEventListener("pointerup", () => { drag = null; for (const k of Object.keys(frozen)) frozen[k] = null; schedule(); });
}

let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; render(); });
}

function render() {
  compute();
  for (const key of Object.keys(PANELS)) drawPanel(key);
  readout();
  syncUI();
  writeHash();
  document.body.classList.add("ready");
}

new ResizeObserver(() => schedule()).observe($("stage"));
window.addEventListener("hashchange", () => { readHash(); rot = null; schedule(); });

shareLinks("Rhumb lines and great circles", { height: 560 });
readHash();
syncUI();
loadCoastline("110m").then((c) => {
  const pairs = (r) => { const o = []; for (let i = 0; i < r.length; i += 2) o.push([r[i], r[i + 1]]); return o; };
  coast = { type: "MultiLineString", coordinates: c.map(pairs) };
  schedule();
}).catch(() => {});
render();
