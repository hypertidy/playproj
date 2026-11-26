// The Navigation page's ice-shelf cavity: which level of BedMachine a
// shelf's box is read at and which cells, each column of ice, water and
// rock, the surfaces' triangles and the open edges where they stop, the
// column between vertices, the bands down a section, where a line crosses
// the box, where a point is in its column, and where the view starts.
import assert from "node:assert/strict";
import { BEDMACHINE, SHELVES, shelfBox, shelfVx, readPlan, columnsOf, gridTriangles, openEdges, columnSampler, layerStrip, lineInBox, whereIn, shelfView } from "../src/core/cavity.js";

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

// levels: the finest no more than 768 cells across, and the window covers the box
const want = { amery: 1, ross: 2, "filchner-ronne": 2, larsen: 2, totten: 0, "pine-island": 0 };
for (const [k, s] of Object.entries(SHELVES)) {
  const box = shelfBox(s.ext), p = readPlan(box);
  assert.equal(p.level, want[k], `${k} level`);
  assert.ok(Math.max(p.w, p.h) <= 770, `${k} cells across ${p.w} x ${p.h}`);
  assert.ok(p.level === 0 || Math.max(box.x1 - box.x0, box.y1 - box.y0) / ((2 * BEDMACHINE.half) / BEDMACHINE.widths[p.level - 1]) > 768, `${k} could be finer`);
  // first and last cell centres within half a cell of the box's edges, or outside them
  assert.ok(p.x0 - p.d / 2 <= box.x0 && p.x0 + (p.w - 0.5) * p.d >= box.x1, `${k} columns cover the box`);
  assert.ok(p.y0 + p.d / 2 >= box.y1 && p.y0 - (p.h - 0.5) * p.d <= box.y0, `${k} rows cover the box`);
  // the plan's cell c0 is that cell of the level
  near(p.x0, -BEDMACHINE.half + (p.c0 + 0.5) * p.d, 1e-6, `${k} first column`);
}
// each shelf's own exaggeration
assert.deepEqual(Object.keys(SHELVES).map((k) => shelfVx(shelfBox(SHELVES[k].ext))), [50, 90, 90, 65, 25, 10]);
const a = readPlan(shelfBox(SHELVES.amery.ext));
near(a.d, 6666500 / 6666, 1e-9, "a 1 km cell is the extent over the width");
// clipped at the grid's edge
const edge = readPlan({ x0: 3.2e6, x1: 3.5e6, y0: -3.5e6, y1: -3.2e6 });
assert.equal(edge.c1, edge.W);
assert.equal(edge.r1, edge.W);

// columns: each kind, no data, and a base under the bed put on it
const L = {
  mask: Int8Array.from([0, 1, 2, 3, 3, 4, 2, 5]),
  bed: Float32Array.from([-800, 120, -300, -900, -500, -3500, -9999, 0]),
  surface: Float32Array.from([0, 120, 1500, 80, 60, 3500, 900, 0]),
  thickness: Float32Array.from([0, 0, 1800, 700, 600, 3700, 1000, 0])
};
const C = columnsOf(L);
assert.deepEqual(Array.from(C.kind), [0, 1, 2, 3, 3, 4, -1, -1]);
assert.deepEqual([C.top[0], C.base[0], C.bed[0]], [0, 0, -800], "open sea");
assert.deepEqual([C.top[1], C.base[1], C.bed[1]], [120, 120, 120], "ice-free land");
assert.deepEqual([C.top[2], C.base[2], C.bed[2]], [1500, -300, -300], "grounded ice sits on the bed");
assert.deepEqual([C.top[3], C.base[3], C.bed[3]], [80, -620, -900], "floating ice over its cavity");
assert.deepEqual([C.base[4], C.bed[4]], [-500, -500], "a base below the bed goes on the bed");
assert.deepEqual([C.top[5], C.base[5], C.bed[5]], [3500, -200, -3500], "Lake Vostok");

