// A mini aatgrid: the tile lattice of the aatgrid R package
// (github.com/mdsumner/aatgrid) for UTM south zones. The whole scheme is
// three numbers: one origin shared by every zone, a fixed 720 pixels per
// tile edge, and a resolution, so a tile is 720 * res metres on a side and
// tiles at two resolutions nest whenever one divides the other.
//
// UTM itself is src/core/mgrs.js (Kruger series, tested against PROJ).

import { toUTM, fromUTM, centralMeridian } from "./mgrs.js";

export const ORIGIN = [140000, 20000];
export const PIXELS = 720;
export const RESOLUTIONS = [10, 20, 60];
// the package's older level names, still accepted in ids
export const LEVELS = { L1: 60, L2: 10 };

export const tileSize = (res) => PIXELS * res;

// The zone for a longitude: plain 6 degree zones (the Norway and Svalbard
// exceptions are northern). Zone 60 at exactly 180 E, as in aatgrid.
export function zoneOf(lon) {
  if (lon < -180 || lon > 180) lon = ((lon + 540) % 360) - 180;
  return Math.min(60, Math.floor((lon + 180) / 6) + 1);
}

export const zoneId = (zone) => String(zone).padStart(2, "0") + "S";
export const epsg = (zone) => 32700 + zone;
export const zoneEdges = (zone) => [centralMeridian(zone) - 3, centralMeridian(zone) + 3];

// lon/lat to easting, northing in a zone (any zone, not only the point's own)
export function toZone(lon, lat, zone) {
  const u = toUTM(lon, lat, zone, true);
  return [u.e, u.n];
}
export const fromZone = (zone, e, n) => fromUTM(zone, true, e, n);

export function tileIndex(e, n, res) {
  const ts = tileSize(res);
  return [Math.floor((e - ORIGIN[0]) / ts), Math.floor((n - ORIGIN[1]) / ts)];
}

export function tileExtent(col, row, res) {
  const ts = tileSize(res), xmin = ORIGIN[0] + col * ts, ymin = ORIGIN[1] + row * ts;
  return { xmin, xmax: xmin + ts, ymin, ymax: ymin + ts };
}

const pad4 = (v) => String(v).padStart(4, "0");
export const tileId = (zone, res, col, row) => `${zoneId(zone)}_R${pad4(res)}_${pad4(col)}_${pad4(row)}`;

// "43S_R0060_0005_0094", or the older "43S_L1_0005_0094"; null if malformed
export function parseTileId(id) {
  const m = /^(\d{1,2})S_(R\d+|L1|L2)_(\d+)_(\d+)$/i.exec(String(id).trim());
  if (!m) return null;
  const zone = +m[1], tag = m[2].toUpperCase();
  const res = tag[0] === "R" ? +tag.slice(1) : LEVELS[tag];
  if (zone < 1 || zone > 60 || !(res > 0)) return null;
  return { zone, res, col: +m[3], row: +m[4] };
}

// A tile with everything a page or a GDAL call needs.
export function tile(zone, res, col, row) {
  const ext = tileExtent(col, row, res);
  return {
    zone, res, col, row, ...ext, id: tileId(zone, res, col, row), epsg: epsg(zone),
    // GDAL geotransform: top left, pixel size, north up
    gt: [ext.xmin, res, 0, ext.ymax, 0, -res]
  };
}

// The tile containing a point, in its own zone by default.
export function tileAt(lon, lat, res, zone = zoneOf(lon)) {
  const [e, n] = toZone(lon, lat, zone);
  const [col, row] = tileIndex(e, n, res);
  return tile(zone, res, col, row);
}

export function nesting(resParent, resChild) {
  const f = resParent / resChild;
  return f >= 1 && f === Math.round(f) ? f : 0;
}

export function parentOf(t, resParent) {
  const f = nesting(resParent, t.res);
  return f ? tile(t.zone, resParent, Math.floor(t.col / f), Math.floor(t.row / f)) : null;
}

export function childrenOf(t, resChild) {
  const f = nesting(t.res, resChild), out = [];
  if (!f) return out;
  for (let j = 0; j < f; j++)
    for (let i = 0; i < f; i++) out.push(tile(t.zone, resChild, t.col * f + i, t.row * f + j));
  return out;
}

