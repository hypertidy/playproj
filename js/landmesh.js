// Land as triangles, built from the coastline polylines, so rays can start
// from inside the land shapes rather than only from their edges.
//
// Natural Earth coastlines are mostly closed rings, but some come in pieces
// (split at the antimeridian, or along arbitrary cuts). The pieces are
// chained end to end, longitudes are unwrapped so a ring crossing 180 stays
// continuous, and a ring that wraps the whole globe (Antarctica) is closed
// through its pole. Rings inside an odd number of other rings are water
// (the Caspian) and become holes. Each land polygon is ear-clipped, then
// triangles are bisected on their longest edge until no edge is longer than
// `maxEdge` degrees of arc, so there are points in the interiors too.

import earcut from "earcut";
import { mulberry32 } from "./geo.js";

const D2R = Math.PI / 180;
const key = (lon, lat) => `${lon === -180 ? 180 : lon},${lat}`;

// Coastline polylines -> closed rings as flat [lon, lat, ...] arrays with
// continuous (unwrapped) longitudes and no repeated closing point.
export function coastRings(coast) {
  const closed = [], open = [];
  for (const l of coast) {
    const n = l.length;
    if (n < 6) continue;
    if (l[0] === l[n - 2] && l[1] === l[n - 1]) closed.push(l.slice(0, n - 2));
    else open.push(l);
  }
  // pieces can run either way, so index both ends
  const ends = new Map();
  const add = (k, i) => { if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); };
  open.forEach((l, i) => { add(key(l[0], l[1]), i); add(key(l[l.length - 2], l[l.length - 1]), i); });
  const used = new Array(open.length).fill(false);
  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const ring = open[i].slice();
    const k0 = key(ring[0], ring[1]);
    for (let guard = 0; guard < open.length; guard++) {
      const kEnd = key(ring[ring.length - 2], ring[ring.length - 1]);
      if (kEnd === k0) break;
      const j = (ends.get(kEnd) || []).find((c) => !used[c]);
      if (j === undefined) break;
      used[j] = true;
      const l = open[j], m = l.length;
      if (key(l[0], l[1]) === kEnd) for (let q = 2; q < m; q++) ring.push(l[q]);
      else for (let q = m - 4; q >= 0; q -= 2) ring.push(l[q], l[q + 1]);
    }
    // drop the repeated closing point, if the chain came back to its start;
    // otherwise keep it only if it ends on the antimeridian (closed along it)
    // or very near its start
    const n = ring.length;
    const x1 = ring[n - 2], y1 = ring[n - 1];
    if (key(x1, y1) === k0) ring.length = n - 2;
    else if (!(Math.abs(ring[0]) === 180 && Math.abs(x1) === 180) && Math.hypot(x1 - ring[0], y1 - ring[1]) > 0.1) continue;
    if (ring.length >= 6) closed.push(ring);
  }
  return closed.map(closeRing);
}

function closeRing(r) {
  const out = [r[0], r[1]];
  let off = 0;
  for (let i = 2; i < r.length; i += 2) {
    let lon = r[i] + off;
    const prev = out[out.length - 2];
    while (lon - prev > 180) { lon -= 360; off -= 360; }
    while (prev - lon > 180) { lon += 360; off += 360; }
    out.push(lon, r[i + 1]);
  }
  // the gap back to the start: a ring around the whole globe has to be
  // closed along the parallel of its pole
  let last = out[out.length - 2];
  const wrap = Math.round((last - out[0]) / 360);
  if (wrap !== 0) {
    let s = 0;
    for (let i = 1; i < out.length; i += 2) s += out[i];
    const pole = s < 0 ? -90 : 90;
    out.push(last, pole, out[0], pole);
  }
  return out;
}

function bbox(r) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < r.length; i += 2) {
    if (r[i] < b[0]) b[0] = r[i];
    if (r[i] > b[2]) b[2] = r[i];
    if (r[i + 1] < b[1]) b[1] = r[i + 1];
    if (r[i + 1] > b[3]) b[3] = r[i + 1];
  }
  return b;
}

function inRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Is ring a inside ring b? Tested at one vertex of a that is not on the
// antimeridian or a pole, where rings split at 180 touch each other.
function testPoint(a) {
  for (let i = 0; i < a.length; i += 2) {
    if (Math.abs(a[i + 1]) < 90 && Math.abs(Math.abs(((a[i] % 360) + 360) % 360 - 180)) > 1e-6) return [a[i], a[i + 1]];
  }
  return [a[0], a[1]];
}

