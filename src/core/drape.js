// Imagery draped over the station scene's patches (src/core/station.js):
// for each patch a texture over its own cells, in its own grid (polar
// stereographic), warped from images in another (Sentinel-2's tiles are
// in UTM), and faded in from wherever the images have nothing. The
// patches' vertices take texture coordinates from where they are drawn.
// Pure: the reading is js/navigate-station.js's.

import { PS } from "./station.js";

// Sentinel-2's Level-2A tiles (Collection 1) as Cloud Optimized GeoTIFFs
// on AWS, found through Element 84's Earth Search STAC API: the true-colour
// image ("visual", TCI.tif), 8-bit RGB at 10 m with overviews at 20, 40, 80
// and 160 m. Both answer a page on any site (CORS).
export const S2 = {
  stac: "https://earth-search.aws.element84.com/v1",
  collection: "sentinel-2-c1-l2a",
  asset: "visual",
  res: 10
};

// A clear summer pass over each station, chosen by eye: the tile over the
// station; the page reads its neighbours from the same pass (the same
// datatake, the time in the name after the tile's). The South Pole has
// none: Sentinel-2's orbit never takes it over the pole.
export const S2_SCENES = {
  davis: "S2B_T43DFD_20240130T035649_L2A",
  mawson: "S2B_T41DMF_20230202T045727_L2A",
  casey: "S2B_T49DDG_20191216T015536_L2A",
  mcmurdo: "S2B_T58CEU_20210123T200531_L2A",
  rothera: "S2B_T19DEF_20210126T132924_L2A",
  concordia: "S2B_T51CWS_20201227T233800_L2A"
};

// An item's name in parts: the satellite, the MGRS tile and the datatake
// (the pass), or null.
export function s2Name(id) {
  const m = /^(S2[ABC])_T(\d{2}[C-X][A-Z]{2})_(\d{8}T\d{6})_L2A$/.exec(String(id));
  return m ? { sat: m[1], tile: m[2], take: m[3] } : null;
}

// ---------------------------------------------------------------- UTM

// UTM's zone from an EPSG code (326zz north, 327zz south), or null.
export function utmOf(epsg) {
  const s = Math.floor(epsg / 100), zone = epsg % 100;
  if ((s !== 326 && s !== 327) || zone < 1 || zone > 60) return null;
  return { zone, south: s === 327, lon0: 6 * zone - 183 };
}

// Transverse Mercator on WGS84 by Krüger's series (as in Karney 2011, to
// n cubed: well under a millimetre across a zone and its neighbours).
const RAD = Math.PI / 180, WA = 6378137, WF = 1 / 298.257223563, K0 = 0.9996;
const n1 = WF / (2 - WF), n2 = n1 * n1, n3 = n2 * n1;
const AA = (WA / (1 + n1)) * (1 + n2 / 4 + (n2 * n2) / 64);
const ALPHA = [n1 / 2 - (2 * n2) / 3 + (5 * n3) / 16, (13 * n2) / 48 - (3 * n3) / 5, (61 * n3) / 240];
const E1 = (2 * Math.sqrt(n1)) / (1 + n1);

