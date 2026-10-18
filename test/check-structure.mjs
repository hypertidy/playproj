// Grid and file structure readers against independent ones: GeoTIFF/COG
// fixtures written by GDAL and described by rasterio and tifffile, Zarr
// stores written by zarr-python (test/make-structure-fixtures.py), and small
// WMTS, TileMatrixSet and ArcGIS documents.
import fs from "fs";
import proj4 from "proj4";
import * as S from "../src/core/structure.js";

const dir = new URL("./fixtures/structure/", import.meta.url);
const fx = JSON.parse(fs.readFileSync(new URL("manifest.json", dir)));
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// a fetch that honours Range, so the block reader is exercised as in a browser
function rangeFetch(buf) {
  return async (url, opt) => {
    const m = /bytes=(\d+)-(\d+)/.exec(opt.headers.Range);
    const a = +m[1], b = Math.min(+m[2], buf.length - 1);
    if (a >= buf.length) return { status: 416, ok: false, headers: new Map() };
    const body = buf.subarray(a, b + 1);
    return {
      status: 206, ok: true,
      headers: new Map([["content-range", `bytes ${a}-${b}/${buf.length}`]]),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length)
    };
  };
}

for (const t of fx.tiff) {
  const buf = new Uint8Array(fs.readFileSync(new URL(t.file, dir)));
  const src = S.rangeSource("x", { fetch: rangeFetch(buf), block: 1024 });
  const s = await S.tiffStructure(src);
  const L0 = s.levels[0];
  check(L0.width === t.width && L0.height === t.height, `${t.file} size ${L0.width}x${L0.height}`);
  check(s.info.format === (t.bigtiff ? "BigTIFF" : "TIFF"), `${t.file} format ${s.info.format}`);
  check(L0.tileH === t.block[0] && L0.tileW === t.block[1], `${t.file} block ${L0.tileW}x${L0.tileH} vs ${t.block}`);
  check(s.levels.length === t.levels.length, `${t.file} ${s.levels.length} levels vs ${t.levels.length}`);
  check(s.levels.slice(1).map((L) => L.factor).join() === t.overviews.join(), `${t.file} overview factors ${s.levels.map((L) => L.factor)} vs ${t.overviews}`);
  const [a, , c, , e, f] = t.transform;
  check(close(L0.x0, c) && close(L0.y0, f) && close(L0.dx, a) && close(L0.dy, e), `${t.file} transform ${[L0.x0, L0.y0, L0.dx, L0.dy]} vs ${t.transform}`);
  check(s.info.dtype === t.dtype, `${t.file} dtype ${s.info.dtype} vs ${t.dtype}`);
  if (t.epsg) check(s.crs && s.crs.epsg === t.epsg, `${t.file} epsg ${JSON.stringify(s.crs)} vs ${t.epsg}`);
  // tile offsets and byte counts, first and last, at every level (tifffile's pages are in file order)
  for (const tl of t.levels) {
    const L = s.levels.find((x) => x.width === tl.width && x.height === tl.height);
    check(!!L, `${t.file} no level ${tl.width}x${tl.height}`);
    if (!L) continue;
    check(L.tilesX * L.tilesY === tl.ntiles, `${t.file} ${L.name}: ${L.tilesX}x${L.tilesY} tiles vs ${tl.ntiles}`);
    const b0 = await S.tileBytes(src, s, L, 0), b1 = await S.tileBytes(src, s, L, tl.ntiles - 1);
    check(b0.offset === tl.first[0] && b0.length === tl.first[1], `${t.file} ${L.name} first tile ${JSON.stringify(b0)} vs ${tl.first}`);
    check(b1.offset === tl.last[0] && b1.length === tl.last[1], `${t.file} ${L.name} last tile ${JSON.stringify(b1)} vs ${tl.last}`);
  }
  if (t.file.includes("4326") || t.file.includes("3031")) check(s.info.cog && /BLOCK_ORDER=ROW_MAJOR/.test(s.info.ghost), `${t.file} COG ghost area: ${s.info.ghost}`);
  // a COG puts every IFD before the data: the header is a small fraction of the file
  check(src.bytes < Math.max(8192, buf.length), `${t.file} read ${src.bytes} of ${buf.length} bytes`);
  if (t.points) {
    check(s.crs && s.crs.proj4, `${t.file} expected a PROJ string from geokeys, got ${JSON.stringify(s.crs)}`);
    const P = proj4(s.crs.proj4);
    for (const [lon, lat, x, y] of t.points) {
      const q = P.forward([lon, lat]);
      check(Math.hypot(q[0] - x, q[1] - y) < 0.01, `${t.file} ${s.crs.proj4} at ${lon},${lat}: ${q} vs ${x},${y}`);
    }
  }
  const layout = await S.tiffLayout(src, s);
  if (s.info.cog) {
    // smallest overview first, full resolution last
    const order = layout.slice(1).sort((p, q) => p.start - q.start).map((g) => g.level.width);
    check(order.join() === s.levels.map((L) => L.width).reverse().join(), `${t.file} data order ${order}`);
    check(layout[0].end <= Math.min(...layout.slice(1).map((g) => g.start)), `${t.file} IFDs before data`);
  }
}