// The tile's outline as lon/lat, `per` points along each edge, closed.
export function tileRing(t, per = 8) {
  const c = [[t.xmin, t.ymin], [t.xmax, t.ymin], [t.xmax, t.ymax], [t.xmin, t.ymax]];
  const ring = [];
  for (let k = 0; k < 4; k++) {
    const [x0, y0] = c[k], [x1, y1] = c[(k + 1) % 4];
    for (let i = 0; i < per; i++) ring.push(fromZone(t.zone, x0 + ((x1 - x0) * i) / per, y0 + ((y1 - y0) * i) / per));
  }
  ring.push(ring[0]);
  return ring;
}

// How far the lattice's pixel edges sit from Sentinel-2's at a resolution,
// in metres east and north, each in (-res/2, res/2]. Sentinel-2 tiles start
// on a 60 m easting lattice through 0 and, in the south, a 60 m northing
// lattice through the equator, which is 40 (mod 60) in northings because
// the 10 000 000 m false northing is not a multiple of 60.
export function s2Shift(res) {
  const wrap = (v) => { v = ((v % res) + res) % res; return v > res / 2 ? v - res : v; };
  return [wrap(ORIGIN[0]), wrap(ORIGIN[1] - 1e7)];
}

// The lattice lines of a zone at a resolution, as lon/lat segments
// [lon0, lat0, lon1, lat1, ...], over latitudes lat0 to lat1 and
// longitudes up to `past` degrees beyond the zone's edges. Segments inside
// the zone go in `inside`, the rest in `outside`. Each line is cut every
// `step` metres (a tile by default) so it follows the globe.
export function latticeSegments(zone, res, { lat0 = -80, lat1 = -45, past = 0, step = 0 } = {}) {
  const ts = tileSize(res), st = step || ts;
  const [w, e] = zoneEdges(zone), cm = centralMeridian(zone);
  const W = w - past, E = e + past;
  // the box in metres: widest at the north edge, deepest at the zone edge
  let emin = Infinity, emax = -Infinity, nmin = Infinity, nmax = -Infinity;
  for (const lat of [lat0, lat1]) for (const lon of [W, cm, E]) {
    const [x, y] = toZone(lon, lat, zone);
    emin = Math.min(emin, x); emax = Math.max(emax, x); nmin = Math.min(nmin, y); nmax = Math.max(nmax, y);
  }
  const c0 = Math.floor((emin - ORIGIN[0]) / ts), c1 = Math.ceil((emax - ORIGIN[0]) / ts);
  const r0 = Math.floor((nmin - ORIGIN[1]) / ts), r1 = Math.ceil((nmax - ORIGIN[1]) / ts);
  const inside = [], outside = [];
  const dl = (lon) => ((lon - cm + 540) % 360) - 180;
  const add = (x0, y0, x1, y1) => {
    const p = fromZone(zone, x0, y0), q = fromZone(zone, x1, y1);
    const m = fromZone(zone, (x0 + x1) / 2, (y0 + y1) / 2);
    if (m[1] < lat0 || m[1] > lat1 || Math.abs(dl(m[0])) > 3 + past) return;
    (Math.abs(dl(m[0])) <= 3 ? inside : outside).push(p[0], p[1], q[0], q[1]);
  };
  const y0 = ORIGIN[1] + r0 * ts, y1 = ORIGIN[1] + r1 * ts, x0 = ORIGIN[0] + c0 * ts, x1 = ORIGIN[0] + c1 * ts;
  const ny = Math.ceil((y1 - y0) / st), nx = Math.ceil((x1 - x0) / st);
  for (let c = c0; c <= c1; c++) {
    const x = ORIGIN[0] + c * ts;
    for (let k = 0; k < ny; k++) add(x, y0 + k * st, x, Math.min(y1, y0 + (k + 1) * st));
  }
  for (let r = r0; r <= r1; r++) {
    const y = ORIGIN[1] + r * ts;
    for (let k = 0; k < nx; k++) add(x0 + k * st, y, Math.min(x1, x0 + (k + 1) * st), y);
  }
  return { inside, outside, cols: [c0, c1], rows: [r0, r1] };
}