// triangles: all of a grid, counter-clockwise from above (y runs down the rows)
const w = 5, h = 4;
const all = gridTriangles(w, h, () => true);
assert.equal(all.length, (w - 1) * (h - 1) * 6);
const xy = (k) => [k % w, -Math.floor(k / w)];
for (let t = 0; t < all.length; t += 3) {
  const [p, q, r] = [all[t], all[t + 1], all[t + 2]].map(xy);
  assert.ok((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]) > 0, `triangle ${t / 3} faces down`);
}
assert.equal(gridTriangles(w, h, () => false).length, 0);

// open edges: none where everything is kept (the grid's own edges are not open)
assert.equal(openEdges(w, h, () => true).length, 0);
// a square of 2 x 2 cells inside a 6 x 6 grid: its 8 sides, each joining neighbours on the square's edge
const W6 = 6, inner = (k) => { const i = k % W6, j = Math.floor(k / W6); return i >= 1 && i <= 3 && j >= 1 && j <= 3; };
const sq = openEdges(W6, W6, (p, q, r) => inner(p) && inner(q) && inner(r));
assert.equal(sq.length, 16);
for (let e = 0; e < sq.length; e += 2) {
  const [p, q] = [sq[e], sq[e + 1]], [pi, pj, qi, qj] = [p % W6, Math.floor(p / W6), q % W6, Math.floor(q / W6)];
  assert.equal(Math.abs(pi - qi) + Math.abs(pj - qj), 1, "a side joins neighbours");
  assert.ok([pi, qi].every((i) => i === 1 || i === 3) && pi === qi || [pj, qj].every((j) => j === 1 || j === 3) && pj === qj, "on the square's edge");
}
// half a cell kept: the diagonal is open, and so are the two sides it has
const half = openEdges(3, 3, (p, q, r) => p === 0 && q === 3 && r === 1);
assert.deepEqual(Array.from(half), [1, 3], "only the diagonal: the cell's other sides are on the grid's edge, or not had");

// the column between vertices
const plan = { w: 2, h: 2, d: 100, x0: 1000, y0: 2000 };
const cols = { kind: Int8Array.from([3, 3, 0, 3]), top: Float32Array.from([50, 70, 0, 90]), base: Float32Array.from([-400, -500, 0, -600]), bed: Float32Array.from([-800, -900, -700, -1000]) };
const at = columnSampler(cols, plan);
assert.deepEqual(at(1000, 2000), { kind: 3, top: 50, base: -400, bed: -800 }, "at a vertex");
const mid = at(1050, 1950);
near(mid.top, (50 + 70 + 0 + 90) / 4, 1e-4, "bilinear top");
near(mid.bed, (-800 - 900 - 700 - 1000) / 4, 1e-4, "bilinear bed");
assert.equal(at(1010, 1910).kind, 0, "the kind of the nearest vertex");
assert.equal(at(990, 2000), null, "outside");
assert.deepEqual(at(999.5, 2000.5), at(1000, 2000), "a hair past the edge is on it");
assert.equal(columnSampler({ ...cols, kind: Int8Array.from([3, -1, 0, 3]) }, plan)(1050, 1950), null, "next to no data");

// bands down a section: ice, water and rock between two points; a band thin at both ends left out
const P = [{ x: 0, y: 0, top: 50, base: -400, bed: -800 }, { x: 10, y: 0, top: 0, base: 0, bed: -700 }, null, { x: 30, y: 0, top: 5, base: 5, bed: 5 }];
const S = layerStrip(P, 300);
assert.equal(S.ice.length, 18, "one quad of ice, tapering to the front");
assert.equal(S.water.length, 18);
assert.equal(S.rock.length, 18, "nothing across the gap");
const zs = (a) => a.filter((v, i) => i % 3 === 2);
assert.deepEqual([Math.max(...zs(S.ice)), Math.min(...zs(S.ice))], [50, -400]);
assert.deepEqual([Math.max(...zs(S.water)), Math.min(...zs(S.water))], [0, -800]);
assert.deepEqual([Math.max(...zs(S.rock)), Math.min(...zs(S.rock))], [-700, -1100], "rock a band 300 m deep under the bed");
const dry = layerStrip([{ x: 0, y: 0, top: 10, base: 10, bed: 10 }, { x: 1, y: 0, top: 10, base: 10, bed: 10 }], 60);
assert.deepEqual([dry.ice.length, dry.water.length, dry.rock.length], [0, 0, 18], "ice-free land: only rock");
// in any units: a thin shelf in scene units (a millionth of a metre a unit) keeps its bands
const tiny = layerStrip(P.slice(0, 2).map((q) => ({ x: q.x, y: q.y, top: q.top * 1e-6, base: q.base * 1e-6, bed: q.bed * 1e-6 })), 300e-6);
assert.deepEqual([tiny.ice.length, tiny.water.length, tiny.rock.length], [18, 18, 18], "thin bands kept");

