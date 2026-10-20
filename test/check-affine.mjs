// Affine maths: the geotransform's inverse, its parts, extent and world
// file forms go there and back, and each fit recovers a known geotransform
// from the fewest points it needs (and fits extra noisy points in the least
// squares sense), refusing points that cannot pin it down.
// Run with: node test/check-affine.mjs
import * as A from "../src/core/affine.js";

let fails = 0;
const check = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); };
const gtErr = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i]) / Math.max(1, Math.abs(b[i]))));

const northUp = A.fromExtent([-180, 180, -90, 90], 960, 480);
check(gtErr(northUp, [-180, 0.375, 0, 90, 0, -0.375]) < 1e-15, `fromExtent: world at 960 x 480 is ${northUp.join(", ")}`);
check(A.isNorthUp(northUp) && gtErr(A.extent(northUp, 960, 480), [-180, 180, -90, 90]) < 1e-15, "north up, and its extent comes back");

const crooked = A.fromParts({ x0: -200, y0: 110, w: 0.4, h: 0.38, rot: 7, shear: -4 });
const parts = A.toParts(crooked);
check(Math.abs(parts.rot - 7) < 1e-12 && Math.abs(parts.shear + 4) < 1e-12 && Math.abs(parts.w - 0.4) < 1e-15 && Math.abs(parts.h - 0.38) < 1e-15,
  `toParts(fromParts) rot ${parts.rot.toFixed(9)} shear ${parts.shear.toFixed(9)} w ${parts.w} h ${parts.h.toFixed(12)}`);
// rotating clockwise: the top edge heads down to the right on the map
const [tr] = [A.apply(crooked, 1000, 0)];
check(tr[1] < 110 && !A.isNorthUp(crooked), `rot 7 turns clockwise: top-right y ${tr[1].toFixed(2)} below top-left 110`);

for (const [name, gt] of [["north up", northUp], ["crooked", crooked]]) {
  const inv = A.invert(gt);
  let e = 0;
  for (const [c, r] of [[0, 0], [123.5, 77.25], [959, 479], [-40, 600]]) {
    const [x, y] = A.apply(gt, c, r), [c2, r2] = A.apply(inv, x, y);
    e = Math.max(e, Math.hypot(c2 - c, r2 - r));
  }
  check(e < 1e-9, `${name}: invert takes x, y back to col, row (${e.toExponential(1)} px)`);
  const wf = A.worldFile(gt), back = A.fromWorldFile(A.worldFileText(gt));
  check(gtErr(back, gt) < 1e-11, `${name}: world file ${wf.map((v) => +v.toFixed(4)).join(" ")} reads back`);
}
// the world file names the centre of the top-left pixel
const wf = A.worldFile(northUp);
check(wf[4] === -179.8125 && wf[5] === 89.8125, `world file C, F is the top-left pixel centre (${wf[4]}, ${wf[5]})`);
check(A.invert([0, 1, 2, 0, 2, 4]) === null, "invert refuses pixels with no area");

// compose: an image drawn from another through a pixel affine m has
// geotransform gt after the inverse of m
const m = A.fromParts({ x0: 30, y0: -12, w: 1.02, h: -0.98, rot: 3, shear: 1 }), mi = A.invert(m);
const g2 = A.compose(northUp, mi);
let ce = 0;
for (const [c, r] of [[0, 0], [300, 200], [960, 480]]) {
  const [c2, r2] = A.apply(m, c, r), a = A.apply(northUp, c, r), b = A.apply(g2, c2, r2);
  ce = Math.max(ce, Math.hypot(a[0] - b[0], a[1] - b[1]));
}
check(ce < 1e-9, `compose: the same place through the drawn image (${ce.toExponential(1)})`);

// fits: exact from the fewest points
const pts = (gt, cr) => cr.map(([col, row]) => { const [x, y] = A.apply(gt, col, row); return { col, row, x, y }; });
const sim = A.fromParts({ x0: -190, y0: 95, w: 0.39, h: 0.39, rot: -12 });
const cases = [
  ["northup", northUp, [[480, 240], [720, 80]]],
  ["similarity", sim, [[100, 400], [800, 50]]],
  ["affine", crooked, [[10, 10], [900, 30], [400, 450]]]
];
for (const [kind, gt, cr] of cases) {
  const f = A.fit(pts(gt, cr), kind);
  check(!f.error && gtErr(f.gt, gt) < 1e-9 && f.rmse < 1e-9, `fit ${kind} from ${cr.length} points recovers it (${f.error || gtErr(f.gt, gt).toExponential(1)})`);
  const few = A.fit(pts(gt, cr.slice(0, -1)), kind);
  check(!!few.error, `fit ${kind} from ${cr.length - 1}: "${few.error}"`);
}
check(!!A.fit(pts(northUp, [[100, 50], [100, 300]]), "northup").error, "north up refuses two points in the same column");
check(!!A.fit(pts(crooked, [[0, 0], [100, 100], [300, 300]]), "affine").error, "affine refuses three points in a line");
check(!!A.fit(pts(sim, [[5, 5], [5, 5]]), "similarity").error, "similarity refuses two points in the same place");

// least squares: noisy points, the fit is near and its residuals are the noise's size
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
for (const [kind, gt] of [["northup", northUp], ["similarity", sim], ["affine", crooked]]) {
  const P = pts(gt, Array.from({ length: 12 }, (_, i) => [37 + 71 * i, 20 + ((i * 113) % 440)]));
  for (const p of P) { p.x += 0.05 * rand(); p.y += 0.05 * rand(); }
  const f = A.fit(P, kind), centre = A.apply(f.gt, 480, 240), truth = A.apply(gt, 480, 240);
  check(f.rmse > 0.005 && f.rmse < 0.05 && Math.hypot(centre[0] - truth[0], centre[1] - truth[1]) < 0.02,
    `fit ${kind} to 12 noisy points: rmse ${f.rmse.toFixed(4)}, centre off by ${Math.hypot(centre[0] - truth[0], centre[1] - truth[1]).toFixed(4)}`);
}
// a full affine fitted to similarity points finds the similarity
const fs = A.fit(pts(sim, [[0, 0], [500, 30], [200, 400], [900, 450]]), "affine");
check(gtErr(fs.gt, sim) < 1e-9, "affine fit to rotated square pixels finds no shear");

console.log(fails ? `\n${fails} failed` : "\nall ok");
process.exit(fails ? 1 : 0);
