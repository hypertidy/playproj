// The Ordnance Survey National Grid of Great Britain (OSGB36, EPSG:27700):
// a single transverse Mercator on the Airy 1830 ellipsoid, its letter
// squares and grid references, and a Helmert shift between WGS84 (or
// ETRS89) and OSGB36.
//
// The projection is Krueger's series (Karney 2011, as PROJ's tmerc) on Airy
// 1830: true origin 49N 2W, scale 0.9996012717 on the central meridian,
// false origin 400 km west and 100 km north of the true origin.
//
// The datum shift is the seven-parameter Helmert transformation Ordnance
// Survey publishes in "A guide to coordinate systems in Great Britain",
// good to a few metres. The exact transformation is the OSTN15 grid (PROJ's
// uk_os_OSTN15_NTv2_OSGBtoETRS.tif), which this does not use.
// Checked against PROJ in test/check-osgb.mjs.

const D2R = Math.PI / 180;

export const AIRY = { a: 6377563.396, b: 6356256.909 };
export const WGS84 = { a: 6378137, f: 1 / 298.257223563 };
export const NATGRID = { lat0: 49, lon0: -2, k0: 0.9996012717, x0: 400000, y0: -100000 };

// Transverse Mercator (Krueger 6th order) on an ellipsoid of semi-major
// axis a and flattening f. Returns forward(lon, lat) -> [x, y] and
// inverse(x, y) -> [lon, lat], in metres about lon0 and the equator,
// scaled by k0, before any false easting or northing.
export function krueger(a, f) {
  const e2 = f * (2 - f), e = Math.sqrt(e2), n = f / (2 - f);
  const n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
  const rect = (a / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
  const alpha = [
    n / 2 - (2 / 3) * n2 + (5 / 16) * n3 + (41 / 180) * n4 - (127 / 288) * n5 + (7891 / 37800) * n6,
    (13 / 48) * n2 - (3 / 5) * n3 + (557 / 1440) * n4 + (281 / 630) * n5 - (1983433 / 1935360) * n6,
    (61 / 240) * n3 - (103 / 140) * n4 + (15061 / 26880) * n5 + (167603 / 181440) * n6,
    (49561 / 161280) * n4 - (179 / 168) * n5 + (6601661 / 7257600) * n6,
    (34729 / 80640) * n5 - (3418889 / 1995840) * n6,
    (212378941 / 319334400) * n6
  ];
  const beta = [
    n / 2 - (2 / 3) * n2 + (37 / 96) * n3 - (1 / 360) * n4 - (81 / 512) * n5 + (96199 / 604800) * n6,
    (1 / 48) * n2 + (1 / 15) * n3 - (437 / 1440) * n4 + (46 / 105) * n5 - (1118711 / 3870720) * n6,
    (17 / 480) * n3 - (37 / 840) * n4 - (209 / 4480) * n5 + (5569 / 90720) * n6,
    (4397 / 161280) * n4 - (11 / 504) * n5 - (830251 / 7257600) * n6,
    (4583 / 161280) * n5 - (108847 / 3991680) * n6,
    (20648693 / 638668800) * n6
  ];
  function forward(lon, lat, lon0, k0) {
    const lam = ((((lon - lon0) + 540) % 360) - 180) * D2R, s = Math.sin(lat * D2R);
    const tau = Math.sinh(Math.atanh(s) - e * Math.atanh(e * s));
    const xi1 = Math.atan2(tau, Math.cos(lam)), eta1 = Math.atanh(Math.sin(lam) / Math.sqrt(1 + tau * tau));
    let xi = xi1, eta = eta1;
    for (let j = 1; j <= 6; j++) {
      xi += alpha[j - 1] * Math.sin(2 * j * xi1) * Math.cosh(2 * j * eta1);
      eta += alpha[j - 1] * Math.cos(2 * j * xi1) * Math.sinh(2 * j * eta1);
    }
    return [k0 * rect * eta, k0 * rect * xi];
  }
  function inverse(x, y, lon0, k0) {
    const xi = y / (k0 * rect), eta = x / (k0 * rect);
    let xi1 = xi, eta1 = eta;
    for (let j = 1; j <= 6; j++) {
      xi1 -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
      eta1 -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    }
    const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1)), lam = Math.atan2(Math.sinh(eta1), Math.cos(xi1));
    let phi = chi;
    for (let i = 0; i < 15; i++) {
      const s = e * Math.sin(phi);
      const next = 2 * Math.atan(Math.tan(Math.PI / 4 + chi / 2) * Math.pow((1 + s) / (1 - s), e / 2)) - Math.PI / 2;
      if (Math.abs(next - phi) < 1e-14) { phi = next; break; }
      phi = next;
    }
    return [lon0 + lam / D2R, phi / D2R];
  }
  return { forward, inverse, e2 };
}

