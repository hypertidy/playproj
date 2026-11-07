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
