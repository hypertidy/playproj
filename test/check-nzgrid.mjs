// NZTM2000 and the Topo50 sheet lattice (src/core/nzgrid.js): the
// projection against PROJ (test/fixtures/nzgrid-proj.json, from
// test/make-nzgrid-fixture.py), and the lattice against every sheet corner
// in LINZ's list (test/fixtures/topo50-linz.json) and the sheets in
// data/nz-topo50.json.
import fs from "fs";
import * as Z from "../src/core/nzgrid.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/nzgrid-proj.json", import.meta.url)));
const linz = JSON.parse(fs.readFileSync(new URL("./fixtures/topo50-linz.json", import.meta.url)));
const data = JSON.parse(fs.readFileSync(new URL("../data/nz-topo50.json", import.meta.url)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };

let dxy = 0, dk = 0, dc = 0, dinv = 0;
for (const p of fx.points) {
  const [lon, lat] = p.ll, [e, n] = Z.toGrid(lon, lat);
  dxy = Math.max(dxy, Math.hypot(e - p.e, n - p.n));
  const [l2, p2] = Z.fromGrid(e, n);
  dinv = Math.max(dinv, Math.hypot((l2 - lon) * 111e3, (p2 - lat) * 111e3));
  const s = Z.scaleAndConvergence(lon, lat);
  dk = Math.max(dk, Math.abs(s.k - p.k));
  dc = Math.max(dc, Math.abs(s.conv + p.conv));
}
check(dxy < 1e-3, `NZTM off PROJ by ${dxy} m`);
check(dinv < 1e-3, `inverse off by ${dinv} m`);
check(dk < 1e-7, `point scale off PROJ by ${dk}`);
check(dc < 1e-6, `convergence off PROJ by ${dc} degrees`);
const fo = Z.fromGrid(0, 0);
check(Math.abs(fo[0] - fx.falseOrigin[0]) < 1e-7 && Math.abs(fo[1] - fx.falseOrigin[1]) < 1e-7, `false origin ${fo} vs ${fx.falseOrigin}`);
console.log(`nzgrid: ${fx.points.length} points: NZTM ${dxy.toExponential(1)} m, k ${dk.toExponential(1)}, convergence ${dc.toExponential(1)} deg from PROJ`);

let bad = 0;
for (const [code, x, y] of linz.sheets) {
  const f = Z.sheetFrame(code), c = Z.sheetAt(x + 1, y - 1);
  if (!f || f.west !== x || f.north !== y || !c || c.code !== code) bad++;
}
check(bad === 0, `${bad} of ${linz.sheets.length} LINZ sheets off the lattice`);
check(data.sheets.length === linz.sheets.length, "data/nz-topo50.json has every sheet");
check(Z.rowName(Z.rowIndex("BQ")) === "BQ" && Z.rowIndex("BI") === -1, "row letters skip I");
const w = Z.describe(174.7762, -41.2865);
check(w.sheet.code === "BQ31" && data.names.BQ31 === "Wellington", `Wellington on ${w.sheet.code}`);
check(w.six.text === "BQ31 487 279", `Wellington ref ${w.six.text}`);
console.log(`nzgrid: ${linz.sheets.length} Topo50 sheets on the lattice`);

if (fails) { console.log(`check-nzgrid: ${fails} failure(s)`); process.exit(1); }
console.log("check-nzgrid: ok");
