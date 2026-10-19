// Homage page: its projections against PROJ (test/fixtures/homage-proj.json),
// and the Greenland slide keeping area.
import fs from "fs";
import * as d3 from "d3-geo";
import { scene, camera, arc, obliquity, SYENE, ALEXANDRIA } from "../src/core/eratosthenes.js";
import { worldProjection, polar, slide, icosahedron, unfold, FULLER_VERTICES, trueSize, mercator } from "../src/core/homage-geo.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/homage-proj.json", import.meta.url)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };

for (const [k, c] of Object.entries(fx.proj)) {
  const p = (k === "aeqd" || k === "laea" ? polar(d3, k, -90) : worldProjection(d3, k)).scale(1).translate([0, 0]);
  if (p.clipAngle && k !== "aeqd" && k !== "laea") p.clipAngle(null);
  let worst = 0;
  for (const [lon, lat, x, y] of c.pts) {
    if ((k === "aeqd" || k === "laea") && lat < -89.9) continue;
    if (k === "vandg" && Math.abs(lon) === 180) continue;   // d3 nudges the antimeridian inward
    const q = p([lon, lat]);
    // d3 has y down; edge meridians may land on either side
    const e = Math.max(Math.abs(Math.abs(q[0]) - Math.abs(x)), Math.abs(-q[1] - y));
    if (e > worst) worst = e;
  }
  console.log(`${k.padEnd(10)} ${c.proj.padEnd(22)} worst ${worst.toExponential(2)}`);
  check(worst < 1e-6, `${k} vs ${fx.source}: ${worst}`);
}

// sliding a polygon along a meridian keeps its area and moves its centroid
const sq = { type: "Polygon", coordinates: [[[-50, 65], [-50, 78], [-30, 78], [-30, 65], [-50, 65]]] };
for (const dlat of [-10, -40, -72]) {
  const s = slide(d3, sq, -40, dlat);
  check(Math.abs(d3.geoArea(s) - d3.geoArea(sq)) < 1e-12, `slide ${dlat} keeps area`);
  const c0 = d3.geoCentroid(sq), c1 = d3.geoCentroid(s);
  check(Math.abs(c1[1] - (c0[1] + dlat)) < 1e-9 && Math.abs(c1[0] - c0[0]) < 1e-9, `slide ${dlat} centroid ${c1} from ${c0}`);
}

// Fuller's icosahedron is regular, and a net of it lies flat without overlap
const ico = icosahedron(d3);
check(ico.faces.length === 20 && ico.edges.length === 30, `icosahedron has ${ico.faces.length} faces, ${ico.edges.length} edges`);
for (let i = 0; i < 12; i++) {
  const far = FULLER_VERTICES.map((v) => d3.geoDistance(v, FULLER_VERTICES[i])).sort((a, b) => b - a)[0];
  check(Math.abs(far - Math.PI) < 1e-6, `vertex ${i} has an antipode (${far})`);
}
const net = unfold(ico, (a, b) => (a * 7 + b * 13) % 5);
check(net && net.cut.length === 30 - 19, "net from a spanning tree has 19 joins and 11 cuts");

// true size: a small square at 70N keeps its spherical area at k = 1 and
// has Mercator's at k = 0; the centroid lands where Mercator puts it
{
  const ring = [];
  for (let x = 0; x <= 10; x += 0.5) ring.push([20 + x, 65]);
  for (let y = 0; y <= 10; y += 0.5) ring.push([30, 65 + y]);
  for (let x = 10; x >= 0; x -= 0.5) ring.push([20 + x, 75]);
  for (let y = 10; y >= 0; y -= 0.5) ring.push([20, 65 + y]);
  const rings = [ring.reverse()], s = 100, t = [500, 500];
  const shoelace = (r) => Math.abs(r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  const sphere = d3.geoArea({ type: "Polygon", coordinates: rings }) * s * s;
  const one = trueSize(d3, rings, s, t, 1), zero = trueSize(d3, rings, s, t, 0);
  check(Math.abs(shoelace(one.rings[0]) / sphere - 1) < 1e-3, `true size area ${shoelace(one.rings[0])} vs sphere ${sphere}`);
  check(shoelace(zero.rings[0]) / sphere > 7, `Mercator inflates at 70N: ${shoelace(zero.rings[0]) / sphere}`);
  const m = mercator(s, t)(one.centre), p = d3.geoMercator().scale(s).translate(t)(one.centre);
  check(Math.hypot(m[0] - p[0], m[1] - p[1]) < 1e-9, "hand Mercator matches d3");
}

// Eratosthenes: with parallel rays, Alexandria's shadow angle less Syene's is
// the cities' angle at the centre, whatever the sun's height; the shadow tip
// lies on the ground plane at Alexandria
for (const sep of [1, 7.2, 30]) for (const zenith of [0, 6, 47.5]) {
  const s = scene({ sep, zenith, h: 0.3 });
  check(Math.abs(s.centre - sep) < 1e-9, `centre angle ${s.centre} vs ${sep}`);
  check(Math.abs(s.zenithA - s.zenithS - sep) < 1e-9, `shadow difference ${s.zenithA} - ${s.zenithS} vs ${sep}`);
  const d = s.shadow.map((x, i) => x - s.A[i]);
  check(Math.abs(d[0] * s.A[0] + d[1] * s.A[1] + d[2] * s.A[2]) < 1e-12, "shadow tip on the ground");
  check(Math.abs(s.shadowLength - 0.3 * Math.tan(s.zenithA * Math.PI / 180)) < 1e-12, "shadow length h tan(z)");
}
// the hand camera is d3's orthographic view
{
  const cam = camera(110.9, 18), p = d3.geoOrthographic().rotate([-110.9, -18]).scale(1).translate([0, 0]);
  let worst = 0;
  for (const [lon, lat] of [[32.9, 24.1], [29.9, 31.2], [150, -40], [100, 60]]) {
    const r = Math.PI / 180, P = [Math.cos(lat * r) * Math.cos(lon * r), Math.cos(lat * r) * Math.sin(lon * r), Math.sin(lat * r)];
    const [x, y] = cam(P), q = p([lon, lat]);
    worst = Math.max(worst, Math.abs(x - q[0]), Math.abs(-y - q[1]));
  }
  check(worst < 1e-12, `camera vs d3 orthographic ${worst}`);
  check(cam.hidden([0, 0, 0]) && !cam.hidden([0, 0, 5]), "centre hidden, far point not");
}
check(Math.abs(obliquity(2000) - 23.4392911) < 1e-6, `obliquity J2000 ${obliquity(2000)}`);
check(Math.abs(obliquity(-239) - 23.72) < 0.01, `obliquity 240 BC ${obliquity(-239)}`);
check(Math.abs(arc(SYENE, ALEXANDRIA) - 7.58) < 0.01, `Syene to Alexandria ${arc(SYENE, ALEXANDRIA)}`);

if (fails) { console.log(`${fails} failures`); process.exit(1); }
console.log("homage: ok");
