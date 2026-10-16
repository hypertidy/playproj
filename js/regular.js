// Regular in what? Recover the CRS a grid is regular in from its lon/lat.
//
// Many datasets ship a 2D longitude array and a 2D latitude array, one value
// per cell, when the grid is a plain rectangle of equal cells in some map
// projection. This module takes samples of those arrays (column i, row j,
// lon, lat) and asks each candidate projection whether it makes them
// regular: project every sample, fit x and y as linear functions of i and j
// (an affine transform), and measure what the fit misses, in cells.
//
// The affine fit absorbs an offset, a scale, a rotation and a shear, so a
// candidate only has to get right the parameters that bend the grid. Polar
// stereographic has none (lat_ts is a scale, lon_0 a rotation), Lambert
// conformal conic has one (the cone constant; lon_0 and lat_0 move and turn
// the map), geostationary has the sub-satellite longitude and the height,
// a rotated pole has the pole. Those few numbers are searched with
// Nelder-Mead. The size of a sphere is a scale too, so every sphere is the
// same candidate, and so is every ellipsoid with WGS84's flattening; the
// cell size then says which radius makes the numbers round (snapRadius).
//
// Angles are in degrees unless named otherwise.

import { obTran, cfToObTran, tripolar } from "./grids.js";

const D2R = Math.PI / 180;
let proj4 = null;
export function init(p) { proj4 = p; }

const wrap180 = (x) => ((((x + 180) % 360) + 360) % 360) - 180;

// proj4js needs explicit zeros that PROJ defaults
function full(def) {
  let s = def.trim();
  for (const k of ["lon_0", "lat_0", "x_0", "y_0"]) if (!new RegExp(`\\+${k}=`).test(s)) s += ` +${k}=0`;
  if (/\+proj=cea\b/.test(s) && !/\+lat_ts=/.test(s)) s += " +lat_ts=0";
  return s;
}

// lon/lat -> x/y and back for a PROJ string, or for {rotated: [plon, plat]}
// (CF grid_north_pole_longitude, latitude) and {longlat: true}
export function crsFunctions(crs) {
  if (typeof crs === "object" && crs.rotated) {
    const ob = obTran(cfToObTran(crs.rotated[0], crs.rotated[1]));
    return { fwd: (lon, lat) => ob.forward(lon, lat), inv: (x, y) => ob.inverse(x, y), angular: true, period: 360 };
  }
  if (typeof crs === "object" && crs.longlat) return { fwd: (lon, lat) => [lon, lat], inv: (x, y) => [x, y], angular: true, period: 360 };
  const def = full(crs);
  const P = proj4.Proj(def);
  const b = P.b ?? P.a * Math.sqrt(1 - P.es);
  const tr = proj4(`+proj=longlat +a=${P.a} +b=${b} +no_defs`, def);
  return {
    fwd(lon, lat) {
      let q;
      try { q = tr.forward([lon, lat]); } catch (e) { return null; }
      return q && Number.isFinite(q[0]) && Number.isFinite(q[1]) ? q : null;
    },
    inv(x, y) {
      let q;
      try { q = tr.inverse([x, y]); } catch (e) { return null; }
      return q && Number.isFinite(q[0]) && Number.isFinite(q[1]) && Math.abs(q[1]) <= 90 ? q : null;
    },
    angular: false,
    // cylindrical x repeats every turn of the equator
    period: /\+proj=(merc|cea|eqc)\b/.test(def) ? 2 * Math.PI * P.a * (P.k0 || 1) : 0
  };
}

// ---------------------------------------------------------------- samples

// Samples are { i, j, lon, lat } arrays of equal length, plus ni and nj when
// known. i is the column, j the row, both counted from 0 at cell centres.
function emptySamples() { return { i: [], j: [], lon: [], lat: [] }; }
function push(s, i, j, lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) return;
  s.i.push(i); s.j.push(j); s.lon.push(lon); s.lat.push(lat);
}

// the indices 0, step, 2 step, ... and always the last
function strided(n, count) {
  const step = Math.max(1, Math.floor((n - 1) / Math.max(1, count - 1)));
  const out = [];
  for (let k = 0; k < n; k += step) out.push(k);
  if (out[out.length - 1] !== n - 1) out.push(n - 1);
  return out;
}

// Samples of a dataset's lon/lat arrays: about count x count of them, as
// float32, the way they ship.
export function sampleExample(ex, count = 41) {
  const s = emptySamples();
  s.ni = ex.ni; s.nj = ex.nj;
  const f = Math.fround;
  for (const j of strided(ex.nj, count))
    for (const i of strided(ex.ni, count)) {
      const ll = ex.lonlat(i, j);
      if (ll) push(s, i, j, f(ll[0]), f(ll[1]));
    }
  return s;
}

