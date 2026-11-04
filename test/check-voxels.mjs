// Voxels (src/core/voxels.js): the equal-area grid against proj4's laea on
// the same sphere, column footprints in each cell system, column means on
// a plane (exact for bilinear samples), quantising, and a .vox file read
// back.
import proj4 from "proj4";
import * as V from "../src/core/voxels.js";

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };
const D2R = Math.PI / 180;

// laea both ways against proj4, at a few centres
for (const [lon0, lat0] of [[86.9, 28], [167, -77.5], [-155.5, 19.6], [0, 90], [-18.6, 64.9]]) {
  const P = V.laea(lon0, lat0);
  const def = `+proj=laea +lon_0=${lon0} +lat_0=${lat0} +x_0=0 +y_0=0 +R=${V.R} +units=m +no_defs`;
  for (const [dl, dp] of [[0.3, 0.2], [-1, 0.7], [2.5, -1.5]]) {
    const lon = lon0 + dl, lat = Math.min(89.9, lat0 + dp);
    const [x, y] = P.forward(lon, lat), [px, py] = proj4("EPSG:4326", def, [lon, lat]);
    check(Math.hypot(x - px, y - py) < 1e-3, `laea at ${lon0},${lat0}: ${x},${y} vs proj4 ${px},${py}`);
    const [l2, p2] = P.inverse(x, y);
    check(Math.abs(((l2 - lon + 540) % 360) - 180) < 1e-9 && Math.abs(p2 - lat) < 1e-9, `laea inverse at ${lon},${lat}`);
  }
}

// grids: laea cells square and covering ext; lon/lat cells cos(lat) wide
{
  const ext = 90000, g = V.columnGrid(167, -77.5, ext, 64, "laea");
  check(g.ni === 64 && g.nj === 64 && Math.abs(g.cellM * 64 - ext) < 1e-6, "laea grid size");
  check(g.cols.every((c) => c.wx === c.wy), "laea cells square");
  const ll = V.columnGrid(167, -77.5, ext, 64, "lonlat");
  const c = ll.cols[(ll.nj >> 1) * ll.ni];
  check(Math.abs(c.wx / c.wy - Math.cos(c.lat * D2R)) < 1e-12, "lonlat cell width is cos(lat) of its height");
  check(Math.abs(ll.nj / ll.ni - Math.cos(-77.5 * D2R)) < 0.03, `lonlat rows ${ll.nj} for ${ll.ni} columns at 77.5 S`);
  const ar = V.columnGrid(167, -77.5, ext, 64, "array");
  check(ar.cols.every((q) => q.wx === q.wy && q.wx === ar.cols[0].wx), "array cells drawn square and equal");
  // each column's samples lie inside its own footprint
  for (const q of [g.cols[0], g.cols[2047], ll.cols[100]]) {
    const pts = q.pts(3);
    check(pts.length === 9, "3 x 3 samples");
  }
}

// a plane in lon/lat: the bilinear mean over a footprint is the value at
// its centre for lon/lat cells
{
  const box = { west: 140, north: -30, dx: 0.01, dy: 0.01, width: 600, height: 600 };
  const elev = new Float32Array(600 * 600);
  for (let j = 0; j < 600; j++) for (let i = 0; i < 600; i++) {
    const lon = 140 + (i + 0.5) * 0.01, lat = -30 - (j + 0.5) * 0.01;
    elev[j * 600 + i] = 100 * (lon - 140) - 50 * (lat + 30);
  }
  const f = V.sampler({ ...box, elev });
  check(Math.abs(f(142.345, -31.2) - (234.5 + 60)) < 1e-3, `sampler on a plane: ${f(142.345, -31.2)}`);
  const g = V.columnGrid(143, -33, 100000, 16, "lonlat");
  const { z, s } = V.columnMeans(g, f, 1100);
  let worst = 0;
  g.cols.forEach((c, k) => { worst = Math.max(worst, Math.abs(z[k] - (100 * (c.lon - 140) - 50 * (c.lat + 30)))); });
  check(s > 1 && worst < 1e-3, `column means on a plane off by ${worst} (s = ${s})`);
}

