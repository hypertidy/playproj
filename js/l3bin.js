// The SeaWiFS / MODIS level-3 binning grid (Campbell, Blaisdell and Darzi,
// NASA Technical Memorandum 104566, vol. 32, 1995): an integerized
// sinusoidal equal-area grid. The globe is cut into `nrows` rows of equal
// height in latitude; each row holds a whole number of bins, as many as fit
// round its middle latitude at the same width as the bins at the equator.
// Bins are numbered from 1, west to east along each row, rows from south to
// north. 2160 rows gives the 9.28 km SeaWiFS grid, 4320 the 4.64 km MODIS one.

const D2R = Math.PI / 180;
export const EARTH_AREA = 510065621.7;   // km2 on the authalic sphere

const cache = new Map();

export function grid(nrows) {
  if (cache.has(nrows)) return cache.get(nrows);
  const latbin = new Float64Array(nrows), numbin = new Int32Array(nrows), basebin = new Float64Array(nrows);
  let base = 1;
  for (let r = 0; r < nrows; r++) {
    latbin[r] = ((r + 0.5) * 180) / nrows - 90;
    numbin[r] = Math.floor(2 * nrows * Math.cos(latbin[r] * D2R) + 0.5);
    basebin[r] = base;
    base += numbin[r];
  }
  const g = { nrows, latbin, numbin, basebin, totbins: base - 1 };
  cache.set(nrows, g);
  return g;
}

export function rowOfLat(g, lat) {
  return Math.max(0, Math.min(g.nrows - 1, Math.floor(((90 + lat) * g.nrows) / 180)));
}

export function binOf(g, lon, lat) {
  const r = rowOfLat(g, lat);
  const lon360 = ((((lon + 180) % 360) + 360) % 360);
  const col = Math.max(0, Math.min(g.numbin[r] - 1, Math.floor((lon360 * g.numbin[r]) / 360)));
  return g.basebin[r] + col;
}

// row and column (both from 0) of a bin number, or null if out of range
export function rowCol(g, bin) {
  if (!(bin >= 1 && bin <= g.totbins && Number.isInteger(bin))) return null;
  let lo = 0, hi = g.nrows - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.basebin[mid] <= bin) lo = mid; else hi = mid - 1;
  }
  return { row: lo, col: bin - g.basebin[lo] };
}

export function binBounds(g, bin) {
  const rc = rowCol(g, bin);
  if (!rc) return null;
  const { row, col } = rc, n = g.numbin[row], h = 90 / g.nrows;
  const lat = g.latbin[row], w = 360 / n;
  return {
    row, col, numbin: n,
    centre: [-180 + (col + 0.5) * w, lat],
    west: -180 + col * w, east: -180 + (col + 1) * w,
    south: lat - h, north: lat + h
  };
}

// area of a bin on the sphere (km2): a band of the sphere cut by meridians
export function binArea(b) {
  const band = (Math.sin(b.north * D2R) - Math.sin(b.south * D2R)) / 2;
  return (EARTH_AREA * band) / b.numbin;
}
