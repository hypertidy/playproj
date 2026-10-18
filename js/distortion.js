// Distortion fields: PROJ's proj_factors() over a whole map, not just at
// the centres of Tissot's indicatrices.
//
// Every number here comes from factors() in tissot.js, so it is the same
// h, k, s, a, b, omega, theta' and convergence PROJ reports. This module
// samples them on a grid (in map or lon/lat space), puts them on a colour
// scale, finds contour lines (Snyder's "isocols"), and picks a size for
// the indicatrices so they fit the lattice they are drawn on. Nothing in it
// touches the DOM; colours come back as [r, g, b].

import { factors } from "./tissot.js";

const D2R = Math.PI / 180;

// The fields a map can be coloured by. `kind` sets the colour scale:
//  scale   a ratio where 1 is true; log2, diverging about 1
//  ratio   a ratio of at least 1 (a / b); log2, sequential from 1
//  angle   degrees of error, sequential from 0
//  signed  degrees either side of 0, diverging
// `get` reads it from a factors() object. `proj` names PROJ's field.
export const FIELDS = [
  { key: "s", label: "areal scale", sym: "s", proj: "areal_scale", kind: "scale", get: (f) => f.s },
  { key: "omega", label: "angular distortion", sym: "\u03c9", proj: "angular_distortion", kind: "angle", get: (f) => f.omega },
  { key: "h", label: "scale along the meridian", sym: "h", proj: "meridional_scale", kind: "scale", get: (f) => f.h },
  { key: "k", label: "scale along the parallel", sym: "k", proj: "parallel_scale", kind: "scale", get: (f) => f.k },
  { key: "a", label: "largest scale", sym: "a", proj: "tissot_semimajor", kind: "scale", get: (f) => f.a },
  { key: "b", label: "smallest scale", sym: "b", proj: "tissot_semiminor", kind: "scale", get: (f) => f.b },
  { key: "ab", label: "flattening of the ellipse", sym: "a/b", proj: null, kind: "ratio", get: (f) => f.a / f.b },
  { key: "orth", label: "departure from a right angle", sym: "90\u00b0 \u2212 \u03b8\u2032", proj: "meridian_parallel_angle", kind: "angle", get: (f) => 90 - Math.abs(f.thetap) },
  { key: "conv", label: "meridian convergence", sym: "\u03b3", proj: "meridian_convergence", kind: "signed", get: (f) => f.conv }
];
export const FIELD = new Map(FIELDS.map((d) => [d.key, d]));

// The bands written to a factors GeoTIFF: PROJ's own names and values.
export const BANDS = [
  ["meridional_scale", (f) => f.h], ["parallel_scale", (f) => f.k], ["areal_scale", (f) => f.s],
  ["angular_distortion", (f) => f.omega], ["meridian_parallel_angle", (f) => f.thetap],
  ["meridian_convergence", (f) => f.conv], ["tissot_semimajor", (f) => f.a], ["tissot_semiminor", (f) => f.b]
];

// ---------------------------------------------------------------- sampling

// Factors at the centre of every cell of an nx by ny grid. `at(i, j)`
// gives the [lon, lat] of cell i, j (column, row) or null where it is off
// the map. `get` is a list of [name, f => value]. Returns one Float32Array
// per name, rows first, NaN where there is no value.
export function sample(fwd, at, nx, ny, get, { es = 0 } = {}) {
  const out = {};
  for (const [name] of get) out[name] = new Float32Array(nx * ny).fill(NaN);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const ll = at(i, j);
      const f = ll && factors(fwd, ll[0], ll[1], { es });
      if (!f) continue;
      for (const [name, g] of get) out[name][j * nx + i] = g(f);
    }
  }
  return out;
}

// Cell centres of a grid over a map extent { x0, x1, y0, y1 }, rows from
// the top, through an inverse projection inv(x, y) -> [lon, lat] | null.
export const mapCells = (inv, e, nx, ny) => (i, j) =>
  inv(e.x0 + ((i + 0.5) * (e.x1 - e.x0)) / nx, e.y1 - ((j + 0.5) * (e.y1 - e.y0)) / ny);

