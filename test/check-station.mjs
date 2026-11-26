// Checks for the station scene: REMA's VRT read as GDAL reads it
// (src/core/rema.js), and the scene's frame, nested patches, colours, ray
// test and near and far planes (src/core/station.js).
import assert from "node:assert/strict";
import * as R from "../src/core/rema.js";
import * as T from "../src/core/station.js";
import { geocentric } from "../src/core/geoid.js";

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

// ------------------------------------------------------------ URLs
assert.equal(R.httpUrl("/vsicurl/https://github.com/mdsumner/rema-ovr/raw/refs/heads/main/rema_mosaic_1km_v2.0_filled_cop30_dem.tif"),
  "https://media.githubusercontent.com/media/mdsumner/rema-ovr/refs/heads/main/rema_mosaic_1km_v2.0_filled_cop30_dem.tif");
assert.equal(R.httpUrl("/vsicurl/https://github.com/mdsumner/rema-ovr/raw/refs/heads/main/rema-vrt/10m_dem_tiles.vrt"),
  "https://raw.githubusercontent.com/mdsumner/rema-ovr/refs/heads/main/rema-vrt/10m_dem_tiles.vrt");
assert.equal(R.httpUrl("/vsis3/pgc-opendata-dems/rema/mosaics/v2.0/10m/35_54/35_54_10m_v2.0_dem.tif"),
  "https://pgc-opendata-dems.s3.amazonaws.com/rema/mosaics/v2.0/10m/35_54/35_54_10m_v2.0_dem.tif");
assert.equal(R.httpUrl("/vsicurl/https://s3.us-west-2.amazonaws.com/pgc-opendata-dems/rema/a.tif"), "https://s3.us-west-2.amazonaws.com/pgc-opendata-dems/rema/a.tif");

// ------------------------------------------------------------ the VRT
const VRT = `<VRTDataset rasterXSize="300" rasterYSize="200">
  <SRS dataAxisToSRSAxisMapping="1,2">PROJCS["WGS 84 / Antarctic Polar Stereographic"]</SRS>
  <GeoTransform> -1.0000000000000000e+03,  2.0000000000000000e+00,  0.0000000000000000e+00,  5.0000000000000000e+02,  0.0000000000000000e+00, -2.0000000000000000e+00</GeoTransform>
  <GeoTransform> -1.0000000000000000e+03,  2.0000000000000000e+00,  0.0000000000000000e+00,  5.0000000000000000e+02,  0.0000000000000000e+00, -2.0000000000000000e+00</GeoTransform>
  <VRTRasterBand dataType="Float32" band="1">
<Overview>
  <SourceFilename relativeToVRT="0">/vsicurl/https://github.com/o/r/raw/refs/heads/main/v/10m.vrt</SourceFilename>
  <SourceBand>1</SourceBand>
</Overview>
<Overview>
  <SourceFilename relativeToVRT="0">/vsicurl/https://github.com/o/r/raw/refs/heads/main/c_100m.tif</SourceFilename>
  <SourceBand>1</SourceBand>
</Overview>
    <NoDataValue>-9999</NoDataValue>
    <ComplexSource>
      <SourceFilename relativeToVRT="0">/vsicurl/https://example.org/a.tif</SourceFilename>
      <SourceBand>1</SourceBand>
      <SourceProperties RasterXSize="160" RasterYSize="200" DataType="Float32" BlockXSize="512" BlockYSize="512" />
      <SrcRect xOff="0" yOff="0" xSize="160" ySize="200" />
      <DstRect xOff="0" yOff="0" xSize="160" ySize="200" />
      <NODATA>-9999</NODATA>
    </ComplexSource>
    <SimpleSource>
      <SourceFilename relativeToVRT="0">/vsis3/bucket/b.tif</SourceFilename>
      <SourceBand>1</SourceBand>
      <SourceProperties RasterXSize="300" RasterYSize="400" DataType="Float32" BlockXSize="512" BlockYSize="512" />
      <SrcRect xOff="0" yOff="0" xSize="300" ySize="400" />
      <DstRect xOff="150" yOff="0" xSize="150" ySize="200" />
    </SimpleSource>
  </VRTRasterBand>
</VRTDataset>`;
const v = R.parseVrt(VRT);
assert.equal(v.width, 300); assert.equal(v.height, 200);
assert.deepEqual(v.gt, [-1000, 2, 0, 500, 0, -2]);
assert.equal(v.nodata, -9999);
assert.deepEqual(v.overviews, ["https://raw.githubusercontent.com/o/r/refs/heads/main/v/10m.vrt", "https://media.githubusercontent.com/media/o/r/refs/heads/main/c_100m.tif"]);
assert.equal(v.sources.length, 2);
assert.deepEqual(v.sources[0], { url: "https://example.org/a.tif", src: [0, 0, 160, 200], dst: [0, 0, 160, 200], nodata: -9999 });
assert.deepEqual(v.sources[1], { url: "https://bucket.s3.amazonaws.com/b.tif", src: [0, 0, 300, 400], dst: [150, 0, 150, 200], nodata: null });
assert.throws(() => R.parseVrt("<GTiff/>"));

