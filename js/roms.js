// playproj: a terrain-following ocean model grid, as ROMS builds one.
//
// The horizontal grid is curvilinear: a regular array of (i, j) whose
// vertices carry a longitude and latitude each. The vertical grid is the
// s-coordinate: N layers between the free surface and the sea floor at every
// column, spaced by a stretching function C(s) and a transform that mixes it
// with plain sigma above the critical depth hc. Every cell is (i, j, k) in
// index space, a regular cube, and a bent, squashed box in the ocean.
//
// Formulas: ROMS wiki "Vertical S-coordinate" (Vtransform 1 and 2,
// Vstretching 1, 2 and 4: Song and Haidvogel 1994, Shchepetkin 2005, 2010).

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// ---------------------------------------------------------------- vertical

// s at w points (layer interfaces, k = 0 at the floor to N at the surface)
// and at rho points (layer middles, k = 1 to N), both from -1 to 0.
export const sW = (k, N) => (k - N) / N;
export const sRho = (k, N) => (k - N - 0.5) / N;

// The stretching function C(s), from -1 at the floor to 0 at the surface.
export function stretch(s, { vs = 4, ts = 7, tb = 2 } = {}) {
  if (vs === 1) {
    if (ts <= 0) return s;
    return (1 - tb) * Math.sinh(ts * s) / Math.sinh(ts) +
      tb * (Math.tanh(ts * (s + 0.5)) / (2 * Math.tanh(0.5 * ts)) - 0.5);
  }
  if (vs === 2) {
    if (ts <= 0) return s;
    const csur = (1 - Math.cosh(ts * s)) / (Math.cosh(ts) - 1);
    if (tb <= 0) return csur;
    const cbot = -1 + Math.sinh(tb * (s + 1)) / Math.sinh(tb);
    const a = 1, b = 1, mu = Math.pow(s + 1, a) * (1 + (a / b) * (1 - Math.pow(s + 1, b)));
    return mu * csur + (1 - mu) * cbot;
  }
  // Vstretching 4
  const csur = ts > 0 ? (1 - Math.cosh(ts * s)) / (Math.cosh(ts) - 1) : -s * s;
  return tb > 0 ? (Math.exp(tb * csur) - 1) / (1 - Math.exp(-tb)) : csur;
}

// Depth z (metres, negative down) of s in a column of depth h under a free
// surface zeta.
export function depth(s, h, v, zeta = 0) {
  const C = stretch(s, v), hc = v.hc;
  if (v.vt === 1) {
    const z0 = hc * s + (h - hc) * C;
    return z0 + zeta * (1 + z0 / h);
  }
  const z0 = (hc * s + h * C) / (hc + h);
  return zeta + (zeta + h) * z0;
}

// ROMS ocean.in lines for these settings.
export function oceanIn(v, N) {
  const d = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x)) + "d0";
  return [`Vtransform == ${v.vt}`, `Vstretching == ${v.vs}`, `THETA_S == ${d(v.ts)}`, `THETA_B == ${d(v.tb)}`, `TCLINE == ${d(v.hc)}`, `N == ${N}`].join("\n");
}

// ---------------------------------------------------------------- sphere

export function toXYZ(lon, lat) {
  const l = lon * D2R, p = lat * D2R, c = Math.cos(p);
  return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)];
}

// point at angular distance c (radians) and azimuth az (radians, clockwise
// from north) from lon0, lat0
export function destination(lon0, lat0, c, az) {
  const p0 = lat0 * D2R, sp = Math.sin(p0), cp = Math.cos(p0);
  const lat = Math.asin(sp * Math.cos(c) + cp * Math.sin(c) * Math.cos(az));
  const lon = lon0 * D2R + Math.atan2(Math.sin(az) * Math.sin(c) * cp, Math.cos(c) - sp * Math.sin(lat));
  return [wrap(lon * R2D), lat * R2D];
}

// angular distance and azimuth from lon0, lat0 to lon, lat
export function inverseGC(lon0, lat0, lon, lat) {
  const p0 = lat0 * D2R, p = lat * D2R, dl = (lon - lon0) * D2R;
  const c = Math.acos(Math.max(-1, Math.min(1, Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(dl))));
  const az = Math.atan2(Math.sin(dl) * Math.cos(p), Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(dl));
  return [c, az];
}

const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
const mercLat = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * R2D;

