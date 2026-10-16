// Checks js/rasterize.js against GDAL's rasterize (centre in, and
// ALL_TOUCHED) and exactextract's coverage fractions, on the polygons and
// grids in test/fixtures/rasterize.json (test/make-rasterize-fixture.py),
// and checks the densify-and-project step against pyproj.

import { readFileSync } from "node:fs";
import proj4 from "proj4";
import * as R from "../js/rasterize.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/rasterize.json", import.meta.url)));
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log("FAIL", msg); } };

for (const c of fx.cases) {
  const G = c.grid, W = G.width, H = G.height;
  const polys = [{ outer: c.rings[0], holes: c.rings.slice(1) }];
  const px = R.toPixel(polys, G);
  const mask = R.centreIn(px, W, H);
  const cov = R.coverage(px, W, H);

  // centre in: the same cells as GDAL
  const want = new Set(c.centre);
  let miss = 0, extra = 0;
  for (let i = 0; i < W * H; i++) {
    if (mask[i] && !want.has(i)) extra++;
    if (!mask[i] && want.has(i)) miss++;
  }
  check(miss === 0 && extra === 0, `${c.name}: centre in differs from GDAL (${miss} missing, ${extra} extra of ${want.size})`);

  // coverage: the same fractions as exactextract
  const ref = new Float64Array(W * H);
  for (const [k, f] of c.coverage) ref[k] = f;
  let worst = 0, sum = 0, refSum = 0;
  for (let i = 0; i < W * H; i++) { worst = Math.max(worst, Math.abs(cov[i] - ref[i])); sum += cov[i]; refSum += ref[i]; }
  check(worst < 2e-6, `${c.name}: coverage differs from exactextract by up to ${worst}`);

  // all touched: GDAL burns every cell the boundary meets, which is every
  // cell with coverage above zero, plus cells only grazed at an edge or corner
  const touched = new Set(c.touched);
  let notTouched = 0;
  for (let i = 0; i < W * H; i++) if (cov[i] > 0 && !touched.has(i)) notTouched++;
  check(notTouched === 0, `${c.name}: ${notTouched} cells with coverage that GDAL ALL_TOUCHED leaves out`);
  const grazed = c.touched.filter((i) => !(cov[i] > 0)).length;

  // the coverage adds up to the polygon's area
  const area = R.polygonArea(px);
  check(Math.abs(sum - area) < 1e-6 * area, `${c.name}: coverage sums to ${sum}, area is ${area}`);

  // densify and project the longitude-latitude rings as the page does
  let projErr = 0;
  if (c.lonlat) {
    const P = c.crs === "EPSG:4326" ? null : proj4(c.crs === "EPSG:3857" ? "EPSG:3857" : c.crs === "EPSG:3031"
      ? "+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs" : c.crs);
    const fwd = P ? (lon, lat) => P.forward([lon, lat]) : (lon, lat) => [lon, lat];
    const mine = R.projectPolys([{ outer: c.lonlat[0], holes: c.lonlat.slice(1) }], fwd)[0];
    const a = mine.outer, b = c.rings[0];
    check(a.length === b.length, `${c.name}: ${a.length / 2} projected points, pyproj has ${b.length / 2}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) projErr = Math.max(projErr, Math.abs(a[i] - b[i]));
    check(projErr < (P ? 1e-3 : 1e-9), `${c.name}: projected vertices differ from pyproj by ${projErr}`);
  }
  console.log(`${c.name}: ${W}x${H}, ${want.size} centre in, ${c.coverage.length} covered, ${grazed} only grazed; max coverage diff ${worst.toExponential(1)}` +
    (c.lonlat ? `, projection ${projErr.toExponential(1)}` : ""));
}
// storage counts on a small case worked by hand: a 6 x 4 grid, a 2 x 2 tiling
{
  const mask = Uint8Array.from([0,1,1,0,0,0, 0,1,1,1,0,0, 0,0,0,0,0,0, 0,0,0,0,0,1]);
  const cov = Float64Array.from(mask, (v, i) => (v ? 1 : i === 0 ? 0.25 : 0));
  const s = R.summarise(mask, cov, 6, 4, { tw: 2 });
  check(s.nIn === 6 && s.runsIn === 3 && s.nEdge === 1 && s.nFull === 6, `summary counts ${JSON.stringify([s.nIn, s.runsIn, s.nEdge, s.nFull])}`);
  check([...s.tilesIn].sort().join() === "0,1,5" && s.tilesAny.size === 3 && s.tilesAll === 6, `tiles ${[...s.tilesIn]} of ${s.tilesAll}`);
  check(s.bboxCells === 24 && s.bytes.runsMask === 36 && s.bytes.runsEdges === 3 * 12 + 8, `bytes ${JSON.stringify(s.bytes)}`);
  // the same cells as a window at (3, 1) on a raster with 4-cell tiles, 3 tiles across
  const w = R.summarise(mask, cov, 6, 4, { tw: 4, ox: 3, oy: 1, tilesX: 3 });
  check([...w.tilesIn].sort().join() === "1,5" && w.tilesAll === 6, `window tiles ${[...w.tilesIn]} of ${w.tilesAll}`);
}

// a spike out and back along a line, its points not matching, folds away
{
  const ring = [[0, 0], [4, 0], [4, 4], [2, 4], [2, 6], [2, 7.5], [2, 5.2], [2, 4.1], [0, 4]];
  const o = R.unspike(ring);
  check(JSON.stringify(o) === JSON.stringify([[0, 0], [4, 0], [4, 4], [2, 4], [2, 4.1], [0, 4]]), `unspike: ${JSON.stringify(o)}`);
  const c = R.unspike([[1, 1], [0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]);
  check(c.length === 4, `unspike round the closing point: ${JSON.stringify(c)}`);
}

if (fail) { console.log(`${fail} failures`); process.exit(1); }
console.log("rasterize ok");
