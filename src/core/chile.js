// One country, which grid? Map projections for mainland Chile, and what
// each one does to area, distance and shape over the land.
//
// Chile's official grid is UTM on SIRGAS-Chile: zone 19S (69 W) and 18S
// (75 W) on the mainland, 12S on Easter Island (EPSG:20049, 20048 and 20042
// on SIRGAS-Chile 2021). The country is about 4 300 km long and seldom
// more than 350 km wide, but it reaches from 66.4 W to 75.7 W, so neither
// zone is centred on it. The alternatives here are one transverse Mercator
// on a chosen meridian (Argentina's Faja 1 on POSGAR 2007, EPSG:5343, is
// the same idea next door), the equal-area Albers conic and Lambert
// azimuthal, a Lambert conformal conic, and longitude and latitude used as
// a grid.
//
// Each projection is a forward and inverse on GRS80 in metres, with the
// PROJ string it stands for. Scale factors come from factors() in
// tissot.js, which follows PROJ's proj_factors(). The conics are
// vicgrid.js's (Snyder 1987), the transverse Mercator is mgrs.js's
// (Karney 2011) and the azimuthal is Snyder's ellipsoidal oblique Lambert
// azimuthal equal-area (chapter 24). All checked against PROJ in
// test/check-chile.mjs.

import { tmerc, tmercInverse } from "./mgrs.js";
import { lcc, aea } from "./vicgrid.js";
import { factors } from "./tissot.js";

const D2R = Math.PI / 180;
export const A = 6378137, RF = 298.257222101;
const F = 1 / RF, E2 = F * (2 - F), E = Math.sqrt(E2);

// ---------------------------------------------------------------- laea

