// Overlapping mosaics: two or more rasters that cover the same ground on
// different grids, read into one map. As the wxylib design note on
// overlapping COG mosaics puts it, there are two problems, kept apart:
// overlap is a question for the plan (where sources cover the same cells,
// which one is read), and the grid is a question for each source (its own
// cells, which never line up with the others'). Here the plan is chosen
// per pixel of the map, and each source is sampled on its own grid.
//
// A window is a piece of one source's grid: { data, width, height, x0, y0,
// dx, dy, nodata } with (x0, y0) the top left corner in the source's own
// coordinates and dy positive (rows run down).

// The ways to combine a primary source (IBCSO, say) with a fallback
// (GEBCO): either alone, the primary wherever it has data, a cut at a
// latitude, or the difference where both have data.
export const PLANS = [
  { key: "first", label: "IBCSO, then GEBCO" },
  { key: "cut", label: "Cut at a latitude" },
  { key: "ibcso", label: "IBCSO only" },
  { key: "gebco", label: "GEBCO only" },
  { key: "diff", label: "IBCSO minus GEBCO" }
];

// Which source a pixel is read from: 1 the primary, 2 the fallback, 3 both
// (difference), 0 none. has1 and has2 say whether each has a value there.
export function pick(plan, lat, has1, has2, cut = -60) {
  switch (plan) {
    case "ibcso": return has1 ? 1 : 0;
    case "gebco": return has2 ? 2 : 0;
    case "cut": return lat <= cut ? (has1 ? 1 : has2 ? 2 : 0) : (has2 ? 2 : 0);
    case "diff": return has1 && has2 ? 3 : 0;
    default: return has1 ? 1 : has2 ? 2 : 0;
  }
}

// The level of a pyramid (finest first, each { res } in source units per
// pixel) to read for a map whose pixels are px source units across: the
// coarsest level still at least as fine as px, then coarser while the
// window (w x h source units) would be more than max pixels on a side.
export function chooseLevel(levels, px, w, h, max = 2048) {
  let k = 0;
  for (let i = 0; i < levels.length; i++) if (levels[i].res <= px * 1.0001) k = i;
  while (k < levels.length - 1 && Math.max(w, h) / levels[k].res > max) k++;
  return k;
}

// The pixel window [c0, r0, c1, r1) of a level covering the box [xmin,
// ymin, xmax, ymax] (source units) with pad pixels round it, clipped to
// the level, or null where the box misses it. The level's top left corner
// is (x0, y0) and its pixels res across.
export function windowOf(level, box, pad = 2) {
  const { x0, y0, res, width, height } = level;
  const c0 = Math.max(0, Math.floor((box[0] - x0) / res) - pad), c1 = Math.min(width, Math.ceil((box[2] - x0) / res) + pad);
  const r0 = Math.max(0, Math.floor((y0 - box[3]) / res) - pad), r1 = Math.min(height, Math.ceil((y0 - box[1]) / res) + pad);
  return c1 > c0 && r1 > r0 ? [c0, r0, c1, r1] : null;
}

// Whether window win holds the box at a pixel size no coarser than px.
export function covers(win, box, px) {
  if (!win) return false;
  const x1 = win.x0 + win.width * win.dx, y1 = win.y0 - win.height * win.dy;
  return win.dx <= px * 1.0001 && box[0] >= win.x0 && box[2] <= x1 && box[3] <= win.y0 && box[1] >= y1;
}

// The value of a window at (x, y), bilinear on cell centres, or NaN off
// the window or where any of the four cells is nodata (nearest is then
// tried, so coastlines keep their cells).
export function sample(win, x, y) {
  if (!win) return NaN;
  const { data, width: W, height: H, x0, y0, dx, dy, nodata } = win;
  const u = (x - x0) / dx - 0.5, v = (y0 - y) / dy - 0.5;
  if (u < -0.5 || v < -0.5 || u > W - 0.5 || v > H - 0.5) return NaN;
  const i0 = Math.max(0, Math.min(W - 2, Math.floor(u))), j0 = Math.max(0, Math.min(H - 2, Math.floor(v)));
  const fu = Math.max(0, Math.min(1, u - i0)), fv = Math.max(0, Math.min(1, v - j0));
  const k = j0 * W + i0;
  const a = data[k], b = data[k + 1], c = data[k + W], d = data[k + W + 1];
  const bad = (z) => z === nodata || !Number.isFinite(z);
  if (bad(a) || bad(b) || bad(c) || bad(d)) {
    const n = Math.round(v) * W + Math.round(u);
    const z = data[Math.max(0, Math.min(W * H - 1, n))];
    return bad(z) ? NaN : z;
  }
  return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
}

// The same, but beside nodata the valid corners are weighted on their own
// (a coarse field such as sea ice then runs up to the coast smoothly
// instead of in steps); NaN only where all four are nodata.
export function sampleValid(win, x, y) {
  if (!win) return NaN;
  const { data, width: W, height: H, x0, y0, dx, dy, nodata } = win;
  const u = (x - x0) / dx - 0.5, v = (y0 - y) / dy - 0.5;
  if (u < -0.5 || v < -0.5 || u > W - 0.5 || v > H - 0.5) return NaN;
  const i0 = Math.max(0, Math.min(W - 2, Math.floor(u))), j0 = Math.max(0, Math.min(H - 2, Math.floor(v)));
  const fu = Math.max(0, Math.min(1, u - i0)), fv = Math.max(0, Math.min(1, v - j0));
  const k = j0 * W + i0;
  const z = [data[k], data[k + 1], data[k + W], data[k + W + 1]], w = [(1 - fu) * (1 - fv), fu * (1 - fv), (1 - fu) * fv, fu * fv];
  let sum = 0, wt = 0;
  for (let n = 0; n < 4; n++) if (z[n] !== nodata && Number.isFinite(z[n])) { sum += z[n] * w[n]; wt += w[n]; }
  return wt > 1e-9 ? sum / wt : NaN;
}