// Cell centres of a global lon/lat grid, rows from the south (as a texture
// with flipY off wants them). `on(lon, lat)` says whether the point is on
// the map at all.
export const lonLatCells = (nx, ny, on = () => true) => (i, j) => {
  const lon = -180 + (360 * (i + 0.5)) / nx, lat = -90 + (180 * (j + 0.5)) / ny;
  return on(lon, lat) ? [lon, lat] : null;
};

// ---------------------------------------------------------------- lattices

// Centres for indicatrices: a lon/lat lattice every `step` degrees about
// the central meridian, short of the seam and the poles.
export function graticuleLattice(step, lon0 = 0) {
  const out = [];
  for (let lat = -90 + step; lat < 90 - 1e-9; lat += step) {
    for (let dl = -180 + step; dl < 180 - 1e-9; dl += step) out.push([((lon0 + dl + 540) % 360) - 180, lat]);
  }
  return out;
}

// Centres on a square grid laid over the map extent, n across (the
// tissot_unproject() way of sampling a projected region), kept where the
// inverse finds the globe.
export function mapLattice(inv, e, n) {
  const d = (e.x1 - e.x0) / n, ny = Math.max(1, Math.round((e.y1 - e.y0) / d));
  const y0 = (e.y0 + e.y1) / 2 - (ny * d) / 2, out = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < n; i++) {
      const ll = inv(e.x0 + (i + 0.5) * d, y0 + (j + 0.5) * d);
      if (ll) out.push([ll[0], ll[1]]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- sizing

// How much each indicatrix is shrunk or swollen before it is drawn: 1 keeps
// its true size (the image of a ground circle), 1 / sqrt(s) draws every one
// with the same area so only its shape and tilt are left.
export const sizeFactor = (f, mode) => (mode === "shape" ? 1 / Math.sqrt(f.s) : 1);

// A ground radius (in units of the sphere's radius) for circles centred on
// `pts` (factor objects with map x, y) so that their ellipses fill `fill` of
// the gap to the nearest neighbour on the map. Each centre counts for the
// share of the globe it stands for (`weight`, by default cos(lat), right
// for a lon/lat lattice; 1 / s suits a grid on the map), and the radius is
// the one that keeps ellipses over (1 - q) of that area clear of their
// neighbours: a few crowded ones near a pole or the edge of the map do not
// shrink them all.
export function autoRadius(pts, { fill = 0.8, mode = "true", q = 0.2, weight = (f) => Math.cos(f.lat * D2R) } = {}) {
  const fit = [];
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    let d = Infinity;
    for (let j = 0; j < pts.length; j++) {
      if (j !== i) d = Math.min(d, Math.hypot(pts[j].x - p.x, pts[j].y - p.y));
    }
    const reach = p.a * sizeFactor(p, mode), w = Math.max(0, weight(p)) || 0;
    if (Number.isFinite(d) && d > 0 && reach > 0 && w > 0) { fit.push([d / (2 * reach), w]); total += w; }
  }
  if (!fit.length) return null;
  fit.sort((a, b) => a[0] - b[0]);
  let acc = 0;
  for (const [r, w] of fit) {
    acc += w;
    if (acc >= q * total) return fill * r;
  }
  return fill * fit[fit.length - 1][0];
}

// ---------------------------------------------------------------- summary

// Range and mean of each field over a set of [lon, lat, factors] samples,
// the mean weighted by cos(lat) so it is a mean over the globe's area.
export function summarise(samples, keys = ["s", "omega", "h", "k"]) {
  const out = {};
  for (const key of keys) {
    const get = FIELD.get(key).get;
    let lo = Infinity, hi = -Infinity, sw = 0, sv = 0;
    for (const [, lat, f] of samples) {
      const v = get(f);
      if (!Number.isFinite(v)) continue;
      const w = Math.cos(lat * D2R);
      lo = Math.min(lo, v); hi = Math.max(hi, v); sw += w; sv += w * v;
    }
    out[key] = Number.isFinite(lo) ? { min: lo, max: hi, mean: sv / sw } : null;
  }
  return out;
}

// ---------------------------------------------------------------- colour

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const NEUTRAL = [27, 38, 56];
const SHRINK = [70, 120, 230], SWELL = [235, 120, 40];
const SEQ = [NEUTRAL, [150, 60, 170], [255, 210, 90]];
const ramp = (stops, t) => {
  const u = Math.max(0, Math.min(1, t)) * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(u));
  return mix(stops[k], stops[k + 1], u - k);
};

