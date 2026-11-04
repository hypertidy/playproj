// Voxels: elevation on a grid of columns, each column a stack of boxes of
// one height step. The same ground can be cut into columns three ways,
//
//   array   lon/lat cells drawn as squares, as the array stores them
//   lonlat  lon/lat cells at their true size on the ground (narrower east
//           to west away from the equator, so rows shrink toward the pole)
//   laea    square cells in metres, on a Lambert azimuthal equal-area grid
//           about the centre
//
// and each column takes the mean elevation over its footprint, read from a
// lon/lat elevation window (GEBCO, or the synthetic island here). Columns
// quantise to whole voxels, and a block of them writes as a MagicaVoxel
// .vox file.

import { sampleWindow } from "./basemap.js";

const D2R = Math.PI / 180;
export const R = 6371008.8;   // mean radius, metres

export const CRS = {
  array: "Lon/lat cells, drawn square (the array)",
  lonlat: "Lon/lat cells, true size on the ground",
  laea: "Square cells in metres (equal-area)"
};

// ------------------------------------------------------------ grids

// Spherical Lambert azimuthal equal-area about (lon0, lat0), metres.
export function laea(lon0, lat0) {
  const p0 = lat0 * D2R, s0 = Math.sin(p0), c0 = Math.cos(p0);
  return {
    forward(lon, lat) {
      const p = lat * D2R, l = (lon - lon0) * D2R, sp = Math.sin(p), cp = Math.cos(p), cl = Math.cos(l);
      const k = Math.sqrt(2 / (1 + s0 * sp + c0 * cp * cl));
      return [R * k * cp * Math.sin(l), R * k * (c0 * sp - s0 * cp * cl)];
    },
    inverse(x, y) {
      const rho = Math.hypot(x, y);
      if (rho < 1e-9) return [lon0, lat0];
      const c = 2 * Math.asin(Math.min(1, rho / (2 * R))), sc = Math.sin(c), cc = Math.cos(c);
      const lat = Math.asin(cc * s0 + (y * sc * c0) / rho) / D2R;
      const lon = lon0 + Math.atan2(x * sc, rho * c0 * cc - y * s0 * sc) / D2R;
      return [lon, lat];
    }
  };
}

// The lon/lat box around a square of side ext metres on the ground at
// (lon0, lat0), its latitudes kept off the poles.
export function groundBox(lon0, lat0, ext) {
  const dlat = ext / R / D2R, c = Math.max(0.02, Math.cos(lat0 * D2R));
  const dlon = Math.min(360, dlat / c);
  return {
    west: lon0 - dlon / 2, east: lon0 + dlon / 2,
    south: Math.max(-89.9, lat0 - dlat / 2), north: Math.min(89.9, lat0 + dlat / 2)
  };
}

// The columns over a square of side ext metres at (lon0, lat0), n across.
// Each column has its scene centre x, y and footprint wx, wy in metres
// (x east, y north), and pts(s): an s x s set of lon/lat points spread over
// its footprint, for the mean. ni x nj columns, row-major from the south
// west; cellM is the nominal cell size in metres, cellDeg the lon/lat cell
// size (lon/lat grids).
export function columnGrid(lon0, lat0, ext, n, crs = "laea") {
  if (crs === "laea") {
    const P = laea(lon0, lat0), c = ext / n, cols = [];
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = (i + 0.5) * c - ext / 2, y = (j + 0.5) * c - ext / 2;
        cols.push({
          i, j, x, y, wx: c, wy: c,
          pts: (s) => spread(s, (u, v) => P.inverse(x + (u - 0.5) * c, y + (v - 0.5) * c))
        });
      }
    const [clon, clat] = P.inverse(0, 0);
    return { crs, ni: n, nj: n, cellM: c, cellDeg: null, cols, centre: [clon, clat] };
  }
  const box = groundBox(lon0, lat0, ext);
  const cd = (box.east - box.west) / n, nj = Math.max(1, Math.round((box.north - box.south) / cd));
  const south = (box.north + box.south) / 2 - (nj * cd) / 2;
  const m = cd * D2R * R, cl0 = Math.cos(lat0 * D2R), cols = [];
  for (let j = 0; j < nj; j++) {
    const lat = Math.max(-89.99, Math.min(89.99, south + (j + 0.5) * cd)), cl = Math.cos(lat * D2R);
    for (let i = 0; i < n; i++) {
      const lon = box.west + (i + 0.5) * cd;
      const col = crs === "array"
        ? { x: (i + 0.5 - n / 2) * m * cl0, y: (j + 0.5 - nj / 2) * m * cl0, wx: m * cl0, wy: m * cl0 }
        : { x: (lon - lon0) * D2R * R * cl, y: (lat - lat0) * D2R * R, wx: m * cl, wy: m };
      cols.push({ i, j, lon, lat, ...col, pts: (s) => spread(s, (u, v) => [lon + (u - 0.5) * cd, lat + (v - 0.5) * cd]) });
    }
  }
  return { crs, ni: n, nj, cellM: m * cl0, cellDeg: cd, cols, centre: [lon0, lat0] };
}