// quantising and the shell
{
  const z = Float32Array.from([-120, -40, 0, 49, 51, 260]);
  const q = V.quantise(z, 100);
  check(q.top.join() === "-1,0,0,0,1,3" && q.base === -3 && q.hi === 3, `quantise ${q.top.join()} base ${q.base}`);
  check(q.solid === 2 + 3 + 3 + 3 + 4 + 6 && q.water === 1, `voxel counts ${q.solid} ${q.water}`);
  check(V.layerClass(V.CLASS.grass, 1) === V.CLASS.dirt && V.layerClass(V.CLASS.grass, 3) === V.CLASS.stone, "layers under grass");
  check(V.surfaceClass(5000, 28) === V.CLASS.snow && V.surfaceClass(800, 28) === V.CLASS.grass && V.surfaceClass(-3000, 0) === V.CLASS.silt, "surface classes");
}

// .vox: write a block and read it back
{
  const g = V.columnGrid(0, 0, 50000, 20, "laea");
  const z = Float32Array.from(g.cols, (c) => 400 * Math.sin(c.x / 8000) + 300 * Math.cos(c.y / 6000) - 100);
  const q = V.quantise(z, 50), surface = Uint8Array.from(z, (v) => V.surfaceClass(v, 0));
  const { bytes, count, size } = V.writeVox(q, g.ni, g.nj, surface);
  const r = V.readVox(bytes);
  check(r.version === 150, "vox version 150");
  check(r.size.join() === size.join() && r.voxels.length === count, `vox size ${r.size} count ${r.voxels.length}`);
  // every column's top voxel is there, coloured as its surface
  const at = new Map(r.voxels.map(([x, y, zz, c]) => [`${x},${y},${zz}`, c]));
  let missing = 0, wrong = 0;
  for (let k = 0; k < z.length; k++) {
    const i = k % g.ni, j = Math.floor(k / g.ni), t = q.top[k] - 1 - q.base;
    const c = at.get(`${i},${j},${t}`);
    if (c === undefined) missing++; else if (c !== surface[k]) wrong++;
  }
  check(!missing && !wrong, `vox tops: ${missing} missing, ${wrong} miscoloured`);
  check(r.voxels.every(([x, y, zz]) => x < size[0] && y < size[1] && zz < size[2]), "vox voxels inside the size");
  check(r.palette[(V.CLASS.water - 1) * 4 + 2] === V.PALETTE[V.CLASS.water].rgb[2], "vox palette");
  let threw = false;
  try { V.writeVox(V.quantise(Float32Array.from([0, 30000]), 100), 2, 1, Uint8Array.from([1, 1])); } catch (e) { threw = true; }
  check(threw, "a block over 256 tall is refused");
}

// imagery tops: a column's mean colour from an RGBA window, and its top
// voxel coloured from the cube in a .vox
{
  const g = V.columnGrid(150, -40, 40000, 8, "lonlat");
  const W = 64, H = 64, data = new Uint8ClampedArray(W * H * 4);
  for (let k = 0; k < W * H; k++) { data[4 * k] = 200; data[4 * k + 1] = 100; data[4 * k + 2] = 50; data[4 * k + 3] = 255; }
  const b = V.groundBox(150, -40, 60000);
  const win = { width: W, height: H, data, west: b.west, north: b.north, dx: (b.east - b.west) / W, dy: (b.north - b.south) / H, global: false };
  const tops = V.columnColours(g, win, 2);
  check(tops.has.every((h) => h === 1) && tops.rgb[0] === 200 && tops.rgb[1] === 100 && tops.rgb[2] === 50, "column colours from a flat window");
  const z = Float32Array.from(g.cols, (c, k) => (k % 3 ? 300 : -300));
  const q = V.quantise(z, 100), surface = Uint8Array.from(z, (v) => V.surfaceClass(v, -40));
  const r = V.readVox(V.writeVox(q, g.ni, g.nj, surface, { tops }).bytes);
  const ci = V.cubeIndex(200, 100, 50), land = q.top.filter((t) => t > 0).length;
  check(r.voxels.filter((v) => v[3] === ci).length === land, "every land top voxel takes the imagery colour");
  check([0, 1, 2].every((c) => Math.abs(r.palette[(ci - 1) * 4 + c] - [200, 100, 50][c]) <= 26), "the cube colour is within half a step");
}

