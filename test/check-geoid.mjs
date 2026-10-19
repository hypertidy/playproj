// The geoid (src/core/geoid.js) against PROJ (test/fixtures/geoid-proj.json,
// from test/make-geoid-fixture.py): the shipped 1 degree EGM2008 grid read
// bilinear as PROJ's vgridshift reads it, how far that grid is from the full
// 2.5 minute model, and geocentric positions of points on the geoid.
import fs from "fs";
import * as G from "../src/core/geoid.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/geoid-proj.json", import.meta.url)));
const buf = fs.readFileSync(new URL("../data/geoid-egm2008-1deg.bin", import.meta.url));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };

const g = G.fromInt16(buf);
let sum = 0;
for (const v of g.N) sum += Math.round(v * 100);
check(sum === fx.grid.sum, `grid sums to ${sum} cm, not ${fx.grid.sum}`);
check(Math.round(g.min * 100) === fx.grid.min && Math.round(g.max * 100) === fx.grid.max, `grid range ${g.min} to ${g.max}`);
for (let j = 0; j < g.ny; j++) check(g.N[j * g.nx] === g.N[j * g.nx + g.nx - 1], `row ${j} does not repeat -180 at 180`);

// against PROJ on the same grid: only float32 rounding apart
let worst = 0, far = 0, rms = 0;
for (const [lon, lat, n1, nf] of fx.samples) {
  const n = G.undulation(g, lon, lat);
  worst = Math.max(worst, Math.abs(n - n1));
  far = Math.max(far, Math.abs(n - nf));
  rms += (n - nf) ** 2;
}
rms = Math.sqrt(rms / fx.samples.length);
check(worst < 1e-4, `bilinear read off PROJ vgridshift by ${worst} m`);
// a whole degree misses the short wavelengths: metres, not tens of metres
check(far < 8 && rms < 1, `1 degree grid is ${far} m (rms ${rms}) from the full model`);
console.log(`undulation: ${fx.samples.length} points, ${worst.toExponential(1)} m from PROJ on the 1 degree grid; ${far.toFixed(2)} m worst, ${rms.toFixed(2)} m rms from the full EGM2008 grid`);

// the extremes of the full model, near enough on the 1 degree grid
const [lo, hi] = [fx.full.min, fx.full.max];
check(Math.abs(G.undulation(g, lo[0], lo[1]) - lo[2]) < 8, `low ${lo} reads ${G.undulation(g, lo[0], lo[1])}`);
check(Math.abs(G.undulation(g, hi[0], hi[1]) - hi[2]) < 8, `high ${hi} reads ${G.undulation(g, hi[0], hi[1])}`);
console.log(`full model: ${lo[2]} m at ${lo[0]}, ${lo[1]} and ${hi[2]} m at ${hi[0]}, ${hi[1]}`);

// geocentric positions of geoid points against PROJ's EPSG:4979 to EPSG:4978
let gw = 0;
for (const [lon, lat, h, X, Y, Z] of fx.geocentric) {
  const p = G.geocentric(lon, lat, h);
  gw = Math.max(gw, Math.hypot(p[0] - X, p[1] - Y, p[2] - Z));
}
check(gw < 1e-3, `geocentric off PROJ by ${gw} m`);
console.log(`geocentric: ${fx.geocentric.length} points, ${gw.toExponential(1)} m from PROJ`);

// the geoid point is the ellipsoid point moved N along the normal
const e = G.geocentric(147, -42, 0), q = G.geocentric(147, -42, 50), n = G.normal(147, -42);
check(Math.hypot(q[0] - e[0] - 50 * n[0], q[1] - e[1] - 50 * n[1], q[2] - e[2] - 50 * n[2]) < 1e-6, "height is not along the normal");

// a profile ends at its ends, with the geodesic length
const pr = G.profile(g, 60, 5, 150, -5, 200);
const last = pr[pr.length - 1];
check(Math.abs(pr[0].lon - 60) < 1e-9 && Math.abs(last.lon - 150) < 1e-9, "profile ends moved");
check(Math.abs(last.s - 9.9e6) < 2e5, `profile length ${last.s}`);
check(pr.every((p, i) => !i || p.s > pr[i - 1].s), "profile distance does not grow");

// the deflection of the vertical: zero on a flat geoid, a few arcseconds here
const flat = G.fromInt16(new Int16Array(361 * 181));
check(G.deflection(flat, 10, 10).total === 0, "flat geoid has a deflection");
const d = G.deflection(g, 147.3, -42.9);
check(d.total > 0 && d.total < 60, `deflection at Hobart ${d.total} arcsec`);

if (fails) { console.log(`${fails} geoid checks failed`); process.exit(1); }
console.log("geoid ok");
