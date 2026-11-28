// Inset maps: one sheet, several frames.
//
// An inset is a second map on the same page with its own projection, scale,
// rotation and place. Here every piece of a composite map is the same
// thing, a projection followed by an affine placement on the page:
//
//   page(lon, lat) = at + s * R(rot) * (F(lon, lat) - F(anchor))
//
// where F is the piece's projection in metres, anchor is the lon/lat that
// lands on the page point `at`, s is its scale relative to the main frame
// and R a rotation. A piece in its true place uses the main projection with
// s = 1, rot = 0 and at = Fmain(anchor). An inset and a piece moved on the
// page without a frame (sp::elide, or the move-scale-rotate recipes for
// Alaska and Hawaii) are the same arithmetic: the difference is only
// whether the page admits it, with a box, a scale bar and a locator.
//
// Projections: the conics and the Lambert azimuthal on GRS80 (vicgrid.js,
// chile.js), the transverse Mercator of mgrs.js, Snyder's modified
// stereographics for the 50 states and for Alaska (GS50 and alsk, as in
// PROJ's mod_ster.cpp: Snyder 1985, USGS Bulletin 1629), and d3-geo's
// spherical conic equal-area so that geoAlbersUsa can be rebuilt exactly.
// All checked against PROJ and d3-geo in test/check-inset.mjs.

import { tmerc, tmercInverse } from "./mgrs.js";
import { lcc, aea } from "./vicgrid.js";
import { laea } from "./chile.js";
import { factors } from "./tissot.js";

const D2R = Math.PI / 180, HALFPI = Math.PI / 2;
const GRS80 = { a: 6378137, es: 0.0066943800229 };
const r6 = (v) => +(+v).toFixed(6);
export const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

// ---------------------------------------------------------------- modified stereographic

// Snyder's complex polynomial coefficients, as PROJ carries them
const GS50_E = [[0.9827497, 0], [0.0210669, 0.0053804], [-0.1031415, -0.0571664], [-0.0323337, -0.0322847], [0.0502303, 0.1211983],
  [0.0251805, 0.0895678], [-0.0012315, -0.1416121], [0.0072202, -0.1317091], [-0.0194029, 0.0759677], [-0.0210072, 0.0834037]];
const GS50_S = [[0.984299, 0], [0.0211642, 0.0037608], [-0.1036018, -0.0575102], [-0.0329095, -0.0320119], [0.0499471, 0.1223335],
  [0.026046, 0.0899805], [0.0007388, -0.1435792], [0.0075848, -0.1334108], [-0.0216473, 0.0776645], [-0.0225161, 0.0853673]];
const ALSK_E = [[0.9945303, 0], [0.0052083, -0.0027404], [0.0072721, 0.0048181], [-0.0151089, -0.1932526], [0.0642675, -0.1381226], [0.3582802, -0.2884586]];
const ALSK_S = [[0.9972523, 0], [0.0052513, -0.0041175], [0.0074606, 0.0048125], [-0.0153783, -0.1968253], [0.0636871, -0.1408027], [0.3660976, -0.2937382]];
const CLARKE66 = { a: 6378206.4, es: 0.00676866 };

// z * (C0 + z * (C1 + ... + z * Cn)), and its derivative
function zpoly(zr, zi, C) {
  let ar = C[C.length - 1][0], ai = C[C.length - 1][1];
  for (let k = C.length - 2; k >= 0; k--) {
    const t = ar;
    ar = C[k][0] + zr * t - zi * ai;
    ai = C[k][1] + zr * ai + zi * t;
  }
  return [zr * ar - zi * ai, zr * ai + zi * ar];
}
function zpolyd(zr, zi, C) {
  // value and derivative of P(z) = sum C[k] z^(k+1) by Horner
  const n = C.length;
  let ar = C[n - 1][0], ai = C[n - 1][1], br = ar * n, bi = ai * n;
  for (let k = n - 2; k >= 0; k--) {
    let t = ar;
    ar = C[k][0] + zr * t - zi * ai;
    ai = C[k][1] + zr * ai + zi * t;
    t = br;
    br = C[k][0] * (k + 1) + zr * t - zi * bi;
    bi = C[k][1] * (k + 1) + zr * bi + zi * t;
  }
  return [zr * ar - zi * ai, zr * ai + zi * ar, br, bi];
}

