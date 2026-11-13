// playproj: how long is a coastline?
//
// Pure functions for coastlen.html, on the sphere of mean radius (IUGG
// R1 = 6371.0088 km). Coastlines are arrays of [lon, lat] in degrees.
//
//   length(pts)              the polyline's length, as great-circle steps
//   mercatorLength(pts)      the length Mercator draws it, read with the
//                            map's equator scale: each step is the straight
//                            line between its Mercator ends
//   lonSpan(pts)             the smallest longitude range holding every point
//   meanLat(pts)             length-weighted mean latitude
//   parallelLength(lat, dl)  dl degrees of the parallel at lat
//   sectorPieces(pts, sectors)  the parts of a line inside longitude sectors
//   divider(pts, r)          Richardson's walk with dividers opened to r km
//   richardson(lines, rulers)   length against ruler, and the dimension D
//                            from the slope: L ~ r^(1 - D)

export const R = 6371.0088;
const RAD = Math.PI / 180;

export const fromFlat = (f) => {
  const o = new Array(f.length >> 1);
  for (let i = 0; i < o.length; i++) o[i] = [f[2 * i], f[2 * i + 1]];
  return o;
};

const vec = ([lon, lat]) => {
  const l = lon * RAD, p = lat * RAD, c = Math.cos(p);
  return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)];
};
const toLL = ([x, y, z]) => [Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD];
const norm = (v) => { const n = Math.hypot(v[0], v[1], v[2]); return [v[0] / n, v[1] / n, v[2] / n]; };

// great-circle distance in km (haversine)
export function distance(a, b) {
  const p1 = a[1] * RAD, p2 = b[1] * RAD, dl = (b[0] - a[0]) * RAD;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function length(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += distance(pts[i - 1], pts[i]);
  return s;
}

const wrap = (d) => ((d + 540) % 360) - 180;
export const isometric = (lat) => Math.log(Math.tan(Math.PI / 4 + Math.max(-89.999, Math.min(89.999, lat)) * RAD / 2));

// The length of the polyline drawn on Mercator, in km at the equator's
// scale. Mercator is conformal, so each short step is drawn sec(lat) times
// its true length, and this is the sum of ds sec(lat).
export function mercatorLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = wrap(pts[i][0] - pts[i - 1][0]) * RAD, dy = isometric(pts[i][1]) - isometric(pts[i - 1][1]);
    s += Math.hypot(dx, dy);
  }
  return s * R;
}

// The smallest longitude range holding every point: 360 less the widest gap
// between longitudes, and where it starts.
export function lonSpan(pts) {
  const l = pts.map((p) => ((p[0] % 360) + 360) % 360).sort((a, b) => a - b);
  let gap = l[0] + 360 - l[l.length - 1], start = l[0];
  for (let i = 1; i < l.length; i++) if (l[i] - l[i - 1] > gap) { gap = l[i] - l[i - 1]; start = l[i]; }
  return { span: 360 - gap, west: wrap(start), east: wrap(start + 360 - gap) };
}

export function meanLat(pts) {
  let s = 0, w = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = distance(pts[i - 1], pts[i]);
    s += d * (pts[i - 1][1] + pts[i][1]) / 2; w += d;
  }
  return s / w;
}

export const parallelLength = (lat, dlon) => R * Math.cos(lat * RAD) * dlon * RAD;

// The parts of a line inside longitude sectors [[west, east], ...] (degrees
// east, west < east, within -180..180), cut where it crosses a sector edge.
export function sectorPieces(pts, sectors) {
  const inside = (lon) => sectors.some(([w, e]) => lon >= w && lon <= e);
  const out = [];
  let cur = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[i - 1], inP = inside(p[0]);
    if (i > 0 && inside(q[0]) !== inP && Math.abs(p[0] - q[0]) < 180) {
      // the sector edge it crosses
      let edge = null;
      for (const [w, e] of sectors) for (const x of [w, e]) if ((q[0] - x) * (p[0] - x) <= 0) edge = x;
      const t = (edge - q[0]) / (p[0] - q[0]), cut = [edge, q[1] + t * (p[1] - q[1])];
      if (cur) { cur.push(cut); out.push(cur); cur = null; } else cur = [cut];
    }
    if (inP) { if (!cur) cur = []; cur.push(p); } else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  // a closed ring that starts inside a sector: join its last piece to its first
  const a = pts[0], b = pts[pts.length - 1];
  if (out.length > 1 && a[0] === b[0] && a[1] === b[1] && inside(a[0])) out[0] = out.pop().concat(out[0].slice(1));
  return out;
}

