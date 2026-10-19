// The Nuyina page's core: polar stereographic against PROJ (in
// test/fixtures/nuyina-proj.json), the sea ice grid and its values, the
// overlap plan and level choice, and reading a ship's track from CSV.
import fs from "fs";
import proj4 from "proj4";
import * as P from "../src/core/polarstere.js";
import * as S from "../src/core/seaice.js";
import * as M from "../src/core/mosaic.js";
import * as T from "../src/core/track.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/nuyina-proj.json", import.meta.url)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };
const dLon = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

// polar stereographic, forward, inverse and scale, in each CRS
for (const [code, rows] of Object.entries(fx.crs)) {
  const ps = P.polarStere(code);
  let fw = 0, inv = 0, kw = 0;
  for (const [lon, lat, x, y, k] of rows) {
    const [px, py] = ps.forward(lon, lat), [ql, qp] = ps.inverse(x, y);
    fw = Math.max(fw, Math.hypot(px - x, py - y));
    inv = Math.max(inv, Math.abs(qp - lat), Math.abs(lat) > 89.99 ? 0 : dLon(ql, lon) * Math.cos(lat * Math.PI / 180));
    kw = Math.max(kw, Math.abs(ps.k(lat) - k));
  }
  check(fw < 1e-3, `${code} forward off by ${fw} m`);
  check(inv < 1e-9, `${code} inverse off by ${inv} degrees`);
  check(kw < 1e-9, `${code} scale off by ${kw}`);
  // and the PROJ string reads the same in proj4js
  const p4 = proj4("EPSG:4326", P.projString(code));
  let w4 = 0;
  for (const [lon, lat, x, y] of rows) { const [a, b] = p4.forward([lon, lat]); w4 = Math.max(w4, Math.hypot(a - x, b - y)); }
  check(w4 < 1e-2, `${code} PROJ string in proj4js off by ${w4} m`);
  console.log(`${code.padEnd(10)} forward ${fw.toExponential(1)} m, inverse ${inv.toExponential(1)} deg, k ${kw.toExponential(1)}, proj4js ${w4.toExponential(1)} m`);
}

// ship-centred maps through proj4js, as the page uses them. proj4js
// 2.12.1's ellipsoidal aeqd inverse returns latitude + 180 south of the
// equator; the page folds it back, and this checks the folded result.
// proj4js's aeqd is a series, not PROJ's geodesic: within about 10 m out to
// 1000 km from the ship, which is well under a map pixel.
for (const c of fx.ship) {
  const p = proj4("EPSG:4326", c.proj), tol = c.proj.includes("aeqd") ? 2e-4 : 1e-7;
  let worst = 0;
  for (const [x, y, lon, lat] of c.pts) {
    let [l, q] = p.inverse([x, y]);
    if (q > 90) q -= 180; else if (q < -90) q += 180;
    worst = Math.max(worst, Math.abs(q - lat), dLon(l, lon));
  }
  check(worst < tol, `${c.proj} inverse off by ${worst} degrees`);
}

// 3031 and 9354 differ only by a scale
const f = P.rescale("EPSG:3031", "EPSG:9354");
{
  const a = fx.crs["EPSG:3031"], b = fx.crs["EPSG:9354"];
  let w = 0;
  for (let i = 0; i < a.length; i++) w = Math.max(w, Math.hypot(a[i][2] * f - b[i][2], a[i][3] * f - b[i][3]));
  check(w < 1e-3, `3031 -> 9354 by scale ${f}: off by ${w} m`);
  check(P.rescale("EPSG:3031", "EPSG:3412") === null, "3031 -> 3412 is not a rescale (different ellipsoid)");
  check(P.rescale("EPSG:3031", "EPSG:3413") === null, "3031 -> 3413 is not a rescale (other pole)");
}

// the NSIDC grid: corners and cell (0, 0)
{
  const ps = P.polarStere(S.SOUTH.crs);
  for (const [x, y, lon, lat] of fx.nsidc_south_corners) {
    const [l, p] = ps.inverse(x, y);
    check(Math.abs(p - lat) < 1e-8 && dLon(l, lon) < 1e-8, `NSIDC corner ${x},${y}: ${l},${p} vs ${lon},${lat}`);
  }
  check(String(S.cellOf(S.SOUTH, -3937500, 4337500)) === "0,0", "cell (0, 0) at the first centre");
  check(String(S.cellOf(S.SOUTH, 3949999, -3949999)) === "315,331", "last cell at the far corner");
  check(S.cellOf(S.SOUTH, 3950001, 0) === null, "off the grid to the east");
  const g = S.gridOf({ width: 316, height: 332, origin: [-3950000, 4350000], resolution: [25000, -25000], epsg: 3976 });
  check(g.crs === "EPSG:3976" && g.dy === 25000, `grid from a file ${JSON.stringify(g)}`);
  check(S.gridOf({ width: 316, height: 332 }).x0 === -3950000, "the published grid for a bare 316 x 332 file");
}