// Parse pasted text. Accepts JSON {"lon": [[...]], "lat": [[...]]} (rows of
// columns), or a table of numbers: four columns are i j lon lat; two columns
// are lon lat in row order, with `ncol` columns to a row.
export function parseSamples(text, ncol = 0) {
  const t = text.trim();
  if (!t) throw new Error("nothing to read");
  const s = emptySamples();
  if (t[0] === "{") {
    const o = JSON.parse(t);
    const lon = o.lon || o.longitude || o.lons, lat = o.lat || o.latitude || o.lats;
    if (!Array.isArray(lon) || !Array.isArray(lat)) throw new Error('JSON needs "lon" and "lat" arrays');
    if (Array.isArray(lon[0])) {
      s.nj = lon.length; s.ni = lon[0].length;
      for (let j = 0; j < s.nj; j++) for (let i = 0; i < s.ni; i++) push(s, i, j, +lon[j][i], +lat[j][i]);
    } else {
      const nc = +o.ncol || ncol;
      if (!nc) throw new Error("flat JSON arrays need ncol");
      s.ni = nc; s.nj = Math.ceil(lon.length / nc);
      lon.forEach((x, k) => push(s, k % nc, Math.floor(k / nc), +x, +lat[k]));
    }
  } else {
    const rows = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[#a-zA-Z]/.test(l))
      .map((l) => l.split(/[\s,;]+/).map(Number));
    const w = rows[0].length;
    if (w >= 4) {
      for (const r of rows) push(s, r[0], r[1], r[2], r[3]);
    } else if (w === 2) {
      if (!ncol) throw new Error("two columns are lon lat in row order: say how many columns make a row");
      rows.forEach((r, k) => push(s, k % ncol, Math.floor(k / ncol), r[0], r[1]));
      s.ni = ncol; s.nj = Math.ceil(rows.length / ncol);
    } else throw new Error("give i j lon lat, or lon lat, on each line");
    if (!s.ni) { s.ni = Math.max(...s.i) + 1; s.nj = Math.max(...s.j) + 1; }
  }
  if (s.i.length < 3) throw new Error("need at least three samples off a line");
  return s;
}

// at most n samples spread through the set, for the search
function thin(s, n) {
  if (s.i.length <= n) return s;
  const out = emptySamples(), step = s.i.length / n;
  for (let k = 0; k < n; k++) {
    const m = Math.floor(k * step);
    out.i.push(s.i[m]); out.j.push(s.j[m]); out.lon.push(s.lon[m]); out.lat.push(s.lat[m]);
  }
  return out;
}

// Where the samples are: a centre (mean direction) and the latitude range.
export function describe(s) {
  let x = 0, y = 0, z = 0, lo = 90, hi = -90;
  for (let k = 0; k < s.lon.length; k++) {
    const p = s.lat[k] * D2R, l = s.lon[k] * D2R;
    x += Math.cos(p) * Math.cos(l); y += Math.cos(p) * Math.sin(l); z += Math.sin(p);
    lo = Math.min(lo, s.lat[k]); hi = Math.max(hi, s.lat[k]);
  }
  const r = Math.hypot(x, y, z) || 1;
  return { lon: Math.atan2(y, x) / D2R, lat: Math.asin(z / r) / D2R, latMin: lo, latMax: hi, spread: 1 - r / s.lon.length };
}

// ---------------------------------------------------------------- the affine fit

// Least squares x = a0 + a1 i + a2 j and y = b0 + b1 i + b2 j. The residual
// of each sample is taken back through the fitted 2 x 2 into index space, so
// it is in cells whatever the units of x and y.
export function affineFit(I, J, X, Y) {
  const n = I.length;
  let mi = 0, mj = 0, mx = 0, my = 0;
  for (let k = 0; k < n; k++) { mi += I[k]; mj += J[k]; mx += X[k]; my += Y[k]; }
  mi /= n; mj /= n; mx /= n; my /= n;
  let sii = 0, sij = 0, sjj = 0, sxi = 0, sxj = 0, syi = 0, syj = 0;
  for (let k = 0; k < n; k++) {
    const di = I[k] - mi, dj = J[k] - mj, dx = X[k] - mx, dy = Y[k] - my;
    sii += di * di; sij += di * dj; sjj += dj * dj;
    sxi += dx * di; sxj += dx * dj; syi += dy * di; syj += dy * dj;
  }
  const det = sii * sjj - sij * sij;
  if (!(Math.abs(det) > 1e-12 * (sii * sjj + 1e-300))) return null;
  const a1 = (sxi * sjj - sxj * sij) / det, a2 = (sxj * sii - sxi * sij) / det;
  const b1 = (syi * sjj - syj * sij) / det, b2 = (syj * sii - syi * sij) / det;
  const a0 = mx - a1 * mi - a2 * mj, b0 = my - b1 * mi - b2 * mj;
  const m = a1 * b2 - a2 * b1;
  if (!(Math.abs(m) > 0)) return null;
  let ss = 0, max = 0;
  const res = new Float64Array(2 * n);
  for (let k = 0; k < n; k++) {
    const ex = X[k] - (a0 + a1 * I[k] + a2 * J[k]), ey = Y[k] - (b0 + b1 * I[k] + b2 * J[k]);
    const ri = (b2 * ex - a2 * ey) / m, rj = (-b1 * ex + a1 * ey) / m;
    res[2 * k] = ri; res[2 * k + 1] = rj;
    const e2 = ri * ri + rj * rj;
    ss += e2; if (e2 > max) max = e2;
  }
  return { a: [a0, a1, a2], b: [b0, b1, b2], rms: Math.sqrt(ss / n), max: Math.sqrt(max), res };
}

// Project the samples and fit. Where x wraps (lon/lat, rotated lon/lat,
// cylinders) it is unwrapped along each row, and the first of each row
// against the row before, so a grid can cross the seam or go all the way
// round.
function evaluate(s, fns, keepXY = false) {
  const n = s.i.length, I = [], J = [], X = [], Y = [];
  let miss = 0, prevRow = null, prevJ = null, prev = null;
  const P = fns.period, wrap = (x, ref) => x - P * Math.round((x - ref) / P);
  for (let k = 0; k < n; k++) {
    const q = fns.fwd(s.lon[k], s.lat[k]);
    if (!q) { miss++; continue; }
    let x = q[0];
    if (P) {
      if (s.j[k] !== prevJ) { if (prevRow !== null) x = wrap(x, prevRow); prevRow = x; prevJ = s.j[k]; }
      else x = wrap(x, prev);
      prev = x;
    }
    I.push(s.i[k]); J.push(s.j[k]); X.push(x); Y.push(q[1]);
  }
  const fit = I.length >= 3 ? affineFit(I, J, X, Y) : null;
  if (!fit) return { score: 1e9, miss };
  fit.miss = miss;
  fit.score = fit.rms + (miss ? 10 + 100 * miss / n : 0);
  if (keepXY) Object.assign(fit, { I, J, X, Y });
  return fit;
}

// ---------------------------------------------------------------- candidates

export const SHAPES = {
  sphere: { label: "sphere", def: "+R=1", angular: true },
  ellipsoid: { label: "ellipsoid", def: "+ellps=WGS84" }
};

// Each family: free parameters (with a search range and a step), a start
// list built from where the samples are, and the CRS for a parameter vector.
// align names the parameter that turns the map in its plane, used afterwards
// to make the grid north-up.
const POLAR = (s) => (s.lat > 45 ? 90 : s.lat < -45 ? -90 : 0);
export const FAMILIES = [
  { key: "longlat", label: "Longitude and latitude", shapes: ["sphere"], params: [], crs: () => ({ longlat: true }) },
  { key: "merc", label: "Mercator", params: [], crs: () => "+proj=merc +lon_0=0" },
  { key: "cea", label: "Equal-area cylindrical", params: [], crs: () => "+proj=cea +lon_0=0" },
  { key: "sinu", label: "Sinusoidal", params: [{ name: "lon_0", step: 10, lo: -360, hi: 360 }],
    start: (d) => [[0], [d.lon]], crs: (p) => `+proj=sinu +lon_0=${r6(p[0])}` },
  { key: "tmerc", label: "Transverse Mercator", params: [{ name: "lon_0", step: 3, lo: -360, hi: 360 }],
    start: (d) => [[d.lon], [d.lon - 6], [d.lon + 6]], crs: (p) => `+proj=tmerc +lon_0=${r6(p[0])}` },
  { key: "stere-polar", label: "Polar stereographic", params: [], when: (d) => POLAR(d) !== 0, align: "lon_0",
    crs: (p, d, a = d.lon) => `+proj=stere +lat_0=${POLAR(d)} +lat_ts=${POLAR(d)} +lon_0=${r6(wrap180(a))}` },
  { key: "laea-polar", label: "Polar Lambert azimuthal equal-area", params: [], when: (d) => POLAR(d) !== 0, align: "lon_0",
    crs: (p, d, a = d.lon) => `+proj=laea +lat_0=${POLAR(d)} +lon_0=${r6(wrap180(a))}` },
  { key: "lcc", label: "Lambert conformal conic", params: [{ name: "lat_1", step: 5, lo: -89.5, hi: 89.5 }], align: "lon_0",
    start: (d) => [[d.lat], [(d.latMin + d.latMax) / 2], [d.lat > 0 ? 45 : -45], [d.lat > 0 ? 25 : -25], [d.lat > 0 ? 65 : -65]],
    crs: (p, d, a = d.lon) => { const l1 = Math.abs(p[0]) < 0.5 ? (p[0] < 0 ? -0.5 : 0.5) : p[0];
      return `+proj=lcc +lat_1=${r6(l1)} +lat_2=${r6(l1)} +lat_0=${r6(l1)} +lon_0=${r6(wrap180(a))}`; } },
  { key: "stere", label: "Oblique stereographic", params: [{ name: "lat_0", step: 10, lo: -90, hi: 90 }, { name: "lon_0", step: 10, lo: -540, hi: 540 }],
    start: (d) => [[d.lat, d.lon]], crs: (p) => `+proj=stere +lat_0=${r6(p[0])} +lon_0=${r6(p[1])}` },
  { key: "laea", label: "Oblique Lambert azimuthal equal-area", params: [{ name: "lat_0", step: 10, lo: -90, hi: 90 }, { name: "lon_0", step: 10, lo: -540, hi: 540 }],
    start: (d) => [[d.lat, d.lon]], crs: (p) => `+proj=laea +lat_0=${r6(p[0])} +lon_0=${r6(p[1])}` },
  { key: "geos-x", label: "Geostationary, sweep x (GOES)", params: [{ name: "lon_0", step: 3, lo: -540, hi: 540 }, { name: "h", step: 200000, lo: 1e5, hi: 2e8 }],
    when: (d) => Math.abs(d.lat) < 30, start: (d) => [[d.lon, 35786023], [d.lon, 35786023 * 0.8]],
    crs: (p, d, a, sh) => `+proj=geos +sweep=x +lon_0=${r6(p[0])} +h=${hscale(p[1], sh)}` },
  { key: "geos-y", label: "Geostationary, sweep y (Meteosat, Himawari)", params: [{ name: "lon_0", step: 3, lo: -540, hi: 540 }, { name: "h", step: 200000, lo: 1e5, hi: 2e8 }],
    when: (d) => Math.abs(d.lat) < 30, start: (d) => [[d.lon, 35786023], [d.lon, 35786023 * 0.8]],
    crs: (p, d, a, sh) => `+proj=geos +sweep=y +lon_0=${r6(p[0])} +h=${hscale(p[1], sh)}` },
  { key: "rotated", label: "Rotated pole", shapes: ["sphere"],
    params: [{ name: "pole lat", step: 10, lo: -90, hi: 90 }, { name: "pole lon", step: 10, lo: -540, hi: 540 }],
    start: (d) => [[90 - Math.abs(d.lat), wrap180(d.lon + 180)], [Math.abs(d.lat) - 90, d.lon]],
    crs: (p) => ({ rotated: [wrap180(p[1]), Math.max(-90, Math.min(90, p[0]))] }) }
];

const r6 = (x) => +(+x).toFixed(6);
// geos h is in metres on the ellipsoid; on the unit sphere it is in radii
const hscale = (h, sh) => r6(sh === "sphere" ? h / 6378137 : h);

// ---------------------------------------------------------------- search

function nelderMead(f, x0, steps, { iter = 200, tol = 1e-12 } = {}) {
  const n = x0.length;
  let simplex = [x0.slice()];
  for (let k = 0; k < n; k++) { const x = x0.slice(); x[k] += steps[k]; simplex.push(x); }
  let vals = simplex.map(f);
  for (let it = 0; it < iter; it++) {
    const ord = vals.map((v, k) => k).sort((a, b) => vals[a] - vals[b]);
    simplex = ord.map((k) => simplex[k]); vals = ord.map((k) => vals[k]);
    if (Math.abs(vals[n] - vals[0]) <= tol * (Math.abs(vals[0]) + 1e-14)) {
      // converged in value: stop once the simplex is small too
      let size = 0;
      for (let k = 1; k <= n; k++) for (let d = 0; d < n; d++) size = Math.max(size, Math.abs(simplex[k][d] - simplex[0][d]) / steps[d]);
      if (size < 1e-9) break;
    }
    const c = new Array(n).fill(0);
    for (let k = 0; k < n; k++) for (let d = 0; d < n; d++) c[d] += simplex[k][d] / n;
    const at = (t) => c.map((v, d) => v + t * (simplex[n][d] - v));
    const xr = at(-1), fr = f(xr);
    if (fr < vals[0]) {
      const xe = at(-2), fe = f(xe);
      if (fe < fr) { simplex[n] = xe; vals[n] = fe; } else { simplex[n] = xr; vals[n] = fr; }
    } else if (fr < vals[n - 1]) { simplex[n] = xr; vals[n] = fr; }
    else {
      const xc = fr < vals[n] ? at(-0.5) : at(0.5), fc = f(xc);
      if (fc < Math.min(fr, vals[n])) { simplex[n] = xc; vals[n] = fc; }
      else {
        for (let k = 1; k <= n; k++) { simplex[k] = simplex[k].map((v, d) => simplex[0][d] + 0.5 * (v - simplex[0][d])); vals[k] = f(simplex[k]); }
      }
    }
  }
  let b = 0;
  for (let k = 1; k <= n; k++) if (vals[k] < vals[b]) b = k;
  return { x: simplex[b], f: vals[b] };
}

function fnsFor(fam, p, d, shape, alignTo) {
  const c = fam.crs(p, d, alignTo, shape);
  if (typeof c === "object") return { crs: c, fns: crsFunctions(c) };
  const def = `${c} ${SHAPES[shape].def}`;
  try { return { crs: def, fns: crsFunctions(def) }; } catch (e) { return null; }
}

// Fit one family on one shape: coarse search, then Nelder-Mead from the best
// starts, on a thinned set; then the full set.
export function fitFamily(fam, shape, samples, d = describe(samples)) {
  const small = thin(samples, 160);
  const score = (p, s) => {
    for (let k = 0; k < p.length; k++) if (p[k] < fam.params[k].lo || p[k] > fam.params[k].hi) return 1e9;
    const f = fnsFor(fam, p, d, shape);
    return f ? evaluate(s, f.fns).score : 1e9;
  };
  let best = [];
  if (fam.params.length) {
    const starts = (fam.start ? fam.start(d) : []).slice();
    // a coarse lattice as well for the two-parameter families on the sphere
    if (fam.params.length === 2 && fam.key !== "geos-x" && fam.key !== "geos-y")
      for (let a = -80; a <= 80; a += 20) for (let b = -180; b < 180; b += 30) starts.push([a, d.lon + b]);
    const scored = starts.map((p) => ({ p, f: score(p, small) })).sort((a, b) => a.f - b.f).slice(0, 3);
    const steps = fam.params.map((q) => q.step);
    for (const s0 of scored) best.push(nelderMead((p) => score(p, small), s0.p, steps, { iter: 160 }));
    best.sort((a, b) => a.f - b.f);
    // polish the best: restart small, on the full set
    let r = nelderMead((p) => score(p, samples), best[0].x, steps.map((v) => v / 50), { iter: 160 });
    r = nelderMead((p) => score(p, samples), r.x, steps.map((v) => v / 5000), { iter: 120 });
    best = r.x;
  }
  let f = fnsFor(fam, best, d, shape);
  if (!f) return null;
  let fit = evaluate(samples, f.fns, true);
  // make it north-up: turn the map in its plane until the i axis lies along x
  if (fam.align && fit.a) {
    let a0 = d.lon;
    for (let it = 0; it < 4; it++) {
      const turn = Math.atan2(fit.b[1], fit.a[1]) / D2R;
      const off = turn;
      if (Math.abs(off) < 1e-9) break;
      // try both senses: polar north and south (and cones) turn opposite ways
      const tries = [1, -1].map((sg) => {
        const nf = fnsFor(fam, best, d, shape, a0 + sg * off / coneFactor(fam, best, d));
        const r = nf && evaluate(samples, nf.fns, true);
        const t2 = r && r.a ? Math.atan2(r.b[1], r.a[1]) / D2R : 999;
        return { nf, r, a: a0 + sg * off / coneFactor(fam, best, d), off: Math.abs(t2) };
      }).sort((x, y) => x.off - y.off)[0];
      if (!tries.r || tries.off >= Math.abs(off)) break;
      a0 = tries.a; f = tries.nf; fit = tries.r;
    }
    // and the right way up, if half a turn makes it so
    if (fit.a[1] < 0) {
      const nf = fnsFor(fam, best, d, shape, a0 + 180 / coneFactor(fam, best, d));
      const r = nf && evaluate(samples, nf.fns, true);
      if (r && r.a && r.a[1] > 0 && r.rms < fit.rms * 2 + 1e-6) { f = nf; fit = r; }
    }
  }
  // a rotated pole and its antipode give the same grid, one upside down
  if (fam.key === "rotated" && fit.a && fit.a[1] < 0) {
    const p2 = [-best[0], best[1] + 180], nf = fnsFor(fam, p2, d, shape);
    const r = nf && evaluate(samples, nf.fns, true);
    if (r && r.a && r.a[1] > 0 && r.rms < fit.rms * 2 + 1e-6) { f = nf; fit = r; best = p2; }
  }
  return { family: fam.key, label: fam.label, shape, params: best, crs: f.crs, fit, angular: !!f.fns.angular, samples };
}

function coneFactor(fam, p, d) {
  if (fam.key === "lcc") return Math.abs(Math.sin((Math.abs(p[0]) < 0.5 ? 0.5 : p[0]) * D2R));
  return 1;
}

// Every candidate, best first. onEach(result) is called as each one is done,
// so a page can show them arriving; it yields between candidates.
export async function testAll(samples, { onEach = null, families = FAMILIES } = {}) {
  const d = describe(samples);
  const out = [];
  for (const fam of families) {
    if (fam.when && !fam.when(d)) continue;
    for (const shape of fam.shapes || ["sphere", "ellipsoid"]) {
      const r = fitFamily(fam, shape, samples, d);
      if (r) { out.push(r); if (onEach) onEach(r, out); }
      await new Promise((res) => setTimeout(res, 0));
    }
  }
  out.sort(rank);
  return out;
}

// Best first; among the regular ones, fewest free parameters first, so a
// polar stereographic beats an oblique one that found the pole.
export function rank(a, b) {
  const ra = a.fit.max < 0.01 && !a.fit.miss, rb = b.fit.max < 0.01 && !b.fit.miss;
  if (ra && rb) return (a.params.length - b.params.length) || (a.fit.rms - b.fit.rms);
  return a.fit.score - b.fit.score;
}

export function verdict(fit) {
  if (fit.miss) return "off the map";
  if (fit.max < 0.01) return "regular";
  if (fit.max < 0.25) return "nearly";
  return "no";
}

// ---------------------------------------------------------------- the answer as a grid

// Radii that make round numbers: the cell size from a fit on the unit sphere
// or on WGS84 is a ratio of radii away from the producer's.
export const RADII = [
  { name: "WGS84 / GRS80", a: 6378137, ellps: true, def: "+ellps=WGS84" },
  { name: "Hughes 1980 (NSIDC)", a: 6378273, ellps: true, def: "+a=6378273 +b=6356889.449" },
  { name: "Clarke 1866", a: 6378206.4, ellps: true, def: "+ellps=clrk66" },
  { name: "International 1924", a: 6378388, ellps: true, def: "+ellps=intl" },
  { name: "sphere 6371229 (NCEP, ECMWF GRIB)", a: 6371229, def: "+R=6371229" },
  { name: "sphere 6371228 (EASE-Grid 1)", a: 6371228, def: "+R=6371228" },
  { name: "sphere 6371007.181 (MODIS, authalic)", a: 6371007.181, def: "+R=6371007.181" },
  { name: "sphere 6371000", a: 6371000, def: "+R=6371000" },
  { name: "sphere 6370997 (Clarke 1866 authalic)", a: 6370997, def: "+R=6370997" },
  { name: "sphere 6378137", a: 6378137, def: "+R=6378137" }
];

// a number is round if a few significant figures carry it, to a part in 1e6
function roundness(v) {
  if (!v) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(v))));
  for (let sig = 1; sig <= 5; sig++) {
    const q = mag / Math.pow(10, sig - 1), r = Math.round(v / q) * q;
    if (Math.abs(r - v) <= 2e-6 * Math.abs(v)) return sig;
  }
  return 0;
}
const roundTo = (v) => { const s = roundness(v); if (!s) return v; const q = Math.pow(10, Math.floor(Math.log10(Math.abs(v))) - s + 1); return Math.round(v / q) * q; };

