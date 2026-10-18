// Distortion fields (js/distortion.js) and the float GeoTIFF they export:
//  1. a sampled grid holds exactly the pointwise factors (which
//     check-tissot.mjs ties to PROJ);
//  2. contour lines of a known surface fall where they should;
//  3. auto-sized indicatrices fit their lattice;
//  4. colour scales and contour levels behave on the classic cases
//     (Mercator conformal, Mollweide equal-area);
//  5. the float GeoTIFF reads back: bands, values, NaN, names.
import { inflateSync } from "zlib";
import proj4 from "proj4";
import { factors, proj4Forward } from "../js/tissot.js";
import * as D from "../js/distortion.js";
import { writeFloatGeoTIFF, esriGeoKeys, proj4Wkt } from "../js/geotiff-write.js";

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL", msg); } };
const R = 6371008.8;
const P = (def) => {
  const p = proj4Forward(proj4, `${def} +R=${R}`);
  p.raw = proj4Forward(proj4, `${def} +R=${R}`, { check: false }).fwd;
  return p;
};

// 1. grid == pointwise
{
  const p = P("+proj=moll");
  const e = { x0: -2.9, x1: 2.9, y0: -1.45, y1: 1.45 }, nx = 29, ny = 15;
  const get = D.FIELDS.map((d) => [d.key, d.get]);
  const g = D.sample(p.raw, D.mapCells(p.inv, e, nx, ny), nx, ny, get, { es: p.es });
  let n = 0, worst = 0, nan = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const ll = p.inv(e.x0 + ((i + 0.5) * (e.x1 - e.x0)) / nx, e.y1 - ((j + 0.5) * (e.y1 - e.y0)) / ny);
      if (!ll) { nan += Number.isNaN(g.s[j * nx + i]); continue; }
      const f = factors(p.raw, ll[0], ll[1]);
      for (const d of D.FIELDS) worst = Math.max(worst, Math.abs(g[d.key][j * nx + i] - d.get(f)) / Math.max(1, Math.abs(d.get(f))));
      n++;
    }
  }
  check(n > 250 && worst < 1e-6, `grid vs pointwise: ${n} cells, worst ${worst}`);
  check(nan > 0 && nan === nx * ny - n, "cells off the ellipse are NaN");
  const sc = D.colourScale("s", g.s);
  check(Math.abs(sc.lo - 1 / 1.01) < 1e-9 && Math.abs(sc.hi - 1.01) < 1e-9, `Mollweide areal scale clamps to 1%: ${sc.lo} ${sc.hi}`);
  check(D.levels(sc).length === 0, `Mollweide areal scale is constant, so no contours: ${D.levels(sc)}`);
  console.log(`distortion grid: ${n} Mollweide cells match factors() to ${worst.toExponential(1)}`);
}

// 2. contours of r^2 on a grid are circles
{
  const nx = 60, ny = 50, v = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) v[j * nx + i] = (i + 0.5 - 30) ** 2 + (j + 0.5 - 25) ** 2;
  v[0] = NaN;
  let worst = 0, segs = 0;
  for (const r of [5, 10, 20]) {
    const s = D.isolines(v, nx, ny, r * r, Math.sqrt);
    segs += s.length / 4;
    for (let k = 0; k < s.length; k += 2) worst = Math.max(worst, Math.abs(Math.hypot(s[k] - 30, s[k + 1] - 25) - r));
  }
  check(segs > 100 && worst < 0.02, `isolines of r: ${segs} segments, worst radius error ${worst}`);
  check(D.isolines(v, nx, ny, 1e6).length === 0, "no contour above the surface");
  console.log(`isolines: ${segs} segments on circles r = 5, 10, 20, worst ${worst.toExponential(1)}`);
}

// 3. auto size fits the lattice
for (const [def, step] of [["+proj=merc", 30], ["+proj=robin", 15], ["+proj=stere +lat_0=-90", 30]]) {
  const p = P(def);
  const pts = [];
  for (const [lon, lat] of D.graticuleLattice(step)) {
    const xy = p.fwd(lon, lat), f = xy && factors(p.raw, lon, lat);
    if (f && f.a < 50) { f.x = xy[0]; f.y = xy[1]; pts.push(f); }
  }
  for (const mode of ["true", "shape"]) {
    const r = D.autoRadius(pts, { fill: 0.8, mode });
    // the share of ellipses that overlap a neighbour
    let over = 0;
    for (const p1 of pts) {
      const R1 = p1.a * D.sizeFactor(p1, mode) * r;
      if (pts.some((p2) => p2 !== p1 && Math.hypot(p2.x - p1.x, p2.y - p1.y) < R1 + p2.a * D.sizeFactor(p2, mode) * r)) over++;
    }
    check(r > 0 && over / pts.length < 0.35, `${def} ${mode}: r ${r}, ${over} of ${pts.length} touch a neighbour`);
  }
}
// Mercator on a lon/lat lattice: neighbours along a parallel stay the same
// distance apart on the map while the scale grows as sec(lat), so the fit
// is set by the 60 degree rows (the 20% quantile): half the equator's
{
  const p = P("+proj=merc"), pts = [];
  for (const [lon, lat] of D.graticuleLattice(30)) {
    const xy = p.fwd(lon, lat), f = factors(p.raw, lon, lat);
    f.x = xy[0]; f.y = xy[1]; pts.push(f);
  }
  const r = D.autoRadius(pts, { fill: 0.8 });
  check(Math.abs(r - 0.8 * (30 * Math.PI / 180) / 2 * 0.5) < 1e-6, `Mercator auto radius fits the 60 degree rows: ${r}`);
}