// ---------------------------------------------------------------- horizontal

// A grid has ni x nj cells and (ni + 1) x (nj + 1) vertices, stored j-major.
// fromIndex(u, v) and toIndex(lon, lat) map between fractions of the array
// (0 to 1) and the sphere; toIndex is null when the grid has no inverse.
function materialize(g) {
  const W = g.ni + 1, n = W * (g.nj + 1);
  g.lon = new Float64Array(n); g.lat = new Float64Array(n);
  for (let j = 0; j <= g.nj; j++)
    for (let i = 0; i <= g.ni; i++) {
      const [lon, lat] = g.fromIndex(i / g.ni, j / g.nj);
      g.lon[j * W + i] = lon; g.lat[j * W + i] = lat;
    }
  return g;
}

// Circumpolar Southern Ocean: longitude all the way round (the array wraps,
// i = ni is i = 0) and Mercator-spaced latitude, so every cell is square.
export function southernOcean({ ni = 180, lat0 = -78, lat1 = -30, lon0 = 20 } = {}) {
  const y0 = mercY(lat0), y1 = mercY(lat1);
  const nj = Math.max(4, Math.round((ni * (y1 - y0)) / (2 * Math.PI)));
  return materialize({
    kind: "so", ni, nj, periodic: true, center: [0, -90],
    fromIndex: (u, v) => [wrap(lon0 + 360 * u), mercLat(y0 + (y1 - y0) * v)],
    toIndex: (lon, lat) => [((((lon - lon0) % 360) + 360) % 360) / 360, (mercY(lat) - y0) / (y1 - y0)],
    seam: 0.5,
    describe: `Longitude from ${lon0} round to ${lon0 + 360} (the array wraps), latitude ${-lat0}S to ${-lat1}S in Mercator steps: square cells that shrink towards Antarctica.`
  });
}

// A fan off a coast: a polar grid about a point inland, equally spaced in
// azimuth and in the log of the stereographic radius. Stereographic
// projection is conformal and so is the log-polar map, so the grid is
// orthogonal with square cells, smallest at the coast where the shelf needs
// them. ROMS users build grids like this with seagrid and gridgen.
export function fan({ ni = 60, lon0 = 150.4, lat0 = -33.2, bearing = 105, spread = 90, r0 = 0.9, r1 = 18 } = {}) {
  const q0 = Math.log(2 * Math.tan((r0 * D2R) / 2)), q1 = Math.log(2 * Math.tan((r1 * D2R) / 2));
  const a = spread * D2R, nj = Math.max(4, Math.round((ni * (q1 - q0)) / a));
  const b0 = bearing * D2R;
  const fromIndex = (u, v) => destination(lon0, lat0, 2 * Math.atan(Math.exp(q0 + (q1 - q0) * v) / 2), b0 + (u - 0.5) * a);
  return materialize({
    kind: "fan", ni, nj, periodic: false, center: fromIndex(0.5, 0.5), focus: [lon0, lat0],
    fromIndex,
    toIndex: (lon, lat) => {
      const [c, az] = inverseGC(lon0, lat0, lon, lat);
      if (c < 1e-9) return null;
      let d = az - b0;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      return [d / a + 0.5, (Math.log(2 * Math.tan(c / 2)) - q0) / (q1 - q0)];
    },
    seam: 0.5,
    describe: `Azimuths ${bearing - spread / 2} to ${bearing + spread / 2} degrees from ${lon0}E ${-lat0}S, radius ${r0} to ${r1} degrees of arc in log steps: square cells that grow away from the coast.`
  });
}

// A grid from arrays of vertex longitude and latitude (ni + 1 by nj + 1).
export function fromArrays({ ni, nj, lon, lat, label = "" }) {
  const W = ni + 1, m = (nj >> 1) * W + (ni >> 1);
  return { kind: "file", ni, nj, periodic: false, lon, lat, center: [lon[m], lat[m]], toIndex: null, describe: label };
}

