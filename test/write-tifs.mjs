// Writes small GeoTIFFs for several constructions so test/check-geotiff.py can
// confirm GDAL reads back the CRS. Usage: node test/write-tifs.mjs OUTDIR
import fs from "fs";
import * as persp from "../src/core/families/perspective.js";
import * as conic from "../src/core/families/conic.js";
import * as azi from "../src/core/families/azimuthal.js";
import * as spil from "../src/core/families/spilhaus.js";
import { writeGeoTIFF } from "../src/core/geotiff-write.js";

const out = process.argv[2];
const P = (p) => ({ fam: persp, p }), C = (p) => ({ fam: conic, p }), A = (p) => ({ fam: azi, p });
const cases = [
  P({ a: -1, lat0: -90, lon0: 0 }), P({ a: -1, lat0: -42, lon0: 147 }),
  P({ a: 0, lat0: 35, lon0: -120 }), P({ a: Infinity, lat0: 10, lon0: 20 }),
  P({ a: 2.5, lat0: -42, lon0: 147 }), P({ a: 0.4, lat0: 0, lon0: 0 }),
  P({ a: -1, lat0: -90, lon0: 0, ts: 71 }), P({ a: -1, lat0: -42, lon0: 147, ts: 45 })
];
for (const prop of ["eqd", "conf", "area"])
  for (const lat1 of [0, -40, 35, 90, -90]) cases.push(C({ prop, lat1, lon0: 147 }));
for (const mode of ["laea", "aeqd"])
  for (const [lat0, lon0] of [[-90, 0], [-42, 147], [35, -120]]) cases.push(A({ mode, lat0, lon0 }));
cases.push(C({ prop: "conf", lat1: 0, lon0: 147, tilt: 30 }), C({ prop: "conf", lat1: 0, lon0: 100, tilt: 90 }), C({ prop: "area", lat1: 40, lon0: 20, tilt: -35 }));
cases.push({ fam: spil, p: {} }, { fam: spil, p: { lon0: 147, lat0: -42, azi: 0 } });
const manifest = [];
for (const [i, { fam, p }] of cases.entries()) {
  const { R, project, geoKeys, projString } = fam;
  const n = 64, w = 2;
  const rgba = new Uint8ClampedArray(n * n * 4).fill(200);
  const blob = await writeGeoTIFF({ width: n, height: n, rgba, origin: [-w * R, w * R], pixelSize: [2 * w * R / n, 2 * w * R / n], geoKeys: geoKeys(p) });
  const file = `${out}/case${i}.tif`;
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  const pts = [[150, -40], [140, -60], [-110, 40], [30, 0], [10, -70], [5, 5], [160, 50], [120, 70]]
    .map(([lon, lat]) => ({ lon, lat, xy: project(lon, lat, p, 1e-3) }))
    .filter((q) => !q.xy || Math.hypot(...q.xy) < 20)
    .filter((q) => q.xy).map((q) => ({ lon: q.lon, lat: q.lat, x: q.xy[0] * R, y: q.xy[1] * R }));
  manifest.push({ file, proj: projString(p), pts });
}
fs.writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 1));
