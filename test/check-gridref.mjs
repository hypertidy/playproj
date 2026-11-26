// Grid references (src/core/gridref.js) against PROJ
// (test/fixtures/gridref-proj.json, from test/make-gridref-fixture.py):
// point scale, grid convergence and the false origins, then the short
// references, the street-directory pages and the digits on their own.
import fs from "fs";
import * as G from "../src/core/gridref.js";
import * as M from "../src/core/mgrs.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/gridref-proj.json", import.meta.url)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };

let dk = 0, dc = 0, dxy = 0;
for (const p of fx.points) {
  const [lon, lat] = p.ll;
  const u = M.toUTM(lon, lat, p.zone, lat < 0);
  dxy = Math.max(dxy, Math.hypot(u.e - p.e, u.n - p.n));
  const s = G.scaleAndConvergence(lon, lat, p.zone);
  dk = Math.max(dk, Math.abs(s.k - p.k));
  // PROJ's meridian convergence is the angle the other way round
  dc = Math.max(dc, Math.abs(s.conv + p.conv));
}
check(dxy < 1e-3, `UTM off PROJ by ${dxy} m`);
check(dk < 1e-7, `point scale off PROJ by ${dk}`);
check(dc < 1e-6, `convergence off PROJ by ${dc} degrees`);
console.log(`${fx.points.length} points: UTM ${dxy.toExponential(1)} m, k ${dk.toExponential(1)}, convergence ${dc.toExponential(1)} deg from PROJ`);

for (const o of fx.origins) {
  const [lon, lat] = G.falseOrigin(o.zone, o.south);
  const dl = Math.abs(((lon - o.ll[0] + 540) % 360) - 180);
  check(dl < 1e-7 && Math.abs(lat - o.ll[1]) < 1e-7, `zone ${o.zone}${o.south ? "S" : "N"} origin ${lon},${lat} vs ${o.ll}`);
}

// Fern Tree
const d = G.describe(147.2625, -42.9216);
check(d.zone === 55 && d.south && d.gzd === "55G" && d.square === "EN", `Fern Tree zone ${d.gzd} ${d.square}`);
check(d.mgrs === "55G EN 21423 47857", `Fern Tree MGRS ${d.mgrs}`);
check(d.six.join("") === "214478" && d.eight.join("") === "21424785", `Fern Tree refs ${d.six} ${d.eight}`);
check(d.atlas.page === 256 && d.atlas.letter === "C" && d.atlas.number === 5, `Fern Tree atlas ${d.atlas.page} ${d.atlas.letter}${d.atlas.number}`);
check(Math.abs(d.fromCM - 21423.13) < 0.01 && Math.abs(d.fromEquator - 4752142.09) < 0.01, `Fern Tree offsets ${d.fromCM} ${d.fromEquator}`);
const pg = G.atlasPage(256, d.e, d.n);
check(pg.west === d.atlas.west && pg.north === d.atlas.north, "atlasPage disagrees with atlas");
check(d.e >= d.atlas.west && d.e < d.atlas.east && d.n <= d.atlas.north && d.n > d.atlas.south, "point off its page");

// every point on its page and square, pages numbered 1-500 in each 100 km square
for (let i = 0; i < 2000; i++) {
  const e = 166000 + Math.random() * 668000, n = Math.random() * 1e7;
  const a = G.atlas(e, n);
  check(a.page >= 1 && a.page <= 500, `page ${a.page}`);
  check(e >= a.squareWest && e < a.squareWest + 500 && n <= a.squareNorth && n > a.squareNorth - 500 - 1e-9, `square at ${e},${n}`);
}

// digits
const s = G.splitDigits(5247857.91);
check(s.hundredKm === "52" && s.km === "47" && s.hundredM === "8" && s.tenM === "5" && s.m === "7", `split ${JSON.stringify(s)}`);
check(G.splitDigits(521423).hundredKm === "5", "split easting");

// geometry: the south pole and the true-scale lines
check(Math.abs(G.poleNorthing(true) - 2035.0571) < 1e-3, `pole northing ${G.poleNorthing(true)}`);
const off = G.trueScaleOffset(-42.9);
check(off > 179000 && off < 182000, `true scale at ${off} m from the central meridian`);
check(Math.abs(G.zoneWidth(0) - 667956) < 100, `zone width at the equator ${G.zoneWidth(0)}`);

if (fails) { console.log(`${fails} failures`); process.exit(1); }
console.log("gridref ok");
