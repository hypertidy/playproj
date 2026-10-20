// Chunk grids: how an array's index space is cut into chunks.
//
// A regular grid has one chunk size per axis; a rectilinear grid has a
// list of sizes per axis, so the cuts along an axis can fall anywhere, but
// every cut still runs the whole way across the array. Each axis here is a
// list of chunk edge lengths, and the grid is the cross product of the
// axes. The edges add up to at least the array's length: the last chunk
// may overhang the end (always, in a regular grid that does not divide the
// shape), and a chunk is stored at its edge length, so an overhang is
// stored as fill. Pure functions, no DOM.

// ---------------------------------------------------------------- axes

// A regular axis of length n cut every c: ceil(n / c) chunks of c, the
// last overhanging the end when c does not divide n. With trim, the last
// is cut back to what is left (a rectilinear axis can say that; a regular
// grid cannot).
export function regularAxis(n, c, { trim = false } = {}) {
  if (!(n >= 0) || !(c >= 1)) throw new Error(`bad regular axis ${n} / ${c}`);
  const out = [];
  for (let s = 0; s < n; s += c) out.push(trim ? Math.min(c, n - s) : c);
  return out;
}

// Run-length form as the rectilinear extension writes it: plain integers
// and [size, count] pairs, in order. Returns the list of sizes.
export function expandRuns(list) {
  if (!Array.isArray(list)) throw new Error("chunk sizes must be a list");
  const out = [];
  for (const v of list) {
    if (Array.isArray(v)) {
      const [s, k] = v;
      if (!(Number.isInteger(s) && s >= 1 && Number.isInteger(k) && k >= 1)) throw new Error(`bad run [${v}]`);
      for (let i = 0; i < k; i++) out.push(s);
    } else {
      if (!(Number.isInteger(v) && v >= 1)) throw new Error(`bad chunk size ${v}`);
      out.push(v);
    }
  }
  return out;
}

// The shortest run-length form: runs of one stay plain integers.
export function compressRuns(sizes) {
  const out = [];
  for (let i = 0; i < sizes.length;) {
    let j = i;
    while (j + 1 < sizes.length && sizes[j + 1] === sizes[i]) j++;
    out.push(j > i ? [sizes[i], j - i + 1] : sizes[i]);
    i = j + 1;
  }
  return out;
}

// Start of each chunk, and the end of the last: offsets[k] .. offsets[k+1].
export function offsets(sizes) {
  const o = [0];
  for (const s of sizes) o.push(o[o.length - 1] + s);
  return o;
}

// The chunk holding index i: a division on a regular axis, a binary search
// of the offsets on a rectilinear one (the first offset past i, less one).
export function locate(off, i) {
  if (i < 0 || i >= off[off.length - 1]) return -1;
  let lo = 0, hi = off.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (off[mid] <= i) lo = mid; else hi = mid - 1;
  }
  return lo;
}
export const locateRegular = (c, i) => Math.floor(i / c);

// The chunks a half-open selection [a, b) touches, as [first, last], or null.
// n is the array's length (defaults to the end of the last chunk).
export function span(off, a, b, n = off[off.length - 1]) {
  a = Math.max(0, a); b = Math.min(n, b);
  if (!(b > a)) return null;
  return [locate(off, a), locate(off, b - 1)];
}

// The regular chunk size of an axis of length n, or null: every edge c,
// and no more chunks than ceil(n / c).
export function regularSize(sizes, n) {
  if (!sizes.length) return null;
  const c = sizes[0];
  if (sizes.some((s) => s !== c)) return null;
  return n == null || sizes.length === Math.max(1, Math.ceil(n / c)) ? c : null;
}

// How much of chunk k of an axis of length n holds data (the rest overhangs).
export const filled = (off, k, n) => Math.max(0, Math.min(off[k + 1], n) - off[k]);

// ---------------------------------------------------------------- grids

// A grid: { shape, axes: [sizes per axis] }.
export function grid(shape, axes) {
  if (shape.length !== axes.length) throw new Error("one list of sizes per axis");
  axes.forEach((a, d) => {
    const t = a.reduce((x, y) => x + y, 0);
    if (t < shape[d]) throw new Error(`axis ${d}: chunk sizes add to ${t}, short of the shape ${shape[d]}`);
  });
  return { shape: shape.slice(), axes: axes.map((a) => a.slice()), off: axes.map(offsets) };
}
export const regularGrid = (shape, chunks) => grid(shape, shape.map((n, d) => regularAxis(n, chunks[d])));
export const isRegular = (g) => g.axes.every((a, d) => regularSize(a, g.shape[d]) !== null);
export const chunkCount = (g) => g.axes.reduce((p, a) => p * a.length, 1);

// The chunk_grid of zarr.json for a grid: regular when every axis is,
// otherwise rectilinear (zarr-extensions chunk-grids/rectilinear), each
// axis written as an integer when it is regular and as a list with runs
// otherwise.
export function chunkGridJson(g, { force } = {}) {
  if (isRegular(g) && force !== "rectilinear") {
    return { name: "regular", configuration: { chunk_shape: g.axes.map((a, d) => regularSize(a, g.shape[d])) } };
  }
  return {
    name: "rectilinear",
    configuration: {
      kind: "inline",
      chunk_shapes: g.axes.map((a, d) => regularSize(a, g.shape[d]) ?? compressRuns(a))
    }
  };
}

