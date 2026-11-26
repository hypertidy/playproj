// The Navigation page's geometry: the lattice, its triangles and its wire
// mesh, GEBCO's window sampled with longitude wrapped, a meridian section,
// the camera's tilt and heading; the linked rings, the globe, and which way
// things point on the screen.
import assert from "node:assert/strict";
import { PS, lattice, latticeTriangles, squareBox, windowSampler, latticeLonLat, stripSampler, meridianPoints, viewAngles, compass,
  latticeLines, linkedRings, axisAngle, screenBearing, globeXYZ, globeLonLat, northAt, sphereHit } from "../src/core/navigate.js";

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

// lattice: corners and middle
const g = lattice(4, 1000);
assert.equal(g.xy.length, 25 * 2);
assert.deepEqual([g.xy[0], g.xy[1]], [-1000, 1000]);
assert.deepEqual([g.xy[48], g.xy[49]], [1000, -1000]);
assert.deepEqual([g.xy[24], g.xy[25]], [0, 0]);

// every triangle faces up: counter-clockwise seen from +z
const tri = latticeTriangles(4);
assert.equal(tri.length, 4 * 4 * 6);
for (let t = 0; t < tri.length; t += 3) {
  const [a, b, c] = [tri[t], tri[t + 1], tri[t + 2]].map((k) => [g.xy[2 * k], g.xy[2 * k + 1]]);
  assert.ok((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0, `triangle ${t / 3} faces down`);
}

// the box reaches past the corners
const box = squareBox(4.5e6);
assert.ok(box.north > PS.inverse(4.5e6, 4.5e6)[1]);
assert.equal(box.south, -90);

// a window all the way round: bilinear, wrapped across 180
const W = 36, H = 9, elev = new Float32Array(W * H);
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) elev[j * W + i] = i * 100 + j;
const win = { elev, width: W, height: H, west: -180, north: -45, dx: 10, dy: 5 };
const s = windowSampler(win);
near(s(-175, -47.5), 0, 1e-9, "first cell centre");
near(s(-170, -47.5), 50, 1e-9, "between the first two");
near(s(-165, -52.5), 101, 1e-9, "second column, second row");
// half way across the seam, between the last column (3500) and the first (0)
near(s(180, -47.5), 1750, 1e-9, "across 180");
near(s(-180, -47.5), 1750, 1e-9, "across -180");
// no-data reads as sea level
const nd = windowSampler({ ...win, elev: new Float32Array(W * H).fill(-32768) });
assert.equal(nd(0, -60), 0);

// lon, lat at the lattice: the middle vertex is the pole
const ll = latticeLonLat(lattice(2, 1e6));
near(ll[9], -90, 1e-9, "pole");
assert.ok(ll[1] > -90 && ll[1] < -70);

// two windows side by side, each with readGebcoWindow's two cells of margin:
// each half of the world is read from its own
const half = (west, v) => ({ elev: new Float32Array(22 * 3).fill(v), width: 22, height: 3, west: west - 20, north: -60, dx: 10, dy: 10 });
const two = stripSampler([half(-180, 1), half(0, 2)]);
assert.equal(two(-90, -70), 1);
assert.equal(two(90, -70), 2);
assert.equal(two(-179, -70), 1);

// a meridian section: from the pole straight out, ending at the square's edge
const m = meridianPoints(140, 4.5e6, 10e3);
near(Math.hypot(m[0].x, m[0].y), 0, 1e-9, "starts at the pole");
assert.equal(m[0].lat, -90);
const last = m.at(-1);
near(Math.max(Math.abs(last.x), Math.abs(last.y)), 4.5e6, 1e-6, "edge");
for (const p of m.slice(1)) near(PS.inverse(p.x, p.y)[0], 140, 1e-9, "on the meridian");
near(last.lat, -39.374, 1e-3, "140 E at the edge of a 4,500 km square");

