// playproj: Which grid for Chile?
//
// Mainland Chile drawn in one grid's own eastings and northings (UTM 19S or
// 18S, a transverse Mercator on a chosen meridian, Argentina's Faja 1,
// Albers, Lambert azimuthal equal-area, Lambert conformal conic, or
// longitude and latitude), shaded by its area, distance or shape error, with
// that error summed over the land. A short set of steps walks through the
// choices. Grids and factors are src/core/chile.js.

import * as C from "../src/core/chile.js";
import { majorAxis } from "../src/core/tissot.js";
import { readParams, hashWriter, shareLinks, oneOf } from "../src/scene/index.js";

const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";

const COL = {
  bg: "#05070d", land: "#101a2c", chile: "#16253f", border: "rgba(215,236,255,0.6)", chileBorder: "#ffd34d",
  grat: "rgba(140,196,255,0.18)", zone: "#ff7ab8", cm: "rgba(127,224,255,0.8)", par: "rgba(255,179,71,0.85)",
  town: "#f2f6fb", pin: "#ffd34d", ink: "#dfe7f2", muted: "#8a97ab", tissot: "rgba(255,255,255,0.85)"
};

const ORDER = ["utm19", "utm18", "tm", "faja1", "aea", "laea", "lcc", "lonlat"];
const TOWNS = [
  ["Arica", -70.3126, -18.4783], ["Antofagasta", -70.4, -23.65], ["La Serena", -71.2542, -29.9027],
  ["Santiago", -70.6693, -33.4489], ["Concepcion", -73.0498, -36.827], ["Puerto Montt", -72.9411, -41.4693],
  ["Coyhaique", -72.0662, -45.5752], ["Punta Arenas", -70.9171, -53.1638], ["Puerto Williams", -67.6167, -54.9333],
  ["La Paz", -68.1193, -16.4897]
];
// starting parameters for each kind that has them
const KIND_DEFAULTS = {
  tm: { lon0: -71, kppm: 0 },
  aea: { lon0: -71, lat0: -37, lat1: -24, lat2: -50 },
  laea: { lon0: -71, lat0: -37 },
  lcc: { lon0: -71, lat0: -37, lat1: -24, lat2: -50 }
};
const SLIDERS = {
  lon0: { label: "Central meridian", min: -80, max: -62, step: 0.5, fmt: (v) => `${(-v).toFixed(1)}${DEG}W` },
  lat0: { label: "Latitude of origin", min: -80, max: -10, step: 0.5, fmt: (v) => `${(-v).toFixed(1)}${DEG}S` },
  lat1: { label: "First standard parallel", min: -80, max: -5, step: 0.5, fmt: (v) => `${(-v).toFixed(1)}${DEG}S` },
  lat2: { label: "Second standard parallel", min: -80, max: -5, step: 0.5, fmt: (v) => `${(-v).toFixed(1)}${DEG}S` },
  kppm: { label: "Scale on the central meridian", min: -1000, max: 200, step: 10, fmt: (v) => `k0 = ${(1 + v * 1e-6).toFixed(4)}` }
};

// ---------------------------------------------------------------- steps

