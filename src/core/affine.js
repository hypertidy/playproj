// Affine georeferencing: the six-number geotransform that takes a pixel's
// column and row to x and y in a CRS, its inverse, the extent and world file
// forms of it, and fitting it to ground control points (a pixel and the
// place it shows) by least squares.
//
// A geotransform is GDAL's [gt0, gt1, gt2, gt3, gt4, gt5]:
//   x = gt0 + col * gt1 + row * gt2
//   y = gt3 + col * gt4 + row * gt5
// with col and row measured from the top-left corner of the top-left pixel
// (pixel centres are at col + 0.5, row + 0.5). North up means gt2 = gt4 = 0
// and gt5 < 0.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export const IDENTITY = [0, 1, 0, 0, 0, 1];

export const apply = (gt, col, row) => [gt[0] + col * gt[1] + row * gt[2], gt[3] + col * gt[4] + row * gt[5]];

export const det = (gt) => gt[1] * gt[5] - gt[2] * gt[4];

// The geotransform that goes back from x, y to col, row (null if the pixels
// have no area: the two columns of the matrix are parallel).
export function invert(gt) {
  const d = det(gt);
  if (!d || !isFinite(d)) return null;
  const a = gt[5] / d, b = -gt[2] / d, c = -gt[4] / d, e = gt[1] / d;
  return [-(a * gt[0] + b * gt[3]), a, b, -(c * gt[0] + e * gt[3]), c, e];
}

// gt after m: the geotransform of an image whose pixel col, row is pixel
// m(col, row) of an image with geotransform gt (m in geotransform form, a
// pixel-to-pixel affine).
export const compose = (gt, m) => [
  gt[0] + gt[1] * m[0] + gt[2] * m[3], gt[1] * m[1] + gt[2] * m[4], gt[1] * m[2] + gt[2] * m[5],
  gt[3] + gt[4] * m[0] + gt[5] * m[3], gt[4] * m[1] + gt[5] * m[4], gt[4] * m[2] + gt[5] * m[5]
];

export const isNorthUp = (gt, eps = 1e-12) => Math.abs(gt[2]) <= eps * Math.abs(gt[1]) && Math.abs(gt[4]) <= eps * Math.abs(gt[5]) && gt[5] < 0;

// North-up geotransform from an extent and the grid's dimensions, and back.
export const fromExtent = ([xmin, xmax, ymin, ymax], ncol, nrow) => [xmin, (xmax - xmin) / ncol, 0, ymax, 0, -(ymax - ymin) / nrow];

// The bounding box of the image's four corners: the extent itself when north
// up, the box round the parallelogram otherwise.
export function extent(gt, ncol, nrow) {
  const c = corners(gt, ncol, nrow);
  const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
  return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
}

// Top-left, top-right, bottom-right, bottom-left, as x, y.
export const corners = (gt, ncol, nrow) => [[0, 0], [ncol, 0], [ncol, nrow], [0, nrow]].map(([c, r]) => apply(gt, c, r));

// Build a geotransform from parts: the top-left corner x0, y0, the pixel
// width and height (both positive, height measured down the image), the
// rotation of the image clockwise on the map in degrees, and the shear in
// degrees (the lean of the columns: 0 keeps them at right angles to the
// rows). The matrix is rotation * scale * shear:
//   [cos -sin] [w  0] [1 tan(shear)]
//   [sin  cos] [0 -h] [0     1     ]
// with the rotation angle negated so positive turns clockwise.
export function fromParts({ x0, y0, w, h, rot = 0, shear = 0 }) {
  const t = -rot * D2R, c = Math.cos(t), s = Math.sin(t), k = Math.tan(shear * D2R);
  // scale * shear = [[w, w k], [0, -h]]
  const m00 = w, m01 = w * k, m10 = 0, m11 = -h;
  return [x0, c * m00 - s * m10, c * m01 - s * m11, y0, s * m00 + c * m10, s * m01 + c * m11];
}

// The parts back from a geotransform (the inverse of fromParts, for any
// geotransform whose rows run left to right on the map, det < 0).
export function toParts(gt) {
  const [x0, a, b, y0, d, e] = gt;
  const w = Math.hypot(a, d), t = Math.atan2(d, a);
  const c = Math.cos(t), s = Math.sin(t);
  // undo the rotation: R^T [[a b], [d e]] = [[w, w k], [0, -h]]
  const m01 = c * b + s * e, m11 = -s * b + c * e;
  return { x0, y0, w, h: -m11, rot: -t * R2D, shear: Math.atan2(m01 / w, 1) * R2D };
}

// World file (ESRI): six lines A, D, B, E, C, F where x = A col + B row + C
// and y = D col + E row + F, but col and row are pixel centres counted from
// 0, so C, F is the centre of the top-left pixel, half a pixel in from the
// geotransform's corner.
export function worldFile(gt) {
  const C = gt[0] + 0.5 * gt[1] + 0.5 * gt[2], F = gt[3] + 0.5 * gt[4] + 0.5 * gt[5];
  return [gt[1], gt[4], gt[2], gt[5], C, F];
}
export function fromWorldFile(wf) {
  const v = typeof wf === "string" ? wf.trim().split(/\s+/).map(Number) : wf;
  if (v.length !== 6 || !v.every(isFinite)) return null;
  const [A, D, B, E, C, F] = v;
  return [C - 0.5 * A - 0.5 * B, A, B, F - 0.5 * D - 0.5 * E, D, E];
}
export const worldFileText = (gt, digits = 12) => worldFile(gt).map((v) => fmt(v, digits)).join("\n") + "\n";