// The fitted grid in plain terms: the cell size along each axis, the centre
// of the first cell, and whether it is north-up; plus the radius (if any)
// that makes the cell size round, for metric results.
export function gridOf(r) {
  const { a, b } = r.fit;
  const turn = Math.atan2(b[1], a[1]) / D2R;
  const northUp = Math.abs(a[2]) < 1e-9 * Math.abs(a[1]) + 1e-12 && Math.abs(b[1]) < 1e-9 * Math.abs(b[2]) + 1e-12;
  const out = { dx: a[1], dy: b[2], x0: a[0], y0: b[0], shear: [a[2], b[1]], turn, northUp: northUp || (Math.abs(a[2] / a[1]) < 1e-6 && Math.abs(b[1] / b[2]) < 1e-6) };
  if (r.angular) { out.units = "degrees"; out.scale = 1; out.dxRound = roundTo(out.dx); out.dyRound = roundTo(out.dy); return out; }
  out.units = "m";
  const isGeos = r.family.startsWith("geos");
  if (isGeos) {
    const h = r.params[1];
    out.h = h;
    // x and y are scan angles times h: the step is an angle
    const base = r.shape === "sphere" ? 6378137 : 1;
    out.angleStep = [a[1] * base / h, b[2] * base / h];
    out.scale = base;
    return out;
  }
  // which radius, and which scale parameter (lat_ts, k_0), make the cell
  // size round: the fit cannot tell them apart, the producer chose one
  const base = r.shape === "sphere" ? 1 : 6378137;
  const scales = scaleOptions(r);
  const opts = [];
  const few = thin(r.samples, 40);
  for (const sc of scales) {
    let rx = 1, ry = 1;
    if (sc.to !== sc.from) {
      const alt = crsFunctions(r.crs.replace(sc.from, sc.to)), e = evaluate(few, alt);
      const e0 = evaluate(few, crsFunctions(r.crs));
      if (!e.a || !e0.a) continue;
      rx = Math.hypot(e.a[1], e.b[1]) / Math.hypot(e0.a[1], e0.b[1]);
      ry = Math.hypot(e.a[2], e.b[2]) / Math.hypot(e0.a[2], e0.b[2]);
    }
    for (const q of RADII.filter((x) => (r.shape === "sphere") !== !!x.ellps)) {
      const k = q.a / base, dx = Math.hypot(a[1], b[1]) * k * rx, dy = Math.hypot(a[2], b[2]) * k * ry;
      const sx = roundness(dx), sy = roundness(dy);
      if (sx && sy && Math.max(sx, sy) <= 3) opts.push({ q, k, rx, ry, sc, sig: Math.max(sx, sy) });
    }
  }
  opts.sort((x, y) => x.sig - y.sig);
  const fallback = r.shape === "sphere" ? RADII.find((x) => x.a === 6371000) : RADII[0];
  const pick = opts[0] || { q: fallback, k: fallback.a / base, rx: 1, ry: 1, sc: scales[0] };
  out.radius = pick.q; out.scale = pick.k; out.rx = pick.rx; out.ry = pick.ry; out.scaleDef = pick.sc; out.snapped = !!opts[0];
  // on a sphere the cell may be a round fraction of a degree of arc instead,
  // whatever the radius (MODIS: 1/240 degree at 500 m)
  if (r.shape === "sphere") {
    const per = 1 / (Math.abs(a[1]) / D2R);
    if (Math.abs(per - Math.round(per)) < 1e-4 * per) out.arc = Math.round(per);
  }
  return out;
}

