// The store page's CRS reading against PROJ and against the stores
// themselves: CF grid mappings through proj4js against pyproj's from_cf,
// cell areas against pyproj's Geod, and small Icechunk and Zarr stores
// written by xarray and zarr-python (test/make-store-fixtures.py), served
// over HTTP here and read with icechunk-js and zarrita as the page does.
import fs from "fs";
import http from "http";
import path from "path";
import proj4 from "proj4";
import * as C from "../src/core/storecrs.js";
import { factors } from "../src/core/tissot.js";

const FIX = new URL("./fixtures/", import.meta.url);
const fx = JSON.parse(fs.readFileSync(new URL("store-proj.json", FIX)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };

// ---------------------------------------------------------------- CF -> PROJ

// proj4js 2.12.1 (the version every page loads) inverts the ellipsoidal
// azimuthal equidistant into the wrong hemisphere south of the equator and
// is a metre or so off going forward; 2.22 agrees with PROJ. Reported, not
// failed, until the pages move to a newer proj4js.
const KNOWN = new Set(["azimuthal_equidistant"]);
const known = [];
for (const c of fx.cases) {
  const name = c.cf.grid_mapping_name;
  const expect = (ok, msg) => { if (!ok && KNOWN.has(name)) { if (!known.includes(name)) known.push(name); } else check(ok, msg); };
  const crs = C.cfProj(c.cf);
  expect(crs && crs.proj4, `${name}: no PROJ string`);
  if (!crs) continue;
  const F = C.crsFunctions(crs, proj4);
  expect(F, `${name}: proj4js rejects ${crs.proj4}`);
  if (!F) continue;
  let worst = 0;
  c.lonlat.forEach(([lon, lat], i) => {
    const q = F.fwd(lon, lat);
    const d = q ? Math.hypot(q[0] - c.xy[i][0], q[1] - c.xy[i][1]) : Infinity;
    worst = Math.max(worst, d);
    const back = q && F.inv(q[0], q[1]);
    expect(back && Math.abs(back[1] - lat) < 1e-7, `${name}: inverse at ${lon}, ${lat}`);
  });
  expect(worst < 1e-3, `${name}: ${crs.proj4} is ${worst.toExponential(2)} m from PROJ's ${c.proj4}`);
}
check(C.cfProj({ grid_mapping_name: "rotated_latitude_longitude", grid_north_pole_longitude: -162, grid_north_pole_latitude: 39.25 }).rotated[1] === 39.25, "rotated pole");
check(C.cfProj({ grid_mapping_name: "made_up" }) === null && C.cfProj({}) === null, "unknown mappings");
check(C.cfProj({ grid_mapping_name: "latitude_longitude" }).longlat.includes("WGS84"), "latitude_longitude defaults to WGS 84");

// ---------------------------------------------------------------- areas

const es = fx.es, a = fx.a;
for (const t of fx.areas) {
  const mine = C.lonLatCellArea(t.dlon, t.lat, t.lat + t.dlat, es) * a * a;
  check(Math.abs(mine - t.area) / t.area < 1e-6, `cell ${t.lon}, ${t.lat}: ${mine} vs Geod ${t.area}`);
  // the same from the areal scale of plate carree at the cell centre (small cells only)
  if (t.dlat <= 0.25 && t.lat < 89) {
    const f = factors((l, p) => [l * Math.PI / 180, p * Math.PI / 180], t.lon + t.dlon / 2, t.lat + t.dlat / 2, { es });
    const viaS = C.projectedCellArea((t.dlon * Math.PI / 180) * (t.dlat * Math.PI / 180), f.s) * a * a;
    check(Math.abs(viaS - t.area) / t.area < 1e-4, `cell ${t.lon}, ${t.lat} by areal scale: ${viaS} vs ${t.area}`);
  }
}

// ---------------------------------------------------------------- axes and the hash

const ax = C.axisOf([0, 2, 4, 6]);
check(ax.step === 2 && ax.edge0 === -1 && ax.regular, `axisOf ${JSON.stringify(ax)}`);
const wrap = C.axisOf([170, 175, 180, -175, -170], { lon: true });
check(wrap.step === 5 && wrap.regular, "axisOf unwraps longitude");
check(!C.axisOf([0, 1, 3, 4]).regular, "axisOf sees an uneven axis");
check(C.unitScale("km") === 1000 && C.unitScale("m") === 1 && C.unitScale(undefined) === 1, "unitScale");
const h = C.parseHash("#https://example.org/a.zarr::varname=tas::projection=mollweide::lat=10");
check(h.url === "https://example.org/a.zarr" && h.params.get("varname") === "tas" && h.params.get("lat") === "10", `parseHash ${JSON.stringify([...h.params])}`);
const back = C.parseHash("#" + C.hashString("https://x.org/s 1.icechunk", { varname: "a/b c", projection: "robinson", lon: "" }));
check(back.url === "https://x.org/s 1.icechunk" && back.params.get("varname") === "a/b c" && !back.params.has("lon"), "hashString round trip");
check(C.displayDef("robinson", 30) === "+proj=robin +lon_0=30 +lat_0=0 +x_0=0 +y_0=0 +R=1 +no_defs", C.displayDef("robinson", 30));
check(C.displayDef("nearside_perspective") === null, "the globe has no PROJ string");
check(C.displayDef("equal_earth", 150) === "+proj=eqearth +lon_0=150 +lat_0=0 +x_0=0 +y_0=0 +R=1 +no_defs", C.displayDef("equal_earth", 150));
check(C.parseHash("#https://x.org/a.icechunk::projection=equal_earth").params.get("projection") === "equal_earth" && C.DISPLAY_KEYS.includes("equal_earth"), "equal_earth is a display key");
check(C.chunkKey([0, 3, 5]) === "c/0/3/5" && C.chunkKey([0, 3, 5], { version: 2 }) === "0.3.5", "chunkKey");

// which way rows and columns run, from a lattice of lon/lat nodes
const lattice = (nu, nv, f) => { const ll = []; for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) ll.push(f(i, j)); return ll; };
const dir = (nu, nv, f) => { const d = C.gridDirections(lattice(nu, nv, f), nu, nv); return `${d.rows} ${d.cols}`; };
check(dir(8, 4, (i, j) => [-180 + 45 * i, -90 + 45 * j]) === "north east", "south-first longlat rows run north");
check(dir(8, 4, (i, j) => [-180 + 45 * i, 90 - 45 * j]) === "south east", "north-first rows run south");
check(dir(8, 4, (i, j) => [180 - 45 * i, 90 - 45 * j]) === "south west", "columns running west");
check(dir(8, 4, (i, j) => [(100 + 30 * i) % 360, -60 + 30 * j]) === "north east", "columns across the antimeridian run east");
check(dir(8, 4, (i, j) => (j === 2 ? null : [10 * i, 10 * j])) === "north east", "nodes off the earth are skipped");
// a south polar stereographic grid, north first in y: its rows cross the pole
{
  const P = proj4("+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +datum=WGS84 +units=m +no_defs");
  const polar = (i, j) => P.inverse([-3e6 + 6e5 * i, 3e6 - 6e5 * j]);
  check(dir(10, 10, polar) === "null null", `polar grid ${dir(10, 10, polar)}`);
}