function modster({ lon0, lat0, coef, a, es }) {
  const e = Math.sqrt(es);
  const conf = (p) => { const s = e * Math.sin(p); return 2 * Math.atan(Math.tan((HALFPI + p) / 2) * Math.pow((1 - s) / (1 + s), e / 2)) - HALFPI; };
  const chi0 = es ? conf(lat0 * D2R) : lat0 * D2R, s0 = Math.sin(chi0), c0 = Math.cos(chi0);
  const forward = (lon, lat) => {
    const dl = wrap(lon - lon0) * D2R, chi = es ? conf(lat * D2R) : lat * D2R;
    const sc = Math.sin(chi), cc = Math.cos(chi), den = 1 + s0 * sc + c0 * cc * Math.cos(dl);
    if (den <= 0) return [NaN, NaN];
    const s = 2 / den, [x, y] = zpoly(s * cc * Math.sin(dl), s * (c0 * sc - s0 * cc * Math.cos(dl)), coef);
    return [a * x, a * y];
  };
  const inverse = (X, Y) => {
    const x = X / a, y = Y / a;
    let pr = x, pi = y;
    for (let k = 0; k < 20; k++) {
      const [fr, fi, dr, di] = zpolyd(pr, pi, coef), gr = fr - x, gi = fi - y, den = dr * dr + di * di;
      const ur = -(gr * dr + gi * di) / den, ui = -(gi * dr - gr * di) / den;
      pr += ur; pi += ui;
      if (Math.abs(ur) + Math.abs(ui) <= 1e-12) break;
    }
    const rh = Math.hypot(pr, pi);
    if (rh < 1e-12) return [lon0, lat0];
    const z = 2 * Math.atan(rh / 2), sz = Math.sin(z), cz = Math.cos(z);
    const chi = Math.asin(Math.max(-1, Math.min(1, cz * s0 + (pi * sz * c0) / rh)));
    let phi = chi;
    if (es) for (let k = 0; k < 20; k++) {
      const s = e * Math.sin(phi);
      const d = 2 * Math.atan(Math.tan((HALFPI + chi) / 2) * Math.pow((1 + s) / (1 - s), e / 2)) - HALFPI - phi;
      phi += d;
      if (Math.abs(d) <= 1e-12) break;
    }
    return [lon0 + Math.atan2(pr * sz, rh * c0 * cz - pi * s0 * sz) / D2R, phi / D2R];
  };
  return { forward, inverse };
}

// ---------------------------------------------------------------- d3's conic equal-area

// d3-geo's geoConicEqualArea (Albers on the sphere) scaled to metres,
// without its origin: pieces are placed by their anchor, so where the
// projection puts 0, 0 does not matter.
function d3aea({ lon0, lat1, lat2, R = 6370997 }) {
  const s1 = Math.sin(lat1 * D2R), n = (s1 + Math.sin(lat2 * D2R)) / 2, c = 1 + s1 * (2 * n - s1), r0 = Math.sqrt(c) / n;
  const forward = (lon, lat) => {
    const r = Math.sqrt(c - 2 * n * Math.sin(lat * D2R)) / n, x = wrap(lon - lon0) * D2R * n;
    return [R * r * Math.sin(x), R * (r0 - r * Math.cos(x))];
  };
  const inverse = (X, Y) => {
    const x = X / R, r0y = r0 - Y / R, l = Math.atan2(x, Math.abs(r0y)) * Math.sign(r0y);
    const t = (c - (x * x + r0y * r0y) * n * n) / (2 * n);
    return [lon0 + l / n / D2R, Math.asin(Math.max(-1, Math.min(1, t))) / D2R];
  };
  return { forward, inverse };
}

// ---------------------------------------------------------------- projections

