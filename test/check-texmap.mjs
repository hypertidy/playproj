// Texture mapping: the projections the page drapes a lon/lat image through
// agree with proj4js, their inverses invert them, the meshes' seams and
// poles are what the page says they are, and a per-vertex lookup misses by
// nothing only where lon/lat is linear across the triangles (plate carree).
// Run with: node test/check-texmap.mjs (needs `npm i proj4`).
import proj4 from "proj4";
import * as T from "../src/core/texmap.js";

let fails = 0;
const check = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); };

for (const [id, P] of Object.entries(T.PROJS)) {
  // proj4js returns NaN for some of these without explicit lon_0 and offsets
  const tr = proj4("+proj=longlat +R=1", P.proj + " +lon_0=0 +x_0=0 +y_0=0");
  let fwd = 0, inv = 0, n = 0;
  for (let lon = -179; lon <= 179; lon += 7.7) {
    for (let lat = P.lat[0] + 0.5; lat <= P.lat[1] - 0.5; lat += 3.3) {
      const xy = P.forward(lon, lat), q = tr.forward([lon, lat]);
      fwd = Math.max(fwd, Math.hypot(xy[0] - q[0], xy[1] - q[1]));
      const ll = P.inverse(...xy);
      inv = Math.max(inv, T.arc(lon, lat, ...ll));
      n++;
    }
  }
  check(fwd < 1e-9 && inv < 1e-9 && n > 100, `${id.padEnd(6)} ${P.proj.padEnd(28)} n=${n} forward vs proj4 ${fwd.toExponential(1)}, inverse ${inv.toExponential(1)} deg`);
}

// u span of each triangle
const spans = (m) => {
  const out = [];
  for (let t = 0; t < m.index.length; t += 3) {
    const us = [0, 1, 2].map((i) => m.uv[2 * m.index[t + i]]);
    out.push(Math.max(...us) - Math.min(...us));
  }
  return out;
};
const rows = 6, cols = 12;
const split = T.globeMesh(rows, cols), shared = T.globeMesh(rows, cols, { seam: "shared" });
check(split.index.length / 3 === 2 * cols * (rows - 2) + 2 * cols, `globe ${rows}x${cols}: ${split.index.length / 3} triangles`);
check(Math.max(...spans(split)) <= 1 / cols + 1e-12, `globe, split seam: no triangle spans more than one column of u`);
check(spans(shared).filter((s) => s > 0.5).length === 2 * (rows - 2) + 2, `globe, shared seam: the last column's triangles span ${Math.max(...spans(shared)).toFixed(3)} of u`);
const single = T.globeMesh(rows, cols, { pole: "single" });
check(split.pos.length / 3 - single.pos.length / 3 === 2 * (cols - 1), `globe, single pole vertex: ${2 * (cols - 1)} fewer vertices`);

for (const level of [1, 2, 4]) {
  const s = T.icoMesh(level), h = T.icoMesh(level, { seam: "shared" });
  check(s.index.length / 3 === 20 * level * level, `icosphere level ${level}: ${s.index.length / 3} triangles`);
  check(Math.max(...spans(s)) <= 0.5, `icosphere level ${level}, split seam: widest u span ${Math.max(...spans(s)).toFixed(3)}`);
  check(spans(h).some((x) => x > 0.5), `icosphere level ${level}, shared seam: ${spans(h).filter((x) => x > 0.5).length} triangles smear across the image`);
  const r = s.pos.reduce((m, x, i) => (i % 3 ? m : Math.max(m, Math.abs(Math.hypot(s.pos[i], s.pos[i + 1], s.pos[i + 2]) - 1))), 0);
  check(r < 1e-12, `icosphere level ${level}: vertices on the unit sphere`);
}

// the per-vertex lookup's miss at triangle centres
const mid = [1 / 3, 1 / 3, 1 / 3];
const worst = (m, projId) => {
  let w = 0;
  for (let t = 0; t < m.index.length / 3; t++) w = Math.max(w, T.lookup(m, t, mid, projId).miss);
  return w;
};
for (const [id, want] of [["eqc", "zero"], ["merc", "some"], ["stere", "some"], ["moll", "some"]]) {
  const m = T.planeMesh(id, 6, 12), w = worst(m, id);
  check(want === "zero" ? w < 1e-9 : w > 0.05, `${id.padEnd(6)} plane 6x12: per-vertex miss at triangle centres up to ${w.toFixed(3)} deg`);
}
const g4 = worst(T.globeMesh(4, 8)), g32 = worst(T.globeMesh(32, 64));
check(g4 > 1 && g32 < g4 / 8, `globe: per-vertex miss up to ${g4.toFixed(2)} deg at 4x8, ${g32.toFixed(3)} deg at 32x64`);
check(T.lookup(split, 10, [1, 0, 0]).miss < 1e-9, `globe: no miss at a vertex`);

// every uv between the polar rows falls in one triangle of the split globe
// (the polar rows are triangles, so parts of the image there are never read)
let found = 0;
for (let k = 0; k < 200; k++) {
  const u = (k * 0.618034) % 1, v = (1 + 4 * ((k * 0.414214) % 1)) / rows;
  if (T.triangleAtUv(split, u, v)) found++;
}
check(found === 200, `globe: triangleAtUv found ${found} of 200 points`);

console.log(fails ? `${fails} failing` : "texmap: all ok");
process.exit(fails ? 1 : 0);
