// VicGrid and its neighbours: the state and national grids of south-east
// Australia, and the datum shifts between AGD66, GDA94 and GDA2020.
//
// Victoria spans about 141 to 150 E, so the 6 degree UTM zones of the
// national grid (AMG on AGD66, then MGA on GDA94 and GDA2020) split it at
// 144 E. VicGrid is one Lambert conformal conic for the whole state:
// standard parallels 36 and 38 S, origin 37 S 145 E. Its false origin moved
// with the datum: Vicgrid66 (AGD66, EPSG:3110) has false northing
// 4 500 000 m, Vicgrid94 (GDA94, EPSG:3111) and GDA2020 / Vicgrid
// (EPSG:7899) have 2 500 000 m. NSW Lambert and SA Lambert are the same idea
// for the neighbouring states; Australian Albers is the equal-area map of
// the whole continent.
//
// The projections are Snyder (1987): Lambert conformal conic with two
// standard parallels (chapter 15) and Albers equal-area conic (chapter 14)
// on the ellipsoid, and mgrs.js's transverse Mercator for MGA. Datum shifts
// are PROJ's seven-parameter Helmert transformations (coordinate frame
// convention): AGD66 to GDA94 for NSW and Victoria
// ("AGD66 to GDA94 (4)", about 1 m) and GDA94 to GDA2020 (EPSG:8048).
// All checked against PROJ in test/check-vicgrid.mjs.

import { tmerc, tmercInverse } from "./mgrs.js";

const D2R = Math.PI / 180;

export const ELLPS = {
  GRS80: { a: 6378137, rf: 298.257222101 },
  aust_SA: { a: 6378160, rf: 298.25 }
};
const consts = (name) => {
  const { a, rf } = ELLPS[name], f = 1 / rf, e2 = f * (2 - f);
  return { a, f, e2, e: Math.sqrt(e2) };
};

// ---------------------------------------------------------------- conics

const mOf = (e2, p) => Math.cos(p) / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
const tOf = (e, p) => Math.tan(Math.PI / 4 - p / 2) / Math.pow((1 - e * Math.sin(p)) / (1 + e * Math.sin(p)), e / 2);

// Lambert conformal conic with two standard parallels. Returns forward
// (lon, lat) -> [E, N], inverse and k (scale, the same in all directions).
export function lcc({ lat0, lon0, lat1, lat2, x0 = 0, y0 = 0, ellps = "GRS80" }) {
  const { a, e2, e } = consts(ellps);
  const p1 = lat1 * D2R, p2 = lat2 * D2R, p0 = lat0 * D2R;
  const m1 = mOf(e2, p1), m2 = mOf(e2, p2), t1 = tOf(e, p1), t2 = tOf(e, p2);
  const n = (Math.log(m1) - Math.log(m2)) / (Math.log(t1) - Math.log(t2));
  const F = m1 / (n * Math.pow(t1, n));
  const rho0 = a * F * Math.pow(tOf(e, p0), n);
  const sg = Math.sign(n);
  const forward = (lon, lat) => {
    const rho = a * F * Math.pow(tOf(e, lat * D2R), n), th = n * (lon - lon0) * D2R;
    return [x0 + rho * Math.sin(th), y0 + rho0 - rho * Math.cos(th)];
  };
  const inverse = (E, N) => {
    const x = E - x0, y = rho0 - (N - y0);
    const rho = sg * Math.hypot(x, y), th = Math.atan2(sg * x, sg * y);
    const t = Math.pow(rho / (a * F), 1 / n);
    let p = Math.PI / 2 - 2 * Math.atan(t);
    for (let i = 0; i < 15; i++) {
      const s = e * Math.sin(p);
      p = Math.PI / 2 - 2 * Math.atan(t * Math.pow((1 - s) / (1 + s), e / 2));
    }
    return [lon0 + th / n / D2R, p / D2R];
  };
  const k = (lon, lat) => {
    const p = lat * D2R;
    return (a * F * Math.pow(tOf(e, p), n) * n) / (a * mOf(e2, p));
  };
  return { forward, inverse, k, n };
}

