// Terrain generator and flood fills: values match the shallows R package
// (shallows/R/generate.R), which computed the references below.
import { terrain, shallows } from "../src/core/index.js";

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error("FAIL", m); } };
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b}`);

// parity with R: sw_generate("island", nx = 40, ny = 30, dx = 10, noise = list(amp = 3, seed = 7))
const g = terrain.generate({ shape: "island", nx: 40, ny: 30, dx: 10, noise: { amp: 3, seed: 7 } });
near(g.z[0], 11.8909876344848, 1e-10, "island [1,1]");
near(g.z[14 * 40 + 19], 49.558754836647, 1e-10, "island [15,20]");
near(g.z[29 * 40 + 39], 11.084169598573, 1e-10, "island [30,40]");
near(terrain.fbm(123.4, -56.7, { scale: 200, octaves: 5, gain: 0.5, seed: 3 }), 0.337169257019615, 1e-12, "fbm");

// determinism and seed sensitivity
const g2 = terrain.generate({ shape: "island", nx: 40, ny: 30, dx: 10, noise: { amp: 3, seed: 7 } });
ok(g.z.every((v, k) => v === g2.z[k]), "same seed, same bed");
const g3 = terrain.generate({ shape: "island", nx: 40, ny: 30, dx: 10, noise: { amp: 3, seed: 8 } });
ok(g.z.some((v, k) => v !== g3.z[k]), "other seed, other bed");

// shapes: plane slope, bowl centre, shelf break
const p = terrain.generate({ shape: "plane", nx: 10, ny: 4, dx: 2 });
near(p.z[1] - p.z[0], -0.02, 1e-12, "plane slope");
const b = terrain.generate({ shape: "bowl", nx: 2, ny: 2, dx: 0.001 });
near(b.z[0], -10, 1e-6, "bowl centre");
for (const s of Object.keys(terrain.SHAPES)) {
  const t = terrain.generate({ shape: s, nx: 20, ny: 10, dx: 50 });
  ok(t.z.every(Number.isFinite), `finite ${s}`);
}
let threw = false;
try { terrain.generate({ shape: "nope", nx: 2, ny: 2, dx: 1 }); } catch { threw = true; }
ok(threw, "unknown shape throws");

// sea fill matches R: sw_fill_sea(sw_generate("island", nx = 100, ny = 80, dx = 10, noise = ...), 0)
const isl = terrain.generate({ shape: "island", nx: 100, ny: 80, dx: 10, noise: { amp: 3, seed: 7 } });
const sea = terrain.fillSea(isl.z, 100, 80, 0);
ok(sea.filter((v) => v > 0).length === 5252, "sea cells");
near(sea.reduce((a, v) => a + v, 0), 89693.8917294, 1e-6, "sea depth sum");

// lake behind an intact dam matches R: sw_fill_lake(reservoir 60 x 20 dx 5, 10, 5, 14)
const r = terrain.generate({ shape: "reservoir", nx: 60, ny: 20, dx: 5 });
const lake = terrain.fillLake(r.z, 60, 20, 9, 4, 14);
ok(lake.filter((v) => v > 0).length === 560, "lake cells");
near(lake.reduce((a, v) => a + v, 0), 4704, 1e-8, "lake depth sum");
ok(terrain.fillLake(r.z, 60, 20, 9, 4, -1e9).every((v) => v === 0), "dry start, no lake");

// Coriolis: inertial oscillation on a flat periodic sheet turns clockwise for f > 0
// and keeps |u| and mass exact
const nx = 8, ny = 8, z = new Float64Array(nx * ny), h = new Float64Array(nx * ny).fill(10);
const hu = new Float64Array(nx * ny).fill(1), f = 1e-4;
const S = shallows.createSolver({ nx, ny, dx: 1000, z, h, hu, f,
  bc: [shallows.PERIODIC, shallows.PERIODIC, shallows.PERIODIC, shallows.PERIODIC] });
const T = Math.PI / 2 / f;  // a quarter inertial period
S.runTo(T);
const k = S.id(3, 3), U = S.hu[k], V = -S.hv[k];  // north-positive
near(U, 0, 1e-9, "quarter turn: east momentum gone");
near(V, -1, 1e-9, "quarter turn: now southward (clockwise)");
near(S.budgetError() / S.volume(), 0, 1e-12, "mass budget");
near(shallows.coriolis(-45), -2 * 7.2921159e-5 * Math.sin(Math.PI / 4), 1e-15, "f at 45 S");

if (fail) { console.error(`${fail} terrain checks failed`); process.exit(1); }
console.log("check-terrain: ok");