const STEPS = [
  {
    title: "The official grid: UTM zone 19S",
    text: "Chile maps in UTM on SIRGAS-Chile. Zone 19S runs from 72 W to 66 W with its central meridian on 69 W, where the scale is 0.9996. Most of the north and the capital are in it. Areas come out a little small near 69 W and too large towards its edges; over the land the area of a 1266 m cell is off by up to about 9 000 square metres.",
    set: { crs: "utm19", shade: "area" }
  },
  {
    title: "Zone 18S, for the west and the south",
    text: "Zone 18S is centred on 75 W, out over the Pacific. Drawn for the whole country, as one grid has to be, the east of Chile is up to 9 degrees from its central meridian, and the scale there reaches 1.008: area errors of up to about 25 000 square metres a cell and 0.8 percent in distance.",
    set: { crs: "utm18", shade: "area" }
  },
  {
    title: "One transverse Mercator, on 71 W",
    text: "Put the central meridian on the middle of the country and the whole mainland is within 5 degrees of it. With k0 = 1 distances are never more than 0.2 percent long and areas 0.4 percent large. Move the meridian and the scale on it to see the trade: a k0 a little under 1 splits the error into too short in the middle and too long at the edges, as UTM does.",
    set: { crs: "tm", lon0: -71, kppm: 0, shade: "scale" }
  },
  {
    title: "Next door: Argentina's Faja 1",
    text: "Argentina did this for itself: seven Gauss-Kruger strips 3 degrees wide with k = 1 on POSGAR 2007. The first is centred on 72 W, along the Andes and the border, so it fits Chile almost as well as a grid made for it (EPSG:5343, northings counted from the South Pole).",
    set: { crs: "faja1", shade: "scale" }
  },
  {
    title: "Equal area: zero by construction",
    text: "An Albers conic with standard parallels at the two ends of the country (56 S and 17 S, centred on 73 W). The area shading is blank: an equal-area projection keeps every area exactly, whatever its parameters, so a cell's area error is zero everywhere, and any residual in a test that builds cells from lon/lat points is the cost of the straight cell edges, not the projection. What the parameters change is shape; switch the shading to see it.",
    set: { crs: "aea", lon0: -73, lat0: -73, lat1: -56, lat2: -17, shade: "area" }
  },
  {
    title: "Albers' price is shape",
    text: "The same Albers shaded by angular distortion: up to 6.7 degrees at the ends and the middle, with distances along a parallel 6 percent off. Standard parallels one sixth of the way in from each end (24 S and 50 S) bring it down to 4.5 degrees. A cone is true along parallels, and Chile runs along meridians, so a conic can only do so well here.",
    set: { crs: "aea", lon0: -73, lat0: -73, lat1: -56, lat2: -17, shade: "shape", tissot: 1 }
  },
  {
    title: "Lambert azimuthal, centred on Chile",
    text: "The Lambert azimuthal equal-area has no direction it prefers: its error grows only with distance from the centre. Centred on 71 W 37 S it keeps area exactly and bends shapes by at most 1.6 degrees over the land, four times better than the Albers. Move the centre to see where it does best.",
    set: { crs: "laea", lon0: -71, lat0: -37, shade: "shape", tissot: 1 }
  },
  {
    title: "The wrong cone: Lambert conformal",
    text: "Lambert's conformal conic with the same parallels keeps shape but not area: its scale changes with latitude and Chile spans 38 degrees of it, so areas run from 5 percent small to 7 percent large. It is the right grid for Victoria or Texas, wide countries, and the wrong one here.",
    set: { crs: "lcc", lon0: -71, lat0: -37, lat1: -24, lat2: -50, shade: "area" }
  },
  {
    title: "Longitude and latitude as a grid",
    text: "Cells of a fixed number of degrees are not a fixed size: a degree of longitude is 106 km at Arica and 62 km at Cape Horn. Areas can still be worked out exactly on the ellipsoid, but no lon/lat grid has cells of one area, so the shading here is the stretch of each parallel, from 1.05 to 1.78.",
    set: { crs: "lonlat", shade: "area" }
  }
];

// ---------------------------------------------------------------- state

const defaults = {
  s: 0, crs: "utm19", lon0: -71, lat0: -37, lat1: -24, lat2: -50, kppm: 0,
  shade: "area", cell: 1266, tissot: 0, zones: 1, grat: 0, towns: 1, v: "", pt: ""
};
const state = { ...defaults };
function readHash() {
  readParams(state, defaults, {
    crs: oneOf(ORDER, "utm19"), shade: oneOf(["area", "scale", "shape", "none"], "area"), v: String, pt: String,
    s: (r) => Math.max(0, Math.min(STEPS.length - 1, Math.round(+r) || 0))
  });
}
readHash();
const writeHash = hashWriter(state, defaults, { digits: 4 });

const parseV = () => {
  const v = state.v.split(",").map(Number);
  return v.length === 3 && v.every(isFinite) && v[2] > 5 ? v : null;
};
const pinned = () => {
  const v = state.pt.split(",").map(Number);
  return v.length === 2 && v.every(isFinite) ? v : null;
};

let grid = null, gridKey = "";
function currentGrid() {
  const key = [state.crs, state.lon0, state.lat0, state.lat1, state.lat2, state.kppm].join(",");
  if (key !== gridKey) { grid = C.build(state.crs, state); gridKey = key; }
  return grid;
}