// Quantile of the finite values of an array (or list).
export function quantile(values, q) {
  const v = [];
  for (const x of values) if (Number.isFinite(x)) v.push(x);
  if (!v.length) return NaN;
  v.sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))];
}

// A colour scale for a field, fitted to its values: the 2nd to 98th
// percentile, so a pole or a seam does not wash the rest out. Scales and
// ratios work in log2 (twice and half are the same distance from 1).
// Returns { t(v) in [-1, 1] or [0, 1] and its inverse value(t), rgb(v),
// pos(v) and at(u) for a 0 to 1 colour bar, lo, hi, dlo, dhi, diverging,
// kind }: lo and hi are the ends of the colour bar and dlo, dhi
// the percentiles of the data, all in the field's own units.
export function colourScale(key, values, { robust = 0.02 } = {}) {
  const d = FIELD.get(key), kind = d.kind;
  const plo = quantile(values, robust), phi = quantile(values, 1 - robust);
  const sc = colourScaleFrom(kind, plo, phi);
  sc.dlo = plo; sc.dhi = phi;
  // position along a colour bar, 0 to 1, and back
  sc.pos = (v) => (sc.diverging ? (sc.t(v) + 1) / 2 : sc.t(v));
  sc.at = (u) => sc.value(sc.diverging ? 2 * u - 1 : u);
  return sc;
}

function colourScaleFrom(kind, plo, phi) {
  if (kind === "scale") {
    // never narrower than 1% either way, or a constant 1 turns to noise
    const L = Math.max(Math.abs(Math.log2(plo)) || 0, Math.abs(Math.log2(phi)) || 0, Math.log2(1.01));
    const t = (v) => Math.max(-1, Math.min(1, Math.log2(v) / L));
    return { kind, diverging: true, lo: 2 ** -L, hi: 2 ** L, t, value: (u) => 2 ** (u * L), rgb: (v) => divergent(t(v)) };
  }
  if (kind === "ratio") {
    const L = Math.max(Math.log2(phi) || 0, Math.log2(1.01));
    const t = (v) => Math.max(0, Math.min(1, Math.log2(v) / L));
    return { kind, diverging: false, lo: 1, hi: 2 ** L, t, value: (u) => 2 ** (u * L), rgb: (v) => ramp(SEQ, t(v)) };
  }
  if (kind === "angle") {
    const hi = Math.max(phi || 0, 0.5);
    const t = (v) => Math.max(0, Math.min(1, v / hi));
    return { kind, diverging: false, lo: 0, hi, t, value: (u) => u * hi, rgb: (v) => ramp(SEQ, t(v)) };
  }
  const M = Math.max(Math.abs(plo) || 0, Math.abs(phi) || 0, 0.5);
  const t = (v) => Math.max(-1, Math.min(1, v / M));
  return { kind, diverging: true, lo: -M, hi: M, t, value: (u) => u * M, rgb: (v) => divergent(t(v)) };
}
const divergent = (t) => (t < 0 ? mix(NEUTRAL, SHRINK, -t) : mix(NEUTRAL, SWELL, t));

// Colour an array of values into RGBA bytes (alpha 0 where NaN).
export function paint(values, scale, rgba = new Uint8ClampedArray(values.length * 4)) {
  for (let i = 0; i < values.length; i++) {
    const v = values[i], o = 4 * i;
    if (!Number.isFinite(v)) { rgba[o + 3] = 0; continue; }
    const c = scale.rgb(v);
    rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
  }
  return rgba;
}