function contains(b, bb, a) {
  const y = a[1];
  if (y < bb[1] || y > bb[3]) return false;
  for (const s of [0, 360, -360]) {
    const x = a[0] + s;
    if (x >= bb[0] && x <= bb[2] && inRing(x, y, b)) return true;
  }
  return false;
}

// Rings -> land polygons [{ outer, holes }] by nesting depth.
export function landPolygons(rings) {
  const bbs = rings.map(bbox);
  const parents = rings.map((a, i) => {
    const ps = [];
    const t = testPoint(a);
    rings.forEach((b, j) => { if (j !== i && contains(b, bbs[j], t)) ps.push(j); });
    return ps;
  });
  const depth = parents.map((p) => p.length);
  const polys = new Map();
  rings.forEach((r, i) => { if (depth[i] % 2 === 0) polys.set(i, { outer: r, holes: [] }); });
  rings.forEach((r, i) => {
    if (depth[i] % 2 === 0) return;
    const p = parents[i].find((j) => depth[j] === depth[i] - 1);
    if (p === undefined) return;
    // shift the hole by whole turns to sit in its parent's longitudes
    const t = testPoint(r), bb = bbs[p];
    const sh = [0, 360, -360].find((d) => t[0] + d >= bb[0] && t[0] + d <= bb[2]) || 0;
    polys.get(p).holes.push(sh ? r.map((x, k) => (k % 2 ? x : x + sh)) : r);
  });
  return [...polys.values()];
}

// Length of the edge a-b in degrees of arc (equirectangular, scaled by the
// cosine of the mid latitude: good enough to decide what to split).
const edgeLen = (a, b) => Math.hypot((b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * D2R), b[1] - a[1]);

// Leaf triangles as [[lon, lat] x 3] (unwrapped longitudes).
export function landTriangles(coast, maxEdge = 3) {
  const tris = [];
  const split = (a, b, c, d) => {
    const la = edgeLen(b, c), lb = edgeLen(c, a), lc = edgeLen(a, b);
    const m = Math.max(la, lb, lc);
    if (m <= maxEdge || d > 16) { tris.push([a, b, c]); return; }
    if (m === la) { const p = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2]; split(a, b, p, d + 1); split(a, p, c, d + 1); }
    else if (m === lb) { const p = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2]; split(b, c, p, d + 1); split(b, p, a, d + 1); }
    else { const p = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; split(c, a, p, d + 1); split(c, p, b, d + 1); }
  };
  for (const { outer, holes } of landPolygons(coastRings(coast))) {
    // earcut takes the rings flat, outer first, with the start of each hole
    const pts = outer.concat(...holes), starts = [];
    let n = outer.length / 2;
    for (const h of holes) { starts.push(n); n += h.length / 2; }
    const ids = earcut(pts, starts);
    const at = (i) => [pts[2 * i], pts[2 * i + 1]];
    for (let t = 0; t < ids.length; t += 3) split(at(ids[t]), at(ids[t + 1]), at(ids[t + 2]), 0);
  }
  return tris;
}

const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

// Area on the sphere, in square degrees (planar area times cos(lat)).
const triArea = ([a, b, c]) =>
  (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2) *
  Math.cos(((a[1] + b[1] + c[1]) / 3) * D2R);

const meshCache = new WeakMap();

// { verts: [[lon, lat, weight]], cents: [[lon, lat, weight]] } for a coastline.
export function landMesh(coast, maxEdge = 3) {
  const hit = meshCache.get(coast);
  if (hit) return hit;
  const tris = landTriangles(coast, maxEdge);
  const vmap = new Map(), cents = [];
  for (const t of tris) {
    const w = Math.max(triArea(t), 0);
    cents.push([wrapLon((t[0][0] + t[1][0] + t[2][0]) / 3), (t[0][1] + t[1][1] + t[2][1]) / 3, w]);
    for (const [lon, lat] of t) {
      const L = Math.abs(lat) === 90 ? 0 : wrapLon(lon);
      const k = `${L},${lat}`;
      const v = vmap.get(k);
      if (v) v[2] += w / 3;
      else vmap.set(k, [L, lat, w / 3]);
    }
  }
  const mesh = { verts: [...vmap.values()], cents, tris };
  meshCache.set(coast, mesh);
  return mesh;
}

