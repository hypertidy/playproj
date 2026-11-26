// The Navigation page's station scene: from space down to an Antarctic
// station on REMA (rema.js), the earth at its own size, in metres.
//
// The scene is drawn in the station's own frame, east, north and up from
// the ellipsoid under it (enuFrame), so the turntable's upright is the
// station's plumb line and the horizon stays level there. REMA is drawn
// as patches, one a level: the whole continent coarse, then windows round
// the station each finer than the last (LADDER). Each patch has a hole
// where the next one sits (holeIn, gridIndex), on its own vertex lines, and
// the finer patch's rim is pinned onto the edges of that hole (pinEdges),
// so the two meet without a crack or an overlap though their cells differ.
// A double-click finds the ground through tiles of each patch (tileBoxes,
// rayHit); the camera's height over the ground is read off the patches
// (sampleGrid); and the near and far planes follow the camera (nearFar).
// No three.js here.

import { geocentric, WGS84 } from "./geoid.js";
import { polarStere } from "./polarstere.js";

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const PS = polarStere("EPSG:3031");

// Stations, at about where their main buildings are (to a few hundred
// metres): who runs them, and where.
export const STATIONS = {
  davis: { name: "Davis", who: "Australia", lon: 77.9675, lat: -68.5765 },
  mawson: { name: "Mawson", who: "Australia", lon: 62.8737, lat: -67.6028 },
  casey: { name: "Casey", who: "Australia", lon: 110.5269, lat: -66.2823 },
  mcmurdo: { name: "McMurdo", who: "the United States", lon: 166.6683, lat: -77.8464 },
  rothera: { name: "Rothera", who: "the United Kingdom", lon: -68.1258, lat: -67.5681 },
  concordia: { name: "Concordia", who: "France and Italy", lon: 123.3326, lat: -75.0997 },
  pole: { name: "Amundsen–Scott South Pole", who: "the United States", lon: 0, lat: -90 }
};

// The levels, by their cells' size in metres, coarse to fine: the first
// the whole continent, the others ACROSS cells round the station.
export const LADDER = [8000, 500, 100, 32, 10, 2];
export const ACROSS = 512;

// ---------------------------------------------------------------- frames

// East, north and up at lon, lat, from the ellipsoid there (h = 0). At the
// South Pole east is towards 90 E and north towards 0 E, as grid east and
// north are on EPSG:3031.
export function enuFrame(lon, lat) {
  const l = lon * D2R, p = lat * D2R, sl = Math.sin(l), cl = Math.cos(l), sp = Math.sin(p), cp = Math.cos(p);
  return { lon, lat, o: geocentric(lon, lat, 0), e: [-sl, cl, 0], n: [-sp * cl, -sp * sl, cp], u: [cp * cl, cp * sl, sp] };
}
export function toEnu(f, X, Y, Z, out = [0, 0, 0]) {
  const x = X - f.o[0], y = Y - f.o[1], z = Z - f.o[2], { e, n, u } = f;
  out[0] = e[0] * x + e[1] * y + e[2] * z;
  out[1] = n[0] * x + n[1] * y + n[2] * z;
  out[2] = u[0] * x + u[1] * y + u[2] * z;
  return out;
}
export function fromEnu(f, x, y, z, out = [0, 0, 0]) {
  const { e, n, u, o } = f;
  for (let k = 0; k < 3; k++) out[k] = o[k] + x * e[k] + y * n[k] + z * u[k];
  return out;
}
// lon, lat and height over the ellipsoid of a geocentric X, Y, Z (to well
// under a millimetre, the poles included)
export function geodetic(X, Y, Z, { a = WGS84.a, f = WGS84.f } = {}) {
  const e2 = f * (2 - f), p = Math.hypot(X, Y);
  let phi = Math.atan2(Z, p * (1 - e2));
  for (let k = 0; k < 6; k++) {
    const s = Math.sin(phi);
    phi = Math.atan2(Z + (e2 * a * s) / Math.sqrt(1 - e2 * s * s), p);
  }
  const s = Math.sin(phi), c = Math.cos(phi);
  return [p < 1e-9 ? 0 : Math.atan2(Y, X) * R2D, phi * R2D, p * c + Z * s - a * Math.sqrt(1 - e2 * s * s)];
}
// a point in the frame as lon, lat, height
export function enuGeodetic(f, x, y, z) {
  const g = fromEnu(f, x, y, z);
  return geodetic(g[0], g[1], g[2]);
}