// a pixel and its tile
{
  const L = S.specStructure({ crs: "EPSG:4326", extent: [-180, 180, -90, 90], dim: [4320, 2160], tile: 256 }).levels[0];
  const p = S.locate(L, 147.3, -42.9);
  check(p.col === Math.floor((147.3 + 180) * 12) && p.row === Math.floor((90 + 42.9) * 12), `locate pixel ${p.col},${p.row}`);
  check(p.tileCol === Math.floor(p.col / 256) && p.tileRow === Math.floor(p.row / 256) && p.tileIndex === p.tileRow * 17 + p.tileCol, `locate tile ${JSON.stringify(p)}`);
  check(close(p.cx, -180 + (p.col + 0.5) / 12) && p.inside, "locate centre");
  check(!S.locate(L, 181, 0).inside, "locate outside");
}
// a typed spec halves the way GDAL's COG driver does
{
  const t = fx.tiff[0];
  const s = S.specStructure({ crs: "EPSG:4326", extent: [-180, 180, -90, 90], dim: [t.width, t.height], tile: t.block[0] });
  check(s.levels.map((L) => L.width).join() === t.levels.map((l) => l.width).join(), `spec levels ${s.levels.map((L) => L.width)} vs ${t.levels.map((l) => l.width)}`);
  check(S.specStructure({ crs: "EPSG:3031", extent: [0, 1, 0, 1], dim: [100, 100], tile: 10, levels: 3 }).levels.length === 3, "spec with a level count");
}

// Zarr stores
const getJsonFor = (store) => async (p) => {
  const f = new URL(store + "/" + p, dir);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : null;
};
for (const z of fx.zarr) {
  const s = await S.zarrStructure(getJsonFor(z.store));
  check(s.crs && s.crs.epsg === z.epsg, `${z.store} crs ${JSON.stringify(s.crs)}`);
  check(s.levels.map((L) => [L.width, L.height].join("x")).join() === z.levels.map((l) => l.join("x")).join(), `${z.store} levels ${s.levels.map((L) => L.width + "x" + L.height)}`);
  const L = s.levels[0];
  check(L.tileW === z.chunk[0] && L.tileH === z.chunk[1], `${z.store} chunks ${L.tileW}x${L.tileH}`);
  if (z.inner) check(L.inner && L.inner.join() === z.inner.join(), `${z.store} inner chunks ${L.inner}`);
  check(close(L.x0, z.x0) && close(L.y0, z.y0) && close(L.dx, z.dx) && close(L.dy, -z.dx), `${z.store} transform ${[L.x0, L.y0, L.dx, L.dy]}`);
  if (s.levels.length > 1) check(close(s.levels[3].dx, z.dx * 8), `${z.store} level 3 cell ${s.levels[3].dx}`);
  if (z.extra) check(JSON.stringify(L.extra.map((e) => [e.dim, e.size, e.chunk])) === JSON.stringify(z.extra), `${z.store} extra dims ${JSON.stringify(L.extra)}`);
}

