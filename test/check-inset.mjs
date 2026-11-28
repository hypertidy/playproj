// src/core/inset.js against PROJ (test/fixtures/inset-proj.json, from
// test/make-inset-fixture.py) and against d3-geo's geoAlbersUsa; then the
// frame numbers insets.html quotes, from data/insets-10m.json.
import fs from "fs";
import { geoAlbersUsa } from "d3-geo";
import * as I from "../src/core/inset.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/inset-proj.json", import.meta.url)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };

for (const [key, { spec, rows }] of Object.entries(fx)) {
  const g = I.crs(spec);
  let dxy = 0, dinv = 0, dk = 0, dom = 0;
  for (const [lon, lat, x, y, h, k, s, om] of rows) {
    const [X, Y] = g.forward(lon, lat), [l2, p2] = g.inverse(x, y);
    dxy = Math.max(dxy, Math.hypot(X - x, Y - y));
    dinv = Math.max(dinv, Math.hypot(I.wrap(l2 - lon) * Math.cos(lat * Math.PI / 180), p2 - lat) * 111320);
    const f = I.scaleAt(g, lon, lat);
    dk = Math.max(dk, Math.abs(f.h - h), Math.abs(f.k - k), Math.abs(f.s - s));
    dom = Math.max(dom, Math.abs(f.omega - om));
  }
  check(dxy < 2e-3, `${key}: projection off PROJ by ${dxy} m`);
  check(dinv < 2e-3, `${key}: inverse off by ${dinv} m`);
  check(dk < 1e-6, `${key}: scale factors off PROJ by ${dk}`);
  check(dom < 1e-3, `${key}: angular distortion off PROJ by ${dom} deg`);
  console.log(`${key.padEnd(6)} ${rows.length} points: xy ${dxy.toExponential(1)} m, inverse ${dinv.toExponential(1)} m, h/k/s ${dk.toExponential(1)}, omega ${dom.toExponential(1)} deg`);
}

// geoAlbersUsa: d3 at scale k puts lon/lat at translate + k * (x, -y) / R
const d3p = geoAlbersUsa(), k = d3p.scale(), [tx, ty] = d3p.translate(), P = I.albersUsaPieces();
let dd = 0, n = 0;
for (const [key, pts] of Object.entries({
  us48: [[-122.4, 37.8], [-74, 40.7], [-80.2, 25.8], [-97, 47]],
  alaska: [[-149.9, 61.2], [-147.7, 64.8], [-156.8, 71.3], [-134.4, 58.3]],
  hawaii: [[-157.8, 21.3], [-155.5, 19.6], [-159.5, 22.1]]
})) {
  const pl = I.placer(P[key]);
  for (const [lon, lat] of pts) {
    const d = d3p([lon, lat]), [X, Y] = pl.forward(lon, lat);
    dd = Math.max(dd, Math.hypot(tx + (k * X) / I.D3_R - d[0], ty - (k * Y) / I.D3_R - d[1]));
    const [l2, p2] = pl.inverse(X, Y);
    check(Math.hypot(l2 - lon, p2 - lat) < 1e-8, `albersUsa ${key} inverse at ${lon},${lat}`);
    n++;
  }
}
check(dd < 1e-6, `albersUsa pieces off d3-geo by ${dd} px`);
console.log(`albersUsa: ${n} points within ${dd.toExponential(1)} px of d3-geo`);

