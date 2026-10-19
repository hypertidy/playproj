// Rhumb lines and great circles (src/core/rhumb.js) against PROJ (in
// test/fixtures/rhumb-proj.json): geodesic lengths and courses, rhumb line
// lengths and midpoints, the vertex of the great circle, and the composite
// great circle sailing round a limiting latitude.
import fs from "fs";
import * as H from "../src/core/rhumb.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/rhumb-proj.json", import.meta.url)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };
const dAng = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

for (const p of fx.pairs) {
  const [lon1, lat1] = p.p1, [lon2, lat2] = p.p2;
  const g = H.geodesicInverse(lon1, lat1, lon2, lat2), r = H.rhumbInverse(lon1, lat1, lon2, lat2);
  const gs = Math.abs(g.s - p.geodesic.s), ga = Math.max(dAng(g.azi1, p.geodesic.azi1), dAng(g.azi2, p.geodesic.azi2));
  // the reference rhumb length is a sum of short geodesics, so a little
  // short of the curve: within a millimetre a thousand kilometres
  const rs = Math.abs(r.s - p.rhumb.s), rtol = 1e-3 + 1e-9 * p.rhumb.s;
  const mid = H.rhumbPoints(lon1, lat1, lon2, lat2, 2)[1];
  const md = Math.max(dAng(mid[0], p.rhumb.mid[0]) * Math.cos(mid[1] * Math.PI / 180), Math.abs(mid[1] - p.rhumb.mid[1]));
  const vx = H.vertexLatitude(lat1, g.azi1), between = Math.abs(p.vertex) > Math.max(Math.abs(lat1), Math.abs(lat2)) + 1e-6;
  check(gs < 1e-3, `${p.name}: geodesic off by ${gs} m`);
  check(ga < 1e-8, `${p.name}: geodesic courses off by ${ga} degrees`);
  check(rs < rtol, `${p.name}: rhumb length off by ${rs} m`);
  check(md < 1e-9, `${p.name}: rhumb midpoint off by ${md} degrees`);
  if (between) check(Math.abs(vx - p.vertex) < 1e-4, `${p.name}: vertex ${vx} not ${p.vertex}`);
  console.log(`${p.name.padEnd(28)} geodesic ${(p.geodesic.s / 1000).toFixed(1).padStart(8)} km (${gs.toExponential(1)} m), rhumb ${(r.s / 1000).toFixed(1).padStart(8)} km (${rs.toExponential(1)} m), +${((r.s / g.s - 1) * 100).toFixed(2)}%`);
}

// isometric latitude and back
let iso = 0;
for (let lat = -89.5; lat <= 89.5; lat += 0.5) iso = Math.max(iso, Math.abs(H.fromIsometric(H.isometric(lat * Math.PI / 180)) * 180 / Math.PI - lat));
check(iso < 1e-12, `isometric latitude round trip off by ${iso} degrees`);

// the meridian quadrant (10 001 965.729 m on WGS84)
check(Math.abs(H.meridian(Math.PI / 2) - 10001965.7293) < 1e-3, `meridian quadrant ${H.meridian(Math.PI / 2)}`);

// a rhumb line on a parallel is the parallel, and a rhumb line due north
// or south is the meridian: the same as the geodesic
const meri = H.rhumbInverse(30, -10, 30, -70), meriG = H.geodesicInverse(30, -10, 30, -70);
check(Math.abs(meri.s - meriG.s) < 1e-3 && dAng(meri.azi, 180) < 1e-12, "rhumb along a meridian");
const par = H.rhumbInverse(10, -60, 50, -60);
check(dAng(par.azi, 90) < 1e-12, "rhumb along a parallel heads east");

// the whole loxodrome: through the start, poleward both ways, and the
// length of the meridian over |cos| of the course
const lox = H.loxodrome(147.3272, -42.8821, 230);
check(Math.abs(lox[0][1] + 89.9) < 1e-9 && Math.abs(lox[lox.length - 1][1] - 89.9) < 1e-9, "loxodrome runs pole to pole");
let near = Infinity;
for (const [lon, lat] of lox) near = Math.min(near, H.greatCircle(lon, lat, 147.3272, -42.8821).s);
check(near < 1e-6, `loxodrome passes ${near} m from its start`);
check(Math.abs(H.loxodromeLength(0) - 2 * 10001965.7293) < 1e-2, "loxodrome due north is the meridian");

// composite sailing round the ice: the legs touch the limit due east or
// west, the path stays on the near side of it, and it is longer than the
// great circle and shorter than the rhumb line
for (const [lon1, lat1, lon2, lat2, lim] of [[147.3272, -42.8821, 18.4241, -33.9249, -50], [147.3272, -42.8821, 62.8742, -55, -58], [172.7194, -43.6033, -70.9171, -53.1638, -60]]) {
  const c = H.composite(lon1, lat1, lon2, lat2, lim);
  check(c !== null, `composite ${lon1},${lat1} to ${lon2},${lat2} at ${lim}`);
  if (!c) continue;
  const [v1, v2] = c.vertices;
  const t1 = H.greatCircle(lon1, lat1, v1[0], v1[1]).azi2, t2 = H.greatCircle(v2[0], v2[1], lon2, lat2).azi1;
  check(Math.min(dAng(t1, 90), dAng(t1, 270)) < 1e-6 && Math.min(dAng(t2, 90), dAng(t2, 270)) < 1e-6, `composite legs touch the limit (${t1}, ${t2})`);
  check(Math.abs(H.greatCircle(lon1, lat1, v1[0], v1[1]).s - c.legs[0]) < 1e-3 && Math.abs(H.greatCircle(v2[0], v2[1], lon2, lat2).s - c.legs[2]) < 1e-3, "composite leg lengths");
  check(c.points.every(([, la]) => la >= lim - 1e-9), "composite stays north of the limit");
  const gc = H.greatCircle(lon1, lat1, lon2, lat2).s, rh = H.rhumbInverse(lon1, lat1, lon2, lat2, { a: H.R_MEAN, f: 0 }).s;
  check(c.s > gc && c.s < rh, `composite ${c.s} between great circle ${gc} and rhumb ${rh}`);
  console.log(`composite at ${lim}: ${(c.s / 1000).toFixed(1)} km, great circle ${(gc / 1000).toFixed(1)}, rhumb ${(rh / 1000).toFixed(1)}`);
}
// no composite where the great circle already keeps north of the limit
check(H.composite(147.3272, -42.8821, 158.9369, -54.4994, -60) === null, "no composite when not needed");

// the rhumb line's greatest distance from the great circle is in the middle
// for a pair on one parallel
const sep = H.separation(10, -60, 50, -60);
check(Math.abs(sep.lon - 30) < 0.5, `separation at ${sep.lon}`);

if (fails) { console.log(`${fails} rhumb checks failed`); process.exit(1); }
console.log(`rhumb lines and great circles agree with ${fx.source}`);