// sea ice values and addresses
check(S.decode(1000) === 1 && S.decode(150) === 0.15 && S.decode(2540) === null && S.decode(0) === 0, "decode tenths of a percent and flags");
check(S.decode(100, 8) === 1 && S.decode(254, 8) === null, "decode 8-bit percent");
check(S.flagOf(2540) === "land" && S.flagOf(2510) === "pole hole" && S.flagOf(500) === "", "flags");
check(S.nsidcUrl("2025-10-05") === "https://noaadata.apps.nsidc.org/NOAA/G02135/south/daily/geotiff/2025/10_Oct/S_20251005_concentration_v4.0.tif",
  `NSIDC address as sds builds it: ${S.nsidcUrl("2025-10-05")}`);
check(S.fillTemplate("x/{YYYY}/{MM}_{Mon}/{YYYYMMDD}-{DD}", "2024-02-09") === "x/2024/02_Feb/20240209-09", "URL template");

// the overlap plan
check(M.pick("first", -70, true, true) === 1 && M.pick("first", -40, false, true) === 2, "primary first, then fallback");
check(M.pick("cut", -55, true, true, -60) === 2 && M.pick("cut", -65, true, true, -60) === 1, "cut by latitude");
check(M.pick("cut", -65, false, true, -60) === 2, "the fallback fills a hole south of the cut");
check(M.pick("diff", -65, true, false) === 0 && M.pick("diff", -65, true, true) === 3, "difference only where both");
check(M.pick("gebco", -65, true, false) === 0, "fallback alone");

// level choice and windows (finest first)
{
  const levels = [500, 1000, 2000, 4000, 8000, 16000, 32000].map((res, i) => ({ res, x0: -4.8e6, y0: 4.8e6, width: 19200 >> i, height: 19200 >> i }));
  check(M.chooseLevel(levels, 1500, 1e5, 1e5) === 1, "1500 m pixels read the 1000 m level");
  check(M.chooseLevel(levels, 300, 1e5, 1e5) === 0, "finer than the finest reads the finest");
  check(M.chooseLevel(levels, 1500, 6e6, 6e6, 2048) === 3, `a wide box goes coarser: ${M.chooseLevel(levels, 1500, 6e6, 6e6, 2048)}`);
  check(M.chooseLevel(levels, 1e6, 1e7, 1e7) === 6, "coarse pixels read the coarsest");
  const w = M.windowOf(levels[0], [0, 0, 5000, 5000], 0);
  check(String(w) === "9600,9590,9610,9600", `window ${w}`);
  check(M.windowOf(levels[0], [5e6, 5e6, 6e6, 6e6]) === null, "window off the level");
  const win = { x0: 0, y0: 10, dx: 1, dy: 1, width: 10, height: 10 };
  check(M.covers(win, [1, 1, 9, 9], 1) && !M.covers(win, [1, 1, 11, 9], 1) && !M.covers(win, [1, 1, 9, 9], 0.5), "covers");
}

// sampling a window: bilinear on centres, nearest beside nodata
{
  const data = new Int16Array([0, 10, 20, 30, 40, 50, -32768, 70, 80]);
  const win = { data, width: 3, height: 3, x0: 0, y0: 3, dx: 1, dy: 1, nodata: -32768 };
  check(M.sample(win, 0.5, 2.5) === 0 && M.sample(win, 1, 2.5) === 5 && M.sample(win, 1, 2) === 20, "bilinear between centres");
  check(M.sample(win, 0.6, 0.6) === 70 || Number.isNaN(M.sample(win, 0.6, 0.6)), "nodata corner falls back to nearest");
  check(Number.isNaN(M.sample(win, 4, 1)), "off the window is NaN");
  check(M.sampleValid(win, 1, 2.5) === 5, "valid-weighted equals bilinear away from nodata");
  check(Math.abs(M.sampleValid(win, 1, 1) - (30 + 40 + 70) / 3) < 1e-9, `valid corners weighted alone: ${M.sampleValid(win, 1, 1)}`);
  check(String(M.cellIndex(win, 2.5, 0.5)) === "2,2", "cell index");
  const lines = M.gridLines({ x0: 0, y0: 0, dx: 25, dy: 25 }, 30, -30, 2);
  check(lines.xs.length === 6 && lines.xs[0] === -25 && lines.ys[0] === 25, `grid lines ${JSON.stringify(lines)}`);
}

