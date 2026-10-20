// Orthorectification (src/core/ortho.js): the sensor models invert their
// own rays, relief displacement is (h - z) tan(theta), and an image
// orthorectified with the true DEM matches the map it was taken of, while
// one rectified onto a flat datum does not.
import * as O from "../src/core/ortho.js";

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };
const n = 128;

// colour difference between two RGBA images over cells both have
function diff(a, b, skip) {
  let s = 0, c = 0;
  for (let k = 0; k < a.length / 4; k++) {
    if (skip && skip[k]) continue;
    if (!a[4 * k + 3] || !b[4 * k + 3]) continue;
    for (let q = 0; q < 3; q++) s += Math.abs(a[4 * k + q] - b[4 * k + q]);
    c++;
  }
  return { mean: s / (3 * c), cover: c / (a.length / 4) };
}

for (const kind of ["frame", "push"]) {
  for (const [tilt, az] of [[0, 0], [25, 60], [40, 200]]) {
    const dem = O.makeTerrain("hills", 1);
    const cam = O.makeSensor(kind, { alt: 5000, tilt, az, fov: 70, n });
    const tag = `${kind} tilt ${tilt} az ${az}`;

    // ray then project returns the pixel; ground point then ray hits it
    let worst = 0;
    for (const [u, v] of [[10.5, 20.5], [64, 64], [120.25, 3.75], [1, 127]]) {
      const { o, d } = cam.ray(u, v);
      const P = O.intersect(dem.height, dem.top, o, d);
      if (!P) { check(false, `${tag}: ray ${u},${v} misses the ground`); continue; }
      const q = cam.project(P);
      worst = Math.max(worst, Math.hypot(q[0] - u, q[1] - v));
      check(Math.abs(P[2] - dem.height(P[0], P[1])) < 0.01, `${tag}: hit is off the ground by ${P[2] - dem.height(P[0], P[1])}`);
    }
    check(worst < 1e-6, `${tag}: project(ray) off by ${worst} px`);

    // relief displacement onto the datum is h tan(theta)
    for (const [x, y] of [[1200, -1800], [-2200, 1500], [300, 400]]) {
      const P = [x, y, dem.height(x, y)];
      const { theta, Q, shift } = O.displacement(cam, P, () => 0);
      check(Math.abs(shift - P[2] * Math.tan(theta)) < 1e-6, `${tag}: shift ${shift} is not h tan(theta) ${P[2] * Math.tan(theta)}`);
      // the datum point Q and P lie on one ray: same pixel
      const a = cam.project(P), b = cam.project(Q);
      check(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6, `${tag}: P and its datum point are not one pixel`);
      if (kind === "push") check(Math.abs(cam.row(P) - cam.row([x, y, 0])) < 1e-9, `${tag}: relief moved a point along the track`);
      if (kind === "frame" && tilt === 0) {
        // vertical photo: radially away from the nadir, by D h / (H - h)
        const D = Math.hypot(x - cam.nadir[0], y - cam.nadir[1]);
        check(Math.abs(shift - (D * P[2]) / (cam.alt - P[2])) < 1e-6, `${tag}: shift is not D h / (H - h)`);
        const rq = Math.hypot(Q[0] - cam.nadir[0], Q[1] - cam.nadir[1]);
        check(Math.abs(rq - D - shift) < 1e-6, `${tag}: shift is not radial`);
      }
    }

    // orthorectified with the true DEM matches the truth; flat does not
    const t0 = Date.now();
    const raw = O.renderRaw(dem, cam);
    const truth = O.renderTruth(dem, n);
    const good = O.orthorectify(raw, cam, dem.height, n, { occlusion: dem });
    const flat = O.orthorectify(raw, cam, () => 0, n);
    const dg = diff(good.px, truth, good.hidden), df = diff(flat.px, truth);
    check(dg.mean < 12, `${tag}: true-DEM ortho differs from the truth by ${dg.mean.toFixed(1)}`);
    check(df.mean > 1.5 * dg.mean, `${tag}: flat rectification (${df.mean.toFixed(1)}) not worse than true DEM (${dg.mean.toFixed(1)})`);
    console.log(`${tag}: ortho ${dg.mean.toFixed(1)} vs flat ${df.mean.toFixed(1)} (cover ${dg.cover.toFixed(2)}), ${Date.now() - t0} ms`);
  }
}

// a tilted view of the spires hides ground behind them
{
  const dem = O.makeTerrain("spires", 1);
  const cam = O.frameCamera({ alt: 4000, tilt: 40, az: 0, fov: 70, n });
  const raw = O.renderRaw(dem, cam);
  const { hidden } = O.orthorectify(raw, cam, dem.height, n, { occlusion: dem });
  const h = hidden.reduce((s, v) => s + v, 0);
  check(h > 20, `only ${h} cells hidden behind the spires`);
  const flatDem = O.makeTerrain("flat", 1);
  const none = O.orthorectify(O.renderRaw(flatDem, cam), cam, flatDem.height, n, { occlusion: flatDem }).hidden.reduce((s, v) => s + v, 0);
  check(none === 0, `${none} cells hidden on flat ground`);
}

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log("ortho ok");