// The PROJ string and the GDAL geotransform (cell corners) for a result,
// at the radius gridOf picked. Rows are j, columns i.
export function describeResult(r) {
  const g = gridOf(r);
  let crs;
  if (typeof r.crs === "object") {
    crs = r.crs.longlat ? "+proj=longlat +datum=WGS84" :
      (() => { const o = cfToObTran(r.crs.rotated[0], r.crs.rotated[1]); return `+proj=ob_tran +o_proj=longlat +o_lat_p=${r6(o.oLatP)} +o_lon_p=0 +lon_0=${r6(o.lon0)} +R=6371229`; })();
  } else if (r.family.startsWith("geos")) {
    crs = r.crs.replace(/\+h=[^ ]+/, `+h=${Math.round(g.h)}`).replace("+R=1", "+ellps=WGS84");
  } else {
    crs = r.crs.replace(g.scaleDef.from, g.scaleDef.to).replace(r.shape === "sphere" ? "+R=1" : "+ellps=WGS84", g.radius.def);
  }
  // x and y as the chosen CRS gives them: the scale parameter stretches each axis
  const kx = g.scale * (g.rx || 1), ky = g.scale * (g.ry || 1);
  const A = r.fit.a.map((v) => v * kx), B = r.fit.b.map((v) => v * ky);
  const gt = [A[0] - 0.5 * A[1] - 0.5 * A[2], A[1], A[2], B[0] - 0.5 * B[1] - 0.5 * B[2], B[1], B[2]];
  const cell = Math.max(Math.abs(A[1]), Math.abs(B[2]));
  const snapped = gt.map((v, m) => (m === 0 || m === 3) ? snapOrigin(v, m === 0 ? A[1] : B[2]) :
    Math.abs(v) < 1e-6 * cell ? 0 : roundTo(v));
  return { grid: g, crs: niceNumbers(crs), gt: snapped };
}
// parameters found by search land a hair off the round values they were made with
// the scale parameters a family could have been made with, most usual first
function scaleOptions(r) {
  const out = [{ from: "", to: "", label: "" }];
  const m = r.crs.match(/\+lat_ts=(-?[\d.]+)/);
  if (r.family === "stere-polar" && m) {
    const sg = +m[1] < 0 ? -1 : 1;
    for (const L of [70, 71, 60, 80, 75, 65]) out.push({ from: m[0], to: `+lat_ts=${sg * L}` });
    for (let L = 50; L < 90; L++) out.push({ from: m[0], to: `+lat_ts=${sg * L}` });
  } else if (r.family === "merc" || r.family === "cea") {
    for (const L of [30, 45, 60]) out.push({ from: "+lon_0=0", to: `+lon_0=0 +lat_ts=${L}` });
    for (let L = 1; L < 85; L++) out.push({ from: "+lon_0=0", to: `+lon_0=0 +lat_ts=${L}` });
  } else if (r.family === "tmerc") {
    for (const k of [0.9996, 0.9999, 0.99995, 0.9998]) out.push({ from: "+proj=tmerc", to: `+proj=tmerc +k_0=${k}` });
  }
  return out;
}

