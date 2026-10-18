// Tissot indicatrices drawn on a 2D canvas, from the factors tissot.js
// computes.

import { factors, ellipse } from "./tissot.js";

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
