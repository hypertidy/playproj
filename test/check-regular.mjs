// Regular in what?: the example grids and geostationary scan angles against
// PROJ (test/fixtures/regular-proj.json), and the test recovering each
// example's CRS and grid from its lon/lat arrays alone.
import fs from "fs";
import proj4 from "proj4";
import * as R from "../src/core/regular.js";

R.init(proj4);
const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/regular-proj.json", import.meta.url)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };
const dLon = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

// 1. each example's cell centres, as its lon/lat arrays hold them
let worst = 0;
for (const g of fx.grids) {
  const ex = R.exampleByKey(g.key);
  check(ex.key === g.key, `example ${g.key} exists`);
  for (const [i, j, lon, lat] of g.pts) {
    const ll = ex.lonlat(i, j);
    const e = ll ? Math.max(dLon(ll[0], lon), Math.abs(ll[1] - lat)) : Infinity;
    worst = Math.max(worst, e);
    check(e < 1e-7, `${g.key} cell ${i},${j}: ${ll} vs PROJ ${lon},${lat}`);
    const ij = ex.index(lon, lat);
    check(ij && Math.hypot(ij[0] - i, ij[1] - j) < 1e-5, `${g.key} index of ${lon},${lat}: ${ij} vs ${i},${j}`);
  }
}
console.log(`examples vs PROJ: worst ${worst.toExponential(1)} deg`);

// 2. scan angles on the sphere, both sweeps, and back
worst = 0;
for (const g of fx.geos)
  for (const [ax, ay, lon, lat] of g.pts) {
    const ll = R.scanToLonLat(ax, ay, g.sweep, g.rg);
    const e = ll ? Math.max(dLon(ll[0], lon), Math.abs(ll[1] - lat)) : Infinity;
    worst = Math.max(worst, e);
    check(e < 1e-8, `geos sweep ${g.sweep} at ${ax},${ay}: ${ll} vs PROJ ${lon},${lat}`);
    const back = R.lonLatToScan(lon, lat, g.sweep, g.rg);
    check(back && Math.hypot(back[0] - ax, back[1] - ay) < 1e-9, `geos sweep ${g.sweep} back at ${lon},${lat}: ${back}`);
  }
console.log(`scan angles vs PROJ: worst ${worst.toExponential(1)} deg`);

// 3. the fit: an affine grid is recovered exactly, a bent one is not
{
  const I = [], J = [], X = [], Y = [];
  for (let j = 0; j < 5; j++) for (let i = 0; i < 7; i++) { I.push(i); J.push(j); X.push(10 + 3 * i - 0.5 * j); Y.push(-4 + 0.2 * i + 2 * j); }
  const f = R.affineFit(I, J, X, Y);
  check(f && f.max < 1e-12 && Math.abs(f.a[1] - 3) < 1e-12 && Math.abs(f.b[2] - 2) < 1e-12, `affine recovers ${JSON.stringify(f && [f.a, f.b])}`);
  Y[Y.length - 1] += 2;  // one sample a cell out
  check(R.affineFit(I, J, X, Y).max > 0.5, "affine notices a bent sample");
}

