// Two homes for a mesh in a projected CRS: the map, where the CRS lays it
// flat, and the Earth, where it really is. Both are in metres in the scene
// frame of geo.js sceneFrame() (east +x, up +y, north -z) about the same
// origin point, so a fraction between them unfolds the map onto the
// ellipsoid and the difference is exactly what the projection did.
//
// Map home: (x, h, -y) for a position (x, y) relative to the local origin
// and height h. Earth home: the point's Earth-centred x, y, z (PROJ's
// +proj=cart) at its longitude, latitude and height, less that of the
// origin, turned into east, up and north at the origin. Near the origin the
// two agree to the scale factor; away from it the Earth home drops below
// the plane by about d^2 / 2R and turns by the meridian convergence.

import { toXYZ } from "./ellipsoid.js";

const D2R = Math.PI / 180;

// pos: Float32Array of n positions with `size` (2 or 3) numbers each,
// origin subtracted; zScale multiplies the third. out: n * 3.
export function mapHome(pos, size, zScale = 1, out = new Float32Array((pos.length / size) * 3)) {
  for (let k = 0, i = 0; i < pos.length; k += 3, i += size) {
    out[k] = pos[i];
    out[k + 1] = size > 2 ? pos[i + 2] * zScale : 0;
    out[k + 2] = -pos[i + 1];
  }
  return out;
}

// East, north and up unit vectors at lon, lat, in Earth-centred axes.
export function enuAxes(lon, lat) {
  const l = lon * D2R, p = lat * D2R;
  return {
    e: [-Math.sin(l), Math.cos(l), 0],
    n: [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)],
    u: [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)]
  };
}

// inv(x, y) -> [lon, lat] | null takes full CRS coordinates; origin is
// [ox, oy] in the CRS; E is an ellipsoid from ellipsoid.js. A vertex the
// inverse cannot place stays at its map home. Returns { out, lonlat0 }.
export function earthHome(pos, size, origin, inv, E, zScale = 1, out = new Float32Array((pos.length / size) * 3)) {
  const ll0 = inv(origin[0], origin[1]);
  if (!ll0) throw new Error("the local origin has no longitude and latitude in this CRS");
  const c0 = toXYZ(E, ll0[0], ll0[1], 0);
  const { e, n, u } = enuAxes(ll0[0], ll0[1]);
  for (let k = 0, i = 0; i < pos.length; k += 3, i += size) {
    const h = size > 2 ? pos[i + 2] * zScale : 0;
    const ll = inv(pos[i] + origin[0], pos[i + 1] + origin[1]);
    if (!ll) {
      out[k] = pos[i]; out[k + 1] = h; out[k + 2] = -pos[i + 1];
      continue;
    }
    const c = toXYZ(E, ll[0], ll[1], h);
    const d0 = c[0] - c0[0], d1 = c[1] - c0[1], d2 = c[2] - c0[2];
    out[k] = d0 * e[0] + d1 * e[1] + d2 * e[2];
    out[k + 1] = d0 * u[0] + d1 * u[1] + d2 * u[2];
    out[k + 2] = -(d0 * n[0] + d1 * n[1] + d2 * n[2]);
  }
  return { out, lonlat0: ll0 };
}

// out = a + (b - a) t, elementwise.
export function blend(out, a, b, t) {
  for (let i = 0; i < out.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

// The largest and the root mean square distance between the two homes.
export function homeGap(a, b) {
  let max = 0, ss = 0;
  const n = a.length / 3;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.hypot(b[i] - a[i], b[i + 1] - a[i + 1], b[i + 2] - a[i + 2]);
    if (d > max) max = d;
    ss += d * d;
  }
  return { max, rms: Math.sqrt(ss / n) };
}

// ---------------------------------------------------------------- graticule

// A round step in degrees giving about `n` lines across a span of degrees.
export function niceStep(span, n = 5) {
  const steps = [1 / 3600, 2 / 3600, 5 / 3600, 10 / 3600, 30 / 3600, 1 / 60, 2 / 60, 5 / 60, 10 / 60, 0.25, 0.5, 1, 2, 5, 10, 15, 30];
  for (const s of steps) if (span / s <= n) return s;
  return 30;
}

// Meridians and parallels over a lon/lat box, each a polyline of
// [lon, lat] pairs sampled `res` times, at a round step.
export function graticuleLines(west, east, south, north, { n = 5, res = 48 } = {}) {
  const step = niceStep(Math.max(east - west, north - south), n);
  const lines = [];
  const first = (a) => Math.ceil(a / step - 1e-9) * step;
  for (let lon = first(west); lon <= east + 1e-12; lon += step) {
    const l = [];
    for (let i = 0; i <= res; i++) l.push([lon, south + ((north - south) * i) / res]);
    lines.push({ kind: "meridian", value: lon, points: l });
  }
  for (let lat = first(south); lat <= north + 1e-12; lat += step) {
    const l = [];
    for (let i = 0; i <= res; i++) l.push([west + ((east - west) * i) / res, lat]);
    lines.push({ kind: "parallel", value: lat, points: l });
  }
  return { step, lines };
}

// The lon/lat box of a CRS extent [x0, x1, y0, y1], from an n by n lattice
// of points through inv (enough for a tile; a box round a pole is the cap).
export function lonLatBox(inv, e, n = 9) {
  let w = Infinity, ea = -Infinity, s = Infinity, no = -Infinity;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const ll = inv(e[0] + ((e[1] - e[0]) * i) / n, e[2] + ((e[3] - e[2]) * j) / n);
      if (!ll) continue;
      w = Math.min(w, ll[0]); ea = Math.max(ea, ll[0]); s = Math.min(s, ll[1]); no = Math.max(no, ll[1]);
    }
  }
  const pole = (lat) => { const ll = inv((e[0] + e[1]) / 2, (e[2] + e[3]) / 2); return ll && Math.abs(ll[1]) > lat; };
  if (ea - w > 180 && pole(60)) return { west: -180, east: 180, south: s, north: no, polar: true };
  return { west: w, east: ea, south: s, north: no, polar: false };
}
