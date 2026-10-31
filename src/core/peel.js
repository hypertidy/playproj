// Peeling the orange: the globe cut into gores, or into one spiral strip,
// and laid flat.
//
// Gores. n segments from pole to pole, each 360/n degrees wide, flattened
// on its own central meridian by one of three projections, all kept true
// along that meridian:
//   sinu   sinusoidal: every parallel keeps its length, so area is kept
//          and the gore's half width at latitude phi is (pi / n) cos(phi)
//   cass   Cassini (transverse plate carree): distance across the gore,
//          at right angles to the central meridian, is kept
//   tmerc  transverse Mercator: angles are kept
// These are PROJ's sinu, cass and tmerc on the sphere (checked in
// test/check-peel.mjs). The narrower the gore the less the choice matters:
// every one of them is out by an amount that goes as the square of the
// gore's width, because no flat piece fits a sphere (Gauss, 1827).
//
// The peeled orange lays the gores out joined at the south pole, each along
// its own central meridian (a flower); the globe maker's row joins them at
// the equator, which with sinu is the interrupted sinusoidal. peelGore()
// opens the flower: each gore is wrapped on a sphere of radius 1 / (1 - p)
// touching the orange at its south pole, so p = 0 is the orange and p = 1
// the table.
//
// Spiral. One strip of width w (radians of arc on the unit sphere) wound
// from pole to pole, latitude rising by w each turn: phi = w lambda / (2 pi).
// Its length is about 4 pi / w (the sphere's area over the width). Laid
// flat, a narrow strip keeps the geodesic curvature of its centre line,
// which at latitude phi is tan(phi); with t the arc length from the
// equator, sin(phi) = t / a, a = 2 pi / w, so the flat centre line turns
// at t / sqrt(a^2 - t^2). Near the equator that is t / a, curvature growing
// in step with arc length: an Euler spiral (clothoid), whose coordinates are
// the Fresnel integrals. This is Bartholdi and Henriques (2012), Orange
// peels and Fresnel integrals, Mathematical Intelligencer 34(3), 1-3,
// arXiv:1202.3033.
//
// Angles are radians inside, degrees at the edges where noted; the sphere
// has radius 1.

const PI = Math.PI, D2R = PI / 180, R2D = 180 / PI;

// ---------------------------------------------------------------- gores

// forward(dl, phi): gore-local [x, y], dl the longitude from the gore's
// central meridian; inverse(x, y): [dl, phi].
export const GORE_METHODS = {
  sinu: {
    label: "Sinusoidal (equal area)", proj: "sinu",
    forward: (dl, p) => [dl * Math.cos(p), p],
    inverse: (x, y) => [Math.abs(Math.cos(y)) < 1e-12 ? 0 : x / Math.cos(y), y]
  },
  cass: {
    label: "Cassini (true across)", proj: "cass",
    forward: (dl, p) => [Math.asin(Math.cos(p) * Math.sin(dl)), Math.atan2(Math.tan(p), Math.cos(dl))],
    inverse: (x, y) => {
      const p = Math.asin(Math.sin(y) * Math.cos(x));
      return [Math.atan2(Math.tan(x), Math.cos(y)), p];
    }
  },
  tmerc: {
    label: "Transverse Mercator (conformal)", proj: "tmerc",
    forward: (dl, p) => {
      const b = Math.cos(p) * Math.sin(dl);
      return [Math.atanh(b), Math.atan2(Math.tan(p), Math.cos(dl))];
    },
    inverse: (x, y) => {
      const p = Math.asin(Math.sin(y) / Math.cosh(x));
      return [Math.atan2(Math.sinh(x), Math.cos(y)), p];
    }
  }
};
export const METHOD_KEYS = Object.keys(GORE_METHODS);

// The gore half width and the central meridian of gore i (radians), with
// the first gore's west edge at lon0 - 180 degrees.
export const goreHalf = (n) => PI / n;
export const goreCentre = (i, n, lon0 = 0) => (lon0 - 180) * D2R + (i + 0.5) * (2 * PI / n);

// A gore as a grid of (cols + 1) x (rows + 1) points, row-major from the
// south pole: lon, lat in degrees (lon unwrapped about the gore's centre),
// and the flat gore-local x, y.
export function goreGrid(n, method, { rows = 48, cols = 6, i = 0, lon0 = 0 } = {}) {
  const f = GORE_METHODS[method].forward, w = goreHalf(n), lc = goreCentre(i, n, lon0);
  const m = (rows + 1) * (cols + 1);
  const lon = new Float64Array(m), lat = new Float64Array(m), x = new Float64Array(m), y = new Float64Array(m);
  let k = 0;
  for (let r = 0; r <= rows; r++) {
    const p = -PI / 2 + (PI * r) / rows;
    for (let c = 0; c <= cols; c++, k++) {
      const dl = -w + (2 * w * c) / cols, xy = f(dl, p);
      lon[k] = (lc + dl) * R2D; lat[k] = p * R2D; x[k] = xy[0]; y[k] = xy[1];
    }
  }
  return { rows, cols, lon, lat, x, y, centre: lc * R2D };
}

