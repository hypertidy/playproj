// Spilhaus: the world's oceans in a square, as PROJ's +proj=spilhaus on a
// sphere. A port of PROJ's spilhaus.cpp and the Adams World in a Square II
// part of adams.cpp (Evenden, Evers, Wilkinson, Jimenez Shaw; MIT licence).
//
// There is no physical construction. The sphere is first rotated so the
// Spilhaus centre, in the Southern Ocean, sits on the oblique pole line
// Adams used, then Adams' conformal map takes the whole sphere to a square
// through elliptic integrals. The square's four corners are the only points
// where angles are not kept.

import { esriGeoKeys } from "../geotiff-write.js";

export const R = 6370997;
const D2R = Math.PI / 180;
const HALFPI = Math.PI / 2;
const RSQRT2 = 0.7071067811865475244008443620;

// PROJ defaults, from https://github.com/OSGeo/PROJ/issues/1851
export const defaults = { lon0: 66.94970198, lat0: -49.56371678, azi: 40.17823482, rot: 45 };

const aasin = (v) => (Math.abs(v) >= 1 ? (v < 0 ? -HALFPI : HALFPI) : Math.asin(v));
const aacos = (v) => (Math.abs(v) >= 1 ? (v < 0 ? Math.PI : 0) : Math.acos(v));
const adjlon = (l) => {
  if (Math.abs(l) <= Math.PI) return l;
  l = (l + Math.PI) % (2 * Math.PI);
  if (l < 0) l += 2 * Math.PI;
  return l - Math.PI;
};

// Elliptic integral of the first kind with k^2 = 0.5, as a Chebyshev series.
const C0 = 2.19174570831038;
const C = [-8.58691003636495e-07, 2.02692115653689e-07, 3.12960480765314e-05,
  5.30394739921063e-05, -0.0012804644680613, -0.00575574836830288, 0.0914203033408211];
function ellInt5(phi) {
  let y = phi * (2 / Math.PI);
  y = 2 * y * y - 1;
  const y2 = 2 * y;
  let d1 = 0, d2 = 0;
  for (const c of C) {
    const t = d1;
    d1 = y2 * d1 - d2 + c;
    d2 = t;
  }
  return phi * (y * d1 - d2 + 0.5 * C0);
}

// Adams World in a Square II, radians in, unit-sphere square out.
export function adamsWs2(lam, phi) {
  const spp = Math.tan(0.5 * phi);
  let a = Math.cos(aasin(spp)) * Math.sin(0.5 * lam);
  const sm = spp + a < 0, sn = spp - a < 0;
  const b = aacos(spp);
  a = aacos(a);
  let m = aasin(Math.sqrt(1 + Math.min(0, Math.cos(a + b))));
  if (sm) m = -m;
  let n = aasin(Math.sqrt(Math.abs(1 - Math.max(0, Math.cos(a - b)))));
  if (sn) n = -n;
  const x = ellInt5(m), y = ellInt5(n);
  return [RSQRT2 * (x - y), RSQRT2 * (x + y)];
}

// Newton iteration on the forward map, as PROJ's pj_generic_inverse_2d.
// A guess [lam, phi] from a neighbouring solution helps near the corners.
function adamsWs2Inverse(x, y, guess) {
  let phi = Math.max(Math.min(y / 2.62181347, 1), -1) * HALFPI;
  let lam = Math.abs(phi) >= HALFPI ? 0 : Math.max(Math.min(x / 2.6220576 / Math.cos(phi), 1), -1) * Math.PI;
  if (guess) [lam, phi] = guess;
  let jlx = 0, jly = 0, jpx = 0, jpy = 0;
  for (let i = 0; i < 15; i++) {
    const f = adamsWs2(lam, phi);
    const dx = f[0] - x, dy = f[1] - y;
    if (Math.abs(dx) < 1e-10 && Math.abs(dy) < 1e-10) return [lam, phi];
    if (i === 0 || Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
      const dl = lam > 0 ? -1e-6 : 1e-6, dp = phi > 0 ? -1e-6 : 1e-6;
      const fl = adamsWs2(lam + dl, phi), fp = adamsWs2(lam, phi + dp);
      const xl = (fl[0] - f[0]) / dl, yl = (fl[1] - f[1]) / dl;
      const xp = (fp[0] - f[0]) / dp, yp = (fp[1] - f[1]) / dp;
      const det = xl * yp - xp * yl;
      if (det !== 0) { jlx = yp / det; jly = -xp / det; jpx = -yl / det; jpy = xl / det; }
    }
    lam -= Math.max(Math.min(dx * jlx + dy * jly, 0.3), -0.3);
    lam = Math.max(-Math.PI, Math.min(Math.PI, lam));
    phi -= Math.max(Math.min(dx * jpx + dy * jpy, 0.3), -0.3);
    phi = Math.max(-HALFPI, Math.min(HALFPI, phi));
  }
  return null;
}

