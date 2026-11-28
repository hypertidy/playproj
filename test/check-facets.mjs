// src/core/facets.js: Australia's pieces and groups, the panels and their
// CRSs, the grid layout, footprints, and the numbers australia.html quotes,
// from data/australia-10m.json.
import fs from "fs";
import * as F from "../src/core/facets.js";
import * as I from "../src/core/inset.js";
import * as AG from "../src/core/aatgrid.js";

const d = JSON.parse(fs.readFileSync(new URL("../data/australia-10m.json", import.meta.url)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };
const ALL = Object.keys(F.PIECES), OWN = F.OWN;

for (const k of ALL) check(d.pieces[k] && d.pieces[k].length, `no land for ${k}`);
for (const G of Object.values(F.GROUPS)) for (const k of G.pieces) check(F.PIECES[k], `group piece ${k}`);
check(new Set(Object.values(F.GROUPS).flatMap((g) => g.pieces)).size === ALL.length, "every piece is in exactly one group");

// ground areas (km2): Natural Earth 1:10m, near the published figures
const km2 = (k) => I.groundArea(d.pieces[k]) / 1e6;
check(Math.abs(km2("mainland") + km2("tasmania") - 7.69e6) < 0.03e6, `Australia ${km2("mainland") + km2("tasmania")}`);
check(km2("aat") > 5.7e6 && km2("aat") < 6.1e6, `AAT ${km2("aat")}`);
check(km2("heard") > 300 && km2("heard") < 450, `Heard ${km2("heard")}`);
check(km2("macquarie") > 100 && km2("macquarie") < 140, `Macquarie ${km2("macquarie")}`);
// GSHHG full resolution for the islands: Macquarie in hundreds of points
const npts = (k) => d.pieces[k].reduce((a, r) => a + r.length / 2, 0);
check(npts("macquarie") > 400 && npts("heard") > 400, `island detail ${npts("macquarie")} ${npts("heard")}`);
check(km2("christmas") > 120 && km2("christmas") < 145 && km2("norfolk") > 30 && km2("norfolk") < 45, `Christmas ${km2("christmas")}, Norfolk ${km2("norfolk")}`);

// the station regions: views into the AAT, each holding its station, with
// a coastline to stroke, and left out of one frame's land
for (const [k, S] of Object.entries(F.STATIONS)) {
  check(F.PIECES[k].within === "aat" && !F.OWN.includes(k), `${k} is a view`);
  const [x0, y0, x1, y1] = d.regions[k];
  check(S.lon > x0 && S.lon < x1 && S.lat > y0 && S.lat < y1, `${k} station in its region`);
  check(d.coast[k] && d.coast[k].length && km2(k) > 1000, `${k} land and coast`);
  // the station stands on the region's land (GSHHG's ice front had Davis 10 km out to sea)
  let ins = false;
  for (const r of d.pieces[k]) for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    if ((r[i + 1] > S.lat) !== (r[j + 1] > S.lat) && S.lon < ((r[j] - r[i]) * (S.lat - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) ins = !ins;
  }
  check(ins, `${k} station on land`);
  check(AG.zoneOf(S.lon) === F.TILED[k] && F.PIECES[k].epsg === `EPSG:${AG.epsg(F.TILED[k])}`, `${k} zone`);
}
check(F.oneFrame(d, ["aat", "mawson"]).ground === F.oneFrame(d, ["aat"]).ground, "views add no land");
check(AG.zoneOf(I.centreOf(d.pieces.heard)[0]) === F.TILED.heard && F.TILED.heard === F.TILED.davis, "Heard and Davis share zone 43");

// the lattice over Davis: 60 m tiles 43.2 km a side, the station's tile in range
const lat = F.tileLattice(43, 60, d.regions.davis, 0);
const dt = AG.tileAt(F.STATIONS.davis.lon, F.STATIONS.davis.lat, 60, 43);
check(dt.col >= lat.cols[0] && dt.col <= lat.cols[1] && dt.row >= lat.rows[0] && dt.row <= lat.rows[1], `Davis tile ${dt.col} ${dt.row} in ${lat.cols} ${lat.rows}`);
check(lat.lines.length === lat.cols[1] - lat.cols[0] + lat.rows[1] - lat.rows[0] + 4, "lattice lines");
const [e, n] = AG.toZone(...lat.lines[0][0], 43);
check(Math.abs(e - (AG.ORIGIN[0] + lat.cols[0] * 43200)) < 0.01 && Math.abs(n - (AG.ORIGIN[1] + lat.rows[0] * 43200)) < 0.01, `lattice corner ${e} ${n}`);

// one frame: the step captions' numbers
const one = (on) => F.oneFrame(d, on);
const a = one(["mainland", "tasmania"]), m = one(["mainland", "tasmania", "macquarie"]);
const ext = one(OWN.filter((k) => k !== "heard" && k !== "aat")), hd = one(OWN.filter((k) => k !== "aat")), all = one(ALL);
check(Math.abs(a.fill - 0.51) < 0.02 && Math.abs(m.fill - 0.37) < 0.02, `fill ${a.fill}, ${m.fill}`);
check(Math.abs(ext.width - 7.2e6) < 0.1e6 && Math.abs(ext.fill - 0.21) < 0.02, `externals ${ext.width}, ${ext.fill}`);
check(hd.height - ext.height > 2e5 && hd.height - ext.height < 3.5e5, `Heard adds ${hd.height - ext.height}`);
check(Math.abs(all.width - 7.65e6) < 0.15e6 && Math.abs(all.height - 8.67e6) < 0.15e6 && Math.abs(all.fill - 0.21) < 0.02, `all ${all.width} ${all.height} ${all.fill}`);

// panels: grouped and split, with the official CRS where there is one
const grouped = F.panels(d, ALL, false), split = F.panels(d, ALL, true);
check(grouped.length === 9 && split.length === ALL.length, `panels ${grouped.length}, ${split.length}`);
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

console.log(`Davis is in ${dt.id || AG.tileId(43, 60, dt.col, dt.row)}; Macquarie ${npts("macquarie")} points, Heard ${npts("heard")}`);
console.log(`one frame: Australia ${(a.fill * 100).toFixed(0)}%, + Macquarie ${(m.fill * 100).toFixed(0)}%, + externals ${(ext.fill * 100).toFixed(0)}% (${(ext.width / 1e3).toFixed(0)} km wide), + Heard ${(hd.fill * 100).toFixed(0)}%, + AAT ${(all.fill * 100).toFixed(0)}% (${(all.width / 1e3).toFixed(0)} x ${(all.height / 1e3).toFixed(0)} km)`);
if (fails) { console.log(`${fails} facets checks failed`); process.exit(1); }
console.log("facets ok");
