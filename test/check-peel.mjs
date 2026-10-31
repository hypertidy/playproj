// Peeling the orange (src/core/peel.js): each gore flattening against
// PROJ's sinu, cass and tmerc on the unit sphere (test/fixtures/peel-proj.json,
// made by test/make-peel-fixture.py), their inverses, what each keeps true,
// the peel's two ends (the orange and the flower), and the spiral's flat
// centre line against its curvature and the Euler spiral it tends to.
import fs from "fs";
import * as P from "../src/core/peel.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/peel-proj.json", import.meta.url)));
const D2R = Math.PI / 180;
let fails = 0;
const report = (ok, label, msg) => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(46)} ${msg}`); };

// forward and inverse against PROJ
for (const g of fx.gores) {
  const m = P.GORE_METHODS[g.proj];
  const i = Math.round(((g.lon0 + 180) * g.n) / 360 - 0.5);
  const lc = P.goreCentre(i, g.n);
  let worst = 0, back = 0;
  for (const [lon, lat, x, y] of g.pts) {
    const xy = m.forward(lon * D2R - lc, lat * D2R);
    worst = Math.max(worst, Math.hypot(xy[0] - x, xy[1] - y));
    const ll = m.inverse(xy[0], xy[1]);
    if (Math.abs(lat) < 89) back = Math.max(back, Math.abs(ll[0] - (lon * D2R - lc)), Math.abs(ll[1] - lat * D2R));
  }
  report(Math.abs(lc - g.lon0 * D2R) < 1e-12 && worst < 1e-9 && back < 1e-9, `${g.def}`, `vs PROJ ${worst.toExponential(1)}, inverse ${back.toExponential(1)}`);
}

// what each keeps: sinu area, tmerc angles, all the central meridian
for (const n of [6, 12, 24]) {
  const s = Object.fromEntries(P.METHOD_KEYS.map((k) => [k, P.goreStats(n, k)]));
  report(s.sinu.area < 1e-6 && Math.abs(s.sinu.areaRatio - 1) < 1e-6, `${n} gores: sinu keeps area`, `worst ${s.sinu.area.toExponential(1)}, gore ${s.sinu.areaRatio.toFixed(6)}`);
  report(s.tmerc.omega < 1e-3, `${n} gores: tmerc keeps angles`, `worst ${s.tmerc.omega.toExponential(1)} deg`);
  // Cassini is true across, so its biggest stretch is along the meridians,
  // sec(dl) at the edge on the equator: 1 / cos(pi / n) - 1
  const sec = 1 / Math.cos(Math.PI / n) - 1;
  report(Math.abs(s.cass.scale - sec) < 1e-4, `${n} gores: cass worst stretch is sec(w) - 1`, `${s.cass.scale.toFixed(5)} vs ${sec.toFixed(5)}`);
  // narrower gores: sinu's shear shrinks with the width, the others with its square
  const s2 = Object.fromEntries(P.METHOD_KEYS.map((k) => [k, P.goreStats(2 * n, k)]));
  const rs = s.sinu.omega / s2.sinu.omega, rc = s.cass.scale / s2.cass.scale;
  report(rs > 1.8 && rs < 2.2 && rc > 3.6 && rc < 4.4, `${n} to ${2 * n} gores: errors fall as w and w^2`, `sinu shear / ${rs.toFixed(2)}, cass stretch / ${rc.toFixed(2)}`);
}
for (const n of [12]) for (const k of P.METHOD_KEYS) {
  const g = P.goreGrid(n, k, { rows: 30, cols: 6, i: 5 });
  let cm = 0;
  for (let r = 0; r <= g.rows; r++) cm = Math.max(cm, Math.abs(g.x[r * (g.cols + 1) + 3]), Math.abs(g.y[r * (g.cols + 1) + 3] - g.lat[r * (g.cols + 1) + 3] * D2R));
  report(cm < 1e-12, `12 gores ${k}: central meridian true`, `${cm.toExponential(1)}`);
}

// the peel: p = 0 is the orange, p = 1 the flower flat on the table at y = -1
{
  let s0 = 0, s1 = 0;
  for (const k of P.METHOD_KEYS) for (const i of [0, 4, 11]) {
    const g = P.goreGrid(12, k, { rows: 24, cols: 4, i, lon0: 30 });
    for (let q = 0; q < g.x.length; q++) {
      const lam = g.lon[q] * D2R, phi = g.lat[q] * D2R;
      const a = P.peelGore(i, 12, 30, g.x[q], g.y[q], lam, phi, 0);
      const t = [Math.cos(phi) * Math.sin(lam), Math.sin(phi), Math.cos(phi) * Math.cos(lam)];
      s0 = Math.max(s0, Math.hypot(a[0] - t[0], a[1] - t[1], a[2] - t[2]));
      const b = P.peelGore(i, 12, 30, g.x[q], g.y[q], lam, phi, 1), f = P.layout("flower", i, 12, 30, g.x[q], g.y[q]);
      s1 = Math.max(s1, Math.abs(b[1] + 1), Math.hypot(b[0] - f[0], b[2] - f[1]));
    }
  }
  report(s0 < 1e-12 && s1 < 1e-12, "peel 0 is the orange, peel 1 the flower", `${s0.toExponential(1)}, ${s1.toExponential(1)}`);
}

// the spiral: the flat line's turning matches tan(latitude), its length is
// the sphere's area over the width, and it tends to the Euler spiral
for (const turns of [3, 6, 12, 30]) {
  const sp = P.spiral(turns), line = P.spiralLine(sp, 20000);
  let kerr = 0;
  for (let k = 1; k < line.length - 1; k++) {
    const a = line[k - 1], b = line[k + 1];
    if (Math.abs(line[k].th) > 1.2) continue;
    const dpsi = b.psi - a.psi, ds = Math.hypot(b.x - a.x, b.y - a.y);
    kerr = Math.max(kerr, Math.abs(dpsi / ds - Math.tan(line[k].th)));
  }
  const len = line.slice(1).reduce((s, q, k) => s + Math.hypot(q.x - line[k].x, q.y - line[k].y), 0);
  const fit = P.eulerFit(sp, line);
  report(kerr < 1e-3 && Math.abs(len / sp.length - 1) < 1e-4, `spiral, ${turns} turns: curvature tan(phi), length 4 pi / w`, `curvature ${kerr.toExponential(1)}, length ${len.toFixed(3)} of ${sp.length.toFixed(3)}`);
  console.log(`     Euler spiral within half a strip for ${(100 * fit.fraction).toFixed(0)}% of the length; sphere's own line ${(P.sphereLength(sp) / sp.length).toFixed(4)} of 4 pi / w`);
}
// Bartholdi and Henriques: scaled by sqrt(2 a), the middle of the peel
// approaches the Euler spiral; at T = 1 the gap shrinks as the strip narrows
{
  const gaps = [10, 40, 160].map((turns) => {
    const sp = P.spiral(turns), t = Math.sqrt(2 * sp.a), line = P.spiralLine(sp, 40000);
    const k = line.findIndex((s) => s.t >= t), e = P.eulerLine(sp, [line[k].t])[0];
    return Math.hypot(line[k].x - e[0], line[k].y - e[1]) / Math.sqrt(2 * sp.a);
  });
  report(gaps[0] > gaps[1] && gaps[1] > gaps[2] && gaps[2] < 1e-3, "spiral tends to the Euler spiral", gaps.map((g) => g.toExponential(1)).join(", "));
}

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log("all peel checks passed");
