// Shallow water solver (src/core/shallows.js), the JS port of the shallows R
// package kernel: well balancing, mass budget, dam break and Thacker bowl
// against their analytic solutions.
import { createSolver, OPEN, WALL, thackerBowl, dambreakStoker, dambreakRitter } from "../src/core/shallows.js";

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };

// lake at rest with dry islands stays at rest, both orders
for (const order of [1, 2]) {
  const n = 40, z = [], h = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const zz = 0.8 * Math.exp(-((i - 15) ** 2 + (j - 20) ** 2) / 30) + 0.3 * Math.sin(i / 3);
    z.push(zz); h.push(Math.max(0, 0.5 - zz));
  }
  const S = createSolver({ nx: n, ny: n, dx: 1, z, h, order });
  S.runTo(20);
  let e = 0, q = 0, dry = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const hh = S.at("h", i, j);
    if (hh > 0) e = Math.max(e, Math.abs(hh + S.at("z", i, j) - 0.5)); else dry++;
    q = Math.max(q, Math.abs(S.at("hu", i, j)), Math.abs(S.at("hv", i, j)));
  }
  check(dry > 0 && e < 1e-12 && q < 1e-12, `lake at rest order ${order}: ${e} ${q}`);
}

// dam breaks along x, 400 cells, order 2, t = 20 s
for (const wet of [true, false]) {
  const nx = 400, dx = 2.5, h = [];
  for (let j = 0; j < nx; j++) h.push(-500 + (j + 0.5) * dx < 0 ? 10 : (wet ? 2 : 0));
  const S = createSolver({ nx, ny: 1, dx, z: new Float64Array(nx), h, bc: [OPEN, OPEN, WALL, WALL], order: 2 });
  S.runTo(20);
  const ex = wet ? dambreakStoker(10, 2) : null;
  let e = 0;
  for (let j = 0; j < nx; j++) { const x = -500 + (j + 0.5) * dx; e += Math.abs(S.at("h", 0, j) - (wet ? ex(x, 20) : dambreakRitter(x, 20, 10))); }
  e /= nx;
  check(e < 0.016, `${wet ? "Stoker" : "Ritter"} mean depth error ${e}`);
  check(Math.abs(S.budgetError()) / S.volume0 < 1e-13, "dam break budget");
}

// Thacker bowl, one period, 60 x 60, order 2: relative L1 depth error
{
  const n = 60, dx = 4 / n, z = [], h = [], hu = [], hv = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = thackerBowl(-2 + (j + 0.5) * dx, -2 + (i + 0.5) * dx, 0);
    z.push(a.z); h.push(a.h); hu.push(a.h * a.u); hv.push(a.h * a.v);
  }
  const S = createSolver({ nx: n, ny: n, dx, z, h, hu, hv, order: 2 });
  const P = thackerBowl(0, 0, 0).period;
  S.runTo(P);
  let e = 0, v = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = thackerBowl(-2 + (j + 0.5) * dx, -2 + (i + 0.5) * dx, P);
    e += Math.abs(S.at("h", i, j) - a.h); v += a.h;
  }
  check(e / v < 0.1 && S.clipped === 0, `Thacker relative error ${e / v}`);
}

// rain with an open edge: budget closes, added water counted
{
  const nx = 40, ny = 30, z = [];
  for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) z.push(0.2 * j + 0.05 * (i - 15) ** 2 / 15);
  const S = createSolver({ nx, ny, dx: 2, z, rain: 0.01, manning: 0.03, bc: [OPEN, WALL, WALL, WALL], order: 2 });
  S.runTo(10); S.addWater(15, 20, 6, 1); S.runTo(30);
  check(S.outflow > 0 && S.added > 0, "outflow and added water");
  check(Math.abs(S.budgetError()) / (S.rainIn + S.added) < 1e-10, `rain budget ${S.budgetError()}`);
}

if (fails) { console.log(fails + " shallows checks failed"); process.exit(1); }
console.log("shallows: all checks passed");