function spread(s, f) {
  const out = [];
  for (let b = 0; b < s; b++) for (let a = 0; a < s; a++) out.push(f((a + 0.5) / s, (b + 0.5) / s));
  return out;
}

// ------------------------------------------------------------ elevation

// Bilinear elevation from a lon/lat window { elev, width, height, west,
// north, dx, dy } (cell centres at west + (i + 0.5) dx), longitudes taken
// round the world into the window where they fit.
export function sampler(win) {
  const { elev, width: W, height: H, west, north, dx, dy } = win;
  const wraps = Math.abs(W * dx - 360) < 1e-6;
  const at = (i, j) => {
    if (wraps) i = ((i % W) + W) % W; else i = Math.max(0, Math.min(W - 1, i));
    j = Math.max(0, Math.min(H - 1, j));
    return elev[j * W + i];
  };
  return (lon, lat) => {
    let l = lon;
    while (l < west) l += 360;
    while (l >= west + 360) l -= 360;
    const fx = (l - west) / dx - 0.5, fy = (north - lat) / dy - 0.5;
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
  };
}

// Bilinear values from a window of a grid in any CRS: { elev, width,
// height, x0, y0 (the window's outer corner), dx, dy (signed cell steps),
// nodata } with fwd(lon, lat) -> [x, y] in the grid's CRS (or null). NaN
// off the window, at nodata, or where a neighbour is missing.
export function gridSampler(win, fwd) {
  const { elev, width: W, height: H, x0, y0, dx, dy, nodata } = win;
  const at = (i, j) => {
    const v = elev[Math.max(0, Math.min(H - 1, j)) * W + Math.max(0, Math.min(W - 1, i))];
    return v === nodata ? NaN : v;
  };
  return (lon, lat) => {
    const q = fwd(lon, lat);
    if (!q) return NaN;
    const fx = (q[0] - x0) / dx - 0.5, fy = (q[1] - y0) / dy - 0.5;
    if (!(fx >= -0.5 && fy >= -0.5 && fx <= W - 0.5 && fy <= H - 0.5)) return NaN;
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
  };
}