// ---------------------------------------------------------------- patches

// A window's vertices, one at the middle of each cell, along x and down y
// (EPSG:3031 metres): { xs, ys, w, h }.
export function patchAxes(g, win) {
  const xs = new Float64Array(win.w), ys = new Float64Array(win.h);
  for (let i = 0; i < win.w; i++) xs[i] = g.x0 + (win.c0 + i + 0.5) * g.dx;
  for (let j = 0; j < win.h; j++) ys[j] = g.y0 - (win.r0 + j + 0.5) * g.dy;
  return { xs, ys, w: win.w, h: win.h };
}

// Heights where REMA has none (the open sea, beyond its edges, and the
// hole round the South Pole its satellites never saw), from fillAt(x, y,
// lon, lat): { h, sea }, sea level where sea is true. Which were filled:
// 1 the sea, 2 land.
export function fillHeights(z, ax, nodata, fillAt) {
  const filled = new Uint8Array(z.length);
  for (let j = 0, k = 0; j < ax.h; j++)
    for (let i = 0; i < ax.w; i++, k++) {
      const v = z[k];
      if (v === nodata || v !== v || v < -1000) {
        const [lon, lat] = PS.inverse(ax.xs[i], ax.ys[j]), f = fillAt(ax.xs[i], ax.ys[j], lon, lat);
        z[k] = f.h;
        filled[k] = f.sea ? 1 : 2;
      }
    }
  return filled;
}

// Each vertex in the frame (Float64Array, x, y, z a vertex), from its
// EPSG:3031 place and its height over the ellipsoid.
export function enuPositions(ax, z, frame) {
  const out = new Float64Array(3 * ax.w * ax.h), g = [0, 0, 0], q = [0, 0, 0];
  for (let j = 0, k = 0; j < ax.h; j++)
    for (let i = 0; i < ax.w; i++, k++) {
      const [lon, lat] = PS.inverse(ax.xs[i], ax.ys[j]);
      geocentric(lon, lat, z[k], undefined, g);
      toEnu(frame, g[0], g[1], g[2], q);
      out[3 * k] = q[0]; out[3 * k + 1] = q[1]; out[3 * k + 2] = q[2];
    }
  return out;
}

// The hole a finer patch makes in a coarser one: the coarser one's vertex
// lines that lie inside the finer one's vertices, as columns i0..i1 and
// rows j0..j1 (rows run down y, as the axes do); null if they hold no cell.
export function holeIn(parent, child, tol = 1e-6) {
  const cx0 = child.xs[0] - tol, cx1 = child.xs[child.w - 1] + tol, cyTop = child.ys[0] + tol, cyBot = child.ys[child.h - 1] - tol;
  let i0 = -1, i1 = -1, j0 = -1, j1 = -1;
  for (let i = 0; i < parent.w; i++) if (parent.xs[i] >= cx0 && parent.xs[i] <= cx1) { if (i0 < 0) i0 = i; i1 = i; }
  for (let j = 0; j < parent.h; j++) if (parent.ys[j] <= cyTop && parent.ys[j] >= cyBot) { if (j0 < 0) j0 = j; j1 = j; }
  if (i0 < 0 || j0 < 0 || i1 - i0 < 1 || j1 - j0 < 1) return null;
  return { i0, i1, j0, j1 };
}
// whether the cell (quad) from vertex i, j to i + 1, j + 1 is in the hole
export const inHole = (hole, i, j) => !!hole && i >= hole.i0 && i < hole.i1 && j >= hole.j0 && j < hole.j1;

// Two triangles a cell, but none in the hole, wound anticlockwise seen
// from above (up out of the ground).
export function gridIndex(w, h, hole = null) {
  const out = [];
  for (let j = 0; j < h - 1; j++)
    for (let i = 0; i < w - 1; i++) {
      if (inHole(hole, i, j)) continue;
      const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
      out.push(a, c, b, b, c, d);
    }
  return Uint32Array.from(out);
}

