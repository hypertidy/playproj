// SeaWiFS / MODIS level-3 bins: grid sizes from the published products, and
// bin numbers round-trip through their bounds.
import { grid, binOf, binBounds, binArea, EARTH_AREA } from "../src/core/l3bin.js";

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };

// total bins of the standard grids (SeaWiFS 9 km, MODIS 4 km, 24 rows from the memo's toy grid)
const known = { 2160: 5940422, 4320: 23761676 };
for (const [n, tot] of Object.entries(known)) check(grid(+n).totbins === tot, `${n} rows: ${grid(+n).totbins} bins, expected ${tot}`);
check(grid(2160).numbin[1080] === 4320 && grid(2160).numbin[0] === 3, "2160 rows: 4320 bins at the equator, 3 at the pole");

for (const n of [24, 2160, 4320]) {
  const g = grid(n);
  let worst = 0, area = 0;
  for (let lat = -89.95; lat < 90; lat += 1.37)
    for (let lon = -179.95; lon < 180; lon += 2.11) {
      const bin = binOf(g, lon, lat), b = binBounds(g, bin);
      const inside = lon >= b.west - 1e-9 && lon <= b.east + 1e-9 && lat >= b.south - 1e-9 && lat <= b.north + 1e-9;
      if (!inside) { check(false, `${n} rows: ${lon},${lat} not in bin ${bin}`); break; }
      worst = Math.max(worst, Math.abs(binOf(g, ...b.centre) - bin));
    }
  check(worst === 0, `${n} rows: bin centre round trip off by ${worst}`);
  for (let r = 0; r < n; r++) { const b = binBounds(g, g.basebin[r]); area += binArea(b) * b.numbin; }
  check(Math.abs(area - EARTH_AREA) < 1e-3 * EARTH_AREA, `${n} rows: areas sum to ${area}`);
  check(binOf(g, -180, -90) === 1 && binOf(g, 179.9999, 89.9999) === g.totbins, `${n} rows: first and last bins`);
}
console.log(`l3 bins: 2160 rows ${grid(2160).totbins} bins, 4320 rows ${grid(4320).totbins}; ${fails} failing`);
process.exit(fails ? 1 : 0);
