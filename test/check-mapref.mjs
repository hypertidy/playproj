// Tasmanian street atlas and map book references (src/core/mapref.js) on
// data/tas-mapref.json: the documented examples, the map book lattice, the
// street atlas squares on the 500 m lattice inside their frames, insets,
// and a point's place on its pages.
import fs from "fs";
import * as R from "../src/core/mapref.js";
import * as M from "../src/core/mgrs.js";
import * as V from "../src/core/vicgrid.js";

const m = R.read(JSON.parse(fs.readFileSync(new URL("../data/tas-mapref.json", import.meta.url))));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };

const sa = m.pages.filter((p) => p.book === "SA"), mb = m.pages.filter((p) => p.book === "MB");
check(sa.length === 275 && mb.length === 406 && m.sa.length === 9225, `counts ${sa.length} ${mb.length} ${m.sa.length}`);

// the README example: E 522750 N 5249800
const L = R.locate(m, 522750, 5249800);
const s188 = L.find((r) => r.page.ref === "SA188"), m356 = L.find((r) => r.page.ref === "MB356");
check(s188 && s188.label === "SA-188-D4" && s188.dx === 1825 && s188.dy === 1775 && Math.abs(s188.u - 0.579) < 1e-3 && Math.abs(s188.v - 0.486) < 1e-3, `SA188 ${JSON.stringify(s188 && [s188.label, s188.dx, s188.dy])}`);
check(m356 && m356.label === "MB356 F1" && m356.dx === 2750 && m356.dy === 200, `MB356 ${JSON.stringify(m356 && [m356.label, m356.dx, m356.dy])}`);

// Fern Tree, GDA2020 to GDA94, then MGA 55
const [lon94, lat94] = V.shift(147.2625, -42.9216, "GDA2020", "GDA94");
const u = M.toUTM(lon94, lat94, 55, true);
const F = R.locate(m, u.e, u.n);
check(F.map((r) => r.label).join(",") === "SA-192-A1,MB356 C5", `Fern Tree ${F.map((r) => r.label)}`);

// the map book: 12 x 18 km pages on the lattice (all but MB001), 24 x 36 squares
let off = 0;
for (const p of mb) {
  check(p.xmax - p.xmin === 12000 && p.ymax - p.ymin === 18000, `${p.ref} size`);
  if ((p.xmin - 4000) % 12000 || (p.ymin - 12000) % 18000) off++;
}
check(off === 1, `${off} map book pages off the lattice`);
check(R.squares(m, "MB356").length === 864, "MB356 squares");
check(R.label("MB", 7, "C", 4) === "MB007 C4" && R.normPage("sa-188") === "SA188" && R.normPage("x") === null, "labels");

// street atlas squares: on the 500 m lattice (bar two 325 m slivers), each inside a frame of its page
let offLattice = 0, homeless = 0;
for (const s of m.sa) {
  if (s.xmin % 500 || s.ymax % 500) offLattice++;
  const home = m.pages.some((p) => p.book === "SA" && p.page === s.page && s.xmin >= p.xmin && s.xmax <= p.xmax && s.ymin >= p.ymin && s.ymax <= p.ymax);
  if (!home) homeless++;
}
check(offLattice <= 2, `${offLattice} squares off the 500 m lattice`);
check(homeless === 0, `${homeless} squares outside every frame of their page`);

// a standard page: 6 x 7 squares, 75 m margin, frame 3150 x 3650
const f = R.frame(m, "SA188");
check(f.squares.length === 42 && f.cols.length === 6 && f.rows.length === 7, `SA188 frame ${f.squares.length}`);
check(f.margin.top === 75 && f.margin.left === 75 && f.page.xmax - f.page.xmin === 3150, `SA188 margin ${JSON.stringify(f.margin)}`);
check(f.cols.map((c) => c.label).join("") === "ABCDEF" && f.rows.map((r) => r.label).join("") === "1234567", "SA188 labels");

// an inset carries its parent's squares
const t = R.squares(m, "SA145T").map((s) => s.ref).sort().join(",");
check(t === "SA145F1,SA145F2", `SA145T ${t}`);
check(R.neighbours(m, "SA192").length > 0, "SA192 has neighbours");

if (fails) { console.log(`${fails} failures`); process.exit(1); }
console.log(`mapref: ${sa.length} street atlas and ${mb.length} map book pages, ${m.sa.length} squares; ok`);