// coordinate order: MPI-ESM1-2-HR historical tas as the CMIP6 bucket has it,
// 5-year files joined out of order (hours since 1915-01-16 12:00)
const T0 = "hours since 1915-01-16 12:00:00.000000";
const mpi = [0, 708, 1416, 43092, -175320, -174612, 35064, -569760, -569016];
const ord = C.coordOrder(mpi);
check(ord.order === "unordered" && ord.lo === 7 && ord.hi === 3 && ord.against === 2, `coordOrder ${JSON.stringify(ord)}`);
check(C.coordOrder([1, 2, 2, 3]).order === "increasing" && C.coordOrder([3, 1]).order === "decreasing" && C.coordOrder([4, 4]).order === "constant", "coordOrder directions");
check(C.cfTime(0, T0) === "1915-01-16 12:00" && C.cfTime(-569760, T0) === "1850-01-16 12:00", `cfTime ${C.cfTime(-569760, T0)}`);
check(C.cfTime(15.5, "days since 1850-01-01") === "1850-01-16 12:00" && C.cfTime(0n, "days since 2000-1-1") === "2000-01-01", "cfTime days, bigint");
check(C.cfTime(31, "days since 0001-01-01 00:00:00") === "0001-02-01", `cfTime before year 100: ${C.cfTime(31, "days since 0001-01-01 00:00:00")}`);
check(C.cfTime(3, "m") === null && C.cfTime(NaN, T0) === null, "cfTime off units");
// calendars, against cftime (test/make-cftime-fixture.py): every CF calendar,
// years before 1, leap days, month ends and the 1582 change
const cft = JSON.parse(fs.readFileSync(new URL("cftime.json", FIX)));
let calBad = 0, calFirst = "";
const p2 = (v) => String(v).padStart(2, "0");
for (const [x, u, cal, [y, mo, d, hh, mi, ss]] of cft.cases) {
  const date = `${y < 0 ? "-" : ""}${String(Math.abs(y)).padStart(4, "0")}-${p2(mo)}-${p2(d)}`;
  const want = hh || mi || ss ? `${date} ${p2(hh)}:${p2(mi)}${ss ? ":" + p2(ss) : ""}` : date;
  const got = C.cfTime(x, u, cal);
  if (got !== want) { calBad++; calFirst ||= `${x} ${u} ${cal}: ${got} not ${want}`; }
}
check(cft.cases.length > 1000 && !calBad, `cfTime vs ${cft.source}: ${calBad} of ${cft.cases.length} differ, first ${calFirst}`);
check(C.CF_CALENDARS.length === 11 && new Set(cft.cases.map((c) => c[2])).size === 9, "cfTime calendars covered");
// GFDL-ESM4 tos on noleap: 164 years of 365 days from 1850-01-16 12:00,
// 40 leap days short of 164 Gregorian years
const G0 = "hours since 1850-01-16 12:00:00.000000";
check(C.cfTime(164 * 365 * 24, G0, "noleap") === "2014-01-16 12:00" && C.cfTime(164 * 365 * 24, G0, "proleptic_gregorian") === "2013-12-07 12:00", `cfTime noleap ${C.cfTime(164 * 365 * 24, G0, "noleap")}`);
check(C.cfTime(59, "days since 2000-01-01", "360_day") === "2000-02-30" && C.cfTime(360, "days since 2000-01-01", "360_DAY") === "2001-01-01", "cfTime 360_day, any case");
check(C.cfTime(0, "days since 1582-10-15") === "1582-10-15" && C.cfTime(-1, "days since 1582-10-15") === "1582-10-04" && C.cfTime(-1, "days since 1582-10-15", "proleptic_gregorian") === "1582-10-14", "cfTime standard calendar 1582 change");
check(C.cfTime(0, T0, "none") === null && C.cfTime(0, T0, "lunar") === null, "cfTime calendars CF does not define");
check(C.cfTime(90, "seconds since 2000-01-01") === "2000-01-01 00:01:30", "cfTime seconds");
check(!C.oddCalendar(undefined) && !C.oddCalendar("Proleptic_Gregorian") && C.oddCalendar("noleap") && C.oddCalendar("360_day") && C.oddCalendar("julian"), "oddCalendar");
// fill values in attributes: numbers, lists, "NaN", and xarray's base64 double
check(C.attrFill("AAAAAPBp+EA=")[0] === 99999 && Number.isNaN(C.attrFill("NaN")[0]) && String(C.attrFill([1, "2"])) === "1,2" && !C.attrFill(null).length && !C.attrFill("abc").length, "attrFill");
// a collection of profiles, from the arrays beside the variable (MEOP's names)
const meopArrays = [
  { name: "LATITUDE", dims: ["N_PROF"], attrs: { standard_name: "latitude", units: "degree_north" } },
  { name: "LONGITUDE", dims: ["N_PROF"], attrs: { standard_name: "longitude", units: "degree_east" } },
  { name: "JULD_LOCATION", dims: ["N_PROF"], attrs: { units: "days since 1950-01-01 00:00:00 UTC" } },
  { name: "JULD", dims: ["N_PROF"], attrs: { units: "days since 1950-01-01 00:00:00 UTC", calendar: "julian" } },
  { name: "PRES_ADJUSTED", dims: ["N_PROF", "N_LEVELS"], attrs: { units: "decibar" } },
  { name: "PRES", dims: ["N_PROF", "N_LEVELS"], attrs: { units: "decibar" } },
  { name: "TEMP", dims: ["N_PROF", "N_LEVELS"], attrs: { units: "degree_Celsius" } },
  { name: "tag", dims: ["N_PROF"], attrs: { source_names: ["a", "b"] } }
];
const pr = C.profileRoles(["N_PROF", "N_LEVELS"], {}, meopArrays);
check(pr && pr.instance === "N_PROF" && pr.level === "N_LEVELS" && pr.lat === "LATITUDE" && pr.lon === "LONGITUDE" && pr.time === "JULD" && pr.z === "PRES" && pr.group === "tag", `profileRoles ${JSON.stringify(pr)}`);
// the variable's coordinates attribute picks among candidates
check(C.profileRoles(["N_PROF", "N_LEVELS"], { coordinates: "JULD_LOCATION LATITUDE LONGITUDE" }, meopArrays).time === "JULD_LOCATION", "profileRoles follows coordinates");
// a grid's lat(lat) and lon(lon), and a station's lat(station) with lon on another dim: not profiles
const gridArrays = [{ name: "lat", dims: ["lat"], attrs: { units: "degrees_north" } }, { name: "lon", dims: ["lon"], attrs: { units: "degrees_east" } }];
check(C.profileRoles(["lat", "lon"], {}, gridArrays) === null && C.profileRoles(["time", "lat", "lon"], {}, gridArrays) === null, "profileRoles: a grid is not a collection");
check(C.profileRoles(["station", "z"], {}, [{ name: "lat", dims: ["station"], attrs: { units: "degrees_north" } }, { name: "lon", dims: ["z"], attrs: { units: "degrees_east" } }]) === null, "profileRoles: lat and lon on different dims");
const sc = C.sliceCost([10, 721, 1440], [1, 721, 1440], 1, 2, 4);
check(sc.chunks === 1 && sc.bytes === 721 * 1440 * 4, "sliceCost");

