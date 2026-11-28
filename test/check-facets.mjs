// src/core/facets.js: Australia's pieces and groups, the panels and their
// CRSs, the grid layout, footprints, and the numbers australia.html quotes,
// from data/australia-10m.json.
import fs from "fs";
import * as F from "../src/core/facets.js";
import * as I from "../src/core/inset.js";

const d = JSON.parse(fs.readFileSync(new URL("../data/australia-10m.json", import.meta.url)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };
const ALL = Object.keys(F.PIECES);

for (const k of ALL) check(d.pieces[k] && d.pieces[k].length, `no land for ${k}`);
for (const G of Object.values(F.GROUPS)) for (const k of G.pieces) check(F.PIECES[k], `group piece ${k}`);
check(new Set(Object.values(F.GROUPS).flatMap((g) => g.pieces)).size === ALL.length, "every piece is in exactly one group");

// ground areas (km2): Natural Earth 1:10m, near the published figures
const km2 = (k) => I.groundArea(d.pieces[k]) / 1e6;
check(Math.abs(km2("mainland") + km2("tasmania") - 7.69e6) < 0.03e6, `Australia ${km2("mainland") + km2("tasmania")}`);
check(km2("aat") > 5.7e6 && km2("aat") < 6.1e6, `AAT ${km2("aat")}`);
check(km2("heard") > 300 && km2("heard") < 450, `Heard ${km2("heard")}`);
check(km2("macquarie") > 100 && km2("macquarie") < 140, `Macquarie ${km2("macquarie")}`);

// one frame: the step captions' numbers
const one = (on) => F.oneFrame(d, on);
const a = one(["mainland", "tasmania"]), m = one(["mainland", "tasmania", "macquarie"]);
const ext = one(ALL.filter((k) => k !== "heard" && k !== "aat")), hd = one(ALL.filter((k) => k !== "aat")), all = one(ALL);
check(Math.abs(a.fill - 0.51) < 0.02 && Math.abs(m.fill - 0.37) < 0.02, `fill ${a.fill}, ${m.fill}`);
check(Math.abs(ext.width - 7.2e6) < 0.1e6 && Math.abs(ext.fill - 0.21) < 0.02, `externals ${ext.width}, ${ext.fill}`);
check(hd.height - ext.height > 2e5 && hd.height - ext.height < 3.5e5, `Heard adds ${hd.height - ext.height}`);
check(Math.abs(all.width - 7.65e6) < 0.15e6 && Math.abs(all.height - 8.67e6) < 0.15e6 && Math.abs(all.fill - 0.21) < 0.02, `all ${all.width} ${all.height} ${all.fill}`);

// panels: grouped and split, with the official CRS where there is one
const grouped = F.panels(d, ALL, false), split = F.panels(d, ALL, true);
check(grouped.length === 6 && split.length === ALL.length, `panels ${grouped.length}, ${split.length}`);
check(split.find((p) => p.key === "norfolk").epsg === "EPSG:7858" && split.find((p) => p.key === "aat").epsg === "EPSG:3031", "panel CRSs");
for (const p of split) {
  const [lon, lat] = I.centreOf(d.pieces[p.key]), [x, y] = p.crs.forward(lon, lat), [l2, p2] = p.crs.inverse(x, y);
  check(Math.hypot(I.wrap(l2 - lon), p2 - lat) < 1e-7, `${p.key} CRS round trip`);
}
// polar stereographic for the AAT against PROJ (pyproj, EPSG:3031): 100 E 70 S
const st = I.crs({ proj: "stere" }), [sx, sy] = st.forward(100, -70);
check(Math.hypot(sx - 2161154.948986, sy - (-381069.926998)) < 0.001, `EPSG:3031 ${sx} ${sy}`);

// layout: every cell inside the canvas, none overlapping
for (const [n, w, h] of [[1, 1000, 800], [6, 1000, 800], [11, 1000, 800], [11, 390, 700]]) {
  const L = F.layout(n, w, h);
  check(L.cells.length === n, `layout ${n} cells`);
  for (const c of [L.overview, ...L.cells]) check(c[0] >= 0 && c[1] >= 0 && c[0] + c[2] <= w + 1e-6 && c[1] + c[3] <= h + 1e-6 && c[2] > 0 && c[3] > 0, `cell outside ${c}`);
  for (let i = 0; i < L.cells.length; i++) for (let j = i + 1; j < L.cells.length; j++) {
    const A = L.cells[i], B = L.cells[j];
    check(A[0] + A[2] <= B[0] + 1e-6 || B[0] + B[2] <= A[0] + 1e-6 || A[1] + A[3] <= B[1] + 1e-6 || B[1] + B[3] <= A[1] + 1e-6, `cells ${i} and ${j} overlap`);
  }
}
// a footprint goes round the panel's land
const p = split.find((q) => q.key === "christmas"), g = F.panelGeometry(d, p);
const fp = F.footprint(p, [g.box[0] - 5000, g.box[1] - 5000, g.box[2] + 5000, g.box[3] + 5000]);
const lons = fp.map((q) => q[0]), lats = fp.map((q) => q[1]);
check(Math.min(...lons) < 105.55 && Math.max(...lons) > 105.75 && Math.min(...lats) < -10.6 && Math.max(...lats) > -10.4, "Christmas footprint");

console.log(`one frame: Australia ${(a.fill * 100).toFixed(0)}%, + Macquarie ${(m.fill * 100).toFixed(0)}%, + externals ${(ext.fill * 100).toFixed(0)}% (${(ext.width / 1e3).toFixed(0)} km wide), + Heard ${(hd.fill * 100).toFixed(0)}%, + AAT ${(all.fill * 100).toFixed(0)}% (${(all.width / 1e3).toFixed(0)} x ${(all.height / 1e3).toFixed(0)} km)`);
if (fails) { console.log(`${fails} facets checks failed`); process.exit(1); }
console.log("facets ok");
