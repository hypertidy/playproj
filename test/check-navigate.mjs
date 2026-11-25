// The Navigation page's geometry: the lattice and its triangles, GEBCO's
// window sampled with longitude wrapped, a meridian section, and the
// camera's tilt and heading.
import assert from "node:assert/strict";
import { PS, lattice, latticeTriangles, squareBox, windowSampler, latticeLonLat, stripSampler, meridianPoints, viewAngles, compass } from "../src/core/navigate.js";

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

console.log("navigate: lattice, triangles, window sampler, meridian section, tilt and heading all agree");
