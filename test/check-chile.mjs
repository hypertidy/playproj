// The grids of chile.html (src/core/chile.js) against PROJ
// (test/fixtures/chile-proj.json, from test/make-chile-fixture.py):
// eastings and northings, inverses, and PROJ's scale factors h, k, s and
// omega, over mainland Chile; then the land sample and the claims the page
// makes about each grid.
import fs from "fs";
import * as C from "../src/core/chile.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/chile-proj.json", import.meta.url)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };

const KIND = { aea6: "aea" };
for (const [key, { params, rows }] of Object.entries(fx.grids)) {
  const g = C.build(KIND[key] || key, params);
  let dxy = 0, dinv = 0, dk = 0, dom = 0;
  for (const [lon, lat, x, y, h, k, s, om] of rows) {
    const [X, Y] = g.forward(lon, lat), [l2, p2] = g.inverse(x, y);
    dxy = Math.max(dxy, Math.hypot(X - x, Y - y));
    dinv = Math.max(dinv, Math.hypot((l2 - lon) * Math.cos(lat * Math.PI / 180), p2 - lat) * 111320);
    const f = C.scaleAt(g, lon, lat);
    dk = Math.max(dk, Math.abs(f.h - h), Math.abs(f.k - k), Math.abs(f.s - s));
    dom = Math.max(dom, Math.abs(f.omega - om));
  }
  // mgrs.js's transverse Mercator is on WGS84, a tenth of a millimetre from GRS80 here
  check(dxy < 2e-3, `${key}: projection off PROJ by ${dxy} m`);
  check(dinv < 2e-3, `${key}: inverse off by ${dinv} m`);
  check(dk < 1e-7, `${key}: scale factors off PROJ by ${dk}`);
  check(dom < 1e-4, `${key}: angular distortion off PROJ by ${dom} deg`);
  console.log(`${key.padEnd(7)} ${rows.length} points: xy ${dxy.toExponential(1)} m, inverse ${dinv.toExponential(1)} m, h/k/s ${dk.toExponential(1)}, omega ${dom.toExponential(1)} deg`);
}

// the land, and what the page says about each grid over it
const land = JSON.parse(fs.readFileSync(new URL("../data/chile-50m.json", import.meta.url)));
const chl = land.find((c) => c.abbr === "CHL");
const pts = C.landSample(chl.rings, 0.1, [-76, -56.5, -66, -17]);
check(pts.length / 2 > 6000 && pts.length / 2 < 9000, `land sample has ${pts.length / 2} points`);
const st = (kind, p = {}) => C.landStats(C.build(kind, p), pts, 1266);
const u18 = st("utm18"), u19 = st("utm19"), tm71 = st("tm", { lon0: -71, kppm: 0 });
const gist = st("aea", { lon0: -73, lat0: -73, lat1: -56, lat2: -17 }), six = st("aea", { lon0: -71, lat0: -37, lat1: -24, lat2: -50 });
const az = st("laea", { lon0: -71, lat0: -37 }), cone = st("lcc", { lon0: -71, lat0: -37, lat1: -24, lat2: -50 });
check(u18.aMax > 1.007 && u18.aMax < 1.009, `UTM 18S largest scale ${u18.aMax}`);
check(u19.aMax > 1.002 && u19.aMax < 1.004, `UTM 19S largest scale ${u19.aMax}`);
check(tm71.aMax < 1.0025 && tm71.bMin >= 1 - 1e-9, `TM 71W scale ${tm71.bMin} to ${tm71.aMax}`);
for (const [n, r] of [["gist aea", gist], ["aea 1/6", six], ["laea", az]]) check(Math.abs(r.sMin - 1) < 1e-8 && Math.abs(r.sMax - 1) < 1e-8, `${n} not equal-area: ${r.sMin} to ${r.sMax}`);
check(gist.omegaMax > 6 && gist.omegaMax < 7.5, `gist aea omega ${gist.omegaMax}`);
check(six.omegaMax < gist.omegaMax && az.omegaMax < six.omegaMax && az.omegaMax < 2, `omega order: ${gist.omegaMax}, ${six.omegaMax}, ${az.omegaMax}`);
check(cone.sMax > 1.05 && u18.omegaMax < 1e-4, `LCC area ${cone.sMax}, UTM omega ${u18.omegaMax}`);
check(C.utmZone(-72.5) === 18 && C.utmZone(-70.67) === 19 && C.utmZone(-109.4) === 12, "UTM zones");
console.log(`land: ${pts.length / 2} points; cell error m2 (1266 m cells) UTM 18S ${u18.eMin.toFixed(0)}..${u18.eMax.toFixed(0)}, 19S ${u19.eMin.toFixed(0)}..${u19.eMax.toFixed(0)}, TM 71W ${tm71.eMin.toFixed(0)}..${tm71.eMax.toFixed(0)}`);
console.log(`omega max: gist aea ${gist.omegaMax.toFixed(2)}, aea 1/6 ${six.omegaMax.toFixed(2)}, laea ${az.omegaMax.toFixed(2)} deg`);

if (fails) { console.log(`${fails} chile checks failed`); process.exit(1); }
console.log("chile ok");
