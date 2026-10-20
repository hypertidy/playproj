// The convex hull of points on a sphere, and what it is on the sphere: the
// Delaunay triangulation (each hull face is a triangle whose circumcircle
// holds no other point) and its dual, the Voronoi diagram (each face's
// outward normal is the centre of that circle, a Voronoi vertex).
//
// The hull is the incremental one (Clarkson and Shor 1989; de Berg et al.,
// Computational Geometry, chapter 11): start from a tetrahedron, add each
// point, remove the faces it can see and fan new faces from it to their
// horizon. A point is on the hull of points on a sphere only once, so every
// input point is a vertex; ties (four or more points on one circle) are
// broken by a tiny fixed jitter, so a square face comes out as two
// triangles sharing a plane.
//
// Points are unit vectors [x, y, z] with z north and x at lon 0, lat 0.

import { mulberry32 } from "./geo.js";

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export const toXYZ = (lon, lat) => {
  const c = Math.cos(lat * D2R);
  return [c * Math.cos(lon * D2R), c * Math.sin(lon * D2R), Math.sin(lat * D2R)];
};
export const toLonLat = (p) => [Math.atan2(p[1], p[0]) * R2D, Math.asin(Math.max(-1, Math.min(1, p[2] / Math.hypot(...p)))) * R2D];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
const det = (a, b, c) => dot(a, cross(b, c));
export { dot, cross, unit };

// Angle between unit vectors, in radians, good near 0 and pi.
export const angle = (a, b) => Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));

// the jitter that breaks ties: a fixed pattern, far below anything drawn
const JITTER = 1e-9;
function jittered(pts) {
  return pts.map((p, i) => unit([
    p[0] + JITTER * Math.sin(i * 12.9898 + 1), p[1] + JITTER * Math.sin(i * 78.233 + 2), p[2] + JITTER * Math.sin(i * 37.719 + 3)
  ]));
}

// The hull of points (unit vectors) as triangles [a, b, c] of point
// numbers, counterclockwise seen from outside. Returns { faces, dropped,
// flat }: dropped are points not on the hull (duplicates of another), flat
// is true when the points all lie in one plane (fewer than four, or all on
// one circle) and there is no solid hull.
export function hull(points) {
  const n = points.length;
  if (n < 4) return { faces: [], dropped: [], flat: true };
  const P = jittered(points);

  // a starting tetrahedron from points spread far apart
  let i1 = 0, best = -1;
  for (let i = 1; i < n; i++) { const d = Math.hypot(...sub(P[i], P[0])); if (d > best) { best = d; i1 = i; } }
  const u = sub(P[i1], P[0]);
  let i2 = -1; best = -1;
  for (let i = 0; i < n; i++) { const d = Math.hypot(...cross(u, sub(P[i], P[0]))); if (d > best) { best = d; i2 = i; } }
  const nrm = cross(u, sub(P[i2], P[0]));
  let i3 = -1; best = -1;
  for (let i = 0; i < n; i++) { const d = Math.abs(dot(nrm, sub(P[i], P[0]))); if (d > best) { best = d; i3 = i; } }
  if (best < 1e-7) return { faces: [], dropped: [], flat: true };

  const F = [];          // faces: { v: [a, b, c], n, d, alive }
  const edge = new Map(); // directed edge "a,b" -> face number
  const key = (a, b) => a * n + b;
  function addFace(a, b, c) {
    const nn = cross(sub(P[b], P[a]), sub(P[c], P[a]));
    const f = { v: [a, b, c], n: nn, d: dot(nn, P[a]), alive: true };
    F.push(f);
    const k = F.length - 1;
    edge.set(key(a, b), k); edge.set(key(b, c), k); edge.set(key(c, a), k);
    return k;
  }
  // the tetrahedron, each face turned to face away from the fourth point
  const T = [0, i1, i2, i3];
  for (const [a, b, c, o] of [[0, 1, 2, 3], [0, 3, 1, 2], [0, 2, 3, 1], [1, 3, 2, 0]]) {
    const A = T[a], B = T[b], C = T[c];
    if (det(sub(P[B], P[A]), sub(P[C], P[A]), sub(P[T[o]], P[A])) < 0) addFace(A, B, C);
    else addFace(A, C, B);
  }

  const dropped = [];
  const used = new Set(T);
  for (let p = 0; p < n; p++) {
    if (used.has(p)) continue;
    const vis = [];
    for (let k = 0; k < F.length; k++) {
      const f = F[k];
      if (f.alive && dot(f.n, P[p]) - f.d > 0) vis.push(k);
    }
    if (!vis.length) { dropped.push(p); continue; }
    const visible = new Set(vis);
    const horizon = [];
    for (const k of vis) {
      const [a, b, c] = F[k].v;
      for (const [s, t] of [[a, b], [b, c], [c, a]]) {
        if (!visible.has(edge.get(key(t, s)))) horizon.push([s, t]);
      }
    }
    for (const k of vis) {
      F[k].alive = false;
      const [a, b, c] = F[k].v;
      for (const [s, t] of [[a, b], [b, c], [c, a]]) if (edge.get(key(s, t)) === k) edge.delete(key(s, t));
    }
    for (const [s, t] of horizon) addFace(s, t, p);
  }
  return { faces: F.filter((f) => f.alive).map((f) => f.v), dropped, flat: false };
}