// lon, lat to easting and northing in zone u (utmOf); null more than 60
// degrees of longitude from its middle, where the series is no use
export function utmForward(lon, lat, u, out = [0, 0]) {
  const d = ((((lon - u.lon0 + 180) % 360) + 360) % 360) - 180;
  if (Math.abs(d) > 60 || Math.abs(lat) >= 90) return null;
  const s = Math.sin(lat * RAD), lam = d * RAD;
  const t = Math.sinh(Math.atanh(s) - E1 * Math.atanh(E1 * s));
  const xi = Math.atan2(t, Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let x = eta, y = xi;
  for (let j = 1; j <= 3; j++) {
    x += ALPHA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    y += ALPHA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  out[0] = 500000 + K0 * AA * x;
  out[1] = (u.south ? 1e7 : 0) + K0 * AA * y;
  return out;
}

// ---------------------------------------------------------------- textures

// A patch's cells' outer edges, from its axes (cell middles).
export function cellExtent(ax) {
  const dx = ax.xs[1] - ax.xs[0], dy = ax.ys[0] - ax.ys[1];
  return { left: ax.xs[0] - dx / 2, right: ax.xs[ax.w - 1] + dx / 2, top: ax.ys[0] + dy / 2, bottom: ax.ys[ax.h - 1] - dy / 2 };
}

// A texture's size for a patch so many metres across: a power of two,
// texels no bigger than 5 m, between 64 and 1024 (so the 2 m patch's
// kilometre has 256, and the others 1024).
export const textureSize = (across) => Math.min(1024, Math.max(64, 2 ** Math.ceil(Math.log2(across / 5))));

// Of an image's levels ({ res }, any order), the coarsest whose pixels are
// no more than half as big again as texel metres, else the finest. (The
// 32 m patch's 16 m texels so take Sentinel-2's 20 m overview: a quarter
// of the bytes of its 10 m pixels, which only the two finest patches
// read.)
export function pickOverview(levels, texel) {
  let best = null, finest = null;
  for (const l of levels) {
    if (!finest || l.res < finest.res) finest = l;
    if (l.res <= texel * 1.5 && (!best || l.res > best.res)) best = l;
  }
  return best || finest;
}

// Where an n by n texture over ext takes its texels from, every step
// texels (and the last row and column of nodes past the texture's edge,
// so every texel is between four): f(x, y) gives the image's pixel
// coordinates for x, y in the patch's grid, or null. { K, step, n, at }:
// at holds K + 1 by K + 1 pairs, NaN where f gave null.
export function lattice(ext, n, step, f) {
  const K = Math.ceil((n - 1) / step), at = new Float64Array(2 * (K + 1) * (K + 1)).fill(NaN);
  const sx = (ext.right - ext.left) / n, sy = (ext.top - ext.bottom) / n;
  for (let b = 0, k = 0; b <= K; b++)
    for (let a = 0; a <= K; a++, k++) {
      const p = f(ext.left + (a * step + 0.5) * sx, ext.top - (b * step + 0.5) * sy);
      if (p) { at[2 * k] = p[0]; at[2 * k + 1] = p[1]; }
    }
  return { K, step, n, at };
}

// The lattice from patch to image as polar stereographic to lon, lat to
// UTM to the pixels of an image at res metres with its corner at ox, oy.
export function utmLattice(ext, n, step, { u, ox, oy, res }) {
  const q = [0, 0];
  return lattice(ext, n, step, (x, y) => {
    const [lon, lat] = PS.inverse(x, y), p = utmForward(lon, lat, u, q);
    return p ? [(p[0] - ox) / res, (oy - p[1]) / res] : null;
  });
}

// The window of an image (w by h pixels) that the lattice's nodes inside
// keep (inside(x, y), pixel coordinates; all by default) fall in, with pad
// pixels round it, clamped to the image: { c0, r0, w, h, nodes }, or null
// if no node falls in the image.
export function latticeWindow(L, w, h, pad = 2, inside = () => true) {
  const { K, at } = L, row = K + 1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, nodes = 0, spread = 0;
  for (let b = 0, k = 0; b <= K; b++)
    for (let a = 0; a <= K; a++, k++) {
      const x = at[2 * k], y = at[2 * k + 1];
      // (the texels between nodes reach out a node's spacing in the image)
      if (a > 0) spread = Math.max(spread, Math.abs(x - at[2 * k - 2]) || 0, Math.abs(y - at[2 * k - 1]) || 0);
      if (b > 0) spread = Math.max(spread, Math.abs(x - at[2 * (k - row)]) || 0, Math.abs(y - at[2 * (k - row) + 1]) || 0);
      if (!(x >= 0 && y >= 0 && x <= w && y <= h) || !inside(x, y)) continue;
      nodes++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  if (!nodes) return null;
  const c0 = Math.max(0, Math.floor(x0 - spread - pad)), r0 = Math.max(0, Math.floor(y0 - spread - pad));
  const c1 = Math.min(w, Math.ceil(x1 + spread + pad)), r1 = Math.min(h, Math.ceil(y1 + spread + pad));
  return c1 > c0 && r1 > r0 ? { c0, r0, w: c1 - c0, h: r1 - r0, nodes } : null;
}

// Fill the texels of rgba (n by n, RGBA, rows from the top) that have
// nothing yet (alpha 0) from an image's window: src { data, w, h, c0, r0,
// mask }, data RGB a pixel in rows. A pixel of 0, 0, 0 has nothing (the
// true-colour image has no nodata value, and is 0 outside the swath),
// unless mask (1 a pixel, from fillRings) says it is inside the tile's
// outline: there it is the darkest water. Each texel is the image
// bilinear between the four pixels round it where all four have
// something, else the nearest that has. Returns how many texels it filled.
export function warpInto(rgba, L, src) {
  const { n, K, step, at } = L, { data, w, h, c0 = 0, r0 = 0, mask = null } = src, row = K + 1;
  const has = (i, j) => { const p = j * w + i, k = 3 * p; return (data[k] | data[k + 1] | data[k + 2]) || (mask && mask[p]); };
  let filled = 0;
  for (let r = 0; r < n; r++) {
    const b = r / step, b0 = Math.min(K - 1, Math.floor(b)), fb = b - b0;
    for (let c = 0; c < n; c++) {
      const o = 4 * (r * n + c);
      if (rgba[o + 3]) continue;
      const a = c / step, a0 = Math.min(K - 1, Math.floor(a)), fa = a - a0;
      const k00 = 2 * (b0 * row + a0), k10 = k00 + 2, k01 = k00 + 2 * row, k11 = k01 + 2;
      const x = (at[k00] * (1 - fa) + at[k10] * fa) * (1 - fb) + (at[k01] * (1 - fa) + at[k11] * fa) * fb - c0 - 0.5;
      const y = (at[k00 + 1] * (1 - fa) + at[k10 + 1] * fa) * (1 - fb) + (at[k01 + 1] * (1 - fa) + at[k11 + 1] * fa) * fb - r0 - 0.5;
      if (!(x > -0.5 && y > -0.5 && x < w - 0.5 && y < h - 0.5)) continue;
      const i0 = Math.max(0, Math.min(w - 2, Math.floor(x))), j0 = Math.max(0, Math.min(h - 2, Math.floor(y)));
      const fx = Math.max(0, Math.min(1, x - i0)), fy = Math.max(0, Math.min(1, y - j0));
      if (w > 1 && h > 1 && has(i0, j0) && has(i0 + 1, j0) && has(i0, j0 + 1) && has(i0 + 1, j0 + 1)) {
        const p = 3 * (j0 * w + i0), q = p + 3 * w;
        for (let ch = 0; ch < 3; ch++)
          rgba[o + ch] = Math.round((data[p + ch] * (1 - fx) + data[p + 3 + ch] * fx) * (1 - fy) + (data[q + ch] * (1 - fx) + data[q + 3 + ch] * fx) * fy);
      } else {
        const i = Math.max(0, Math.min(w - 1, Math.round(x))), j = Math.max(0, Math.min(h - 1, Math.round(y)));
        if (!has(i, j)) continue;
        const p = 3 * (j * w + i);
        rgba[o] = data[p]; rgba[o + 1] = data[p + 1]; rgba[o + 2] = data[p + 2];
      }
      rgba[o + 3] = 255;
      filled++;
    }
  }
  return filled;
}

// Which pixels of a w by h window have their middles inside any of the
// rings (each a list of [x, y] in the window's pixel coordinates, x right
// and y down from its corner): 1 inside, 0 not, a row at a time.
export function fillRings(rings, w, h) {
  const out = new Uint8Array(w * h), xs = [];
  for (let j = 0; j < h; j++) {
    const y = j + 0.5;
    for (const ring of rings) {
      xs.length = 0;
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [xa, ya] = ring[a], [xb, yb] = ring[b];
        if (ya > y !== yb > y) xs.push(xa + ((y - ya) * (xb - xa)) / (yb - ya));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil(xs[k] - 0.5)), i1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
        if (i1 >= i0) out.fill(1, j * w + i0, j * w + i1 + 1);
      }
    }
  }
  return out;
}

// A box blur of v (n by n) along rows (along = 1) or columns (n), radius
// r, what lies past the edge 0 (fade) or the edge's own value (hold).
function boxBlur(v, n, r, along, hold) {
  const out = new Float32Array(v.length), line = new Float64Array(n + 1), span = 2 * r + 1;
  for (let l = 0; l < n; l++) {
    const base = along === 1 ? l * n : l, stride = along === 1 ? 1 : n;
    for (let i = 0; i < n; i++) line[i + 1] = line[i] + v[base + i * stride];
    const first = v[base], last = v[base + (n - 1) * stride];
    for (let i = 0; i < n; i++) {
      const a = i - r, b = i + r;
      let s = line[Math.min(n, b + 1)] - line[Math.max(0, a)];
      if (hold) s += Math.max(0, -a) * first + Math.max(0, b - (n - 1)) * last;
      out[base + i * stride] = s / span;
    }
  }
  return out;
}

// The texture's alpha faded in over about r texels from wherever it has
// nothing, and from its edges too where rim is true (the outermost patch
// with imagery, so it melts into the tints round it); else the edges hold.
// Changes rgba's alpha in place.
export function feather(rgba, n, r, rim = false) {
  r = Math.max(1, Math.round(r / 2));
  let v = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) v[k] = rgba[4 * k + 3] ? 1 : 0;
  for (let pass = 0; pass < 2; pass++) { v = boxBlur(v, n, r, 1, !rim); v = boxBlur(v, n, r, n, !rim); }
  for (let k = 0; k < n * n; k++) {
    if (!rgba[4 * k + 3]) continue;
    const t = Math.min(1, Math.max(0, (v[k] - 0.5) / 0.5));
    rgba[4 * k + 3] = Math.round(255 * t * t * (3 - 2 * t));
  }
}

