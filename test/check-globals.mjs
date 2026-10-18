// Globals and interrupteds: compare every map with points projected by PROJ
// itself (test/fixtures/globals-proj.json, made with PROJ 9.8 by
// test/make-globals-fixture.py), the butterfly's faces with PROJ's gnom,
// and check that the butterfly's faces and the lobes meet where they should.
import fs from "fs";
import { R, makeMap, BASES, projString } from "../src/core/families/globals.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/globals-proj.json", import.meta.url)));
const PARAMS = {
  igh: { base: "goode", lobes: "land" }, igh_o: { base: "goode", lobes: "ocean" },
  imoll: { base: "moll", lobes: "land" }, imoll_o: { base: "moll", lobes: "ocean" }
};
let fails = 0;
const report = (ok, label, msg) => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(44)} ${msg}`); };

for (const { proj, lon0, def, pts } of fx.maps) {
  const p = { ...(PARAMS[proj] || { base: Object.keys(BASES).find((k) => BASES[k].proj === proj), lobes: "none" }), s: 1, lon0 };
  const map = makeMap(p);
  let worst = 0;
  for (const [lon, lat, x, y] of pts) {
    const xy = map.project(lon, lat);
    worst = Math.max(worst, Math.hypot(xy[0] * R - x, xy[1] * R - y));
  }
  const str = projString(p);
  report(worst < 1e-3 && str === def, def, `vs PROJ ${worst.toExponential(2)} m over ${pts.length} points${str === def ? "" : `; string ${str}`}`);
}

// each butterfly face is PROJ's gnom from its centre, turned and moved
for (const edge of [-20, 0]) {
  const map = makeMap({ base: "butterfly", lon0: edge });
  let worst = 0;
  for (const { k, north, pts } of fx.faces.filter((f) => f.edge === edge)) {
    const q = map.pieces[(north ? 0 : 4) + k];
    const c = Math.cos(q.theta), s = Math.sin(q.theta);
    for (const [lon, lat, x, y] of pts) {
      const xy = map.project(lon, lat);
      if (xy[2] !== q.id) { worst = Infinity; continue; }
      const lx = c * (xy[0] - q.T[0]) + s * (xy[1] - q.T[1]), ly = -s * (xy[0] - q.T[0]) + c * (xy[1] - q.T[1]);
      worst = Math.max(worst, Math.hypot(lx - x, ly - y));
    }
  }
  report(worst < 1e-9, `butterfly faces, edge at ${edge}`, `vs PROJ gnom ${worst.toExponential(2)} (unit sphere)`);

  // neighbours across the equator meet; the four northern faces meet at the pole
  let gap = 0;
  for (let k = 0; k < 4; k++) {
    const n = map.pieces[k], s = map.pieces[4 + k];
    for (let i = 1; i < 20; i++) {
      const lam = n.cut[0] + (90 * i) / 20;
      const a = n.flat(lam, 0), b = s.flat(lam, 0);
      gap = Math.max(gap, Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
    const pole = n.flat(n.lamC, 90);
    gap = Math.max(gap, Math.hypot(pole[0], pole[1]));
  }
  report(gap < 1e-12, `butterfly joins, edge at ${edge}`, `largest gap ${gap.toExponential(2)}`);
  // going east around the pole turns the same way on the map as on the globe
  const turn = [0, 1, 2, 3].map((k) => { const xy = map.pieces[k].flat(map.pieces[k].lamC, 80); return Math.atan2(xy[1], xy[0]); });
  let ccw = true;
  for (let k = 0; k < 3; k++) ccw = ccw && ((turn[k + 1] - turn[k] + 2 * Math.PI) % (2 * Math.PI)) < Math.PI;
  report(ccw, `butterfly not mirrored, edge at ${edge}`, ccw ? "east is anticlockwise around the North Pole" : "mirrored");
}

// interrupted maps of every base: lobes meet along the equator, at any amount
for (const base of Object.keys(BASES).filter((b) => BASES[b].lobes))
  for (const lobes of ["land", "ocean", "gores"])
    for (const s of [0, 0.5, 1]) {
      const map = makeMap({ base, lobes, s, gores: 8, lon0: 30 });
      let gap = 0;
      for (let lam = -179.75; lam < 180; lam += 0.5) {
        const a = map.locate(lam, 1e-9).flat(lam, 0), b = map.locate(lam, -1e-9).flat(lam, 0);
        gap = Math.max(gap, Math.hypot(a[0] - b[0], a[1] - b[1]));
      }
      // and with the lobes closed it is the one unbroken map
      let closed = 0;
      if (s === 0) {
        const whole = makeMap({ base, lobes: "none", lon0: 30 });
        for (let lam = -179; lam < 180; lam += 7)
          for (let phi = -85; phi < 90; phi += 10) {
            const a = map.locate(lam, phi).flat(lam, phi), b = whole.locate(lam, phi).flat(lam, phi);
            closed = Math.max(closed, Math.hypot(a[0] - b[0], a[1] - b[1]));
          }
      }
      // goode's lobes use igh's join, a hair from goode's own
      const tol = base === "goode" ? 2e-4 : 1e-12;
      if (gap > 1e-12 || closed > tol) report(false, `${base} ${lobes} s=${s}`, `equator gap ${gap.toExponential(2)}, closed ${closed.toExponential(2)}`);
    }
report(true, "lobes meet on the equator", "every base, lobe set and amount");

process.exit(fails ? 1 : 0);
