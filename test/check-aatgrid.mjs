// The mini aatgrid lattice against the aatgrid R package's own tests
// (github.com/mdsumner/aatgrid, tests/testthat/test-grid.R): Heard and
// McDonald anchors in their 60 m tiles, the Atlas Cove row seam, id
// formatting and parsing, nesting, and the Sentinel-2 pixel shift stated in
// R/mgrs.R. UTM is src/core/mgrs.js, checked against PROJ in check-mgrs.mjs.
import * as a from "../src/core/aatgrid.js";
import { tileOfSquare } from "../src/core/mgrs.js";

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };

// name, lon, lat, col, row at 60 m in zone 43S
const heard = [
  ["atlas_cove", 73.3868, -53.0243, 5, 94],
  ["big_ben", 73.5167, -53.1, 6, 94],
  ["spit_bay", 73.7189, -53.1141, 6, 94],
  ["mcdonald", 72.5773, -53.038, 4, 94],
  ["coast_bbox_ne_islet", 73.58, -52.91414, 6, 95]
];
for (const [name, lon, lat, col, row] of heard) {
  const t = a.tileAt(lon, lat, 60);
  check(t.zone === 43 && t.col === col && t.row === row, `${name}: ${t.id}, want 43S col ${col} row ${row}`);
}

// Atlas Cove is about 191 m south of the row seam at northing 4124000
{
  const ts = a.tileSize(60), [e, n] = a.toZone(73.3868, -53.0243, 43);
  const seam = a.ORIGIN[1] + Math.ceil((n - a.ORIGIN[1]) / ts) * ts;
  check(seam === 4124000, `row seam ${seam}`);
  check(Math.abs(seam - n) < 500, `seam distance ${seam - n}`);
  const cseam = a.ORIGIN[0] + Math.ceil((e - a.ORIGIN[0]) / ts) * ts;
  check(Math.abs(cseam - e) > 5000, `column seam distance ${cseam - e}`);
}

// ids
check(a.tileId(43, 60, 6, 113) === "43S_R0060_0006_0113", "tile id");
check(a.tileId(1, 60, 5, 113) === "01S_R0060_0005_0113", "zone padding");
for (const [id, want] of [["43S_R0060_0006_0113", [43, 60, 6, 113]], ["55S_L2_0001_0002", [55, 10, 1, 2]], ["1S_L1_0000_0000", [1, 60, 0, 0]]]) {
  const p = a.parseTileId(id);
  check(p && [p.zone, p.res, p.col, p.row].join() === want.join(), `parse ${id}`);
}
for (const bad of ["43S_X1_0001_0002", "43S_R0060_0001", "43N_R0060_0001_0002", "61S_R0060_0001_0002"])
  check(a.parseTileId(bad) === null, `rejects ${bad}`);

// nesting: 6 x 6 tens in a sixty, 3 x 3 twenties, each child inside its parent
{
  const t = a.tile(43, 60, 6, 113);
  for (const [res, f] of [[10, 6], [20, 3]]) {
    const ch = a.childrenOf(t, res);
    check(ch.length === f * f, `${f * f} children at ${res} m`);
    check(ch.every((c) => c.xmin >= t.xmin && c.xmax <= t.xmax && c.ymin >= t.ymin && c.ymax <= t.ymax), `children inside at ${res} m`);
    check(ch.every((c) => a.parentOf(c, 60).id === t.id), `parents at ${res} m`);
  }
  check(a.childrenOf(a.tile(43, 20, 1, 1), 60).length === 0 && a.parentOf(a.tile(43, 20, 1, 1), 60).id === "43S_R0060_0000_0000", "20 m in 60 m");
  check(a.nesting(60, 20) === 3 && a.nesting(20, 60) === 0 && a.nesting(60, 25) === 0, "nesting factors");
  check(a.tileSize(10) === 7200 && a.tileSize(60) === 43200, "tile sizes");
  check(t.gt.join() === [t.xmin, 60, 0, t.ymax, 0, -60].join(), "geotransform");
}

// Sentinel-2: 10 m and 20 m pixels coincide, 60 m ones are 20 m off in each
// direction (aatgrid R/mgrs.R); checked against real tile corners too
{
  check(a.s2Shift(10).join() === "0,0" && a.s2Shift(20).join() === "0,0", "10 and 20 m aligned");
  const [dx, dy] = a.s2Shift(60);
  check(Math.abs(dx) === 20 && Math.abs(dy) === 20, `60 m shift ${dx},${dy}`);
  let worst = 0;
  for (let col = 1; col <= 8; col++)
    for (let row = 0; row < 100; row += 7) {
      const s = tileOfSquare(43, true, col, row);
      if (!s) continue;
      for (const res of [10, 20, 60]) {
        const [sx, sy] = a.s2Shift(res);
        const ex = (((s.xmin - a.ORIGIN[0] + sx) % res) + res) % res, ey = (((s.ymax - a.ORIGIN[1] + sy) % res) + res) % res;
        worst = Math.max(worst, ex, ey);
      }
    }
  check(worst === 0, `Sentinel-2 corners off the shifted lattice by ${worst} m`);
}

// lattice lines: inside the zone only by default, and on lattice coordinates
{
  const L = a.latticeSegments(43, 60, { lat0: -56, lat1: -50 });
  check(L.inside.length > 0 && L.outside.length === 0, "lattice without past");
  let off = 0;
  for (let i = 0; i < L.inside.length; i += 2) {
    const [e, n] = a.toZone(L.inside[i], L.inside[i + 1], 43);
    const ts = a.tileSize(60);
    const de = Math.abs(((e - a.ORIGIN[0]) / ts) - Math.round((e - a.ORIGIN[0]) / ts)) * ts;
    const dn = Math.abs(((n - a.ORIGIN[1]) / ts) - Math.round((n - a.ORIGIN[1]) / ts)) * ts;
    off = Math.max(off, Math.min(de, dn));
  }
  check(off < 1e-3, `lattice vertex off a line by ${off} m`);
  const P = a.latticeSegments(43, 60, { lat0: -56, lat1: -50, past: 1 });
  check(P.outside.length > 0, "lattice past the edge");
}

// zones: the AAT claim (45 E to 160 E) and Mawson
check(a.zoneOf(45) === 38 && a.zoneOf(160) === 57 && a.zoneOf(62.87) === 41 && a.zoneOf(180) === 60 && a.zoneOf(-180) === 1, "zones");

console.log(fails ? `aatgrid: ${fails} failures` : "aatgrid: all checks pass");
process.exit(fails ? 1 : 0);
