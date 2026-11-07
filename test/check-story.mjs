// Story (src/core/story.js): the terrain grid on the equal-area plane, its
// heights and triangles, footprint corners, and where a block stands.
import * as St from "../src/core/story.js";

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };

// grid: n + 1 vertices a side, north-west first, ext across, centre at lon0, lat0
{
  const g = St.terrainGrid(147.2869, -42.8876, 1500, 8);
  check(g.m === 9 && g.xy.length === 162 && g.cellM === 187.5, "grid size");
  check(g.xy[0] === -750 && g.xy[1] === 750 && g.xy[160] === 750 && g.xy[161] === -750, "grid corners nw first");
  const c = 4 * 9 + 4;
  check(Math.abs(g.ll[2 * c] - 147.2869) < 1e-9 && Math.abs(g.ll[2 * c + 1] + 42.8876) < 1e-9, "grid centre");
  // 1500 m east is about 0.0184 degrees of longitude at 42.9 S
  const dlon = g.ll[2 * 8] - g.ll[0];
  check(Math.abs(dlon - 1500 / (6371008.8 * Math.PI / 180 * Math.cos(42.8876 * Math.PI / 180))) < 2e-5, `grid width in longitude ${dlon}`);
}

// heights: a plane is a plane, and holes take the lowest height
{
  const g = St.terrainGrid(147, -43, 1000, 4);
  const h = St.gridHeights(g, (lon, lat) => (lon > 147.004 ? NaN : 100 + 1000 * (lat + 43)));
  check(h.missing > 0 && h.lo < h.hi, "heights with holes");
  check(Array.from(h.z).every((v) => v === v && v >= h.lo - 1e-3), "holes filled with the lowest");
}

// triangles: two a cell, every one counter-clockwise from above (y north)
{
  const g = St.terrainGrid(147, -43, 1000, 5), m = g.m;
  const z = new Float32Array(m * m).map((_, k) => Math.sin(k));
  for (const t of [St.gridTriangles(m), St.gridTriangles(m, z)]) {
    check(t.length === 5 * 5 * 6, "triangle count");
    let ccw = true;
    for (let k = 0; k < t.length; k += 3) {
      const [a, b, c] = [t[k], t[k + 1], t[k + 2]].map((v) => [g.xy[2 * v], g.xy[2 * v + 1]]);
      if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) <= 0) ccw = false;
    }
    check(ccw, "triangles counter-clockwise from above");
  }
}

// footprints: a 30 m square turned 90 degrees is the same square; turned
// 45 its corners reach 15 * sqrt 2
{
  const a = St.footprintCorners(10, 20, 30, 30, 0), b = St.footprintCorners(10, 20, 30, 30, 90);
  check(a[0][0] === -5 && a[0][1] === 5 && a[2][0] === 25 && a[2][1] === 35, "corners unturned");
  const key = (p) => p.map((q) => q.map((v) => Math.round(v * 1e6) / 1e6).join(",")).sort().join(" ");
  check(key(a) === key(b), "turned 90 is the same square");
  const c = St.footprintCorners(0, 0, 30, 30, 45);
  check(c.every(([x, y]) => Math.abs(Math.hypot(x, y) - 15 * Math.SQRT2) < 1e-9), "turned 45 corners");
  // clockwise from north: a long east-west block turned 90 runs north-south
  const d = St.footprintCorners(0, 0, 100, 10, 90);
  check(Math.max(...d.map((p) => Math.abs(p[1]))) > 49 && Math.max(...d.map((p) => Math.abs(p[0]))) < 6, "turned 90 runs north-south");
}

// seat: on a slope rising 1 m a metre to the east, a 30 m block stands at
// the west edge's height and the ground climbs 30 m under it
{
  const g = St.terrainGrid(147, -43, 1000, 4);
  const slope = (lon, lat) => g.P.forward(lon, lat)[0] + 500;
  const s = St.seat(slope, g.P, 100, 0, 30, 30, 0);
  check(Math.abs(s.min - 585) < 1e-6 && Math.abs(s.max - s.min - 30) < 1e-6 && Math.abs(s.mean - 600) < 1e-6, `seat on a slope ${s.min} ${s.max}`);
  check(St.seat(() => NaN, g.P, 0, 0, 30, 30) === null, "seat on nothing");
  check(St.blockHeight(10, 3) === 30, "ten storeys of 3 m");
}

// quantities: 50,000 t of soil in place is about a 30 m cube; a tonne of
// CO2 gas about an 8 m one; a pit over a 200 m square holds its volume
{
  const v = St.volumeOf(50000, "t", "soil");
  check(Math.abs(v - 27777.78) < 0.01 && Math.abs(St.shapeFor(v, "cube").h - 30.29) < 0.01, `soil cube ${v}`);
  check(Math.abs(St.shapeFor(St.volumeOf(1, "t", "co2"), "cube").w - 8.12) < 0.01, "a tonne of CO2");
  const p = St.shapeFor(St.volumeOf(298000, "t", "soil"), "pit", 200, 200);
  check(p.pit && Math.abs(p.w * p.d * p.h - 298000 / 1.8) < 1e-6, "pit holds the volume");
  check(St.volumeOf(5, "m3", "anything") === 5 && Number.isNaN(St.volumeOf(5, "t", "unobtainium")), "units");
}

if (fails) { console.log(`${fails} story checks failed`); process.exit(1); }
console.log("story: terrain grid, heights, triangles, footprints and seats all agree");
