// Tissot indicatrix factors (js/tissot.js) against PROJ's own proj_factors()
// (fixture made with PROJ 9.8 by test/make-tissot-fixture.py), in two parts:
//  1. the formulas: PROJ's four derivatives in, every other factor out, to
//     rounding;
//  2. the whole path: proj4js forward functions, differenced numerically.
//     The stereographic case runs a second time through the ray construction
//     of the perspective page, which has no PROJ string at all.
// Known differences in part 2 are in the projections, not the factors:
// proj4js interpolates Robinson's table differently near the poles, its
// spherical tmerc is the +approx series, and PROJ's van der Grinten loses
// digits on the equator (its derivative gives h = 394 at the origin and
// 0.99993 at 20 W, where h = 1), so the equator is left out there.
import { readFileSync } from "fs";
import proj4 from "proj4";
import { factors, fromDerivatives, proj4Forward, ellipse, smallCircle, majorAxis } from "../js/tissot.js";
import { project } from "../js/families/perspective.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/tissot-proj.json", import.meta.url)));
const OURS = { meridional_scale: "h", parallel_scale: "k", areal_scale: "s", angular_distortion: "omega",
  meridian_parallel_angle: "thetap", meridian_convergence: "conv", tissot_semimajor: "a", tissot_semiminor: "b",
  dx_dlam: "dx_dlam", dx_dphi: "dx_dphi", dy_dlam: "dy_dlam", dy_dphi: "dy_dphi" };
const ANGLE = new Set(["angular_distortion", "meridian_parallel_angle", "meridian_convergence"]);
const KNOWN = { "+proj=robin": 5e-3, "+proj=tmerc +lon_0=147 +R": 2e-6 };
const known = (label) => Object.entries(KNOWN).find(([k]) => label.startsWith(k))?.[1];

let fails = 0, total = 0;
const worst = {};
function diff(key, ours, ref) {
  if (key === "meridian_parallel_angle") return Math.abs(Math.sin(ours / 57.29577951308232) - Math.sin(ref / 57.29577951308232));
  if (ANGLE.has(key)) { const d = (((ours - ref) % 360) + 540) % 360 - 180; return Math.abs(d); }
  return Math.abs(ours - ref) / Math.max(1, Math.abs(ref));
}

function compare(label, fwd, es, pts, minN, tol = 1e-6) {
  let n = 0;
  const bad = [];
  for (const row of pts) {
    const [lon, lat] = row;
    if (label.startsWith("+proj=vandg") && lat === 0) continue;
    const f = factors(fwd, lon, lat, { es });
    if (!f) continue;
    n++;
    // numerical derivatives lose digits as the scale grows
    const t = tol * Math.max(1, f.a);
    fx.keys.forEach((key, j) => {
      const d = diff(key, f[OURS[key]], row[2 + j]);
      if (tol === 1e-6) worst[key] = Math.max(worst[key] || 0, d / Math.max(1, f.a));
      if (!(d <= (ANGLE.has(key) && key !== "meridian_parallel_angle" ? 100 * t : t)) && bad.length < 4) {
        bad.push(`${key} at ${lon},${lat}: ${f[OURS[key]]} vs ${row[2 + j]}`);
      }
    });
  }
  total += n;
  if (n < minN) bad.push(`only ${n} of ${pts.length} points`);
  if (bad.length) { fails++; console.log(`FAIL ${label}: ${bad.join("; ")}`); }
}

// 1. formulas, from PROJ's derivatives
let exact = 0, nexact = 0;
for (const c of fx.cases) {
  const es = proj4Forward(proj4, c.proj)?.es ?? 0;
  for (const row of c.pts) {
    const [lon, lat, ...ref] = row;
    let phi = lat * Math.PI / 180;
    if (Math.abs(phi) > Math.PI / 2 - 1e-5) phi = Math.sign(phi) * (Math.PI / 2 - 1e-5);
    const k = (name) => ref[fx.keys.indexOf(name)];
    const f = fromDerivatives(k("dx_dlam"), k("dx_dphi"), k("dy_dlam"), k("dy_dphi"), phi, es);
    nexact++;
    fx.keys.forEach((key, j) => {
      if (key.startsWith("d")) return;
      const d = diff(key, f[OURS[key]], ref[j]);
      exact = Math.max(exact, d / Math.max(1, f.a));
      // a, b and omega come from a difference of near-equal squares, so
      // rounding in the inputs grows to its square root (1e-8) near a = b;
      // the rest carry the fixture's 10 decimals
      const tol = (key.startsWith("tissot") ? 1e-7 : key === "angular_distortion" ? 1e-5 : 1e-9) * Math.max(1, f.a);
      if (!(d <= tol)) { fails++; console.log(`FAIL formula ${c.proj} ${key} at ${lon},${lat}: ${f[OURS[key]]} vs ${ref[j]}`); }
    });
  }
}
console.log(`tissot formulas: ${nexact} points from PROJ's derivatives, worst ${exact.toExponential(1)}`);

// 2. forward functions, differenced here
for (const c of fx.cases) {
  const P = proj4Forward(proj4, c.proj);
  if (!P) { fails++; console.log(`FAIL ${c.proj}: proj4js rejects it`); continue; }
  compare(c.proj, P.fwd, P.es, c.pts, c.pts.length * 0.85, known(c.proj) ?? 1e-6);
}

// the same stereographic numbers from the ray construction (light at the antipode)
const st = fx.cases.find((c) => c.proj.startsWith("+proj=stere +lat_0=-40"));
const rays = (lon, lat) => project(lon, lat, { a: -1, lat0: -40, lon0: 140 });
compare("stereographic by rays", rays, 0, st.pts, st.pts.length * 0.9);

// geometry helpers: the ellipse has semi-axes a r and b r, along majorAxis();
// a small circle stays r from its centre
{
  const P = proj4Forward(proj4, "+proj=moll +R=1");
  const f = factors(P.fwd, 60, 50);
  const ring = ellipse(f, 0, 0, 1, 720), th = majorAxis(f);
  let rmax = 0, rmin = Infinity, along = 0;
  for (let i = 0; i < ring.length - 2; i += 2) {
    const r = Math.hypot(ring[i], ring[i + 1]);
    if (r > rmax) { rmax = r; along = Math.atan2(ring[i + 1], ring[i]); }
    rmin = Math.min(rmin, r);
  }
  let dth = (((along - th) % Math.PI) + Math.PI) % Math.PI;
  dth = Math.min(dth, Math.PI - dth);
  if (Math.abs(rmax - f.a) > 1e-4 || Math.abs(rmin - f.b) > 1e-4 || dth > 0.01) {
    fails++; console.log(`FAIL ellipse axes: ${rmax} ${rmin} vs ${f.a} ${f.b}, direction off by ${dth}`);
  }
  const c = smallCircle(170, -60, 10, 36);
  for (let i = 0; i < c.length; i += 2) {
    const p1 = -60 * Math.PI / 180, p2 = c[i + 1] * Math.PI / 180, dl = (c[i] - 170) * Math.PI / 180;
    const d = Math.acos(Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI;
    if (Math.abs(d - 10) > 1e-9) { fails++; console.log(`FAIL small circle radius ${d}`); break; }
  }
}

console.log(`tissot: ${total} points in ${fx.cases.length + 1} projections vs ${fx.source}; worst (per unit scale, known differences aside) ` +
  Object.entries(worst).map(([k, v]) => `${OURS[k]} ${v.toExponential(1)}`).join(", ") + `; ${fails} failing`);
if (fails) process.exit(1);
