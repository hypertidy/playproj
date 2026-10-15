// Compare the geometric construction with proj4js for every case that has a
// PROJ equivalent. Run with: node test/check-proj.mjs (needs `npm i proj4`).
import proj4 from "proj4";
import { R, project, proj4String } from "../js/families/perspective.js";

const cases = [];
for (const a of [-1, 0, 1.5, 2, 5, 40, Infinity])
  for (const [lat0, lon0] of [[-90, 0], [90, 0], [0, 0], [-42, 147], [35, -120]])
    cases.push({ a, lat0, lon0 });

let worst = 0, fails = 0;
for (const p of cases) {
  const tr = proj4("+proj=longlat +R=" + R, proj4String(p));
  let maxd = 0, n = 0;
  for (let lon = -180; lon < 180; lon += 7.3)
    for (let lat = -89; lat <= 89; lat += 5.1) {
      const xy = project(lon, lat, p, 1e-3);
      if (!xy) continue;
      const q = tr.forward([lon, lat]);
      if (!isFinite(q[0]) || !isFinite(q[1])) continue;
      const d = Math.hypot(xy[0] * R - q[0], xy[1] * R - q[1]) / R / Math.max(1, Math.hypot(...xy));
      maxd = Math.max(maxd, d); n++;
    }
  worst = Math.max(worst, maxd);
  const ok = maxd < 1e-9 && n > 20;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${proj4String(p).padEnd(70)} n=${n} maxrel=${maxd.toExponential(2)}`);
}
console.log(`worst relative difference ${worst.toExponential(2)}, ${fails} failing`);
process.exit(fails ? 1 : 0);
