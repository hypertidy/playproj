// Time and depth as axes shared by every layer (the 4D page).
//
// A dataset is described by its flat/arrays.json ("mdim-refs/0.2", as
// raad.virtualize writes it): each array's dims with their roles (TEMPORAL,
// VERTICAL, HORIZONTAL_X, HORIZONTAL_Y), coordinates as an affine start and
// step or inline values, the codec, and scale, offset and fill. From that a
// page can set up its axes without reading the store's own metadata. This
// module turns the description into axes, maps a date to each layer's own
// time step, finds the index window a lon/lat box needs, and keeps a byte
// budgeted cache. It also makes a synthetic ocean on the same axes, so the
// depth views can be shown and tested with no network.

const DAY = 86400000;
const UNIT_MS = { seconds: 1000, second: 1000, minutes: 60000, minute: 60000, hours: 3600000, hour: 3600000, days: DAY, day: DAY };

// CF time units ("days since 1979-01-01 00:00:00") as { step, epoch } in
// milliseconds, so a value v is the date epoch + v * step. Only the
// proleptic Gregorian calendar (and "standard", "gregorian") is handled.
export function timeUnits(units) {
  const m = /^\s*(\w+)\s+since\s+(\d{1,4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d*)?))?)?\s*(?:Z|UTC|[+-]00:?00)?\s*$/i.exec(units || "");
  if (!m || !UNIT_MS[m[1].toLowerCase()]) throw new Error(`time units not understood: ${units}`);
  const [, u, y, mo, d, hh = 0, mi = 0, ss = 0] = m;
  return { step: UNIT_MS[u.toLowerCase()], epoch: Date.UTC(+y, +mo - 1, +d, +hh, +mi, 0) + +ss * 1000 };
}

// An arrays.json coordinate entry as a Float64Array of its values.
export function coordValues(a) {
  const n = a.shape[0];
  if (a.affine) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = a.affine.start + i * a.affine.step;
    return out;
  }
  if (Array.isArray(a.values)) return Float64Array.from(a.values);
  throw new Error(`coordinate ${a.array} has neither affine nor inline values`);
}

const num = (v) => (v === null || v === undefined || v === "" ? null : +v);

// The description of one data array: its dims in order with a role each
// ("t", "z", "y", "x" or "other"), shape and chunks, the coordinate values
// of each role, the time axis as dates (ms), the vertical axis in metres
// (positive down when the store says DOWN), and the unpacking.
export function describe(meta, varname) {
  const arrays = meta.arrays || [];
  const a = arrays.find((x) => x.array === varname && x.kind === "data");
  if (!a) throw new Error(`no data array ${varname}; there are ${arrays.filter((x) => x.kind === "data").map((x) => x.array).join(", ")}`);
  const dimMeta = meta.dimensions || {};
  const ROLE = { TEMPORAL: "t", VERTICAL: "z", HORIZONTAL_X: "x", HORIZONTAL_Y: "y" };
  const roles = a.dims.map((d) => ROLE[(dimMeta[d] || {}).type] || guessRole(d));
  const coord = (d) => arrays.find((x) => x.array === d && x.kind === "coord");
  const out = {
    name: a.array, dims: a.dims.slice(), roles, shape: a.shape.slice(), chunks: a.chunks.slice(), dtype: a.dtype,
    units: (a.attrs || {}).units || "", longName: (a.attrs || {}).long_name || a.array,
    scale: num((a.attrs || {}).scale_factor) ?? 1, offset: num((a.attrs || {}).add_offset) ?? 0,
    fill: num(a.fill ?? (a.attrs || {})._FillValue),
    axes: {}
  };
  a.dims.forEach((d, i) => {
    const r = roles[i], c = coord(d);
    if (r === "other" || !c) return;
    const values = coordValues(c);
    const ax = { dim: d, index: i, n: a.shape[i], chunk: a.chunks[i], values, units: (c.attrs || {}).units || "", affine: c.affine || null };
    if (r === "t") {
      const tu = timeUnits(ax.units);
      ax.dates = Float64Array.from(values, (v) => tu.epoch + v * tu.step);
    }
    if (r === "z") ax.down = ((dimMeta[d] || {}).direction || "").toUpperCase() !== "UP";
    out.axes[r] = ax;
  });
  return out;
}

function guessRole(d) {
  const s = d.toLowerCase();
  if (/^(time|t)$/.test(s)) return "t";
  if (/(depth|lev|^z|st_ocean|sw_ocean)/.test(s)) return "z";
  if (/^(lat|latitude|y|yt_ocean|yu_ocean)$/.test(s)) return "y";
  if (/^(lon|longitude|x|xt_ocean|xu_ocean)$/.test(s)) return "x";
  return "other";
}

