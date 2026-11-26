// The Navigation page's ice-shelf cavity, without three.js: BedMachine
// Antarctica v4.1's grids (EPSG:3031, 500 m cells, with overviews of about
// 1, 2, 4, 8 and 16 km) read over a box round an ice shelf; each cell's
// column of ice, water and rock; the triangles of each surface; the open
// edges where an ice front stands; the bands of ice, water and rock down
// the sides of the block and down a section through it; and where a point
// is in its column.

export const BEDMACHINE = {
  base: "https://data.source.coop/ausantarctic/bedmachine/v4.1/cog/",
  layers: ["mask", "bed", "surface", "thickness"],
  // the grid's outer edge, metres from the pole each way (13,333 cells of
  // 500 m), and each level's width in cells: the file, then its overviews
  half: 3333250,
  widths: [13333, 6666, 3333, 1666, 833, 416],
  nodata: -9999,
  doi: "10.5067/POJQI54A45HX"
};

// BedMachine's mask values, and what the readout calls each
export const KIND = { none: -1, ocean: 0, land: 1, grounded: 2, floating: 3, lake: 4 };
export const KIND_NAMES = ["open sea", "ice-free land", "grounded ice", "floating ice", "Lake Vostok"];

// Ice shelves: the extent of each one's floating ice in EPSG:3031 metres,
// [x0, x1, y0, y1], as BedMachine v4.1's mask has it at 2 km.
export const SHELVES = {
  amery: { name: "Amery Ice Shelf", ext: [1684e3, 2243e3, 613e3, 839e3] },
  ross: { name: "Ross Ice Shelf", ext: [-593e3, 399e3, -1353e3, -435e3] },
  "filchner-ronne": { name: "Filchner–Ronne Ice Shelf", ext: [-1511e3, -525e3, 133e3, 1035e3] },
  larsen: { name: "Larsen C and D Ice Shelves", ext: [-2337e3, -1611e3, 905e3, 1293e3] },
  totten: { name: "Totten Ice Shelf", ext: [2189e3, 2321e3, -1295e3, -1005e3] },
  "pine-island": { name: "Pine Island Ice Shelf", ext: [-1685e3, -1561e3, -361e3, -257e3] }
};

// A shelf's extent with a margin all round, a share of its longer side, so
// there is open sea and grounded ice to see too: { x0, x1, y0, y1 }.
export function shelfBox(ext, margin = 0.12) {
  const [x0, x1, y0, y1] = ext, m = margin * Math.max(x1 - x0, y1 - y0);
  return { x0: x0 - m, x1: x1 + m, y0: y0 - m, y1: y1 + m };
}

// The vertical exaggeration a shelf's box opens at: a kilometre of depth
// drawn as about 7% of the box's longer side, to the nearest 5 (Amery's
// 50, Ross's 90, Pine Island's 10), so a small box is not drawn tall nor a
// large one flat.
export function shelfVx(box) {
  return Math.max(5, 5 * Math.round(0.0144 * (Math.max(box.x1 - box.x0, box.y1 - box.y0) / 1000)));
}

// The finest level of the grid that covers the box in no more than max
// cells across, and which of its cells the box needs: columns c0 to c1 and
// rows r0 to r1 (end not included), clipped to the grid; w x h cells of d
// metres, the first one's centre at x0, y0 (rows run south from the top).
// Each level's cells are the grid's extent over its width, as GDAL makes
// an overview's (so a "1 km" cell is 1,000.075 m).
export function readPlan(box, max = 768, G = BEDMACHINE) {
  const size = (k) => (2 * G.half) / G.widths[k], span = Math.max(box.x1 - box.x0, box.y1 - box.y0);
  let level = 0;
  while (level < G.widths.length - 1 && span / size(level) > max) level++;
  const d = size(level), W = G.widths[level];
  const c0 = Math.max(0, Math.floor((box.x0 + G.half) / d)), c1 = Math.min(W, Math.ceil((box.x1 + G.half) / d));
  const r0 = Math.max(0, Math.floor((G.half - box.y1) / d)), r1 = Math.min(W, Math.ceil((G.half - box.y0) / d));
  return { level, d, W, c0, c1, r0, r1, w: c1 - c0, h: r1 - r0, x0: -G.half + (c0 + 0.5) * d, y0: G.half - (r0 + 0.5) * d };
}