// lon/lat at fractional vertex (i, j), bilinear on the unit sphere
export function lonlatAt(g, fi, fj) {
  const W = g.ni + 1;
  const i0 = Math.max(0, Math.min(g.ni - 1, Math.floor(fi))), j0 = Math.max(0, Math.min(g.nj - 1, Math.floor(fj)));
  const a = fi - i0, b = fj - j0;
  const p = [0, 0, 0];
  const add = (k, w) => { const x = toXYZ(g.lon[k], g.lat[k]); p[0] += w * x[0]; p[1] += w * x[1]; p[2] += w * x[2]; };
  add(j0 * W + i0, (1 - a) * (1 - b)); add(j0 * W + i0 + 1, a * (1 - b));
  add((j0 + 1) * W + i0, (1 - a) * b); add((j0 + 1) * W + i0 + 1, a * b);
  return [Math.atan2(p[1], p[0]) * R2D, Math.atan2(p[2], Math.hypot(p[0], p[1])) * R2D];
}

// great-circle distance in km between vertices
export function arcKm(g, k1, k2) {
  const [c] = inverseGC(g.lon[k1], g.lat[k1], g.lon[k2], g.lat[k2]);
  return c * 6371;
}

// ---------------------------------------------------------------- bathymetry

const smooth01 = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// A shelf, slope and abyss at a distance d (degrees) past the coast.
function profile(d) {
  if (d <= 0) return -200;                       // land
  return 60 + 90 * Math.min(1, d / 1.2) + 4300 * smooth01(1.1, 4.5, d);
}
const bump = (lon, lat, lon0, lat0, r, hgt) => {
  const [c] = inverseGC(lon0, lat0, lon, lat);
  return hgt * Math.exp(-(((c * R2D) / r) ** 2));
};

// Idealized sea floor (negative is below sea level), for when GEBCO is not
// loaded: a coast, shelf and slope, a ridge and a few seamounts.
export function idealElevation(g, lon, lat) {
  if (g.kind === "fan" || g.kind === "file") {
    const f = g.focus || g.center;
    const [c, az] = inverseGC(f[0], f[1], lon, lat);
    const coast = 1.6 + 0.4 * Math.sin(3 * az) + 0.25 * Math.sin(7 * az + 1);
    let h = profile(c * R2D - coast);
    if (h < 0) return 200;
    h -= bump(lon, lat, 156, -28, 0.8, 3600) + bump(lon, lat, 155.5, -32, 0.7, 3400) + bump(lon, lat, 159, -36, 1.2, 2500);
    h -= 1600 * smooth01(4, 1, Math.abs(lat + 36 + 0.6 * (lon - 160)));   // a rise
    return -Math.max(20, h);
  }
  // Southern Ocean: Antarctica with two embayments, the Drake Passage and a ridge
  const L = lon * D2R;
  const coast = -69 + 2 * Math.sin(3 * L + 0.5) - 8 * Math.exp(-(((wrap(lon + 175)) / 18) ** 2)) - 7 * Math.exp(-(((wrap(lon + 45)) / 16) ** 2));
  if (Math.abs(wrap(lon + 68)) < 5 && lat > -55) return 300;        // South America
  if (Math.abs(wrap(lon + 60)) < 4 && lat < -62 && lat > -64 - 6 * smooth01(-56, -64, lon)) return 300;   // the Peninsula
  let h = profile(lat - coast);
  if (h < 0) return 300;
  const ridge = -56 + 6 * Math.sin(L + 0.8) + 3 * Math.sin(2 * L);
  h -= 2400 * Math.exp(-(((lat - ridge) / 3) ** 2));
  h -= bump(lon, lat, 75, -52, 6, 3600);                             // a Kerguelen
  h -= bump(lon, lat, -30, -58, 3, 2500);                            // a Scotia arc
  return -Math.max(20, h);
}

// Bathymetry at every vertex: depth h (positive, at least hmin) and mask
// (1 sea, 0 land). elev(lon, lat) gives elevation, negative below sea level.
export function bathymetry(g, elev, hmin = 10) {
  const n = (g.ni + 1) * (g.nj + 1), h = new Float64Array(n), mask = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const z = elev(g.lon[k], g.lat[k]);
    mask[k] = z < 0 ? 1 : 0;
    h[k] = Math.max(hmin, -z);
  }
  if (g.periodic) for (let j = 0, W = g.ni + 1; j <= g.nj; j++) { h[j * W + g.ni] = h[j * W]; mask[j * W + g.ni] = mask[j * W]; }
  return { h, mask };
}

// Neighbour pairs of wet vertices, along i and along j.
function* pairs(g, mask) {
  const W = g.ni + 1;
  for (let j = 0; j <= g.nj; j++)
    for (let i = 0; i <= g.ni; i++) {
      const k = j * W + i;
      if (!mask[k]) continue;
      if (i < g.ni && mask[k + 1]) yield [k, k + 1];
      if (j < g.nj && mask[k + W]) yield [k, k + W];
    }
}