// tilt: straight down, level, straight up
near(viewAngles([0, -1e6, 5], [0, -1e6, 0]).tilt, 0, 1e-9, "straight down");
near(viewAngles([0, -2e6, 0], [0, -1e6, 0]).tilt, 90, 1e-9, "level");
near(viewAngles([0, -1e6, -5], [0, -1e6, 0]).tilt, 180, 1e-9, "straight up");
assert.equal(viewAngles([0, -1e6, -5], [0, -1e6, 0]).below, true);

// heading: at 180 E (the target on -y) looking towards the pole is south and
// away from it north. Longitude grows clockwise round a Greenwich-up map, so
// at the bottom of it east is to the left (-x) and west to the right
const T = [0, -1e6, 0];
near(viewAngles([0, -2e6, 1], T).heading, 180, 1e-9, "towards the pole: south");
near(viewAngles([0, 0, 1], T).heading, 0, 1e-9, "away from the pole: north");
const [lonL] = PS.inverse(-1000, -1e6), [lonR] = PS.inverse(1000, -1e6);
assert.ok(lonL < -179.9 && lonR > 179.9, "left of 180 is past it (-179.9), right is short of it (179.9)");
near(viewAngles([1e6, -1e6, 1], T).heading, 90, 1e-9, "along -x at 180 E: east");
near(viewAngles([-1e6, -1e6, 1], T).heading, 270, 1e-9, "along +x at 180 E: west");
// at 90 E (target on +x) north is +x and east is -y
near(viewAngles([1e6, 0, 1], [2e6, 0, 0]).heading, 0, 1e-9, "90 E outwards: north");
near(viewAngles([2e6, 1e6, 1], [2e6, 0, 0]).heading, 90, 1e-9, "90 E along -y: east");
// at the pole, grid bearings from +y
const pole = viewAngles([0, -1, 1], [0, 0, 0]);
assert.equal(pole.grid, true);
near(pole.heading, 0, 1e-9, "pole, along +y");
// straight down has no heading
assert.equal(viewAngles([3, 4, 9], [3, 4, 0]).heading, null);

assert.equal(compass(0), "N");
assert.equal(compass(359), "N");
assert.equal(compass(100), "E");
assert.equal(compass(202.5), "SSW");
assert.equal(compass(null), "");

// the wire mesh: every row and column segment once, each joining neighbours
const wl = latticeLines(4);
assert.equal(wl.length, 4 * 4 * 5);
const seen = new Set();
for (let s = 0; s < wl.length; s += 2) {
  const [a, b] = [wl[s], wl[s + 1]], [ia, ja, ib, jb] = [a % 5, Math.floor(a / 5), b % 5, Math.floor(b / 5)];
  assert.equal(Math.abs(ia - ib) + Math.abs(ja - jb), 1, `segment ${a}-${b} joins neighbours`);
  seen.add(`${Math.min(a, b)}-${Math.max(a, b)}`);
}
assert.equal(seen.size, wl.length / 2, "no segment twice");