// Texture coordinates for a patch's vertices (axes ax, its texture over
// ext): from where each vertex is drawn, which for a patch set into a
// coarser one's hole is held to the hole's rim (box { X0, X1, YT, YB },
// as station.js pinEdges moves them). u runs east, v down from the top.
export function patchUv(ax, ext, box = null) {
  const { xs, ys, w, h } = ax, out = new Float32Array(2 * w * h);
  const W = ext.right - ext.left, H = ext.top - ext.bottom;
  for (let j = 0, k = 0; j < h; j++) {
    const y = box ? Math.min(box.YT, Math.max(box.YB, ys[j])) : ys[j];
    for (let i = 0; i < w; i++, k++) {
      const x = box ? Math.min(box.X1, Math.max(box.X0, xs[i])) : xs[i];
      out[2 * k] = (x - ext.left) / W;
      out[2 * k + 1] = (ext.top - y) / H;
    }
  }
  return out;
}

// The hole's rim as pinEdges holds the finer patch to it: the coarser
// patch's vertex lines i0, i1, j0, j1 as x and y.
export const rimBox = (parent, hole) => ({ X0: parent.xs[hole.i0], X1: parent.xs[hole.i1], YT: parent.ys[hole.j0], YB: parent.ys[hole.j1] });

// The lon, lat box round a patch (its edges, sampled), for a STAC search.
export function lonLatBox(ext, k = 8) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (let a = 0; a <= k; a++)
    for (let b = 0; b <= k; b++) {
      if (a > 0 && a < k && b > 0 && b < k) continue;
      const [lon, lat] = PS.inverse(ext.left + ((ext.right - ext.left) * a) / k, ext.bottom + ((ext.top - ext.bottom) * b) / k);
      w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat);
    }
  return [w, s, e, n];
}

// Whether a point is inside a polygon (a ring of [x, y]).
export function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