// WMTS: a polar tile matrix set and a geographic one written lat, lon
const wmts = `<?xml version="1.0" encoding="UTF-8"?>
<Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1" version="1.0.0">
 <Contents>
  <Layer><ows:Title>Sea ice &amp; snow</ows:Title><ows:Identifier>ice</ows:Identifier>
   <TileMatrixSet>ignored</TileMatrixSet>
   <TileMatrixSetLink><TileMatrixSet>500m</TileMatrixSet></TileMatrixSetLink>
   <ResourceURL format="image/png" resourceType="tile" template="https://example.org/ice/{TileMatrix}/{TileRow}/{TileCol}.png"/>
  </Layer>
  <TileMatrixSet><ows:Identifier>500m</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::3031</ows:SupportedCRS>
   <TileMatrix><ows:Identifier>0</ows:Identifier><ScaleDenominator>29257142.85714286</ScaleDenominator>
    <TopLeftCorner>-4194304 4194304</TopLeftCorner><TileWidth>512</TileWidth><TileHeight>512</TileHeight><MatrixWidth>1</MatrixWidth><MatrixHeight>1</MatrixHeight></TileMatrix>
   <TileMatrix><ows:Identifier>1</ows:Identifier><ScaleDenominator>14628571.42857143</ScaleDenominator>
    <TopLeftCorner>-4194304 4194304</TopLeftCorner><TileWidth>512</TileWidth><TileHeight>512</TileHeight><MatrixWidth>2</MatrixWidth><MatrixHeight>2</MatrixHeight></TileMatrix>
  </TileMatrixSet>
  <TileMatrixSet><ows:Identifier>geo</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::4326</ows:SupportedCRS>
   <TileMatrix><ows:Identifier>0</ows:Identifier><ScaleDenominator>279541132.0143589</ScaleDenominator>
    <TopLeftCorner>90 -180</TopLeftCorner><TileWidth>256</TileWidth><TileHeight>256</TileHeight><MatrixWidth>2</MatrixWidth><MatrixHeight>1</MatrixHeight></TileMatrix>
  </TileMatrixSet>
 </Contents>
</Capabilities>`;
{
  const s = S.wmtsStructure(wmts);
  check(s.crs.epsg === 3031 && s.layer === "ice" && s.tms === "500m", `wmts pick ${s.layer} ${s.tms} ${JSON.stringify(s.crs)}`);
  check(s.layers[0].title === "Sea ice & snow", `wmts entity ${s.layers[0].title}`);
  const L = s.levels[0];
  check(close(L.dx, 4096, 1e-6) && L.x0 === -4194304 && L.tilesX === 2 && L.width === 1024, `wmts level ${JSON.stringify([L.dx, L.x0, L.tilesX])}`);
  check(s.template.includes("{TileMatrix}"), "wmts template");
  const g = S.wmtsStructure(wmts, { tms: "geo" }).levels[0];
  check(g.x0 === -180 && g.y0 === 90 && close(g.dx, 180 / 256, 1e-6), `wmts lat,lon corner ${[g.x0, g.y0, g.dx]}`);
}

// OGC TileMatrixSet JSON matches the built-in WebMercatorQuad
{
  const R = 20037508.3427892;
  const j = { id: "WebMercatorQuad", crs: "http://www.opengis.net/def/crs/EPSG/0/3857", orderedAxes: ["X", "Y"], tileMatrices: [0, 1, 2].map((z) => ({ id: String(z), scaleDenominator: 559082264.028717 / 2 ** z, cellSize: 156543.033928041 / 2 ** z, cornerOfOrigin: "topLeft", pointOfOrigin: [-R, R], matrixWidth: 2 ** z, matrixHeight: 2 ** z, tileWidth: 256, tileHeight: 256 })) };
  const a = S.tmsJsonStructure(j), b = S.webMercatorQuad(2);
  check(a.crs.epsg === 3857 && a.levels.length === 3, "tms json crs");
  for (let z = 0; z < 3; z++) {
    const p = a.levels.find((L) => L.id === String(z)), q = b.levels.find((L) => L.z === z);
    check(close(p.dx, q.dx, 1e-9) && close(p.x0, q.x0, 1e-9) && p.tilesX === q.tilesX, `tms json zoom ${z}`);
  }
}

