// S2 cells: tokens, faces and cell corners against s2sphere (a Python port
// of s2geometry), in test/fixtures/s2-cells.json.
import fs from "fs";
import * as s2 from "../src/core/s2.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/s2-cells.json", import.meta.url)));
let fails = 0, worst = 0;
for (const c of fx.cells) {
  const id = s2.cellFromLonLat(c.lon, c.lat, c.level);
  const tok = s2.toToken(id);
  const back = s2.fromToken(c.token);
  const b = s2.cellBounds(back);
  let d = 0;
  b.corners.forEach(([lon, lat], k) => {
    let dl = Math.abs(lon - c.corners[k][0]); dl = Math.min(dl, 360 - dl);
    if (Math.abs(lat) > 89.999999) dl = 0;
    d = Math.max(d, dl * Math.cos(lat * Math.PI / 180), Math.abs(lat - c.corners[k][1]));
  });
  worst = Math.max(worst, d);
  const ok = tok === c.token && b.face === c.face && b.level === c.level && back === id && d < 1e-7;
  if (!ok) { fails++; console.log(`FAIL ${c.lon},${c.lat} L${c.level}: ${tok} vs ${c.token}, corners ${d}`); }
}
// the Hilbert walk visits each face's cells in id order
for (let face = 0; face < 6; face++) {
  const cells = s2.hilbertCells(face, 3), n = 8;
  let prev = -1n;
  for (const [i, j] of cells) {
    const id = s2.cellFromFaceST(face, (i + 0.5) / n, (j + 0.5) / n, 3);
    if (id <= prev) { fails++; console.log(`FAIL Hilbert order face ${face} at ${i},${j}`); break; }
    prev = id;
  }
}
console.log(`s2 cells: ${fx.cells.length} cells vs ${fx.source}, corners worst ${worst.toExponential(2)} deg; ${fails} failing`);
process.exit(fails ? 1 : 0);