// Weighted sample of `count` items without replacement (Efraimidis-Spirakis):
// bigger pieces of land are more likely to be picked, but each only once.
function weighted(items, count, rand) {
  const keyed = [];
  for (const it of items) if (it[2] > 0) keyed.push([Math.log(rand()) / it[2], it]);
  keyed.sort((p, q) => q[0] - p[0]);
  return keyed.slice(0, count).map(([, it]) => [it[0], it[1]]);
}

// Land triangles binned into CELL-degree cells, for point-in-land tests.
const CELL = 2;
const indexCache = new WeakMap();

function landIndex(coast) {
  const hit = indexCache.get(coast);
  if (hit) return hit;
  const tris = landMesh(coast).tris;
  const nx = 360 / CELL, ny = 180 / CELL;
  const cells = Array.from({ length: nx * ny }, () => []);
  tris.forEach((t, k) => {
    const xs = t.map((v) => v[0]), ys = t.map((v) => v[1]);
    const x0 = Math.floor((Math.min(...xs) + 180) / CELL), x1 = Math.floor((Math.max(...xs) + 180) / CELL);
    const y0 = Math.max(0, Math.floor((Math.min(...ys) + 90) / CELL)), y1 = Math.min(ny - 1, Math.floor((Math.max(...ys) + 90) / CELL));
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) cells[(((x % nx) + nx) % nx) + y * nx].push(k);
  });
  const index = { tris, cells, nx, ny };
  indexCache.set(coast, index);
  return index;
}

function inTriangle(x, y, [a, b, c]) {
  const s1 = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  const s2 = (c[0] - b[0]) * (y - b[1]) - (c[1] - b[1]) * (x - b[0]);
  const s3 = (a[0] - c[0]) * (y - c[1]) - (a[1] - c[1]) * (x - c[0]);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

export function isLand(coast, lon, lat) {
  const { tris, cells, nx, ny } = landIndex(coast);
  const x = Math.floor((wrapLon(lon) + 180) / CELL) % nx;
  const y = Math.min(ny - 1, Math.floor((lat + 90) / CELL));
  for (const k of cells[x + y * nx]) {
    const t = tris[k];
    // triangle longitudes may be unwrapped: try the point a turn either way
    for (const d of [0, 360, -360, 720, -720]) if (inTriangle(lon + d, lat, t)) return true;
  }
  return false;
}

const GOLDEN = 180 * (3 - Math.sqrt(5)); // golden angle, degrees

// Evenly spaced points on land: a Fibonacci lattice over the whole sphere,
// dense enough that about `count` of its points fall on land, keeping those.
// Every point has the same area of sphere to itself, so the spacing is
// sqrt(4 pi / total) radians. The seed turns the lattice about the pole.
export function evenLand(coast, count, seed = 1) {
  const frac = landFraction(coast);
  const total = Math.max(1, Math.round(count / frac));
  const pts = [];
  for (let i = 0; i < total; i++) {
    const lat = Math.asin(1 - (2 * i + 1) / total) / D2R;
    const lon = wrapLon(i * GOLDEN + (seed - 1) * GOLDEN / 7);
    if (isLand(coast, lon, lat)) pts.push([lon, lat]);
  }
  return pts;
}

// Spacing of the even lattice, in degrees, for about `count` points on land.
export function evenSpacing(coast, count) {
  const total = Math.max(1, Math.round(count / landFraction(coast)));
  return Math.sqrt((4 * Math.PI) / total) / D2R;
}

export function landFraction(coast) {
  return landMesh(coast).cents.reduce((s, c) => s + c[2], 0) * D2R * D2R / (4 * Math.PI);
}

// Ray targets: "coast" (random coastline vertices, the original sampling),
// "vert" (vertices of the land mesh), "tri" (land triangle centres), or
// "even" (evenly spaced land points, all of them: count sets the density).
export function samplePoints(coast, mode, seed, count) {
  if (mode === "even") return evenLand(coast, count, seed);
  const rand = mulberry32(seed);
  if (mode === "vert" || mode === "tri") {
    const mesh = landMesh(coast);
    return weighted(mode === "vert" ? mesh.verts : mesh.cents, count, rand);
  }
  const pool = [];
  const total = coast.reduce((s, l) => s + l.length / 2, 0);
  for (let k = 0; k < count; k++) {
    let idx = Math.floor(rand() * total);
    for (const line of coast) {
      const n = line.length / 2;
      if (idx < n) { pool.push([line[2 * idx], line[2 * idx + 1]]); break; }
      idx -= n;
    }
  }
  return pool;
}

export const SAMPLE_MODES = ["tri", "vert", "coast", "even"];
