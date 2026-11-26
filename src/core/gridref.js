// Grid references: what the numbers on a map grid mean.
//
// A point's UTM (or MGA) coordinates read as a short grid reference, a
// military (MGRS) one and a street-directory page and square, and the parts
// that explain them: how far the point is from its zone's central meridian
// and from the equator, the point scale and the grid convergence there, and
// where the zone's own 0,0 lands on the Earth. Built on src/core/mgrs.js
// (Krueger's series, as PROJ's tmerc).
//
// The street directory is made up for the explainer: pages 4 km wide and
// 5 km tall cut from the kilometre grid inside each 100 km square, numbered
// across and then down from 1 in the square's north-west corner, with
// 500 m squares lettered A-H across and numbered 1-10 down.

import * as M from "./mgrs.js";

const D2R = Math.PI / 180;
const E2 = M.F * (2 - M.F);

export const FALSE_EASTING = 500000, FALSE_NORTHING_SOUTH = 1e7;
export const ATLAS = { pageW: 4000, pageH: 5000, square: 500, across: 25 };
const COLS = "ABCDEFGH";

// meridional and prime-vertical radii of curvature at latitude phi (radians)
function radii(phi) {
  const s = Math.sin(phi), w = Math.sqrt(1 - E2 * s * s);
  return { rho: (M.A * (1 - E2)) / (w * w * w), nu: M.A / w };
}

// Point scale k and grid convergence (degrees: the angle from grid north
// to true north, clockwise, so positive where the meridian leans east of
// grid north) at lon, lat in a zone, by differencing the projection along
// the meridian. The projection is conformal, so k holds in every direction.
export function scaleAndConvergence(lon, lat, zone) {
  const lon0 = M.centralMeridian(zone), d = 1e-6;
  const [x1, y1] = M.tmerc(lon, lat - d, lon0), [x2, y2] = M.tmerc(lon, lat + d, lon0);
  const ground = radii(lat * D2R).rho * 2 * d * D2R;
  return { k: Math.hypot(x2 - x1, y2 - y1) / ground, conv: Math.atan2(x2 - x1, y2 - y1) / D2R };
}

// The distance from the central meridian, at latitude lat, where the scale
// is true (k = 1): one of the two lines where the cylinder cuts the
// ellipsoid. Metres of grid easting from the central meridian.
export function trueScaleOffset(lat, zone = 31) {
  const lon0 = M.centralMeridian(zone);
  let lo = 0, hi = 10;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (scaleAndConvergence(lon0 + mid, lat, zone).k < 1) lo = mid; else hi = mid;
  }
  return M.tmerc(lon0 + lo, lat, lon0)[0];
}

// Grid width of a zone (from its west to its east edge meridian) at lat.
export const zoneWidth = (lat) => 2 * M.tmerc(3, lat, 0)[0];

// The grid northing of a pole: the meridian quadrant times 0.9996, so the
// south pole sits a little above northing 0 in a southern zone.
export function poleNorthing(south = true) {
  const y = M.tmerc(0, 90, 0)[1];
  return south ? FALSE_NORTHING_SOUTH - y : y;
}

// The longitude and latitude of a zone's false origin, its easting 0 and
// northing 0. North of the equator it is on the equator, 500 km of grid
// west of the central meridian. South of it, 0,0 is 10 000 km of grid
// south of the equator: past the south pole, on the far side of it.
export const falseOrigin = (zone, south) => M.fromUTM(zone, south, 0, 0);

// Street directory page and square for a UTM position.
export function atlas(e, n) {
  const A = ATLAS, sqE = Math.floor(e / 1e5) * 1e5, sqN = Math.floor(n / 1e5) * 1e5;
  const col = Math.floor((e - sqE) / A.pageW), row = Math.floor((sqN + 1e5 - n) / A.pageH);
  const west = sqE + col * A.pageW, north = sqN + 1e5 - row * A.pageH;
  const across = Math.floor((e - west) / A.square), down = Math.floor((north - n) / A.square);
  return {
    page: 1 + row * A.across + col, letter: COLS[across], number: down + 1,
    west, north, east: west + A.pageW, south: north - A.pageH,
    squareWest: west + across * A.square, squareNorth: north - down * A.square
  };
}

// The page with a given number, in the 100 km square holding e, n.
export function atlasPage(page, e, n) {
  const sqE = Math.floor(e / 1e5) * 1e5, sqN = Math.floor(n / 1e5) * 1e5;
  const col = (page - 1) % ATLAS.across, row = Math.floor((page - 1) / ATLAS.across);
  const west = sqE + col * ATLAS.pageW, north = sqN + 1e5 - row * ATLAS.pageH;
  return { page, west, north, east: west + ATLAS.pageW, south: north - ATLAS.pageH };
}

// Digits of an easting or northing, split by what they count. The last
// five digits are the place inside the 100 km square; what comes before is
// the count of 100 km from the false origin (the part MGRS letters replace).
export function splitDigits(v) {
  const s = String(Math.floor(v));
  const head = s.slice(0, -5), tail = s.slice(-5).padStart(5, "0");
  return { hundredKm: head, km: tail.slice(0, 2), hundredM: tail[2], tenM: tail[3], m: tail[4] };
}

// A short reference of `figures` digits in all (4, 6, 8 or 10): easting
// then northing inside the 100 km square, each truncated (not rounded) to
// the cell it falls in.
export function shortRef(e, n, figures) {
  const d = figures / 2;
  const part = (v) => String(Math.floor(v % 1e5)).padStart(5, "0").slice(0, d);
  return [part(e), part(n)];
}

// Everything the explainer says about a point.
export function describe(lon, lat) {
  const m = M.toMGRS(lon, lat, 5);
  if (!m || m.ups) {
    const u = M.toUPS(lon, lat);
    return { lon, lat, ups: true, north: u.north, e: u.e, n: u.n, mgrs: m };
  }
  const { zone, south, e, n } = m;
  const { k, conv } = scaleAndConvergence(lon, lat, zone);
  const lon0 = M.centralMeridian(zone);
  return {
    lon, lat, zone, south, e, n, band: m.band, gzd: m.gzd, square: m.square,
    mgrs: `${m.gzd} ${m.square} ${shortRef(e, n, 10).join(" ")}`,
    six: shortRef(e, n, 6), eight: shortRef(e, n, 8),
    lon0, west: lon0 - 3, east: lon0 + 3,
    fromCM: e - FALSE_EASTING,
    fromEquator: south ? FALSE_NORTHING_SOUTH - n : n,
    k, conv, atlas: atlas(e, n),
    epsg: M.epsg(zone, south),
    origin: falseOrigin(zone, south)
  };
}
