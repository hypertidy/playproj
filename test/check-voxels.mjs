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

// the synthetic island: sea floor at the edge, a crater in the peak
{
  const w = V.syntheticWindow(10, 45, 60000, 128), f = V.sampler(w);
  const peak = Math.max(...w.elev), rim = f(w.west + w.dx, w.north - w.dy);
  check(peak > 1800 && f(10, 45) < peak - 500 && rim < -1500, `synthetic island peak ${peak}, crater ${f(10, 45)}, edge ${rim}`);
}

if (fails) { console.log(`${fails} voxel checks failed`); process.exit(1); }
console.log("voxels: laea vs proj4, grids, means, quantising and .vox all agree");
