// The Navigation page's geometry, without three.js: a square of Antarctic
// polar stereographic (EPSG:3031) as a lattice, GEBCO's heights read onto
// it from a lon/lat window, a section along a meridian, and the camera's
// tilt and heading as a reader would say them.

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
