// Checks for the imagery draped over the station scene (src/core/drape.js):
// UTM against proj4js, Sentinel-2's names, the warp from an image in UTM
// onto a patch's own grid, the fade from where there is nothing, and the
// texture coordinates of vertices pinned to a hole's rim.
import assert from "node:assert/strict";
import proj4 from "proj4";
import * as D from "../src/core/drape.js";
import * as T from "../src/core/station.js";

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

// ------------------------------------------------------------ names
assert.deepEqual(D.s2Name("S2B_T43DFD_20240130T035649_L2A"), { sat: "S2B", tile: "43DFD", take: "20240130T035649" });
assert.equal(D.s2Name("S2B_T43DFD_20240130_L2A"), null);
for (const [k, id] of Object.entries(D.S2_SCENES)) {
  assert.ok(D.s2Name(id), `${k}: ${id} is a Sentinel-2 L2A name`);
  assert.ok(T.STATIONS[k], `${k} is a station`);
}
assert.equal(D.S2_SCENES.pole, undefined, "no Sentinel-2 over the pole");

// ------------------------------------------------------------ UTM
assert.deepEqual(D.utmOf(32743), { zone: 43, south: true, lon0: 75 });
assert.deepEqual(D.utmOf(32601), { zone: 1, south: false, lon0: -177 });
assert.equal(D.utmOf(3031), null);
assert.equal(D.utmOf(32761), null);
// each station in its own zone and in the zones either side, as a patch
// 128 km out reaches into them
for (const s of Object.values(T.STATIONS)) {
  if (s.lat < -85) continue;
  const z = Math.floor((s.lon + 180) / 6) + 1;
  for (const dz of [-1, 0, 1]) {
    const zone = ((z + dz + 59) % 60) + 1, u = D.utmOf(32700 + zone);
    for (const [dl, dp] of [[0, 0], [2.5, 1], [-3, -1.2]]) {
      const lon = s.lon + dl, lat = s.lat + dp;
      const want = proj4("EPSG:4326", `+proj=utm +zone=${zone} +south +datum=WGS84 +units=m +no_defs`, [lon, lat]);
      const got = D.utmForward(lon, lat, u);
      near(got[0], want[0], 1e-3, `${s.name} zone ${zone} easting`);
      near(got[1], want[1], 1e-3, `${s.name} zone ${zone} northing`);
    }
  }
}
// across the antimeridian, and nothing far from the zone
near(D.utmForward(-179.5, -77, D.utmOf(32760))[0], proj4("EPSG:4326", "+proj=utm +zone=60 +south +datum=WGS84", [-179.5, -77])[0], 1e-3, "across 180");
assert.equal(D.utmForward(100, -70, D.utmOf(32701)), null);

// ------------------------------------------------------------ sizes and levels
assert.equal(D.textureSize(1024), 256);
assert.equal(D.textureSize(5120), 1024);
assert.equal(D.textureSize(256000), 1024);
assert.equal(D.textureSize(100), 64);
const levels = [{ res: 10 }, { res: 20 }, { res: 40 }, { res: 80 }, { res: 160 }];
assert.equal(D.pickOverview(levels, 250).res, 160);
assert.equal(D.pickOverview(levels, 50).res, 40);
assert.equal(D.pickOverview(levels, 16).res, 20, "the 32 m patch's texels take the 20 m overview");
assert.equal(D.pickOverview(levels, 5).res, 10);
assert.equal(D.pickOverview(levels, 4).res, 10, "the finest when all are coarser");
assert.equal(D.pickOverview([...levels].reverse(), 80).res, 80);