// The finer patch's vertices on or outside the hole's rim, moved onto it:
// each onto the coarser patch's edge there, along the straight line between
// the two vertices of that edge, so the rim follows the coarser surface
// exactly and the two meet without a crack. child and parent are axes with
// positions (enu); the child's are changed in place.
export function pinEdges(child, parent, hole) {
  const { i0, i1, j0, j1 } = hole, X0 = parent.xs[i0], X1 = parent.xs[i1], YT = parent.ys[j0], YB = parent.ys[j1];
  const P = parent.enu, C = child.enu, pw = parent.w;
  const pdx = parent.xs[1] - parent.xs[0], pdy = parent.ys[0] - parent.ys[1];
  const lerp = (ka, kb, t, k) => { for (let c = 0; c < 3; c++) C[3 * k + c] = P[3 * ka + c] * (1 - t) + P[3 * kb + c] * t; };
  for (let j = 0; j < child.h; j++) {
    const y = Math.min(YT, Math.max(YB, child.ys[j])), onH = y === YT || y === YB;
    for (let i = 0; i < child.w; i++) {
      const x = Math.min(X1, Math.max(X0, child.xs[i])), onV = x === X0 || x === X1;
      if (!onV && !onH) continue;
      const k = j * child.w + i;
      if (onV) {
        const col = x === X0 ? i0 : i1, jj = Math.min(j1 - 1, Math.max(j0, Math.floor((parent.ys[0] - y) / pdy)));
        lerp(jj * pw + col, (jj + 1) * pw + col, (parent.ys[jj] - y) / (parent.ys[jj] - parent.ys[jj + 1]), k);
      } else {
        const row = y === YT ? j0 : j1, ii = Math.min(i1 - 1, Math.max(i0, Math.floor((x - parent.xs[0]) / pdx)));
        lerp(row * pw + ii, row * pw + ii + 1, (x - parent.xs[ii]) / (parent.xs[ii + 1] - parent.xs[ii]), k);
      }
    }
  }
}

// ---------------------------------------------------------------- colours

const RGB = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
export const SEA = RGB(0x1c4a78);
const ROCK = RGB(0x6e6157), ICE_LO = RGB(0xc6d6e8), ICE_HI = RGB(0xfbfdff);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// A colour a vertex: the sea (where REMA had nothing, or the ground lies
// flat within a metre or two of sea level, as the globe's); rock where the
// ground is steep (snow does not lie on it) or where noIce says there is
// no ice (0 to 1 a vertex, or null); and otherwise snow and ice, bluer low
// down. sea is sea level at each vertex (or one number for all); slopes
// come from the heights' differences over cells dx by dy metres.
export function tints(z, filled, ax, dx, dy, sea, noIce = null) {
  const { w, h } = ax, out = new Float32Array(3 * w * h);
  for (let j = 0, k = 0; j < h; j++)
    for (let i = 0; i < w; i++, k++) {
      const s = typeof sea === "number" ? sea : sea[k], above = z[k] - s;
      const zx = (z[j * w + Math.min(w - 1, i + 1)] - z[j * w + Math.max(0, i - 1)]) / (dx * (Math.min(w - 1, i + 1) - Math.max(0, i - 1)) || 1);
      const zy = (z[Math.min(h - 1, j + 1) * w + i] - z[Math.max(0, j - 1) * w + i]) / (dy * (Math.min(h - 1, j + 1) - Math.max(0, j - 1)) || 1);
      const slope = Math.atan(Math.hypot(zx, zy)) * R2D;
      let c;
      if (filled[k] === 1 || (Math.abs(above) < 2 && slope < 1.5)) c = SEA;
      else {
        const t = Math.min(1, Math.max(0, above / 3000)), r = Math.max(smooth(22, 38, slope), noIce ? noIce[k] : 0);
        c = [0, 1, 2].map((q) => (ICE_LO[q] * (1 - t) + ICE_HI[q] * t) * (1 - r) + ROCK[q] * r);
      }
      out[3 * k] = c[0]; out[3 * k + 1] = c[1]; out[3 * k + 2] = c[2];
    }
  return out;
}

