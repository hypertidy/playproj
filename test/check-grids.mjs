// Model grids: rotated pole (ob_tran) and the tripolar cap against PROJ, in
// test/fixtures/grids-proj.json, and the properties each grid is built for.
import fs from "fs";
import proj4 from "proj4";
import * as g from "../js/grids.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/grids-proj.json", import.meta.url)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };
const dLon = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
const near = (a, b, tol) => Math.abs(a[1] - b[1]) < tol && (Math.abs(a[1]) > 89.99999 || dLon(a[0], b[0]) < tol);

// ob_tran, forward and inverse
let worst = 0;
for (const c of fx.obtran) {
  const ob = g.obTran(c);
  for (const [lon, lat, rl, rp] of c.pts) {
    const f = ob.forward(lon, lat), b = ob.inverse(rl, rp);
    worst = Math.max(worst, Math.abs(f[1] - rp), Math.abs(rp) > 89.99999 ? 0 : dLon(f[0], rl));
    check(near(f, [rl, rp], 1e-8), `ob_tran ${c.proj} at ${lon},${lat}: ${f} vs ${rl},${rp}`);
    check(near(b, [lon, lat], 1e-8), `ob_tran inverse ${c.proj} at ${rl},${rp}: ${b} vs ${lon},${lat}`);
  }
}
// CF to PROJ: EURO-CORDEX's pole is the first fixture
const cf = g.cfToObTran(g.EURO_CORDEX.plon, g.EURO_CORDEX.plat);
check(cf.oLatP === 39.25 && cf.lon0 === 18, `CF EURO-CORDEX -> ${JSON.stringify(cf)}`);

// tripolar cap vs PROJ stereographic out and back
for (const c of fx.cap) {
  const R = Math.tan(((90 - c.join) * Math.PI / 180) / 2);
  for (const [lon, lat, rl, rp] of c.pts) {
    const p = g.auxToCap(R, lon, lat);
    worst = Math.max(worst, Math.abs(p[1] - rp));
    check(near(p, [rl, rp], 1e-8), `cap join ${c.join} at ${lon},${lat}: ${p} vs ${rl},${rp}`);
  }
}

// every grid: index -> lon/lat -> index round trips
const grids = [
  g.rotatedPole({ step: 10 }), g.rotatedPole({ plon: 30, plat: 10, step: 5 }),
  g.tripolar({ step: 10 }), g.tripolar({ plon: 40, join: 55, step: 5 }),
  g.cubedSphere({ n: 8 }), g.cubedSphere({ n: 8, stretch: "plain" }), g.yinYang({ step: 10 })
];
let rt = 0;
for (const gr of grids)
  for (const p of gr.patches)
    for (let a = 0.03; a < 1; a += 0.0617)
      for (let b = 0.03; b < 1; b += 0.0617) {
        const ll = p.fromIndex(a, b), uv = p.toIndex(...ll);
        const e = uv ? Math.hypot(uv[0] - a, uv[1] - b) : Infinity;
        rt = Math.max(rt, e);
        check(e < 1e-9, `${gr.kind} ${p.name} round trip at ${a.toFixed(3)},${b.toFixed(3)}: ${uv}`);
      }

// tripolar: orthogonal everywhere, continuous at the join, folded at the top,
// with its northern poles on the join
for (const tp of [g.tripolar({ step: 10 }), g.tripolar({ plon: 40, join: 55, step: 5 })]) {
  const p = tp.patches[0];
  let ang = 0;
  for (let j = 0; j < p.nj; j++) for (let i = 0; i < p.ni; i++) ang = Math.max(ang, Math.abs(g.cellAngle(p, i, j) - 90));
  check(ang < 0.01, `tripolar not orthogonal: ${ang} deg`);
  const vJ = tp.nS / p.nj, eps = 1e-9;
  for (let u = 0.01; u < 1; u += 0.037) {
    check(near(p.fromIndex(u, vJ - eps), p.fromIndex(u, vJ + eps), 1e-6), `tripolar join at u=${u}`);
    check(near(p.fromIndex(u, 1), p.fromIndex(1 - u, 1), 1e-9), `tripolar fold at u=${u}`);
  }
  check(near(p.fromIndex(0.5, vJ + 0.5 / p.nj), tp.poles[0], 1e-9), "tripolar pole on the join (east)");
  check(near(p.fromIndex(0, 0.99), tp.poles[1], 1e-9), "tripolar pole on the join (west)");
  console.log(`tripolar join ${tp.poles[0][1]}: worst corner angle off 90 by ${ang.toExponential(2)} deg`);
}

// cubed sphere: equiangular faces are symmetric and cover the sphere equally
const cube = g.cubedSphere({ n: 4 });
const area = cube.patches.reduce((s, p) => {
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) s += g.quadArea(g.cellCorners(p, i, j));
  return s;
}, 0);
check(Math.abs(area - 4 * Math.PI) < 1e-9, `cube cells sum to ${area}, not 4 pi`);
// each equiangular face is PROJ's gnomonic, read as angles
let gw = 0;
cube.patches.forEach((p, f) => {
  const pr = proj4("+proj=longlat +R=1", g.cubeFaceProj(f) + " +R=1 +x_0=0 +y_0=0");
  for (let a = 0.05; a < 1; a += 0.1) for (let b = 0.05; b < 1; b += 0.1) {
    const [x, y] = pr.forward(p.fromIndex(a, b));
    const e = Math.hypot((Math.atan(x) * 180 / Math.PI + 45) / 90 - a, (Math.atan(y) * 180 / Math.PI + 45) / 90 - b);
    gw = Math.max(gw, e);
    check(e < 1e-9, `cube face ${f} vs ${g.cubeFaceProj(f)} at ${a},${b}: ${e}`);
  }
});
console.log(`cubed sphere faces vs proj4js gnom: worst ${gw.toExponential(2)}`);
// Yin-Yang overlap: every point is on one patch or the other
const yy = g.yinYang({ step: 10 });
let miss = 0;
for (let lat = -89; lat < 90; lat += 4) for (let lon = -179; lon < 180; lon += 4) {
  const on = yy.patches.some((p) => { const uv = p.toIndex(lon, lat); return uv && uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1; });
  if (!on) miss++;
}
check(miss === 0, `Yin-Yang misses ${miss} points`);

console.log(`model grids vs ${fx.source}: worst ${worst.toExponential(2)} deg; round trips worst ${rt.toExponential(2)}; ${fails} failing`);
process.exit(fails ? 1 : 0);
