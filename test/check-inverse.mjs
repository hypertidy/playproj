// Round trip: project then inverse should return the starting lon/lat, for
// every light position including those with no PROJ equivalent.
import { project, inverse } from "../src/core/families/perspective.js";

let worst = 0, n = 0, fails = 0;
for (const a of [-40, -3, -1, -0.5, 0, 0.3, 0.7, 1.5, 3, 40, Infinity, -Infinity])
  for (const [lat0, lon0] of [[-90, 0], [90, 0], [0, 0], [-42, 147], [35, -120]]) {
    const p = { a, lat0, lon0 };
    let maxd = 0;
    for (let lon = -180; lon < 180; lon += 7.3)
      for (let lat = -89; lat <= 89; lat += 5.1) {
        const xy = project(lon, lat, p, 1e-3);
        if (!xy) continue;
        const ll = inverse(xy[0], xy[1], p, 0);
        if (!ll) { fails++; console.log("miss", a, lat0, lon0, lon, lat); continue; }
        let dl = Math.abs(ll[0] - lon); dl = Math.min(dl, 360 - dl) * Math.cos(lat * Math.PI / 180);
        maxd = Math.max(maxd, dl, Math.abs(ll[1] - lat));
        n++;
      }
    worst = Math.max(worst, maxd);
    if (maxd > 1e-8) { fails++; console.log(`FAIL a=${a} lat0=${lat0} lon0=${lon0} max ${maxd}`); }
  }
console.log(`inverse round trip: ${n} points, worst ${worst.toExponential(2)} deg, ${fails} failing`);
process.exit(fails ? 1 : 0);