function niceNumbers(s) {
  return s.replace(/=(-?\d+\.\d+)/g, (m, v) => {
    const x = +v;
    for (const q of [1, 0.5, 0.25, 0.1, 0.01, 0.001]) {
      const r = Math.round(x / q) * q;
      if (Math.abs(r - x) < Math.min(2e-4, q / 50)) return "=" + (+r.toFixed(3));
    }
    return m;
  });
}
// an origin that is a whole or half number of cells, or a round number, to a part in 1e6 of a cell
function snapOrigin(v, cell) {
  const c = Math.abs(roundTo(Math.abs(cell)));
  const w = Math.round(v / (c / 2)) * (c / 2);
  if (Math.abs(w - v) < 1e-3 * c) return w;
  const r = roundTo(v);
  return Math.abs(r - v) < 1e-3 * c ? r : v;
}

// ---------------------------------------------------------------- examples

// A dataset whose grid is regular in a known CRS: centres of the first
// column and row (x0, y0), steps dx, dy, and size ni x nj. lonlat(i, j)
// gives the cell centre, what the dataset's 2D arrays hold.
function regular(o) {
  let f = null, x0 = o.x0, y0 = o.y0;
  // a grid can be pinned by its first point instead (GRIB): x0, y0 from that
  const fns = () => {
    if (!f) { f = crsFunctions(o.crs); if (o.origin) [x0, y0] = f.fwd(o.origin[0], o.origin[1]); }
    return f;
  };
  return {
    ...o,
    lonlat(i, j) { return fns().inv(x0 + i * o.dx, y0 + j * o.dy); },
    // column and row of a lon/lat, fractional; null off the map
    index(lon, lat) {
      const F = fns(), q = F.fwd(lon, lat);
      if (!q) return null;
      let x = q[0];
      if (F.period) { const c = x0 + o.dx * (o.ni - 1) / 2; x -= F.period * Math.round((x - c) / F.period); }
      return [(x - x0) / o.dx, (q[1] - y0) / o.dy];
    }
  };
}

