// The Navigation page's geometry, without three.js: a square of Antarctic
// polar stereographic (EPSG:3031) as a lattice, GEBCO's heights read onto
// it from a lon/lat window, a section along a meridian, and the camera's
// tilt and heading as a reader would say them; and for its other scenes,
// a chain of rings at right angles, a globe, and which way things point
// on the screen.

import { polarStere } from "./polarstere.js";

export const PS = polarStere("EPSG:3031");
const R2D = 180 / Math.PI;

// The lattice of a square half metres either side of the pole, n cells
// across: (n + 1)^2 vertices, row by row from the top (+y, towards 0 E),
// as x, y in metres.
export function lattice(n, half) {
  const m = n + 1, xy = new Float64Array(m * m * 2);
  for (let j = 0; j < m; j++)
    for (let i = 0; i < m; i++) {
      const k = 2 * (j * m + i);
      xy[k] = -half + (2 * half * i) / n;
      xy[k + 1] = half - (2 * half * j) / n;
    }
  return { n, half, xy };
}

// Two triangles a cell, wound counter-clockwise seen from above (+z), so
// their faces look up.
export function latticeTriangles(n) {
  const m = n + 1, out = new Uint32Array(n * n * 6);
  let o = 0;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * m + i, b = a + 1, c = a + m, d = c + 1;
      out[o++] = a; out[o++] = c; out[o++] = b;
      out[o++] = b; out[o++] = c; out[o++] = d;
    }
  return out;
}

// The lon/lat box a square needs from a lon/lat source: every longitude,
// from the pole to a degree past its corners.
export function squareBox(half) {
  const [, lat] = PS.inverse(half, half);
  return { west: -180, east: 180, south: -90, north: Math.min(90, lat + 1) };
}

// Elevation at lon, lat from a window as readGebcoWindow gives it ({ elev,
// width, height, west, north, dx, dy }), bilinear between cell centres,
// with longitude wrapped where the window goes all the way round.
export function windowSampler(win) {
  const { elev, width: W, height: H, west, north, dx, dy } = win;
  const round = Math.abs(W * dx - 360) < dx / 2;
  const at = (i, j) => {
    const z = elev[j * W + i];
    return z <= -32767 ? 0 : z;
  };
  return (lon, lat) => {
    let u = (lon - west) / dx - 0.5;
    const v = Math.max(0, Math.min(H - 1.000001, (north - lat) / dy - 0.5));
    if (round) u = ((u % W) + W) % W;
    else u = Math.max(0, Math.min(W - 1.000001, u));
    const i0 = Math.floor(u), j0 = Math.floor(v), fu = u - i0, fv = v - j0;
    const i1 = round ? (i0 + 1) % W : Math.min(W - 1, i0 + 1), j1 = Math.min(H - 1, j0 + 1);
    return (at(i0, j0) * (1 - fu) + at(i1, j0) * fu) * (1 - fv) + (at(i0, j1) * (1 - fu) + at(i1, j1) * fu) * fv;
  };
}

// The lon, lat of every vertex of a lattice, interleaved.
export function latticeLonLat(grid) {
  const N = grid.xy.length / 2, ll = new Float64Array(N * 2);
  for (let k = 0; k < N; k++) {
    const [lon, lat] = PS.inverse(grid.xy[2 * k], grid.xy[2 * k + 1]);
    ll[2 * k] = lon; ll[2 * k + 1] = lat;
  }
  return ll;
}

// A sampler over several windows side by side in longitude (a read too wide
// for one): each lon goes to the window whose own span holds it.
export function stripSampler(wins) {
  const s = wins.map((w) => [w.west + 2 * w.dx, w.west + (w.width - 2) * w.dx, windowSampler(w)]);
  return (lon, lat) => {
    for (const [a, b, f] of s) if (lon >= a && lon <= b) return f(lon, lat);
    return s[0][2](lon, lat);
  };
}

// Points along the meridian lon from the pole out to the square's edge,
// about step metres apart: [{ x, y, lon, lat }].
export function meridianPoints(lon, half, step) {
  const t = lon / R2D, sx = Math.sin(t), sy = Math.cos(t);
  const reach = half / Math.max(Math.abs(sx), Math.abs(sy));
  const n = Math.max(2, Math.ceil(reach / step)), out = [];
  for (let k = 0; k <= n; k++) {
    const r = (reach * k) / n, x = r * sx, y = r * sy;
    const [, lat] = PS.inverse(x, y);
    out.push({ x, y, lon, lat: k === 0 ? -90 : lat });
  }
  return out;
}

