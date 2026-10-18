// Secant planes (true scale away from the tangent point): the construction
// against PROJ itself (fixture made with PROJ 9.8 from the strings below),
// and its inverse round trip. Polar stere uses +lat_ts, oblique stere
// +k_0, and gnom and nsper an affine step in a pipeline.
import { readFileSync } from "fs";
import { R, project, inverse, projString, lightFromSlider, planeScale } from "../src/core/families/perspective.js";

const cases = JSON.parse(readFileSync(new URL("./fixtures/secant-proj.json", import.meta.url)));
let fails = 0, worst = 0, worstInv = 0, n = 0;
for (const c of cases) {
  const p = { a: lightFromSlider(c.v), lat0: c.lat0, lon0: c.lon0, ts: c.ts };
  const bad = [];
  if (projString(p) !== c.proj) bad.push(`string ${projString(p)}`);
  let maxd = 0, maxi = 0, m = 0;
  for (const [lon, lat, x, y] of c.pts) {
    const xy = project(lon, lat, p);
    if (!xy) continue;
    m++;
    maxd = Math.max(maxd, Math.hypot(xy[0] * R - x, xy[1] * R - y));
    const ll = inverse(xy[0], xy[1], p);
    if (!ll) { maxi = Infinity; continue; }
    let dl = Math.abs(ll[0] - lon); dl = Math.min(dl, 360 - dl);
    maxi = Math.max(maxi, dl * Math.cos(lat * Math.PI / 180), Math.abs(ll[1] - lat));
  }
  n += m; worst = Math.max(worst, maxd); worstInv = Math.max(worstInv, maxi);
  if (maxd > 1e-3 || maxi > 1e-7 || m < 100) bad.push(`n=${m} vs PROJ ${maxd.toExponential(2)} m, inverse ${maxi}`);
  if (bad.length) { fails++; console.log(`FAIL ${c.proj}: ${bad.join("; ")}`); }
}
// the tangent plane is unchanged, and polar stere k0 is (1 + sin lat_ts) / 2
if (planeScale({ a: -1, lat0: 90, lon0: 0, ts: 90 }) !== 1) { fails++; console.log("FAIL tangent scale"); }
if (Math.abs(planeScale({ a: -1, lat0: 90, lon0: 0, ts: 60 }) - (1 + Math.sin(Math.PI / 3)) / 2) > 1e-15) { fails++; console.log("FAIL polar k0"); }
console.log(`secant planes: ${n} points vs PROJ, worst ${worst.toExponential(2)} m; inverse worst ${worstInv.toExponential(2)} deg; ${fails} failing`);
if (fails) process.exit(1);
