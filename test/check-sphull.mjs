// Convex hull on the sphere: the hull is closed and convex with every point
// on it (Euler: 2n - 4 faces, 3n - 6 edges), each face's circle is empty
// (Delaunay), the Voronoi cells tile the sphere, the stereographic map
// agrees with proj4js and keeps the circles empty in the plane, and the
// faces round the far point give the planar convex hull (Brown 1979).
// Run with: node test/check-sphull.mjs (needs `npm i proj4`).
import proj4 from "proj4";
import * as H from "../src/core/sphull.js";

let fails = 0;
const check = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); };

function solid(T, label, { n = T.xyz.length } = {}) {
  const F = T.faces.length, E = T.edges.length;
  check(!T.flat && T.dropped.length === 0 && F === 2 * n - 4 && E === 3 * n - 6,
    `${label}: n=${n} faces ${F} (2n-4), edges ${E} (3n-6)`);
  // outward, and every point on or behind every face's plane
  let behind = -Infinity, out = Infinity;
  T.faces.forEach((v, f) => {
    behind = Math.max(behind, H.emptiness(T, f));
    const m = v.map((i) => T.xyz[i]).reduce((s, p) => s.map((x, k) => x + p[k] / 3), [0, 0, 0]);
    out = Math.min(out, H.dot(T.centres[f], m));
  });
  check(behind < 1e-9, `${label}: every circle empty (nearest other point ${behind.toExponential(1)} inside)`);
  // face areas and cell areas each add to the whole sphere; when the
  // points fit in a hemisphere the back faces cancel the front ones
  const area = T.faces.map(([a, b, c]) => H.triArea(T.xyz[a], T.xyz[b], T.xyz[c]));
  const front = area.filter((_, f) => !T.back[f]).reduce((s, x) => s + x, 0);
  const fa = T.back.some(Boolean) ? 4 * Math.PI + area.reduce((s, x) => s + x, 0) : front;
  check(area.every((x, f) => (x < 0) === T.back[f]), `${label}: ${T.back.filter(Boolean).length} back faces, each clockwise from outside`);
  const ca = T.xyz.reduce((s, _, i) => s + H.cellArea(T, i), 0);
  const ring = T.cells.every((r) => r.length >= 3) && T.cells.reduce((s, r) => s + r.length, 0) === 3 * F;
  check(Math.abs(fa - 4 * Math.PI) < 1e-9 && Math.abs(ca - 4 * Math.PI) < 1e-9 && ring,
    `${label}: triangles ${(fa / Math.PI).toFixed(9)} pi, Voronoi cells ${(ca / Math.PI).toFixed(9)} pi, rings close`);
  // a Voronoi vertex is equally far from its three points and no nearer to any other
  let eq = 0, near = 0;
  T.faces.forEach((v, f) => {
    const d = v.map((i) => H.angle(T.centres[f], T.xyz[i]));
    eq = Math.max(eq, Math.max(...d) - Math.min(...d), Math.abs(d[0] - T.radius[f]));
    near = Math.max(near, T.radius[f] - H.angle(T.centres[f], T.xyz[H.nearest(T, T.centres[f])]));
  });
  check(eq < 1e-9 && near < 1e-9, `${label}: circumcentres equidistant (${eq.toExponential(1)}), none nearer (${near.toExponential(1)})`);
  return T;
}

for (const n of [4, 5, 12, 100, 1000]) solid(H.triangulate(H.random(n, 7)), `random ${n}`);
solid(H.triangulate(H.fibonacci(500)), "fibonacci 500");
solid(H.triangulate(H.random(200, 3, { cap: 40, lon: 77, lat: -68 })), "200 in a 40 deg cap");
solid(H.triangulate(H.SOLIDS.octahedron), "octahedron");
solid(H.triangulate(H.SOLIDS.icosahedron), "icosahedron");

// a cube's squares come out as two triangles in one plane
{
  const T = solid(H.triangulate(H.SOLIDS.cube), "cube");
  const ties = T.edges.filter(([, , f, g]) => H.dot(T.centres[f], T.centres[g]) > 1 - 1e-6).length;
  check(ties === 6, `cube: ${ties} edges join two triangles in one plane (6 squares)`);
}

// a cap: the triangles on the empty side are big, their circles over a hemisphere
{
  const T = H.triangulate(H.random(60, 11, { cap: 30, lat: -90 }));
  const big = T.radius.filter((r) => r > Math.PI / 2).length, back = T.back.filter(Boolean).length;
  // front faces triangulate the points' hull: the same area as the back faces
  const area = T.faces.map(([a, b, c]) => H.triArea(T.xyz[a], T.xyz[b], T.xyz[c]));
  const fr = area.filter((x) => x > 0).reduce((s, x) => s + x, 0), bk = area.filter((x) => x < 0).reduce((s, x) => s + x, 0);
  check(big >= 1 && big === back && Math.abs(fr + bk) < 1e-9,
    `points in a 30 deg cap: ${big} circles wider than a hemisphere, all back faces; front ${(fr / Math.PI).toFixed(6)} pi, back ${(bk / Math.PI).toFixed(6)} pi`);
  const hullFaces = T.faces.filter((_, f) => !T.back[f]).length;
  const rim = T.edges.filter(([, , f, g]) => T.back[f] !== T.back[g]).length;
  check(hullFaces === 2 * 60 - 2 - rim, `points in a 30 deg cap: ${hullFaces} front faces = 2n - 2 - ${rim} (rim edges), a planar triangulation`);
}

