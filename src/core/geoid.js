// The geoid over the ellipsoid. A geoid model is a grid of undulations N,
// the height of the geoid above the WGS84 ellipsoid, read as PROJ's
// vgridshift reads its grids (bilinear between nodes). Heights then relate
// as h = H + N: h is the ellipsoidal height a GNSS receiver gives, H the
// orthometric height above the geoid ("above sea level"). That sum ignores
// the small angle between the plumb line and the ellipsoid normal (the
// deflection of the vertical), and is how PROJ moves heights between the
// two (EPSG:4979 to EPSG:4326 + EPSG:3855 for EGM2008).
//
// playproj ships EGM2008 at whole degrees (data/geoid-egm2008-1deg.bin,
// made by test/make-geoid-fixture.py from PROJ's us_nga_egm08_25.tif):
// 361 x 181 int16 centimetres, columns from -180 to 180 (the last repeats
// the first), rows from 90 down to -90.

import { greatCirclePoints, geodesicInverse } from "./rhumb.js";

const D2R = Math.PI / 180;
export const WGS84 = { a: 6378137, f: 1 / 298.257223563 };

// A grid from its int16 centimetres (an ArrayBuffer, or anything an
// Int16Array takes); the layout above unless given.
export function fromInt16(buf, { nx = 361, ny = 181, lon0 = -180, lat0 = 90, step = 1, scale = 0.01 } = {}) {
  const raw = buf instanceof Int16Array ? buf : new Int16Array(buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf);
  if (raw.length !== nx * ny) throw new Error(`geoid grid has ${raw.length} values, not ${nx} x ${ny}`);
  const N = new Float32Array(raw.length);
  let min = Infinity, max = -Infinity, at = { min: 0, max: 0 };
  for (let k = 0; k < raw.length; k++) {
    N[k] = raw[k] * scale;
    if (N[k] < min) { min = N[k]; at.min = k; }
    if (N[k] > max) { max = N[k]; at.max = k; }
  }
  const node = (k) => [lon0 + (k % nx) * step, lat0 - Math.floor(k / nx) * step];
  return { nx, ny, lon0, lat0, step, N, min, max, minAt: node(at.min), maxAt: node(at.max) };
}

// N (metres) at lon, lat (degrees), bilinear between the four nodes round
// it, longitude wrapped onto the grid.
export function undulation(g, lon, lat) {
  const { nx, ny, lon0, lat0, step, N } = g;
  const span = (nx - 1) * step;
  let x = (lon - lon0) % 360;
  if (x < 0) x += 360;
  x = Math.min(x, span) / step;
  const y = Math.max(0, Math.min(ny - 1, (lat0 - lat) / step));
  const i = Math.min(nx - 2, Math.floor(x)), j = Math.min(ny - 2, Math.floor(y));
  const u = x - i, v = y - j, k = j * nx + i;
  return (N[k] * (1 - u) + N[k + 1] * u) * (1 - v) + (N[k + nx] * (1 - u) + N[k + nx + 1] * u) * v;
}

// Geocentric X, Y, Z (metres, or units of a) of geodetic lon, lat at
// ellipsoidal height h, on an ellipsoid { a, f } (WGS84 unless given).
export function geocentric(lon, lat, h = 0, { a = WGS84.a, f = WGS84.f } = {}, out = [0, 0, 0]) {
  const e2 = f * (2 - f), p = lat * D2R, l = lon * D2R;
  const sp = Math.sin(p), cp = Math.cos(p);
  const nu = a / Math.sqrt(1 - e2 * sp * sp);
  out[0] = (nu + h) * cp * Math.cos(l);
  out[1] = (nu + h) * cp * Math.sin(l);
  out[2] = (nu * (1 - e2) + h) * sp;
  return out;
}

// The outward ellipsoid normal at geodetic lon, lat (it does not depend on
// the ellipsoid: that is what geodetic latitude means).
export function normal(lon, lat, out = [0, 0, 0]) {
  const p = lat * D2R, l = lon * D2R;
  out[0] = Math.cos(p) * Math.cos(l); out[1] = Math.cos(p) * Math.sin(l); out[2] = Math.sin(p);
  return out;
}

// The radii of curvature on WGS84 at lat: in the meridian (M) and across
// it (nu).
export function radii(lat, { a = WGS84.a, f = WGS84.f } = {}) {
  const e2 = f * (2 - f), s = Math.sin(lat * D2R), w = 1 - e2 * s * s;
  return { M: a * (1 - e2) / Math.pow(w, 1.5), nu: a / Math.sqrt(w) };
}

// The deflection of the vertical from the slope of the geoid: the angle
// between the plumb line and the ellipsoid normal, north (xi) and east
// (eta) components in arcseconds, positive where the plumb line points
// south and west of the normal (so, where the geoid falls to the north
// and east). From a 1 degree grid it is the smoothed, long-wavelength
// part; mountains add more.
export function deflection(g, lon, lat, d = g.step / 2) {
  const { M, nu } = radii(lat);
  const la = Math.max(-89.9, Math.min(89.9, lat));
  const dn = (undulation(g, lon, la + d) - undulation(g, lon, la - d)) / (M * 2 * d * D2R);
  const de = (undulation(g, lon + d, la) - undulation(g, lon - d, la)) / (nu * Math.cos(la * D2R) * 2 * d * D2R);
  const asec = 180 / Math.PI * 3600;
  return { xi: -dn * asec, eta: -de * asec, total: Math.hypot(dn, de) * asec };
}

// N along the great circle from A to B: n + 1 points { lon, lat, s, N }
// with s the distance along it (metres, on the sphere of mean radius,
// scaled to the WGS84 geodesic length so the end is the true length).
export function profile(g, alon, alat, blon, blat, n = 400) {
  const pts = greatCirclePoints(alon, alat, blon, blat, n);
  const total = geodesicInverse(alon, alat, blon, blat).s;
  const out = [];
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [lon, lat] = pts[i];
    if (i) {
      const [l0, p0] = pts[i - 1];
      const c = Math.sin(p0 * D2R) * Math.sin(lat * D2R) + Math.cos(p0 * D2R) * Math.cos(lat * D2R) * Math.cos((lon - l0) * D2R);
      s += Math.acos(Math.max(-1, Math.min(1, c)));
    }
    out.push({ lon, lat, s, N: undulation(g, lon, lat) });
  }
  const k = s > 0 ? total / s : 0;
  for (const p of out) p.s *= k;
  return out;
}

// The PROJ pipeline that takes WGS84 ellipsoidal heights to EGM2008
// heights (H = h - N, the grid applied inverse), as PROJ builds it for
// EPSG:4979 to EPSG:4326+3855.
export const PIPELINE = "+proj=pipeline +step +proj=axisswap +order=2,1 +step +proj=unitconvert +xy_in=deg +xy_out=rad " +
  "+step +inv +proj=vgridshift +grids=us_nga_egm08_25.tif +multiplier=1 +step +proj=unitconvert +xy_in=rad +xy_out=deg +step +proj=axisswap +order=2,1";
