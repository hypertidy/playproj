// Writes small GeoTIFFs for several constructions so test/check-geotiff.py can
// confirm GDAL reads back the CRS. Usage: node test/write-tifs.mjs OUTDIR
import fs from "fs";
import { R, project, geoKeys, projString } from "../js/families/perspective.js";
import { writeGeoTIFF } from "../js/geotiff-write.js";

const out = process.argv[2];
const cases = [
  { a: -1, lat0: -90, lon0: 0 }, { a: -1, lat0: -42, lon0: 147 },
  { a: 0, lat0: 35, lon0: -120 }, { a: Infinity, lat0: 10, lon0: 20 },
  { a: 2.5, lat0: -42, lon0: 147 }, { a: 0.4, lat0: 0, lon0: 0 }
];
const manifest = [];
for (const [i, p] of cases.entries()) {
  const n = 64, w = 2;
  const rgba = new Uint8ClampedArray(n * n * 4).fill(200);
  const blob = await writeGeoTIFF({ width: n, height: n, rgba, origin: [-w * R, w * R], pixelSize: [2 * w * R / n, 2 * w * R / n], geoKeys: geoKeys(p) });
  const file = `${out}/case${i}.tif`;
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  const pts = [[150, -40], [140, -60], [-110, 40], [30, 0], [10, -70], [5, 5]]
    .map(([lon, lat]) => ({ lon, lat, xy: project(lon, lat, p, 1e-3) }))
    .filter((q) => q.xy).map((q) => ({ lon: q.lon, lat: q.lat, x: q.xy[0] * R, y: q.xy[1] * R }));
  manifest.push({ file, proj: projString(p), pts });
}
fs.writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 1));