const qOf = (p) => {
  const s = Math.sin(p);
  return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
};
// latitude from q, by Snyder's iteration (eq. 3-16)
function latFromQ(q) {
  let p = Math.asin(Math.max(-1, Math.min(1, q / 2)));
  for (let i = 0; i < 20; i++) {
    const s = Math.sin(p), w = 1 - E2 * s * s, c = Math.cos(p);
    if (Math.abs(c) < 1e-12) break;
    const dp = ((w * w) / (2 * c)) * (q / (1 - E2) - s / w + (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
    p += dp;
    if (Math.abs(dp) < 1e-14) break;
  }
  return p;
}

// Lambert azimuthal equal-area, oblique aspect, on the ellipsoid.
export function laea({ lon0, lat0, x0 = 0, y0 = 0 }) {
  const qp = qOf(Math.PI / 2), Rq = A * Math.sqrt(qp / 2);
  const p1 = lat0 * D2R, b1 = Math.asin(qOf(p1) / qp);
  const m1 = Math.cos(p1) / Math.sqrt(1 - E2 * Math.sin(p1) ** 2);
  const D = (A * m1) / (Rq * Math.cos(b1));
  const forward = (lon, lat) => {
    const b = Math.asin(Math.max(-1, Math.min(1, qOf(lat * D2R) / qp))), dl = (lon - lon0) * D2R;
    const B = Rq * Math.sqrt(2 / (1 + Math.sin(b1) * Math.sin(b) + Math.cos(b1) * Math.cos(b) * Math.cos(dl)));
    return [x0 + B * D * Math.cos(b) * Math.sin(dl), y0 + (B / D) * (Math.cos(b1) * Math.sin(b) - Math.sin(b1) * Math.cos(b) * Math.cos(dl))];
  };
  const inverse = (X, Y) => {
    const x = X - x0, y = Y - y0, rho = Math.hypot(x / D, D * y);
    if (rho < 1e-9) return [lon0, lat0];
    const ce = 2 * Math.asin(Math.min(1, rho / (2 * Rq)));
    const q = qp * (Math.cos(ce) * Math.sin(b1) + (D * y * Math.sin(ce) * Math.cos(b1)) / rho);
    const lam = Math.atan2(x * Math.sin(ce), D * rho * Math.cos(b1) * Math.cos(ce) - D * D * y * Math.sin(b1) * Math.sin(ce));
    return [lon0 + lam / D2R, latFromQ(q) / D2R];
  };
  return { forward, inverse };
}

// ---------------------------------------------------------------- the grids

// Transverse Mercator about lon0 with scale k0 on it. y0 is the false
// northing; lat0 = -90 (Argentina's fajas) counts northings from the pole.
function tm({ lon0, k0, x0, y0 = 0, lat0 = 0 }) {
  const n0 = lat0 ? -tmerc(lon0, lat0, lon0, k0)[1] : 0;
  return {
    forward: (lon, lat) => { const [x, y] = tmerc(lon, lat, lon0, k0); return [x + x0, y + y0 + n0]; },
    inverse: (X, Y) => tmercInverse(X - x0, Y - y0 - n0, lon0, k0)
  };
}

// Longitude and latitude used as a grid: PROJ's +proj=eqc on GRS80, which
// keeps the meridians true (northing is the meridian arc) and stretches the
// parallels by a / (nu cos lat), so equal steps of longitude are equal steps
// of easting at every latitude. The meridian arc is the transverse Mercator
// on its own central meridian with k0 = 1.
function eqc() {
  return {
    forward: (lon, lat) => [A * lon * D2R, tmerc(0, lat, 0, 1)[1]],
    inverse: (x, y) => [x / A / D2R, tmercInverse(0, y, 0, 1)[1]]
  };
}

const r6 = (v) => +(+v).toFixed(6);

// The kinds of grid the page offers. `params` are the ones a person can
// change; `build(p)` returns { forward, inverse, proj, epsg, lines } where
// lines are the meridians and parallels worth drawing (central meridian,
// standard parallels).
export const KINDS = {
  utm19: {
    label: "UTM zone 19S", kind: "conformal", params: [],
    build: () => ({ ...tm({ lon0: -69, k0: 0.9996, x0: 500000, y0: 10000000 }), epsg: 20049, name: "SIRGAS-Chile 2021 / UTM zone 19S",
      proj: "+proj=utm +zone=19 +south +ellps=GRS80 +units=m +no_defs", lines: { lon: [-69] } })
  },
  utm18: {
    label: "UTM zone 18S", kind: "conformal", params: [],
    build: () => ({ ...tm({ lon0: -75, k0: 0.9996, x0: 500000, y0: 10000000 }), epsg: 20048, name: "SIRGAS-Chile 2021 / UTM zone 18S",
      proj: "+proj=utm +zone=18 +south +ellps=GRS80 +units=m +no_defs", lines: { lon: [-75] } })
  },
  tm: {
    label: "Transverse Mercator on a chosen meridian", kind: "conformal", params: ["lon0", "kppm"],
    build: (p) => {
      const k0 = 1 + p.kppm * 1e-6;
      return { ...tm({ lon0: p.lon0, k0, x0: 500000, y0: 10000000 }), epsg: null, name: `Transverse Mercator ${-p.lon0}${"\u00b0"}W`,
        proj: `+proj=tmerc +lat_0=0 +lon_0=${r6(p.lon0)} +k=${r6(k0)} +x_0=500000 +y_0=10000000 +ellps=GRS80 +units=m +no_defs`, lines: { lon: [p.lon0] } };
    }
  },
  faja1: {
    label: "Argentina Faja 1 (TM 72W, k = 1)", kind: "conformal", params: [],
    build: () => ({ ...tm({ lon0: -72, k0: 1, x0: 1500000, lat0: -90 }), epsg: 5343, name: "POSGAR 2007 / Argentina 1",
      proj: "+proj=tmerc +lat_0=-90 +lon_0=-72 +k=1 +x_0=1500000 +y_0=0 +ellps=GRS80 +units=m +no_defs", lines: { lon: [-72] } })
  },
  aea: {
    label: "Albers equal-area conic", kind: "equal-area", params: ["lon0", "lat0", "lat1", "lat2"],
    build: (p) => ({ ...aea({ lat0: p.lat0, lon0: p.lon0, lat1: p.lat1, lat2: p.lat2 }), epsg: null, name: "Albers equal-area conic",
      proj: `+proj=aea +lat_0=${r6(p.lat0)} +lon_0=${r6(p.lon0)} +lat_1=${r6(p.lat1)} +lat_2=${r6(p.lat2)} +ellps=GRS80 +units=m +no_defs`,
      lines: { lon: [p.lon0], lat: [p.lat1, p.lat2] } })
  },
  laea: {
    label: "Lambert azimuthal equal-area", kind: "equal-area", params: ["lon0", "lat0"],
    build: (p) => ({ ...laea({ lon0: p.lon0, lat0: p.lat0 }), epsg: null, name: "Lambert azimuthal equal-area",
      proj: `+proj=laea +lat_0=${r6(p.lat0)} +lon_0=${r6(p.lon0)} +ellps=GRS80 +units=m +no_defs`, lines: { lon: [p.lon0], centre: [p.lon0, p.lat0] } })
  },
  lcc: {
    label: "Lambert conformal conic", kind: "conformal", params: ["lon0", "lat0", "lat1", "lat2"],
    build: (p) => ({ ...lcc({ lat0: p.lat0, lon0: p.lon0, lat1: p.lat1, lat2: p.lat2 }), epsg: null, name: "Lambert conformal conic",
      proj: `+proj=lcc +lat_0=${r6(p.lat0)} +lon_0=${r6(p.lon0)} +lat_1=${r6(p.lat1)} +lat_2=${r6(p.lat2)} +ellps=GRS80 +units=m +no_defs`,
      lines: { lon: [p.lon0], lat: [p.lat1, p.lat2] } })
  },
  lonlat: {
    label: "Longitude and latitude as a grid", kind: "neither", params: [],
    build: () => ({ ...eqc(), epsg: 20041, name: "SIRGAS-Chile 2021 longitude and latitude (drawn as eqc)",
      proj: "+proj=eqc +ellps=GRS80 +units=m +no_defs", lines: {} })
  }
};

export function build(kind, p) {
  const k = KINDS[kind];
  return { id: kind, kind: k.kind, label: k.label, ...k.build(p) };
}

// PROJ's scale factors at lon, lat: h, k, s (areal), a, b, omega (degrees).
export function scaleAt(g, lon, lat) {
  return factors((l, p) => { const [x, y] = g.forward(l, p); return [x / A, y / A]; }, lon, lat, { es: E2 });
}

// The linear scale error that matters most at a point: the larger of a - 1
// and 1 - b, with its sign.
export const worstScale = (f) => (f.a - 1 >= 1 - f.b ? f.a : f.b);

// Ground area of a cell that is `size` metres square on the map, and its
// error against the size * size the grid says it is.
export const cellError = (f, size) => (size * size) / f.s - size * size;

// ---------------------------------------------------------------- the land

// Points on a regular lon/lat lattice inside any of the rings (even-odd), as
// a flat [lon, lat, ...] array.
export function landSample(rings, step, [w, s, e, n]) {
  const out = [];
  for (let lat = s + step / 2; lat < n; lat += step) {
    // the crossings of this parallel with every ring, sorted
    const xs = [];
    for (const r of rings) {
      for (let i = 0, m = r.length; i < m; i += 2) {
        const j = (i + 2) % m, y1 = r[i + 1], y2 = r[j + 1];
        if ((y1 > lat) !== (y2 > lat)) xs.push(r[i] + ((lat - y1) / (y2 - y1)) * (r[j] - r[i]));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(w, xs[k]), b = Math.min(e, xs[k + 1]);
      for (let lon = Math.ceil((a - w) / step - 0.5) * step + w + step / 2; lon < b; lon += step) out.push(lon, lat);
    }
  }
  return out;
}

// Area, distance and shape over the land: the range of the areal scale, of
// the cell error for `size` metre cells, of the linear scale (b to a), and
// the largest angular distortion.
export function landStats(g, pts, size) {
  const r = { n: 0, sMin: Infinity, sMax: -Infinity, eMin: Infinity, eMax: -Infinity, bMin: Infinity, aMax: -Infinity, omegaMax: 0 };
  for (let i = 0; i < pts.length; i += 2) {
    const f = scaleAt(g, pts[i], pts[i + 1]);
    if (!f) continue;
    r.n++;
    r.sMin = Math.min(r.sMin, f.s); r.sMax = Math.max(r.sMax, f.s);
    const c = cellError(f, size);
    r.eMin = Math.min(r.eMin, c); r.eMax = Math.max(r.eMax, c);
    r.bMin = Math.min(r.bMin, f.b); r.aMax = Math.max(r.aMax, f.a);
    r.omegaMax = Math.max(r.omegaMax, f.omega);
  }
  return r;
}

// The UTM zone a longitude falls in.
export const utmZone = (lon) => Math.floor((lon + 180) / 6) + 1;