// ------------------------------------------------------------ the warp
// An image in UTM zone 43S round Davis, 250 by 250 pixels of 25 m, its red
// its column and its green its row (so a texel says where it came from).
const st = T.STATIONS.davis, u = D.utmOf(32743), [sx, sy] = T.PS.forward(st.lon, st.lat);
const [E, Nn] = D.utmForward(st.lon, st.lat, u);
const IW = 250, IH = 250, RES = 25, ox = Math.round(E - 125 * RES), oy = Math.round(Nn + 125 * RES);
const img = new Uint8Array(3 * IW * IH);
for (let j = 0; j < IH; j++) for (let i = 0; i < IW; i++) { const k = 3 * (j * IW + i); img[k] = i; img[k + 1] = j; img[k + 2] = 200; }
// a patch round Davis, 4 km across in cells of 32 m, turned some 80 degrees
// in the image (polar stereographic north is towards 0 degrees east; the
// image is 6 km across)
const g = { x0: sx - 2000, y0: sy + 2000, dx: 32, dy: 32, w: 125, h: 125 };
const ax = T.patchAxes(g, { c0: 0, r0: 0, w: 125, h: 125 }), ext = D.cellExtent(ax);
near(ext.left, sx - 2000, 1e-6, "extent left"); near(ext.top, sy + 2000, 1e-6, "extent top");
near(ext.right, sx + 2000, 1e-6, "extent right"); near(ext.bottom, sy - 2000, 1e-6, "extent bottom");
const n = 256, L = D.utmLattice(ext, n, 16, { u, ox, oy, res: RES });
assert.equal(L.K, 16);
const win = D.latticeWindow(L, IW, IH);
assert.ok(win && win.c0 > 0 && win.r0 > 0 && win.c0 + win.w < IW && win.r0 + win.h < IH, "the window is inside the image");
const cut = new Uint8Array(3 * win.w * win.h);
for (let j = 0; j < win.h; j++) cut.set(img.subarray(3 * ((win.r0 + j) * IW + win.c0), 3 * ((win.r0 + j) * IW + win.c0 + win.w)), 3 * j * win.w);
const rgba = new Uint8Array(4 * n * n);
assert.equal(D.warpInto(rgba, L, { data: cut, w: win.w, h: win.h, c0: win.c0, r0: win.r0 }), n * n, "every texel filled");
let worst = 0;
const q = [0, 0];
for (let r = 0; r < n; r += 7)
  for (let c = 0; c < n; c += 5) {
    const x = ext.left + ((c + 0.5) * (ext.right - ext.left)) / n, y = ext.top - ((r + 0.5) * (ext.top - ext.bottom)) / n;
    const [lon, lat] = T.PS.inverse(x, y), p = D.utmForward(lon, lat, u, q);
    const ci = (p[0] - ox) / RES - 0.5, ri = (oy - p[1]) / RES - 0.5, o = 4 * (r * n + c);
    worst = Math.max(worst, Math.abs(rgba[o] - ci), Math.abs(rgba[o + 1] - ri));
    assert.equal(rgba[o + 2], 200); assert.equal(rgba[o + 3], 255);
  }
assert.ok(worst <= 0.51, `each texel from where it lies in the image, to the rounding: ${worst}`);

// where the image has nothing (0, 0, 0) a texel is left empty, or takes the
// nearest pixel that has something at the edge of it; a second image then
// fills only what is left
const holed = Uint8Array.from(cut);
for (let j = 0; j < win.h; j++) for (let i = 0; i < Math.floor(win.w / 2); i++) holed.fill(0, 3 * (j * win.w + i), 3 * (j * win.w + i) + 3);
const half = new Uint8Array(4 * n * n);
const got1 = D.warpInto(half, L, { data: holed, w: win.w, h: win.h, c0: win.c0, r0: win.r0 });
assert.ok(got1 > 0.4 * n * n && got1 < 0.6 * n * n, `about half filled: ${got1}`);
for (let k = 0; k < n * n; k++) if (half[4 * k + 3]) assert.ok(half[4 * k] >= win.c0 + Math.floor(win.w / 2) - 1, "filled only from pixels that have something");
const got2 = D.warpInto(half, L, { data: cut, w: win.w, h: win.h, c0: win.c0, r0: win.r0 });
assert.equal(got1 + got2, n * n, "the second image fills the rest and nothing twice");
// 0, 0, 0 inside the tile's outline is the darkest water, and counts
const dark = Uint8Array.from(cut);
for (let j = 0; j < win.h; j++) for (let i = 0; i < win.w; i++) if ((i + j) % 3 === 0) dark.fill(0, 3 * (j * win.w + i), 3 * (j * win.w + i) + 3);
const outline = D.fillRings([[[-1, -1], [win.w + 1, -1], [win.w + 1, win.h + 1], [-1, win.h + 1]]], win.w, win.h);
assert.equal(D.warpInto(new Uint8Array(4 * n * n), L, { data: dark, w: win.w, h: win.h, c0: win.c0, r0: win.r0, mask: outline }), n * n, "dark pixels inside the outline fill");
assert.ok(D.warpInto(new Uint8Array(4 * n * n), L, { data: dark, w: win.w, h: win.h, c0: win.c0, r0: win.r0 }) < n * n, "but without it some are left");
// the outline filled by rows: a triangle's pixel middles
{
  const m = D.fillRings([[[0, 0], [10.2, 0], [0, 10.2]]], 12, 12);
  let count = 0;
  for (let j = 0; j < 12; j++) for (let i = 0; i < 12; i++) {
    const inside = i + 0.5 + j + 0.5 < 10.2;
    assert.equal(m[j * 12 + i], inside ? 1 : 0, `pixel ${i}, ${j}`);
    count += inside;
  }
  assert.equal(count, 55, "pixels in the triangle");
  assert.equal(D.fillRings([[[0, 0], [10, 0], [0, 10]]], 4, 4).reduce((a, b) => a + b, 0), 16, "clipped to the window");
}
// nothing where the patch is off the image
const away = D.utmLattice(ext, n, 16, { u, ox: ox + 1e6, oy, res: RES });
assert.equal(D.latticeWindow(away, IW, IH), null);
assert.equal(D.warpInto(new Uint8Array(4 * n * n), away, { data: cut, w: win.w, h: win.h, c0: win.c0, r0: win.r0 }), 0);