// ---------------------------------------------------------------- view

const map = $("map");
let land = [], chile = null, sample = [], view = null, hover = null;

function makeView(w, h) {
  const g = currentGrid();
  let v = parseV();
  if (!v) v = fit(g, w, h);
  const [lon, lat, km] = v;
  const [cx, cy] = g.forward(lon, lat);
  const s = w / (km * 1000);
  return {
    w, h, cx, cy, s,
    px: (E, N) => [w / 2 + (E - cx) * s, h / 2 - (N - cy) * s],
    en: (x, y) => [cx + (x - w / 2) / s, cy - (y - h / 2) / s]
  };
}
// the view that fits mainland Chile, as [lon, lat, width km]
function fit(g, w, h) {
  let e0 = Infinity, e1 = -Infinity, n0 = Infinity, n1 = -Infinity;
  const rings = chile ? chile.rings : [[-70.3, -17.5, -75.7, -48, -67, -56]];
  for (const r of rings) for (let i = 0; i < r.length; i += 2) {
    const [E, N] = g.forward(r[i], r[i + 1]);
    e0 = Math.min(e0, E); e1 = Math.max(e1, E); n0 = Math.min(n0, N); n1 = Math.max(n1, N);
  }
  const pad = 1.08, width = Math.max((e1 - e0) * pad, ((n1 - n0) * pad * w) / h);
  const [lon, lat] = g.inverse((e0 + e1) / 2, (n0 + n1) / 2);
  return [lon, lat, width / 1000];
}

// ---------------------------------------------------------------- drawing

function draw() {
  const box = map.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, box.width), h = Math.max(10, box.height);
  map.width = Math.round(w * dpr); map.height = Math.round(h * dpr);
  const ctx = map.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, w, h);
  const g = currentGrid();
  view = makeView(w, h);
  const P = (lon, lat) => view.px(...g.forward(lon, lat));

  const ringPath = (ring) => {
    ctx.beginPath();
    for (let i = 0; i < ring.length; i += 2) {
      const [x, y] = P(ring[i], ring[i + 1]);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
  };
  for (const c of land) {
    ctx.fillStyle = c.abbr === "CHL" ? COL.chile : COL.land;
    for (const r of c.rings) { ringPath(r); ctx.fill(); }
  }
  if (state.shade !== "none") {
    const img = shade(g);
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.3; ctx.drawImage(img, 0, 0);
    if (chile) {
      ctx.save(); ctx.beginPath();
      for (const r of chile.rings) for (let i = 0; i < r.length; i += 2) { const [x, y] = P(r[i], r[i + 1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.clip("evenodd"); ctx.globalAlpha = 0.95; ctx.drawImage(img, 0, 0); ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
  if (state.grat) {
    for (let lon = -90; lon <= -50; lon += 2) line(ctx, P, (t) => [lon, -60 + 50 * t], COL.grat, 1);
    for (let lat = -60; lat <= -10; lat += 2) line(ctx, P, (t) => [-90 + 40 * t, lat], COL.grat, 1);
  }
  for (const c of land) {
    if (c.abbr === "CHL") continue;
    ctx.strokeStyle = COL.border; ctx.lineWidth = 1;
    for (const r of c.rings) { ringPath(r); ctx.stroke(); }
  }
  if (chile) { ctx.strokeStyle = COL.chileBorder; ctx.lineWidth = 1.5; for (const r of chile.rings) { ringPath(r); ctx.stroke(); } }

  if (state.zones) {
    for (const lon of [-78, -72, -66]) line(ctx, P, (t) => [lon, -60 + 46 * t], COL.zone, 2);
    ctx.font = "bold 13px system-ui, sans-serif"; ctx.fillStyle = COL.zone; ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (const [z, lon] of [[18, -75], [19, -69]]) {
      const [x, y] = P(lon, -16);
      if (x > 0 && x < w && y < h) ctx.fillText(`UTM ${z}S`, x, Math.max(48, y));
    }
  }
  // the grid's own lines: central meridian, standard parallels, centre
  const L = g.lines || {};
  for (const lon of L.lon || []) line(ctx, P, (t) => [lon, -60 + 46 * t], COL.cm, 1.3, [6, 5], `${(-lon).toFixed(1)}${DEG}W central meridian`, 0.8, "right");
  for (const lat of L.lat || []) line(ctx, P, (t) => [-90 + 40 * t, lat], COL.par, 1.3, [6, 5], `${(-lat).toFixed(1)}${DEG}S standard parallel`, 0.15);
  if (L.centre) {
    const [x, y] = P(...L.centre);
    ctx.strokeStyle = COL.cm; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 7, 0, 2 * Math.PI); ctx.stroke();
  }
  if (state.tissot) indicatrices(ctx, g);
  if (state.towns) {
    ctx.font = "12px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    for (const [name, lon, lat] of TOWNS) {
      const [x, y] = P(lon, lat);
      if (x < -50 || x > w + 50 || y < -20 || y > h + 20) continue;
      ctx.fillStyle = COL.town; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 2 * Math.PI); ctx.fill();
      ctx.strokeStyle = "rgba(5,7,13,0.85)"; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.strokeText(name, x + 5, y);
      ctx.fillStyle = COL.ink; ctx.fillText(name, x + 5, y);
    }
  }
  const p = pinned();
  if (p) {
    const [x, y] = P(p[0], p[1]);
    ctx.strokeStyle = COL.pin; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, 2 * Math.PI); ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y); ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10); ctx.stroke();
  }
  scaleBar(ctx);
  legend(ctx);
  $("map-label").textContent = `${g.name}${g.epsg ? ` (EPSG:${g.epsg})` : ""}: eastings and northings as drawn`;
}