// 4. scales and levels
{
  const p = P("+proj=merc"), vals = [], om = [];
  for (let lat = -80; lat <= 80; lat += 2) for (let lon = -170; lon <= 170; lon += 20) {
    const f = factors(p.raw, lon, lat);
    vals.push(f.s); om.push(f.omega);
  }
  const sc = D.colourScale("s", vals), lv = D.levels(sc);
  check(sc.hi > 20 && lv.includes(2) && lv.includes(10) && lv.length <= 9, `Mercator areal levels ${lv}`);
  check(sc.rgb(1).join() === "27,38,56", "true scale is the neutral colour");
  const so = D.colourScale("omega", om);
  check(so.hi === 0.5 && D.levels(so).length <= 3, `Mercator omega stays near zero: hi ${so.hi}`);
  const sm = D.summarise(vals.map((s, i) => [0, -80 + 2 * Math.floor(i / 18), { s, omega: om[i], h: Math.sqrt(s), k: Math.sqrt(s) }]));
  check(Math.abs(sm.s.min - 1) < 1e-9 && sm.s.max > 30 && sm.s.mean > 1 && sm.s.mean < sm.s.max, `summary ${JSON.stringify(sm.s)}`);
  const conv = D.colourScale("conv", [-40, -10, 0, 10, 35]);
  const lc = D.levels(conv);
  check(lc.includes(0) && lc.length <= 9 && lc.every((v) => Math.abs(v) < conv.hi), `convergence levels ${lc}`);
}

// 5. float GeoTIFF
{
  const w = 7, h = 5;
  const bands = [0, 1].map((b) => Float32Array.from({ length: w * h }, (_, i) => (i === 3 ? NaN : b * 100 + i * 0.5)));
  const def = "+proj=moll +R=6371008.8";
  const blob = await writeFloatGeoTIFF({
    width: w, height: h, bands, names: ["areal_scale", "angular_distortion"],
    origin: [-1000, 500], pixelSize: [10, 20], geoKeys: esriGeoKeys(proj4Wkt("moll", def, R), R, def)
  });
  const buf = Buffer.from(await blob.arrayBuffer()), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ifd = dv.getUint32(4, true), nt = dv.getUint16(ifd, true), tags = {};
  const SIZE = { 2: 1, 3: 2, 4: 4, 12: 8 };
  for (let t = 0; t < nt; t++) {
    const e = ifd + 2 + 12 * t, tag = dv.getUint16(e, true), type = dv.getUint16(e + 2, true), n = dv.getUint32(e + 4, true);
    const at = n * SIZE[type] <= 4 ? e + 8 : dv.getUint32(e + 8, true);
    const vals = [];
    for (let k = 0; k < n; k++) {
      const o = at + k * SIZE[type];
      vals.push(type === 2 ? buf[o] : type === 3 ? dv.getUint16(o, true) : type === 4 ? dv.getUint32(o, true) : dv.getFloat64(o, true));
    }
    tags[tag] = type === 2 ? String.fromCharCode(...vals) : vals;
  }
  check(tags[277][0] === 2 && tags[284][0] === 2 && tags[339].join() === "3,3" && tags[258].join() === "32,32", "float32, two planes");
  check(tags[42113].startsWith("nan") && tags[42112].includes("angular_distortion"), "nodata and band names");
  check(tags[33922][3] === -1000 && tags[33550][1] === 20, "georeferencing");
  const per = tags[273].length / 2;
  const plane = (b) => {
    const parts = [];
    for (let k = 0; k < per; k++) parts.push(inflateSync(buf.subarray(tags[273][b * per + k], tags[273][b * per + k] + tags[279][b * per + k])));
    const c = Buffer.concat(parts);
    return new Float32Array(c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength));
  };
  const b1 = plane(1);
  check(Number.isNaN(b1[3]) && b1[4] === 102 && b1[w * h - 1] === 100 + (w * h - 1) * 0.5, "band 2 values");
  console.log("float GeoTIFF: two named float32 planes read back");
}

console.log(fails ? `distortion: ${fails} failing` : "distortion: all checks pass");
if (fails) process.exit(1);
