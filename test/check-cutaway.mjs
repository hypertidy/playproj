// The cutaway's geometry and layering (src/core/cutaway.js). The layer
// checks use Bedmap3 values read along a line across the Amery Ice Shelf at
// its 2 km level (surface, thickness, bed, mask; -9999 is nodata).
import * as C from "../src/core/cutaway.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log("FAIL " + msg); } };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const nd = (v) => (v === -9999 ? NaN : v);

// the line's frame, the block and the samples
{
  const f = C.lineFrame([0, 0], [3000, 4000]);
  ok(f.L === 5000, "length"); near(f.ux, 0.6, 1e-12, "ux");
  near(f.nx, -0.8, 1e-12, "normal x (left)"); near(f.ny, 0.6, 1e-12, "normal y");
  const p = C.at(f, 5000, 100);
  near(p[0], 3000 - 80, 1e-9, "at x"); near(p[1], 4000 + 60, 1e-9, "at y");
  const k = C.blockOf(f, 1000, -1);
  near(k.corners[2][0], 3800, 1e-9, "right side corner x"); near(k.corners[2][1], 3400, 1e-9, "right side corner y");
  ok(k.box.join() === "0,-600,3800,4000", `block box ${k.box}`);
  const s = C.samplesAlong(f, 10);
  ok(s.length === 11 && s[10].s === 5000 && s[5].p[0] === 1500, "samples along");
}

// Bedmap3's pyramid: 13334 at 500 m, then halves
{
  const L = C.levelsOf(-3333500, 3333500, 500, [[13334, 13334], [6667, 6667], [3333, 3333], [1666, 1666], [833, 833], [416, 416]]);
  near(L[1].res, 1000, 1e-9, "level 1 res"); near(L[4].res, 500 * 13334 / 833, 1e-9, "level 4 res");
  const box = [1600000, 600000, 2400000, 800000];
  const p = C.plan(L, box, 1200, 1600);
  ok(p.k === 1 && p.win[2] - p.win[0] <= 800 + 8, `800 km at 1200 m reads the 1 km level (${p.k}, ${p.win})`);
  const q = C.plan(L, [0, 0, 1600000, 10000], 100, 1600);
  ok(q.k === 1, `no more than 1600 px across (${q.k})`);
  const g = C.windowGrid(p.level, p.win, new Int16Array((p.win[2] - p.win[0]) * (p.win[3] - p.win[1])).fill(7), -9999);
  near(C.sample(g, 2000000, 700000), 7, 1e-9, "sample inside the window");
  ok(Number.isNaN(C.sample(g, 0, 0)), "sample outside is NaN");
}

// layers across the Amery: open sea, floating shelf, grounded ice
{
  const sea = C.layer(nd(-9999), nd(-9999), -588, nd(-9999));
  ok(sea.kind === "sea" && sea.top === 0 && sea.water[0] === 0 && sea.water[1] === -588, `open sea ${JSON.stringify(sea)}`);
  const shelf = C.layer(78, 636, -886, 3);
  ok(shelf.kind === "floating" && shelf.base === 78 - 636 && shelf.water[0] === -558 && shelf.water[1] === -886, `shelf ${JSON.stringify(shelf)}`);
  const edge = C.layer(42, 260, -459, nd(-9999));
  ok(edge.kind === "floating", "ice with no mask over a deeper bed floats");
  const ground = C.layer(1437, 197, 1240, 1);
  ok(ground.kind === "grounded" && ground.base === 1240 && ground.water === null, `grounded ${JSON.stringify(ground)}`);
  const rock = C.layer(900, 0, 900, 4);
  ok(rock.kind === "rock" && rock.ice === 0 && rock.base === 900, "rock");
  ok(C.layer(NaN, NaN, NaN, NaN).kind === "none", "nothing");
  // the stack of bands, bottom up
  const st = C.stack(shelf, -1200);
  ok(st.rock.join() === "-1200,-886" && st.water.join() === "-886,-558" && st.ice.join() === "-558,78", `shelf stack ${JSON.stringify(st)}`);
  const sg = C.stack(ground, -1200);
  ok(sg.water[0] === sg.water[1] && sg.ice.join() === "1240,1437", `grounded stack ${JSON.stringify(sg)}`);
  const ss = C.stack(sea, -1200);
  ok(ss.water.join() === "-588,0" && ss.ice[0] === 0 && ss.ice[1] === 0, `sea stack ${JSON.stringify(ss)}`);
  ok(C.stack(rock, -1200).rock[1] === 900 && C.stack(C.layer(NaN, NaN, NaN, NaN), 0) === null, "rock stack, and none");
  const w = { data: Int16Array.of(1, 3, -9999, 4), width: 2, height: 2, x0: 0, y0: 2, dx: 1, dy: 1, nodata: -9999 };
  ok(C.nearest(w, 1.2, 1.9) === 3 && Number.isNaN(C.nearest(w, 0.5, 0.5)) && C.nearest(w, 1.5, 0.5) === 4 && Number.isNaN(C.nearest(w, 5, 5)), "nearest cell");
  ok(C.floorOf([sea, shelf, ground]) === -1200, `floor ${C.floorOf([sea, shelf, ground])}`);
  // a run sea, shelf, shelf, grounded: one grounding line
  const rows = [sea, shelf, shelf, ground].map((l, i) => ({ s: i * 1000, l }));
  const S = C.summary(rows);
  ok(S.grounding.length === 1 && S.grounding[0] === 2500 && S.floating === 2000 && S.grounded === 1000, `summary ${JSON.stringify(S)}`);
  near(S.maxCavity, 328, 1e-9, "thickest cavity");
}

{
  const one = C.lonBoxes([10, 20], [-70, -75]);
  ok(one.length === 1 && one[0].join() === "10,-75,20,-70", `one box ${JSON.stringify(one)}`);
  const two = C.lonBoxes([178, -170, -150], [-77.6, -80, -83.6]);
  ok(two.length === 2 && two[0].join() === "178,-83.6,180,-77.6" && two[1].join() === "-180,-83.6,-150,-77.6", `across the antimeridian ${JSON.stringify(two)}`);
}

ok(C.autoExaggeration(700000, 3000) === 25, `auto exaggeration ${C.autoExaggeration(700000, 3000)}`);
ok(C.PRESETS.every((p) => p.a[1] < -60 && p.b[1] < -60), "presets in the south");

console.log(fails ? `${fails} failed` : "cutaway: all checks pass");
process.exit(fails ? 1 : 0);