// The window of a source grid { nx, ny, x0, dx, y0, dy, levels: [factor,
// ...] (1 first, then each overview's step in full cells), angular } that
// covers pts (lon/lat points round the block) through fwd, at the coarsest
// level whose cells are at most half a column (cellM metres), coarser
// while over max cells on a side; where even the coarsest is too big, a
// stride within it. Pixel ranges are in the level's own cells, clipped to
// the grid; null where the block misses the grid.
export function planWindow(src, fwd, pts, cellM, lat0 = 0, max = 2048) {
  let xa = Infinity, xb = -Infinity, ya = Infinity, yb = -Infinity;
  for (const [lon, lat] of pts) {
    const q = fwd(lon, lat);
    if (!q || !isFinite(q[0]) || !isFinite(q[1])) continue;
    const fi = (q[0] - src.x0) / src.dx, fj = (q[1] - src.y0) / src.dy;
    xa = Math.min(xa, fi); xb = Math.max(xb, fi); ya = Math.min(ya, fj); yb = Math.max(yb, fj);
  }
  if (!(xb > 0 && yb > 0 && xa < src.nx && ya < src.ny)) return null;
  const metres = src.angular ? D2R * R * Math.max(0.05, Math.cos(lat0 * D2R)) : 1;
  const cell = (f) => Math.min(Math.abs(src.dx), Math.abs(src.dy)) * f * metres;
  const levels = src.levels || [1];
  let k = 0;
  for (let i = 0; i < levels.length; i++) if (cell(levels[i]) <= cellM / 2) k = i;
  const span = (f) => Math.max(xb - xa, yb - ya) / f;
  while (k < levels.length - 1 && span(levels[k]) > max) k++;
  const f = levels[k], step = Math.max(1, Math.ceil(span(f) / max));
  const lw = Math.ceil(src.nx / f), lh = Math.ceil(src.ny / f);
  const i0 = Math.max(0, Math.floor(xa / f) - 1), i1 = Math.min(lw, Math.ceil(xb / f) + 1);
  const j0 = Math.max(0, Math.floor(ya / f) - 1), j1 = Math.min(lh, Math.ceil(yb / f) + 1);
  return {
    level: k, factor: f, step, i0, i1, j0, j1,
    width: Math.ceil((i1 - i0) / step), height: Math.ceil((j1 - j0) / step),
    x0: src.x0 + i0 * f * src.dx, y0: src.y0 + j0 * f * src.dy, dx: src.dx * f * step, dy: src.dy * f * step,
    cellM: cell(f * step)
  };
}

// Points round a block (its outline and a cross through it), lon/lat.
export function blockOutline(lon0, lat0, ext, crs = "laea", n = 16) {
  const g = columnGrid(lon0, lat0, ext, n, crs), out = [];
  for (const c of g.cols) {
    const edge = c.i === 0 || c.j === 0 || c.i === g.ni - 1 || c.j === g.nj - 1 || c.i === g.ni >> 1 || c.j === g.nj >> 1;
    if (edge) out.push(...c.pts(2));
  }
  return out;
}

// The mean elevation of each column: s x s bilinear samples over the
// footprint, s enough to reach the source's own cells (srcM metres) along
// the footprint's longer side (north to south, for lon/lat cells), up
// to 6. Missing samples (NaN) are left out; a column with none is NaN.
export function columnMeans(grid, sample, srcM) {
  const side = grid.cellDeg ? grid.cellDeg * D2R * R : grid.cellM;
  const s = Math.max(1, Math.min(6, Math.ceil(side / Math.max(1, srcM))));
  const z = new Float32Array(grid.cols.length);
  grid.cols.forEach((c, k) => {
    let t = 0, m = 0;
    for (const [lon, lat] of c.pts(s)) {
      const v = sample(lon, lat);
      if (v === v) { t += v; m++; }
    }
    z[k] = m ? t / m : NaN;
  });
  return { z, s };
}

// A synthetic island on a sea floor, as a window like GEBCO's: a volcano
// with a crater and a ridge, wherever the view is (it is centred there).
export function syntheticWindow(lon0, lat0, ext, size = 256) {
  const box = groundBox(lon0, lat0, ext * 1.2);
  const dx = (box.east - box.west) / size, dy = (box.north - box.south) / size;
  const elev = new Float32Array(size * size), cl = Math.cos(lat0 * D2R);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const lon = box.west + (i + 0.5) * dx, lat = box.north - (j + 0.5) * dy;
      const x = ((lon - lon0) * D2R * R * cl) / ext, y = ((lat - lat0) * D2R * R) / ext;
      const r = Math.hypot(x, y);
      const cone = 4200 * Math.exp(-((r / 0.17) ** 2)) - 900 * Math.exp(-((r / 0.03) ** 2));
      const ridge = 1400 * Math.exp(-(((x - y * 0.6 - 0.12) / 0.06) ** 2) - ((y + 0.15) / 0.22) ** 2);
      const ripple = 120 * Math.sin(x * 40) * Math.cos(y * 33);
      elev[j * size + i] = -3600 + 1800 * Math.exp(-((r / 0.38) ** 2)) + cone + ridge + ripple;
    }
  return { elev, width: size, height: size, west: box.west, north: box.north, dx, dy };
}