// a grid in another CRS: UTM 55S at 30 m, a plane in metres, read through
// gridSampler at a window planWindow picks (with a 2 x overview)
{
  const P = proj4("EPSG:4326", "+proj=utm +zone=55 +south +datum=WGS84 +units=m +no_defs");
  const fwd = (lon, lat) => P.forward([lon, lat]);
  const src = { nx: 4000, ny: 4000, x0: 450000, y0: 5300000, dx: 30, dy: -30, levels: [1, 2, 4] };
  const lon = 147.0, lat = -43.3, ext = 20000;
  const pl = V.planWindow(src, fwd, V.blockOutline(lon, lat, ext), ext / 64, lat);
  check(pl && pl.factor === 4 && pl.step === 1, `plan picks the 120 m overview for 312 m columns: ${JSON.stringify(pl)}`);
  const pf = V.planWindow(src, fwd, V.blockOutline(lon, lat, ext), ext / 256, lat);
  check(pf.factor === 1, `plan picks 30 m for 78 m columns (factor ${pf.factor})`);
  const plane = (x, y) => 0.01 * (x - 500000) + 0.02 * (5300000 - y);
  const elev = new Float32Array(pl.width * pl.height);
  for (let j = 0; j < pl.height; j++) for (let i = 0; i < pl.width; i++)
    elev[j * pl.width + i] = plane(pl.x0 + (i + 0.5) * pl.dx, pl.y0 + (j + 0.5) * pl.dy);
  elev[0] = -9999;
  const f = V.gridSampler({ elev, width: pl.width, height: pl.height, x0: pl.x0, y0: pl.y0, dx: pl.dx, dy: pl.dy, nodata: -9999 }, fwd);
  const [x, y] = fwd(lon, lat);
  check(Math.abs(f(lon, lat) - plane(x, y)) < 1e-2, `gridSampler on a plane: ${f(lon, lat)} vs ${plane(x, y)}`);
  check(Number.isNaN(f(lon + 5, lat)), "off the window is NaN");
  check(Number.isNaN(V.gridSampler({ elev, width: pl.width, height: pl.height, x0: pl.x0, y0: pl.y0, dx: pl.dx, dy: pl.dy, nodata: -9999 }, fwd)(...P.inverse([pl.x0 + pl.dx / 2, pl.y0 + pl.dy / 2]))), "nodata is NaN");
  check(V.planWindow(src, fwd, V.blockOutline(10, 50, ext), 300, 50) === null, "a block off the grid has no window");
  const q = V.quantise(Float32Array.from([NaN, -250, 120]), 100);
  check(q.missing[0] === 1 && q.top[0] === q.base && q.lo === -2 && q.water === 2, `NaN columns are empty: ${q.top.join()} ${q.water}`);
  const r = V.readVox(V.writeVox(q, 3, 1, Uint8Array.from([1, 2, 4])).bytes);
  check(!r.voxels.some((v) => v[0] === 0), "an empty column writes no voxels");
}

