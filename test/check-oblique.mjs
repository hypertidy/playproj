// Tilted cones and cylinders (oblique aspects) against PROJ itself: the
// conformal cylinder as +proj=omerc, the rest as +proj=ob_tran (fixture
// made with PROJ 9.8 from the strings below), plus the inverse round trip.
import { readFileSync } from "fs";
import { R, project, inverse, projString } from "../js/families/conic.js";

const cases = JSON.parse(readFileSync(new URL("./fixtures/oblique-proj.json", import.meta.url)));
let fails = 0, worst = 0, worstInv = 0, n = 0;
for (const c of cases) {
  const p = { prop: c.prop, lat1: c.lat1, lon0: c.lon0, tilt: c.tilt };
  const bad = [];
  if (projString(p) !== c.proj) bad.push(`string ${projString(p)}`);
  let maxd = 0, maxi = 0, m = 0;
  for (const [lon, lat, x, y] of c.pts) {
    const xy = project(lon, lat, p);
    if (!xy || Math.hypot(xy[0], xy[1]) > 20) continue; // far out on a conformal map
    m++;
    maxd = Math.max(maxd, Math.hypot(xy[0] * R - x, xy[1] * R - y) / Math.max(1, Math.hypot(xy[0], xy[1])));
    const ll = inverse(xy[0], xy[1], p);
    if (!ll) { maxi = Infinity; continue; }
    let dl = Math.abs(ll[0] - lon); dl = Math.min(dl, 360 - dl);
    maxi = Math.max(maxi, dl * Math.cos(lat * Math.PI / 180), Math.abs(ll[1] - lat));
  }
  n += m; worst = Math.max(worst, maxd); worstInv = Math.max(worstInv, maxi);
  if (maxd > 1e-3 || maxi > 1e-7 || m < 100) bad.push(`n=${m} vs PROJ ${maxd.toExponential(2)} m, inverse ${maxi}`);
  if (bad.length) { fails++; console.log(`FAIL ${c.proj}: ${bad.join("; ")}`); }
}
console.log(`oblique aspects: ${n} points vs PROJ, worst ${worst.toExponential(2)} m (per radius from the origin); inverse worst ${worstInv.toExponential(2)} deg; ${fails} failing`);
if (fails) process.exit(1);