const GOES_H = 35786023, HIMA_H = 35785863;
const T_MODIS = 1111950.5197665, MODIS_X = -20015109.354, MODIS_Y = 10007554.677;
const MODIS_CELL = T_MODIS / 2400;

export const EXAMPLES = [
  regular({
    key: "oisst", label: "Quarter degree", crs: { longlat: true },
    ni: 1440, nj: 720, x0: 0.125, dx: 0.25, y0: -89.875, dy: 0.25,
    source: "A global 0.25 degree grid, as NOAA OISST and many reanalyses use.",
    ships: "Usually 1D lon and lat, but often expanded to 2D on the way through a toolchain. Two 1440 x 720 arrays to say what four numbers say."
  }),
  regular({
    key: "goes", label: "GOES-East", crs: `+proj=geos +sweep=x +lon_0=-75 +h=${GOES_H} +ellps=GRS80`,
    ni: 5424, nj: 5424, x0: -0.151844 * GOES_H, dx: 56e-6 * GOES_H, y0: 0.151844 * GOES_H, dy: -56e-6 * GOES_H,
    source: "GOES-16/19 ABI full disk at 2 km: a scan-angle grid of 56 microradians, from 75 W.",
    ships: "The L1b and L2 files carry x and y as 1D scan angles and the projection as attributes; lon/lat arrays are what people derive and pass on."
  }),
  regular({
    key: "himawari", label: "Himawari", crs: `+proj=geos +sweep=y +lon_0=140.7 +h=${HIMA_H} +ellps=WGS84`,
    ni: 5500, nj: 5500, x0: -2749.5 * (65536 / 20466275) * D2R * HIMA_H, dx: (65536 / 20466275) * D2R * HIMA_H,
    y0: 2749.5 * (65536 / 20466275) * D2R * HIMA_H, dy: -(65536 / 20466275) * D2R * HIMA_H,
    source: "Himawari-8/9 AHI full disk at 2 km, from 140.7 E. The step is 2^16 / CFAC degrees, CFAC = 20466275.",
    ships: "Many regridded and L2 products ship 2D latitude and longitude, NaN off the disk."
  }),
  regular({
    key: "nsidc", label: "NSIDC sea ice", crs: "+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +a=6378273 +b=6356889.449",
    ni: 304, nj: 448, x0: -3850000 + 12500, dx: 25000, y0: 5850000 - 12500, dy: -25000,
    source: "NSIDC polar stereographic north, 25 km (EPSG:3411), on the Hughes 1980 ellipsoid.",
    ships: "psn25lons_v3.dat and psn25lats_v3.dat: the famous pair of lon/lat files, and the same arrays inside the netCDF."
  }),
  regular({
    key: "ease", label: "EASE-Grid 2.0", crs: "+proj=laea +lat_0=90 +lon_0=0 +ellps=WGS84",
    ni: 720, nj: 720, x0: -9000000 + 12500, dx: 25000, y0: 9000000 - 12500, dy: -25000,
    source: "EASE-Grid 2.0 North at 25 km (EPSG:6931).",
    ships: "Ancillary files EASE2_N25km.lats and .lons, one value per cell."
  }),
  regular({
    key: "hrrr", label: "HRRR", crs: "+proj=lcc +lat_1=38.5 +lat_2=38.5 +lat_0=38.5 +lon_0=-97.5 +R=6371229",
    ni: 1799, nj: 1059, origin: [237.280472 - 360, 21.138123], dx: 3000, dy: 3000,
    source: "NOAA's HRRR at 3 km: Lambert conformal on a 6371229 m sphere, pinned by its first point, 21.138123 N 237.280472 E.",
    ships: "GRIB2 carries the projection, but cfgrib and wgrib2 netCDF hand you 2D latitude and longitude."
  }),
  regular({
    key: "cordex", label: "EURO-CORDEX", crs: { rotated: [-162, 39.25] },
    ni: 424, nj: 412, x0: -28.375, dx: 0.11, y0: -23.375, dy: 0.11,
    source: "EUR-11: 0.11 degrees on a pole rotated to 39.25 N 162 W.",
    ships: "rlon and rlat as 1D, plus 2D lon and lat that many tools read instead."
  }),
  regular({
    key: "modis", label: "MODIS tile", crs: "+proj=sinu +lon_0=0 +R=6371007.181",
    ni: 2400, nj: 2400, x0: MODIS_X + 29 * T_MODIS + MODIS_CELL / 2, dx: MODIS_CELL,
    y0: MODIS_Y - 12 * T_MODIS - MODIS_CELL / 2, dy: -MODIS_CELL,
    source: "MODIS land tile h29v12 at 500 m, south-east Australia, on the sinusoidal grid.",
    ships: "HDF-EOS stores the corners; the MOD03 geolocation and many reprocessed products carry lon/lat per cell."
  }),
  (() => {
    const p = tripolar({ plon: 80, join: 65, step: 1 }).patches[0];
    const nj = p.nj;
    return {
      key: "tripolar", label: "Tripolar", crs: null, ni: p.ni, nj,
      lonlat: (i, j) => p.fromIndex((i + 0.5) / p.ni, (j + 0.5) / nj),
      index: (lon, lat) => { const uv = p.toIndex(lon, lat); return uv && [uv[0] * p.ni - 0.5, uv[1] * nj - 0.5]; },
      source: "A 1 degree tripolar ocean grid (Murray 1996), as on the Model grids page: Mercator-spaced south of 65 N, a bipolar cap north of it.",
      ships: "Ocean models store lon and lat for every cell, because no PROJ string describes the whole grid."
    };
  })(),
  (() => {
    const p = tripolar({ plon: 80, join: 65, step: 1 }).patches[0];
    const nj = Math.floor(p.fold * p.nj);
    return {
      key: "tripolar-south", label: "Tripolar, south part", crs: "+proj=merc +R=1", ni: p.ni, nj,
      lonlat: (i, j) => p.fromIndex((i + 0.5) / p.ni, (j + 0.5) / p.nj),
      index: (lon, lat) => { const uv = p.toIndex(lon, lat); return uv && [uv[0] * p.ni - 0.5, uv[1] * p.nj - 0.5]; },
      source: "The same tripolar grid, only the rows south of the join.",
      ships: "Cut out the part below the cap and the arrays are regular again."
    };
  })()
];