// a track from GeoServer's CSV: FID first, geometry as WKT, a quoted field
{
  const csv = [
    "FID,set_code,datetime,longitude,latitude,sea_water_temperature,note,geom",
    "nuyina_underway.3,202526010,2025-10-01T00:02:00Z,179.9,-60,1.5,\"a, b\",POINT (179.9 -60)",
    "nuyina_underway.1,202526010,2025-10-01T00:00:00Z,179.5,-60,1.0,x,POINT (179.5 -60)",
    "nuyina_underway.2,202526010,2025-10-01T00:01:00Z,179.7,-60,,x,POINT (179.7 -60)",
    "nuyina_underway.4,202526010,2025-10-01T00:03:00Z,-179.9,-60,2,x,POINT (-179.9 -60)",
    "nuyina_underway.5,202526010,2025-10-01T00:04:00Z,,,2,x,POINT (-179.7 -60)",
    "nuyina_underway.6,202526010,bad,0,0,2,x,"
  ].join("\r\n");
  const tr = T.trackFromCSV(csv, "sea_water_temperature");
  check(tr.n === 5, `5 rows kept, got ${tr.n}`);
  check(tr.lon[0] === 179.5 && tr.lon[4] === -179.7, "sorted by time, WKT where the columns are empty");
  check(tr.numeric.includes("sea_water_temperature") && !tr.numeric.includes("longitude") && !tr.numeric.includes("note"), `numeric columns ${tr.numeric}`);
  const p = T.at(tr, Date.parse("2025-10-01T00:02:30Z"));
  check(Math.abs(p.lon - 180) < 1e-9 || Math.abs(p.lon + 180) < 1e-9, `across the antimeridian the short way: ${p.lon}`);
  check(p.heading !== null && Math.abs(p.heading - 90) < 1, `heading east ${p.heading}`);
  check(Math.abs(tr.dist[4] - T.greatCircle(179.5, -60, -179.7, -60)) < 0.05, `distance run ${tr.dist[4]}`);
  check(Math.abs(p.knots - (0.2 * 111.195 * 0.5 / 1.852) * 60) < 2, `speed ${p.knots} kn`);
  check(T.at(tr, 0).i === 0 && T.at(tr, 1e15).i === tr.n - 2, "clamped at the ends");
  const cols = T.detectColumns(["date_time_utc", "lon", "lat"]);
  check(cols.time === 0 && cols.lon === 1 && cols.lat === 2, `short names ${JSON.stringify(cols)}`);
  check(T.parseTime("2025-10-01 00:00:00") === Date.parse("2025-10-01T00:00:00Z"), "a time with no zone is UTC");
  check(T.thin(tr, 2).length <= 4 && T.thin(tr, 2).at(-1) === 4, "thinning keeps the last point");
}

// the feature service request and the schematic route
{
  const u = new URL(T.wfsUrl("202526010", { props: ["datetime", "longitude", "latitude"], max: 1 }));
  check(u.searchParams.get("typeName") === "underway:nuyina_underway" && u.searchParams.get("cql_filter") === "set_code='202526010'"
    && u.searchParams.get("propertyName") === "datetime,longitude,latitude" && u.searchParams.get("maxFeatures") === "1", `WFS request ${u}`);
  for (const v of T.VOYAGES) {
    const s = T.portsOfCall(v);
    check(s.schematic && Math.abs(s.lon[0] - T.PLACES.hobart.lon) < 1e-9 && Math.abs(s.lat[s.n - 1] - T.PLACES.hobart.lat) < 1e-9, `ports of call for ${v.label} start and end in Hobart`);
  }
}

// the parquet copy: which row groups a voyage's dates fall in (adjacent
// ones merged), and the track from its rows, by voyage code where it has one
{
  const day = 864e5, g = [0, 1, 2, 3].map((i) => ({ rows: 10, min: i * 10 * day, max: (i * 10 + 9) * day }));
  check(JSON.stringify(T.rowRanges(g, 12 * day, 25 * day)) === JSON.stringify([{ rowStart: 10, rowEnd: 30 }]), `row ranges ${JSON.stringify(T.rowRanges(g, 12 * day, 25 * day))}`);
  check(T.rowRanges(g, 50 * day, 60 * day).length === 0, "no row groups outside the dates");
  const v = { code: "X1", from: "2025-01-02", to: "2025-01-03" }, t0 = Date.parse("2025-01-01T00:00:00Z");
  const rows = [0, 1, 2, 3, 4].map((i) => [new Date(t0 + i * day), 147 + i, -43 - i, i === 0 || i === 4 ? "P1" : "X1", BigInt(i)]);
  const tr = T.trackFromRows(rows, v);
  check(tr.n === 3 && tr.lon[0] === 148 && tr.value[2] === 3, `track from rows by code: ${tr.n} points`);
  const tr2 = T.trackFromRows(rows.map((r) => [...r.slice(0, 3), "", r[4]]), v);
  check(tr2.n === 2 && tr2.lon[0] === 148, `track from rows by dates: ${tr2.n} points`);
}

console.log(fails ? `nuyina: ${fails} failing` : "nuyina ok");
if (fails) process.exit(1);