// A projection from a spec { proj, ...params }: forward and inverse in
// metres, with its PROJ string, the semi-major axis and eccentricity
// squared it works on (for the scale factors) and a short name.
export function crs(spec) {
  const p = spec, wrapIn = (f, lon0) => (lon, lat) => f(lon0 + wrap(lon - lon0), lat);
  let g;
  switch (p.proj) {
    case "aea": {
      const q = aea(p);
      g = { forward: wrapIn(q.forward, p.lon0), inverse: q.inverse, ...GRS80, name: "Albers equal-area conic",
        proj: `+proj=aea +lat_0=${r6(p.lat0)} +lon_0=${r6(p.lon0)} +lat_1=${r6(p.lat1)} +lat_2=${r6(p.lat2)} +ellps=GRS80 +units=m +no_defs` };
      break;
    }
    case "lcc": {
      const q = lcc(p);
      g = { forward: wrapIn(q.forward, p.lon0), inverse: q.inverse, ...GRS80, name: "Lambert conformal conic",
        proj: `+proj=lcc +lat_0=${r6(p.lat0)} +lon_0=${r6(p.lon0)} +lat_1=${r6(p.lat1)} +lat_2=${r6(p.lat2)} +ellps=GRS80 +units=m +no_defs` };
      break;
    }
    case "laea": {
      const q = laea(p);
      g = { forward: wrapIn(q.forward, p.lon0), inverse: q.inverse, ...GRS80, name: "Lambert azimuthal equal-area",
        proj: `+proj=laea +lat_0=${r6(p.lat0)} +lon_0=${r6(p.lon0)} +ellps=GRS80 +units=m +no_defs` };
      break;
    }
    case "tmerc": {
      const k0 = p.k0 ?? 1;
      g = { forward: (lon, lat) => tmerc(p.lon0 + wrap(lon - p.lon0), lat, p.lon0, k0), inverse: (x, y) => tmercInverse(x, y, p.lon0, k0),
        a: 6378137, es: 0.00669437999014, name: "Transverse Mercator",
        proj: `+proj=tmerc +lat_0=0 +lon_0=${r6(p.lon0)} +k=${r6(k0)} +ellps=WGS84 +units=m +no_defs` };
      break;
    }
    case "gs50": case "alsk": {
      const sphere = !!p.sphere, gs = p.proj === "gs50";
      const e = sphere ? { a: 6370997, es: 0 } : CLARKE66;
      const q = modster({ lon0: gs ? -120 : -152, lat0: gs ? 45 : 64, coef: gs ? (sphere ? GS50_S : GS50_E) : (sphere ? ALSK_S : ALSK_E), ...e });
      g = { ...q, ...e, name: gs ? "GS50, modified stereographic of the 50 states" : "Modified stereographic of Alaska",
        proj: `+proj=${p.proj} ${sphere ? "+R=6370997" : "+ellps=clrk66"} +units=m +no_defs` };
      break;
    }
    case "d3aea": {
      const q = d3aea(p);
      g = { ...q, a: p.R || 6370997, es: 0, name: "Albers on the sphere (d3-geo)",
        proj: `+proj=aea +lat_1=${r6(p.lat1)} +lat_2=${r6(p.lat2)} +lon_0=${r6(p.lon0)} +R=${p.R || 6370997} +units=m +no_defs` };
      break;
    }
    default:
      throw new Error(`unknown projection ${p.proj}`);
  }
  g.spec = spec;
  return g;
}

// PROJ's scale factors for a projection at lon, lat: h, k, s, a, b, omega.
export function scaleAt(g, lon, lat) {
  return factors((l, q) => { const [x, y] = g.forward(l, q); return isFinite(x) ? [x / g.a, y / g.a] : null; }, lon, lat, { es: g.es });
}

// ---------------------------------------------------------------- placement

// A placed piece: { key, crs (a crs() result), anchor [lon, lat], at [x, y]
// page metres, s, rot degrees, mode "true" | "inset" | "moved" | "off" }.
export function placer(piece) {
  const g = piece.crs, [ax, ay] = g.forward(...piece.anchor), s = piece.s ?? 1, t = (piece.rot || 0) * D2R;
  const c = Math.cos(t) * s, sn = Math.sin(t) * s, [tx, ty] = piece.at;
  const forward = (lon, lat) => {
    const [x, y] = g.forward(lon, lat), dx = x - ax, dy = y - ay;
    return [tx + c * dx - sn * dy, ty + sn * dx + c * dy];
  };
  const inverse = (X, Y) => {
    const dx = X - tx, dy = Y - ty, k = s * s;
    return g.inverse(ax + (c * dx + sn * dy) / k, ay + (-sn * dx + c * dy) / k);
  };
  return { forward, inverse };
}