const AIRY_F = 1 - AIRY.b / AIRY.a;
const TM = krueger(AIRY.a, AIRY_F);
// the meridian distance (scaled) from the equator to the true origin
const Y_LAT0 = TM.forward(NATGRID.lon0, NATGRID.lat0, NATGRID.lon0, NATGRID.k0)[1];

// OSGB36 lon, lat (degrees) to National Grid easting, northing (metres).
export function toGrid(lon, lat) {
  const [x, y] = TM.forward(lon, lat, NATGRID.lon0, NATGRID.k0);
  return [x + NATGRID.x0, y - Y_LAT0 + NATGRID.y0];
}
export function fromGrid(e, n) {
  return TM.inverse(e - NATGRID.x0, n - NATGRID.y0 + Y_LAT0, NATGRID.lon0, NATGRID.k0);
}

// Point scale and grid convergence (degrees, angle from grid north to true
// north, clockwise) at an OSGB36 lon, lat, by differencing along the meridian.
export function scaleAndConvergence(lon, lat) {
  const d = 1e-6, [x1, y1] = toGrid(lon, lat - d), [x2, y2] = toGrid(lon, lat + d);
  const s = Math.sin(lat * D2R), w = Math.sqrt(1 - TM.e2 * s * s), rho = (AIRY.a * (1 - TM.e2)) / (w * w * w);
  return { k: Math.hypot(x2 - x1, y2 - y1) / (rho * 2 * d * D2R), conv: Math.atan2(x2 - x1, y2 - y1) / D2R };
}

// Grid easting either side of the central meridian where the scale is true
// (k = 1) at latitude lat.
export function trueScaleOffset(lat) {
  let lo = 0, hi = 6;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (scaleAndConvergence(NATGRID.lon0 + mid, lat).k < 1) lo = mid; else hi = mid;
  }
  return toGrid(NATGRID.lon0 + lo, lat)[0] - NATGRID.x0;
}

// ---------------------------------------------------------------- datum

// WGS84 / ETRS89 to OSGB36, Helmert (position vector convention): metres,
// arcseconds, ppm. Ordnance Survey's published parameters.
export const HELMERT = { tx: -446.448, ty: 125.157, tz: -542.06, rx: -0.1502, ry: -0.247, rz: -0.8421, s: 20.4894 };

function toCart(lon, lat, h, a, e2) {
  const p = lat * D2R, l = lon * D2R, nu = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  return [(nu + h) * Math.cos(p) * Math.cos(l), (nu + h) * Math.cos(p) * Math.sin(l), (nu * (1 - e2) + h) * Math.sin(p)];
}
function fromCart(X, Y, Z, a, e2) {
  const r = Math.hypot(X, Y);
  let p = Math.atan2(Z, r * (1 - e2)), h = 0;
  for (let i = 0; i < 10; i++) {
    const nu = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
    h = r / Math.cos(p) - nu;
    p = Math.atan2(Z, r * (1 - (e2 * nu) / (nu + h)));
  }
  return [Math.atan2(Y, X) / D2R, p / D2R, h];
}
const E2_WGS = WGS84.f * (2 - WGS84.f), E2_AIRY = AIRY_F * (2 - AIRY_F);
function pv(c, [X, Y, Z], sign) {
  const as = D2R / 3600, m = 1 + sign * c.s * 1e-6, rx = sign * c.rx * as, ry = sign * c.ry * as, rz = sign * c.rz * as;
  return [sign * c.tx + m * (X - rz * Y + ry * Z), sign * c.ty + m * (rz * X + Y - rx * Z), sign * c.tz + m * (-ry * X + rx * Y + Z)];
}

// WGS84 lon, lat (height 0) to OSGB36 lon, lat.
export function fromWGS84(lon, lat) {
  const [l, p] = fromCart(...pv(HELMERT, toCart(lon, lat, 0, WGS84.a, E2_WGS), 1), AIRY.a, E2_AIRY);
  return [l, p];
}
// OSGB36 lon, lat to WGS84, by iterating the forward shift (so the two
// undo each other to well under a millimetre).
export function toWGS84(lon, lat) {
  let g = [lon, lat];
  for (let i = 0; i < 6; i++) {
    const f = fromWGS84(g[0], g[1]);
    g = [g[0] + (lon - f[0]), g[1] + (lat - f[1])];
  }
  return g;
}

// ---------------------------------------------------------------- letters and references

