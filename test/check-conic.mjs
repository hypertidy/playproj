// Cone family: compare with proj4js for every property and standard
// parallel (including the cylinder and plane limits), and round-trip the
// inverse.
import proj4 from "proj4";
import { R, project, inverse, proj4String } from "../src/core/families/conic.js";

let fails = 0, worst = 0, worstInv = 0, n = 0;
for (const prop of ["eqd", "conf", "area"])
  for (const lat1 of [0, 10, 30, 45, 60, 89, 90, -20, -45, -90])
    for (const lon0 of [0, 147, -120]) {
      const p = { prop, lat1, lon0 };
      const tr = proj4("+proj=longlat +R=" + R, proj4String(p));
      let maxd = 0, maxi = 0, m = 0;
      for (let lon = -179; lon < 180; lon += 7.3)
        for (let lat = -85; lat <= 85; lat += 5.1) {
          const xy = project(lon, lat, p);
          if (!xy) continue;
          const q = tr.forward([lon, lat]);
          if (isFinite(q[0]) && isFinite(q[1])) {
            const d = Math.hypot(xy[0] * R - q[0], xy[1] * R - q[1]) / R / Math.max(1, Math.hypot(...xy));
            maxd = Math.max(maxd, d); m++;
          }
          const ll = inverse(xy[0], xy[1], p);
          if (!ll) { maxi = Infinity; continue; }
          let dl = Math.abs(ll[0] - lon); dl = Math.min(dl, 360 - dl);
          maxi = Math.max(maxi, dl * Math.cos(lat * Math.PI / 180), Math.abs(ll[1] - lat));
        }
      n += m;
      worst = Math.max(worst, maxd); worstInv = Math.max(worstInv, maxi);
      const ok = maxd < 1e-9 && maxi < 1e-7 && m > 100;
      if (!ok) { fails++; console.log(`FAIL ${proj4String(p)} n=${m} proj4 ${maxd.toExponential(2)} inverse ${maxi}`); }
    }
console.log(`cone family: ${n} points vs proj4js, worst ${worst.toExponential(2)}; inverse worst ${worstInv.toExponential(2)} deg; ${fails} failing`);
process.exit(fails ? 1 : 0);