// ------------------------------------------------------------ windows and sources
const g = R.gridOf(v.gt, v.width, v.height);
assert.deepEqual(g, { x0: -1000, y0: 500, dx: 2, dy: 2, w: 300, h: 200 });
// the cell holding x, y in the middle: x = -1000 + 2 * 100.5 is column 100
assert.deepEqual(R.windowAt(g, -799, 299, 10), { c0: 95, r0: 95, w: 10, h: 10 });
assert.deepEqual(R.windowAt(g, -999, 499, 10), { c0: 0, r0: 0, w: 5, h: 5 }, "clipped at the corner");
assert.equal(R.windowAt(g, 5000, 0, 10), null, "off the grid");
// a window across both sources (columns 140 to 170; they overlap from 150
// to 160): the second read at twice the cells it lands in
const win = { c0: 140, r0: 10, w: 30, h: 4 }, parts = R.sourcesIn(v.sources, win);
assert.equal(parts.length, 2);
assert.deepEqual(parts[0], { url: "https://example.org/a.tif", nodata: -9999, read: [140, 10, 160, 14], cols: 20, rows: 4, at: [0, 0] });
assert.deepEqual(parts[1], { url: "https://bucket.s3.amazonaws.com/b.tif", nodata: null, read: [0, 20, 40, 28], cols: 20, rows: 4, at: [10, 0] });
assert.deepEqual(R.sourcesIn(v.sources, { c0: 0, r0: 0, w: 10, h: 10 }).map((p) => p.url), ["https://example.org/a.tif"]);
// pasting leaves what is there under a block's nodata
const out = new Float32Array(6).fill(7);
R.paste(out, 3, Float32Array.from([1, -9999, 3, 4]), { cols: 2, rows: 2, at: [1, 0], nodata: -9999 });
assert.deepEqual([...out], [7, 1, 7, 7, 3, 4]);
R.paste(out, 3, Float32Array.from([NaN]), { cols: 1, rows: 1, at: [0, 0], nodata: null });
assert.equal(out[0], 7, "NaN is no value either");
// levels by cell size, in ratio
const levels = [2, 10, 32, 100, 500, 1000, 2000, 4000, 8000.6, 16000].map((dx) => ({ dx }));
assert.deepEqual(T.LADDER.map((d) => R.pickLevel(levels, d).dx), [8000.6, 500, 100, 32, 10, 2]);
assert.equal(R.pickLevel(levels, 6000).dx, 8000.6, "6 km is nearer 8 km than 4 km in ratio");
assert.deepEqual([2, 10, 32, 500, 8005.87, 16000].map(R.cellWords), ["2 m", "10 m", "32 m", "500 m", "8 km", "16 km"]);