// Albers equal-area conic with two standard parallels. k is the scale along
// the parallel (1/k along the meridian).
export function aea({ lat0, lon0, lat1, lat2, x0 = 0, y0 = 0, ellps = "GRS80" }) {
  const { a, e2, e } = consts(ellps);
  const q = (p) => {
    const s = Math.sin(p);
    return (1 - e2) * (s / (1 - e2 * s * s) - (1 / (2 * e)) * Math.log((1 - e * s) / (1 + e * s)));
  };
  const p1 = lat1 * D2R, p2 = lat2 * D2R;
  const m1 = mOf(e2, p1), m2 = mOf(e2, p2), q1 = q(p1), q2 = q(p2);
  const n = (m1 * m1 - m2 * m2) / (q2 - q1), C = m1 * m1 + n * q1;
  const rho0 = (a * Math.sqrt(C - n * q(lat0 * D2R))) / n;
  const rhoOf = (p) => (a * Math.sqrt(C - n * q(p))) / n;
  const forward = (lon, lat) => {
    const rho = rhoOf(lat * D2R), th = n * (lon - lon0) * D2R;
    return [x0 + rho * Math.sin(th), y0 + rho0 - rho * Math.cos(th)];
  };
  const sg = Math.sign(n);
  const inverse = (E, N) => {
    const x = E - x0, y = rho0 - (N - y0);
    const rho = Math.hypot(x, y), th = Math.atan2(sg * x, sg * y);
    const qq = (C - (rho * rho * n * n) / (a * a)) / n;
    let p = Math.asin(Math.max(-1, Math.min(1, qq / 2)));
    for (let i = 0; i < 15; i++) {
      const s = Math.sin(p), w = 1 - e2 * s * s;
      p += ((w * w) / (2 * Math.cos(p))) * (qq / (1 - e2) - s / w + (1 / (2 * e)) * Math.log((1 - e * s) / (1 + e * s)));
    }
    return [lon0 + th / n / D2R, p / D2R];
  };
  const k = (lon, lat) => (rhoOf(lat * D2R) * n) / (a * mOf(e2, lat * D2R));
  return { forward, inverse, k, n };
}

// MGA (and AMG) zones: UTM south, false northing 10 000 km. mgrs.js's
// transverse Mercator is on WGS84, which is GRS80 to a tenth of a millimetre.
export function mga(zone) {
  const lon0 = 6 * zone - 183;
  return {
    forward: (lon, lat) => { const [x, y] = tmerc(lon, lat, lon0); return [x + 500000, y + 10000000]; },
    inverse: (E, N) => tmercInverse(E - 500000, N - 10000000, lon0),
    k: (lon, lat) => scaleAlongParallel(lon, lat, (a, b) => tmerc(a, b, lon0), "GRS80"),
    lon0
  };
}

// The scale along the parallel from the forward projection, by differences.
export function scaleAlongParallel(lon, lat, fwd, ellps = "GRS80") {
  const { a, e2 } = consts(ellps), d = 1e-4;
  const p = lat * D2R, nu = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  const u = fwd(lon - d, lat), v = fwd(lon + d, lat);
  return Math.hypot(v[0] - u[0], v[1] - u[1]) / (nu * Math.cos(p) * 2 * d * D2R);
}

// ---------------------------------------------------------------- the grids

export const VICGRID = { lat0: -37, lon0: 145, lat1: -36, lat2: -38, x0: 2500000 };

// id: { name, epsg, datum, kind, proj, ...projection }
export const CRS = {};
function add(id, name, epsg, datum, kind, proj, p) { CRS[id] = { id, name, epsg, datum, kind, proj, ...p }; }
const ell = (d) => (d === "AGD66" ? "aust_SA" : "GRS80");
add("vicgrid", "GDA2020 / Vicgrid", 7899, "GDA2020", "conformal",
  "+proj=lcc +lat_0=-37 +lon_0=145 +lat_1=-36 +lat_2=-38 +x_0=2500000 +y_0=2500000 +ellps=GRS80 +units=m +no_defs",
  lcc({ ...VICGRID, y0: 2500000 }));
add("vicgrid94", "GDA94 / Vicgrid", 3111, "GDA94", "conformal",
  "+proj=lcc +lat_0=-37 +lon_0=145 +lat_1=-36 +lat_2=-38 +x_0=2500000 +y_0=2500000 +ellps=GRS80 +units=m +no_defs",
  lcc({ ...VICGRID, y0: 2500000 }));
add("vicgrid66", "AGD66 / Vicgrid66", 3110, "AGD66", "conformal",
  "+proj=lcc +lat_0=-37 +lon_0=145 +lat_1=-36 +lat_2=-38 +x_0=2500000 +y_0=4500000 +ellps=aust_SA +units=m +no_defs",
  lcc({ ...VICGRID, y0: 4500000, ellps: ell("AGD66") }));
add("mga54", "GDA2020 / MGA zone 54", 7854, "GDA2020", "conformal", "+proj=utm +zone=54 +south +ellps=GRS80 +units=m +no_defs", mga(54));
add("mga55", "GDA2020 / MGA zone 55", 7855, "GDA2020", "conformal", "+proj=utm +zone=55 +south +ellps=GRS80 +units=m +no_defs", mga(55));
add("nsw", "GDA2020 / NSW Lambert", 8058, "GDA2020", "conformal",
  "+proj=lcc +lat_0=-33.25 +lon_0=147 +lat_1=-30.75 +lat_2=-35.75 +x_0=9300000 +y_0=4500000 +ellps=GRS80 +units=m +no_defs",
  lcc({ lat0: -33.25, lon0: 147, lat1: -30.75, lat2: -35.75, x0: 9300000, y0: 4500000 }));