// The mean colour of each column from an RGBA lon/lat window (imagery,
// as basemap.js reads it), s x s samples over the footprint: rgb[3k..],
// and has[k] = 0 where the window has nothing there.
export function columnColours(grid, win, s = 2) {
  const n = grid.cols.length, rgb = new Uint8Array(n * 3), has = new Uint8Array(n), px = new Float32Array(4);
  grid.cols.forEach((c, k) => {
    let r = 0, g = 0, b = 0, m = 0;
    for (const [lon, lat] of c.pts(s)) {
      if (!sampleWindow(win, lon, lat, px, 0)) continue;
      r += px[0]; g += px[1]; b += px[2]; m++;
    }
    if (m) { rgb[3 * k] = r / m; rgb[3 * k + 1] = g / m; rgb[3 * k + 2] = b / m; has[k] = 1; }
  });
  return { rgb, has };
}

// ------------------------------------------------------------ voxels

// Palette, index 1 up as in a .vox file. Each column's surface class comes
// from its elevation and latitude; the layers under a grass top are dirt,
// and stone below that.
export const PALETTE = [
  null,
  { key: "water", rgb: [52, 116, 196] },
  { key: "sand", rgb: [222, 204, 146] },
  { key: "silt", rgb: [96, 100, 112] },
  { key: "grass", rgb: [98, 158, 66] },
  { key: "dirt", rgb: [134, 96, 62] },
  { key: "rock", rgb: [128, 120, 110] },
  { key: "snow", rgb: [240, 246, 250] },
  { key: "stone", rgb: [92, 92, 96] },
  { key: "ice", rgb: [196, 226, 240] }
];
export const CLASS = Object.fromEntries(PALETTE.slice(1).map((p, k) => [p.key, k + 1]));

// Imagery on the tops goes into a .vox as a 6 x 6 x 6 colour cube after
// the classes: index CUBE + 36 r + 6 g + b, levels 0, 51, .. 255.
export const CUBE = PALETTE.length;
export const cubeIndex = (r, g, b) => CUBE + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51);
function paletteRgb(c) {
  if (c < CUBE) return PALETTE[c] ? PALETTE[c].rgb : null;
  const k = c - CUBE;
  return k < 216 ? [51 * Math.floor(k / 36), 51 * (Math.floor(k / 6) % 6), 51 * (k % 6)] : null;
}

// Snow from about 4800 m at the equator down to the sea toward the poles.
export const snowLine = (lat) => 4800 * Math.cos(lat * D2R) ** 2;

export function surfaceClass(z, lat) {
  if (z <= 0) return z > -200 ? CLASS.sand : CLASS.silt;
  const snow = snowLine(lat);
  if (Math.abs(lat) > 66 && z > 0) return z > 10 ? CLASS.ice : CLASS.sand;
  if (z > snow) return CLASS.snow;
  if (z > snow * 0.62) return CLASS.rock;
  return z < 15 ? CLASS.sand : CLASS.grass;
}

// The class of a voxel d layers below its column's top.
export function layerClass(surface, d) {
  if (d === 0) return surface;
  if (surface === CLASS.grass && d < 3) return CLASS.dirt;
  if (surface === CLASS.ice && d < 4) return CLASS.ice;
  return CLASS.stone;
}

// Whole voxels: top[k] = round(z / step), the column filling layers
// base .. top - 1 (layer t spans t step .. (t + 1) step metres), and the
// sea, where top < 0, filling top .. -1. base is two layers under the
// lowest top, so the block has a floor. A column with no elevation (NaN)
// is empty: top = base, and missing[k] = 1.
export function quantise(z, step) {
  const top = new Int32Array(z.length), missing = new Uint8Array(z.length);
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < z.length; k++) {
    if (!(z[k] === z[k])) { missing[k] = 1; continue; }
    top[k] = Math.round(z[k] / step);
    lo = Math.min(lo, top[k]); hi = Math.max(hi, top[k]);
  }
  if (lo === Infinity) lo = hi = 0;
  const base = lo - 2;
  let solid = 0, water = 0;
  for (let k = 0; k < z.length; k++) {
    if (missing[k]) { top[k] = base; continue; }
    solid += top[k] - base; water += Math.max(0, -top[k]);
  }
  return { top, base, lo, hi: Math.max(hi, 0), solid, water, missing };
}

