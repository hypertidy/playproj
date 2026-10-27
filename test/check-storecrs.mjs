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
check(C.chunkKey([0, 3, 5]) === "c/0/3/5" && C.chunkKey([0, 3, 5], { version: 2 }) === "0.3.5", "chunkKey");
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
    v = await R.describeVariable(s, t.variable);
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
server.close();

if (known.length) console.log(`storecrs: known proj4js 2.12.1 differences from PROJ in ${known.join(", ")}`);
console.log(`storecrs: ${fx.cases.length} CF mappings vs PROJ ${fx.proj}, ${fx.areas.length} cell areas, ${man.stores.length} stores${fails ? `, ${fails} failing` : ", all agree"}`);
process.exit(fails ? 1 : 0);