add("sa", "GDA2020 / SA Lambert", 8059, "GDA2020", "conformal",
  "+proj=lcc +lat_0=-32 +lon_0=135 +lat_1=-28 +lat_2=-36 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs",
  lcc({ lat0: -32, lon0: 135, lat1: -28, lat2: -36, x0: 1000000, y0: 2000000 }));
add("albers", "GDA94 / Australian Albers", 3577, "GDA94", "equal-area",
  "+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs",
  aea({ lat0: 0, lon0: 132, lat1: -18, lat2: -36 }));

// ---------------------------------------------------------------- datums

// Helmert parameters, coordinate frame convention: metres, arcseconds, ppm
const HELMERT = {
  "AGD66>GDA94": { from: "aust_SA", to: "GRS80", x: -119.353, y: -48.301, z: 139.484, rx: -0.415, ry: -0.26, rz: -0.437, s: -0.613 },
  "GDA94>GDA2020": { from: "GRS80", to: "GRS80", x: 0.06155, y: -0.01087, z: -0.04019, rx: -0.0394924, ry: -0.0327221, rz: -0.0328979, s: -0.009994 }
};
export const DATUMS = ["AGD66", "GDA94", "GDA2020"];

export function toCart(lon, lat, h, ellps) {
  const { a, e2 } = consts(ellps), p = lat * D2R, l = lon * D2R;
  const nu = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  return [(nu + h) * Math.cos(p) * Math.cos(l), (nu + h) * Math.cos(p) * Math.sin(l), (nu * (1 - e2) + h) * Math.sin(p)];
}
export function fromCart(X, Y, Z, ellps) {
  const { a, e2 } = consts(ellps), r = Math.hypot(X, Y);
  let p = Math.atan2(Z, r * (1 - e2)), h = 0;
  for (let i = 0; i < 10; i++) {
    const nu = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
    h = r / Math.cos(p) - nu;
    p = Math.atan2(Z, r * (1 - (e2 * nu) / (nu + h)));
  }
  return [Math.atan2(Y, X) / D2R, p / D2R, h];
}

// The rotation matrix of the coordinate frame convention, scaled
function helmertMatrix(c) {
  const as = D2R / 3600, rx = c.rx * as, ry = c.ry * as, rz = c.rz * as, m = 1 + c.s * 1e-6;
  return [[m, m * rz, -m * ry], [-m * rz, m, m * rx], [m * ry, -m * rx, m]];
}
function helmert(c, [X, Y, Z], inverse = false) {
  const R = helmertMatrix(c);
  if (!inverse) return [0, 1, 2].map((i) => [c.x, c.y, c.z][i] + R[i][0] * X + R[i][1] * Y + R[i][2] * Z);
  // solve R v = X - T exactly (Cramer), so a shift and its inverse undo each other
  const b = [X - c.x, Y - c.y, Z - c.z];
  const det = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const D = det(R);
  return [0, 1, 2].map((j) => det(R.map((row, i) => row.map((v, k) => (k === j ? b[i] : v)))) / D);
}

// lon, lat (degrees, ellipsoidal height 0) on datum `from` to datum `to`.
export function shift(lon, lat, from, to) {
  let i = DATUMS.indexOf(from), j = DATUMS.indexOf(to);
  if (i < 0 || j < 0) throw new Error(`unknown datum ${from} or ${to}`);
  let ll = [lon, lat, 0];
  while (i !== j) {
    const fwd = j > i, key = fwd ? `${DATUMS[i]}>${DATUMS[i + 1]}` : `${DATUMS[i - 1]}>${DATUMS[i]}`, c = HELMERT[key];
    const X = toCart(ll[0], ll[1], ll[2], fwd ? c.from : c.to);
    ll = fromCart(...helmert(c, X, !fwd), fwd ? c.to : c.from);
    i += fwd ? 1 : -1;
  }
  return [ll[0], ll[1]];
}

// GDA2020 lon/lat to a grid's easting and northing (through its datum).
export function toGrid(id, lon, lat, datum = "GDA2020") {
  const c = CRS[id], ll = c.datum === datum ? [lon, lat] : shift(lon, lat, datum, c.datum);
  return c.forward(ll[0], ll[1]);
}
export function fromGrid(id, E, N, datum = "GDA2020") {
  const c = CRS[id], ll = c.inverse(E, N);
  return c.datum === datum ? ll : shift(ll[0], ll[1], c.datum, datum);
}

// The MGA zone a longitude falls in.
export const mgaZone = (lon) => Math.floor((lon + 180) / 6) + 1;

// Distance on the ellipsoid between two nearby lon/lats (metres), for the
// size of a datum shift.
export function nearDistance(lon1, lat1, lon2, lat2, ellps = "GRS80") {
  const { a, e2 } = consts(ellps), p = ((lat1 + lat2) / 2) * D2R, w = 1 - e2 * Math.sin(p) ** 2;
  const M = (a * (1 - e2)) / Math.pow(w, 1.5), nu = a / Math.sqrt(w);
  return Math.hypot((lat2 - lat1) * D2R * M, (lon2 - lon1) * D2R * nu * Math.cos(p));
}