// Gore-local x, y of gore i to the plane: "flower", joined at the south
// pole, seen from outside (east anticlockwise, as EPSG:3031 has it); "row",
// joined at the equator, west to east (the interrupted map).
export function layout(kind, i, n, lon0, x, y) {
  const lc = goreCentre(i, n, lon0);
  if (kind === "row") return [lc + x, y];
  const r = y + PI / 2, s = Math.sin(lc), c = Math.cos(lc);
  return [r * s + x * c, r * c - x * s];
}

// A point of gore i (gore-local x, y; its own lon, lat in radians) at peel
// p, as [x, y, z] with y up (three.js; the globe as texmap.toXYZ has it).
// Between the orange and the flower its distance from the south pole and its
// azimuth there are blended, on a sphere of radius 1 / (1 - p) that touches
// the orange at the south pole.
export function peelGore(i, n, lon0, x, y, lam, phi, p) {
  const lc = goreCentre(i, n, lon0);
  const rf = Math.hypot(x, y + PI / 2), af = lc + Math.atan2(x, y + PI / 2);
  const r = (1 - p) * (phi + PI / 2) + p * rf, az = (1 - p) * lam + p * af;
  const k = 1 - p, sa = Math.sin(az), ca = Math.cos(az);
  if (k < 1e-9) return [r * sa, -1, r * ca];
  const th = r * k, rho = 1 / k;
  return [rho * Math.sin(th) * sa, -1 + rho * (1 - Math.cos(th)), rho * Math.sin(th) * ca];
}

// Distortion over one gore by finite differences: the semi-axes a >= b of
// Tissot's ellipse at each sample. Returns the worst areal scale error, the
// worst angular distortion (degrees), the largest scale error in any
// direction, the edge meridian's flat length over its true length (pi),
// and the gore's flat area over its area on the sphere (4 pi / n).
export function goreStats(n, method, { rows = 90, cols = 16 } = {}) {
  const f = GORE_METHODS[method].forward, w = goreHalf(n), e = 1e-6;
  let area = 0, omega = 0, scale = 0;
  for (let r = 1; r < rows; r++) {
    const p = -PI / 2 + (PI * r) / rows, cp = Math.cos(p);
    for (let c = 0; c <= cols; c++) {
      const dl = -w + (2 * w * c) / cols;
      const a0 = f(dl - e, p), a1 = f(dl + e, p), b0 = f(dl, p - e), b1 = f(dl, p + e);
      // columns: d/d(east distance), d/d(north distance)
      const ex = (a1[0] - a0[0]) / (2 * e * cp), ey = (a1[1] - a0[1]) / (2 * e * cp);
      const nx = (b1[0] - b0[0]) / (2 * e), ny = (b1[1] - b0[1]) / (2 * e);
      const [sa, sb] = singular(ex, nx, ey, ny);
      area = Math.max(area, Math.abs(sa * sb - 1));
      omega = Math.max(omega, 2 * Math.asin((sa - sb) / (sa + sb)) * R2D);
      scale = Math.max(scale, sa - 1, 1 - sb);
    }
  }
  // the edge meridian, and the gore's outline, by many short chords
  const m = 4000;
  let edge = 0, shoelace = 0;
  const pts = [];
  for (let k = 0; k <= m; k++) pts.push(f(w, -PI / 2 + (PI * k) / m));
  for (let k = 0; k < m; k++) edge += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
  // the gore is symmetric about its central meridian: twice the area east of it
  for (let k = 0; k < m; k++) shoelace += (pts[k][0] + pts[k + 1][0]) * (pts[k + 1][1] - pts[k][1]) / 2;
  return { area, omega, scale, edge: edge / PI, areaRatio: (2 * Math.abs(shoelace)) / (4 * w) };
}

// singular values of [[a, b], [c, d]]
function singular(a, b, c, d) {
  const s1 = a * a + b * b + c * c + d * d, det = Math.abs(a * d - b * c);
  const q = Math.sqrt(Math.max(0, s1 * s1 - 4 * det * det));
  return [Math.sqrt((s1 + q) / 2), Math.sqrt(Math.max(0, (s1 - q) / 2))];
}

// ---------------------------------------------------------------- spiral

// A spiral of `turns` turns from pole to pole: width w = pi / turns, and a,
// the half length (arc length from the equator to a pole).
export function spiral(turns) {
  const w = PI / turns;
  return { turns, w, a: (2 * PI) / w, length: (4 * PI) / w };
}

// The heading of the flat centre line at arc length t (0 at the equator).
export const heading = (a, t) => a - Math.sqrt(Math.max(0, a * a - t * t));