// The index of the value in sorted (ascending) nearest to v, and whether v
// lies outside the axis by more than half a step at that end.
export function nearestIndex(sorted, v) {
  const n = sorted.length;
  if (!n) return { index: -1, outside: true };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid; else hi = mid;
  }
  const index = Math.abs(sorted[hi] - v) < Math.abs(sorted[lo] - v) ? hi : lo;
  const half = n > 1 ? Math.abs(sorted[Math.min(n - 1, 1)] - sorted[0]) / 2 : 0;
  const halfEnd = n > 1 ? Math.abs(sorted[n - 1] - sorted[n - 2]) / 2 : 0;
  const outside = v < sorted[0] - half || v > sorted[n - 1] + halfEnd;
  return { index, outside };
}

// The time index of a layer for a date in ms, with its own date and how far
// that is from the date asked for (days).
export function timeAt(desc, ms) {
  const ax = desc.axes.t;
  if (!ax) return { index: null, date: null, offsetDays: 0, outside: false };
  const { index, outside } = nearestIndex(ax.dates, ms);
  return { index, date: ax.dates[index], offsetDays: (ax.dates[index] - ms) / DAY, outside };
}

// The half-open index window [i0, i1) of an axis whose cell centres fall in
// [lo, hi]. Handles ascending or descending values; for a longitude axis
// lo and hi are taken modulo 360 to the axis's own range (a box that
// crosses the axis's seam is cut at the seam).
export function windowOf(ax, lo, hi, { lon = false } = {}) {
  const v = ax.values, n = v.length;
  if (lon) {
    const base = Math.min(v[0], v[n - 1]);
    const wrap = (x) => ((((x - base) % 360) + 360) % 360) + base;
    let a = wrap(lo), b = wrap(hi);
    if (hi - lo >= 360) { a = base; b = base + 360; } else if (b < a) b = base + 360;
    lo = a; hi = b;
  }
  let i0 = n, i1 = -1;
  for (let i = 0; i < n; i++) if (v[i] >= lo && v[i] <= hi) { if (i < i0) i0 = i; i1 = i; }
  return i1 < 0 ? null : [i0, i1 + 1];
}

// The chunks along one axis that a window [i0, i1) touches, as [c0, c1).
export const chunkSpan = ([i0, i1], chunk) => [Math.floor(i0 / chunk), Math.ceil(i1 / chunk)];

// Bytes of one chunk before compression, and an estimate after (the ratio
// is a rough guide for the prefetch budget, not a promise).
export const BYTES = { "<i2": 2, "|u1": 1, "<u2": 2, "<f4": 4, "<f8": 8, "<i4": 4, int16: 2, uint8: 1, float32: 4, float64: 8 };
export function chunkBytes(desc) {
  return desc.chunks.reduce((p, c) => p * c, 1) * (BYTES[desc.dtype] || 4);
}

// Raw stored values to physical values: Float32Array with NaN for the fill
// and anything outside the valid range given (in physical units).
export function unpack(raw, desc, { valid = null } = {}) {
  const out = new Float32Array(raw.length);
  const f = desc.fill, s = desc.scale, o = desc.offset;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if ((f !== null && r === f) || r !== r) { out[i] = NaN; continue; }
    const v = r * s + o;
    out[i] = valid && (v < valid[0] || v > valid[1]) ? NaN : v;
  }
  return out;
}

// A least recently used cache with a byte budget. size(v) gives a value's
// bytes; set() evicts the oldest entries until the total fits.
export class ByteLRU {
  constructor(budget, size = (v) => (v && v.byteLength) || 0) { this.budget = budget; this.size = size; this.map = new Map(); this.bytes = 0; }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k); this.map.set(k, v);
    return v;
  }
  has(k) { return this.map.has(k); }
  set(k, v) {
    if (this.map.has(k)) { this.bytes -= this.size(this.map.get(k)); this.map.delete(k); }
    this.map.set(k, v); this.bytes += this.size(v);
    for (const [ok, ov] of this.map) {
      if (this.bytes <= this.budget || ok === k) break;
      this.map.delete(ok); this.bytes -= this.size(ov);
    }
    return this;
  }
}

// A date k months on from ms, keeping its day of the month where the month
// has it and taking the last day where it does not (31 January to 29 February).
function addMonths(ms, k) {
  const d = new Date(ms), y = d.getUTCFullYear(), m = d.getUTCMonth() + k;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours());
}

// The dates a clock steps through from start to end (ms), every step of
// "day", "5day", "month" or "year"; month and year steps keep the day of
// the month where they can.
export function clockSteps(start, end, step = "day") {
  const out = [];
  if (step === "day" || step === "5day") {
    const d = step === "day" ? DAY : 5 * DAY;
    for (let t = start; t <= end; t += d) out.push(t);
    return out;
  }
  const months = step === "year" ? 12 : 1;
  for (let k = 0; ; k++) {
    const t = addMonths(start, k * months);
    if (t > end) break;
    out.push(t);
  }
  return out;
}

export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