// ------------------------------------------------------------ the fade
{
  const m = 64, full = () => { const a = new Uint8Array(4 * m * m); for (let k = 0; k < m * m; k++) a[4 * k + 3] = 255; return a; };
  const a = full(); D.feather(a, m, 8, false);
  for (let k = 0; k < m * m; k++) assert.equal(a[4 * k + 3], 255, "all there and the edges held: no fade");
  const b = full(); D.feather(b, m, 8, true);
  assert.ok(b[3] < 10, `the rim fades to nothing at the corner: ${b[3]}`);
  assert.ok(b[4 * (32 * m) + 3] < 60, "and at the middle of an edge");
  assert.equal(b[4 * (32 * m + 32) + 3], 255, "and not in the middle");
  // a gap: the alpha climbs away from it, and stays 0 in it
  const c = full();
  for (let r = 0; r < m; r++) for (let col = 0; col < 20; col++) c[4 * (r * m + col) + 3] = 0;
  D.feather(c, m, 8, false);
  const row = 4 * (32 * m);
  assert.equal(c[row + 4 * 10 + 3], 0);
  assert.ok(c[row + 4 * 20 + 3] < 40 && c[row + 4 * 24 + 3] > c[row + 4 * 20 + 3] && c[row + 4 * 40 + 3] === 255, "climbs from the gap");
}

// ------------------------------------------------------------ texture coordinates
{
  const uv = D.patchUv(ax, ext);
  near(uv[0], 0.5 / 125, 1e-6, "the first vertex at its cell's middle"); near(uv[1], 0.5 / 125, 1e-6, "from the top");
  const last = 2 * (125 * 125 - 1);
  near(uv[last], 1 - 0.5 / 125, 1e-6, "the last vertex"); near(uv[last + 1], 1 - 0.5 / 125, 1e-6, "at the bottom");
  // a finer patch in a coarser one's hole: its rim vertices take the
  // coordinates of where pinEdges puts them, on the coarse vertex lines (to
  // the millimetre: the coordinates are 32-bit)
  const P = T.patchAxes({ x0: sx - 4000, y0: sy + 4000, dx: 100, dy: 100, w: 80, h: 80 }, { c0: 0, r0: 0, w: 80, h: 80 });
  const C = T.patchAxes({ x0: sx - 1530, y0: sy + 1530, dx: 30, dy: 30, w: 102, h: 102 }, { c0: 0, r0: 0, w: 102, h: 102 });
  const hole = T.holeIn(P, C), box = D.rimBox(P, hole), ce = D.cellExtent(C), cu = D.patchUv(C, ce, box);
  const at = (k) => [ce.left + cu[2 * k] * (ce.right - ce.left), ce.top - cu[2 * k + 1] * (ce.top - ce.bottom)];
  const [x0, y0] = at(0);
  near(x0, P.xs[hole.i0], 1e-3, "the corner held to the rim, x"); near(y0, P.ys[hole.j0], 1e-3, "and y");
  const mid = 51 * 102 + 51, [xm, ym] = at(mid);
  near(xm, C.xs[51], 1e-3, "inside, where the vertex is"); near(ym, C.ys[51], 1e-3, "inside, y");
  for (let j = 0; j < 102; j++) {
    const [x] = at(j * 102 + 101);
    assert.ok(x <= box.X1 + 1e-3, "the east edge no further than the rim");
  }
}

// ------------------------------------------------------------ boxes and rings
{
  const bb = D.lonLatBox(ext);
  assert.ok(bb[0] < st.lon && st.lon < bb[2] && bb[1] < st.lat && st.lat < bb[3], "the box holds the station");
  assert.ok(bb[2] - bb[0] < 0.2 && bb[3] - bb[1] < 0.05, "and is about 4 km");
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.ok(D.inRing(ring, 5, 5)); assert.ok(!D.inRing(ring, 11, 5)); assert.ok(!D.inRing(ring, -1, -1));
}

console.log("drape: UTM matches proj4js to a millimetre, Sentinel-2's names, the warp from UTM onto a patch's grid, the fade from where there is nothing, and the texture coordinates of pinned vertices all agree");
