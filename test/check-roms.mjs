// The s-coordinate against a NumPy port of ROMS set_scoord/set_depth, the
// Zarr grid reader against stores written by zarr-python
// (test/make-roms-fixture.py), and the grids' own inverses and smoothing.
import fs from "fs";
import * as R from "../js/roms.js";

const dir = new URL("./fixtures/roms/", import.meta.url);
const fx = JSON.parse(fs.readFileSync(new URL("manifest.json", dir)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };

for (const c of fx.depth) {
  const v = { vt: c.vt, vs: c.vs, ts: c.ts, tb: c.tb, hc: c.hc };
  for (let k = 0; k <= c.N; k++) {
    const z = R.depth(R.sW(k, c.N), c.h, v, c.zeta);
    check(Math.abs(z - c.z_w[k]) < 1e-9 * Math.max(1, c.h), `depth ${JSON.stringify(v)} h ${c.h} k ${k}: ${z} vs ${c.z_w[k]}`);
  }
}

for (const ver of ["v2", "v3"]) {
  const base = new URL(`grid-${ver}.zarr/`, dir);
  const get = async (p) => {
    const f = new URL(p, base);
    return fs.existsSync(f) && fs.statSync(f).isFile() ? new Uint8Array(fs.readFileSync(f)).buffer : null;
  };
  const g = await R.readRomsZarr(get);
  const [ny, nx] = fx.grid.shape;
  check(g.ni === nx - 1 && g.nj === ny - 1, `${ver} size ${g.ni}x${g.nj}`);
  for (const [j, i, lon, lat, h, m] of fx.grid.samples) {
    const k = j * nx + i;
    check(Math.abs(g.lon[k] - lon) < 1e-12 && Math.abs(g.lat[k] - lat) < 1e-12, `${ver} lon/lat at ${j},${i}`);
    check(Math.abs(g.h[k] - h) < 1e-12 && g.mask[k] === m, `${ver} h/mask at ${j},${i}: ${g.h[k]} ${g.mask[k]}`);
  }
  const v = fx.grid.vertical;
  check(g.vertical.vt === v.Vtransform && g.vertical.vs === v.Vstretching && g.vertical.ts === v.theta_s &&
    g.vertical.tb === v.theta_b && g.vertical.hc === v.hc && g.vertical.N === fx.grid.N, `${ver} vertical ${JSON.stringify(g.vertical)}`);
  // subsampled: the corners stay
  const s = await R.readRomsZarr(get, { maxCells: 6 });
  check(s.ni <= 7 && s.lon[s.ni] === g.lon[nx - 1] && s.lat[s.lon.length - 1] === g.lat[g.lat.length - 1], `${ver} subsample corners`);
}

// the grids' inverses
for (const g of [R.southernOcean({ ni: 72 }), R.fan({ ni: 40 })]) {
  let worst = 0;
  for (const [u, v] of [[0.1, 0.2], [0.5, 0.5], [0.93, 0.77], [0.3, 0.05]]) {
    const [lon, lat] = g.fromIndex(u, v), b = g.toIndex(lon, lat);
    worst = Math.max(worst, Math.abs(b[0] - u), Math.abs(b[1] - v));
  }
  check(worst < 1e-9, `${g.kind} toIndex(fromIndex) ${worst}`);
  // conformal: cells square at the middle of the array
  const W = g.ni + 1, k = (g.nj >> 1) * W + (g.ni >> 1);
  const dx = R.arcKm(g, k, k + 1), dy = R.arcKm(g, k, k + W);
  check(Math.abs(dx / dy - 1) < 0.03, `${g.kind} cell aspect ${dx / dy}`);
}

// smoothing reaches the target and only deepens
{
  const g = R.fan({ ni: 30 });
  const { h, mask } = R.bathymetry(g, (lon, lat) => R.idealElevation(g, lon, lat));
  const hs = R.smoothRx0(g, h, mask, 0.2);
  check(R.rx0(g, hs, mask) <= 0.2 + 1e-9, `smoothed rx0 ${R.rx0(g, hs, mask)}`);
  check(hs.every((x, k) => x >= h[k] - 1e-9), "smoothing only deepens");
  check(R.rx0(g, h, mask) > 0.2, "idealized fan is steep before smoothing");
}

if (fails) { console.log(`${fails} roms checks failed`); process.exit(1); }
console.log("roms: s-coordinate, Zarr grid reader, inverses and smoothing match");
