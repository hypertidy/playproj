// Aspects and the cone through a parallel. The aspect follows PROJ's own
// test on lat_0; each parallel's conic has the kind geometry says it must;
// the points that reach the plane agree with project(); and in the gnomonic
// the branch from behind the light is where the opposite latitude lands.
import { aspect, parallelConic, project, lightFromSlider } from "../src/core/families/perspective.js";

let fails = 0;
const want = (got, exp, what) => { if (got !== exp) { fails++; console.log(`FAIL ${what}: ${got}, expected ${exp}`); } };

want(aspect(90), "north", "aspect 90"); want(aspect(-90), "south", "aspect -90");
want(aspect(0), "equatorial", "aspect 0"); want(aspect(-42), "oblique", "aspect -42");

const G = 0, ST = -1, OR = Infinity, NS = lightFromSlider(0.75);
const kinds = [
  [G, -90, -30, "circle"], [G, -90, 0, "at infinity"], [G, 0, 30, "hyperbola"], [G, 0, 0, "line"],
  [G, -45, -60, "ellipse"], [G, -45, -45, "parabola"], [G, -45, -30, "hyperbola"], [G, -45, 30, "hyperbola"],
  [G, -45, 0, "line"], [G, 60, 30, "parabola"], [G, 60, 40, "ellipse"],
  [ST, -45, 30, "circle"], [ST, -45, 45, "line"], [OR, 0, 30, "line"], [OR, -45, 30, "ellipse"], [NS, -45, 30, "ellipse"]
];
for (const [a, lat0, lat, k] of kinds) want(parallelConic({ a, lat0, lon0: 0, ts: 90 }, lat).kind, k, `a=${a} lat_0=${lat0} lat=${lat}`);

let worst = 0, worstAnti = 0, n = 0;
for (const a of [G, ST, OR, NS, lightFromSlider(0.3)])
  for (const lat0 of [-90, -45, 0, 30])
    for (const lat of [-75, -40, -10, 0, 20, 55])
      for (const ts of [90, 60]) {
        const p = { a, lat0, lon0: 20, ts };
        const N = 360, con = parallelConic(p, lat, N);
        con.points.forEach((q, k) => {
          if (!q) return;
          const lon = 20 + (360 * k) / N;
          if (q.near) {
            const xy = project(lon, lat, p);
            if (xy) { worst = Math.max(worst, Math.hypot(xy[0] - q.x, xy[1] - q.y) / Math.max(1, Math.hypot(xy[0], xy[1]))); n++; }
          } else if (a === 0 && q.behind) {
            const xy = project(lon + 180, -lat, p);
            if (xy) worstAnti = Math.max(worstAnti, Math.hypot(xy[0] - q.x, xy[1] - q.y) / Math.max(1, Math.hypot(xy[0], xy[1])));
          }
        });
      }
if (worst > 1e-9 || n < 1000) { fails++; console.log(`FAIL conic vs project: n=${n}, worst ${worst}`); }
if (worstAnti > 1e-9) { fails++; console.log(`FAIL gnomonic far branch vs opposite latitude: ${worstAnti}`); }
console.log(`aspects and parallel cones: ${n} points vs project(), worst ${worst.toExponential(2)} (relative); far branch vs opposite latitude ${worstAnti.toExponential(2)}; ${fails} failing`);
process.exit(fails ? 1 : 0);
