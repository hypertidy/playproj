// The 4D page's axes, clock and cache (src/core/fourd.js), checked against
// two flat/arrays.json descriptions as raad.virtualize publishes them
// (test/fixtures/fourd: Bluelink BRAN temperature, and NSIDC G02202 sea ice
// with its time axis trimmed), and the registry (data/fourd/stores.json).
// Dates are checked against the published catalogue: BRAN daily from
// 1993-01-01, G02202 from 1978-10-25.
import { readFileSync } from "fs";
import * as F from "../src/core/fourd.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log("FAIL " + msg); } };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

// time units
{
  const t = F.timeUnits("days since 1979-01-01 00:00:00");
  ok(t.step === 86400000 && t.epoch === Date.UTC(1979, 0, 1), "days since 1979");
  const u = F.timeUnits("days since 1978-01-01 12:00:00");
  ok(u.epoch === Date.UTC(1978, 0, 1, 12), "noon epoch");
  ok(F.timeUnits("hours since 1900-01-01").step === 3600000, "hours");
  let threw = false; try { F.timeUnits("months since 2000-01-01"); } catch (e) { threw = true; }
  ok(threw, "months are refused (not a fixed length)");
}

// BRAN: four dims with roles from the description, affine coords, depths inline
{
  const d = F.describe(json("fixtures/fourd/bluelink-daily-temp.json"), "temp");
  ok(d.roles.join() === "t,z,y,x", `BRAN roles ${d.roles}`);
  ok(d.shape.join() === "12265,51,1500,3600" && d.chunks.join() === "1,1,300,300", "BRAN shape and chunks");
  ok(F.isoDay(d.axes.t.dates[0]) === "1993-01-01", `BRAN first day ${F.isoDay(d.axes.t.dates[0])}`);
  ok(d.axes.z.down && d.axes.z.n === 51, "BRAN depth axis, positive down");
  near(d.axes.z.values[0], 2.5, 1e-9, "BRAN first depth");
  near(d.axes.x.values[0], 0.05, 1e-6, "BRAN first lon");
  near(d.axes.y.values[1499], 74.95, 1e-3, "BRAN last lat");
  near(d.scale, 0.0077822199091315269, 1e-15, "BRAN scale");
  ok(d.fill === -32768 && d.offset === 245, "BRAN fill and offset");
  const v = F.unpack(Int16Array.of(-32768, 0, 100), d);
  ok(Number.isNaN(v[0]) && Math.abs(v[1] - 245) < 1e-4 && Math.abs(v[2] - (100 * d.scale + 245)) < 1e-3, "unpack");
  // a date to a step
  // the page's clock is the middle of a day; BRAN's steps are daily means
  // stamped at noon
  const ta = F.timeAt(d, Date.UTC(2025, 8, 15, 12));
  ok(!ta.outside && F.isoDay(ta.date) === "2025-09-15", `BRAN on 2025-09-15: ${F.isoDay(ta.date)}`);
  ok(F.timeAt(d, Date.UTC(1990, 0, 1)).outside, "before BRAN is outside");
  // a box to index windows and chunks: 60E to 90E, 70S to 45S
  const wx = F.windowOf(d.axes.x, 60, 90, { lon: true }), wy = F.windowOf(d.axes.y, -70, -45);
  ok(wx[0] === 600 && wx[1] === 900, `lon window ${wx}`);
  ok(wy[0] === 50 && wy[1] === 300, `lat window ${wy}`);
  ok(F.chunkSpan(wx, 300).join() === "2,3" && F.chunkSpan(wy, 300).join() === "0,1", "the box is one chunk a level");
  // a box given in -180..180 lands on the 0..360 axis
  const wneg = F.windowOf(d.axes.x, -100, -90, { lon: true });
  ok(wneg[0] === 2600 && wneg[1] === 2700, `negative lon window ${wneg}`);
  ok(F.chunkBytes(d) === 180000, "BRAN chunk bytes");
}

// G02202: polar stereographic metres, inline time with gaps, fill 255
{
  const d = F.describe(json("fixtures/fourd/g02202-v6-daily-south.json"), "cdr_seaice_conc");
  ok(d.roles.join() === "t,y,x", `G02202 roles ${d.roles}`);
  ok(F.isoDay(d.axes.t.dates[0]) === "1978-10-25", `G02202 first day ${F.isoDay(d.axes.t.dates[0])}`);
  ok(d.fill === 255 && d.scale === 0.01, "G02202 fill and scale");
  near(d.axes.x.values[0], -3937500, 0, "G02202 first x");
  near(d.axes.y.values[331], 4337500 - 331 * 25000, 0, "G02202 last y (descending)");
  const t = d.axes.t.dates;
  ok(F.nearestIndex(t, t[1] + 0.4 * 86400000).index === 1, "nearest day");
  ok(F.nearestIndex(t, t[4] + 2 * 86400000).outside, "after the end is outside");
  ok(F.windowOf(d.axes.y, -1e6, 1e6)[1] - F.windowOf(d.axes.y, -1e6, 1e6)[0] === 80, "descending axis window");
}