// ------------------------------------------------------------ the frame
const davis = T.STATIONS.davis, F = T.enuFrame(davis.lon, davis.lat);
near(Math.hypot(...T.toEnu(F, ...F.o)), 0, 1e-9, "the station's own ground is the origin");
{
  const up = T.toEnu(F, ...geocentric(davis.lon, davis.lat, 100));
  near(up[0], 0, 1e-6, "100 m up: east"); near(up[1], 0, 1e-6, "north"); near(up[2], 100, 1e-6, "up");
  // a little north and a little east
  const n = T.toEnu(F, ...geocentric(davis.lon, davis.lat + 0.01, 0)), e = T.toEnu(F, ...geocentric(davis.lon + 0.01, davis.lat, 0));
  assert.ok(n[1] > 1100 && Math.abs(n[0]) < 1e-6, `north is +y (${n})`);
  assert.ok(e[0] > 400 && Math.abs(e[1]) < 1, `east is +x (${e})`);
  const back = T.fromEnu(F, 123.4, -567.8, 910.1), there = T.toEnu(F, ...back);
  near(there[0], 123.4, 1e-7, "round trip x"); near(there[1], -567.8, 1e-7, "y"); near(there[2], 910.1, 1e-7, "z");
}
for (const [lon, lat, h] of [[77.9675, -68.5765, 17.6], [0, -90, 2835], [-68.1, -67.5, -40], [123.3, -75.1, 3233], [140, -25, 2e7], [10, 45, 0]]) {
  const [l, p, hh] = T.geodetic(...geocentric(lon, lat, h));
  near(l, lon, 1e-9, `geodetic lon at ${lon}, ${lat}`); near(p, lat, 1e-9, `lat`); near(hh, h, 1e-5, `height`);
}
{
  const P = T.enuFrame(0, -90);
  const e = T.toEnu(P, ...geocentric(90, -89.99, 0)), n = T.toEnu(P, ...geocentric(0, -89.99, 0));
  assert.ok(e[0] > 1000 && Math.abs(e[1]) < 1, "at the pole east is towards 90 E");
  assert.ok(n[1] > 1000 && Math.abs(n[0]) < 1, "and north towards 0 E");
}