// the claims, over the land
const data = JSON.parse(fs.readFileSync(new URL("../data/insets-10m.json", import.meta.url)));
const pc = data.pieces;
const ak = I.groundArea(pc.alaska), us = I.groundArea(pc.us48), hi = I.groundArea(pc.hawaii);
check(ak > 1.4e12 && ak < 1.6e12, `Alaska ground area ${ak}`);
check(us > 7.7e12 && us < 8.2e12, `lower 48 ground area ${us}`);
check(hi > 1.5e10 && hi < 1.8e10, `Hawaii ground area ${hi}`);
const layout = (keys, mk) => I.frameStats(keys.map((key) => {
  const pl = mk(key), page = I.pagePiece(pl, pc[key]);
  return { key, page, ground: I.groundArea(pc[key]) };
}));
const d3s = layout(["us48", "alaska", "hawaii"], (key) => I.placer(P[key]));
check(Math.abs(d3s.pieces[1].linear - 0.35) < 0.03, `albersUsa Alaska linear ${d3s.pieces[1].linear}`);
const gs = I.crs({ proj: "gs50" }), truePl = (key) => I.placer({ crs: gs, anchor: [0, 0], at: gs.forward(0, 0) });
const fifty = layout(["us48", "alaska", "hawaii"], truePl), lower = layout(["us48"], truePl);
check(fifty.width > 7.8e6 && fifty.width < 8.4e6, `GS50 sheet width ${fifty.width}`);
check(fifty.mainShare > 0.4 && fifty.mainShare < 0.6, `GS50 lower 48 share ${fifty.mainShare}`);
console.log(`ground km2: lower 48 ${(us / 1e6).toFixed(0)}, Alaska ${(ak / 1e6).toFixed(0)}, Hawaii ${(hi / 1e6).toFixed(0)}`);
console.log(`albersUsa sheet fill ${(d3s.fill * 100).toFixed(0)}%, Alaska at ${d3s.pieces[1].linear.toFixed(3)} linear, ${(d3s.pieces[1].areal * 100).toFixed(1)}% area`);
console.log(`GS50 50 states: ${(fifty.width / 1e3).toFixed(0)} x ${(fifty.height / 1e3).toFixed(0)} km, fill ${(fifty.fill * 100).toFixed(0)}%, lower 48 share ${fifty.mainShare.toFixed(2)}; lower 48 alone fill ${(lower.fill * 100).toFixed(0)}%`);

// GS50 holds only where it was fitted: Puerto Rico is well outside 2 percent
const prs = [];
for (const r of pc.puertorico) for (let i = 0; i < r.length; i += 6) prs.push(I.scaleAt(gs, r[i], r[i + 1]).a);
check(Math.min(...prs) > 1.2 && Math.max(...prs) < 1.5, `GS50 over Puerto Rico ${Math.min(...prs)} to ${Math.max(...prs)}`);
// every scene places, and a true-place layout holds its pieces at s = 1 with no error
for (const [key, sc] of Object.entries(I.SCENES)) {
  const main = I.crs(sc.mains[sc.main].spec), cen = {};
  for (const k of Object.keys(sc.pieces)) { check(!!pc[k], `${key}: no land for ${k}`); cen[k] = I.centreOf(pc[k]); }
  const items = I.placeScene(key, {}, main, cen);
  for (const it of items) {
    const [lon, lat] = it.anchor, [X, Y] = it.placer.forward(lon, lat), [x, y] = main.forward(lon, lat);
    check(Math.hypot(X - x, Y - y) < 1e-6, `${key}/${it.key}: true place off by ${Math.hypot(X - x, Y - y)}`);
    const ins = I.placeScene(key, { [it.key]: { mode: "inset", s: 2, rot: 0, at: [1e5, 2e5] } }, main, cen).find((q) => q.key === it.key);
    if (!sc.pieces[it.key].main) {
      const p2 = ins.placer.inverse(...ins.placer.forward(lon, lat + 0.01));
      check(Math.hypot(I.wrap(p2[0] - lon), p2[1] - lat - 0.01) < 1e-7, `${key}/${it.key}: inset placer does not invert`);
      const A = I.affineOf(ins), [px, py] = ins.crs.forward(lon, lat), [qx, qy] = ins.placer.forward(lon, lat);
      check(Math.hypot(A[0] * px + A[1] * py + A[2] - qx, A[3] * px + A[4] * py + A[5] - qy) < 1e-3, `${key}/${it.key}: affine`);
    }
  }
}

if (fails) { console.log(`${fails} inset checks failed`); process.exit(1); }
console.log("inset ok");