// Each cell's column from the four layers (arrays of the same length):
// its kind (the mask, or -1 where a layer has no data), the top (the ice
// surface, sea level over open sea, the ground on ice-free land), the base
// of the ice (surface minus thickness where the ice floats, the bed under
// grounded ice, the top where there is no ice), and the bed. BedMachine's
// thickness includes the firn, so on grounded ice surface minus thickness
// is the bed. Where averaging over an overview's cell leaves a floating
// base below the bed, the base is put on the bed.
export function columnsOf({ mask, bed, surface, thickness }, nodata = BEDMACHINE.nodata) {
  const n = mask.length, kind = new Int8Array(n), top = new Float32Array(n), base = new Float32Array(n), floor = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const b = bed[k], s = surface[k], t = thickness[k];
    let m = mask[k];
    if (b === nodata || s === nodata || t === nodata || !(m >= 0 && m <= 4)) m = -1;
    kind[k] = m;
    if (m < 0) continue;
    floor[k] = b;
    if (m === 0) top[k] = base[k] = 0;
    else if (m === 1) top[k] = base[k] = b;
    else if (m === 2) { top[k] = s; base[k] = b; }
    else { top[k] = s; base[k] = Math.max(b, s - t); }
  }
  return { kind, top, base, bed: floor };
}

// The triangles of a w x h grid of vertices (row by row from the top), two
// a cell and counter-clockwise seen from above, that keep(a, b, c) keeps.
export function gridTriangles(w, h, keep) {
  const out = new Uint32Array(Math.max(0, (w - 1) * (h - 1) * 6));
  let o = 0;
  for (let j = 0; j < h - 1; j++)
    for (let i = 0; i < w - 1; i++) {
      const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
      if (keep(a, c, b)) { out[o++] = a; out[o++] = c; out[o++] = b; }
      if (keep(b, c, d)) { out[o++] = b; out[o++] = c; out[o++] = d; }
    }
  return out.slice(0, o);
}

// The edges of the triangles keep keeps (as gridTriangles makes them) that
// only one of them has, away from the grid's own edges: where a surface
// stops inside the grid, as the ice does at its front. Pairs of vertices.
export function openEdges(w, h, keep) {
  // how many kept triangles have each edge: along a row (k to k + 1), down
  // a column (k to k + w), and the diagonal of the cell whose top left is k
  const H = new Uint8Array(w * h), V = new Uint8Array(w * h), D = new Uint8Array(w * h);
  for (let j = 0; j < h - 1; j++)
    for (let i = 0; i < w - 1; i++) {
      const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
      if (keep(a, c, b)) { V[a]++; D[a]++; H[a]++; }
      if (keep(b, c, d)) { D[a]++; H[c]++; V[b]++; }
    }
  const out = [];
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (i < w - 1 && j > 0 && j < h - 1 && H[k] === 1) out.push(k, k + 1);
      if (j < h - 1 && i > 0 && i < w - 1 && V[k] === 1) out.push(k, k + w);
      if (i < w - 1 && j < h - 1 && D[k] === 1) out.push(k + 1, k + w);
    }
  return Uint32Array.from(out);
}

// The column at x, y (metres): heights bilinear between the four vertices
// round it, the kind of the nearest; null outside the grid (a hundredth of
// a cell past its edge still counts: a point on the block's side, come
// back from the screen, can be that far out) or where one of the four has
// no data.
export function columnSampler(cols, plan) {
  const { w, h, d, x0, y0 } = plan, { kind, top, base, bed } = cols;
  const inside = (t, n) => (t < 0 && t > -0.01 ? 0 : t > n && t < n + 0.01 ? n : t);
  return (x, y) => {
    const u = inside((x - x0) / d, w - 1), v = inside((y0 - y) / d, h - 1);
    if (!(u >= 0 && v >= 0 && u <= w - 1 && v <= h - 1)) return null;
    const i = Math.min(w - 2, Math.floor(u)), j = Math.min(h - 2, Math.floor(v)), fu = u - i, fv = v - j;
    const a = j * w + i, b = a + 1, c = a + w, e = c + 1;
    if (kind[a] < 0 || kind[b] < 0 || kind[c] < 0 || kind[e] < 0) return null;
    const mix = (A) => (A[a] * (1 - fu) + A[b] * fu) * (1 - fv) + (A[c] * (1 - fu) + A[e] * fu) * fv;
    const near = (fv < 0.5 ? (fu < 0.5 ? a : b) : fu < 0.5 ? c : e);
    return { kind: kind[near], top: mix(top), base: mix(base), bed: mix(bed) };
  };
}