// a lon/lat curve t in [0, 1] -> [lon, lat], projected and stroked
function line(ctx, P, f, colour, width, dash = [], label = null, at = 0.5, side = "left") {
  ctx.beginPath();
  let first = true;
  for (let i = 0; i <= 200; i++) {
    const [x, y] = P(...f(i / 200));
    if (!isFinite(x) || !isFinite(y)) { first = true; continue; }
    first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    first = false;
  }
  const last = P(...f(at));
  ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]);
  if (label && last[0] > 0 && last[0] < view.w && last[1] > 0 && last[1] < view.h) {
    ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = colour; ctx.textBaseline = "bottom"; ctx.textAlign = side;
    ctx.fillText(label, last[0] + (side === "left" ? 4 : -4), last[1] - 3);
  }
}

// ---------------------------------------------------------------- shading

// parts per million either side of true, for area and distance
const DIVERGING = [[-50000, 20, 50, 150], [-10000, 50, 110, 220], [-2000, 120, 175, 240], [-300, 200, 222, 245], [0, 245, 245, 245],
  [300, 250, 220, 190], [2000, 250, 180, 110], [10000, 235, 105, 55], [50000, 170, 25, 35]];
// degrees of angular distortion
const SEQUENTIAL = [[0, 245, 245, 245], [0.25, 230, 225, 250], [1, 185, 160, 240], [3, 140, 90, 220], [7, 90, 30, 160], [15, 40, 10, 90]];
function ramp(stops, v) {
  if (v <= stops[0][0]) return stops[0].slice(1);
  for (let i = 1; i < stops.length; i++) if (v <= stops[i][0]) {
    const [z0, r0, g0, b0] = stops[i - 1], [z1, r1, g1, b1] = stops[i], t = (v - z0) / (z1 - z0);
    return [r0 + t * (r1 - r0), g0 + t * (g1 - g0), b0 + t * (b1 - b0)];
  }
  return stops[stops.length - 1].slice(1);
}
function shadeValue(f) {
  if (state.shade === "area") return (f.s - 1) * 1e6;
  if (state.shade === "scale") return (C.worstScale(f) - 1) * 1e6;
  return f.omega;
}
const shadeColour = (v) => ramp(state.shade === "shape" ? SEQUENTIAL : DIVERGING, v);