// The flat centre line at m + 1 samples, uniform in theta where
// t = a sin(theta), so they crowd towards the poles where it curls.
// Each sample: t, theta, the point x, y, the heading psi and the radius of
// curvature cot|theta|. Integrated by Simpson's rule between samples.
export function spiralLine({ a }, m = 1200) {
  const out = [];
  const dP = (th) => { const s = a * (1 - Math.cos(th)); return [Math.cos(s) * a * Math.cos(th), Math.sin(s) * a * Math.cos(th)]; };
  const sub = 8;
  let x = 0, y = 0;
  const half = [];
  for (let k = 0; k <= m / 2; k++) {
    const th = (PI / 2) * (k / (m / 2));
    if (k) {
      const th0 = (PI / 2) * ((k - 1) / (m / 2)), h = (th - th0) / sub;
      let sx = 0, sy = 0;
      for (let j = 0; j <= sub; j++) {
        const wt = j === 0 || j === sub ? 1 : j % 2 ? 4 : 2, d = dP(th0 + j * h);
        sx += wt * d[0]; sy += wt * d[1];
      }
      x += (sx * h) / 3; y += (sy * h) / 3;
    }
    half.push({ th, x, y });
  }
  // the line is odd in t: P(-t) = -P(t)
  for (let k = half.length - 1; k > 0; k--) out.push(sample(a, -half[k].th, -half[k].x, -half[k].y));
  for (const h of half) out.push(sample(a, h.th, h.x, h.y));
  return out;
}
function sample(a, th, x, y) {
  const t = a * Math.sin(th);
  return { t, th, x, y, psi: heading(a, t), R: Math.abs(th) < 1e-12 ? Infinity : 1 / Math.tan(Math.abs(th)) };
}

// The Euler spiral the centre line tends to: heading t^2 / (2 a), so
// sqrt(2 a) times the Fresnel integrals (C, S) of t / sqrt(2 a). From 0 to
// each t, by Simpson's rule.
export function eulerLine({ a }, ts) {
  const out = [];
  for (const t of ts) {
    const m = 2 * Math.ceil(8 + (16 * t * t) / (2 * a)), h = t / m;
    let sx = 0, sy = 0;
    for (let j = 0; j <= m; j++) {
      const u = j * h, s = (u * u) / (2 * a), wt = j === 0 || j === m ? 1 : j % 2 ? 4 : 2;
      sx += wt * Math.cos(s); sy += wt * Math.sin(s);
    }
    out.push([(sx * h) / 3, (sy * h) / 3]);
  }
  return out;
}

// A point on the spiral strip: centre-line sample theta (t = a sin theta),
// offset v across it (north positive), as lon, lat in radians (lon
// unwrapped), with the latitude kept off the poles.
export function spiralSphere({ w }, th, v) {
  const lam = (2 * PI * th) / w;
  return [lam, Math.max(-PI / 2, Math.min(PI / 2, th + v))];
}

// Offset v at a sample, held inside the radius of curvature on the inner
// side (north for t > 0, south for t < 0), where the flat strip would fold
// over itself; the true peel tapers to the pole there.
export const clampOffset = (s, v) => (Math.sign(s.t) * v > 0.9 * s.R ? Math.sign(s.t) * 0.9 * s.R : v);

// The flat strip point: the centre line plus v to its left (north).
export function spiralFlat(s, v) {
  return [s.x - v * Math.sin(s.psi), s.y + v * Math.cos(s.psi)];
}

// Where the flat line leaves the Euler spiral by more than half the strip's
// width: the fraction of the whole length, centred on the equator, that
// stays within it.
export function eulerFit(sp, line) {
  const e = eulerLine(sp, line.map((s) => s.t));
  let reach = 0;
  for (let k = 0; k < line.length; k++) {
    if (Math.hypot(line[k].x - e[k][0], line[k].y - e[k][1]) <= sp.w / 2) reach = Math.max(reach, Math.abs(line[k].t));
  }
  // reach is the largest |t| still within; check it holds all the way in
  let held = reach;
  for (let k = 0; k < line.length; k++) {
    if (Math.abs(line[k].t) < held && Math.hypot(line[k].x - e[k][0], line[k].y - e[k][1]) > sp.w / 2) held = Math.abs(line[k].t);
  }
  return { euler: e, held, fraction: held / sp.a };
}

// The sphere's own centre line: phi = w lambda / (2 pi), lambda from
// -pi^2 / w to pi^2 / w; its true arc length (the flat line's t leaves out
// the small northward part of each step).
export function sphereLength({ w }, m = 200000) {
  const L = (PI * PI) / w;
  let s = 0, prev = null;
  for (let k = 0; k <= m; k++) {
    const lam = -L + (2 * L * k) / m, p = (w * lam) / (2 * PI);
    const q = [Math.cos(p) * Math.cos(lam), Math.cos(p) * Math.sin(lam), Math.sin(p)];
    if (prev) s += Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
    prev = q;
  }
  return s;
}
