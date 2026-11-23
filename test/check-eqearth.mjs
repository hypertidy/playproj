// Equal Earth on the sphere and the ellipsoid (src/core/eqearth.js) against
// points projected by PROJ itself (test/fixtures/eqearth-proj.json, made
// with PROJ 9.5.1 by test/make-eqearth-fixture.py): the core functions,
// the way back, the areal scale on the ellipsoid, and proj4js once
// useEqearth has put this one in place of its sphere-only eqearth.
import fs from "fs";
import proj4 from "proj4";
import * as E from "../src/core/eqearth.js";
import { factors, proj4Forward, proj4Def } from "../src/core/tissot.js";
import { knownProj4 } from "../src/core/structure.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/eqearth-proj.json", import.meta.url)));
let fails = 0;
const report = (ok, label, msg) => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(52)} ${msg}`); };

// a, es, lon_0, x_0, y_0 from a PROJ string
function figureOf(def) {
  const g = (k) => { const m = new RegExp(`\\+${k}=(\\S+)`).exec(def); return m ? m[1] : null; };
  let a = 1, es = 0;
  if (g("R")) a = +g("R");
  else if (g("a")) { a = +g("a"); const b = +g("b"); es = 1 - (b * b) / (a * a); }
  else if (/WGS84/.test(def)) { a = 6378137; const f = 1 / 298.257223563; es = f * (2 - f); }
  else if (/GRS80/.test(def)) { a = 6378137; const f = 1 / 298.257222101; es = f * (2 - f); }
  return { a, es, lon0: +(g("lon_0") || 0), x0: +(g("x_0") || 0), y0: +(g("y_0") || 0) };
}

// longitude and latitude on the definition's own figure, to it
function pair(def) {
  const d = proj4Def(def), P = proj4.Proj(d), b = P.b ?? P.a * Math.sqrt(1 - P.es);
  return proj4(`+proj=longlat +a=${P.a} +b=${b} +no_defs`, d);
}
// metres on the earth, or units of R on the unit sphere
const tol = (a) => (a > 1 ? 1e-4 : 1e-12);
const show = (d, a) => (a > 1 ? `${d.toExponential(2)} m` : d.toExponential(2));

// proj4js as it comes: right on the sphere, the sphere scaled by a on an ellipsoid
const stock = [];
for (const { def, pts } of fx.maps) {
  const tr = pair(def);
  let worst = 0;
  for (const [lon, lat, x, y] of pts) { const q = tr.forward([lon, lat]); worst = Math.max(worst, Math.hypot(q[0] - x, q[1] - y)); }
  stock.push(worst);
}

// cell areas on EPSG:8857 as it comes (cellAreas is below; function declarations hoist)
const stockCells = cellAreas(proj4("EPSG:4326", knownProj4(8857)));

// ---------------------------------------------------------------- the core

for (const { def, pts } of fx.maps) {
  const { a, es, lon0, x0, y0 } = figureOf(def);
  const o = { a, es, lon0 };
  let worst = 0, back = 0;
  for (const [lon, lat, x, y] of pts) {
    const q = E.forward(lon, lat, o);
    worst = Math.max(worst, Math.hypot(q[0] + x0 - x, q[1] + y0 - y));
    const ll = E.inverse(q[0], q[1], o);
    // at a pole, and on the outline at 180, any longitude is the point
    const dlon = Math.abs(lat) === 90 ? 0 : Math.abs((((ll[0] - lon + 540) % 360) - 180) * Math.cos(lat * Math.PI / 180));
    back = Math.max(back, Math.abs(ll[1] - lat), dlon);
  }
  report(worst < tol(a), `core ${def.replace(" +units=m +no_defs", "")}`, `${show(worst, a)} from PROJ over ${pts.length} points`);
  report(back < 1e-9, `  and back`, `${back.toExponential(2)} degrees`);
}

// past the pole line there is no point; past the outline the longitude wraps
{
  const p = E.inverse(0, E.MAX_Y), q = E.inverse(0, E.MAX_Y * 1.01), r = E.inverse(E.forward(180, 0)[0], 0), w = E.inverse(3.2, 0);
  report(Math.abs(p[1] - 90) < 1e-12 && q[1] === p[1] && Math.abs(Math.abs(r[0]) - 180) < 1e-9 && w[0] < 0, "the pole line and past the outline",
    `pole at ${p[1]}, past it clamped to the pole, past 180 wrapped to ${w[0].toFixed(3)} (as PROJ)`);
}

// equal-area on the ellipsoid: the areal scale is 1 everywhere, where the
// sphere scaled by a (proj4js's eqearth on WGS 84) is not
const W84 = figureOf("+datum=WGS84");
let sWorst = 0, sStock = 0;
for (let lat = -85; lat <= 85; lat += 5)
  for (const lon of [-170, -60, 0, 45, 120]) {
    const f = factors((l, p) => E.forward(l, p, { es: W84.es }), lon, lat, { es: W84.es });
    const g = factors((l, p) => E.forward(l, p), lon, lat, { es: W84.es });
    sWorst = Math.max(sWorst, Math.abs(f.s - 1));
    sStock = Math.max(sStock, Math.abs(g.s - 1));
  }
report(sWorst < 1e-8, "areal scale on WGS 84", `|s - 1| at most ${sWorst.toExponential(2)} (the sphere scaled by a: ${sStock.toExponential(2)})`);

// ---------------------------------------------------------------- proj4js

E.useEqearth(proj4);
for (const [k, { def, pts }] of fx.maps.entries()) {
  const { a } = figureOf(def);
  const tr = pair(def);
  let worst = 0, back = 0;
  for (const [lon, lat, x, y] of pts) {
    const q = tr.forward([lon, lat]);
    worst = Math.max(worst, Math.hypot(q[0] - x, q[1] - y));
    const ll = tr.inverse(q);
    const dlon = Math.abs(lat) === 90 ? 0 : Math.abs((((ll[0] - lon + 540) % 360) - 180) * Math.cos(lat * Math.PI / 180));
    back = Math.max(back, Math.abs(ll[1] - lat), dlon);
  }
  report(worst < tol(a) && back < 1e-9, `proj4js ${def.replace(" +units=m +no_defs", "")}`,
    `${show(worst, a)} from PROJ (as it comes: ${show(stock[k], a)}), back ${back.toExponential(2)} deg`);
}

// EPSG:8857 as the pages know it, against PROJ's own EPSG:8857
{
  const tr = proj4("EPSG:4326", knownProj4(8857));
  let worst = 0;
  for (const [lon, lat, x, y] of fx.epsg8857) { const q = tr.forward([lon, lat]); worst = Math.max(worst, Math.hypot(q[0] - x, q[1] - y)); }
  report(worst < 1e-4, "knownProj4(8857) through proj4js", `${worst.toExponential(2)} m from PROJ's EPSG:8857 over ${fx.epsg8857.length} points`);
}