function shade(g) {
  const step = 5, W = Math.ceil(view.w / step), H = Math.ceil(view.h / step);
  const off = document.createElement("canvas"); off.width = W; off.height = H;
  const oc = off.getContext("2d"), img = oc.createImageData(W, H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const [lon, lat] = g.inverse(...view.en((i + 0.5) * step, (j + 0.5) * step));
    if (!isFinite(lon) || !isFinite(lat) || lat > -5 || lat < -70 || lon < -100 || lon > -40) continue;
    const f = C.scaleAt(g, lon, lat);
    if (!f) continue;
    const [r, gg, b] = shadeColour(shadeValue(f)), o = 4 * (j * W + i);
    img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
  }
  oc.putImageData(img, 0, 0);
  // stretch to exactly W * step by H * step pixels of the view
  const full = document.createElement("canvas"); full.width = W * step; full.height = H * step;
  const fc = full.getContext("2d"); fc.imageSmoothingEnabled = true; fc.drawImage(off, 0, 0, W * step, H * step);
  return full;
}

function legend(ctx) {
  if (state.shade === "none") return;
  const shape = state.shade === "shape";
  const stops = shape ? SEQUENTIAL : DIVERGING;
  const labels = shape ? ["0", "1", "3", "7", `15${DEG}`] : ["-5%", "-1%", "0", "+1%", "+5%"];
  const at = shape ? [0, 1, 3, 7, 15] : [-50000, -10000, 0, 10000, 50000];
  const bw = 220, x0 = 24, y0 = 14;
  // the scale is piecewise: place each stop evenly
  const n = stops.length - 1, pos = (v) => {
    for (let i = 1; i < stops.length; i++) if (v <= stops[i][0]) return x0 + ((i - 1 + (v - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0])) / n) * bw;
    return x0 + bw;
  };
  for (let i = 0; i < bw; i++) {
    const k = (i / bw) * n, a = Math.floor(k), t = k - a, s0 = stops[a], s1 = stops[Math.min(n, a + 1)];
    const v = s0[0] + t * (s1[0] - s0[0]), [r, g, b] = ramp(stops, v);
    ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`; ctx.fillRect(x0 + i, y0 + 16, 1, 10);
  }
  ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = COL.ink; ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText(shape ? "Angular distortion, degrees" : state.shade === "area" ? "Map area against ground area" : "Map distance against ground distance (worst direction)", x0, y0);
  ctx.textAlign = "center"; ctx.fillStyle = COL.muted;
  at.forEach((v, i) => ctx.fillText(labels[i], pos(v), y0 + 29));
}

// Tissot's indicatrix on a lattice over the country, its departure from a
// circle of the true size exaggerated EXAG times so a few percent shows
const EXAG = 10;
function indicatrices(ctx, g) {
  const r = 60000 * view.s;
  ctx.strokeStyle = COL.tissot; ctx.lineWidth = 1.2;
  for (let lat = -54; lat <= -18; lat += 4) for (let lon = -76; lon <= -66; lon += 4) {
    const f = C.scaleAt(g, lon, lat);
    if (!f) continue;
    const [x, y] = view.px(...g.forward(lon, lat));
    const ra = r * Math.max(0.05, 1 + EXAG * (f.a - 1)), rb = r * Math.max(0.05, 1 + EXAG * (f.b - 1));
    ctx.beginPath(); ctx.ellipse(x, y, ra, rb, -majorAxis(f), 0, 2 * Math.PI); ctx.stroke();
  }
  ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = COL.muted; ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText(`Indicatrices: 120 km circles, distortion x${EXAG}`, 24, 60);
}

function scaleBar(ctx) {
  const km = [10, 20, 50, 100, 200, 500, 1000].find((k) => k * 1000 * view.s > 80) || 1000;
  const L = km * 1000 * view.s, x = view.w - L - 16, y = view.h - 36;
  ctx.strokeStyle = COL.ink; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + L, y); ctx.lineTo(x + L, y - 5); ctx.stroke();
  ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = COL.ink; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  ctx.fillText(`${km} grid km`, x + L / 2, y - 4);
}

// ---------------------------------------------------------------- readouts

const fmtLL = (lon, lat) => `${Math.abs(lat).toFixed(4)}${DEG}${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(4)}${DEG}W`;
const num = (v) => Math.round(v).toLocaleString("en");
const signed = (v, d = 0) => `${v >= 0 ? "+" : "-"}${Math.abs(v).toLocaleString("en", { maximumFractionDigits: d, minimumFractionDigits: d })}`;
const pct = (s) => `${signed((s - 1) * 100, 2)}%`;

let statsKey = "", stats = null;
function statsTable() {
  const g = currentGrid(), key = gridKey + "," + state.cell;
  if (!sample.length) { $("stats").innerHTML = ""; return; }
  if (key !== statsKey) { stats = C.landStats(g, sample, state.cell); statsKey = key; }
  const st = stats, cell = state.cell, area = cell * cell;
  const zeroArea = Math.abs(st.sMin - 1) < 1e-9 && Math.abs(st.sMax - 1) < 1e-9;
  const rows = [
    [`<b>Over the land</b><br><span class="hint">${num(st.n)} points in mainland Chile</span>`, `<b>${g.label}</b>`],
    ["Map area against ground", zeroArea ? "exact" : `${pct(st.sMin)} to ${pct(st.sMax)}`],
    [`Ground area of a ${num(cell)} m cell<br><span class="hint">nominal ${num(area)} m${"\u00b2"}</span>`,
      zeroArea ? "no error" : `${signed(st.eMin)} to ${signed(st.eMax)} m${"\u00b2"}`],
    ["Distance, worst direction", `${pct(st.bMin)} to ${pct(st.aMax)}`],
    ["Shape: largest angle bent", st.omegaMax < 1e-4 ? "none (conformal)" : `${st.omegaMax.toFixed(2)}${DEG}`]
  ];
  $("stats").innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("");
}

function readout() {
  const g = currentGrid();
  const p = hover || pinned() || [-70.6693, -33.4489];
  const [lon, lat] = p, f = C.scaleAt(g, lon, lat);
  const [E, N] = g.forward(lon, lat);
  const rows = [[hover ? "Under the pointer" : pinned() ? "Pinned" : "Santiago", `${fmtLL(lon, lat)}`],
    ["UTM zone here", `${C.utmZone(lon)}S`],
    [`${g.name}<br><span class="hint">${g.epsg ? `EPSG:${g.epsg}` : "custom"}</span>`, `E ${num(E)}<br>N ${num(N)}`]];
  if (f) {
    rows.push(["Scale along the meridian, h", f.h.toFixed(6)], ["Scale along the parallel, k", f.k.toFixed(6)],
      ["Areal scale, s", f.s.toFixed(6)], ["Angular distortion", `${f.omega.toFixed(3)}${DEG}`],
      [`A ${num(state.cell)} m cell here covers`, `${num((state.cell * state.cell) / f.s)} m${"\u00b2"} (${signed(C.cellError(f, state.cell))})`]);
  }
  $("out").innerHTML = rows.map(([x, y]) => `<tr><td>${x}</td><td>${y}</td></tr>`).join("") +
    `<tr><td colspan="2" style="text-align:left"><span class="hint">PROJ string of the map:</span><br><code style="font-size:11px;word-break:break-all">${g.proj}</code></td></tr>`;
}

// ---------------------------------------------------------------- UI

const sel = $("crs");
for (const id of ORDER) sel.add(new Option(C.KINDS[id].label, id));
sel.addEventListener("change", () => {
  state.crs = sel.value;
  Object.assign(state, KIND_DEFAULTS[state.crs] || {});
  state.v = "";
  sync();
});
$("shade").addEventListener("change", (e) => { state.shade = e.target.value; sync(); });
$("cell").addEventListener("change", (e) => { state.cell = +e.target.value; sync(); });
for (const k of ["tissot", "zones", "grat", "towns"]) $(k).addEventListener("change", (e) => { state[k] = e.target.checked ? 1 : 0; sync(); });
$("reset-view").addEventListener("click", () => { state.v = ""; sync(); });

// sliders for the kind's parameters
function buildParams() {
  const box = $("params"), want = C.KINDS[state.crs].params;
  if (box.dataset.kind === state.crs) return;
  box.dataset.kind = state.crs;
  box.innerHTML = "";
  for (const k of want) {
    const sl = SLIDERS[k];
    const lab = document.createElement("label");
    lab.className = "row"; lab.htmlFor = `p-${k}`;
    lab.innerHTML = `<span>${sl.label}</span><output id="p-${k}-out"></output>`;
    const inp = document.createElement("input");
    Object.assign(inp, { id: `p-${k}`, type: "range", min: sl.min, max: sl.max, step: sl.step });
    inp.setAttribute("aria-label", sl.label);
    inp.addEventListener("input", () => { state[k] = +inp.value; sync(); });
    box.append(lab, inp);
  }
}
function syncParams() {
  buildParams();
  for (const k of C.KINDS[state.crs].params) {
    $(`p-${k}`).value = state[k];
    $(`p-${k}-out`).textContent = SLIDERS[k].fmt(state[k]);
  }
}

// pan and zoom keep the view as a lon/lat centre and a width, so it survives a change of grid
function setView(cE, cN, widthM) {
  const [lon, lat] = currentGrid().inverse(cE, cN);
  state.v = `${lon.toFixed(4)},${lat.toFixed(4)},${Math.round(widthM / 1000)}`;
}
const pointerLL = (e) => {
  const r = map.getBoundingClientRect();
  return currentGrid().inverse(...view.en(e.clientX - r.left, e.clientY - r.top));
};
let drag = null;
map.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, moved: false, cx: view.cx, cy: view.cy }; map.setPointerCapture(e.pointerId); });
map.addEventListener("pointermove", (e) => {
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 3) drag.moved = true;
    if (drag.moved) { setView(drag.cx - dx / view.s, drag.cy + dy / view.s, view.w / view.s); draw(); }
    return;
  }
  hover = pointerLL(e);
  readout();
});
map.addEventListener("pointerup", (e) => {
  if (drag && !drag.moved) {
    const [lon, lat] = pointerLL(e);
    state.pt = `${lon.toFixed(5)},${lat.toFixed(5)}`;
  }
  drag = null; sync();
});
map.addEventListener("pointerleave", () => { hover = null; readout(); });
map.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = map.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const f = Math.exp(e.deltaY * 0.0015), [E, N] = view.en(mx, my);
  const s = Math.max(view.w / 9e6, Math.min(view.w / 2e4, view.s / f));
  setView(E - (mx - view.w / 2) / s, N + (my - view.h / 2) / s, view.w / s);
  sync();
}, { passive: false });

// steps
STEPS.forEach((st, k) => {
  const li = document.createElement("li");
  li.textContent = st.title;
  li.addEventListener("click", () => goStep(k));
  $("steps").appendChild(li);
});
function goStep(k) {
  state.s = Math.max(0, Math.min(STEPS.length - 1, k));
  Object.assign(state, { tissot: 0 }, STEPS[state.s].set, { v: "" });
  sync();
}
$("prev").addEventListener("click", () => goStep(state.s - 1));
$("next").addEventListener("click", () => goStep(state.s + 1));
function syncStep() {
  const st = STEPS[state.s];
  $("step-title").textContent = st.title;
  $("caption").textContent = st.text;
  $("count").textContent = `${state.s + 1} of ${STEPS.length}`;
  $("prev").disabled = state.s === 0;
  $("next").disabled = state.s === STEPS.length - 1;
  [...$("steps").children].forEach((li, k) => li.classList.toggle("active", k === state.s));
}

function sync() {
  sel.value = state.crs; $("shade").value = state.shade; $("cell").value = String(state.cell);
  for (const k of ["tissot", "zones", "grat", "towns"]) $(k).checked = !!state[k];
  syncParams(); syncStep();
  draw(); statsTable(); readout(); writeHash();
}

// a page opened with no hash starts on the first step's settings
if (!location.hash) Object.assign(state, STEPS[0].set);
window.addEventListener("hashchange", () => { readHash(); sync(); });
new ResizeObserver(() => { if (view) draw(); }).observe(map.parentElement);
shareLinks("playproj: Which grid for Chile?", { height: 620 });

sync();
fetch(new URL("../data/chile-50m.json", import.meta.url))
  .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
  .then((d) => {
    land = d; chile = d.find((c) => c.abbr === "CHL");
    sample = C.landSample(chile.rings, 0.1, [-76, -56.5, -66, -17]);
    sync();
  })
  .catch((e) => { $("stats").innerHTML = `<tr><td>The borders did not load (${e.message}).</td></tr>`; });
