// Synthetic terrain for the shallow water model, matched number for number
// by the shallows R package (R/generate.R in
// https://github.com/hypertidy/shallows): the same shape, size
// and seed give the same bed in R and here.
//
// Grids are row-major, ny rows by nx columns, row 0 at the north (top) edge.
// Local coordinates are metres from the grid centre: X east, Y north.
//
// The noise is value noise on an integer lattice, hashed with Park-Miller
// steps (products stay below 2^53, so doubles are exact in both languages),
// blended with the quintic smoothstep, summed over octaves (fBm).

const M = 2147483647;

function mod(a, m) { const r = a % m; return r < 0 ? r + m : r; }

/** Lattice hash in [0, 1). */
export function hash01(i, j, seed) {
  let h = mod(i * 1619 + j * 31337 + seed * 6971, M);
  h = mod(h * 48271, M);
  h = mod(h * 48271 + 12345, M);
  h = mod(h * 48271, M);
  return h / M;
}

/** Value noise in [-1, 1] at lattice coordinates (x, y). */
export function noise2(x, y, seed) {
  const i = Math.floor(x), j = Math.floor(y);
  const fx = x - i, fy = y - j;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash01(i, j, seed), b = hash01(i + 1, j, seed);
  const c = hash01(i, j + 1, seed), d = hash01(i + 1, j + 1, seed);
  const top = a + (b - a) * u, bot = c + (d - c) * u;
  return 2 * (top + (bot - top) * v) - 1;
}

/**
 * Fractal (fBm) noise in about [-1, 1]: octaves of value noise, each at
 * twice the frequency and `gain` times the amplitude of the last.
 * @param {number} X,Y metres
 * @param {object} p {scale (m, largest wavelength), octaves, gain, seed}
 */
export function fbm(X, Y, p) {
  let amp = 1, sum = 0, norm = 0, f = 1 / p.scale;
  for (let o = 0; o < p.octaves; o++) {
    sum += amp * noise2(X * f, Y * f, p.seed + o * 101);
    norm += amp; amp *= p.gain; f *= 2;
  }
  return sum / norm;
}

export const SHAPES = {
  // z0 at the centre, falling slope_x per metre to the east, slope_y to the north
  plane: { z0: 0, slope_x: 0.01, slope_y: 0 },
  // valley draining east: floor falls `slope`, sides rise `side` per metre
  // beyond a flat floor `floor` metres wide
  valley: { z0: 0, slope: 0.01, side: 0.3, floor: 20 },
  // paraboloid bowl: `depth` below the rim level at the centre, rim at radius
  bowl: { depth: 10, radius: 500 },
  // coast running north-south, land to the west, sea to the east of X = 0:
  // land rises land_slope; shelf falls shelf_slope to shelf_depth at the break,
  // then slope_slope down to abyss
  shelf: { land_slope: 0.02, shelf_slope: 0.002, shelf_depth: 120, slope_slope: 0.05, abyss: 3000 },
  // island or seamount: gaussian of height `height` above sea level on a sea
  // floor `depth` deep, e-folding radius `radius`
  island: { height: 50, depth: 30, radius: 300 },
  // valley with a dam across it at X = dam_x: wall `dam_height` above the
  // floor there, `dam_thick` thick, with a breach `breach` metres wide
  // (0 for an intact dam)
  reservoir: { z0: 0, slope: 0.01, side: 0.3, floor: 20, dam_x: 0, dam_height: 15, dam_thick: 20, breach: 0 },
};