// 4. the CRS and grid from the arrays alone (float32, ~600 samples)
const want = {
  oisst: { family: "longlat", gt: [0, 0.25, 0, -90, 0, 0.25] },
  goes: { family: "geos-x", lon0: -75, h: 35786023, step: 56e-6 },
  himawari: { family: "geos-y", lon0: 140.7, h: 35785863, gt: [-5500000, 2000, 0, 5500000, 0, -2000] },
  nsidc: { family: "stere-polar", crs: "+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +a=6378273 +b=6356889.449", gt: [-3850000, 25000, 0, 5850000, 0, -25000] },
  ease: { family: "laea-polar", crs: "+proj=laea +lat_0=90 +lon_0=0 +ellps=WGS84", gt: [-9000000, 25000, 0, 9000000, 0, -25000] },
  hrrr: { family: "lcc", crs: "+proj=lcc +lat_1=38.5 +lat_2=38.5 +lat_0=38.5 +lon_0=-97.5 +R=6371229", cell: 3000 },
  cordex: { family: "rotated", gt: [-28.43, 0.11, 0, -23.43, 0, 0.11] },
  modis: { family: "sinu", shape: "sphere", arc: 240 },
  tripolar: { none: true },
  "tripolar-south": { family: "merc", shape: "sphere", arc: 1 }
};
for (const ex of R.EXAMPLES) {
  const w = want[ex.key];
  const list = await R.testAll(R.sampleExample(ex, 25));
  const best = list[0], v = R.verdict(best.fit);
  if (w.none) { check(v === "no", `${ex.key}: nothing should be regular, got ${best.family} ${best.fit.max}`); continue; }
  check(v === "regular", `${ex.key}: best ${best.family}/${best.shape} misses by ${best.fit.max} cells`);
  check(best.family === w.family, `${ex.key}: best is ${best.family}, want ${w.family}`);
  if (w.shape) check(best.shape === w.shape, `${ex.key}: shape ${best.shape}, want ${w.shape}`);
  const d = R.describeResult(best);
  if (w.crs) check(d.crs === w.crs, `${ex.key}: ${d.crs}\n   want ${w.crs}`);
  if (w.gt) check(d.gt.every((x, k) => Math.abs(x - w.gt[k]) < 1e-6 * Math.max(1, Math.abs(w.gt[k]))), `${ex.key}: geotransform ${d.gt}, want ${w.gt}`);
  if (w.cell) check(Math.abs(d.gt[1] - w.cell) < 1e-6 && Math.abs(d.gt[5] - w.cell) < 1e-6, `${ex.key}: cell ${d.gt[1]}, ${d.gt[5]}`);
  if (w.arc) check(d.grid.arc === w.arc, `${ex.key}: 1/${d.grid.arc} degree of arc, want 1/${w.arc}`);
  if (w.lon0 !== undefined) check(Math.abs(best.params[0] - w.lon0) < 1e-3, `${ex.key}: lon_0 ${best.params[0]}`);
  if (w.h) check(Math.abs(d.grid.h - w.h) < 50, `${ex.key}: h ${d.grid.h}, want ${w.h}`);
  if (w.step) check(Math.abs(Math.abs(d.grid.angleStep[0]) - w.step) < 1e-11, `${ex.key}: scan step ${d.grid.angleStep}`);
  // the other sweep is clearly not it
  if (ex.key === "goes" || ex.key === "himawari") {
    const other = list.find((r) => r.family.startsWith("geos") && r.family !== best.family);
    check(other && other.fit.max > 1, `${ex.key}: the other sweep misses by ${other && other.fit.max} cells`);
  }
}

// 5. pasted text
{
  const s = R.parseSamples("# i j lon lat\n0 0 10 20\n1 0 11 20\n0 1 10 21\n1 1 11 21");
  check(s.i.length === 4 && s.ni === 2 && s.nj === 2, `parse four columns: ${JSON.stringify(s)}`);
  const t = R.parseSamples('{"lon": [[10, 11], [10, 11]], "lat": [[20, 20], [21, 21]]}');
  check(t.i.length === 4 && t.lat[2] === 21 && t.j[2] === 1, `parse JSON: ${JSON.stringify(t)}`);
  const u = R.parseSamples("10 20\n11 20\n10 21\n11 21", 2);
  check(u.i[3] === 1 && u.j[3] === 1, `parse two columns: ${JSON.stringify(u)}`);
  let threw = false;
  try { R.parseSamples("10 20\n11 20"); } catch (e) { threw = true; }
  check(threw, "two columns without a row length is an error");
}

console.log(fails ? `${fails} failures` : "regular: all checks pass");
process.exit(fails ? 1 : 0);