const LETTERS = "ABCDEFGHJKLMNOPQRSTUVWXYZ"; // 25 letters, no I

// The two letters of the 100 km square holding easting e, northing n:
// the first names a 500 km square (S, T, N, O, H, J cover Great Britain)
// on a 5 x 5 lettering that starts at V (south-west), the second the
// 100 km square inside it on the same 5 x 5 pattern from A (north-west).
export function squareLetters(e, n) {
  const e100 = Math.floor(e / 1e5), n100 = Math.floor(n / 1e5);
  if (e100 < 0 || e100 > 6 || n100 < 0 || n100 > 12) return null;
  const e500 = Math.floor(e100 / 5) + 2, n500 = Math.floor(n100 / 5) + 1;
  const l1 = (4 - n500) * 5 + e500, l2 = (4 - (n100 % 5)) * 5 + (e100 % 5);
  return LETTERS[l1] + LETTERS[l2];
}
// The south-west corner of a 100 km square from its letters.
export function squareOrigin(letters) {
  const [i1, i2] = [...String(letters).toUpperCase()].map((c) => LETTERS.indexOf(c));
  if (i1 < 0 || i2 < 0) return null;
  const e100 = ((i1 % 5) - 2) * 5 + (i2 % 5), n100 = (4 - Math.floor(i1 / 5) - 1) * 5 + (4 - Math.floor(i2 / 5));
  return [e100 * 1e5, n100 * 1e5];
}

// A grid reference of `figures` digits in all (2 to 10): letters, then
// easting and northing inside the 100 km square, each truncated to the
// cell the point falls in.
export function gridRef(e, n, figures = 6) {
  const sq = squareLetters(e, n);
  if (!sq) return null;
  const d = figures / 2, part = (v) => String(Math.floor(v % 1e5)).padStart(5, "0").slice(0, d);
  return { square: sq, e: part(e), n: part(n), text: `${sq} ${part(e)} ${part(n)}` };
}

// Everything the explainer says about a WGS84 point on the National Grid.
export function describe(lon, lat) {
  const [lo, la] = fromWGS84(lon, lat), [e, n] = toGrid(lo, la);
  const sq = squareLetters(e, n);
  if (!sq) return null;
  const { k, conv } = scaleAndConvergence(lo, la);
  return {
    lon, lat, lon36: lo, lat36: la, e, n, square: sq, k, conv,
    four: gridRef(e, n, 4), six: gridRef(e, n, 6), eight: gridRef(e, n, 8), ten: gridRef(e, n, 10),
    fromCM: e - NATGRID.x0, trueScale: trueScaleOffset(la)
  };
}

// Great Britain, loosely: where the National Grid is in use.
export const inGB = (lon, lat) => lon > -8.8 && lon < 2.1 && lat > 49.8 && lat < 61;

// ---------------------------------------------------------------- a made-up county atlas

// A street atlas of London made up for the explainer, in the way many
// British atlases are made: pages cut from the National Grid, here 3 km
// wide and 4 km tall on whole kilometre lines, numbered across and then
// down from the north-west corner of the area, each holding 6 x 8 squares
// of 500 m lettered A-F across and numbered 1-8 down, with the kilometre
// grid printed over the page and its numbers in the margin.
export const COUNTY = { west: 500000, north: 205000, east: 563000, south: 153000, pageW: 3000, pageH: 4000, square: 500 };
COUNTY.across = (COUNTY.east - COUNTY.west) / COUNTY.pageW;
COUNTY.down = (COUNTY.north - COUNTY.south) / COUNTY.pageH;

// The page (and square on it) holding easting e, northing n, or null.
export function countyPage(e, n) {
  const A = COUNTY;
  if (e < A.west || e >= A.east || n <= A.south || n > A.north) return null;
  const col = Math.floor((e - A.west) / A.pageW), row = Math.floor((A.north - n) / A.pageH);
  const west = A.west + col * A.pageW, north = A.north - row * A.pageH;
  const across = Math.floor((e - west) / A.square), down = Math.floor((north - n) / A.square);
  return {
    page: 1 + row * A.across + col, col, row, letter: "ABCDEF"[across], number: down + 1,
    west, north, east: west + A.pageW, south: north - A.pageH,
    squareWest: west + across * A.square, squareNorth: north - down * A.square
  };
}
// The frame of page number p.
export function countyFrame(p) {
  const A = COUNTY, col = (p - 1) % A.across, row = Math.floor((p - 1) / A.across);
  if (p < 1 || row >= A.down) return null;
  const west = A.west + col * A.pageW, north = A.north - row * A.pageH;
  return { page: p, col, row, west, north, east: west + A.pageW, south: north - A.pageH };
}
