// Spilhaus: compare the JS port with points projected by PROJ itself
// (test/fixtures/spilhaus-proj.json, from PROJ 9 via GDAL), and round-trip
// the inverse, exact and interpolated.
import fs from "fs";
import { R, project, inverse, inverseGrid } from "../src/core/families/spilhaus.js";

const cases = JSON.parse(fs.readFileSync(new URL("./fixtures/spilhaus-proj.json", import.meta.url)));
let fails = 0;
for (const { p, proj, pts } of cases) {
  const g = inverseGrid(p, 256);
  let fwd = 0, inv = 0, interp = 0, misses = 0;
  for (const [lon, lat, x, y] of pts) {
    const xy = project(lon, lat, p);
    fwd = Math.max(fwd, Math.hypot(xy[0] * R - x, xy[1] * R - y));
    for (const [f, tol] of [[inverse, 1e-6], [g.inverse, 0.05]]) {
      const ll = f(xy[0], xy[1], p);
      if (!ll) { misses++; continue; }
      let dl = Math.abs(ll[0] - lon); dl = Math.min(dl, 360 - dl);
      const d = Math.max(dl * Math.cos(lat * Math.PI / 180), Math.abs(ll[1] - lat));
      if (f === inverse) inv = Math.max(inv, d); else interp = Math.max(interp, d);
    }
  }
  const ok = fwd < 1e-3 && inv < 1e-6 && interp < 0.05 && misses <= 2;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${proj.padEnd(62)} vs PROJ ${fwd.toExponential(2)} m; inverse ${inv.toExponential(2)} deg; interpolated ${interp.toExponential(2)} deg; misses ${misses}`);
}
process.exit(fails ? 1 : 0);