export const exampleByKey = (k) => EXAMPLES.find((e) => e.key === k) || EXAMPLES[0];

// ---------------------------------------------------------------- geostationary on the sphere

// The scan direction for scan angles (radians) x and y, in the frame where
// the satellite looks down the first axis: sweep "x" turns about x last
// (GOES), sweep "y" about y last (Meteosat, Himawari). As PROJ's geos.
export function scanDirection(ax, ay, sweep) {
  return sweep === "x"
    ? [Math.cos(ax) * Math.cos(ay), Math.sin(ax), Math.cos(ax) * Math.sin(ay)]
    : [Math.cos(ay) * Math.cos(ax), Math.cos(ay) * Math.sin(ax), Math.sin(ay)];
}

// Where the scan ray hits the unit sphere, from a satellite at distance rg
// (in radii) over the equator at lon0: lon/lat in degrees, or null.
export function scanToLonLat(ax, ay, sweep, rg, lon0 = 0) {
  const d = scanDirection(ax, ay, sweep);
  const disc = rg * rg * d[0] * d[0] - rg * rg + 1;
  if (disc < 0) return null;
  const s = rg * d[0] - Math.sqrt(disc);
  const x = rg - s * d[0], y = s * d[1], z = s * d[2];
  return [wrap180(Math.atan2(y, x) / D2R + lon0), Math.asin(Math.max(-1, Math.min(1, z))) / D2R];
}

// lon/lat to scan angles (radians) on the sphere, or null behind the limb
export function lonLatToScan(lon, lat, sweep, rg, lon0 = 0) {
  const p = lat * D2R, l = (lon - lon0) * D2R;
  const vx = Math.cos(p) * Math.cos(l), vy = Math.cos(p) * Math.sin(l), vz = Math.sin(p);
  if ((rg - vx) * vx - vy * vy - vz * vz < 0) return null;
  const t = rg - vx;
  return sweep === "x"
    ? [Math.atan(vy / Math.hypot(vz, t)), Math.atan(vz / t)]
    : [Math.atan(vy / t), Math.atan(vz / Math.hypot(vy, t))];
}

// The half-angle of the Earth's disc seen from rg radii
export const discAngle = (rg) => Math.asin(1 / rg);
