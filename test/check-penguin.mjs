// The penguin datum (src/core/penguin.js): the decree's rotation against
// PROJ's ob_tran (test/fixtures/penguin-proj.json, from
// test/make-penguin-fixture.py), the radial table against the mesh (a
// star-shaped penguin's lon/lat cells add up to its surface; a real one's
// fall short by what no ray's last exit reaches), and the volume scaled to
// the earth's.
import fs from "fs";
import * as P from "../src/core/penguin.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/penguin-proj.json", import.meta.url)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };
const dlon = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// ---------------------------------------------------------------- rotation
const M = P.frame("heard");
check(P.projString(M) === fx.string, `PROJ string ${P.projString(M)} is not ${fx.string}`);
let worst = 0;
for (const [lon, lat, x, y] of fx.points) {
  const [pl, pp] = P.earthToPenguin(M, lon, lat);
  // longitude is arbitrary at the poles of either frame
  const e = Math.abs(pp - y) + (Math.abs(y) < 89.99 ? dlon(pl, x) * Math.cos(y * Math.PI / 180) : 0);
  worst = Math.max(worst, e);
  const [el, ep] = P.penguinToEarth(M, pl, pp);
  check(Math.abs(ep - lat) < 1e-9 && (Math.abs(lat) > 89.99 || dlon(el, lon) < 1e-8), `round trip at ${lon}, ${lat}`);
}
check(worst < 1e-8, `rotation off PROJ ob_tran by ${worst} degrees`);
const [hl, hp] = P.earthToPenguin(M, P.HEARD.lon, P.HEARD.lat);
check(Math.abs(hl) < 1e-9 && Math.abs(hp) < 1e-9, `Heard Island at penguin ${hl}, ${hp}, not 0, 0`);
const [cl, cp] = P.crown(M);
check(Math.abs(cl - 73.513) < 1e-9 && Math.abs(cp - 36.894) < 1e-9, `crown over ${cl}, ${cp}`);
const g = P.frame("greenwich");
const [gl, gp] = P.earthToPenguin(g, 30, -20);
check(Math.abs(gl - 30) < 1e-12 && Math.abs(gp + 20) < 1e-12, "greenwich frame is not the identity");

// the PROJJSON carries PROJ's own conversion
const pjBare = P.projjson(M, null);
check(pjBare.type === fx.type && pjBare.conversion.method.name === fx.method, "PROJJSON type or method differs from PROJ's");
check(JSON.stringify(pjBare.conversion.parameters) === JSON.stringify(fx.parameters), "PROJJSON parameters differ from PROJ's");

// ---------------------------------------------------------------- shapes

// a penguin with nothing sticking out: one exit everywhere, and the cells
// of the lon/lat table add up to the mesh's surface
const plain = P.buildPenguin({ beak: 0, flip: 0, feet: 0 }, { n: 96, step: 1 });
check(plain.contestedCells === 0, `the plain penguin has ${plain.contestedCells} directions with more than one exit`);
const plainA = P.meshAreas(plain.mesh, P.vertexReach(plain).hidden);
check(Math.abs(plain.decreeArea / plainA.area - 1) < 0.01, `plain: table area ${plain.decreeArea} against mesh ${plainA.area}`);
check(plainA.hidden / plainA.area < 0.005, `plain: ${plainA.hidden / plainA.area} of the surface hidden`);
check(Math.abs(plain.decreeVolume / plain.volume - 1) < 0.01, `plain: radial volume ${plain.decreeVolume} against ${plain.volume}`);

// the king penguin: rays leave and enter again, the table covers only what
// the last exits reach, and the decree surface encloses more than the bird
const king = P.buildPenguin({}, { n: 96, step: 1 });
check(king.contestedFraction > 0.03, `king: only ${king.contestedFraction} of directions contested`);
const kingV = P.vertexReach(king), kingA = P.meshAreas(king.mesh, kingV.hidden);
const frac = kingA.hidden / kingA.area;
check(frac > 0.05 && frac < 0.2, `king: hidden fraction ${frac}`);
check(Math.abs(king.decreeArea / (kingA.area - kingA.hidden) - 1) < 0.03, `king: table area ${king.decreeArea} against reachable mesh ${kingA.area - kingA.hidden}`);
check(king.decreeVolume > king.volume * 1.01, `king: decree volume ${king.decreeVolume} not above ${king.volume}`);
const contestedOf = (pg) => pg.contestedFraction;
check(contestedOf(P.buildPenguin({ beak: 1, flip: 0, feet: 0 }, { n: 64, step: 2 })) > 0, "a beak alone contests no direction");

// every exit count in the table is at least one (the centre is inside)
let none = 0;
for (const e of king.table.exits) if (!e) none++;
check(none === 0, `${none} directions never leave the penguin`);

// a ray from the centre: crossings alternate exit, entry, exit, ... and end on an exit
const u = P.dirOf(0, 40);
const xs = P.rayCrossings(king.field.F, king.centroid, u);
check(xs.length % 2 === 1 && xs.every((c, i) => c.exit === (i % 2 === 0)), `crossings out of order: ${JSON.stringify(xs)}`);

// ---------------------------------------------------------------- scale
const s = P.scale(king);
const vol = king.volume * s ** 3, earth = 4 / 3 * Math.PI * P.R_EARTH ** 3;
check(Math.abs(vol / earth - 1) < 1e-12, "the penguin is not the earth's volume");
const H = P.heightOf(king) * s / 1000;
check(H > 19000 && H < 23000, `penguin height ${H} km`);
check(Math.abs(P.ellipsoidRadius(0) - 6378137) < 1e-6 && Math.abs(P.ellipsoidRadius(90) - 6356752.314) < 1e-3, "WGS84 geocentric radius");

console.log(fails ? `${fails} failures` : `penguin: ok (king penguin ${Math.round(H)} km tall, ${(king.contestedFraction * 100).toFixed(1)}% of directions contested, ${(frac * 100).toFixed(1)}% of its surface unreachable)`);
process.exit(fails ? 1 : 0);
