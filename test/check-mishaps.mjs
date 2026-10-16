// Map catastrophes: the vertex-by-vertex map agrees with d3-geo away from
// the seam, and the spherical areas show the inside-out rings.
import * as d3 from "d3-geo";
import { catastrophes, frame, sphereProjection, rotation, areas, reverseFeature } from "../js/mishaps.js";

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };

// pixel frames match d3's projections, rotated or not
for (const flat of ["eqc", "merc"])
  for (const [lon0, lat0] of [[0, 0], [150, 0], [-40, 30]]) {
    const rot = rotation(lon0, lat0), fr = frame(flat, 1000), pr = sphereProjection(d3, flat, 1000, rot), r = d3.geoRotation(rot);
    let worst = 0;
    for (let lon = -170; lon <= 170; lon += 17)
      for (let lat = -80; lat <= 80; lat += 16) {
        const q = r([lon, lat]);
        if (Math.abs(q[1]) > 84) continue;
        const a = fr.px(...q), b = pr([lon, lat]);
        worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1]));
      }
    check(worst < 1e-6, `${flat} ${lon0},${lat0} frame vs d3: ${worst} px`);
  }

const steps = Object.fromEntries(catastrophes(d3).map((s) => [s.id, s]));
const area = (id, flip) => {
  const s = steps[id], f = flip ? reverseFeature(s.features[0]) : s.features[0];
  return areas(d3, f, rotation(s.view.lon, s.view.lat));
};
check(area("seam").sphere < 0.03 && area("seam").planar > 0.1, "seam box is small on the sphere and wide on the map");
check(area("pole").planar === 0 && area("pole").sphere > 0.05 && area("pole").sphere < 0.07, "pole ring is a cap with no planar area");
check(area("inside").sphere > 0.999 && area("inside", 1).sphere < 0.001, "Tasmania counterclockwise is the world, reversed it is Tasmania");
check(area("big").sphere > 0.7 && area("big", 1).sphere < 0.3, "big circle is more than half the sphere");

console.log(`map catastrophes: ${fails} failing`);
process.exit(fails ? 1 : 0);
