// The National Grid (src/core/osgb.js) against PROJ
// (test/fixtures/osgb-proj.json, from test/make-osgb-fixture.py): the
// projection, point scale and convergence, the Helmert shift from WGS84,
// the origins, and how far the Helmert lands from OSTN15; then the letter
// squares and grid references.
import fs from "fs";
import * as O from "../src/core/osgb.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/osgb-proj.json", import.meta.url)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };

let dxy = 0, dk = 0, dc = 0, dh = 0, dinv = 0, dost = 0;
for (const p of fx.points) {
  const [lon, lat] = p.ll;
  const [e, n] = O.toGrid(lon, lat);
  dxy = Math.max(dxy, Math.hypot(e - p.e, n - p.n));
  const [l2, p2] = O.fromGrid(e, n);
  dinv = Math.max(dinv, Math.hypot((l2 - lon) * 111e3 * Math.cos(lat * Math.PI / 180), (p2 - lat) * 111e3));
  const s = O.scaleAndConvergence(lon, lat);
  dk = Math.max(dk, Math.abs(s.k - p.k));
  dc = Math.max(dc, Math.abs(s.conv + p.conv));
  const h = O.fromWGS84(lon, lat);
  dh = Math.max(dh, Math.hypot((h[0] - p.helmert[0]) * 111e3 * Math.cos(lat * Math.PI / 180), (h[1] - p.helmert[1]) * 111e3));
  const b = O.toWGS84(...h);
  dinv = Math.max(dinv, Math.hypot((b[0] - lon) * 111e3, (b[1] - lat) * 111e3));
  const [eh, nh] = O.toGrid(...h);
  dost = Math.max(dost, Math.hypot(eh - p.ostn[0], nh - p.ostn[1]));
}
check(dxy < 1e-3, `grid off PROJ by ${dxy} m`);
check(dk < 1e-7, `point scale off PROJ by ${dk}`);
check(dc < 1e-6, `convergence off PROJ by ${dc} degrees`);
check(dh < 1e-3, `Helmert off PROJ by ${dh} m`);
check(dinv < 1e-3, `inverses off by ${dinv} m`);
check(dost < 8, `Helmert ${dost} m from OSTN15`);
console.log(`osgb: ${fx.points.length} points: grid ${dxy.toExponential(1)} m, k ${dk.toExponential(1)}, convergence ${dc.toExponential(1)} deg, Helmert ${dh.toExponential(1)} m from PROJ; Helmert within ${dost.toFixed(2)} m of OSTN15`);

const fo = O.fromGrid(0, 0), to = O.fromGrid(4e5, -1e5);
check(Math.abs(fo[0] - fx.falseOrigin[0]) < 1e-8 && Math.abs(fo[1] - fx.falseOrigin[1]) < 1e-8, `false origin ${fo}`);
check(Math.abs(to[0] - fx.trueOrigin[0]) < 1e-8 && Math.abs(to[1] - fx.trueOrigin[1]) < 1e-8, `true origin ${to}`);

// letters: the published squares
const want = { SV: [0, 0], TQ: [5e5, 1e5], NT: [3e5, 6e5], HU: [4e5, 1.1e6], HP: [4e5, 1.2e6], TG: [6e5, 3e5], NA: [0, 9e5], SH: [2e5, 3e5] };
for (const [k, [e, n]] of Object.entries(want)) {
  check(O.squareLetters(e + 1, n + 1) === k, `square at ${e},${n} is ${O.squareLetters(e + 1, n + 1)} not ${k}`);
  const o = O.squareOrigin(k);
  check(o && o[0] === e && o[1] === n, `origin of ${k} is ${o}`);
}
check(O.squareLetters(-1, 5) === null && O.squareLetters(7e5 + 1, 5) === null, "outside the grid has no letters");
// E 651409, N 313177 is TG 51409 13177
check(O.gridRef(651409, 313177, 10).text === "TG 51409 13177", "TG 51409 13177");
check(O.gridRef(651409, 313177, 6).text === "TG 514 131", "TG 514 131 (truncated)");
const g = O.describe(-0.0015, 51.4779);
check(g.six.text === "TQ 388 773", `Greenwich ${g.six.text}`);

// the made-up county atlas
const cp = O.countyPage(g.e, g.n);
check(cp && cp.page === 139 && cp.letter === "F" && cp.number === 8, `Greenwich atlas ${cp && cp.page + " " + cp.letter + cp.number}`);
const fr = O.countyFrame(cp.page);
check(fr.west === cp.west && fr.north === cp.north && fr.east - fr.west === 3000, "page frame");
check(O.countyPage(499999, 180000) === null && O.countyFrame(O.COUNTY.across * O.COUNTY.down + 1) === null, "outside the atlas");

if (fails) { console.log(`check-osgb: ${fails} failure(s)`); process.exit(1); }
console.log("check-osgb: ok");
