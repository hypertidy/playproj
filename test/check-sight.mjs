// Sight and shade (src/core/sight.js): the horizon method against marching
// every line of sight, for eyes on the ground, eyes in the air, and the sun;
// and an eye pushed far enough away sees what the sun lights.
import * as S from "../src/core/sight.js";

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };

const T = S.makeTerrain({});
check(T.nv === 161 && Math.abs(T.size - 4800) < 1e-9, "terrain size");
check(Math.abs(S.heightAt(T, 30, 0) - T.z[1]) < 1e-9 && Math.abs(S.heightAt(T, 30, 30) - T.z[T.nv + 1]) < 1e-9, "TIN heights at nodes");

const agree = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += a[k] === b[k]; return s / a.length; };
const cases = [
  ["eye on the ground, centre", { x: 2400, y: 2400, h: 1.5, dist: 0 }],
  ["eye on a tower", { x: 1000, y: 3500, h: 30, dist: 0 }],
  ["eye 3 km up and away", { x: 2400, y: 2400, h: 1.5, dist: 3000, az: 300, el: 20 }],
  ["eye outside the grid", { x: 2400, y: 2400, h: 1.5, dist: 50000, az: 30, el: 10 }],
  ["sun, north-west, 15 degrees", { x: 0, y: 0, dist: Infinity, az: 315, el: 15 }],
  ["sun, east, 5 degrees", { x: 0, y: 0, dist: Infinity, az: 90, el: 5 }],
  ["sun, due north", { x: 0, y: 0, dist: Infinity, az: 0, el: 25 }]
];
for (const [name, c] of cases) {
  const L = S.lightFrom(T, c);
  const t0 = performance.now();
  const r = S.horizonVisible(T, L);
  const ms = performance.now() - t0;
  const los = new Uint8Array(r.vis.length);
  for (let k = 0; k < los.length; k++) los[k] = S.losVisible(T, L, k) ? 1 : 0;
  const a = agree(r.vis, los);
  check(a > 0.995, `${name}: ${(a * 100).toFixed(2)}% agree with the line of sight`);
  console.log(`${name.padEnd(28)} visible ${(S.visibleFraction(r.vis) * 100).toFixed(1).padStart(5)}%, agree ${(a * 100).toFixed(2)}%, ${ms.toFixed(0)} ms`);
}

// an eye 100 000 km away towards the sun sees what the sun lights
for (const [az, el] of [[315, 15], [120, 30]]) {
  const sun = S.horizonVisible(T, S.lightFrom(T, { x: 2400, y: 2400, az, el, dist: Infinity })).vis;
  const far = S.horizonVisible(T, S.lightFrom(T, { x: 2400, y: 2400, h: 0, az, el, dist: 1e8 })).vis;
  const a = agree(sun, far);
  check(a > 0.995, `far eye vs sun at ${az}/${el}: ${(a * 100).toFixed(2)}%`);
  console.log(`far eye vs sun at ${az}/${el}: ${(a * 100).toFixed(2)}% agree`);
}

// a gnomonic image keeps 3D straight lines straight: three points on a line
const L = S.lightFrom(T, { x: 1000, y: 1000, h: 5 });
const V = S.views(L)[0], q = (t) => [100 + 40 * t, 500 + 300 * t, -20 + 15 * t];
const [a, b, c] = [0, 0.37, 1].map((t) => S.uv(L, V, q(t)));
const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
check(Math.abs(cross) < 1e-12, `straight line not straight in the gnomonic image (${cross})`);

console.log(fails ? `${fails} failed` : "sight: all ok");
process.exit(fails ? 1 : 0);