// and the distortion page's path through proj4js: equal-area on WGS 84
{
  const P = proj4Forward(proj4, "+proj=eqearth +datum=WGS84");
  let worst = 0;
  for (let lat = -80; lat <= 80; lat += 20) for (const lon of [-120, 0, 90]) worst = Math.max(worst, Math.abs(factors(P.fwd, lon, lat, { es: W84.es }).s - 1));
  report(worst < 1e-6, "proj4Forward eqearth on WGS 84, areal scale", `|s - 1| at most ${worst.toExponential(2)}`);
}

// the Rasterize page's Equal Earth grid: a 10 km cell's true area, measured
// on a laea on WGS 84 centred on it (its sides densified, since they curve
// there), is its nominal 100 km2 anywhere. proj4js's own eqearth, as the
// sphere scaled by a, is off by up to 0.7 per cent.
function cellAreas(P) {
  let worst = 0;
  for (const [lon, lat] of [[0, 0], [147, -42], [-60, 60], [100, -75], [170, 85]]) {
    const [x, y] = P.forward([lon, lat]);
    const ea = proj4("EPSG:4326", `+proj=laea +lat_0=${lat} +lon_0=${lon} +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs`);
    const ring = [], n = 64;
    for (let i = 0; i < n; i++) ring.push([x + 1e4 * i / n, y], [x + 1e4, y + 1e4 * i / n], [x + 1e4 * (1 - i / n), y + 1e4], [x, y + 1e4 * (1 - i / n)]);
    // sides in order: bottom, right, top, left
    const r = [0, 1, 2, 3].flatMap((k) => ring.filter((_, i) => i % 4 === k)).map((q) => ea.forward(P.inverse(q)));
    let a2 = 0;
    for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a2 += p[0] * q[1] - q[0] * p[1]; }
    worst = Math.max(worst, Math.abs(Math.abs(a2) / 2 / 1e8 - 1));
  }
  return worst;
}
report(cellAreas(proj4("EPSG:4326", knownProj4(8857))) < 1e-7, "EPSG:8857 10 km cells: true area over nominal",
  `within ${cellAreas(proj4("EPSG:4326", knownProj4(8857))).toExponential(2)} of 1 from the equator to 85 N (proj4js as it comes: ${stockCells.toExponential(2)})`);

console.log(fails ? `eqearth: ${fails} failing` : "eqearth: all agree with PROJ");
if (fails) process.exit(1);