// ---------------------------------------------------------------- curvilinear helpers

// a 1 degree cell at the equator: its sphere area and squareness
const q = C.sphereQuadArea([[0, 0], [1, 0], [1, 1], [0, 1]]);
const band = C.lonLatCellArea(1, 0, 1, 0);
check(Math.abs(q - band) / band < 1e-4, `sphereQuadArea ${q} vs band ${band}`);
const sq = C.cellShape([1, 0], [0, 1]), sk = C.cellShape([2, 0], [0, 1]), sh = C.cellShape([1, 0], [1, 1]);
check(sq.omega < 1e-9 && Math.abs(sq.area - 1) < 1e-12, "cellShape of a square");
check(Math.abs(sk.omega - 2 * Math.asin(1 / 3) * 180 / Math.PI) < 1e-9 && sk.area === 2, `cellShape of a 2 by 1 rectangle ${sk.omega}`);
check(Math.abs(sh.area - 1) < 1e-12 && sh.omega > 0, "cellShape of a sheared cell keeps its area");
// across the antimeridian and over the pole, bilinear on unit vectors
const ring = { nx: 2, ny: 2, lon: [179, -179, 179, -179], lat: [10, 10, 12, 12] };
const mid = C.curvAt(ring, 1, 1);
check(Math.abs(Math.abs(mid[0]) - 180) < 1e-9 && Math.abs(mid[1] - 11) < 0.01, `curvAt across the seam ${mid}`);