// Beckmann and Haidvogel's slope factor rx0 = |h1 - h2| / (h1 + h2), max.
export function rx0(g, h, mask) {
  let m = 0;
  for (const [a, b] of pairs(g, mask)) m = Math.max(m, Math.abs(h[a] - h[b]) / (h[a] + h[b]));
  return m;
}

// Haney's hydrostatic inconsistency number rx1, max over layers and pairs.
export function rx1(g, h, mask, v, N) {
  let m = 0;
  const za = new Float64Array(N + 1), zb = new Float64Array(N + 1);
  for (const [a, b] of pairs(g, mask)) {
    for (let k = 0; k <= N; k++) { za[k] = depth(sW(k, N), h[a], v); zb[k] = depth(sW(k, N), h[b], v); }
    for (let k = 1; k <= N; k++) {
      const den = Math.abs(za[k] + zb[k] - za[k - 1] - zb[k - 1]);
      if (den > 0) m = Math.max(m, Math.abs(za[k] - zb[k] + za[k - 1] - zb[k - 1]) / den);
    }
  }
  return m;
}

// Smooth to rx0 <= r by deepening the shallow side of each steep pair, the
// minimal positive method of Sikiric et al. (2009).
export function smoothRx0(g, h, mask, r = 0.2, passes = 400) {
  const out = Float64Array.from(h), f = (1 - r) / (1 + r);
  for (let p = 0; p < passes; p++) {
    let changed = false;
    for (const [a, b] of pairs(g, mask)) {
      if (out[b] < out[a] * f - 1e-9) { out[b] = out[a] * f; changed = true; }
      else if (out[a] < out[b] * f - 1e-9) { out[a] = out[b] * f; changed = true; }
    }
    if (g.periodic) for (let j = 0, W = g.ni + 1; j <= g.nj; j++) {
      const m = Math.max(out[j * W], out[j * W + g.ni]);
      out[j * W] = out[j * W + g.ni] = m;
    }
    if (!changed) break;
  }
  return out;
}

// ---------------------------------------------------------------- data

// A synthetic temperature (degrees C) in four dimensions: warm at low
// latitudes and cold below the thermocline, a mixed layer that deepens in
// winter, and eddies that drift west along the array. day is 0 to 365.
export function temperature(lon, lat, z, day, u, v) {
  const season = Math.cos((2 * Math.PI * (day - 45)) / 365) * (lat < 0 ? 1 : -1);   // 1 at the height of summer
  const tsurf = -1.2 + 28.5 * Math.exp(-((lat / 42) ** 2)) + 2.2 * season * Math.exp(-(((Math.abs(lat) - 45) / 20) ** 2));
  const mld = 40 + 160 * (1 - season) / 2 * Math.exp(-(((Math.abs(lat) - 55) / 15) ** 2)) + 20;
  const tdeep = 0.6 + 1.6 * Math.exp(z / 2500);
  const zz = Math.min(0, z + mld);
  let t = tdeep + (tsurf - tdeep) * Math.exp(zz / 450);
  for (const e of EDDIES) {
    const eu = (((e.u - (e.w * day) / 365) % 1) + 1) % 1;
    let du = u - eu; du -= Math.round(du);
    const dv = v - e.v - 0.04 * Math.sin(2 * Math.PI * (day / 365 + e.u));
    const r2 = (du / e.ru) ** 2 + (dv / e.rv) ** 2;
    if (r2 < 9) t += e.a * Math.exp(-r2) * Math.exp(z / 700);
  }
  return t;
}
const EDDIES = [
  { u: 0.12, v: 0.55, a: 2.6, w: 0.35, ru: 0.035, rv: 0.06 }, { u: 0.33, v: 0.4, a: -2.2, w: 0.3, ru: 0.03, rv: 0.05 },
  { u: 0.52, v: 0.7, a: 2.0, w: 0.25, ru: 0.04, rv: 0.07 }, { u: 0.7, v: 0.3, a: -2.4, w: 0.4, ru: 0.03, rv: 0.06 },
  { u: 0.86, v: 0.5, a: 2.8, w: 0.33, ru: 0.035, rv: 0.05 }, { u: 0.45, v: 0.2, a: 1.8, w: 0.28, ru: 0.025, rv: 0.045 }
];

