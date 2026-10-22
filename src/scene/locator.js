// A locator globe: a small orthographic view of the Earth on a 2D canvas,
// centred on a place, with the coastline and a mark where the scene is.
// The coastline is a list of flat [lon, lat, ...] polylines (js/data.js).

const D2R = Math.PI / 180;

// Orthographic about (lon0, lat0) on a unit sphere: [x, y] or null on the
// far side.
export function ortho(lon0, lat0) {
  const p0 = lat0 * D2R, sp0 = Math.sin(p0), cp0 = Math.cos(p0);
  return (lon, lat) => {
    const p = lat * D2R, l = (lon - lon0) * D2R, cp = Math.cos(p), sp = Math.sin(p), cl = Math.cos(l);
    if (sp0 * sp + cp0 * cp * cl < 0) return null;
    return [cp * Math.sin(l), cp0 * sp - sp0 * cp * cl];
  };
}

// Draw on canvas: the disc, the coastline, and box (a list of [lon, lat]
// outline points, or one point) in accent.
export function drawLocator(canvas, coast, lon0, lat0, box, { ink = "#9fb3c8", sea = "#0d1726", accent = "#ffd34d" } = {}) {
  const ctx = canvas.getContext("2d"), w = canvas.width, h = canvas.height, r = Math.min(w, h) / 2 - 2;
  const P = ortho(lon0, lat0), X = (q) => w / 2 + q[0] * r, Y = (q) => h / 2 - q[1] * r;
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath(); ctx.arc(w / 2, h / 2, r, 0, 2 * Math.PI);
  ctx.fillStyle = sea; ctx.fill(); ctx.strokeStyle = ink; ctx.lineWidth = 1; ctx.stroke();
  ctx.strokeStyle = ink; ctx.lineWidth = 0.8; ctx.beginPath();
  for (const line of coast || []) {
    let pen = false;
    for (let i = 0; i < line.length; i += 2) {
      const q = P(line[i], line[i + 1]);
      if (!q) { pen = false; continue; }
      if (pen) ctx.lineTo(X(q), Y(q)); else ctx.moveTo(X(q), Y(q));
      pen = true;
    }
  }
  ctx.stroke();
  const pts = box.map(([lon, lat]) => P(lon, lat)).filter(Boolean);
  ctx.strokeStyle = accent; ctx.fillStyle = accent; ctx.lineWidth = 2;
  if (pts.length > 2) {
    ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(X(q), Y(q)) : ctx.moveTo(X(q), Y(q)))); ctx.closePath();
    ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
  }
  const c = P(lon0, lat0);
  ctx.beginPath(); ctx.arc(X(c), Y(c), 4, 0, 2 * Math.PI); ctx.fill();
}

// A ramp for a legend: palette stops as a CSS linear gradient.
export const cssRamp = (stops) =>
  `linear-gradient(to right, ${stops.map((s, i) => `rgb(${s.join(",")}) ${((100 * i) / (stops.length - 1)).toFixed(1)}%`).join(", ")})`;