// The hull and everything the sphere makes of it, for points as [lon, lat]
// pairs (degrees):
//   xyz      the points as unit vectors
//   faces    hull faces = Delaunay triangles, [a, b, c] counterclockwise
//   centres  each face's outward unit normal: the triangle's circumcentre
//            on the sphere, a Voronoi vertex
//   offset   each face's plane, centre . p = offset for its three points
//   radius   angular circumradius (radians): acos(offset); over 90 degrees
//            when the face's plane passes beyond the centre of the sphere
//   back     for each face, whether the centre of the sphere sees it
//            (offset < 0). Only when the points fit in a hemisphere is the
//            centre outside the hull; then the faces it sees cover the
//            points' hull on the sphere a second time, their arcs crossing
//            the others, and the faces it does not see are the Delaunay
//            triangulation of the points' hull alone
//   edges    Delaunay edges [i, j, f, g] with i < j and faces f (left of
//            i -> j) and g either side; each is also a Voronoi edge from
//            centre f to centre g
//   cells    for each point, its faces in counterclockwise order: the
//            corners of its Voronoi cell
export function triangulate(lonlat) {
  const xyz = lonlat.map(([lon, lat]) => toXYZ(lon, lat));
  const { faces, dropped, flat } = hull(xyz);
  const centres = [], offset = [], radius = [];
  for (const [a, b, c] of faces) {
    const nn = unit(cross(sub(xyz[b], xyz[a]), sub(xyz[c], xyz[a])));
    const d = (dot(nn, xyz[a]) + dot(nn, xyz[b]) + dot(nn, xyz[c])) / 3;
    centres.push(nn); offset.push(d);
    radius.push(Math.acos(Math.max(-1, Math.min(1, d))));
  }
  const half = new Map(), n = xyz.length;
  faces.forEach(([a, b, c], f) => { half.set(a * n + b, f); half.set(b * n + c, f); half.set(c * n + a, f); });
  const edges = [];
  for (const [k, f] of half) {
    const i = Math.floor(k / n), j = k % n;
    if (i < j) edges.push([i, j, f, half.get(j * n + i)]);
  }
  // walk round each point: the face after f about point i is the one on
  // the other side of f's edge leaving i
  const first = new Array(n).fill(-1);
  faces.forEach((v, f) => { for (const i of v) if (first[i] < 0) first[i] = f; });
  const cells = first.map((f0, i) => {
    if (f0 < 0) return [];
    const ring = [];
    let f = f0;
    do {
      ring.push(f);
      const v = faces[f], k = v.indexOf(i), prev = v[(k + 2) % 3];
      f = half.get(i * n + prev);
    } while (f !== f0 && f !== undefined && ring.length <= faces.length);
    return ring;
  });
  const back = offset.map((d) => d < 0);
  return { lonlat, xyz, faces, centres, offset, radius, back, edges, cells, dropped, flat };
}

