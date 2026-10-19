// The ellipsoid (src/core/ellipsoid.js) against PROJ (in
// test/fixtures/ellipsoid-proj.json): a, b and f of each ellps, Earth-centred
// x, y, z, the geocentric and parametric latitudes those imply, the
// inverse back to geodetic latitude, and the meridian length from the
// equator; on WGS84 and on WGS84 with its flattening times 100.
import fs from "fs";
import * as E from "../src/core/ellipsoid.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/ellipsoid-proj.json", import.meta.url)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };
const R2D = 180 / Math.PI;

const wgs = E.fromRecord(E.ELLIPSOIDS[0]);
for (const ref of fx.ellipsoids) {
  const rec = E.ELLIPSOIDS.find((r) => r.id === ref.name);
  const ell = rec ? E.fromRecord(rec) : E.exaggerate(wgs, 100);
  check(Math.abs(ell.a - ref.a) < 1e-6 && Math.abs(ell.b - ref.b) < 1e-6, `${ref.name}: a, b ${ell.a}, ${ell.b} not ${ref.a}, ${ref.b}`);
  let dx = 0, dlat = 0, darc = 0;
  for (const p of ref.points) {
    const xyz = E.toXYZ(ell, fx.lon, p.lat);
    dx = Math.max(dx, Math.hypot(xyz[0] - p.xyz[0], xyz[1] - p.xyz[1], xyz[2] - p.xyz[2]));
    const [x, y, z] = p.xyz, q = Math.hypot(x, y);
    if (Math.abs(p.lat) < 90) {
      const gc = Math.atan2(z, q) * R2D, pm = Math.atan2(z / ell.b, q / ell.a) * R2D;
      check(Math.abs(E.geocentricLatitude(ell, p.lat) - gc) < 1e-9, `${ref.name} ${p.lat}: geocentric latitude`);
      check(Math.abs(E.parametricLatitude(ell, p.lat) - pm) < 1e-9, `${ref.name} ${p.lat}: parametric latitude`);
      check(Math.abs(E.geodeticFromGeocentric(ell, gc) - p.lat) < 1e-9, `${ref.name} ${p.lat}: geodetic from geocentric`);
    }
    dlat = Math.max(dlat, Math.abs(E.fromXYZ(ell, x, y, z)[1] - p.lat));
    darc = Math.max(darc, Math.abs(E.meridianArc(ell, p.lat) - p.arc));
  }
  check(dx < 1e-6, `${ref.name}: x, y, z off by ${dx} m`);
  check(dlat < 1e-10, `${ref.name}: inverse latitude off by ${dlat} degrees`);
  check(darc < 1e-3, `${ref.name}: meridian length off by ${darc} m`);
  const mx = E.maxLatitudeDifference(ell);
  console.log(`${ref.name.padEnd(10)} 1/f ${ell.rf.toFixed(4).padStart(9)}  xyz ${dx.toExponential(1)} m  lat ${dlat.toExponential(1)} deg  arc ${darc.toExponential(1)} m  max(geodetic - geocentric) ${(mx.diff * 60).toFixed(2)}' at ${mx.lat.toFixed(3)}`);
}

// the largest difference is where d/dlat of the geocentric latitude is 1
for (const k of [1, 30, 200]) {
  const ell = E.exaggerate(wgs, k), mx = E.maxLatitudeDifference(ell);
  const h = 1e-4, d = (lat) => lat - E.geocentricLatitude(ell, lat);
  check(d(mx.lat) >= d(mx.lat - h) && d(mx.lat) >= d(mx.lat + h), `x${k}: maxLatitudeDifference is not a maximum`);
}
check(E.exaggerate(wgs, 1e6).f === E.F_MAX, "exaggeration is capped at F_MAX");

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log("ellipsoid ok");