// ---------------------------------------------------------------- reading it

// The height at x, y (EPSG:3031) from a patch's axes and heights, on the
// triangles gridIndex makes of its cells (so a point a ray found on the
// patch is on the ground here too), or null outside them.
export function sampleGrid(ax, z, x, y) {
  const { xs, ys, w, h } = ax;
  if (w < 2 || h < 2) return null;
  const fx = (x - xs[0]) / (xs[1] - xs[0]), fy = (ys[0] - y) / (ys[0] - ys[1]);
  if (fx < 0 || fy < 0 || fx > w - 1 || fy > h - 1) return null;
  const i = Math.min(w - 2, Math.floor(fx)), j = Math.min(h - 2, Math.floor(fy)), u = fx - i, v = fy - j, k = j * w + i;
  // a cell's two triangles meet on the diagonal from i + 1, j to i, j + 1
  const a = z[k], b = z[k + 1], c = z[k + w], d = z[k + w + 1];
  return u + v <= 1 ? a + u * (b - a) + v * (c - a) : d + (1 - u) * (c - d) + (1 - v) * (b - d);
}

// The value at x, y (EPSG:3031) from a grid's axes and values: bilinear
// where the four round it all have one, else the nearest of them that has,
// else null (and null outside).
export function sampleValid(ax, z, x, y, nodata) {
  const { xs, ys, w, h } = ax;
  const fx = (x - xs[0]) / (xs[1] - xs[0]), fy = (ys[0] - y) / (ys[0] - ys[1]);
  if (!(fx >= -0.5 && fy >= -0.5 && fx <= w - 0.5 && fy <= h - 0.5)) return null;
  const i = Math.max(0, Math.min(w - 2, Math.floor(fx))), j = Math.max(0, Math.min(h - 2, Math.floor(fy)));
  const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fy - j)), k = j * w + i;
  const q = [z[k], z[k + 1], z[k + w], z[k + w + 1]], ok = q.map((a) => a !== nodata && a === a);
  if (ok.every(Boolean)) return (q[0] * (1 - u) + q[1] * u) * (1 - v) + (q[2] * (1 - u) + q[3] * u) * v;
  let best = null, bd = Infinity;
  for (const [n, a, b] of [[0, u, v], [1, 1 - u, v], [2, u, 1 - v], [3, 1 - u, 1 - v]]) {
    const d = a * a + b * b;
    if (ok[n] && d < bd) { bd = d; best = q[n]; }
  }
  return best;
}

// Boxes round tiles of T x T cells of a patch, for finding where a ray
// meets it without trying every triangle: { T, nx, ny, box } with six
// numbers a tile (min x, y, z, max x, y, z).
export function tileBoxes(enu, w, h, T = 32) {
  const nx = Math.ceil((w - 1) / T), ny = Math.ceil((h - 1) / T), box = new Float64Array(6 * nx * ny);
  for (let ty = 0; ty < ny; ty++)
    for (let tx = 0; tx < nx; tx++) {
      const b = 6 * (ty * nx + tx);
      box.fill(Infinity, b, b + 3); box.fill(-Infinity, b + 3, b + 6);
      for (let j = ty * T; j <= Math.min(h - 1, (ty + 1) * T); j++)
        for (let i = tx * T; i <= Math.min(w - 1, (tx + 1) * T); i++) {
          const k = 3 * (j * w + i);
          for (let c = 0; c < 3; c++) {
            if (enu[k + c] < box[b + c]) box[b + c] = enu[k + c];
            if (enu[k + c] > box[b + 3 + c]) box[b + 3 + c] = enu[k + c];
          }
        }
    }
  return { T, nx, ny, box };
}