// the clock
{
  const s = F.clockSteps(Date.UTC(2020, 0, 31), Date.UTC(2020, 4, 1), "month");
  ok(s.length === 4 && F.isoDay(s[1]) === "2020-02-29" && F.isoDay(s[2]) === "2020-03-31", `month steps ${s.map(F.isoDay)}`);
  ok(F.clockSteps(Date.UTC(2020, 0, 1), Date.UTC(2020, 0, 11), "5day").length === 3, "5 day steps");
  ok(F.isoDay(F.stepFrom(Date.UTC(2020, 1, 28), "day", 1)) === "2020-02-29", "leap day");
  ok(F.isoDay(F.stepFrom(Date.UTC(2021, 5, 15), "year", -1)) === "2020-06-15", "a year back");
  ok(F.parseDay("2025-09-15") === Date.UTC(2025, 8, 15) && F.parseDay("15/09/2025") === null, "parseDay");
}

// the cache keeps the newest entries within its budget
{
  const c = new F.ByteLRU(10);
  c.set("a", new Uint8Array(4)).set("b", new Uint8Array(4));
  c.get("a");
  c.set("c", new Uint8Array(4));
  ok(c.has("a") && c.has("c") && !c.has("b") && c.bytes === 8, "LRU eviction");
}

// depth as radius
near(F.depthRadius(6371, 1000), 0, 1e-12, "6371 m at x 1000 reaches the centre");

// the synthetic ocean has the shape of a real one and cools downwards
{
  const s = F.syntheticOcean();
  ok(s.desc.roles.join() === "t,z,y,x" && s.desc.axes.z.n === 51, "synthetic dims");
  const top = s.read(100, 0, 100, 101, 0, 1)[0], deep = s.read(100, 45, 100, 101, 0, 1)[0];
  ok(top > deep, `synthetic cools with depth (${top.toFixed(2)} > ${deep.toFixed(2)})`);
}

// the registry: one base, every entry under it, remap to public URLs
{
  const reg = json("../data/fourd/stores.json");
  ok(/^https:\/\//.test(reg.base), "registry base");
  const ids = new Set();
  for (const e of [...reg.datasets, ...(reg.probe || [])]) {
    ok(!ids.has(e.id), `unique id ${e.id}`); ids.add(e.id);
    if (e.synthetic) continue;
    ok(!/^https?:/.test(e.path), `${e.id} path is relative to base`);
    const u = F.storeUrls(reg.base, e);
    ok(u.icechunk.startsWith(reg.base + "/") && u.arrays.endsWith("/flat/arrays.json"), `${e.id} urls`);
    if (reg.datasets.includes(e)) ok(Array.isArray(e.range) && e.range.length === 2 && ["surface", "volume"].includes(e.kind), `${e.id} range and kind`);
  }
  const meta = json("fixtures/fourd/bluelink-daily-temp.json");
  ok(F.publicUrl(meta, "/g/data/gb6/BRAN/BRAN2023/daily/ocean_temp_2025_09.nc") ===
    "https://thredds.nci.org.au/thredds/fileServer/gb6/BRAN/BRAN2023/daily/ocean_temp_2025_09.nc", "remap to public");
}

// isolines: a cone of values, distance from the middle, gives rings
{
  const w = 41, h = 41, get = (i, j) => Math.hypot(i - 20, j - 20);
  const { xy, lev } = F.isolines(w, h, get, [5, 10]);
  ok(xy.length === lev.length * 4 && lev.length > 40, `isoline segments ${lev.length}`);
  let worst = 0;
  for (let s = 0; s < lev.length; s++) for (const q of [0, 2]) {
    const r = Math.hypot(xy[4 * s + q] - 20, xy[4 * s + q + 1] - 20);
    worst = Math.max(worst, Math.abs(r - [5, 10][lev[s]]));
  }
  ok(worst < 0.1, `isoline points on their rings (worst ${worst.toFixed(3)})`);
  ok(F.isolines(2, 2, () => NaN, [1]).xy.length === 0, "missing corners give no lines");
  const L = F.isoLevels([0.15, 1], { n: 4, edge: true });
  ok(L.length === 4 && L[0] === 0.15, `levels with the edge ${L}`);
  ok(F.isoLevels([-2, 30], { step: 5 }).join() === "0,5,10,15,20,25", "levels by step");
}

console.log(fails ? `${fails} failed` : "fourd: all checks pass");
process.exit(fails ? 1 : 0);