// How far inside face f's circle the nearest other point is: the largest
// centre . p - offset over the points not on the face. Below zero means the
// circle is empty, as Delaunay's is.
export function emptiness(T, f) {
  const v = T.faces[f];
  let worst = -Infinity;
  T.xyz.forEach((p, i) => { if (!v.includes(i)) worst = Math.max(worst, dot(T.centres[f], p) - T.offset[f]); });
  return worst;
}

// Signed area of the spherical triangle a, b, c (unit vectors) with short
// arcs for sides, in steradians (Van Oosterom and Strackee 1983); positive
// when counterclockwise seen from outside, so negative for a back face.
export function triArea(a, b, c) {
  return 2 * Math.atan2(det(a, b, c), 1 + dot(a, b) + dot(b, c) + dot(c, a));
}

// Area of point i's Voronoi cell, steradians.
export function cellArea(T, i) {
  const ring = T.cells[i], p = T.xyz[i];
  let s = 0;
  for (let k = 0; k < ring.length; k++) s += triArea(p, T.centres[ring[k]], T.centres[ring[(k + 1) % ring.length]]);
  return s;
}

// The face whose spherical triangle holds the unit vector p, or -1 (outside
// the points' hull, when they fit in a hemisphere).
export function locate(T, p) {
  const X = T.xyz;
  for (let f = 0; f < T.faces.length; f++) {
    if (T.back[f]) continue;
    const [a, b, c] = T.faces[f];
    if (det(X[a], X[b], p) >= 0 && det(X[b], X[c], p) >= 0 && det(X[c], X[a], p) >= 0) return f;
  }
  return -1;
}

// The nearest point to unit vector p: the one whose Voronoi cell holds it.
export function nearest(T, p) {
  let best = -1, bd = -2;
  T.xyz.forEach((q, i) => { const d = dot(p, q); if (d > bd) { bd = d; best = i; } });
  return best;
}

// The great-circle arc from a to b (unit vectors) as steps + 1 points.
export function arc(a, b, steps = 16) {
  const w = angle(a, b), out = [];
  const s = Math.sin(w);
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    if (s < 1e-12) { out.push(a.slice()); continue; }
    const p = Math.sin((1 - t) * w) / s, q = Math.sin(t * w) / s;
    out.push([p * a[0] + q * b[0], p * a[1] + q * b[1], p * a[2] + q * b[2]]);
  }
  return out;
}

// The circle where face f's plane cuts the sphere, as steps points.
export function circle(centre, offset, steps = 96) {
  const r = Math.sqrt(Math.max(0, 1 - offset * offset));
  const e = unit(Math.abs(centre[2]) < 0.9 ? cross([0, 0, 1], centre) : cross([1, 0, 0], centre));
  const nn = cross(centre, e), out = [];
  for (let k = 0; k < steps; k++) {
    const t = (2 * Math.PI * k) / steps, c = Math.cos(t) * r, s = Math.sin(t) * r;
    out.push([offset * centre[0] + c * e[0] + s * nn[0], offset * centre[1] + c * e[1] + s * nn[1], offset * centre[2] + c * e[2] + s * nn[2]]);
  }
  return out;
}