// where a ray (o + t d) first enters a box, or Infinity
function boxEnter(b, k, o, d, best) {
  let t0 = 0, t1 = best;
  for (let c = 0; c < 3; c++) {
    const lo = b[k + c], hi = b[k + 3 + c];
    if (Math.abs(d[c]) < 1e-300) { if (o[c] < lo || o[c] > hi) return Infinity; continue; }
    let a = (lo - o[c]) / d[c], z = (hi - o[c]) / d[c];
    if (a > z) [a, z] = [z, a];
    if (a > t0) t0 = a;
    if (z < t1) t1 = z;
    if (t0 > t1) return Infinity;
  }
  return t0;
}
// a ray and a triangle, from either side (Moller-Trumbore): t, or Infinity
function triHit(P, ia, ib, ic, o, d) {
  const ax = P[3 * ia], ay = P[3 * ia + 1], az = P[3 * ia + 2];
  const e1x = P[3 * ib] - ax, e1y = P[3 * ib + 1] - ay, e1z = P[3 * ib + 2] - az;
  const e2x = P[3 * ic] - ax, e2y = P[3 * ic + 1] - ay, e2z = P[3 * ic + 2] - az;
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-300) return Infinity;
  const inv = 1 / det, sx = o[0] - ax, sy = o[1] - ay, sz = o[2] - az;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return Infinity;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 0 ? t : Infinity;
}
// Where a ray from o along d (unit, in the frame) first meets a patch
// ({ enu, w, h, tiles, hole }): { t, i, j }, or null. Cells in the hole
// are not there.
export function rayHit(p, o, d) {
  const { enu, w, h, hole } = p, { T, nx, ny, box } = p.tiles, order = [];
  for (let k = 0; k < nx * ny; k++) {
    const t = boxEnter(box, 6 * k, o, d, Infinity);
    if (t < Infinity) order.push([t, k]);
  }
  order.sort((a, b) => a[0] - b[0]);
  let best = Infinity, at = null;
  for (const [t0, k] of order) {
    if (t0 > best) break;
    const tx = k % nx, ty = (k - tx) / nx;
    for (let j = ty * T; j < Math.min(h - 1, (ty + 1) * T); j++)
      for (let i = tx * T; i < Math.min(w - 1, (tx + 1) * T); i++) {
        if (inHole(hole, i, j)) continue;
        const a = j * w + i, b = a + 1, c = a + w, dd = c + 1;
        const t = Math.min(triHit(enu, a, c, b, o, d), triHit(enu, b, c, dd, o, d));
        if (t < best) { best = t; at = { t, i, j }; }
      }
  }
  return at;
}

// ---------------------------------------------------------------- the camera

// Near and far planes for a camera range metres from the earth's centre
// and clearance metres over the ground under it: near a quarter of the
// clearance (not under half a metre), far to the horizon and on to the
// highest ground (hmax) that could stand up beyond it. A depth buffer
// splits the depths between near and far unevenly, finest near the camera
// and coarsest far off, so the closer far is to near the better.
export function nearFar(range, clearance, { R = 6356752, hmax = 5000 } = {}) {
  const near = Math.max(0.5, 0.25 * clearance);
  const far = Math.sqrt(Math.max(0, range * range - R * R)) + Math.sqrt(2 * R * hmax + hmax * hmax);
  return [near, Math.max(far, 2 * near)];
}

// Where a ray from o along d (in the frame) meets the ellipsoid raised by
// h metres (h added to both its semi-axes: within a millimetre of h over it
// for heights of a few kilometres): the distance along it (d a unit
// vector), or null. From inside, where it comes out.
export function rayEllipsoid(f, o, d, h = 0, { a = WGS84.a, f: fl = WGS84.f } = {}) {
  const O = fromEnu(f, o[0], o[1], o[2]), D = [0, 1, 2].map((k) => d[0] * f.e[k] + d[1] * f.n[k] + d[2] * f.u[k]);
  const A = a + h, k = A / (a * (1 - fl) + h);
  const ox = O[0], oy = O[1], oz = O[2] * k, dx = D[0], dy = D[1], dz = D[2] * k;
  const qa = dx * dx + dy * dy + dz * dz, qb = 2 * (ox * dx + oy * dy + oz * dz), qc = ox * ox + oy * oy + oz * oz - A * A;
  const disc = qb * qb - 4 * qa * qc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc), t0 = (-qb - s) / (2 * qa), t1 = (-qb + s) / (2 * qa);
  return t0 > 0 ? t0 : t1 > 0 ? t1 : null;
}