// Read a chunk_grid (or a whole zarr.json, or a v2 .zarray) against a shape.
// An integer inside a rectilinear grid is a regular axis, repeated until it
// reaches the shape; lists may overflow it by whole chunks.
export function parseChunkGrid(meta, shape) {
  if (meta && meta.shape && !shape) shape = meta.shape;
  if (!shape) throw new Error("no shape: give the zarr.json, or the shape with the chunk_grid");
  if (meta && meta.chunk_grid) meta = meta.chunk_grid;
  else if (meta && Array.isArray(meta.chunks)) return { kind: "regular (v2)", grid: regularGrid(shape, meta.chunks) };
  const name = meta && (meta.name || meta.type);
  const conf = (meta && meta.configuration) || {};
  if (name === "regular") return { kind: "regular", grid: regularGrid(shape, conf.chunk_shape) };
  if (name === "rectilinear") {
    const cs = conf.chunk_shapes;
    if (!Array.isArray(cs) || cs.length !== shape.length) throw new Error("chunk_shapes needs one entry per axis");
    const axes = cs.map((v, d) => (Number.isInteger(v) ? regularAxis(shape[d], v) : expandRuns(v)));
    return { kind: "rectilinear", grid: grid(shape, axes) };
  }
  throw new Error(`unknown chunk grid "${name}"`);
}

// The key of a chunk under the default v3 encoding ("c/0/1/2") or v2 ("0.1.2").
export function chunkKey(idx, { version = 3, separator } = {}) {
  if (version === 2) return idx.join(separator || ".");
  return ["c", ...idx].join(separator || "/");
}

// What a selection costs: per axis a half-open [a, b); returns the chunks
// touched, and the elements decoded (whole chunks at their edge lengths,
// overhang and all) and wanted.
export function readCost(g, sel) {
  let chunks = 1, read = 1, want = 1;
  const spans = [];
  for (let d = 0; d < g.axes.length; d++) {
    const [a, b] = sel[d] || [0, g.shape[d]];
    const s = span(g.off[d], a, b, g.shape[d]);
    if (!s) return { chunks: 0, read: 0, want: 0, spans: null };
    spans.push(s);
    let r = 0;
    for (let k = s[0]; k <= s[1]; k++) r += g.axes[d][k];
    chunks *= s[1] - s[0] + 1; read *= r; want *= Math.min(b, g.shape[d]) - Math.max(a, 0);
  }
  return { chunks, read, want, spans };
}

// ---------------------------------------------------------------- calendars

export const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const daysInMonth = (y, m) => (m === 1 && isLeap(y) ? 29 : MONTH[m]);
export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Days of each month from January y0 to December y1, with labels.
export function months(y0, y1) {
  const sizes = [], labels = [];
  for (let y = y0; y <= y1; y++) for (let m = 0; m < 12; m++) { sizes.push(daysInMonth(y, m)); labels.push(`${MONTH_NAMES[m]} ${y}`); }
  return { sizes, labels };
}
export function years(y0, y1) {
  const sizes = [], labels = [];
  for (let y = y0; y <= y1; y++) { sizes.push(isLeap(y) ? 366 : 365); labels.push(String(y)); }
  return { sizes, labels };
}
// Day index (from 1 January y0) of the first day of month m of year y.
export function dayOf(y0, y, m = 0, d = 1) {
  let n = 0;
  for (let yy = y0; yy < y; yy++) n += isLeap(yy) ? 366 : 365;
  for (let mm = 0; mm < m; mm++) n += daysInMonth(y, mm);
  return n + d - 1;
}

// ---------------------------------------------------------------- mosaics

// Rectangles in index space: { x0, x1, y0, y1 } half-open, from files or
// scenes of a mosaic. The rectilinear grid that can hold them is cut at
// every edge any of them has; a tile is a single chunk of it only when no
// other tile's edge runs through it.
export function mosaicGrid(rects) {
  const xs = [...new Set(rects.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r.y0, r.y1]))].sort((a, b) => a - b);
  const diff = (e) => e.slice(1).map((v, i) => v - e[i]);
  return { x0: xs[0], y0: ys[0], cols: diff(xs), rows: diff(ys), xs, ys };
}

// How each rectangle sits on the grid of all their edges: the cells it
// covers, and whether two rectangles claim the same cell (overlap).
export function mosaicReport(rects) {
  const m = mosaicGrid(rects);
  const nx = m.cols.length, ny = m.rows.length;
  const owners = Array.from({ length: nx * ny }, () => []);
  const per = rects.map((r, t) => {
    const i0 = m.xs.indexOf(r.x0), i1 = m.xs.indexOf(r.x1), j0 = m.ys.indexOf(r.y0), j1 = m.ys.indexOf(r.y1);
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) owners[j * nx + i].push(t);
    return { cells: (i1 - i0) * (j1 - j0), i0, i1, j0, j1 };
  });
  const overlapCells = owners.filter((o) => o.length > 1).length;
  const holes = owners.filter((o) => o.length === 0).length;
  const oneChunkEach = per.every((p) => p.cells === 1) && overlapCells === 0;
  return { grid: m, per, owners, overlapCells, holes, oneChunkEach };
}