// a line through a box
const B = { x0: 0, x1: 10, y0: 0, y1: 4 };
assert.deepEqual(lineInBox(B, 5, 2, 1, 0), [-5, 5]);
const diag = lineInBox(B, 5, 2, Math.SQRT1_2, Math.SQRT1_2);
near(diag[0], -2 * Math.SQRT2, 1e-12, "the diagonal leaves through the bottom");
near(diag[1], 2 * Math.SQRT2, 1e-12, "and the top");
assert.equal(lineInBox(B, 5, 6, 1, 0), null, "passing above");
assert.deepEqual(lineInBox(B, 3, 2, 0, -1), [-2, 2], "straight down the box");

// where a point is in its column
const shelf = { kind: 3, top: 60, base: -540, bed: -900 };
assert.deepEqual(whereIn(shelf, 100), { in: "above the ice", above: 40 });
assert.deepEqual(whereIn(shelf, -100), { in: "ice", below: 160, above: 440 });
assert.deepEqual(whereIn(shelf, -700), { in: "cavity", below: 160, above: 200 });
assert.deepEqual(whereIn(shelf, -1000), { in: "rock", below: 100 });
assert.equal(whereIn({ kind: 0, top: 0, base: 0, bed: -500 }, -200).in, "sea");
assert.equal(whereIn({ kind: 0, top: 0, base: 0, bed: -500 }, 20).in, "above the sea");
assert.equal(whereIn({ kind: 2, top: 900, base: -100, bed: -100 }, -50).in, "ice", "grounded ice down to the bed");
assert.equal(whereIn({ kind: 1, top: 300, base: 300, bed: 300 }, 200).in, "rock");
// on a surface, give or take a metre
assert.deepEqual(whereIn({ kind: 2, top: 900, base: -100, bed: -100 }, -100.4), { in: "bed", below: 1000 }, "on the bed under grounded ice");
assert.deepEqual(whereIn({ kind: 1, top: 300, base: 300, bed: 300 }, 300.5), { in: "bed", below: 0 }, "on the ground");
assert.equal(whereIn(shelf, -540.5).in, "cavity", "just under the ice's base");
assert.equal(whereIn(shelf, -900.5).in, "cavity", "just on the sea floor");
assert.equal(whereIn(shelf, 60.5).in, "ice", "just on top");

// where the view starts: shelf on the left, sea on the right
const vp = { w: 4, h: 1, d: 1000, x0: 0, y0: 0 };
const vc = { kind: Int8Array.from([2, 3, 3, 0]), top: Float32Array.from([900, 80, 60, 0]), base: Float32Array.from([-200, -600, -400, 0]), bed: Float32Array.from([-200, -1000, -800, -1200]) };
const v = shelfView(vc, vp);
assert.deepEqual(v.at, [1500, 0]);
assert.deepEqual(v.sea, [1, 0]);
near(v.mid, ((-600 - 1000) / 2 + (-400 - 800) / 2) / 2, 1e-9, "half way down the water, on average");
assert.deepEqual([v.area, v.thick, v.water, v.deep], [2e6, 680, 400, -1200]);
assert.equal(shelfView({ ...vc, kind: Int8Array.from([2, 2, 0, 0]) }, vp), null, "no floating ice");
// no open sea: away from the pole
const away = shelfView({ ...vc, kind: Int8Array.from([2, 3, 3, 2]) }, { ...vp, x0: 1e6 });
near(away.sea[0], 1, 1e-12, "away from the pole");

console.log("cavity: levels and windows, columns, triangles and open edges, the column sampler, section bands, lines in a box, where in the column, and the opening view all agree");