// Bands of ice (top to base), water (base to bed) and rock (bed down to
// depth under it) between each point of a line and the next, as
// triangles: three arrays of x, y, z. Points are { x, y, top, base, bed },
// in any units, or null where there is nothing (the line breaks there); a
// band of no thickness at either end (ice over open sea, water under
// grounded ice) is left out.
export function layerStrip(pts, depth) {
  const out = { ice: [], water: [], rock: [] };
  const bands = [["ice", "top", "base"], ["water", "base", "bed"], ["rock", "bed", null]];
  for (let k = 1; k < pts.length; k++) {
    const p = pts[k - 1], q = pts[k];
    if (!p || !q) continue;
    for (const [name, u, l] of bands) {
      const pl = l ? p[l] : p.bed - depth, ql = l ? q[l] : q.bed - depth;
      if (p[u] - pl + (q[u] - ql) <= 0) continue;
      out[name].push(p.x, p.y, p[u], q.x, q.y, q[u], q.x, q.y, ql, p.x, p.y, p[u], q.x, q.y, ql, p.x, p.y, pl);
    }
  }
  return out;
}

// Where the line through px, py along tx, ty is inside the box { x0, x1,
// y0, y1 }: [t0, t1] (px + t tx, py + t ty), or null if it misses.
export function lineInBox(box, px, py, tx, ty) {
  let t0 = -Infinity, t1 = Infinity;
  for (const [p, t, lo, hi] of [[px, tx, box.x0, box.x1], [py, ty, box.y0, box.y1]]) {
    if (Math.abs(t) < 1e-12) { if (p < lo || p > hi) return null; continue; }
    const a = (lo - p) / t, b = (hi - p) / t;
    t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
  }
  return t0 <= t1 ? [t0, t1] : null;
}

// Where height z (metres) is in a column: above it, in the ice, in the
// water (under an ice shelf, the cavity; in the open sea or Lake Vostok),
// on the bed where there is no water over it, or in the rock; with how far
// it is below the top of what it is in and above the bottom (on the bed,
// below: the ice over it). Within tol metres of a top, a bed or the bottom
// of the water counts as there, so a place put on a surface reads as on it.
export function whereIn(col, z, tol = 1) {
  const { kind, top, base, bed } = col;
  if (z > top + tol) return { in: kind === 0 ? "above the sea" : kind === 1 ? "above the ground" : "above the ice", above: z - top };
  z = Math.min(z, top);
  const dry = base - bed <= tol;
  if (dry && Math.abs(z - bed) <= tol) return { in: "bed", below: top - bed };
  if (top - base > tol && z >= base) return { in: "ice", below: top - z, above: z - base };
  if (!dry && z >= bed - tol) return { in: kind === 0 ? "sea" : kind === 4 ? "lake" : "cavity", below: base - z, above: Math.max(0, z - bed) };
  return { in: "rock", below: bed - z };
}

// Where to look from, worked out from the columns: the middle of the
// floating ice (the mean of its cells), the way out to the open sea from
// there (towards the mean of the open sea's cells; away from the pole if
// there is none), and the mean height half way down its water.
// Also the shelf's area and its deepest and thickest.
export function shelfView(cols, plan) {
  const { w, h, d, x0, y0 } = plan, { kind, top, base, bed } = cols;
  let fx = 0, fy = 0, fn = 0, ox = 0, oy = 0, on = 0, mid = 0, thick = 0, water = 0, deep = Infinity;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i, x = x0 + i * d, y = y0 - j * d;
      if (kind[k] === 3) {
        fx += x; fy += y; fn++;
        mid += (base[k] + bed[k]) / 2;
        thick = Math.max(thick, top[k] - base[k]);
        water = Math.max(water, base[k] - bed[k]);
      } else if (kind[k] === 0) { ox += x; oy += y; on++; }
      if (kind[k] >= 0) deep = Math.min(deep, bed[k]);
    }
  if (!fn) return null;
  const at = [fx / fn, fy / fn];
  let sea = on ? [ox / on - at[0], oy / on - at[1]] : [at[0], at[1]];
  const len = Math.hypot(...sea) || 1;
  sea = [sea[0] / len, sea[1] / len];
  return { at, sea, mid: mid / fn, area: fn * d * d, thick, water, deep };
}