// Richardson's walk: open the dividers to r km and step along the line,
// each new point the first place further along that is r from the last.
// The steps are chords, measured as great-circle arcs. What is left at the
// end, shorter than r, is added as its own arc. Returns the step count, the
// remainder, the length (n r + rem) and the divider points.
export function divider(pts, r) {
  const V = pts.map(vec), c = 2 * Math.sin(r / (2 * R)), c2 = c * c;
  let P = V[0], i = 0;
  const marks = [pts[0]];
  let n = 0;
  for (;;) {
    // the first segment from i that leaves the ball of chord c round P
    let j = i, A = P, found = null;
    for (; j < V.length - 1; j++) {
      const B = V[j + 1];
      const db = (B[0] - P[0]) ** 2 + (B[1] - P[1]) ** 2 + (B[2] - P[2]) ** 2;
      if (db >= c2) {
        const D = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], E = [A[0] - P[0], A[1] - P[1], A[2] - P[2]];
        const qa = D[0] * D[0] + D[1] * D[1] + D[2] * D[2], qb = 2 * (D[0] * E[0] + D[1] * E[1] + D[2] * E[2]);
        const qc = E[0] * E[0] + E[1] * E[1] + E[2] * E[2] - c2;
        // the crossing on the chord, then refined on the sphere: the point
        // on the arc A B that is c from P
        let t = Math.min(1, Math.max(0, (-qb + Math.sqrt(Math.max(0, qb * qb - 4 * qa * qc))) / (2 * qa)));
        const at = (u) => norm([A[0] + u * D[0], A[1] + u * D[1], A[2] + u * D[2]]);
        const f = (u) => { const q = at(u); return (q[0] - P[0]) ** 2 + (q[1] - P[1]) ** 2 + (q[2] - P[2]) ** 2 - c2; };
        let lo = Math.max(0, t - 1e-3), hi = Math.min(1, t + 1e-3);
        if (f(lo) >= 0) lo = 0;
        if (f(hi) < 0) hi = 1;
        for (let it = 0; it < 60 && hi - lo > 1e-14; it++) {
          t = (lo + hi) / 2;
          if (f(t) < 0) lo = t; else hi = t;
        }
        t = hi;
        found = at(t);
        break;
      }
      A = B;
    }
    if (!found) break;
    P = found; i = j; n++;
    marks.push(toLL(P));
  }
  const last = pts[pts.length - 1], tail = marks[marks.length - 1];
  const rem = distance(tail, last);
  if (rem > 0) marks.push(last);
  return { n, rem, length: n * r + rem, marks };
}

export const RULERS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];

// Length against ruler for a set of lines walked separately, with the
// dimension D from a least-squares line through log L against log r over
// [fitMin, fitMax] km: L ~ r^(1 - D).
export function richardson(lines, rulers = RULERS, { fitMin = 10, fitMax = 500 } = {}) {
  const rows = rulers.map((r) => ({ r, L: lines.reduce((s, l) => s + divider(l, r).length, 0) }));
  const fit = rows.filter((o) => o.r >= fitMin && o.r <= fitMax);
  const x = fit.map((o) => Math.log(o.r)), y = fit.map((o) => Math.log(o.L));
  const mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length;
  let sxy = 0, sxx = 0;
  for (let k = 0; k < x.length; k++) { sxy += (x[k] - mx) * (y[k] - my); sxx += (x[k] - mx) ** 2; }
  const slope = sxy / sxx;
  return { rows, D: 1 - slope, slope, intercept: my - slope * mx, fitMin, fitMax };
}

// the median step between the line's own vertices, km: the data's detail
export function medianStep(lines) {
  const d = [];
  for (const l of lines) for (let i = 1; i < l.length; i++) d.push(distance(l[i - 1], l[i]));
  d.sort((a, b) => a - b);
  return d[d.length >> 1];
}

// the Australian Antarctic Territory's sectors: 45 E to 160 E, less Adelie Land
// (136 E to 142 E)
export const AAT = [[45, 136], [142, 160]];