// A number with up to digits significant figures and no trailing zeros.
export function fmt(v, digits = 12) {
  if (!isFinite(v)) return String(v);
  if (v === 0) return "0";
  const s = Number(v.toPrecision(digits));
  return String(Object.is(s, -0) ? 0 : s);
}

// ---------------------------------------------------------------- fitting

// Fit kinds: how many numbers each finds and how many points it needs.
//   northup: x = gt0 + col gt1, y = gt3 + row gt5 (4 numbers; 2 points not
//            in the same row or column)
//   similarity: square pixels, any rotation (4 numbers: offset, size and
//            angle; 2 distinct points)
//   affine: all six (3 points not in a line)
export const FITS = {
  northup: { label: "North up", min: 2 },
  similarity: { label: "Rotate and scale", min: 2 },
  affine: { label: "Full affine", min: 3 }
};

// Least squares by the normal equations: rows of A (each a list of n
// numbers) and b; null if singular.
export function lsq(A, b) {
  const n = A[0].length, N = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  A.forEach((row, k) => {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) N[i][j] += row[i] * row[j];
      N[i][n] += row[i] * b[k];
    }
  });
  // Gauss-Jordan with partial pivoting, scaled to the matrix
  const scale = Math.max(...N.map((r) => Math.max(...r.slice(0, n).map(Math.abs)))) || 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(N[r][c]) > Math.abs(N[p][c])) p = r;
    if (Math.abs(N[p][c]) < 1e-12 * scale) return null;
    [N[c], N[p]] = [N[p], N[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = N[r][c] / N[c][c];
      for (let j = c; j <= n; j++) N[r][j] -= f * N[c][j];
    }
  }
  return N.map((r, i) => r[n] / r[i]);
}

// Fit a geotransform to points [{ col, row, x, y }]. Returns { gt,
// residuals: [{ dx, dy, d }] in x, y units, rmse } or { error } when there
// are too few points or they do not pin it down. The columns and rows are
// centred first so the normal equations stay well conditioned.
export function fit(points, kind = "northup") {
  const need = FITS[kind].min;
  if (points.length < need) return { error: `${FITS[kind].label} needs ${need} points; there ${points.length === 1 ? "is 1" : `are ${points.length}`}.` };
  const mc = mean(points.map((p) => p.col)), mr = mean(points.map((p) => p.row));
  const mx = mean(points.map((p) => p.x)), my = mean(points.map((p) => p.y));
  const P = points.map((p) => ({ c: p.col - mc, r: p.row - mr, x: p.x - mx, y: p.y - my }));
  let g; // centred geotransform: x - mx = g0 + c g1 + r g2, likewise y
  if (kind === "northup") {
    const gx = lsq(P.map((p) => [1, p.c]), P.map((p) => p.x));
    const gy = lsq(P.map((p) => [1, p.r]), P.map((p) => p.y));
    if (!gx || !gy) return { error: "The points need to differ in both column and row." };
    g = [gx[0], gx[1], 0, gy[0], 0, gy[1]];
  } else if (kind === "similarity") {
    // x = tx + p c + q r, y = ty + q c - p r: square pixels with rows
    // running down the image and y up the map
    const A = [], b = [];
    for (const p of P) { A.push([1, 0, p.c, p.r]); b.push(p.x); A.push([0, 1, -p.r, p.c]); b.push(p.y); }
    const s = lsq(A, b);
    if (!s) return { error: "The points need to be in different places." };
    g = [s[0], s[2], s[3], s[1], s[3], -s[2]];
  } else {
    const gx = lsq(P.map((p) => [1, p.c, p.r]), P.map((p) => p.x));
    const gy = lsq(P.map((p) => [1, p.c, p.r]), P.map((p) => p.y));
    if (!gx || !gy) return { error: "The points must not lie in a line." };
    g = [gx[0], gx[1], gx[2], gy[0], gy[1], gy[2]];
  }
  // uncentre: x = mx + g0 + (col - mc) g1 + (row - mr) g2
  const gt = [mx + g[0] - mc * g[1] - mr * g[2], g[1], g[2], my + g[3] - mc * g[4] - mr * g[5], g[4], g[5]];
  if (!det(gt)) return { error: "The fit gives pixels with no area." };
  const residuals = points.map((p) => {
    const [x, y] = apply(gt, p.col, p.row), dx = x - p.x, dy = y - p.y;
    return { dx, dy, d: Math.hypot(dx, dy) };
  });
  const rmse = Math.sqrt(mean(residuals.map((r) => r.d * r.d)));
  return { gt, residuals, rmse, spare: points.length - need };
}

const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