// How the camera looks at the place it turns about, from camera and target
// positions [x, y, z] in a frame of x and y on the map (metres or any
// multiple) and z up: tilt in degrees from straight down (0) through level
// (90) to straight up from beneath (180); heading in degrees clockwise from
// true north at the target, where the map's own north is away from the pole
// (grid: from +y, towards 0 E, when the target is at the pole); and
// whether the camera is below z = 0.
export function viewAngles(cam, target) {
  const d = [target[0] - cam[0], target[1] - cam[1], target[2] - cam[2]];
  const len = Math.hypot(...d) || 1;
  const tilt = Math.acos(Math.max(-1, Math.min(1, -d[2] / len))) * R2D;
  const rho = Math.hypot(target[0], target[1]), atPole = rho < 1e-9 * Math.max(1, len);
  // north is away from the pole, east a quarter turn clockwise from it
  const north = atPole ? [0, 1] : [target[0] / rho, target[1] / rho], east = [north[1], -north[0]];
  const level = Math.hypot(d[0], d[1]);
  const heading = level < 1e-9 * len ? null : (Math.atan2(d[0] * east[0] + d[1] * east[1], d[0] * north[0] + d[1] * north[1]) * R2D + 360) % 360;
  return { tilt, heading, grid: atPole, below: cam[2] < 0 };
}

// A heading as a compass point of sixteen: "NNE" and so on.
export function compass(deg) {
  if (deg === null) return "";
  const P = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return P[Math.round(deg / 22.5) % 16];
}

// The lattice's rows and columns as line segments (pairs of vertex
// indices), without the triangles' diagonals: its cells drawn as a wire
// mesh.
export function latticeLines(n) {
  const m = n + 1, out = new Uint32Array(4 * n * m);
  let o = 0;
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) { const a = j * m + i; out[o++] = a; out[o++] = a + 1; }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < m; i++) { const a = j * m + i; out[o++] = a; out[o++] = a + m; }
  return out;
}

// ------------------------------------------------------------------ other scenes

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Three rings of radius r in a chain, each at right angles to the others:
// the first flat (its axis z), the second standing across it through its
// hole (axis y), the third standing the other way through the second's
// (axis x), set out past the first's rim and raised, so the first neither
// touches it nor reaches its plane. [{ centre, axis }], about the middle of
// their centres. The rings come no nearer each other than 0.4 r.
export function linkedRings(r) {
  const R = [
    { centre: [0, 0, 0], axis: [0, 0, 1] },
    { centre: [r, 0, 0], axis: [0, 1, 0] },
    { centre: [1.3 * r, 0, 0.5 * r], axis: [1, 0, 0] }
  ];
  const m = [0, 1, 2].map((k) => (R[0].centre[k] + R[1].centre[k] + R[2].centre[k]) / 3);
  return R.map((q) => ({ centre: q.centre.map((v, k) => v - m[k]), axis: q.axis }));
}

// The angle in degrees between a line of sight and an axis, either way
// along it: 0 looking straight along it (through a ring about it), 90
// across it.
export function axisAngle(dir, axis) {
  return Math.acos(Math.min(1, Math.abs(dot(unit(dir), unit(axis))))) * R2D;
}

// Which way a direction v points on the screen, in degrees clockwise from
// straight up the screen, for a camera whose screen right and up are the
// world directions right and up; null when v is nearly along the line of
// sight, so has no way on the screen.
export function screenBearing(v, right, up) {
  const x = dot(v, right), y = dot(v, up);
  if (Math.hypot(x, y) < 0.02 * Math.hypot(...v)) return null;
  return Math.atan2(x, y) * R2D;
}

// A globe about the origin with its north pole on +z and 0 E on +x: lon,
// lat in degrees to a point at radius r, and back.
export function globeXYZ(lon, lat, r = 1) {
  const l = lon / R2D, p = lat / R2D;
  return [r * Math.cos(p) * Math.cos(l), r * Math.cos(p) * Math.sin(l), r * Math.sin(p)];
}
export function globeLonLat(p) {
  const [x, y, z] = unit(p);
  return [Math.atan2(y, x) * R2D, Math.asin(Math.max(-1, Math.min(1, z))) * R2D];
}
// North along the globe at p (a unit vector along the meridian, towards
// the north pole), or null at a pole.
export function northAt(p) {
  const u = unit(p), n = [-u[2] * u[0], -u[2] * u[1], 1 - u[2] * u[2]];
  return Math.hypot(...n) < 1e-6 ? null : unit(n);
}
// Where a line of sight from cam along dir first meets a sphere of radius
// r about the origin, or null where it misses.
export function sphereHit(cam, dir, r) {
  const d = unit(dir), b = dot(cam, d), c = dot(cam, cam) - r * r, disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? null : [cam[0] + t * d[0], cam[1] + t * d[1], cam[2] + t * d[2]];
}