// ------------------------------------------------------------ patches
const [sx, sy] = T.PS.forward(davis.lon, davis.lat);
// a coarse level of 100 m cells and a fine one of 32 m, with their own origins
const coarse = { x0: sx - 1000.5 * 100 + 37, y0: sy + 1000 * 100 - 11, dx: 100, dy: 100, w: 3000, h: 3000 };
const fine = { x0: sx - 3001 * 32 + 5, y0: sy + 3000 * 32 + 3, dx: 32, dy: 32, w: 9000, h: 9000 };
const surf = (x, y) => 20 + 30 * Math.sin((x - sx) / 700) + 20 * Math.cos((y - sy) / 900);
function makePatch(grid, n) {
  const w = R.windowAt(grid, sx, sy, n), ax = T.patchAxes(grid, w), z = new Float32Array(ax.w * ax.h);
  for (let j = 0, k = 0; j < ax.h; j++) for (let i = 0; i < ax.w; i++, k++) z[k] = surf(ax.xs[i], ax.ys[j]);
  return { ...ax, z, enu: T.enuPositions(ax, z, F) };
}
const P = makePatch(coarse, 24), Q = makePatch(fine, 40);
assert.equal(P.w, 24); assert.equal(Q.w, 40);
near(P.xs[1] - P.xs[0], 100, 1e-9, "axes step a cell"); near(P.ys[0] - P.ys[1], 100, 1e-9, "and down y");
const hole = T.holeIn(P, Q);
assert.ok(hole, "the fine patch makes a hole");
assert.ok(P.xs[hole.i0] >= Q.xs[0] && P.xs[hole.i0 - 1] < Q.xs[0], "the hole's left line is the first inside");
assert.ok(P.xs[hole.i1] <= Q.xs[Q.w - 1] && P.xs[hole.i1 + 1] > Q.xs[Q.w - 1], "its right line the last inside");
assert.ok(P.ys[hole.j0] <= Q.ys[0] && P.ys[hole.j0 - 1] > Q.ys[0], "its top");
assert.ok(P.ys[hole.j1] >= Q.ys[Q.h - 1] && P.ys[hole.j1 + 1] < Q.ys[Q.h - 1], "its bottom");
assert.equal(T.holeIn(P, { ...Q, xs: Q.xs.map((x) => x + 1e5) }), null, "a patch elsewhere makes none");
assert.deepEqual(T.holeIn(Q, P), { i0: 0, i1: Q.w - 1, j0: 0, j1: Q.h - 1 }, "and one over the whole of it takes it all");
const full = T.gridIndex(P.w, P.h), holed = T.gridIndex(P.w, P.h, hole);
assert.equal(full.length, 6 * (P.w - 1) * (P.h - 1));
assert.equal(holed.length, full.length - 6 * (hole.i1 - hole.i0) * (hole.j1 - hole.j0), "the hole drops its cells");
// wound so that faces look up
{
  const [a, b, c] = full, E = P.enu, d1 = [0, 1, 2].map((q) => E[3 * b + q] - E[3 * a + q]), d2 = [0, 1, 2].map((q) => E[3 * c + q] - E[3 * a + q]);
  assert.ok(d1[0] * d2[1] - d1[1] * d2[0] > 0, "triangles face up");
}
// the fine patch's rim pinned onto the hole's edges: every rim vertex on a
// coarse edge, and the hole's corners exactly the coarse corners
T.pinEdges(Q, P, hole);
const vtx = (S, k) => [S.enu[3 * k], S.enu[3 * k + 1], S.enu[3 * k + 2]];
const onSeg = (p, a, b) => {
  const ab = a.map((x, i) => b[i] - x), ap = a.map((x, i) => p[i] - x), L = ab.reduce((s, x) => s + x * x, 0);
  const t = Math.max(0, Math.min(1, ap.reduce((s, x, i) => s + x * ab[i], 0) / L));
  return Math.hypot(...a.map((x, i) => x + t * ab[i] - p[i]));
};
const rimEdges = [];
for (let i = hole.i0; i < hole.i1; i++) for (const j of [hole.j0, hole.j1]) rimEdges.push([j * P.w + i, j * P.w + i + 1]);
for (let j = hole.j0; j < hole.j1; j++) for (const i of [hole.i0, hole.i1]) rimEdges.push([j * P.w + i, (j + 1) * P.w + i]);
let worst = 0, rim = 0;
for (let j = 0; j < Q.h; j++)
  for (let i = 0; i < Q.w; i++) {
    if (i > 0 && j > 0 && i < Q.w - 1 && j < Q.h - 1) continue;
    const p = vtx(Q, j * Q.w + i), d = Math.min(...rimEdges.map(([a, b]) => onSeg(p, vtx(P, a), vtx(P, b))));
    worst = Math.max(worst, d); rim++;
  }
assert.ok(worst < 1e-6, `the fine rim lies on the coarse hole's edges (worst ${worst} m over ${rim} vertices)`);
for (const [ci, cj] of [[0, 0], [Q.w - 1, 0], [0, Q.h - 1], [Q.w - 1, Q.h - 1]]) {
  const p = vtx(Q, cj * Q.w + ci), corner = vtx(P, (cj ? hole.j1 : hole.j0) * P.w + (ci ? hole.i1 : hole.i0));
  near(Math.hypot(...p.map((x, k) => x - corner[k])), 0, 1e-6, "the fine patch's corner is the hole's");
}
// the fine patch's inside is its own: a vertex in the middle is its own height
{
  const k = 20 * Q.w + 20, p = vtx(Q, k), [, , h] = T.enuGeodetic(F, ...p);
  near(h, Q.z[k], 1e-4, "inside, the fine patch's own heights");
}

