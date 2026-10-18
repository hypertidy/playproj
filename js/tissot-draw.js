// Tissot indicatrices drawn on a 2D canvas, from the factors tissot.js
// computes.

import { factors, ellipse, majorAxis } from "./tissot.js";

const D2R = Math.PI / 180;

// Stroke or fill indicatrices on a 2D canvas. `toPx` maps plane [x, y] to
// canvas pixels; points is an array of factor objects with x, y set.
export function drawIndicatrix(ctx, f, toPx, r, style = {}) {
  const ring = ellipse(f, f.x, f.y, r, style.n || 48);
  ctx.beginPath();
  for (let i = 0; i < ring.length; i += 2) {
    const [px, py] = toPx(ring[i], ring[i + 1]);
    if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
  }
  ctx.closePath();
  if (style.fill) { ctx.fillStyle = style.fill; ctx.fill(); }
  if (style.stroke) { ctx.strokeStyle = style.stroke; ctx.lineWidth = style.width || 1; ctx.stroke(); }
  if (style.axes) {
    // images of the parallel (east) and meridian (north) through the point
    const [cx, cy] = toPx(f.x, f.y);
    for (const [v, col] of [[f.east, style.axes[0]], [f.north, style.axes[1]]]) {
      const [ex, ey] = toPx(f.x + v[0] * r, f.y + v[1] * r);
      ctx.strokeStyle = col; ctx.lineWidth = style.axisWidth || 1.2;
      ctx.beginPath(); ctx.moveTo(2 * cx - ex, 2 * cy - ey); ctx.lineTo(ex, ey); ctx.stroke();
    }
  }
}

// Indicatrices on a lon/lat lattice about lon0, for overlaying on a map that
// is drawn elsewhere: `fwd` is the page's own forward function (plane units)
// and `toPx` its pixel transform. Circles of `size` degrees, `step` apart.
export function drawLattice(ctx, fwd, toPx, { lon0 = 0, step = 30, size = 6, es = 0, maxR = Infinity, style } = {}) {
  const r = size * D2R;
  style = style || { fill: "rgba(255,153,0,0.42)", stroke: "#ffb347", width: 1, axes: ["#ff5a5a", "#5aa0ff"] };
  for (let lat = -90 + step; lat < 90; lat += step) {
    for (let dl = -180 + step; dl < 180; dl += step) {
      const lon = ((lon0 + dl + 540) % 360) - 180;
      const xy = fwd(lon, lat);
      const f = xy && factors(fwd, lon, lat, { es });
      if (!f || f.a * r > maxR) continue;
      f.x = xy[0]; f.y = xy[1];
      drawIndicatrix(ctx, f, toPx, r, style);
    }
  }
}

// One indicatrix, large, in a box of `size` pixels at x, y (top left): the
// unit circle dashed, the ellipse, its axes a and b, and the images of the
// parallel (k) and meridian (h).
export function drawInset(ctx, f, x, y, size, c = {}) {
  const pad = 16, R = (size / 2 - pad) / Math.max(1, f.a), cx = x + size / 2, cy = y + size / 2;
  const toPx = (u, v) => [cx + u * R, cy - v * R];
  ctx.save();
  ctx.fillStyle = c.bg || "rgba(5,7,13,0.82)"; ctx.strokeStyle = c.frame || "#2c4a73"; ctx.lineWidth = 1;
  ctx.fillRect(x, y, size, size); ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  ctx.beginPath(); ctx.rect(x, y, size, size); ctx.clip();
  // true scale
  ctx.setLineDash([3, 3]); ctx.strokeStyle = c.unit || "rgba(220,230,245,0.6)";
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
  const g = { ...f, x: 0, y: 0 };
  drawIndicatrix(ctx, g, toPx, 1, { fill: c.fill || "rgba(255,211,77,0.3)", stroke: c.edge || "#ffd34d", width: 1.5, n: 96 });
  // semi-axes: a along the major direction, b across it
  const th = majorAxis(f), ca = Math.cos(th), sa = Math.sin(th);
  const ax = (len, dx, dy, col, label) => {
    const [ex, ey] = toPx(dx * len, dy * len);
    ctx.strokeStyle = col; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.fillStyle = col; ctx.font = "italic 12px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const d = Math.hypot(ex - cx, ey - cy) || 1;
    ctx.fillText(label, ex + ((ex - cx) / d) * 9, ey + ((ey - cy) / d) * 9);
  };
  ax(f.a, ca, sa, c.axis || "#f1e3b0", "a");
  ax(f.b, -sa, ca, c.axis || "#f1e3b0", "b");
  // parallel and meridian through the point
  for (const [v, col, label] of [[f.east, c.par || "#ff5a5a", "k"], [f.north, c.mer || "#5aa0ff", "h"]]) {
    const [ex, ey] = toPx(v[0], v[1]), [bx, by] = toPx(-v[0], -v[1]);
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.fillStyle = col; ctx.font = "italic 11px system-ui, sans-serif";
    // labelled at the far end from the axes' a and b
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const d = Math.hypot(bx - cx, by - cy) || 1;
    ctx.fillText(label, bx + ((bx - cx) / d) * 8, by + ((by - cy) / d) * 8);
  }
  ctx.restore();
}

// Contour segments (flat [x1, y1, x2, y2, ...] in grid units) stroked onto
// a canvas through toPx, with a few labels spread along them.
export function drawContours(ctx, segs, toPx, { color = "rgba(235,240,250,0.7)", width = 1, label = null, gap = 60, max = 6, taken = [] } = {}) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.beginPath();
  for (let k = 0; k < segs.length; k += 4) {
    const [x1, y1] = toPx(segs[k], segs[k + 1]), [x2, y2] = toPx(segs[k + 2], segs[k + 3]);
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
  }
  ctx.stroke();
  if (label) {
    ctx.font = "11px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(5,7,13,0.9)"; ctx.fillStyle = color;
    let n = 0;
    for (let k = 0; k < segs.length && n < max; k += 4) {
      const [x, y] = toPx((segs[k] + segs[k + 2]) / 2, (segs[k + 1] + segs[k + 3]) / 2);
      if (taken.some(([u, v]) => Math.hypot(u - x, v - y) < gap)) continue;
      taken.push([x, y]); n++;
      ctx.strokeText(label, x, y); ctx.fillText(label, x, y);
    }
  }
  ctx.restore();
}