// The cell (i, j) of a grid { x0, y0, dx, dy, width, height } holding (x, y).
export function cellIndex(g, x, y) {
  const i = Math.floor((x - g.x0) / g.dx), j = Math.floor((g.y0 - y) / g.dy);
  return i >= 0 && j >= 0 && i < g.width && j < g.height ? [i, j] : null;
}

// Colours. Ocean depths and land as playproj's basemap tints, but land in
// the far south (ice sheet and shelves) in greys and whites.
const OCEAN = [[-9000, 8, 20, 50], [-6000, 16, 45, 95], [-4000, 28, 78, 140], [-2000, 50, 115, 180], [-200, 95, 165, 215], [0, 165, 212, 236]];
const LAND = [[0, 72, 122, 72], [300, 122, 152, 92], [1000, 172, 162, 112], [2000, 152, 122, 92], [3500, 205, 196, 186], [5500, 252, 252, 252]];
const ICE = [[0, 170, 182, 196], [500, 198, 208, 220], [1500, 222, 229, 238], [3000, 244, 247, 251], [4500, 255, 255, 255]];

function ramp(stops, z, out, k) {
  if (z <= stops[0][0]) { const s = stops[0]; out[k] = s[1]; out[k + 1] = s[2]; out[k + 2] = s[3]; return; }
  for (let i = 1; i < stops.length; i++) {
    if (z <= stops[i][0]) {
      const [z0, r0, g0, b0] = stops[i - 1], [z1, r1, g1, b1] = stops[i], t = (z - z0) / (z1 - z0);
      out[k] = r0 + t * (r1 - r0); out[k + 1] = g0 + t * (g1 - g0); out[k + 2] = b0 + t * (b1 - b0);
      return;
    }
  }
  const s = stops[stops.length - 1]; out[k] = s[1]; out[k + 1] = s[2]; out[k + 2] = s[3];
}

// Tint for elevation z (metres) at latitude lat into out[k..k+2].
export function tint(z, lat, out, k) {
  ramp(z <= 0 ? OCEAN : lat < -60 ? ICE : LAND, z, out, k);
}

// Source colours for the "which source" view: primary, fallback, both.
export const SOURCE_RGB = { 1: [96, 170, 255], 2: [255, 170, 80], 3: [200, 120, 255] };

// The map as RGBA: elevation elev (W x H, NaN where none) tinted and
// hillshaded at px metres a pixel (sun from the north-west of the screen),
// in mode "relief", "source" (tinted by which source each pixel came from,
// src) or "diff" (elev holds differences; blue below, red above, at
// +-range metres).
export function shade(elev, src, lat, W, H, px, mode = "relief", range = 100, out = new Uint8ClampedArray(W * H * 4)) {
  const zx = 8;   // vertical exaggeration
  const sun = [-0.5, 0.5, 0.7071];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i, o = k * 4, z = elev[k];
      if (!Number.isFinite(z)) { out[o] = 10; out[o + 1] = 14; out[o + 2] = 24; out[o + 3] = 255; continue; }
      if (mode === "diff") {
        const t = Math.max(-1, Math.min(1, z / range)), a = Math.abs(t);
        const c = t < 0 ? [40, 110, 230] : [230, 70, 50];
        out[o] = 236 + (c[0] - 236) * a; out[o + 1] = 236 + (c[1] - 236) * a; out[o + 2] = 236 + (c[2] - 236) * a; out[o + 3] = 255;
        continue;
      }
      const zl = Number.isFinite(elev[k - 1]) && i > 0 ? elev[k - 1] : z, zr = Number.isFinite(elev[k + 1]) && i < W - 1 ? elev[k + 1] : z;
      const zu = j > 0 && Number.isFinite(elev[k - W]) ? elev[k - W] : z, zd = j < H - 1 && Number.isFinite(elev[k + W]) ? elev[k + W] : z;
      const gx = ((zr - zl) * zx) / (2 * px), gy = ((zu - zd) * zx) / (2 * px);
      const s = Math.max(0, (-gx * sun[0] - gy * sun[1] + sun[2]) / Math.hypot(gx, gy, 1));
      const f = 0.5 + 0.7 * s;
      if (mode === "source") {
        const c = SOURCE_RGB[src[k]] || [120, 120, 120], g = z > 0 ? 0.95 : 0.55;
        out[o] = c[0] * g * f; out[o + 1] = c[1] * g * f; out[o + 2] = c[2] * g * f;
      } else {
        tint(z, lat[k], out, o);
        out[o] *= f; out[o + 1] *= f; out[o + 2] *= f;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

// Grid lines of a source near a point, for drawing its cells: the cell
// edges x = x0 + i dx and y = y0 - j dy within half pixels n cells of
// (x, y), as { xs, ys } in source units, or null where n cells would be
// more than max lines.
export function gridLines(g, x, y, n = 6, max = 80) {
  if (2 * n + 1 > max) return null;
  const ci = Math.floor((x - g.x0) / g.dx), cj = Math.floor((g.y0 - y) / g.dy);
  const xs = [], ys = [];
  for (let i = ci - n; i <= ci + n + 1; i++) xs.push(g.x0 + i * g.dx);
  for (let j = cj - n; j <= cj + n + 1; j++) ys.push(g.y0 - j * g.dy);
  return { xs, ys, ci, cj };
}