function setup(p) {
  const azi = (p.azi ?? defaults.azi) * D2R, rot = (p.rot ?? defaults.rot) * D2R;
  const phi0 = (p.lat0 ?? defaults.lat0) * D2R;
  const sinalpha = -Math.cos(phi0) * Math.cos(azi);
  return {
    lam0: (p.lon0 ?? defaults.lon0) * D2R,
    sinalpha, cosalpha: Math.sqrt(1 - sinalpha * sinalpha),
    lambda0: Math.atan2(Math.tan(azi), -Math.sin(phi0)),
    beta: Math.PI + Math.atan2(-Math.sin(azi), -Math.tan(phi0)),
    cosrot: Math.cos(rot), sinrot: Math.sin(rot)
  };
}

// lon/lat degrees -> square x/y in sphere radii (about +-2.62 at the corners).
export function project(lon, lat, p = {}) {
  const Q = setup(p);
  const phi = lat * D2R, lam = adjlon(lon * D2R - Q.lam0);
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const cl = Math.cos(lam - Q.lambda0), sl = Math.sin(lam - Q.lambda0);
  const pa = aasin(Q.sinalpha * sp - Q.cosalpha * cp * cl);
  let la = Q.beta + Math.atan2(cp * sl, Q.sinalpha * cp * cl + Q.cosalpha * sp);
  while (la > Math.PI) la -= 2 * Math.PI;
  while (la < -Math.PI) la += 2 * Math.PI;
  const [xa, ya] = adamsWs2(la, pa);
  return [-(xa * Q.cosrot + ya * Q.sinrot), -(-xa * Q.sinrot + ya * Q.cosrot)];
}

export function inverse(x, y, p = {}) {
  const r = inverseAdams(x, y, setup(p));
  return r && r.ll;
}

function inverseAdams(x, y, Q, guess) {
  const xa = -(x * Q.cosrot - y * Q.sinrot), ya = -(x * Q.sinrot + y * Q.cosrot);
  const adams = adamsWs2Inverse(xa, ya, guess);
  if (!adams) return null;
  const [la, pa] = adams;
  const cp = Math.cos(pa), sp = Math.sin(pa);
  const cl = Math.cos(la - Q.beta), sl = Math.sin(la - Q.beta);
  const phi = aasin(Q.sinalpha * sp + Q.cosalpha * cp * cl);
  const lam = Q.lambda0 + Math.atan2(cp * sl, Q.sinalpha * cp * cl - Q.cosalpha * sp);
  return { ll: [adjlon(lam + Q.lam0) / D2R, phi / D2R], adams };
}

// The square's half side in sphere radii: K(1/2), the complete elliptic
// integral of the first kind.
export const HALF = 1.8540746773013719;