function shapeZ(shape, X, Y, q) {
  switch (shape) {
    case "plane": return q.z0 - q.slope_x * X - q.slope_y * Y;
    case "valley": return q.z0 - q.slope * X + q.side * Math.max(Math.abs(Y) - q.floor / 2, 0);
    case "bowl": return q.depth * ((X * X + Y * Y) / (q.radius * q.radius) - 1);
    case "shelf": {
      if (X <= 0) return -q.land_slope * X;
      const xb = q.shelf_depth / q.shelf_slope;
      if (X <= xb) return -q.shelf_slope * X;
      return -Math.min(q.abyss, q.shelf_depth + q.slope_slope * (X - xb));
    }
    case "island": return -q.depth + (q.height + q.depth) * Math.exp(-(X * X + Y * Y) / (q.radius * q.radius));
    case "reservoir": {
      const v = q.z0 - q.slope * X + q.side * Math.max(Math.abs(Y) - q.floor / 2, 0);
      if (Math.abs(X - q.dam_x) <= q.dam_thick / 2 && Math.abs(Y) >= q.breach / 2) {
        return Math.max(v, q.z0 - q.slope * q.dam_x + q.dam_height);
      }
      return v;
    }
    default: throw new Error("unknown shape " + shape);
  }
}

/**
 * Generate a bed.
 * @param {object} o {shape, nx, ny, dx, dy?, params?, noise?: {amp, scale, octaves, gain, seed}}
 * @returns {{nx, ny, dx, dy, z: Float64Array}}
 */
export function generate(o) {
  const nx = o.nx, ny = o.ny, dx = o.dx, dy = o.dy ?? o.dx;
  const q = { ...SHAPES[o.shape], ...(o.params || {}) };
  if (!SHAPES[o.shape]) throw new Error("unknown shape " + o.shape);
  const nz = o.noise && o.noise.amp ? { octaves: 5, gain: 0.5, seed: 1, scale: 200, ...o.noise } : null;
  const z = new Float64Array(nx * ny);
  for (let i = 0; i < ny; i++) {
    const Y = (ny / 2 - i - 0.5) * dy;
    for (let j = 0; j < nx; j++) {
      const X = (j + 0.5 - nx / 2) * dx;
      let v = shapeZ(o.shape, X, Y, q);
      if (nz) v += nz.amp * fbm(X, Y, nz);
      z[i * nx + j] = v;
    }
  }
  return { nx, ny, dx, dy, z };
}

/**
 * Fill a lake: depth of water standing at `level` in the cells connected
 * (4-neighbour) to cell (i0, j0) that lie below it. Works on any bed, real
 * or generated, so a reservoir, a crater or a hollow can start full.
 * @returns {Float64Array} depth, row-major
 */
export function fillLake(z, nx, ny, i0, j0, level) {
  const h = new Float64Array(nx * ny);
  if (!(z[i0 * nx + j0] < level)) return h;
  const seen = new Uint8Array(nx * ny), stack = [i0 * nx + j0];
  seen[i0 * nx + j0] = 1;
  while (stack.length) {
    const k = stack.pop(), i = (k / nx) | 0, j = k - i * nx;
    h[k] = level - z[k];
    const nb = [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]];
    for (const [a, b] of nb) {
      if (a < 0 || b < 0 || a >= ny || b >= nx) continue;
      const kk = a * nx + b;
      if (!seen[kk] && z[kk] < level) { seen[kk] = 1; stack.push(kk); }
    }
  }
  return h;
}

/**
 * Fill the sea: depth of water standing at `level` in cells below it that
 * connect (4-neighbour) to the grid's edge. Inland hollows below the level
 * stay dry.
 * @returns {Float64Array} depth, row-major
 */
export function fillSea(z, nx, ny, level) {
  const h = new Float64Array(nx * ny), seen = new Uint8Array(nx * ny), stack = [];
  const push = (i, j) => { const k = i * nx + j; if (!seen[k] && z[k] < level) { seen[k] = 1; stack.push(k); } };
  for (let j = 0; j < nx; j++) { push(0, j); push(ny - 1, j); }
  for (let i = 0; i < ny; i++) { push(i, 0); push(i, nx - 1); }
  while (stack.length) {
    const k = stack.pop(), i = (k / nx) | 0, j = k - i * nx;
    h[k] = level - z[k];
    if (i > 0) push(i - 1, j);
    if (i < ny - 1) push(i + 1, j);
    if (j > 0) push(i, j - 1);
    if (j < nx - 1) push(i, j + 1);
  }
  return h;
}
