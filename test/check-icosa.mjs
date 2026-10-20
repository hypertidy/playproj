// The icosahedron behind H3, built from H3's own 12 pentagon centres: the
// faces match h3-js's getIcosahedronFaces, the gnomonic frame inverts, and
// the strip net opens flat without overlap.
import * as h3 from "h3-js";
import * as ico from "../src/core/icosa.js";

let fails = 0;
const fail = (m) => { fails++; console.log("FAIL " + m); };

const verts = h3.getPentagons(0).map((c) => { const [lat, lon] = h3.cellToLatLng(c); return [lon, lat]; });
const faceId = (c) => { const [lon, lat] = ico.toLonLat(c); return h3.getIcosahedronFaces(h3.latLngToCell(lat, lon, 12))[0]; };
const I = ico.renumber(ico.icosahedron(verts), faceId);

// a random point's face is H3's face for a fine cell there
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
let n = 0;
for (let k = 0; k < 3000; k++) {
  const lon = 360 * rnd() - 180, lat = Math.asin(2 * rnd() - 1) * 180 / Math.PI;
  const cell = h3.latLngToCell(lat, lon, 11), fs = h3.getIcosahedronFaces(cell);
  if (fs.length > 1) continue;   // a cell on an edge belongs to two
  n++;
  const f = ico.faceOf(I, ico.toXYZ(lon, lat));
  if (f !== fs[0]) fail(`face at ${lon.toFixed(3)},${lat.toFixed(3)}: ${f} vs H3 ${fs[0]}`);
  const p = ico.toXYZ(lon, lat), [x, y] = ico.toPlane(I, f, p), q = ico.fromPlane(I, f, x, y);
  if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 1e-12) fail(`gnomonic round trip at ${lon},${lat}`);
}

// H3 hexagon edges are straight on the face plane: the middle of each edge
// (on the sphere, a great circle) is on the line between its ends
let worstStraight = 0;
for (const c of h3.cellToChildren("8075fffffffffff", 3)) {
  const fs = h3.getIcosahedronFaces(c);
  if (fs.length > 1) continue;
  const b = h3.cellToBoundary(c).map(([la, lo]) => ico.toPlane(I, fs[0], ico.toXYZ(lo, la)));
  for (let i = 0; i < b.length; i++) {
    const a = b[i], d = b[(i + 1) % b.length];
    for (let k = i + 2; k < i + b.length; k++) {
      const e = b[k % b.length];
      // the other vertices lie on one side of every edge: a convex hexagon
      const s = (d[0] - a[0]) * (e[1] - a[1]) - (d[1] - a[1]) * (e[0] - a[0]);
      if (s <= 0) fail(`cell ${c} not convex counter clockwise on face ${fs[0]}`);
    }
  }
  // the hexagon's vertices are a regular hexagon about its centre on the plane
  const [la, lo] = h3.cellToLatLng(c), o = ico.toPlane(I, fs[0], ico.toXYZ(lo, la));
  const r = b.map((p) => Math.hypot(p[0] - o[0], p[1] - o[1]));
  worstStraight = Math.max(worstStraight, (Math.max(...r) - Math.min(...r)) / Math.max(...r));
}
if (worstStraight > 1e-6) fail(`hexagons not regular on the face plane: ${worstStraight}`);

// the strip net: 5 upper, 10 band, 5 lower; a tree; flat and non overlapping
const net = ico.stripNet(I);
if (net.parent.filter((p) => p < 0).length !== 1) fail("net has more than one root");
const hg = ico.hinges(I, net.parent), aff = ico.netAffines(I, net.parent, hg);
const R = I.faces[net.root], cs = [];
let worstFlat = 0, worstSide = 0;
for (let f = 0; f < 20; f++) {
  const place = ico.placer(I, net.parent, hg, f);
  const pts = ico.corners(I, f).map(([x, y]) => place(x, y, 1));
  for (const p of pts) worstFlat = Math.max(worstFlat, Math.abs(p[0] * R.c[0] + p[1] * R.c[1] + p[2] * R.c[2] - 1));
  const side = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const s0 = side(pts[0], pts[1]);
  worstSide = Math.max(worstSide, Math.abs(side(pts[1], pts[2]) - s0), Math.abs(side(pts[2], pts[0]) - s0));
  const a = aff[f];
  cs.push([a[2], a[5]]);
}
if (worstFlat > 1e-9) fail(`net not flat: ${worstFlat}`);
if (worstSide > 1e-9) fail(`net faces not equilateral: ${worstSide}`);
for (let i = 0; i < 20; i++) for (let j = i + 1; j < 20; j++)
  if (Math.hypot(cs[i][0] - cs[j][0], cs[i][1] - cs[j][1]) < 0.3) fail(`net faces ${i} and ${j} overlap`);

console.log(`icosa: 20 faces from H3 pentagons, ${n} points on H3's faces, hexagons regular on the plane to ${worstStraight.toExponential(1)}, net flat to ${worstFlat.toExponential(1)}; ${fails} failing`);
process.exit(fails ? 1 : 0);