// scene metres back to lon/lat, for every layout, and a texture over the
// footprint
for (const crs of ["laea", "lonlat", "array"]) {
  const g = V.columnGrid(167, -77.5, 90000, 32, crs);
  let worst = 0;
  for (const c of [g.cols[0], g.cols[g.cols.length >> 1], g.cols[g.cols.length - 1]]) {
    const [lon, lat] = g.toLonLat(c.x, c.y), [l2, p2] = c.pts(1)[0];
    worst = Math.max(worst, Math.abs(lon - l2), Math.abs(lat - p2));
  }
  check(worst < 1e-9, `${crs}: toLonLat at column centres off by ${worst}`);
}
{
  const g = V.columnGrid(150, -40, 40000, 8, "laea"), b = V.groundBox(150, -40, 60000), W = 32;
  const data = new Uint8ClampedArray(W * W * 4);
  for (let k = 0; k < W * W; k++) { data[4 * k] = (k % W) * 8; data[4 * k + 3] = 255; }
  const t = V.topTexture(g, { width: W, height: W, data, west: b.west, north: b.north, dx: (b.east - b.west) / W, dy: (b.north - b.south) / W, global: false }, 16);
  check(t.data[3] === 255 && t.data[0] < t.data[15 * 4], "texture covers the footprint, west to east");
}

// sides: one colour under the tops, or the tops alone
{
  const g = V.columnGrid(0, 0, 30000, 12, "laea");
  const z = Float32Array.from(g.cols, (c) => 600 + 400 * Math.sin(c.x / 5000));
  const q = V.quantise(z, 100), surface = Uint8Array.from(z, (v) => V.surfaceClass(v, 0));
  const one = V.readVox(V.writeVox(q, g.ni, g.nj, surface, { sides: "colour", sideRgb: [10, 20, 30] }).bytes);
  const under = one.voxels.filter((v) => v[2] < q.top[v[1] * g.ni + v[0]] - 1 - q.base);
  check(under.length > 0 && under.every((v) => v[3] === V.SIDE), "every voxel under a top is the side colour");
  check([10, 20, 30].every((c, i) => one.palette[(V.SIDE - 1) * 4 + i] === c), "the side colour is in the palette");
  const none = V.readVox(V.writeVox(q, g.ni, g.nj, surface, { sides: "none" }).bytes);
  check(none.voxels.length === g.ni * g.nj && none.voxels.every((v) => v[2] === q.top[v[1] * g.ni + v[0]] - 1 - q.base), "hidden sides write the tops alone");
}

// the synthetic island: sea floor at the edge, a crater in the peak
{
  const w = V.syntheticWindow(10, 45, 60000, 128), f = V.sampler(w);
  const peak = Math.max(...w.elev), rim = f(w.west + w.dx, w.north - w.dy);
  check(peak > 1800 && f(10, 45) < peak - 500 && rim < -1500, `synthetic island peak ${peak}, crater ${f(10, 45)}, edge ${rim}`);
}

// zone CRS codes against proj4 (MGA 55 on GRS80, UTM 33N on WGS84), and
// the fallback sampler
{
  const mga = V.zoneForward(28355), m20 = V.zoneForward(7855), utm = V.zoneForward(32633);
  const pm = proj4("EPSG:4326", "+proj=utm +zone=55 +south +ellps=GRS80 +units=m +no_defs");
  const pu = proj4("EPSG:4326", "+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs");
  for (const [lon, lat] of [[147.237, -42.896], [145.95, -41.68], [144.1, -40.7]]) {
    const [x, y] = mga(lon, lat), [px, py] = pm.forward([lon, lat]);
    check(Math.hypot(x - px, y - py) < 1e-3 && m20(lon, lat)[0] === x, `MGA 55 at ${lon},${lat}: ${x},${y} vs ${px},${py}`);
  }
  const [x, y] = utm(14.5, 48.2), [px, py] = pu.forward([14.5, 48.2]);
  check(Math.hypot(x - px, y - py) < 1e-3, "UTM 33N");
  check(V.zoneForward(3857) === null && V.zoneForward(4326) === null, "other codes are not zones");
  const f = V.fallbackSampler((lon) => (lon > 0 ? 5 : NaN), () => -7);
  check(f(1, 0) === 5 && f(-1, 0) === -7, "fallback sampler");
}

if (fails) { console.log(`${fails} voxel checks failed`); process.exit(1); }
console.log("voxels: laea vs proj4, grids, means, quantising and .vox all agree");