// Stereographic projection centred on (lon0, lat0), R = 1, k0 = 1, as PROJ's
// +proj=stere: forward(p) of a unit vector to [x, y], inverse back. The
// point opposite the centre goes to infinity.
export function stereo(lon0, lat0) {
  const c = toXYZ(lon0, lat0);
  const e = [-Math.sin(lon0 * D2R), Math.cos(lon0 * D2R), 0];
  const nn = [-Math.sin(lat0 * D2R) * Math.cos(lon0 * D2R), -Math.sin(lat0 * D2R) * Math.sin(lon0 * D2R), Math.cos(lat0 * D2R)];
  return {
    centre: c,
    forward(p) {
      const s = 1 + dot(p, c);
      return [(2 * dot(p, e)) / s, (2 * dot(p, nn)) / s];
    },
    inverse([x, y]) {
      const r2 = x * x + y * y, k = 4 + r2;
      return [0, 1, 2].map((i) => (4 * x * e[i] + 4 * y * nn[i] + (4 - r2) * c[i]) / k);
    }
  };
}

// The circle in 2D through three points, { x, y, r }, or null if they are
// in a line.
export function circumcircle([ax, ay], [bx, by], [cx, cy]) {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const x = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const y = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { x, y, r: Math.hypot(ax - x, ay - y) };
}

// Stereographic projection takes circles to circles, so face f's circle on
// the sphere is its triangle's circumcircle in the map. outside is true
// when the circle's cap holds the point opposite the map centre, which then
// sits inside the cap: in the map, the empty side is the outside.
export function mapCircle(T, f, S) {
  const [a, b, c] = T.faces[f].map((i) => S.forward(T.xyz[i]));
  const cc = circumcircle(a, b, c);
  if (!cc) return null;
  cc.outside = dot(T.centres[f], S.centre) < -T.offset[f];
  return cc;
}

// The faces whose circle holds the point opposite the map centre: in the
// map they are not triangles but the outside. The Delaunay edges between
// one of them and a face that is not are the convex hull of the points in
// the map (Brown 1979).
export function outerFaces(T, S) {
  const anti = S.centre.map((x) => -x);
  return T.faces.map((_, f) => dot(T.centres[f], anti) > T.offset[f]);
}
export function mapHull(T, S) {
  const out = outerFaces(T, S);
  return T.edges.filter(([, , f, g]) => out[f] !== out[g]);
}

// Point sets. n points from a seed, uniform over the sphere or over a cap
// of half-angle cap degrees about (lon, lat); a Fibonacci spiral; and
// regular solids.
export function random(n, seed = 1, { cap = 180, lon = 0, lat = 0 } = {}) {
  const r = mulberry32(seed), out = [];
  const zmin = Math.cos(cap * D2R);
  const c = toXYZ(lon, lat);
  const e = unit(Math.abs(c[2]) < 0.9 ? cross([0, 0, 1], c) : cross([1, 0, 0], c)), nn = cross(c, e);
  for (let k = 0; k < n; k++) {
    const z = zmin + (1 - zmin) * r(), t = 2 * Math.PI * r(), s = Math.sqrt(1 - z * z);
    const p = [0, 1, 2].map((i) => z * c[i] + s * Math.cos(t) * e[i] + s * Math.sin(t) * nn[i]);
    out.push(toLonLat(p));
  }
  return out;
}
export function fibonacci(n) {
  const g = Math.PI * (3 - Math.sqrt(5)), out = [];
  for (let k = 0; k < n; k++) {
    const z = 1 - (2 * k + 1) / n;
    let lon = ((k * g * R2D + 180) % 360) - 180;
    out.push([lon, Math.asin(z) * R2D]);
  }
  return out;
}
export const SOLIDS = {
  // a cube: six squares, each four points on one circle
  cube: [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => toLonLat([x, y, z])))),
  // an octahedron: eight faces, each an eighth of the sphere
  octahedron: [[0, 0], [90, 0], [180, 0], [-90, 0], [0, 90], [0, -90]],
  icosahedron: (() => {
    const t = Math.atan(0.5) * R2D, out = [[0, 90], [0, -90]];
    for (let k = 0; k < 5; k++) out.push([-180 + 72 * k, t], [-144 + 72 * k, -t]);
    return out;
  })()
};
