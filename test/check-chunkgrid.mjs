// Chunk grids: regular axes and their edge chunk, run-length sizes, chunk
// lookup against a brute-force scan, the zarr.json chunk_grid round trip,
// calendar axes and the mosaic edge grid.
import * as g from "../src/core/chunkgrid.js";

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// regular axes: whole chunks, the last overhanging, or trimmed to what is left
check(same(g.regularAxis(100, 30), [30, 30, 30, 30]), "100 by 30");
check(same(g.regularAxis(100, 30, { trim: true }), [30, 30, 30, 10]), "100 by 30, trimmed");
check(same(g.regularAxis(90, 30), [30, 30, 30]), "90 by 30");
check(same(g.regularAxis(5, 30), [30]) && same(g.regularAxis(5, 30, { trim: true }), [5]), "one short chunk");
check(g.regularSize([30, 30, 30, 30], 100) === 30 && g.regularSize([30, 30, 30, 10], 100) === null && g.regularSize([30, 31, 30]) === null, "regular sizes");
check(g.regularSize([30, 30, 30, 30, 30], 100) === null, "an overflow chunk is not regular");
{
  const off = g.offsets(g.regularAxis(100, 30));
  check(g.filled(off, 3, 100) === 10 && g.filled(off, 0, 100) === 30, "filled");
}

// runs
check(same(g.expandRuns([[31, 1], 28, [30, 2]]), [31, 28, 30, 30]), "expand runs");
check(same(g.compressRuns([31, 28, 31, 30, 30, 30, 1]), [31, 28, 31, [30, 3], 1]), "compress runs");
for (const bad of [[0], [[3, 0]], [1.5], "1,2"]) {
  let threw = false;
  try { g.expandRuns(bad); } catch (e) { threw = true; }
  check(threw, `rejects ${JSON.stringify(bad)}`);
}

// lookup against a scan, on a calendar axis
{
  const { sizes } = g.months(2023, 2025);
  const off = g.offsets(sizes);
  check(off[off.length - 1] === 365 + 366 + 365, "three years of days");
  let ok = true;
  for (let i = 0; i < off[off.length - 1]; i++) {
    let k = 0;
    while (off[k + 1] <= i) k++;
    if (g.locate(off, i) !== k) ok = false;
  }
  check(ok, "locate matches a scan");
  check(g.locate(off, -1) === -1 && g.locate(off, 2000) === -1, "outside is -1");
  const feb24 = g.dayOf(2023, 2024, 1);
  check(feb24 === 365 + 31, "1 Feb 2024");
  check(same(g.span(off, feb24, feb24 + 29), [13, 13]), "February 2024 is one chunk");
  check(same(g.span(g.offsets(g.regularAxis(1096, 30)), feb24, feb24 + 29, 1096), [13, 14]), "February 2024 in 30-day chunks is two");
  check(g.years(2023, 2025).sizes.join() === "365,366,365", "years");
  check(g.isLeap(2000) && !g.isLeap(1900) && g.isLeap(2024), "leap years");
}

// chunk_grid round trip
{
  const r = g.regularGrid([100, 180, 360], [30, 90, 90]);
  check(g.isRegular(r) && g.chunkCount(r) === 4 * 2 * 4, "regular grid");
  check(same(g.chunkGridJson(r), { name: "regular", configuration: { chunk_shape: [30, 90, 90] } }), "regular json");
  const back = g.parseChunkGrid({ shape: [100, 180, 360], chunk_grid: g.chunkGridJson(r) });
  check(same(back.grid.axes, r.axes), "regular round trip");

  const days = g.months(2024, 2024).sizes;
  const rg = g.grid([366, 180, 360], [days, g.regularAxis(180, 90), g.regularAxis(360, 90)]);
  const j = g.chunkGridJson(rg);
  check(j.name === "rectilinear" && same(j.configuration.chunk_shapes, [[31, 29, 31, 30, 31, 30, [31, 2], 30, 31, 30, 31], 90, 90]), "rectilinear json");
  const p = g.parseChunkGrid(j, [366, 180, 360]);
  check(p.kind === "rectilinear" && same(p.grid.axes, rg.axes), "rectilinear round trip");
  check(same(g.chunkGridJson(g.grid([100], [g.regularAxis(100, 30, { trim: true })])).configuration.chunk_shapes, [[[30, 3], 10]]), "trimmed edge chunk as runs");
  check(same(g.chunkGridJson(g.grid([100], [g.regularAxis(100, 30)]), { force: "rectilinear" }).configuration.chunk_shapes, [30]), "overhanging edge chunk as an integer");
  let threw = false;
  try { g.grid([100], [[30, 30, 30]]); } catch (e) { threw = true; }
  check(threw, "sizes must reach the shape");
  check(g.grid([12], [[4, 4, 4, 4]]).axes[0].length === 4, "overflow chunks are allowed");
  check(g.parseChunkGrid({ shape: [10, 10], chunks: [4, 5] }).grid.axes[0].join() === "4,4,4", "v2 .zarray");
  // the extension's own example (zarr-extensions chunk-grids/rectilinear README)
  const ex = g.parseChunkGrid({ shape: [6, 6, 6, 6, 6], chunk_grid: { name: "rectilinear", configuration: { kind: "inline", chunk_shapes: [4, [1, 2, 3], [[4, 2]], [[1, 3], 3], [4, 4, 4]] } } });
  check(same(ex.grid.axes, [[4, 4], [1, 2, 3], [4, 4], [1, 1, 1, 3], [4, 4, 4]]), "the extension's example");
}

// keys and read cost
{
  check(g.chunkKey([1, 0, 3]) === "c/1/0/3" && g.chunkKey([1, 0, 3], { version: 2 }) === "1.0.3", "chunk keys");
  const r = g.regularGrid([100, 10], [30, 10]);
  const c = g.readCost(r, [[95, 100], [0, 10]]);
  check(c.chunks === 1 && c.read === 300 && c.want === 50, `edge chunk read ${JSON.stringify(c)}`);
  const t = g.grid([100, 10], [g.regularAxis(100, 30, { trim: true }), [10]]);
  check(g.readCost(t, [[95, 100], [0, 10]]).read === 100, "trimmed edge chunk read");
}

// mosaics
{
  const tidy = [{ x0: 0, x1: 100, y0: 0, y1: 50 }, { x0: 100, x1: 130, y0: 0, y1: 50 }, { x0: 0, x1: 100, y0: 50, y1: 70 }, { x0: 100, x1: 130, y0: 50, y1: 70 }];
  const a = g.mosaicReport(tidy);
  check(a.oneChunkEach && same(a.grid.cols, [100, 30]) && same(a.grid.rows, [50, 20]), "uneven tiles in rows and columns");
  const brick = [{ x0: 0, x1: 100, y0: 0, y1: 50 }, { x0: 100, x1: 200, y0: 0, y1: 50 }, { x0: 50, x1: 150, y0: 50, y1: 100 }, { x0: 0, x1: 50, y0: 50, y1: 100 }, { x0: 150, x1: 200, y0: 50, y1: 100 }];
  const b = g.mosaicReport(brick);
  check(!b.oneChunkEach && b.overlapCells === 0 && b.holes === 0 && same(b.grid.cols, [50, 50, 50, 50]), "brick bond splits tiles");
  const lap = [{ x0: 0, x1: 110, y0: 0, y1: 50 }, { x0: 100, x1: 200, y0: 0, y1: 50 }];
  const c = g.mosaicReport(lap);
  check(c.overlapCells === 1 && same(c.grid.cols, [100, 10, 90]), "overlap claims a cell twice");
}

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log("chunk grids ok");