// The inverse is a Newton iteration, too slow to run for every pixel. This
// solves it exactly on an (n + 1)^2 grid over the square, each node seeded
// from its neighbour, and returns
//   grid: unit vectors (x, y, z) per node, NaN where unsolved
//   lonlat: lon, lat per node
//   inverse(x, y): lon/lat by bilinear interpolation of the unit vectors,
//     which is seamless across the antimeridian.
export function inverseGrid(p = {}, n = 256) {
  const Q = setup(p), m = n + 1, step = (2 * HALF) / n, edge = HALF * (1 - 1e-5);
  const grid = new Float64Array(m * m * 3).fill(NaN), lonlat = new Float64Array(m * m * 2).fill(NaN);
  const adamsAt = new Array(m * m);
  for (let j = 0; j < m; j++)
    for (let i = 0; i < m; i++) {
      const k = j * m + i;
      const x = Math.max(-edge, Math.min(edge, -HALF + i * step)), y = Math.max(-edge, Math.min(edge, HALF - j * step));
      let r = inverseAdams(x, y, Q);
      for (const nb of [i > 0 ? k - 1 : -1, j > 0 ? k - m : -1, j > 0 && i < n ? k - m + 1 : -1]) {
        if (r || nb < 0 || !adamsAt[nb]) continue;
        r = inverseAdams(x, y, Q, adamsAt[nb]);
      }
      if (!r) continue;
      adamsAt[k] = r.adams;
      const [lon, lat] = r.ll;
      lonlat[2 * k] = lon; lonlat[2 * k + 1] = lat;
      const cp = Math.cos(lat * D2R);
      grid[3 * k] = cp * Math.cos(lon * D2R); grid[3 * k + 1] = cp * Math.sin(lon * D2R); grid[3 * k + 2] = Math.sin(lat * D2R);
    }
  // Newton stalls very close to two of the corners, where the map is not
  // conformal; fill those few nodes from their solved neighbours.
  for (let pass = 0, left = 1; pass < 20 && left; pass++) {
    left = 0;
    for (let k = 0; k < m * m; k++) {
      if (!isNaN(grid[3 * k])) continue;
      const i = k % m, j = (k - i) / m;
      let sx = 0, sy = 0, sz = 0, c = 0;
      for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const ii = i + di, jj = j + dj, kk = jj * m + ii;
        if (ii < 0 || jj < 0 || ii > n || jj > n || isNaN(grid[3 * kk])) continue;
        sx += grid[3 * kk]; sy += grid[3 * kk + 1]; sz += grid[3 * kk + 2]; c++;
      }
      if (!c) { left++; continue; }
      const r = Math.hypot(sx, sy, sz);
      grid[3 * k] = sx / r; grid[3 * k + 1] = sy / r; grid[3 * k + 2] = sz / r;
      lonlat[2 * k] = Math.atan2(sy, sx) / D2R; lonlat[2 * k + 1] = Math.asin(sz / r) / D2R;
    }
  }
  const inv = (x, y) => {
    if (Math.abs(x) > HALF || Math.abs(y) > HALF) return null;
    const u = Math.min(n - 1e-9, (x + HALF) / step), v = Math.min(n - 1e-9, (HALF - y) / step);
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    const k = j * m + i;
    let gx = 0, gy = 0, gz = 0;
    for (const [kk, w] of [[k, (1 - fu) * (1 - fv)], [k + 1, fu * (1 - fv)], [k + m, (1 - fu) * fv], [k + m + 1, fu * fv]]) {
      if (isNaN(grid[3 * kk])) return null;
      gx += w * grid[3 * kk]; gy += w * grid[3 * kk + 1]; gz += w * grid[3 * kk + 2];
    }
    return [Math.atan2(gy, gx) / D2R, Math.atan2(gz, Math.hypot(gx, gy)) / D2R];
  };
  return { n, step, grid, lonlat, inverse: inv };
}

const isDefault = (p) => ["lon0", "lat0", "azi"].every((k) => p[k] === undefined || Math.abs(p[k] - defaults[k]) < 1e-9);

export function projString(p = {}) {
  if (isDefault(p)) return `+proj=spilhaus +R=${R}`;
  return `+proj=spilhaus +lon_0=${fmt(p.lon0)} +lat_0=${fmt(p.lat0)} +azi=${fmt(p.azi)} +R=${R}`;
}

export function describe(p = {}) {
  return isDefault(p)
    ? "Spilhaus: the oceans as one body of water, conformal everywhere but the four corners of the square, which fall on land."
    : "An oblique Adams World in a Square II with your own centre and azimuth, the construction Spilhaus used.";
}

// GeoTIFF has no code for this projection and ESRI has no name for it, so
// the PROJ string travels in the PE string's PROJ4 extension, which GDAL reads.
export function geoKeys(p = {}) {
  const wkt = `PROJCS["playproj_spilhaus",GEOGCS["GCS_Sphere",DATUM["D_Sphere",SPHEROID["Sphere",${R},0.0]],` +
    `PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["custom_proj4"],UNIT["Meter",1.0],` +
    `EXTENSION["PROJ4","${projString(p)} +wktext +no_defs"]]`;
  return esriGeoKeys(wkt, R, "playproj spilhaus");
}

function fmt(x) {
  return String(+(+x).toFixed(4));
}