// ---------------------------------------------------------------- Zarr

// Read a ROMS grid from a Zarr store (v2 or v3): lon_rho, lat_rho, h and,
// when present, mask_rho, and the vertical settings from scalar variables or
// attributes. Chunks may be uncompressed, zlib or gzip (the codecs a browser
// can decode on its own). get(path) returns an ArrayBuffer or null.
export async function readRomsZarr(get, { maxCells = 240 } = {}) {
  const json = async (p) => { const b = await get(p); return b ? JSON.parse(new TextDecoder().decode(b)) : null; };
  const root = (await json("zarr.json")) || null;
  const v3 = !!root;
  const rootAttrs = v3 ? root.attributes || {} : (await json(".zattrs")) || {};

  async function meta(name) {
    if (v3) {
      const j = await json(`${name}/zarr.json`);
      if (!j) return null;
      const enc = j.chunk_key_encoding || { name: "default" };
      const sep = (enc.configuration && enc.configuration.separator) || (enc.name === "v2" ? "." : "/");
      return { shape: j.shape, chunks: j.chunk_grid.configuration.chunk_shape, dtype: j.data_type, fill: j.fill_value,
        codecs: j.codecs || [], key: (idx) => (enc.name === "v2" ? (idx.length ? idx.join(sep) : "0") : ["c", ...idx].join(sep)), attrs: j.attributes || {} };
    }
    const j = await json(`${name}/.zarray`);
    if (!j) return null;
    if (j.filters && j.filters.length) throw new Error(`${name}: Zarr filters are not supported`);
    if (j.order && j.order !== "C") throw new Error(`${name}: only C order is supported`);
    const sep = j.dimension_separator || ".";
    return { shape: j.shape, chunks: j.chunks, dtype: j.dtype, fill: j.fill_value, compressor: j.compressor,
      key: (idx) => (idx.length ? idx.join(sep) : "0"), attrs: (await json(`${name}/.zattrs`)) || {} };
  }

  async function read(name) {
    const m = await meta(name);
    if (!m) return null;
    const n = m.shape.reduce((s, x) => s * x, 1), out = new Float64Array(n).fill(m.fill === null || m.fill === undefined ? NaN : Number(m.fill));
    const nc = m.shape.map((s, d) => Math.ceil(s / m.chunks[d]));
    const total = nc.reduce((s, x) => s * x, 1);
    for (let c = 0; c < total; c++) {
      const idx = [];
      for (let d = nc.length - 1, r = c; d >= 0; d--) { idx.unshift(r % nc[d]); r = Math.floor(r / nc[d]); }
      const raw = await get(`${name}/${m.key(idx)}`);
      if (!raw) continue;
      const vals = await decode(m, raw, name);
      // copy the chunk (full chunk shape, C order) into the array
      const cs = m.chunks, D = cs.length;
      const cn = cs.reduce((s, x) => s * x, 1);
      for (let q = 0; q < cn; q++) {
        let o = 0, ok = true, r = q;
        const pos = new Array(D);
        for (let d = D - 1; d >= 0; d--) { pos[d] = r % cs[d]; r = Math.floor(r / cs[d]); }
        for (let d = 0; d < D; d++) {
          const g = idx[d] * cs[d] + pos[d];
          if (g >= m.shape[d]) { ok = false; break; }
          o = o * m.shape[d] + g;
        }
        if (ok) out[o] = vals[q];
      }
    }
    return { shape: m.shape, data: out, attrs: m.attrs };
  }

  const scalar = async (names) => {
    for (const nm of names) {
      if (rootAttrs[nm] !== undefined) return Number(Array.isArray(rootAttrs[nm]) ? rootAttrs[nm][0] : rootAttrs[nm]);
      const a = await read(nm).catch(() => null);
      if (a && a.data.length) return a.data[0];
    }
    return undefined;
  };

  const lon = await read("lon_rho"), lat = await read("lat_rho"), h = await read("h");
  if (!lon || !lat || !h) throw new Error("this store needs lon_rho, lat_rho and h");
  if (lon.shape.length !== 2) throw new Error("lon_rho should be two-dimensional (eta_rho, xi_rho)");
  const mask = await read("mask_rho").catch(() => null);
  const [ny, nx] = lon.shape;
  const step = Math.max(1, Math.ceil(Math.max(nx, ny) / (maxCells + 1)));
  const ii = [], jj = [];
  for (let i = 0; i < nx; i += step) ii.push(i);
  if (ii[ii.length - 1] !== nx - 1) ii.push(nx - 1);
  for (let j = 0; j < ny; j += step) jj.push(j);
  if (jj[jj.length - 1] !== ny - 1) jj.push(ny - 1);
  const W = ii.length, n = W * jj.length;
  const g = { lon: new Float64Array(n), lat: new Float64Array(n), h: new Float64Array(n), mask: new Uint8Array(n) };
  jj.forEach((j, b) => ii.forEach((i, a) => {
    const s = j * nx + i, k = b * W + a;
    g.lon[k] = wrap(lon.data[s]); g.lat[k] = lat.data[s];
    g.h[k] = isFinite(h.data[s]) ? h.data[s] : 0;
    g.mask[k] = mask ? (mask.data[s] > 0.5 ? 1 : 0) : 1;
  }));
  const sr = await meta("s_rho").catch(() => null);
  const vt = { vt: await scalar(["Vtransform"]), vs: await scalar(["Vstretching"]), ts: await scalar(["theta_s", "THETA_S"]), tb: await scalar(["theta_b", "THETA_B"]), hc: await scalar(["hc", "Tcline", "TCLINE"]), N: sr ? sr.shape[0] : await scalar(["N"]) };
  for (const k of Object.keys(vt)) if (vt[k] === undefined || !isFinite(vt[k])) delete vt[k];
  return { ni: W - 1, nj: jj.length - 1, ...g, vertical: vt, size: [nx, ny], step, version: v3 ? 3 : 2 };
}