// The next step after ms (or before, with dir -1) in a clock of the given step.
export function stepFrom(ms, step, dir = 1) {
  if (step === "day") return ms + dir * DAY;
  if (step === "5day") return ms + dir * 5 * DAY;
  return addMonths(ms, dir * (step === "year" ? 12 : 1));
}

// The radius of a depth (m, positive down) on a sphere of radius 1 standing
// for the Earth (R m), with the depth multiplied by exag.
export const EARTH_R = 6371000;
export const depthRadius = (depth, exag, R = EARTH_R) => 1 - (depth * exag) / R;

// A registry entry's URLs: the store and its arrays.json under base, which
// is the one place the index's home is named.
export function storeUrls(base, entry) {
  const root = (entry.base || base).replace(/\/+$/, "") + "/" + entry.path.replace(/^\/+|\/+$/g, "");
  return { root, icechunk: root + "/icechunk", arrays: root + "/flat/arrays.json" };
}

// A storage path from the refs (or a source list) as a public URL, by the
// first "public" rule of the description's remap table that matches.
export function publicUrl(meta, path) {
  for (const r of meta.remap || []) if (r.target === "public" && path.startsWith(r.prefix)) path = r.replacement + path.slice(r.prefix.length);
  return path;
}

// ---------------------------------------------------------------- synthetic

// A synthetic ocean on BRAN-like axes over a lon/lat box: potential
// temperature that cools to the south and with depth, with a seasonal mixed
// layer and eddies that drift west. It has the same description shape as
// a real dataset, and read(t, k, y0, y1, x0, x1) returns a Float32Array of
// rows y0..y1-1 and columns x0..x1-1, so the page draws it the same way.
export const BRAN_DEPTHS = [2.5, 7.5, 12.5, 17.52, 22.67, 28.17, 34.22, 40.95, 48.45, 56.72, 65.67, 75.17, 85.02, 95, 105, 115, 125, 135, 145, 155, 165, 175, 185, 195, 205.19, 217.05, 233.19, 255.88, 286.61, 325.88, 373.19, 427.05, 485.19, 545.51, 610.42, 685.93, 775.93, 880.42, 995.51, 1115.31, 1238.35, 1368.16, 1507.73, 1658.16, 1818.35, 1985.31, 2165.18, 2431.1, 2894.84, 3603.1, 4509.18];

export function syntheticOcean({ start = Date.UTC(2024, 0, 1), days = 1096, dx = 0.25 } = {}) {
  const nx = Math.round(360 / dx), ny = Math.round(150 / dx);
  const x = Float64Array.from({ length: nx }, (_, i) => dx / 2 + i * dx);
  const y = Float64Array.from({ length: ny }, (_, j) => -75 + dx / 2 + j * dx);
  const dates = Float64Array.from({ length: days }, (_, i) => start + i * DAY + DAY / 2);
  const z = Float64Array.from(BRAN_DEPTHS);
  const desc = {
    name: "temp", dims: ["Time", "st_ocean", "yt_ocean", "xt_ocean"], roles: ["t", "z", "y", "x"],
    shape: [days, z.length, ny, nx], chunks: [1, 1, 60, 60], dtype: "<f4", units: "degrees C",
    longName: "Synthetic potential temperature", scale: 1, offset: 0, fill: null, synthetic: true,
    axes: {
      t: { dim: "Time", index: 0, n: days, chunk: 1, values: Float64Array.from(dates, (d) => (d - start) / DAY), dates },
      z: { dim: "st_ocean", index: 1, n: z.length, chunk: 1, values: z, down: true, units: "meters" },
      y: { dim: "yt_ocean", index: 2, n: ny, chunk: 60, values: y, units: "degrees_N" },
      x: { dim: "xt_ocean", index: 3, n: nx, chunk: 60, values: x, units: "degrees_E" }
    }
  };
  const read = (t, k, y0, y1, x0, x1) => {
    const w = x1 - x0, out = new Float32Array((y1 - y0) * w);
    const day = t, season = Math.cos((2 * Math.PI * (day - 30)) / 365.25);
    const d = z[k], mld = 60 + 90 * (1 - season) / 2;
    for (let j = y0; j < y1; j++) {
      const lat = y[j];
      const surf = 1.5 + 26 * Math.cos((lat * Math.PI) / 180) ** 2 - 2.0 + 1.6 * season * (lat < 0 ? 1 : -1);
      for (let i = x0; i < x1; i++) {
        const lon = x[i];
        const eddy = 1.4 * Math.sin(((lon + 0.08 * day) * Math.PI) / 9) * Math.cos((lat * Math.PI) / 7 + day / 40) * Math.exp(-d / 600);
        const deep = 0.6 + 1.2 * Math.cos((lat * Math.PI) / 180);
        const mix = d <= mld ? 1 : Math.exp(-(d - mld) / 450);
        out[(j - y0) * w + (i - x0)] = deep + (surf - deep) * mix + eddy;
      }
    }
    return out;
  };
  return { desc, read };
}