// ------------------------------------------------------------ filling and colours
{
  const ax = { xs: Float64Array.from([sx, sx + 100, sx + 200]), ys: Float64Array.from([sy, sy - 100]), w: 3, h: 2 };
  const z = Float32Array.from([-9999, 50, 4000, NaN, 10, 600]);
  const filled = T.fillHeights(z, ax, -9999, () => ({ h: 17.5, sea: true }));
  assert.deepEqual([...filled], [1, 0, 0, 1, 0, 0]);
  assert.deepEqual([...z], [17.5, 50, 4000, 17.5, 10, 600]);
  // land filled from elsewhere is land, told where it is
  const z2 = Float32Array.from([-9999, 50]), seen = [];
  const f2 = T.fillHeights(z2, { xs: Float64Array.from([sx, sx + 100]), ys: Float64Array.from([sy]), w: 2, h: 1 }, -9999, (x, y, lon, lat) => { seen.push([x, y, lon, lat]); return { h: 2800, sea: false }; });
  assert.deepEqual([...f2], [2, 0]); assert.equal(z2[0], 2800);
  near(seen[0][0], sx, 1e-9, "fillAt gets x"); near(seen[0][3], davis.lat, 1e-9, "and lat");
  const land = T.tints(Float32Array.from([2800, 2800, 2800, 2800]), Uint8Array.from([2, 2, 2, 2]), { w: 2, h: 2 }, 100, 100, -30);
  assert.ok(land[0] > 0.9, "filled land is snow, not the sea");
  const c = T.tints(z, filled, ax, 100, 100, 17.5);
  const col = (k) => [...c.slice(3 * k, 3 * k + 3)].map((x) => +x.toFixed(3));
  assert.deepEqual(col(0), col(3), "filled cells are the sea");
  assert.ok(col(2)[0] < 0.5 && col(2)[2] < 0.5, `a 4 km cliff in 100 m is rock (${col(2)})`);
  const flat = T.tints(Float32Array.from([18, 18, 18, 18]), new Uint8Array(4), { w: 2, h: 2 }, 100, 100, 17.5);
  assert.deepEqual([...flat.slice(0, 3)].map((x) => +x.toFixed(3)), col(0), "flat at sea level is the sea");
  const snow = T.tints(Float32Array.from([3000, 3000, 3000, 3000]), new Uint8Array(4), { w: 2, h: 2 }, 100, 100, 0);
  assert.ok(snow[0] > 0.95 && snow[2] > 0.95, "high flat ground is snow");
  const bare = T.tints(Float32Array.from([40, 40, 40, 40]), new Uint8Array(4), { w: 2, h: 2 }, 100, 100, 17.5, Float32Array.from([1, 0, 0.5, 1]));
  const bc = (k) => [...bare.slice(3 * k, 3 * k + 3)].map((x) => +x.toFixed(3));
  assert.deepEqual(bc(0), col(2), "flat ground with no ice on it is rock");
  assert.ok(bc(1)[2] > 0.8, "flat ground with ice is snow");
  assert.ok(bc(2)[2] < bc(1)[2] && bc(2)[2] > bc(0)[2], "and half way, between");
  const sea2 = T.tints(Float32Array.from([18, 18, 18, 18]), new Uint8Array(4), { w: 2, h: 2 }, 100, 100, 17.5, Float32Array.from([1, 1, 1, 1]));
  assert.deepEqual([...sea2.slice(0, 3)].map((x) => +x.toFixed(3)), col(0), "the sea with no ice is still the sea");
}