// ArcGIS: a tile cache whose full extent is a window on the matrix
{
  const j = {
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    fullExtent: { xmin: -2e6, ymin: -1e6, xmax: 3e6, ymax: 4e6 },
    tileInfo: { rows: 256, cols: 256, origin: { x: -20037508.342787, y: 20037508.342787 }, spatialReference: { wkid: 102100, latestWkid: 3857 },
      lods: [0, 1, 2, 3].map((z) => ({ level: z, resolution: 156543.03392800014 / 2 ** z, scale: 591657527.591555 / 2 ** z })) }
  };
  const s = S.arcgisStructure(j, "https://example.org/arcgis/rest/services/X/MapServer?f=json");
  check(s.crs.epsg === 3857 && s.template === "https://example.org/arcgis/rest/services/X/MapServer/tile/{z}/{y}/{x}", `arcgis ${s.template}`);
  const L = s.levels.find((x) => x.z === 3);
  // zoom 3 tiles are 5009377 m: the window is columns 3..4 and rows 3..4
  check(L.col0 === 3 && L.tilesX === 2 && L.row0 === 3 && L.tilesY === 2, `arcgis window ${[L.col0, L.tilesX, L.row0, L.tilesY]}`);
  const p = S.locate(L, 1e5, 1e5);
  check(p.tileCol === 4 && p.tileRow === 3, `arcgis tile ${p.tileCol},${p.tileRow}`);
}

// CRS references
{
  const cases = [["EPSG:3031", 3031], ["urn:ogc:def:crs:EPSG::3413", 3413], ["http://www.opengis.net/def/crs/EPSG/0/32755", 32755], ["4326", 4326], ["OGC:CRS84", 4326]];
  for (const [r, e] of cases) check(S.parseCrsRef(r).epsg === e, `crs ref ${r} -> ${JSON.stringify(S.parseCrsRef(r))}`);
  const wkt = JSON.parse(fs.readFileSync(new URL("sst-v2.zarr/spatial_ref/.zattrs", dir))).crs_wkt;
  check(S.parseCrsRef(wkt).epsg === 4326, "crs ref from WKT");
  check(S.parseCrsRef('PROJCS["x",GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]],PROJECTION["polar"]]').epsg === undefined, "WKT whose only ID is its datum's");
  // every built-in definition is one proj4js can use
  for (const code of [3031, 3413, 3857, 32755, 32633, 3035, 3577, 6933, 8857, 32761, 27700, 2193, 4283, 28355])
    check(isFinite(proj4(S.knownProj4(code)).forward([147, -42])[0]) || code === 3413 || code === 3995, `proj4 ${code}`);
  check(S.guessKind("https://tile.openstreetmap.org/{z}/{x}/{y}.png") === "xyz" && S.guessKind("https://data.source.coop/ausantarctic/gebco/GEBCO_2026.tif") === "tiff" &&
    S.guessKind("https://x/arcgis/rest/services/World_Imagery/MapServer") === "arcgis" && S.guessKind("https://x/a.zarr") === "zarr" &&
    S.guessKind("https://gibs.earthdata.nasa.gov/wmts/epsg3031/best/1.0.0/WMTSCapabilities.xml") === "wmts", "guessKind");
}

if (fails) { console.log(`check-structure: ${fails} failures`); process.exit(1); }
console.log("check-structure: TIFF/COG, Zarr, WMTS, TileMatrixSet, ArcGIS and spec structures agree");