// Voxels a viewer can see: from the lowest neighbouring top (or the floor
// at the block's edge) up to the column's own top.
export function shellFloor(top, ni, nj, base) {
  const out = new Int32Array(top.length);
  for (let j = 0; j < nj; j++)
    for (let i = 0; i < ni; i++) {
      const k = j * ni + i;
      if (i === 0 || j === 0 || i === ni - 1 || j === nj - 1) { out[k] = base; continue; }
      out[k] = Math.max(base, Math.min(top[k - 1], top[k + 1], top[k - ni], top[k + ni], top[k]) - 1);
    }
  return out;
}

// A MagicaVoxel .vox file (version 150) of the block: x east, y north,
// z up, the shell of each column with its layers' classes, and the sea as
// water where water is set. With tops ({ rgb, has } from columnColours),
// a land column's top voxel takes its colour from the cube. Throws where
// the block is over 256 voxels on a side, the format's limit.
export function writeVox(q, ni, nj, surface, { water = true, tops = null } = {}) {
  const { top, base } = q, nz = Math.max(q.hi, 0) - base;
  if (ni > 256 || nj > 256 || nz > 256)
    throw new Error(`the block is ${ni} x ${nj} x ${nz} voxels, and a .vox model stops at 256 on a side`);
  const floor = shellFloor(top, ni, nj, base), vox = [];
  for (let j = 0; j < nj; j++)
    for (let i = 0; i < ni; i++) {
      const k = j * ni + i;
      const img = tops && tops.has[k] && top[k] > 0
        ? cubeIndex(tops.rgb[3 * k], tops.rgb[3 * k + 1], tops.rgb[3 * k + 2]) : 0;
      for (let t = floor[k]; t < top[k]; t++) {
        const d = top[k] - 1 - t;
        vox.push(i, j, t - base, d === 0 && img ? img : layerClass(surface[k], d));
      }
      if (water && !(q.missing && q.missing[k])) for (let t = top[k]; t < 0; t++) {
        const edge = i === 0 || j === 0 || i === ni - 1 || j === nj - 1;
        if (t === -1 || edge) vox.push(i, j, t - base, CLASS.water);
      }
    }
  const count = vox.length / 4;
  const size = 12, xyzi = 4 + 4 * count, rgba = 1024;
  const children = (12 + size) + (12 + xyzi) + (12 + rgba);
  const buf = new ArrayBuffer(8 + 12 + children), dv = new DataView(buf), u8 = new Uint8Array(buf);
  let o = 0;
  const id = (s) => { for (let c = 0; c < 4; c++) u8[o++] = s.charCodeAt(c); };
  const i32 = (v) => { dv.setInt32(o, v, true); o += 4; };
  id("VOX "); i32(150);
  id("MAIN"); i32(0); i32(children);
  id("SIZE"); i32(size); i32(0); i32(ni); i32(nj); i32(nz);
  id("XYZI"); i32(xyzi); i32(0); i32(count);
  u8.set(vox, o); o += vox.length;
  id("RGBA"); i32(rgba); i32(0);
  for (let c = 1; c <= 256; c++) {
    const p = paletteRgb(c);
    const [r, g, b] = p || [0, 0, 0];
    u8[o++] = r; u8[o++] = g; u8[o++] = b; u8[o++] = p ? 255 : 0;
  }
  return { bytes: u8, count, size: [ni, nj, nz] };
}

// Read a .vox file back: its size and voxels as [x, y, z, colour] rows.
export function readVox(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const id = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (id(0) !== "VOX ") throw new Error("not a .vox file");
  let o = 20, size = null, voxels = null, palette = null;
  while (o < u8.length) {
    const name = id(o), n = dv.getInt32(o + 4, true), body = o + 12;
    if (name === "SIZE") size = [0, 4, 8].map((d) => dv.getInt32(body + d, true));
    if (name === "XYZI") {
      const count = dv.getInt32(body, true);
      voxels = [];
      for (let v = 0; v < count; v++) voxels.push(Array.from(u8.subarray(body + 4 + 4 * v, body + 8 + 4 * v)));
    }
    if (name === "RGBA") palette = u8.subarray(body, body + 1024);
    o = body + n + dv.getInt32(o + 8, true);
  }
  return { version: dv.getInt32(4, true), size, voxels, palette };
}
