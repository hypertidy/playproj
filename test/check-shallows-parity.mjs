// Parity with the shallows R package (https://github.com/hypertidy/shallows).
// test/fixtures/shallows/parity.json is a copy of inst/parity/parity.json
// from that repository: small problems as plain data with the results the R
// package gives. The JS solver and terrain generator must reproduce them.
// The file records the package version it was written by. To refresh, copy
// the file again and port whatever changed in R.
import { readFileSync } from "node:fs";
import { terrain, shallows } from "../src/core/index.js";

const ref = JSON.parse(readFileSync(new URL("./fixtures/shallows/parity.json", import.meta.url), "utf8"));
let fail = 0, worst = 0;
const ok = (c, m) => { if (!c) { fail++; console.error("FAIL", m); } };
// relative to the size of the reference, absolute near zero
const near = (a, b, tol, m) => {
  const e = Math.abs(a - b) / Math.max(1, Math.abs(b));
  if (e > worst) worst = e;
  ok(e <= tol, `${m}: ${a} vs ${b}`);
};
const sum = (a) => { let s = 0; for (const v of a) s += v; return s; };
const wet = (a) => { let n = 0; for (const v of a) if (v > 0) n++; return n; };
const BC = { wall: shallows.WALL, open: shallows.OPEN, periodic: shallows.PERIODIC };

for (const c of ref.cases) {
  const e = c.expect;
  if (c.kind === "generate") {
    const g = terrain.generate(c.bed);
    c.cells.forEach((k, n) => near(g.z[k], e.z[n], 1e-12, `${c.name} z[${k}]`));
    near(sum(g.z), e.sum, 1e-12, `${c.name} sum`);
  } else if (c.kind === "fbm") {
    c.x.forEach((x, n) => near(terrain.fbm(x, c.y[n], c.noise), e.value[n], 1e-12, `${c.name} ${n}`));
  } else if (c.kind === "fill_sea" || c.kind === "fill_lake") {
    const g = terrain.generate(c.bed);
    const h = c.kind === "fill_sea" ? terrain.fillSea(g.z, g.nx, g.ny, c.level)
      : terrain.fillLake(g.z, g.nx, g.ny, c.i0, c.j0, c.level);
    ok(wet(h) === e.wet, `${c.name} wet cells ${wet(h)} vs ${e.wet}`);
    near(sum(h), e.sum, 1e-12, `${c.name} sum`);
  } else if (c.kind === "run") {
    const g = terrain.generate(c.bed), k = c.column;
    const h = Float64Array.from(g.z, (z) => Math.max(c.eta - z, 0));
    for (let i = k.i0; i <= k.i1; i++) for (let j = k.j0; j <= k.j1; j++) h[i * g.nx + j] += k.add;
    const S = shallows.createSolver({ nx: g.nx, ny: g.ny, dx: g.dx, z: g.z, h,
      manning: c.manning, rain: c.rain, f: c.f, bc: c.bc.map((b) => BC[b]), order: c.order });
    S.runTo(c.t);
    let nwet = 0;
    for (let i = 0; i < g.ny; i++) for (let j = 0; j < g.nx; j++) if (S.at("h", i, j) > 0) nwet++;
    c.cells.forEach((cell, n) => {
      const i = Math.floor(cell / g.nx), j = cell % g.nx;
      for (const v of ["h", "hu", "hv"]) near(S.at(v, i, j), e[v][n], 1e-10, `${c.name} ${v}[${cell}]`);
    });
    near(S.volume(), e.volume, 1e-12, `${c.name} volume`);
    ok(nwet === e.wet, `${c.name} wet cells ${nwet} vs ${e.wet}`);
  } else ok(false, `unknown parity case kind ${c.kind}`);
}

if (fail) { console.error(`${fail} parity checks failed against shallows ${ref.version}`); process.exit(1); }
console.log(`check-shallows-parity: ok (${ref.cases.length} cases, shallows ${ref.version}, worst ${worst.toExponential(1)})`);