// ---------------------------------------------------------------- contours

// Contour values in tiers of roundness: the first tier is always offered,
// later ones only while there is room.
const SCALE_TIERS = [[1, 2, 0.5, 10, 0.1, 100, 0.01], [1.25, 0.8, 4, 0.25, 5, 0.2, 20, 0.05, 50, 0.02],
  [1.5, 2 / 3, 1.1, 0.9, 3, 1 / 3], [1.05, 0.95, 1.02, 0.98, 1.01, 0.99]];
const ANGLE_TIERS = [[10, 30, 60, 90], [1, 5, 20, 45], [2, 15, 40, 50, 70, 80, 120, 150, 0.5], [0.1, 0.2]];

// Round values to draw contours at, inside the range the data actually
// covers (dlo to dhi): the familiar ones (half, twice, 10 degrees) first,
// at most about `max` unless the first tier alone is more.
export function levels(scale, max = 9) {
  const { dlo, dhi, kind } = scale;
  const inside = (v) => v > dlo + 1e-9 * Math.abs(dlo) && v < dhi - 1e-9 * Math.abs(dhi);
  if (kind === "signed") {
    const M = Math.max(Math.abs(dlo), Math.abs(dhi));
    const step = [1, 2, 5, 10, 15, 30, 45, 90].find((s) => (2 * M) / s <= max) || 90;
    const list = [];
    for (let v = Math.ceil(dlo / step) * step; v <= dhi; v += step) if (inside(v)) list.push(v);
    return list;
  }
  const tiers = kind === "angle" ? ANGLE_TIERS : SCALE_TIERS;
  let list = [];
  for (const tier of tiers) {
    const add = tier.filter((v) => inside(v) && (kind !== "ratio" || v > 1));
    if (list.length && list.length + add.length > max) break;
    list = list.concat(add);
  }
  return list.sort((a, b) => a - b);
}

// Contour lines of a grid at one level, by marching squares on the cell
// centres: segments as a flat [x1, y1, x2, y2, ...] in grid units (cell i
// has its centre at i + 0.5). Squares with a NaN corner are skipped, so the
// lines stop at the edge of the map. `tf` transforms values first (log2
// for scales, so lines fall where the ratio really crosses the level).
export function isolines(values, nx, ny, level, tf = (v) => v) {
  const out = [], L = tf(level);
  const v = (i, j) => tf(values[j * nx + i]);
  const lerp = (a, b) => (L - a) / (b - a);
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = v(i, j), b = v(i + 1, j), c = v(i + 1, j + 1), d = v(i, j + 1);
      if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d))) continue;
      const code = (a > L ? 8 : 0) | (b > L ? 4 : 0) | (c > L ? 2 : 0) | (d > L ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const x = i + 0.5, y = j + 0.5;
      // crossing points on the four edges: top (a-b), right (b-c), bottom (d-c), left (a-d)
      const T = () => [x + lerp(a, b), y], R = () => [x + 1, y + lerp(b, c)];
      const B = () => [x + lerp(d, c), y + 1], Lf = () => [x, y + lerp(a, d)];
      const seg = (p, q) => out.push(p[0], p[1], q[0], q[1]);
      switch (code) {
        case 1: case 14: seg(Lf(), B()); break;
        case 2: case 13: seg(B(), R()); break;
        case 3: case 12: seg(Lf(), R()); break;
        case 4: case 11: seg(T(), R()); break;
        case 6: case 9: seg(T(), B()); break;
        case 7: case 8: seg(Lf(), T()); break;
        case 5: case 10: {
          // a saddle: the centre decides which pairs of corners join
          const up = (a + b + c + d) / 4 > L;
          if ((code === 5) === up) { seg(Lf(), T()); seg(B(), R()); } else { seg(Lf(), B()); seg(T(), R()); }
          break;
        }
      }
    }
  }
  return out;
}

// The transform isolines() should use for a field.
export const contourTransform = (key) => (FIELD.get(key).kind === "scale" || FIELD.get(key).kind === "ratio" ? Math.log2 : (v) => v);