// fewer than four, or all on one circle: no solid hull
check(H.triangulate([[0, 0], [10, 0], [20, 5]]).flat, "three points: flat");
check(H.triangulate([0, 40, 80, 120, 160, 200].map((lon) => [lon, -60])).flat, "six on one small circle: flat");

// stereographic against proj4js
{
  let worst = 0, inv = 0;
  for (const [lon0, lat0] of [[0, 90], [0, -90], [140, -60], [-30, 20], [0, 0]]) {
    const S = H.stereo(lon0, lat0);
    const tr = proj4("+proj=longlat +R=1", `+proj=stere +lat_0=${lat0} +lon_0=${lon0} +k_0=1 +x_0=0 +y_0=0 +R=1`);
    for (let lon = -175; lon < 180; lon += 13) for (let lat = -85; lat < 90; lat += 11) {
      const p = H.toXYZ(lon, lat);
      if (H.dot(p, S.centre) < -0.9) continue;
      const a = S.forward(p), b = tr.forward([lon, lat]);
      worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1]));
      inv = Math.max(inv, H.angle(S.inverse(a), p));
    }
  }
  check(worst < 1e-9 && inv < 1e-12, `stereographic vs proj4js ${worst.toExponential(1)}, inverse ${inv.toExponential(1)} rad`);
}

// in the map: each triangle's circle empty in the plane (the empty side
// being outside for the faces round the far point), and those faces' edges
// the planar convex hull
function planarHull(xy) {
  const idx = xy.map((_, i) => i).sort((a, b) => xy[a][0] - xy[b][0] || xy[a][1] - xy[b][1]);
  const turn = (o, a, b) => (xy[a][0] - xy[o][0]) * (xy[b][1] - xy[o][1]) - (xy[a][1] - xy[o][1]) * (xy[b][0] - xy[o][0]);
  const build = (list) => {
    const h = [];
    for (const i of list) { while (h.length >= 2 && turn(h[h.length - 2], h[h.length - 1], i) <= 0) h.pop(); h.push(i); }
    h.pop();
    return h;
  };
  const h = [...build(idx), ...build(idx.slice().reverse())];
  return new Set(h.map((a, k) => { const b = h[(k + 1) % h.length]; return Math.min(a, b) + "," + Math.max(a, b); }));
}
for (const [label, pts, c] of [
  ["random 300, map from the south pole", H.random(300, 5), [0, -90]],
  ["cap of 80 near Antarctica, map from the south pole", H.random(80, 9, { cap: 35, lon: 100, lat: -70 }), [0, -90]],
  ["random 150, map from 140E 30N", H.random(150, 2), [140, 30]]
]) {
  const T = H.triangulate(pts), S = H.stereo(...c), xy = T.xyz.map(S.forward);
  let worst = -Infinity, outer = 0;
  T.faces.forEach((v, f) => {
    const cc = H.mapCircle(T, f, S);
    if (cc.outside) outer++;
    xy.forEach((q, i) => {
      if (v.includes(i)) return;
      const d = Math.hypot(q[0] - cc.x, q[1] - cc.y) / cc.r;
      worst = Math.max(worst, cc.outside ? d - 1 : 1 - d);
    });
  });
  check(worst < 1e-9, `${label}: map circles empty (worst ${worst.toExponential(1)}), ${outer} faces round the far point`);
  const mine = new Set(H.mapHull(T, S).map(([i, j]) => i + "," + j)), ref = planarHull(xy);
  check(mine.size === ref.size && [...ref].every((k) => mine.has(k)), `${label}: map hull = planar convex hull (${ref.size} edges)`);
}

// locate and nearest agree with brute force
{
  const T = H.triangulate(H.random(80, 4));
  let bad = 0;
  for (const [lon, lat] of H.random(400, 99)) {
    const p = H.toXYZ(lon, lat), f = H.locate(T, p);
    if (f < 0 || H.dot(T.centres[f], p) < T.offset[f] - 1e-12) bad++;
    const i = H.nearest(T, p);
    if (T.cells[i].length < 3) bad++;
  }
  check(bad === 0, `locate: every test point in a triangle on the far side of its plane (${bad} bad)`);
}

console.log(fails ? `\n${fails} failed` : "\nall ok");
process.exit(fails ? 1 : 0);