// ---------------------------------------------------------------- stores

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "store");
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  const buf = fs.readFileSync(p), m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (m) {
    let a0, b0;
    if (m[1] === "") { a0 = Math.max(0, buf.length - +m[2]); b0 = buf.length - 1; } else { a0 = +m[1]; b0 = m[2] === "" ? buf.length - 1 : Math.min(+m[2], buf.length - 1); }
    res.writeHead(206, { "content-range": `bytes ${a0}-${b0}/${buf.length}`, "content-length": b0 - a0 + 1 });
    res.end(buf.subarray(a0, b0 + 1));
  } else { res.writeHead(200, { "content-length": buf.length }); res.end(buf); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const R = await import("../js/store-read.js");
const man = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
for (const t of man.stores) {
  let s, v;
  try {
    s = await R.openStore(`${base}/${t.name}`);
    if (t.assume) {
      // left unplaced until a satellite is chosen
      const v0 = await R.describeVariable(s, t.variable);
      check(v0.abiLike && !v0.crs, `${t.name}: without an assumption, abiLike ${v0.abiLike}, crs ${JSON.stringify(v0.crs)}`);
    }
    v = await R.describeVariable(s, t.variable, { assume: t.assume });
  } catch (e) { check(false, `${t.name}: ${e.message}`); continue; }
  const g = v.grid;
  check(s.kind === (t.name.endsWith(".icechunk") ? "icechunk" : t.kind ? "zarr2" : "zarr3"), `${t.name}: opened as ${s.kind}`);
  check(R.dataArrays(s.arrays()).some((x) => x.path === t.variable), `${t.name}: ${t.variable} not listed`);
  check(g && g.nx === t.nx && g.ny === t.ny, `${t.name}: grid ${g && g.nx} x ${g && g.ny}`);
  check(String(v.meta.chunks) === String(t.chunks), `${t.name}: chunks ${v.meta.chunks}`);
  if (!g) continue;
  if (t.kind === "rectilinear") {
    check(g.kind === "rectilinear" && g.yc && !g.xc, `${t.name}: kind ${g.kind}, uneven ${!!g.xc} ${!!g.yc}`);
    check(g.yc && t.lat.every((v, i) => Math.abs(g.yc[i] - v) < 1e-9), `${t.name}: latitudes ${g.yc && g.yc.slice(0, 3)}`);
    // the edge between the first two rows is their midpoint
    check(g.yc && Math.abs(C.axisAt(g.yc, 1) - (t.lat[0] + t.lat[1]) / 2) < 1e-12, `${t.name}: axisAt`);
    await R.readChunk(s, v, 0, 0);
    continue;
  }
  if (t.kind === "curvilinear") {
    check(g.kind === "curvilinear" && v.crs === null, `${t.name}: kind ${g.kind}, crs ${JSON.stringify(v.crs)}`);
    const c = C.curvAt(g, 3.5, 2.5), k = C.curvAt(g, 1, 1);
    const tol = t.tol || 1e-9;
    check(c && Math.abs(c[0] - t.centre32[0]) < tol && Math.abs(c[1] - t.centre32[1]) < tol, `${t.name}: centre ${c} vs ${t.centre32}`);
    // a corner is interpolated between four centres: close (here 1.5 degree
    // cells, within 0.01 degree), not exact
    check(k && Math.abs(k[0] - t.corner11[0]) < 0.01 && Math.abs(k[1] - t.corner11[1]) < 0.01, `${t.name}: corner ${k} vs ${t.corner11}`);
    await R.readChunk(s, v, 0, 0);
    continue;
  }
  const near = (p, q) => Math.abs(p - q) <= 1e-6 * Math.max(1, Math.abs(q));
  check(near(g.x0, t.x0) && near(g.dx, t.dx) && near(g.y0, t.y0) && near(g.dy, t.dy), `${t.name}: transform ${[g.x0, g.dx, g.y0, g.dy]} vs ${[t.x0, t.dx, t.y0, t.dy]}`);
  if (t.body) check(v.crs && v.crs.body === t.body && /\+R=3396190/.test(v.crs.longlat), `${t.name}: body ${JSON.stringify(v.crs)}`);
  const F = C.crsFunctions(v.crs, proj4);
  check(F, `${t.name}: no CRS functions for ${JSON.stringify(v.crs)}`);
  if (F && t.corner) {
    const ll = F.inv(g.x0 + g.dx / 2, g.y0 + g.dy / 2);
    check(ll && Math.abs(ll[0] - t.corner[0]) < 1e-6 && Math.abs(ll[1] - t.corner[1]) < 1e-6, `${t.name}: first cell centre at ${ll} vs PROJ ${t.corner}`);
  }
  // a chunk comes back with the values the fixture wrote
  const c = await R.readChunk(s, v, 0, 0);
  check(c.chunk.data.length === t.chunks.reduce((p, q) => p * q, 1), `${t.name}: chunk of ${c.chunk.data.length}`);
}
// a group path after the repository root, as gridlook allows
try {
  const s = await R.openStore(`${base}/era.icechunk/1x91x180`);
  check(s.group === "1x91x180" && R.dataArrays(s.arrays()).some((x) => x.path === "2m_temperature"), "a group path after the repository");
} catch (e) { check(false, `group path: ${e.message}`); }
// a collection of profiles: no grid, a point per profile, and one profile read alone
for (const t of man.profiles || []) {
  try {
    const s = await R.openStore(`${base}/${t.name}`);
    const v = await R.describeVariable(s, t.variable);
    const p = await R.describeProfiles(s, v);
    check(!v.grid && p, `${t.name}: grid ${!!v.grid}, profiles ${!!p}`);
    if (!p) continue;
    for (const k of ["instance", "level", "lat", "lon", "time", "z", "group"]) check(p[k] === t[k], `${t.name}: ${k} is ${p[k]}, not ${t[k]}`);
    check(p.n === t.n && p.nLevels === t.levels, `${t.name}: ${p.n} profiles of ${p.nLevels} levels`);
    const lat = await R.readPerProfile(s, p.by[p.lat]);
    check(lat.values.filter(Number.isNaN).length === t.noPosition, `${t.name}: ${lat.values.filter(Number.isNaN).length} without a position`);
    const r = await R.readProfile(s, v, p, t.pick);
    check(r.values.length === t.levels && t.values.every((x, k) => (x === null ? Number.isNaN(r.values[k]) : Math.abs(r.values[k] - x) < 1e-6)), `${t.name}: profile ${t.pick} ${Array.from(r.values)}`);
    check(r.z && t.pres.every((x, k) => r.z[k] === x), `${t.name}: z of profile ${t.pick}`);
    const e = await R.readProfile(s, v, p, t.empty);
    check(e.values.every(Number.isNaN), `${t.name}: profile ${t.empty}, which has no chunk, reads ${Array.from(e.values).slice(0, 3)}`);
    // many at once, as a time window reads them: the same values, cut after the last level with one
    const got = new Map();
    const all = Array.from({ length: p.n }, (_, k) => k);
    const nc = await R.readProfiles(s, v, p, all, (i, x) => got.set(i, x), { run: 4 });
    const last = t.values.reduce((a, x, k) => (x === null ? a : k), -1);
    const g2 = got.get(t.pick);
    check(got.size === p.n && nc === 2 * p.n, `${t.name}: readProfiles gave ${got.size} profiles, ${nc} chunks`);
    check(g2 && g2.values instanceof Float32Array && g2.values.length === last + 1 && t.values.slice(0, last + 1).every((x, k) => Math.abs(g2.values[k] - x) < 1e-6) &&
      g2.z && g2.z.length === last + 1 && t.pres.slice(0, last + 1).every((x, k) => g2.z[k] === x), `${t.name}: readProfiles profile ${t.pick} ${g2 && Array.from(g2.values)}`);
    check(got.get(t.empty).values.length === 0, `${t.name}: readProfiles profile ${t.empty}, which has no chunk`);
    const some = new Map();
    await R.readProfiles(s, v, p, [t.pick, t.empty], (i, x) => some.set(i, x));
    check(some.size === 2 && some.get(t.pick).values.length === last + 1, `${t.name}: readProfiles of two`);
    let stops = 0;
    await R.readProfiles(s, v, p, all, () => {}, { run: 1, inFlight: 1, stop: () => ++stops > 3 });
    check(stops === 4, `${t.name}: readProfiles stops between runs (${stops})`);
  } catch (e) { check(false, `${t.name}: ${e.message}`); }
}
// the gribberish codec (js/gribberish.js) around a stand-in decoder: its
// settings, zarrita 0.7's dataType, the size check, and a lazy registry entry
{
  const G = await import("../js/gribberish.js");
  const calls = [];
  const Codec = G.gribberishCodec((bytes, v, lon, up) => { calls.push([bytes.length, v, lon, up]); return Float64Array.from({ length: 6 }, (_, i) => 270 + i); });
  const c = Codec.fromConfig({ var: "2t", adjust_longitude_range: true, north_up: true }, { dataType: "float32", shape: [1, 2, 3] });
  const out = c.decode(new Uint8Array(10));
  check(c.kind === "array_to_bytes" && out.data instanceof Float32Array && out.data[5] === 275 && String(out.stride) === "6,3,1" && String(calls[0]) === "10,2t,true,true", `gribberish codec ${JSON.stringify(calls)} ${out.stride}`);
  check(Codec.fromConfig({}, { data_type: "float64", shape: [2, 3] }).decode(new Uint8Array(1)).data instanceof Float64Array, "gribberish codec takes data_type too");
  let bad = 0;
  for (const f of [() => Codec.fromConfig({ nope: 1 }, { dataType: "float64", shape: [6] }), () => Codec.fromConfig({}, { dataType: "int16", shape: [6] }), () => Codec.fromConfig({}, { dataType: "float64", shape: [7] }).decode(new Uint8Array(1))]) {
    try { f(); } catch (e) { bad++; }
  }
  check(bad === 3, `gribberish codec refuses bad settings, types and sizes (${bad} of 3)`);
  const reg = new Map();
  let loads = 0;
  G.registerGribberish(reg, async () => { loads++; return { decodeZarrChunk: () => new Float64Array(1) }; });
  check(loads === 0 && reg.has("gribberish"), "gribberish registers without loading");
  const K = await reg.get("gribberish")();
  check(loads === 1 && K.fromConfig({}, { dataType: "float64", shape: [1] }).decode(new Uint8Array(1)).data.length === 1, "gribberish loads when a chunk needs it");
}
// dates back to CF values, for the time window
{
  const U = "days since 1950-01-01 00:00:00 UTC";
  const round = [["2019-03-01", U, "julian"], ["2012-06-12 09:54", U, "julian"], ["2000-02-30", "days since 2000-01-01", "360_day"],
    ["1582-10-04", "days since 1582-10-15", "standard"], ["2014-01-16 12:00", "hours since 1850-01-01", "noleap"], ["2020-01-01 00:00:30", "seconds since 1970-01-01", "proleptic_gregorian"]];
  const bad = round.filter(([d, u, c]) => C.cfTime(C.cfValue(d, u, c), u, c) !== d);
  check(!bad.length, `cfValue round trip: ${bad.map(([d, u, c]) => `${d} ${c} -> ${C.cfTime(C.cfValue(d, u, c), u, c)}`).join(", ")}`);
  check(C.cfValue("1950-01-02", U, "julian") === 1 && C.cfValue("1850-01-02", "hours since 1850-01-01") === 24 && C.cfValue("2000-01-01T06:00", "days since 2000-01-01") === 0.25, "cfValue values");
  check(C.cfValue("2000-13-01x", U) === null && C.cfValue("2000-01-01", "m") === null && C.cfValue("2000-01-01", U, "none") === null, "cfValue refuses");
  check(C.cfPerDay(U) === 1 && C.cfPerDay("hours since 1850-01-01") === 24 && C.cfPerDay("seconds since 1970-01-01") === 86400 && C.cfPerDay("m") === null, "cfPerDay");
}
// a profile at one depth, its deepest value, profiles per time, a window of them
{
  const z = [10, 20, 30, 40, 50], x = [NaN, 2, 1.5, NaN, NaN];
  check(C.valueAt(x, z, 20, 5) === 2 && C.valueAt(x, z, 27, 5) === 1.5 && C.valueAt(x, z, 12, 9) === 2 && Number.isNaN(C.valueAt(x, z, 10, 5)), "valueAt: nearest level with a value");
  check(Number.isNaN(C.valueAt(x, z, 45, 5)) && C.valueAt(x, z, 45, 20) === 1.5 && Number.isNaN(C.valueAt([], [], 0, 1)), "valueAt: none that close");
  check(C.deepestAt(x, z) === 30 && C.deepestAt(x, z, false) === 20 && Number.isNaN(C.deepestAt([NaN], [1])), "deepestAt");
  check(String(C.binCounts([0, 1, 2, 9.99, 10, 11, NaN], 0, 10, 5)) === "2,1,0,0,2" && String(C.binCounts([3, 3], 3, 3, 2)) === "2,0", "binCounts");
  check(String(C.inWindow([5, 1, 3, NaN, 2], 2, 5)) === "2,4", "inWindow");
  // a box round points, across the antimeridian where that is smaller
  const bx = (b) => b && [b.west, b.east, b.south, b.north].map((v) => +v.toFixed(6)).join(",");
  check(bx(C.lonLatBox([10, 20, 15], [-60, -50, -55], 1)) === "9,21,-61,-49", `lonLatBox ${bx(C.lonLatBox([10, 20, 15], [-60, -50, -55], 1))}`);
  check(bx(C.lonLatBox([170, -170, 179], [-70, -65, NaN])) === "170,190,-70,-65", `lonLatBox across 180 ${bx(C.lonLatBox([170, -170, 179], [-70, -65, NaN]))}`);
  check(bx(C.lonLatBox([-170, 0, 170, 90, -90], [0, 0, 0, 0, 0], 50)) === "-180,180,-50,50" && C.lonLatBox([NaN], [0]) === null, "lonLatBox all round, none");
  // bilinear between cell centres, round the antimeridian, NaN off the grid
  const g = { elev: Float32Array.from([0, 10, 20, 30, 40, 50]), width: 3, height: 2, west: 0, north: 10, dx: 1, dy: 1 };
  check(C.gridSample(g, 0.5, 9.5) === 0 && C.gridSample(g, 1, 9) === 20 && C.gridSample(g, 1.5, 9.25) === 17.5 && C.gridSample(g, 360.5, 9.5) === 0, `gridSample ${C.gridSample(g, 1.5, 9.25)}`);
  check(Number.isNaN(C.gridSample(g, 5, 9)) && Number.isNaN(C.gridSample(g, 1, 7)), "gridSample off the grid");
  // fractional levels, carried on past the ends
  const zl = [1, 2, 3, 5, NaN];
  check(C.levelOf(zl, 2.5) === 1.5 && C.levelOf(zl, 4) === 2.5 && C.levelOf(zl, 9) === 5 && C.levelOf(zl, 0) === -1 && Number.isNaN(C.levelOf([NaN], 1)), "levelOf");
}
check(C.cfDuration(0, "seconds") === "0 h" && C.cfDuration(97200, "seconds") === "1 d 3 h" && C.cfDuration(1296000, "seconds") === "15 d" && C.cfDuration(1.5, "days") === "1 d 12 h" &&
  C.cfDuration(-3600, "s") === "-1 h" && C.cfDuration(3, "m") === null && C.cfDuration(3, "days since 2000-01-01") === null, "cfDuration");
// a grid is never a collection of profiles
try {
  const s = await R.openStore(`${base}/era.icechunk`), v = await R.describeVariable(s, "1x91x180/2m_temperature");
  check((await R.describeProfiles(s, v)) === null, "a grid taken for profiles");
} catch (e) { check(false, `grid not profiles: ${e.message}`); }
server.close();

if (known.length) console.log(`storecrs: known proj4js 2.12.1 differences from PROJ in ${known.join(", ")}`);
console.log(`storecrs: ${fx.cases.length} CF mappings vs PROJ ${fx.proj}, ${fx.areas.length} cell areas, ${man.stores.length} stores, ${(man.profiles || []).length} profile collection${fails ? `, ${fails} failing` : ", all agree"}`);
process.exit(fails ? 1 : 0);