// The page point a piece would sit at in its true place on the main frame.
export const truePlace = (main, anchor) => main.forward(...anchor);

// The lon/lat centre of a set of rings: the middle of their extent, taken
// across the antimeridian when that is narrower.
export function centreOf(rings) {
  let y0 = Infinity, y1 = -Infinity, xs = [];
  for (const r of rings) for (let i = 0; i < r.length; i += 2) { xs.push(r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]); }
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  const shifted = xs.map((x) => (x < 0 ? x + 360 : x)), u0 = Math.min(...shifted), u1 = Math.max(...shifted);
  if (u1 - u0 < x1 - x0) { x0 = u0; x1 = u1; }
  return [wrap((x0 + x1) / 2), (y0 + y1) / 2];
}

// ---------------------------------------------------------------- area and the frame

// signed shoelace area of a flat [x, y, ...] ring
export function shoelace(xy) {
  let s = 0;
  for (let i = 0, n = xy.length; i < n; i += 2) {
    const j = (i + 2) % n;
    s += xy[i] * xy[j + 1] - xy[j] * xy[i + 1];
  }
  return s / 2;
}

// Ground area of lon/lat rings in square metres: the shoelace of each ring
// in a Lambert azimuthal equal-area centred on the rings (exact for the
// polygon with its edges straight in that projection). Rings are summed
// with even-odd sign, so holes subtract when they wind the other way.
export function groundArea(rings, centre = centreOf(rings)) {
  const g = crs({ proj: "laea", lon0: centre[0], lat0: centre[1] });
  let s = 0;
  for (const r of rings) {
    const xy = [];
    for (let i = 0; i < r.length; i += 2) xy.push(...g.forward(r[i], r[i + 1]));
    s += Math.abs(shoelace(xy));
  }
  return s;
}