// the rings: at right angles, clear of each other, the first two and the
// last two linked (one ring passes through the other's disc an odd number
// of times) and the first and last not
const RR = 1.1, rings = linkedRings(RR);
const basis = (ax) => {
  const a = Math.abs(ax[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = [ax[1] * a[2] - ax[2] * a[1], ax[2] * a[0] - ax[0] * a[2], ax[0] * a[1] - ax[1] * a[0]];
  const v = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]];
  return [u, v];
};
const onRing = (q, t) => { const [u, v] = basis(q.axis); return [0, 1, 2].map((k) => q.centre[k] + RR * (Math.cos(t) * u[k] + Math.sin(t) * v[k])); };
const K = 720, pts = rings.map((q) => Array.from({ length: K }, (_, i) => onRing(q, (2 * Math.PI * i) / K)));
function gap(a, b) {
  let m = Infinity;
  for (const p of pts[a]) for (const q of pts[b]) m = Math.min(m, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
  return m;
}
function throughDisc(a, b) {
  // how often ring a crosses the plane of ring b inside its circle
  const q = rings[b], side = (p) => (p[0] - q.centre[0]) * q.axis[0] + (p[1] - q.centre[1]) * q.axis[1] + (p[2] - q.centre[2]) * q.axis[2];
  let n = 0;
  for (let i = 0; i < K; i++) {
    const p = pts[a][i], r = pts[a][(i + 1) % K], s0 = side(p), s1 = side(r);
    if (s0 * s1 > 0 || s0 === s1) continue;
    const t = s0 / (s0 - s1), x = [0, 1, 2].map((k) => p[k] + t * (r[k] - p[k]));
    if (Math.hypot(x[0] - q.centre[0], x[1] - q.centre[1], x[2] - q.centre[2]) < RR) n++;
  }
  return n;
}
for (const [a, b] of [[0, 1], [1, 2], [0, 2]]) {
  near(axisAngle(rings[a].axis, rings[b].axis), 90, 1e-9, `rings ${a} and ${b} at right angles`);
  assert.ok(gap(a, b) > 0.4 * RR, `rings ${a} and ${b} clear: ${gap(a, b)}`);
}
assert.equal(throughDisc(0, 1), 1, "the first ring through the second");
assert.equal(throughDisc(1, 0), 1, "and the second through the first");
assert.equal(throughDisc(1, 2), 1, "the second through the third");
assert.equal(throughDisc(2, 1), 1, "and the third through the second");
assert.equal(throughDisc(0, 2) + throughDisc(2, 0), 0, "the first and third not through each other at all");
near(Math.hypot(...[0, 1, 2].map((k) => rings.reduce((s, q) => s + q.centre[k], 0))), 0, 1e-12, "about their middle");

// line of sight against an axis, either way along it
near(axisAngle([0, 0, -1], [0, 0, 1]), 0, 1e-9, "straight along");
near(axisAngle([1, 0, 0], [0, 0, 1]), 90, 1e-9, "across");
near(axisAngle([1, 0, 1], [0, 0, 1]), 45, 1e-9, "half way");

// on the screen: right is +x, up is +z (a camera looking along +y)
const R = [1, 0, 0], U = [0, 0, 1];
near(screenBearing([0, 0, 1], R, U), 0, 1e-9, "straight up the screen");
near(screenBearing([1, 0, 1], R, U), 45, 1e-9, "up and to the right: clockwise");
near(screenBearing([-1, 0, 0], R, U), -90, 1e-9, "to the left: anticlockwise");
assert.equal(screenBearing([0, 1, 0], R, U), null, "along the line of sight");

// the globe: round trips, north, and where a line of sight meets it
for (const [lon, lat] of [[0, 0], [147.3, -42.9], [-120, 60], [179.9, -89]]) {
  const [a, b] = globeLonLat(globeXYZ(lon, lat, 2.5));
  near(a, lon, 1e-9, "globe lon"); near(b, lat, 1e-9, "globe lat");
}
assert.deepEqual(globeXYZ(90, 0).map((v) => +v.toFixed(12)), [0, 1, 0], "90 E on +y");
near(northAt(globeXYZ(30, 0))[2], 1, 1e-12, "north at the equator is +z");
const nh = northAt(globeXYZ(0, 45));
near(nh[0], -Math.SQRT1_2, 1e-12, "north at 45 N 0 E leans back over the pole"); near(nh[2], Math.SQRT1_2, 1e-12, "and up");
assert.equal(northAt([0, 0, 3]), null, "no north at the pole");
const hit = sphereHit([0, -10, 0], [0, 1, 0], 2.5);
near(hit[1], -2.5, 1e-12, "the near side");
assert.equal(sphereHit([0, -10, 0], [0, -1, 0], 2.5), null, "looking away");
assert.equal(sphereHit([0, -10, 3], [0, 1, 0], 2.5), null, "passing over");

console.log("navigate: lattice, triangles, wire mesh, window sampler, meridian section, tilt and heading, rings, globe and screen bearings all agree");