const DTYPES = {
  "<f8": [Float64Array, 8], "<f4": [Float32Array, 4], "<i4": [Int32Array, 4], "<i2": [Int16Array, 2], "|i1": [Int8Array, 1],
  "|u1": [Uint8Array, 1], "<u1": [Uint8Array, 1], "|b1": [Uint8Array, 1], "<u2": [Uint16Array, 2], "<u4": [Uint32Array, 4], "<i8": [BigInt64Array, 8],
  float64: [Float64Array, 8], float32: [Float32Array, 4], int32: [Int32Array, 4], int16: [Int16Array, 2], int8: [Int8Array, 1],
  uint8: [Uint8Array, 1], bool: [Uint8Array, 1], uint16: [Uint16Array, 2], uint32: [Uint32Array, 4], int64: [BigInt64Array, 8]
};

async function inflate(buf, kind) {
  const ds = new DecompressionStream(kind);
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decode(m, raw, name) {
  let bytes = new Uint8Array(raw);
  let little = true;
  if (m.codecs) {
    // v3: array -> bytes codec, then bytes -> bytes codecs, applied in reverse
    for (const c of m.codecs) {
      if (c.name === "bytes") little = !c.configuration || c.configuration.endian !== "big";
      else if (c.name !== "gzip" && c.name !== "zlib") throw new Error(`${name}: the ${c.name} codec is not supported here (uncompressed, zlib and gzip are)`);
    }
    for (const c of m.codecs.slice().reverse()) {
      if (c.name === "gzip") bytes = await inflate(bytes, "gzip");
      else if (c.name === "zlib") bytes = await inflate(bytes, "deflate");
    }
  } else {
    const c = m.compressor;
    if (c && c.id === "zlib") bytes = await inflate(bytes, "deflate");
    else if (c && c.id === "gzip") bytes = await inflate(bytes, "gzip");
    else if (c) throw new Error(`${name}: the ${c.id} compressor is not supported here (uncompressed, zlib and gzip are)`);
    if (/^>/.test(m.dtype)) little = false;
  }
  const dt = DTYPES[m.dtype] || DTYPES[m.dtype.replace(/^>/, "<")];
  if (!dt) throw new Error(`${name}: data type ${m.dtype} is not supported`);
  const [T, size] = dt;
  if (!little && size > 1) {
    for (let k = 0; k < bytes.length; k += size) bytes.subarray(k, k + size).reverse();
  }
  const copy = bytes.slice().buffer;
  const arr = new T(copy, 0, Math.floor(copy.byteLength / size));
  return T === BigInt64Array ? Array.from(arr, Number) : arr;
}
