// UTM, MGRS and Sentinel-2 tiles against test/fixtures/mgrs-points.json:
// UTM from PROJ (pyproj), MGRS references from GeoTrans (the mgrs Python
// package), and the tiles whose footprints in ESA's tiling grid contain
// each point. Made by test/make-mgrs-fixtures.py.
import fs from "fs";
import * as m from "../src/core/mgrs.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/mgrs-points.json", import.meta.url)));
const grid = m.tileSet(JSON.parse(fs.readFileSync(new URL("../data/s2-tiles.json", import.meta.url))));
let fails = 0, worst = 0, worstInv = 0, worstRef = 0;
const fail = (msg) => { if (++fails < 30) console.log("FAIL " + msg); };

for (const [lon, lat, zone, e, n, ref, tiles] of fx.points) {
  const u = m.toUTM(lon, lat);
  if (u.zone !== zone) fail(`${lon},${lat} zone ${u.zone} vs ${zone}`);
  const d = Math.hypot(u.e - e, u.n - n);
  worst = Math.max(worst, d);
  if (d > 1e-3) fail(`${lon},${lat} UTM off by ${d} m`);
  const [lon2, lat2] = m.fromUTM(u.zone, u.south, u.e, u.n);
  worstInv = Math.max(worstInv, Math.abs(lat2 - lat), Math.abs(lon2 - lon) * Math.cos(lat * Math.PI / 180));
  const r = m.toMGRS(lon, lat).ref;
  if (r !== ref) {
    // GeoTrans rounds to the metre first; allow a 1 m disagreement on the last digit
    const same = r.slice(0, 5) === ref.slice(0, 5) && Math.abs(+r.slice(5, 10) - +ref.slice(5, 10)) <= 1 && Math.abs(+r.slice(10) - +ref.slice(10)) <= 1;
    if (same) worstRef = 1; else fail(`${lon},${lat} MGRS ${r} vs ${ref}`);
  }
  // back from the reference to within the 1 m cell
  const p = m.parseMGRS(ref);
  if (!p || Math.abs(p.e - Math.floor(e)) > 1 || Math.abs(p.n - Math.floor(n)) > 1) fail(`${ref} parsed to ${p && [p.e, p.n]} vs ${e},${n}`);
  const got = m.tilesAt(lon, lat, grid.has).map((t) => t.name).join(" ");
  if (got !== tiles.join(" ")) fail(`${lon},${lat} tiles ${got} vs ${tiles.join(" ")}`);
}

// tile names round trip, and the tile count per zone adds up to the grid
let total = 0;
for (let z = 1; z <= 60; z++) {
  for (const t of grid.inZone(z)) {
    total++;
    const b = m.tileByName(t.name);
    if (!b || b.xmin !== t.xmin || b.ymax !== t.ymax) fail(`tile ${t.name} by name`);
  }
}
if (total !== grid.count) fail(`walked ${total} tiles, grid has ${grid.count}`);
const t = m.tileByName("T31UFU");
if (!t || t.xmin !== 600000 || t.ymax !== 5900040 || t.epsg !== 32631) fail(`31UFU ${JSON.stringify(t)}`);
if (m.gridZoneLon(32, "X") !== null || m.gridZoneLon(32, "V")[0] !== 3 || m.zoneOf(5, 60) !== 32 || m.zoneOf(10, 78) !== 33) fail("exceptions");

// UPS in the polar caps, against PROJ and GeoTrans
const ups = JSON.parse(fs.readFileSync(new URL("./fixtures/ups-points.json", import.meta.url)));
let worstUps = 0;
for (const [lon, lat, e, n, ref] of ups.points) {
  const u = m.toUPS(lon, lat);
  const d = Math.hypot(u.e - e, u.n - n);
  worstUps = Math.max(worstUps, d);
  if (d > 1e-3) fail(`${lon},${lat} UPS off by ${d} m`);
  const [lon2, lat2] = m.fromUPS(lat > 0, u.e, u.n);
  let dl = Math.abs(lon2 - lon); dl = Math.min(dl, 360 - dl);
  if (Math.abs(lat2 - lat) > 1e-9 || dl * Math.cos(lat * Math.PI / 180) > 1e-9) fail(`${lon},${lat} UPS inverse ${lon2},${lat2}`);
  const r = m.toMGRS(lon, lat).ref;
  // GeoTrans rounds to the metre first; allow a 1 m disagreement on the last digit
  const near = r.slice(0, 3) === ref.slice(0, 3) && Math.abs(+r.slice(3, 8) - +ref.slice(3, 8)) <= 1 && Math.abs(+r.slice(8) - +ref.slice(8)) <= 1;
  if (!near) fail(`${lon},${lat} polar MGRS ${r} vs ${ref}`);
  const p = m.parseMGRS(ref);
  if (!p || Math.abs(p.e - Math.floor(e)) > 1 || Math.abs(p.n - Math.floor(n)) > 1) fail(`${ref} parsed to ${p && [p.e, p.n]} vs ${e},${n}`);
}
console.log(`ups: ${ups.points.length} points vs ${ups.source}; worst ${worstUps.toExponential(2)} m`);

console.log(`mgrs: ${fx.points.length} points vs ${fx.source}; UTM worst ${worst.toExponential(2)} m, inverse ${worstInv.toExponential(2)} deg${worstRef ? ", MGRS within 1 m of GeoTrans" : ""}; ${total} tiles walked; ${fails} failing`);
process.exit(fails ? 1 : 0);
