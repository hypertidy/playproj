// Story scenes: a square of ground as a draped terrain mesh, and a block
// (a building, a cube, any box with a height in metres) set down on it.
//
// The ground is a regular grid of vertices in metres on a Lambert
// azimuthal equal-area plane about the centre (laea in voxels.js), each
// vertex's height read from a sampler (lon, lat) -> metres. The block
// stands on the lowest ground under its footprint, so no corner floats;
// the uphill side is cut into the slope, as a real building would be.

import { laea } from "./voxels.js";

const D2R = Math.PI / 180;

// The vertices of a square of side ext metres at (lon0, lat0), n cells
// (n + 1 vertices) across: xy (scene metres, x east, y north) and ll
// (lon, lat), row-major from the north-west corner, as images are.
export function terrainGrid(lon0, lat0, ext, n) {
  const P = laea(lon0, lat0), m = n + 1, xy = new Float64Array(m * m * 2), ll = new Float64Array(m * m * 2);
  for (let j = 0; j < m; j++)
    for (let i = 0; i < m; i++) {
      const k = j * m + i, x = -ext / 2 + (i * ext) / n, y = ext / 2 - (j * ext) / n;
      const [lon, lat] = P.inverse(x, y);
      xy[2 * k] = x; xy[2 * k + 1] = y; ll[2 * k] = lon; ll[2 * k + 1] = lat;
    }
  return { lon0, lat0, ext, n, m, cellM: ext / n, xy, ll, P };
}

// Heights at each vertex from sample(lon, lat). Missing values (NaN) take
// the lowest height found, so the mesh has no holes; lo, hi and missing
// say what was there.
export function gridHeights(grid, sample) {
  const N = grid.m * grid.m, z = new Float32Array(N);
  let lo = Infinity, hi = -Infinity, missing = 0;
  for (let k = 0; k < N; k++) {
    const v = sample(grid.ll[2 * k], grid.ll[2 * k + 1]);
    z[k] = v;
    if (v === v) { lo = Math.min(lo, v); hi = Math.max(hi, v); } else missing++;
  }
  if (missing) for (let k = 0; k < N; k++) if (z[k] !== z[k]) z[k] = lo === Infinity ? 0 : lo;
  if (lo === Infinity) lo = hi = 0;
  return { z, lo, hi, missing };
}

// Triangle indices for an m x m vertex grid, two to a cell, each cell cut
// along the diagonal that better follows the ground (the shorter one in
// height), counter-clockwise seen from above with y north.
export function gridTriangles(m, z = null) {
  const out = new Uint32Array((m - 1) * (m - 1) * 6);
  let t = 0;
  for (let j = 0; j < m - 1; j++)
    for (let i = 0; i < m - 1; i++) {
      const a = j * m + i, b = a + 1, c = a + m, d = c + 1;   // a nw, b ne, c sw, d se
      const flip = z && Math.abs(z[b] - z[c]) < Math.abs(z[a] - z[d]);
      if (flip) { out.set([a, c, b, b, c, d], t); } else { out.set([a, c, d, a, d, b], t); }
      t += 6;
    }
  return out;
}

// The corners of a w (east) by d (north) footprint at scene x, y, turned
// rot degrees clockwise (seen from above, from north), as [[x, y], ...]
// round from the south-west.
export function footprintCorners(x, y, w, d, rot = 0) {
  const a = -rot * D2R, c = Math.cos(a), s = Math.sin(a);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
    const px = (u * w) / 2, py = (v * d) / 2;
    return [x + px * c - py * s, y + px * s + py * c];
  });
}

// The ground under a footprint: k x k samples spread over it (corners and
// edges included) through the plane's inverse P. min is where the block
// stands; max - min is how far the slope climbs across it.
export function seat(sample, P, x, y, w, d, rot = 0, k = 9) {
  const a = -rot * D2R, c = Math.cos(a), s = Math.sin(a);
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  for (let j = 0; j < k; j++)
    for (let i = 0; i < k; i++) {
      const px = (i / (k - 1) - 0.5) * w, py = (j / (k - 1) - 0.5) * d;
      const [lon, lat] = P.inverse(x + px * c - py * s, y + px * s + py * c);
      const v = sample(lon, lat);
      if (v !== v) continue;
      min = Math.min(min, v); max = Math.max(max, v); sum += v; n++;
    }
  return n ? { min, max, mean: sum / n, n } : null;
}

// A block of storeys: height in metres and the storey lines on its sides.
export function blockHeight(storeys, storeyM) {
  return Math.max(0, storeys) * Math.max(0, storeyM);
}

// ------------------------------------------------------------ quantities

// Bulk densities in tonnes a cubic metre, typical values to turn a tonnage
// into a volume (a story should say which it used: soil in place is denser
// than the same soil loose in a truck).
export const MATERIALS = {
  soil: { name: "Soil, in place", t: 1.8, rgb: "8a6a4a" },
  loose: { name: "Soil, loose (dug out)", t: 1.5, rgb: "9c7b55" },
  waste: { name: "Mixed waste, compacted in a landfill", t: 0.8, rgb: "8d8a7c" },
  water: { name: "Fresh water", t: 1.0, rgb: "3f7fb8" },
  seawater: { name: "Sea water", t: 1.025, rgb: "2f6a9a" },
  ice: { name: "Glacial ice", t: 0.917, rgb: "dcecf5" },
  concrete: { name: "Concrete", t: 2.4, rgb: "b9b5ad" },
  sand: { name: "Dry sand", t: 1.6, rgb: "d8c08a" },
  co2: { name: "CO2 gas, 15 C at sea-level pressure", t: 0.00187, rgb: "c9c9c9" },
  gold: { name: "Gold", t: 19.3, rgb: "d4af37" }
};

// Cubic metres of amount in unit ("m3", or "t" of material).
export function volumeOf(amount, unit, material) {
  if (unit === "m3") return amount;
  const m = MATERIALS[material];
  return m ? amount / m.t : NaN;
}

// A volume as a block: a cube; a slab (or heap) standing on a w x d
// footprint; or a pit dug down into one. { w, d, h, pit }.
export function shapeFor(volume, shape, w, d) {
  if (shape === "cube") { const s = Math.cbrt(volume); return { w: s, d: s, h: s, pit: false }; }
  return { w, d, h: volume / (w * d), pit: shape === "pit" };
}
