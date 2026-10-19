// VicGrid and its neighbours (src/core/vicgrid.js) against PROJ
// (test/fixtures/vicgrid-proj.json, from test/make-vicgrid-fixture.py):
// eastings and northings of each grid through its datum, scale factors,
// inverses, and the AGD66, GDA94 and GDA2020 shifts.
import fs from "fs";
import * as V from "../src/core/vicgrid.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/vicgrid-proj.json", import.meta.url)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };

const worst = {};
let dshift = 0, round = 0;
for (const p of fx.points) {
  const [lon, lat] = p.ll;
  const s94 = V.shift(lon, lat, "GDA2020", "GDA94"), s66 = V.shift(lon, lat, "GDA2020", "AGD66");
  dshift = Math.max(dshift, V.nearDistance(s94[0], s94[1], ...p.gda94), V.nearDistance(s66[0], s66[1], ...p.agd66));
  const back = V.shift(s66[0], s66[1], "AGD66", "GDA2020");
  round = Math.max(round, V.nearDistance(back[0], back[1], lon, lat));
  for (const [id, [E, N, k]] of Object.entries(p.grids)) {
    const xy = V.toGrid(id, lon, lat);
    const c = V.CRS[id], ll = c.datum === "GDA2020" ? [lon, lat] : c.datum === "GDA94" ? p.gda94 : p.agd66;
    const own = c.forward(ll[0], ll[1]), inv = c.inverse(E, N);
    const w = worst[id] || (worst[id] = { d: 0, own: 0, inv: 0, k: 0 });
    w.d = Math.max(w.d, Math.hypot(xy[0] - E, xy[1] - N));
    w.own = Math.max(w.own, Math.hypot(own[0] - E, own[1] - N));
    w.inv = Math.max(w.inv, V.nearDistance(inv[0], inv[1], ll[0], ll[1]));
    w.k = Math.max(w.k, Math.abs(c.k(ll[0], ll[1]) - k));
  }
}
check(dshift < 1e-3, `datum shifts off PROJ by ${dshift} m`);
// each shift drops the height it makes (as PROJ's push/pop v_3 does), so a
// round trip comes back to within millimetres, not exactly
check(round < 5e-3, `AGD66 round trip off by ${round} m`);
console.log(`datum shifts: ${fx.points.length} points, ${dshift.toExponential(1)} m from PROJ, round trip ${round.toExponential(1)} m`);
for (const [id, w] of Object.entries(worst)) {
  // MGA: mgrs.js is on WGS84, a tenth of a millimetre from GRS80 here
  check(w.own < 1e-3, `${id}: projection off PROJ by ${w.own} m`);
  check(w.d < 2e-3, `${id}: through the datum off PROJ by ${w.d} m`);
  check(w.inv < 1e-3, `${id}: inverse off by ${w.inv} m`);
  check(w.k < 1e-8, `${id}: scale off PROJ by ${w.k}`);
  console.log(`${id.padEnd(10)} EPSG:${V.CRS[id].epsg}  projection ${w.own.toExponential(1)} m, with datum ${w.d.toExponential(1)} m, inverse ${w.inv.toExponential(1)} m, k ${w.k.toExponential(1)}`);
}

// VicGrid is true scale on its standard parallels, and the two Vicgrids
// differ by 2 000 km in northing plus the datum shift
check(Math.abs(V.CRS.vicgrid.k(145, -36) - 1) < 1e-12 && Math.abs(V.CRS.vicgrid.k(147, -38) - 1) < 1e-12, "VicGrid not true scale at 36 and 38 S");
const a = V.toGrid("vicgrid94", 144.9631, -37.8136), b = V.toGrid("vicgrid66", 144.9631, -37.8136);
check(Math.abs(a[1] - b[1] + 2e6) < 500 && Math.abs(a[0] - b[0]) < 500, `Vicgrid94 minus Vicgrid66 at Melbourne ${a[0] - b[0]}, ${a[1] - b[1]}`);
check(V.mgaZone(143.85) === 54 && V.mgaZone(144.28) === 55, "Ballarat and Bendigo in the wrong zones");

if (fails) { console.log(`${fails} vicgrid checks failed`); process.exit(1); }
console.log("vicgrid ok");