// Page geometry of a piece: its rings on the page, extent and map area.
export function pagePiece(pl, rings) {
  const out = [];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, area = 0;
  for (const r of rings) {
    const xy = new Float64Array(r.length);
    for (let i = 0; i < r.length; i += 2) {
      const [x, y] = pl.forward(r[i], r[i + 1]);
      xy[i] = x; xy[i + 1] = y;
      if (isFinite(x) && isFinite(y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    area += Math.abs(shoelace(xy));
    out.push(xy);
  }
  return { rings: out, box: [x0, y0, x1, y1], area };
}

// Frame statistics for a layout: a list of { key, page (pagePiece), ground
// (square metres), box (the frame around an inset, or null) }. Returns the
// extent of the whole sheet, the share of it that is map, the ground area,
// and each piece's areal scale against the first (main) piece.
export function frameStats(items) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, map = 0, ground = 0;
  for (const it of items) {
    const b = it.box || it.page.box;
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
    map += it.page.area; ground += it.ground;
  }
  const sheet = (x1 - x0) * (y1 - y0), main = items[0];
  const k0 = main.page.area / main.ground;
  return {
    extent: [x0, y0, x1, y1], width: x1 - x0, height: y1 - y0, sheet, map, ground, fill: map / sheet,
    // the main piece's share of the sheet's width and height: how big it can be drawn
    mainShare: Math.min((main.page.box[2] - main.page.box[0]) / (x1 - x0), (main.page.box[3] - main.page.box[1]) / (y1 - y0)),
    pieces: items.map((it) => ({ key: it.key, areal: it.page.area / it.ground / k0, linear: Math.sqrt(it.page.area / it.ground / k0) }))
  };
}

// ---------------------------------------------------------------- d3 geoAlbersUsa

// geoAlbersUsa (Bostock, d3-geo src/projection/albersUsa.js) rebuilt as
// three pieces in metres: the lower 48 on USGS's Albers (29.5, 45.5 on
// 96 W), Alaska on the shape of EPSG:3338 (55, 65 on 154 W) drawn at 0.35,
// Hawaii on ESRI:102007's (8, 18 on 157 W) at 1. d3 places each by
// translate offsets in units of the scale k; here those are multiples of the
// sphere radius R, north up.
export const D3_R = 6370997;
export function albersUsaPieces(R = D3_R) {
  return {
    us48: { crs: crs({ proj: "d3aea", lon0: -96, lat1: 29.5, lat2: 45.5, R }), anchor: [-96.6, 38.7], at: [0, 0], s: 1 },
    alaska: { crs: crs({ proj: "d3aea", lon0: -154, lat1: 55, lat2: 65, R }), anchor: [-156, 58.5], at: [-0.307 * R, -0.201 * R], s: 0.35 },
    hawaii: { crs: crs({ proj: "d3aea", lon0: -157, lat1: 8, lat2: 18, R }), anchor: [-160, 19.9], at: [-0.205 * R, -0.212 * R], s: 1 }
  };
}
// d3's clip boxes for Alaska and Hawaii, in the same page metres: the
// frames the composite draws (d3 draws none, it only clips to them)
export function albersUsaBoxes(R = D3_R) {
  return {
    alaska: [-0.425 * R, -0.234 * R, -0.214 * R, -0.12 * R],
    hawaii: [-0.214 * R, -0.234 * R, -0.115 * R, -0.166 * R],
    us48: [-0.455 * R, -0.238 * R, 0.455 * R, 0.238 * R]
  };
}

// ---------------------------------------------------------------- distance

// great-circle distance in metres on the mean sphere (good to about 0.5%)
export function greatCircle(lon1, lat1, lon2, lat2, R = 6371008.8) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------- scenes

const UTM = (zone, south = false) => ({ proj: "tmerc", lon0: zone * 6 - 183, k0: 0.9996, epsg: (south ? 32700 : 32600) + zone });

// The examples of insets.html. Each scene has a main frame, a choice of
// projections for it, and pieces (keys into data/insets-10m.json) each with
// the projection it uses when it has a frame of its own. A layout gives
// each piece a mode and, for an inset or a moved piece, its scale s against
// the main frame, rotation and centre on the page (`ll`: the lon/lat whose
// place on the main frame it is centred on).
export const SCENES = {
  usa: {
    name: "United States", context: "usa", main: "usgs",
    mains: {
      usgs: { label: "USGS Albers for the lower 48 (EPSG:5070 geometry)", spec: { proj: "aea", lat0: 23, lon0: -96, lat1: 29.5, lat2: 45.5 } },
      gs50: { label: "GS50, Snyder's projection for the 50 states", spec: { proj: "gs50" } },
      laea50: { label: "Lambert azimuthal on 123 W 47 N, best for the 50", spec: { proj: "laea", lon0: -123, lat0: 47 } },
      sesync: { label: "Lambert azimuthal on 100 W 45 N (the SESYNC recipe)", spec: { proj: "laea", lon0: -100, lat0: 45 } }
    },
    pieces: {
      us48: { name: "Lower 48", main: true },
      alaska: { name: "Alaska", spec: { proj: "aea", lat0: 50, lon0: -154, lat1: 55, lat2: 65, epsg: 3338 } },
      hawaii: { name: "Hawaii", spec: { proj: "aea", lat0: 3, lon0: -157, lat1: 8, lat2: 18, epsg: "ESRI:102007" } },
      puertorico: { name: "Puerto Rico", spec: { proj: "lcc", lat0: 17.833333, lon0: -66.433333, lat1: 18.433333, lat2: 18.033333, epsg: 32161 } },
      usvi: { name: "US Virgin Islands", spec: { proj: "laea", lon0: -64.8, lat0: 18 } },
      guam: { name: "Guam", spec: { ...UTM(55) } },
      cnmi: { name: "Northern Mariana Islands", spec: { ...UTM(55) } },
      amsamoa: { name: "American Samoa", spec: { ...UTM(2, true) } }
    },
    pair: { a: ["Seattle", -122.33, 47.61, "us48"], b: ["Anchorage", -149.9, 61.22, "alaska"] }
  },
  france: {
    name: "France", context: "france", main: "l93",
    mains: { l93: { label: "Lambert-93 (EPSG:2154 geometry)", spec: { proj: "lcc", lat0: 46.5, lon0: 3, lat1: 44, lat2: 49 } } },
    pieces: {
      france: { name: "Metropolitan France", main: true },
      guadeloupe: { name: "Guadeloupe", spec: UTM(20) }, martinique: { name: "Martinique", spec: UTM(20) },
      guyane: { name: "Guyane", spec: UTM(22) }, reunion: { name: "La Reunion", spec: UTM(40, true) }, mayotte: { name: "Mayotte", spec: UTM(38, true) }
    },
    pair: { a: ["Paris", 2.35, 48.86, "france"], b: ["Cayenne", -52.33, 4.94, "guyane"] }
  },
  scotland: {
    name: "Scotland", context: "scotland", main: "bng",
    mains: { bng: { label: "Transverse Mercator on 2 W (British National Grid geometry)", spec: { proj: "tmerc", lon0: -2, k0: 0.9996012717 } } },
    pieces: { scotland: { name: "Scotland", main: true }, shetland: { name: "Shetland", spec: { proj: "tmerc", lon0: -2, k0: 0.9996012717 } } },
    pair: { a: ["Edinburgh", -3.19, 55.95, "scotland"], b: ["Lerwick", -1.145, 60.155, "shetland"] }
  },
  chile: {
    name: "Chile", context: "chile", main: "tm71",
    mains: { tm71: { label: "Transverse Mercator on 71 W", spec: { proj: "tmerc", lon0: -71, k0: 1 } }, utm19: { label: "UTM zone 19S", spec: UTM(19, true) } },
    pieces: {
      chile: { name: "Mainland Chile", main: true },
      easter: { name: "Rapa Nui (Easter Island)", spec: UTM(12, true) },
      juanfernandez: { name: "Juan Fernandez Islands", spec: UTM(17, true) },
      chileantarctic: { name: "Chilean Antarctic Territory (claimed)", spec: { proj: "laea", lon0: -71, lat0: -89.9999 } }
    },
    pair: { a: ["Santiago", -70.67, -33.45, "chile"], b: ["Hanga Roa", -109.43, -27.15, "easter"] }
  },
  spain: {
    name: "Spain", context: "spain", main: "utm30",
    mains: { utm30: { label: "UTM zone 30N", spec: UTM(30) } },
    pieces: { spain: { name: "Peninsula and Balearics", main: true }, canarias: { name: "Canary Islands", spec: UTM(28) } },
    pair: { a: ["Madrid", -3.70, 40.42, "spain"], b: ["Las Palmas", -15.43, 28.12, "canarias"] }
  },
  portugal: {
    name: "Portugal", context: "portugal", main: "pttm",
    mains: { pttm: { label: "PT-TM06 transverse Mercator (EPSG:3763 geometry)", spec: { proj: "tmerc", lon0: -8.133108, k0: 1 } } },
    pieces: { portugal: { name: "Mainland Portugal", main: true }, azores: { name: "Azores", spec: UTM(26) }, madeira: { name: "Madeira", spec: UTM(28) } },
    pair: { a: ["Lisbon", -9.14, 38.72, "portugal"], b: ["Ponta Delgada", -25.67, 37.74, "azores"] }
  },
  norway: {
    name: "Norway", context: "norway", main: "utm33",
    mains: { utm33: { label: "UTM zone 33N", spec: UTM(33) } },
    pieces: {
      norway: { name: "Mainland Norway", main: true }, svalbard: { name: "Svalbard", spec: UTM(33) },
      janmayen: { name: "Jan Mayen", spec: UTM(29) }, bouvet: { name: "Bouvet Island", spec: UTM(32, true) }
    },
    pair: { a: ["Oslo", 10.75, 59.91, "norway"], b: ["Longyearbyen", 15.63, 78.22, "svalbard"] }
  },
  ecuador: {
    name: "Ecuador", context: "ecuador", main: "utm17",
    mains: { utm17: { label: "UTM zone 17S", spec: UTM(17, true) } },
    pieces: { ecuador: { name: "Mainland Ecuador", main: true }, galapagos: { name: "Galapagos Islands", spec: UTM(15, true) } },
    pair: { a: ["Quito", -78.47, -0.18, "ecuador"], b: ["Puerto Ayora", -90.31, -0.74, "galapagos"] }
  },
  nz: {
    name: "New Zealand", context: "nz", main: "nztm",
    mains: { nztm: { label: "NZTM2000 (EPSG:2193 geometry)", spec: { proj: "tmerc", lon0: 173, k0: 0.9996 } } },
    pieces: {
      nz: { name: "North and South Islands", main: true },
      chathams: { name: "Chatham Islands", spec: { proj: "tmerc", lon0: -176.5, k0: 1, epsg: 3793 } },
      kermadec: { name: "Kermadec Islands", spec: { proj: "laea", lon0: -178, lat0: -29.5 } },
      nzsubantarctic: { name: "Sub-Antarctic islands", spec: { proj: "laea", lon0: 168, lat0: -50.5 } }
    },
    pair: { a: ["Wellington", 174.78, -41.29, "nz"], b: ["Waitangi", -176.56, -43.95, "chathams"] }
  },
  denmark: {
    name: "Denmark", context: "denmark", main: "utm32",
    mains: { utm32: { label: "UTM zone 32N", spec: UTM(32) } },
    pieces: {
      denmark: { name: "Denmark", main: true }, bornholm: { name: "Bornholm", spec: UTM(33) },
      faroe: { name: "Faroe Islands", spec: UTM(29) }, greenland: { name: "Greenland", spec: { proj: "laea", lon0: -42, lat0: 72 } }
    },
    pair: { a: ["Copenhagen", 12.57, 55.68, "denmark"], b: ["Nuuk", -51.72, 64.18, "greenland"] }
  },
  tasmania: {
    name: "Tasmania", context: "tasmania", main: "mga55",
    mains: { mga55: { label: "MGA zone 55 (GDA2020)", spec: { ...UTM(55, true), epsg: 7855 } } },
    pieces: { tasmania: { name: "Tasmania with King and Flinders Islands", main: true }, macquarie: { name: "Macquarie Island", spec: { ...UTM(57, true), epsg: 7857 } } },
    pair: { a: ["Hobart", 147.33, -42.88, "tasmania"], b: ["Macquarie station", 158.94, -54.5, "macquarie"] }
  }
};

// A piece's frame projection, or the main one when it has none.
export function pieceCrs(scene, key, main) {
  const p = SCENES[scene].pieces[key];
  return p.main || !p.spec ? main : crs(p.spec);
}

// Place a scene's pieces for a layout { key: { mode, s, rot, ll } } on main
// projection `main` (a crs()). Returns [{ key, mode, crs, placer, anchor }],
// the main piece first; pieces whose mode is "off" are left out. anchors
// are the centres of each piece's rings (centres[key]).
export function placeScene(scene, layout, main, centres, { allTrue = false } = {}) {
  const out = [];
  const keys = Object.keys(SCENES[scene].pieces).sort((a, b) => !!SCENES[scene].pieces[b].main - !!SCENES[scene].pieces[a].main);
  for (const key of keys) {
    const L = layout[key] || { mode: "true" }, mode = SCENES[scene].pieces[key].main ? "true" : L.mode || "true";
    if (mode === "off") continue;
    if (allTrue && mode !== "true") {
      const anchor = centres[key], g = main, at = main.forward(...anchor);
      out.push({ key, mode: "true", crs: g, anchor, s: 1, rot: 0, at, placer: placer({ crs: g, anchor, at, s: 1, rot: 0 }) });
      continue;
    }
    const anchor = centres[key];
    let g = main, s = 1, rot = 0, at = main.forward(...anchor);
    if (mode !== "true") {
      g = mode === "inset" ? pieceCrs(scene, key, main) : main;
      s = L.s ?? 1; rot = mode === "moved" ? L.rot || 0 : 0;
      if (L.ll) at = main.forward(...L.ll);
      else if (L.at) at = L.at;
    }
    out.push({ key, mode, crs: g, anchor, s, rot, at, bw: L.bw, placer: placer({ crs: g, anchor, at, s, rot }) });
  }
  return out;
}

// The six numbers of a placed piece's affine from its own projection's
// metres to the page (the main frame's metres): X = a x + b y + c, Y = d x + e y + f.
export function affineOf(piece) {
  const t = (piece.rot || 0) * D2R, c = Math.cos(t) * piece.s, sn = Math.sin(t) * piece.s;
  const [ax, ay] = piece.crs.forward(...piece.anchor);
  return [c, -sn, piece.at[0] - c * ax + sn * ay, sn, c, piece.at[1] - sn * ax - c * ay];
}