// ------------------------------------------------------------ sampling and rays
{
  // the nodata-aware sampler: bilinear among four with values, else the nearest with one
  const ax = { xs: Float64Array.from([0, 10]), ys: Float64Array.from([10, 0]), w: 2, h: 2 };
  near(T.sampleValid(ax, Float32Array.from([0, 10, 20, 30]), 5, 5, -9999), 15, 1e-9, "all four: bilinear");
  assert.equal(T.sampleValid(ax, Float32Array.from([0, -9999, 20, 30]), 9, 9, -9999), 0, "the nearest with a value");
  assert.equal(T.sampleValid(ax, Float32Array.from([NaN, 7, 20, 30]), 1, 9, -9999), 7, "NaN is no value");
  assert.equal(T.sampleValid(ax, Float32Array.from([-9999, -9999, -9999, -9999]), 5, 5, -9999), null, "none");
  assert.equal(T.sampleValid(ax, Float32Array.from([0, 10, 20, 30]), 50, 5, -9999), null, "outside");
}
{
  near(T.sampleGrid(P, P.z, P.xs[3], P.ys[5]), P.z[5 * P.w + 3], 1e-4, "at a vertex");
  const x = (P.xs[3] + P.xs[4]) / 2, y = (P.ys[5] + P.ys[6]) / 2, k = 5 * P.w + 3;
  near(T.sampleGrid(P, P.z, x, y), (P.z[k + 1] + P.z[k + P.w]) / 2, 1e-4, "in a cell's middle, on its triangles' shared diagonal");
  const x1 = P.xs[3] + 0.2 * (P.xs[4] - P.xs[3]), y1 = P.ys[5] - 0.3 * (P.ys[5] - P.ys[6]);
  near(T.sampleGrid(P, P.z, x1, y1), P.z[k] + 0.2 * (P.z[k + 1] - P.z[k]) + 0.3 * (P.z[k + P.w] - P.z[k]), 1e-4, "on the first triangle");
  const x2 = P.xs[3] + 0.8 * (P.xs[4] - P.xs[3]), y2 = P.ys[5] - 0.7 * (P.ys[5] - P.ys[6]), dd = P.z[k + P.w + 1];
  near(T.sampleGrid(P, P.z, x2, y2), dd + 0.2 * (P.z[k + P.w] - dd) + 0.3 * (P.z[k + 1] - dd), 1e-4, "on the second");
  assert.equal(T.sampleGrid(P, P.z, P.xs[0] - 1, P.ys[0]), null, "outside");
}
{
  const patch = { enu: P.enu, w: P.w, h: P.h, hole, tiles: T.tileBoxes(P.enu, P.w, P.h, 5) };
  assert.equal(patch.tiles.nx, Math.ceil((P.w - 1) / 5));
  // straight down onto a vertex outside the hole
  const k = 2 * P.w + 2, p = vtx(P, k), hit = T.rayHit(patch, [p[0], p[1], p[2] + 5000], [0, 0, -1]);
  assert.ok(hit, "a ray down meets the patch");
  near(hit.t, 5000, 0.05, "at the vertex's height");
  // a slanting ray's hit is on the ground the sampler gives, to a millimetre
  {
    const p0 = vtx(P, 2 * P.w + 2), aim = [p0[0] + 37, p0[1] - 23, p0[2]], o = [aim[0] + 400, aim[1] - 900, aim[2] + 2500];
    const d0 = aim.map((x, i) => x - o[i]), L = Math.hypot(...d0), d = d0.map((x) => x / L), got = T.rayHit(patch, o, d);
    assert.ok(got, "the slanting ray meets the patch outside the hole");
    const q = o.map((x, i) => x + got.t * d[i]), [lon, lat, hh] = T.enuGeodetic(F, ...q), [px, py] = T.PS.forward(lon, lat);
    near(hh, T.sampleGrid(P, P.z, px, py), 0.01, "a ray's hit is on the sampled ground");
  }
  // into the hole: nothing
  const m = vtx(P, ((hole.j0 + hole.j1) >> 1) * P.w + ((hole.i0 + hole.i1) >> 1));
  assert.equal(T.rayHit(patch, [m[0], m[1], m[2] + 5000], [0, 0, -1]), null, "the hole is open");
  // slanting rays agree with every triangle tried
  const tris = T.gridIndex(P.w, P.h, hole);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let n = 0; n < 40; n++) {
    const o = [(rnd() - 0.5) * 3000, (rnd() - 0.5) * 3000, 3000 + rnd() * 3000];
    const d0 = [(rnd() - 0.5), (rnd() - 0.5), -0.3 - rnd()], L = Math.hypot(...d0), d = d0.map((x) => x / L);
    const got = T.rayHit(patch, o, d);
    let best = Infinity;
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]].map((q) => vtx(P, q));
      const e1 = b.map((x, i) => x - a[i]), e2 = c.map((x, i) => x - a[i]);
      const pv = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
      const det = e1.reduce((s, x, i) => s + x * pv[i], 0), sv = o.map((x, i) => x - a[i]);
      const u = sv.reduce((s, x, i) => s + x * pv[i], 0) / det;
      const qv = [sv[1] * e1[2] - sv[2] * e1[1], sv[2] * e1[0] - sv[0] * e1[2], sv[0] * e1[1] - sv[1] * e1[0]];
      const w2 = d.reduce((s, x, i) => s + x * qv[i], 0) / det, tt = e2.reduce((s, x, i) => s + x * qv[i], 0) / det;
      if (u >= 0 && w2 >= 0 && u + w2 <= 1 && tt > 0) best = Math.min(best, tt);
    }
    if (best === Infinity) assert.equal(got, null, "a ray that misses every triangle misses");
    else near(got.t, best, 1e-6, "the tiles find the nearest triangle");
  }
}

