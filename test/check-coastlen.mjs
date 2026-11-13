// Coastline lengths (src/core/coastlen.js): lengths on the sphere and drawn
// on Mercator against PROJ (test/fixtures/coastlen-proj.json, from
// test/make-coastlen-fixture.py), the sphere against WGS84, and the divider
// walk, the longitude span and the sector cut on lines with known answers.
import fs from "fs";
import * as K from "../src/core/coastlen.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/coastlen-proj.json", import.meta.url)));
const data = JSON.parse(fs.readFileSync(new URL("../data/coast-south-10m.json", import.meta.url)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };
const rel = (a, b) => Math.abs(a / b - 1);

for (const k of ["australia", "grounding", "front"]) {
  const p = K.fromFlat(data[k]), f = fx[k];
  const L = K.length(p), M = K.mercatorLength(p);
  check(rel(L, f.sphere_km) < 1e-9, `${k}: sphere length ${L} not ${f.sphere_km}`);
  check(rel(M, f.mercator_km) < 1e-9, `${k}: Mercator length ${M} not ${f.mercator_km}`);
  check(rel(L, f.wgs84_km) < 0.005, `${k}: sphere and WGS84 differ by ${(100 * rel(L, f.wgs84_km)).toFixed(2)} percent`);
  // the ruler's length can only shrink as the ruler grows, and never passes the line's own
  const rows = K.richardson([p]).rows;
  check(rows.every((r, i) => r.L <= L + 1e-6 && (i === 0 || r.L <= rows[i - 1].L + 1e-6)), `${k}: ruler lengths not falling`);
  console.log(`${k.padEnd(10)} ${L.toFixed(1).padStart(9)} km sphere, ${f.wgs84_km.toFixed(1).padStart(9)} km WGS84 (${(100 * (f.wgs84_km / L - 1)).toFixed(2)}%), ${M.toFixed(1).padStart(10)} km on Mercator`);
}

// the dividers on a great circle: every step is r, and the length is the line's
const eq = Array.from({ length: 91 }, (_, i) => [i / 10, 0]);
const w = K.divider(eq, 100), Leq = K.length(eq);
check(w.n === Math.floor(Leq / 100), `equator: ${w.n} steps`);
check(Math.abs(w.length - Leq) < 1e-6, `equator: walked ${w.length} not ${Leq}`);
for (let i = 1; i < w.marks.length - 1; i++) check(Math.abs(K.distance(w.marks[i - 1], w.marks[i]) - 100) < 1e-6, `equator: step ${i} not 100 km`);
check(Math.abs(K.richardson([eq], [5, 10, 20, 50, 100], { fitMin: 5, fitMax: 100 }).D - 1) < 1e-3, "a straight line should have D = 1");

// a zigzag: the dividers cut its corners
const zz = Array.from({ length: 41 }, (_, i) => [i * 0.1, (i % 2) * 0.1]);
const zw = K.divider(zz, 50);
check(zw.length < K.length(zz) && zw.length > K.length([zz[0], zz[zz.length - 1]]), "zigzag: divider length out of range");

// a parallel all the way round is R cos(lat) 2 pi, and Mercator draws it R 2 pi
const par = Array.from({ length: 3601 }, (_, i) => [-180 + i / 10, -60]);
check(rel(K.mercatorLength(par), 2 * Math.PI * K.R) < 1e-9, "Mercator parallel not the equator's length");
check(rel(K.parallelLength(-60, 360), Math.PI * K.R) < 1e-12, "parallel length at 60 S");
check(Math.abs(K.lonSpan(par).span - 359.9) < 1e-9, `lonSpan of a parallel ${K.lonSpan(par).span}`);
const across = K.lonSpan([[170, 0], [-170, 0], [175, 1]]);
check(Math.abs(across.span - 20) < 1e-9 && across.west === 170, `lonSpan across the antimeridian ${JSON.stringify(across)}`);

// the sector cut: a ring round the pole at 66 S gives the AAT's two pieces, 109 degrees in all
const ring = Array.from({ length: 721 }, (_, i) => [-180 + i / 2, -66]);
const pieces = K.sectorPieces(ring, K.AAT);
check(pieces.length === 2, `AAT pieces ${pieces.length}`);
const spans = pieces.map((p) => p[p.length - 1][0] - p[0][0]).sort((a, b) => a - b);
check(Math.abs(spans[0] - 18) < 1e-9 && Math.abs(spans[1] - 91) < 1e-9, `AAT spans ${spans}`);
// a ring that starts inside a sector is joined across its start
const ring2 = ring.slice(500).concat(ring.slice(1, 501));
check(K.sectorPieces(ring2, K.AAT).length === 2, "AAT pieces of a ring starting in a sector");

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log("coastlen ok");