// the ellipsoid from above, from beside and from inside
{
  near(T.rayEllipsoid(F, [0, 0, 1000], [0, 0, -1]), 1000, 1e-6, "1 km straight down");
  near(T.rayEllipsoid(F, [0, 0, 1000], [0, 0, -1], 17.5), 982.5, 1e-3, "onto the sea 17.5 m up");
  assert.equal(T.rayEllipsoid(F, [0, 0, 1000], [0, 0, 1]), null, "looking up, nothing");
  const t = T.rayEllipsoid(F, [0, 0, -100], [0, 0, 1]);
  near(t, 100, 1e-6, "from 100 m under, out through the top");
  const s = T.rayEllipsoid(F, [0, -2e7, -3e6], [0, 1, 0]);
  assert.equal(T.rayEllipsoid(F, [0, -2e7, 1e6], [0, 1, 0]), null, "level from 1,000 km up, it passes over");
  assert.ok(s > 1e7 && s < 2e7, `level, from far off, the limb (${s})`);
}

// ------------------------------------------------------------ near and far
{
  const Rp = 6356752;
  const [n0, f0] = T.nearFar(Rp + 20, 2);
  near(n0, 0.5, 1e-12, "standing on the ground, near is half a metre");
  assert.ok(f0 > 250e3 && f0 < 275e3, `and far reaches past the horizon to the highest ground (${f0})`);
  const [n1, f1] = T.nearFar(Rp + 1000, 1000);
  assert.equal(n1, 250, "a kilometre up, near is 250 m");
  const [n2, f2] = T.nearFar(3 * 6378137, 2 * 6378137);
  assert.ok(f2 / n2 < 10, `from space far is a few times near (${(f2 / n2).toFixed(1)})`);
  assert.ok(f2 > Math.sqrt((3 * 6378137) ** 2 - Rp ** 2), "and reaches the globe's limb");
  const [n3, f3] = T.nearFar(Rp - 50, -30);
  assert.ok(n3 === 0.5 && f3 >= 2 * n3, "under the ground, near is still half a metre");
}

console.log("station: REMA's VRT and its URLs, windows, sources and levels, the station's frame, nested patches pinned edge to edge, colours, the tiled ray test and the near and far planes all agree");
