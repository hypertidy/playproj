// Grid, tile and file structure of rasters, read from headers and metadata
// only, never from pixel data: GeoTIFF and COG (TIFF tags by range request),
// Zarr (JSON metadata), tile services (WMTS capabilities, OGC TileMatrixSet
// JSON, ArcGIS REST JSON, XYZ templates) and grid specs typed by hand.
//
// Every source becomes a structure: a CRS, an extent and a list of levels.
// A level is a regular grid of pixels cut into tiles (or strips, or chunks):
//
//   x = x0 + col * dx,  y = y0 + row * dy      (dy < 0 for north-up)
//
// with width x height pixels in tilesX x tilesY tiles of tileW x tileH.
// col0 and row0 are the index of the first tile when a level is a window on
// a larger tile matrix (ArcGIS caches, tile matrix limits).

// ---------------------------------------------------------------- levels

export function levelExtent(L) {
  const xa = L.x0, xb = L.x0 + L.width * L.dx, ya = L.y0, yb = L.y0 + L.height * L.dy;
  return [Math.min(xa, xb), Math.min(ya, yb), Math.max(xa, xb), Math.max(ya, yb)];
}

function makeLevel(o) {
  const L = { col0: 0, row0: 0, tiled: true, ...o };
  if (!L.tileW) L.tileW = L.width;
  if (!L.tileH) L.tileH = L.height;
  if (L.tilesX === undefined) L.tilesX = Math.ceil(L.width / L.tileW);
  if (L.tilesY === undefined) L.tilesY = Math.ceil(L.height / L.tileH);
  return L;
}

// Pixel and tile under a point in the level's CRS.
export function locate(L, x, y) {
  const fc = (x - L.x0) / L.dx, fr = (y - L.y0) / L.dy;
  const col = Math.floor(fc), row = Math.floor(fr);
  const inside = col >= 0 && row >= 0 && col < L.width && row < L.height;
  const tc = Math.floor(col / L.tileW), tr = Math.floor(row / L.tileH);
  const inTiles = tc >= 0 && tr >= 0 && tc < L.tilesX && tr < L.tilesY;
  return {
    col, row, inside, inTiles,
    tileCol: tc + L.col0, tileRow: tr + L.row0,
    tileIndex: tr * L.tilesX + tc,
    inTile: [col - tc * L.tileW, row - tr * L.tileH],
    // the pixel's centre, back in the CRS
    cx: L.x0 + (col + 0.5) * L.dx, cy: L.y0 + (row + 0.5) * L.dy
  };
}

// The usual overview sizes: GDAL halves with rounding up, (n + f - 1) / f.
export function overviewSize(n, f) { return Math.floor((n + f - 1) / f); }

// ---------------------------------------------------------------- byte sources

const MAX_WHOLE = 8 * 1024 * 1024;

// Reads byte ranges of a URL in aligned blocks, each fetched once. A server
// that ignores Range is accepted only for small files.
export function rangeSource(url, { fetch: fetchFn = globalThis.fetch, block = 65536 } = {}) {
  const blocks = new Map();
  const src = { url, size: null, requests: 0, bytes: 0, read };
  let whole = null;

  async function fetchRun(i0, i1) {
    const a = i0 * block, b = (i1 + 1) * block;
    src.requests++;
    const r = await fetchFn(url, { headers: { Range: `bytes=${a}-${b - 1}` } });
    if (r.status === 416) return new Uint8Array(0);
    if (r.status === 206) {
      const m = /\/(\d+)\s*$/.exec(r.headers.get("content-range") || "");
      if (m) src.size = +m[1];
      const u = new Uint8Array(await r.arrayBuffer());
      // a short answer is the end of the file (Content-Range is not always exposed to scripts)
      if (src.size === null && u.length < b - a) src.size = a + u.length;
      src.bytes += u.length;
      return u;
    }
    if (!r.ok) throw new Error(`${r.status} ${r.statusText || ""} from ${url}`.trim());
    const len = +(r.headers.get("content-length") || 0);
    if (!len || len > MAX_WHOLE) {
      if (r.body && r.body.cancel) r.body.cancel().catch(() => {});
      throw new Error("the server ignores range requests, so only the whole file could be read");
    }
    whole = new Uint8Array(await r.arrayBuffer());
    src.bytes += whole.length;
    src.size = whole.length;
    return null;
  }

  async function read(off, len) {
    if (whole) return whole.subarray(off, off + len);
    const i0 = Math.floor(off / block), i1 = Math.floor((off + len - 1) / block);
    // fetch each run of missing blocks in one request
    let i = i0;
    while (i <= i1) {
      if (blocks.has(i)) { i++; continue; }
      let j = i;
      while (j + 1 <= i1 && !blocks.has(j + 1)) j++;
      const first = i, last = j, run = fetchRun(first, last);
      for (let k = first; k <= last; k++)
        blocks.set(k, run.then((u) => (u ? u.subarray((k - first) * block, (k - first + 1) * block) : null)));
      run.catch(() => { for (let k = first; k <= last; k++) blocks.delete(k); });
      i = j + 1;
    }
    const parts = [];
    for (let k = i0; k <= i1; k++) parts.push(await blocks.get(k));
    if (whole) return whole.subarray(off, off + len);
    const out = new Uint8Array(len);
    let got = 0;
    for (let k = i0; k <= i1; k++) {
      const p = parts[k - i0], start = k * block;
      const s = Math.max(off, start) - start, e = Math.min(off + len, start + p.length) - start;
      if (e > s) { out.set(p.subarray(s, e), Math.max(off, start) - off); got += e - s; }
      if (p.length < block) break;
    }
    if (got < len) throw new Error(`read past the end of the file at byte ${off + got}`);
    return out;
  }
  return src;
}

// A local File or Blob.
export function blobSource(blob) {
  const src = { url: blob.name || "local file", size: blob.size, requests: 0, bytes: 0 };
  src.read = async (off, len) => {
    src.requests++; src.bytes += len;
    if (off + len > blob.size) throw new Error(`read past the end of the file at byte ${blob.size}`);
    return new Uint8Array(await blob.slice(off, off + len).arrayBuffer());
  };
  return src;
}

// Bytes already in memory (tests).
export function bufferSource(u8) {
  const src = { url: "buffer", size: u8.length, requests: 0, bytes: 0 };
  src.read = async (off, len) => {
    src.requests++; src.bytes += len;
    if (off + len > u8.length) throw new Error(`read past the end of the file at byte ${u8.length}`);
    return u8.subarray(off, off + len);
  };
  return src;
}

// ---------------------------------------------------------------- TIFF

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

export const TAG = {
  NewSubfileType: 254, ImageWidth: 256, ImageLength: 257, BitsPerSample: 258, Compression: 259,
  Photometric: 262, StripOffsets: 273, SamplesPerPixel: 277, RowsPerStrip: 278, StripByteCounts: 279,
  PlanarConfig: 284, Predictor: 317, TileWidth: 322, TileLength: 323, TileOffsets: 324,
  TileByteCounts: 325, ExtraSamples: 338, SampleFormat: 339, ModelPixelScale: 33550,
  ModelTiepoint: 33922, ModelTransformation: 34264, GeoKeyDirectory: 34735, GeoDoubleParams: 34736,
  GeoAsciiParams: 34737, GDAL_METADATA: 42112, GDAL_NODATA: 42113
};
const LAZY = new Set([TAG.StripOffsets, TAG.StripByteCounts, TAG.TileOffsets, TAG.TileByteCounts]);
const WANT = new Set(Object.values(TAG).filter((t) => !LAZY.has(t)));

const COMPRESSION = { 1: "none", 5: "LZW", 6: "old JPEG", 7: "JPEG", 8: "Deflate", 32773: "PackBits", 32946: "Deflate", 34712: "JPEG 2000", 34887: "LERC", 34925: "LZMA", 50000: "ZSTD", 50001: "WebP", 50002: "JPEG XL" };

function decode(u8, type, count, le) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (type === 2) {
    let s = "";
    for (let i = 0; i < count; i++) s += String.fromCharCode(u8[i]);
    return s.replace(/\0+$/, "");
  }
  const sz = TYPE_SIZE[type], out = new Array(count);
  for (let i = 0, o = 0; i < count; i++, o += sz) {
    switch (type) {
      case 1: case 7: out[i] = dv.getUint8(o); break;
      case 6: out[i] = dv.getInt8(o); break;
      case 3: out[i] = dv.getUint16(o, le); break;
      case 8: out[i] = dv.getInt16(o, le); break;
      case 4: out[i] = dv.getUint32(o, le); break;
      case 9: out[i] = dv.getInt32(o, le); break;
      case 5: out[i] = dv.getUint32(o, le) / dv.getUint32(o + 4, le); break;
      case 10: out[i] = dv.getInt32(o, le) / dv.getInt32(o + 4, le); break;
      case 11: out[i] = dv.getFloat32(o, le); break;
      case 12: out[i] = dv.getFloat64(o, le); break;
      case 16: case 18: out[i] = Number(dv.getBigUint64(o, le)); break;
      case 17: out[i] = Number(dv.getBigInt64(o, le)); break;
      default: out[i] = NaN;
    }
  }
  return out;
}

// The IFD chain, with the tags the structure needs read; tile and strip
// offsets stay lazy (they can be large) and are read element by element.
export async function readTiff(src) {
  const head = await src.read(0, 16);
  const order = String.fromCharCode(head[0], head[1]);
  if (order !== "II" && order !== "MM") throw new Error("not a TIFF file (no II or MM byte order mark)");
  const le = order === "II";
  const dv = new DataView(head.buffer, head.byteOffset, 16);
  const magic = dv.getUint16(2, le);
  if (magic !== 42 && magic !== 43) throw new Error(`not a TIFF file (version ${magic})`);
  const big = magic === 43;
  const first = big ? Number(dv.getBigUint64(8, le)) : dv.getUint32(4, le);

  // GDAL's COG writer leaves its layout notes in a ghost area right after the header
  let ghost = null;
  const gAt = big ? 16 : 8;
  if (first > gAt + 43) {
    const g = await src.read(gAt, Math.min(first - gAt, 1024));
    const txt = String.fromCharCode(...g);
    const m = /^GDAL_STRUCTURAL_METADATA_SIZE=(\d+) bytes\n/.exec(txt);
    if (m) ghost = txt.slice(m[0].length, m[0].length + +m[1]).replace(/\0+$/, "").trim();
  }

  const ifds = [], seen = new Set();
  let off = first;
  while (off && !seen.has(off) && ifds.length < 256) {
    seen.add(off);
    const nb = await src.read(off, big ? 8 : 2);
    const ndv = new DataView(nb.buffer, nb.byteOffset, nb.byteLength);
    const n = big ? Number(ndv.getBigUint64(0, le)) : ndv.getUint16(0, le);
    const es = big ? 20 : 12, vs = big ? 8 : 4, at = off + (big ? 8 : 2);
    const body = await src.read(at, n * es + vs);
    const bdv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const entries = new Map();
    for (let i = 0; i < n; i++) {
      const o = i * es;
      const tag = bdv.getUint16(o, le), type = bdv.getUint16(o + 2, le);
      const count = big ? Number(bdv.getBigUint64(o + 4, le)) : bdv.getUint32(o + 4, le);
      const vo = o + (big ? 12 : 8);
      const size = (TYPE_SIZE[type] || 1) * count;
      const inline = size <= vs ? body.slice(vo, vo + vs) : null;
      const pos = inline ? at + vo : big ? Number(bdv.getBigUint64(vo, le)) : bdv.getUint32(vo, le);
      entries.set(tag, { tag, type, count, inline, pos });
    }
    const next = big ? Number(bdv.getBigUint64(n * es, le)) : bdv.getUint32(n * es, le);
    const ifd = { offset: off, end: at + n * es + vs, entries, values: new Map() };
    for (const [tag, e] of entries) {
      if (!WANT.has(tag)) continue;
      ifd.values.set(tag, await tagValue(src, e, le));
      if (!e.inline) ifd.end = Math.max(ifd.end, e.pos + TYPE_SIZE[e.type] * e.count);
    }
    ifds.push(ifd);
    off = next;
  }
  return { le, big, ifds, ghost, first };
}

async function tagValue(src, e, le) {
  const bytes = e.inline || (await src.read(e.pos, TYPE_SIZE[e.type] * e.count));
  return decode(bytes, e.type, e.count, le);
}

// one element of a lazy array (a tile offset or byte count)
export async function tagElement(src, tiff, e, i) {
  if (!e || i < 0 || i >= e.count) return null;
  const sz = TYPE_SIZE[e.type];
  const bytes = e.inline ? e.inline.subarray(i * sz, (i + 1) * sz) : await src.read(e.pos + i * sz, sz);
  return decode(bytes, e.type, 1, tiff.le)[0];
}

function dtypeName(fmt, bits) {
  const kind = fmt === 3 ? "float" : fmt === 2 ? "int" : fmt === 6 ? "complex float" : fmt === 5 ? "complex int" : "uint";
  return kind + bits;
}

export async function tiffStructure(src) {
  const tiff = await readTiff(src);
  const v = (ifd, tag, i = 0) => { const a = ifd.values.get(tag); return a === undefined ? undefined : typeof a === "string" ? a : a[i]; };
  const sub = (ifd) => v(ifd, TAG.NewSubfileType) || 0;
  const base = tiff.ifds.find((d) => !(sub(d) & 5)) || tiff.ifds[0];
  const W0 = v(base, TAG.ImageWidth), H0 = v(base, TAG.ImageLength);

  // where pixel (0, 0) is and how big pixels are
  const geo = { x0: 0, y0: 0, dx: 1, dy: -1, georeferenced: false, rotated: false };
  const keys = geoKeys(base);
  const mt = base.values.get(TAG.ModelTransformation);
  const tie = base.values.get(TAG.ModelTiepoint), scl = base.values.get(TAG.ModelPixelScale);
  if (mt && mt.length >= 16) {
    Object.assign(geo, { x0: mt[3], y0: mt[7], dx: mt[0], dy: mt[5], georeferenced: true, rotated: mt[1] !== 0 || mt[4] !== 0 });
  } else if (tie && tie.length >= 6 && scl && scl.length >= 2) {
    Object.assign(geo, { x0: tie[3] - tie[0] * scl[0], y0: tie[4] + tie[1] * scl[1], dx: scl[0], dy: -scl[1], georeferenced: true });
  }
  // a point-registered raster's tie point is a pixel centre
  if (geo.georeferenced && keys[1025] === 2) { geo.x0 -= geo.dx / 2; geo.y0 -= geo.dy / 2; geo.point = true; }

  const levels = [], masks = [];
  for (const [k, ifd] of tiff.ifds.entries()) {
    const s = sub(ifd);
    if (s & 4) { masks.push(k); continue; }
    if (ifd !== base && !(s & 1)) continue;
    const w = v(ifd, TAG.ImageWidth), h = v(ifd, TAG.ImageLength);
    const tiled = ifd.entries.has(TAG.TileWidth);
    const bands = v(ifd, TAG.SamplesPerPixel) || 1, planar = v(ifd, TAG.PlanarConfig) || 1;
    const fx = W0 / w, fy = H0 / h;
    levels.push(makeLevel({
      ifd: k, ifdOffset: ifd.offset, width: w, height: h,
      x0: geo.x0, y0: geo.y0, dx: geo.dx * fx, dy: geo.dy * fy,
      tiled, tileW: tiled ? v(ifd, TAG.TileWidth) : w,
      tileH: tiled ? v(ifd, TAG.TileLength) : Math.min(h, v(ifd, TAG.RowsPerStrip) || h),
      bands, planar,
      offsets: ifd.entries.get(tiled ? TAG.TileOffsets : TAG.StripOffsets),
      counts: ifd.entries.get(tiled ? TAG.TileByteCounts : TAG.StripByteCounts)
    }));
  }
  levels.sort((a, b) => b.width - a.width);
  levels.forEach((L, i) => { L.name = i === 0 ? "full resolution" : `overview ${i}`; L.factor = W0 / L.width; });

  const bits = base.values.get(TAG.BitsPerSample) || [1];
  const comp = v(base, TAG.Compression) || 1;
  const info = {
    format: tiff.big ? "BigTIFF" : "TIFF",
    byteOrder: tiff.le ? "little-endian" : "big-endian",
    compression: COMPRESSION[comp] || `code ${comp}`,
    predictor: v(base, TAG.Predictor) || 1,
    dtype: dtypeName(v(base, TAG.SampleFormat) || 1, bits[0]),
    bands: v(base, TAG.SamplesPerPixel) || 1,
    interleave: (v(base, TAG.PlanarConfig) || 1) === 2 ? "band" : "pixel",
    nodata: v(base, TAG.GDAL_NODATA),
    ghost: tiff.ghost,
    cog: !!(tiff.ghost && /LAYOUT=IFDS_BEFORE_DATA/.test(tiff.ghost)),
    ifds: tiff.ifds.length, masks: masks.length,
    rotated: geo.rotated, pointRegistered: !!geo.point,
    headerEnd: Math.max(...tiff.ifds.map((d) => d.end))
  };
  const crs = geo.georeferenced ? crsFromGeoKeys(keys) : null;
  return { kind: "tiff", crs, levels, info, tiff, extent: levelExtent(levels[0]) };
}

// GeoKeyDirectory as {key: value}
export function geoKeys(ifd) {
  const dir = ifd.values.get(TAG.GeoKeyDirectory);
  const out = {};
  if (!dir || dir.length < 4) return out;
  const dbl = ifd.values.get(TAG.GeoDoubleParams) || [], asc = ifd.values.get(TAG.GeoAsciiParams) || "";
  for (let i = 0; i < dir[3]; i++) {
    const [key, loc, count, val] = dir.slice(4 + 4 * i, 8 + 4 * i);
    if (loc === 0) out[key] = val;
    else if (loc === TAG.GeoDoubleParams) out[key] = count === 1 ? dbl[val] : dbl.slice(val, val + count);
    else if (loc === TAG.GeoAsciiParams) out[key] = asc.slice(val, val + count).replace(/\|$/, "");
  }
  return out;
}

// GeoTIFF geokeys to a CRS: an EPSG code when the file has one, otherwise a
// PROJ string built from the projection parameters for the common methods.
export function crsFromGeoKeys(k) {
  const citation = k[3073] || k[2049] || k[1026] || "";
  if (k[3072] && k[3072] > 0 && k[3072] < 32767) return { epsg: k[3072], citation };
  if (k[1024] === 2 && k[2048] && k[2048] < 32767) return { epsg: k[2048], citation };
  if (k[1024] === 2 || (!k[3075] && k[2048])) return { proj4: "+proj=longlat " + ellipsoid(k) + " +no_defs", citation };
  const ct = k[3075];
  if (!ct) return k[1024] ? { citation, unknown: true } : null;
  const g = (...ids) => { for (const id of ids) if (k[id] !== undefined) return k[id]; return 0; };
  const fe = g(3082, 3086, 3090), fn = g(3083, 3087, 3091);
  const units = { 9001: 1, 9002: 0.3048, 9003: 0.3048006096012192 }[k[3076] || 9001] || 1;
  const tail = ` +x_0=${fe * units} +y_0=${fn * units} ${ellipsoid(k)} +units=m${units !== 1 ? " +to_meter=" + units : ""} +no_defs`;
  let p = null;
  switch (ct) {
    case 1: p = `+proj=tmerc +lat_0=${g(3081, 3089)} +lon_0=${g(3080, 3088)} +k=${g(3092, 3093) || 1}`; break;
    case 7: p = `+proj=merc +lon_0=${g(3080, 3088)} +k=${g(3092) || 1}` + (k[3081] ? ` +lat_ts=${k[3081]}` : ""); break;
    case 8: case 11: p = `+proj=${ct === 8 ? "lcc" : "aea"} +lat_1=${g(3078)} +lat_2=${g(3079)} +lat_0=${g(3085, 3081, 3089)} +lon_0=${g(3084, 3080, 3088)}`; break;
    case 9: p = `+proj=lcc +lat_1=${g(3081)} +lat_0=${g(3081)} +lon_0=${g(3080)} +k_0=${g(3092) || 1}`; break;
    case 10: p = `+proj=laea +lat_0=${g(3089, 3081)} +lon_0=${g(3088, 3080)}`; break;
    case 12: p = `+proj=aeqd +lat_0=${g(3089, 3081)} +lon_0=${g(3088, 3080)}`; break;
    case 14: case 16: p = `+proj=${ct === 14 ? "stere" : "sterea"} +lat_0=${g(3081, 3089)} +lon_0=${g(3080, 3088)} +k=${g(3092) || 1}`; break;
    case 15: {
      const lat = g(3081, 3089);
      p = `+proj=stere +lat_0=${lat < 0 ? -90 : 90} +lon_0=${g(3095, 3080, 3088)}` + (k[3092] !== undefined && k[3092] !== 1 ? ` +k=${k[3092]}` : ` +lat_ts=${lat}`);
      break;
    }
    case 17: p = `+proj=eqc +lat_ts=${g(3078)} +lat_0=${g(3089)} +lon_0=${g(3088, 3080)}`; break;
    case 21: p = `+proj=ortho +lat_0=${g(3089, 3081)} +lon_0=${g(3088, 3080)}`; break;
    case 24: p = `+proj=sinu +lon_0=${g(3088, 3080)}`; break;
    default: return { citation, unknown: true, method: ct };
  }
  return { proj4: p + tail, citation };
}

function ellipsoid(k) {
  const e = k[2056], d = k[2050];
  if (d === 6326 || e === 7030) return "+datum=WGS84";
  if (e === 7019 || d === 6269 || d === 6258 || d === 6283) return "+ellps=GRS80";
  if (e === 7008) return "+ellps=clrk66";
  if (e === 7035 || e === 7047) return `+a=${k[2057] || 6371007.181} +b=${k[2057] || 6371007.181}`;
  if (k[2057]) {
    if (k[2058]) return `+a=${k[2057]} +b=${k[2058]}`;
    if (k[2059]) return `+a=${k[2057]} +rf=${k[2059]}`;
    return `+a=${k[2057]} +b=${k[2057]}`;
  }
  return "+datum=WGS84";
}

// File offsets of one tile (or strip). Band b in a band-interleaved file.
export async function tileBytes(src, s, L, index, band = 0) {
  const i = L.planar === 2 ? index + band * L.tilesX * L.tilesY : index;
  const offset = await tagElement(src, s.tiff, L.offsets, i);
  const length = await tagElement(src, s.tiff, L.counts, i);
  return offset === null ? null : { offset, length, index: i };
}

// Where each level's tiles sit in the file: from the first tile's offset to
// the end of the last, read as four numbers per level.
export async function tiffLayout(src, s) {
  const segs = [{ label: "header and IFDs", start: 0, end: s.info.headerEnd }];
  for (const L of s.levels) {
    const n = L.offsets ? L.offsets.count : 0;
    if (!n) continue;
    const a = await tagElement(src, s.tiff, L.offsets, 0);
    const b = await tagElement(src, s.tiff, L.offsets, n - 1), c = await tagElement(src, s.tiff, L.counts, n - 1);
    if (a && b) segs.push({ label: L.name, start: a, end: b + c, level: L, ordered: b >= a });
  }
  return segs;
}

// ---------------------------------------------------------------- CRS references

const GEOG = new Set([4326, 4258, 4269, 4283, 4167, 7844, 4979, 4617, 4612, 6668, 4674, 4019]);

// EPSG codes that need no lookup. Others are fetched by the page.
export function knownProj4(code) {
  code = +code;
  const W = "+datum=WGS84 +units=m +no_defs", G = "+ellps=GRS80 +units=m +no_defs";
  if (code === 4326 || code === 4979) return "+proj=longlat +datum=WGS84 +no_defs";
  if (GEOG.has(code)) return "+proj=longlat +ellps=GRS80 +no_defs";
  if ([3857, 900913, 102100, 102113, 3785].includes(code))
    return "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs";
  if (code >= 32601 && code <= 32660) return `+proj=utm +zone=${code - 32600} ${W}`;
  if (code >= 32701 && code <= 32760) return `+proj=utm +zone=${code - 32700} +south ${W}`;
  if (code >= 25828 && code <= 25838) return `+proj=utm +zone=${code - 25800} ${G}`;
  if (code >= 28348 && code <= 28358) return `+proj=utm +zone=${code - 28300} +south ${G}`;
  if (code >= 7846 && code <= 7859) return `+proj=utm +zone=${code - 7800} +south ${G}`;
  const t = {
    3395: `+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 ${W}`,
    3031: `+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +x_0=0 +y_0=0 ${W}`,
    3976: `+proj=stere +lat_0=-90 +lat_ts=-70 +lon_0=0 +x_0=0 +y_0=0 ${W}`,
    3412: "+proj=stere +lat_0=-90 +lat_ts=-70 +lon_0=0 +x_0=0 +y_0=0 +a=6378273 +b=6356889.449 +units=m +no_defs",
    3413: `+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +x_0=0 +y_0=0 ${W}`,
    3411: "+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +x_0=0 +y_0=0 +a=6378273 +b=6356889.449 +units=m +no_defs",
    3995: `+proj=stere +lat_0=90 +lat_ts=71 +lon_0=0 +x_0=0 +y_0=0 ${W}`,
    32661: `+proj=stere +lat_0=90 +lat_ts=90 +lon_0=0 +k=0.994 +x_0=2000000 +y_0=2000000 ${W}`,
    32761: `+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +k=0.994 +x_0=2000000 +y_0=2000000 ${W}`,
    3035: `+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 ${G}`,
    3577: `+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 ${G}`,
    9473: `+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 ${G}`,
    3338: `+proj=aea +lat_0=50 +lon_0=-154 +lat_1=55 +lat_2=65 +x_0=0 +y_0=0 ${G}`,
    5070: `+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 ${G}`,
    6933: `+proj=cea +lat_ts=30 +lon_0=0 +x_0=0 +y_0=0 ${W}`,
    6931: `+proj=laea +lat_0=90 +lon_0=0 +x_0=0 +y_0=0 ${W}`,
    6932: `+proj=laea +lat_0=-90 +lon_0=0 +x_0=0 +y_0=0 ${W}`,
    8857: `+proj=eqearth +lon_0=0 +x_0=0 +y_0=0 ${W}`,
    4087: `+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 ${W}`,
    54009: `+proj=moll +lon_0=0 +x_0=0 +y_0=0 ${W}`,
    54030: `+proj=robin +lon_0=0 +x_0=0 +y_0=0 ${W}`,
    2193: `+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 ${G}`,
    27700: "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +units=m +no_defs"
  };
  return t[code] || null;
}

// A CRS written any of the usual ways: EPSG:3031, urn:ogc:def:crs:EPSG::3031,
// http://www.opengis.net/def/crs/EPSG/0/3031, OGC CRS84, a PROJ string or WKT.
export function parseCrsRef(ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  if (typeof ref === "number") return { epsg: ref };
  if (typeof ref === "object") {
    if (ref.uri) return parseCrsRef(ref.uri);
    if (ref.wkt) return parseCrsRef(ref.wkt);
    if (ref.id && ref.id.code) return { epsg: +ref.id.code };
    if (ref.wkid || ref.latestWkid) return { epsg: ref.latestWkid || ref.wkid };
    return null;
  }
  const s = String(ref).trim();
  if (/CRS:?84|OGC\/[\d.]+\/CRS84/i.test(s) && !/^(PROJ|GEOG|GEOD|BOUND|COMPD)/i.test(s)) return { epsg: 4326, lonlat: true };
  if (/^\+|^proj=/.test(s)) return { proj4: s.startsWith("+") ? s : "+" + s };
  if (/^[A-Z]+\[/i.test(s)) {
    // WKT: the CRS's own identifier is the last ID or AUTHORITY, just before the closing brackets
    const ids = [...s.matchAll(/(?:ID|AUTHORITY)\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/gi)];
    const last = ids[ids.length - 1];
    const own = last && /^[\s\]]*$/.test(s.slice(last.index + last[0].length));
    return own ? { epsg: +last[1], wkt: s } : { wkt: s };
  }
  const m = /EPSG(?::+|\/\d+\/|\/)(\d+)\s*$/i.exec(s) || /^(\d{4,6})$/.exec(s);
  if (m) return { epsg: +m[1] };
  return { unknown: s };
}

export const isGeographicEpsg = (code) => GEOG.has(+code);

// ---------------------------------------------------------------- tile matrix sets

const OGC_PIXEL = 0.00028;                       // metres, the WMTS "standardized rendering pixel"
const DEG_M = (2 * Math.PI * 6378137) / 360;     // metres per degree for scale denominators

// The quadtree every slippy map uses.
export function webMercatorQuad(maxZoom = 18, minZoom = 0) {
  const R = 20037508.342789244, levels = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const n = 2 ** z, cell = (2 * R) / (256 * n);
    levels.push(makeLevel({ name: `zoom ${z}`, z, width: 256 * n, height: 256 * n, x0: -R, y0: R, dx: cell, dy: -cell, tileW: 256, tileH: 256, tilesX: n, tilesY: n }));
  }
  levels.reverse();   // finest first, as everywhere
  return { kind: "tms", tms: "WebMercatorQuad", crs: { epsg: 3857 }, levels, extent: [-R, -R, R, R], info: { scheme: "WebMercatorQuad" } };
}

// OGC Two Dimensional Tile Matrix Set JSON (version 2), or the 1.0 form.
export function tmsJsonStructure(j) {
  const crs = parseCrsRef(j.crs || j.supportedCRS);
  const mats = j.tileMatrices || j.tileMatrix || [];
  if (!mats.length) throw new Error("no tileMatrices in this tile matrix set");
  const ax = (j.orderedAxes || []).map((a) => String(a).toLowerCase());
  const swap = ax.length ? /^(lat|y$|n)/.test(ax[0]) && ax[0] !== "x" : !!(crs && crs.epsg && isGeographicEpsg(crs.epsg) && !crs.lonlat);
  const levels = mats.map((m) => {
    const cell = m.cellSize !== undefined ? m.cellSize : (m.scaleDenominator * OGC_PIXEL) / (crs && crs.epsg && isGeographicEpsg(crs.epsg) ? DEG_M : 1);
    let o = m.pointOfOrigin || m.topLeftCorner;
    if (swap) o = [o[1], o[0]];
    const bottom = m.cornerOfOrigin === "bottomLeft";
    return makeLevel({
      name: `matrix ${m.id ?? m.identifier}`, id: String(m.id ?? m.identifier), width: m.matrixWidth * m.tileWidth, height: m.matrixHeight * m.tileHeight,
      x0: o[0], y0: o[1], dx: cell, dy: bottom ? cell : -cell, tileW: m.tileWidth, tileH: m.tileHeight,
      tilesX: m.matrixWidth, tilesY: m.matrixHeight, variable: !!m.variableMatrixWidths
    });
  });
  levels.sort((a, b) => b.width * b.height - a.width * a.height);
  return { kind: "tms", tms: j.id || j.identifier || j.title || "", crs, levels, extent: levelExtent(levels[levels.length - 1]), info: { scheme: j.id || j.title || "tile matrix set", note: levels.some((L) => L.variable) ? "variable matrix widths near the poles are not drawn" : "" } };
}

// ---------------------------------------------------------------- tiny XML

export function parseXml(text) {
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const ent = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) =>
    ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e.toLowerCase()] ??
    String.fromCharCode(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)));
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += ent(m[6]);
    else if (m[3]) {
      if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
      const attrs = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].replace(/^.*:/, "")] = ent(a[2] ?? a[3]);
      const el = { name: m[3].replace(/^.*:/, ""), attrs, children: [], text: "" };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    }
  }
  return root;
}
const kids = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);
const kid = (el, name) => kids(el, name)[0];
const txt = (el, name) => { const c = kid(el, name); return c ? c.text.trim() : ""; };
function findAll(el, name, out = []) {
  for (const c of el.children) { if (c.name === name) out.push(c); findAll(c, name, out); }
  return out;
}

// WMTS GetCapabilities: the tile matrix set of one layer.
export function wmtsStructure(xml, { layer, tms } = {}) {
  const doc = typeof xml === "string" ? parseXml(xml) : xml;
  const caps = findAll(doc, "Capabilities")[0] || doc;
  const contents = kid(caps, "Contents");
  if (!contents) throw new Error("no Contents in this WMTS capabilities document");
  const sets = kids(contents, "TileMatrixSet").map((s) => ({ id: txt(s, "Identifier"), el: s }));
  const layers = kids(contents, "Layer").map((l) => ({
    id: txt(l, "Identifier"), title: txt(l, "Title"),
    sets: kids(l, "TileMatrixSetLink").map((k) => txt(k, "TileMatrixSet")),
    url: (kids(l, "ResourceURL").find((r) => r.attrs.resourceType === "tile") || { attrs: {} }).attrs.template || "",
    formats: kids(l, "Format").map((f) => f.text.trim())
  }));
  const lyr = layers.find((l) => l.id === layer) || layers[0] || null;
  const setId = tms && sets.some((s) => s.id === tms) ? tms : lyr && lyr.sets.find((id) => sets.some((s) => s.id === id)) || (sets[0] && sets[0].id);
  const set = sets.find((s) => s.id === setId);
  if (!set) throw new Error("no TileMatrixSet in this WMTS capabilities document");
  const crs = parseCrsRef(txt(set.el, "SupportedCRS"));
  const geog = crs && crs.epsg && isGeographicEpsg(crs.epsg);
  const swap = geog && !crs.lonlat && /EPSG/i.test(txt(set.el, "SupportedCRS"));
  const levels = kids(set.el, "TileMatrix").map((m) => {
    const scale = +txt(m, "ScaleDenominator"), cell = (scale * OGC_PIXEL) / (geog ? DEG_M : 1);
    let o = txt(m, "TopLeftCorner").split(/[\s,]+/).map(Number);
    if (swap) o = [o[1], o[0]];
    const tw = +txt(m, "TileWidth"), th = +txt(m, "TileHeight"), mw = +txt(m, "MatrixWidth"), mh = +txt(m, "MatrixHeight");
    return makeLevel({ name: `matrix ${txt(m, "Identifier")}`, id: txt(m, "Identifier"), scale, width: mw * tw, height: mh * th, x0: o[0], y0: o[1], dx: cell, dy: -cell, tileW: tw, tileH: th, tilesX: mw, tilesY: mh });
  });
  levels.sort((a, b) => b.width * b.height - a.width * a.height);
  return {
    kind: "wmts", crs, levels, extent: levelExtent(levels[levels.length - 1]),
    layers, layer: lyr && lyr.id, sets: sets.map((s) => s.id), tms: setId,
    template: lyr ? lyr.url : "",
    info: { scheme: setId, title: lyr ? lyr.title : "" }
  };
}

// ---------------------------------------------------------------- ArcGIS REST

export function arcgisStructure(j, url = "") {
  if (j.error) throw new Error(j.error.message || "ArcGIS server error");
  const sr = (j.tileInfo && j.tileInfo.spatialReference) || j.spatialReference || (j.extent && j.extent.spatialReference) || {};
  const code = sr.latestWkid || sr.wkid;
  const crs = code ? { epsg: code === 102100 ? 3857 : code } : sr.wkt ? parseCrsRef(sr.wkt) : null;
  const ext = j.fullExtent || j.extent || j.initialExtent;
  const e = ext ? [ext.xmin, ext.ymin, ext.xmax, ext.ymax] : null;
  const ti = j.tileInfo;
  const base = url.replace(/\?.*$/, "").replace(/\/+$/, "");
  if (ti && ti.lods && ti.lods.length) {
    const ox = ti.origin.x, oy = ti.origin.y, tw = ti.cols, th = ti.rows;
    const levels = ti.lods.map((l) => {
      const r = l.resolution;
      let c0 = 0, c1 = 0, r0 = 0, r1 = 0;
      if (e) {
        c0 = Math.max(0, Math.floor((e[0] - ox) / (tw * r))); c1 = Math.max(c0, Math.ceil((e[2] - ox) / (tw * r)) - 1);
        r0 = Math.max(0, Math.floor((oy - e[3]) / (th * r))); r1 = Math.max(r0, Math.ceil((oy - e[1]) / (th * r)) - 1);
      }
      const nx = c1 - c0 + 1, ny = r1 - r0 + 1;
      return makeLevel({ name: `level ${l.level}`, z: l.level, scale: l.scale, width: nx * tw, height: ny * th, x0: ox + c0 * tw * r, y0: oy - r0 * th * r, dx: r, dy: -r, tileW: tw, tileH: th, tilesX: nx, tilesY: ny, col0: c0, row0: r0 });
    });
    levels.sort((a, b) => b.width * b.height - a.width * a.height);
    return { kind: "arcgis", crs, levels, extent: e || levelExtent(levels[levels.length - 1]), template: base + "/tile/{z}/{y}/{x}", info: { scheme: "ArcGIS tile cache", title: j.documentInfo?.Title || j.name || j.mapName || "", format: ti.format, origin: [ox, oy] } };
  }
  // an image service without a tile cache: one grid of pixels
  if (e && j.pixelSizeX) {
    const w = Math.round((e[2] - e[0]) / j.pixelSizeX), h = Math.round((e[3] - e[1]) / j.pixelSizeY);
    const L = makeLevel({ name: "full resolution", width: w, height: h, x0: e[0], y0: e[3], dx: j.pixelSizeX, dy: -j.pixelSizeY, tiled: false, tileW: w, tileH: h });
    return { kind: "arcgis", crs, levels: [L], extent: e, info: { scheme: "image service, no tile cache", title: j.name || "", dtype: j.pixelType, bands: j.bandCount } };
  }
  throw new Error("this ArcGIS service has neither a tile cache nor a pixel size");
}

// ---------------------------------------------------------------- Zarr

const sp = (...p) => p.filter((x) => x !== "" && x !== undefined && x !== null).join("/");
const parent = (p) => p.split("/").slice(0, -1).join("/");

// getJson(path) resolves a path inside the store to parsed JSON, or null.
export async function zarrStructure(getJson, { variable = "" } = {}) {
  let v3 = await getJson("zarr.json"), zmeta = null, rootAttrs = {}, consolidated = null;
  if (v3) {
    rootAttrs = v3.attributes || {};
    consolidated = v3.consolidated_metadata && v3.consolidated_metadata.metadata;
  } else {
    zmeta = await getJson(".zmetadata");
    const md = zmeta && zmeta.metadata;
    const za = md ? md[".zattrs"] : await getJson(".zattrs");
    const zr = md ? md[".zarray"] : await getJson(".zarray");
    const zg = md ? md[".zgroup"] : zr ? null : await getJson(".zgroup");
    if (!za && !zr && !zg) throw new Error("no zarr.json, .zarray or .zgroup at this address");
    rootAttrs = za || {};
  }
  const version = v3 ? 3 : 2;

  async function node(path) {
    if (version === 3) {
      if (path === "") return norm3(v3);
      const c = consolidated && consolidated[path];
      return norm3(c || (await getJson(sp(path, "zarr.json"))));
    }
    const md = zmeta && zmeta.metadata;
    const look = async (f) => (md ? md[sp(path, f)] || null : await getJson(sp(path, f)));
    const zr = await look(".zarray"), za = (await look(".zattrs")) || {};
    if (zr) return { kind: "array", shape: zr.shape, chunks: zr.chunks, dims: za._ARRAY_DIMENSIONS || null, attrs: za, dtype: zr.dtype, codec: zr.compressor ? zr.compressor.id : "none" };
    const zg = await look(".zgroup");
    return zg || Object.keys(za).length ? { kind: "group", attrs: za } : null;
  }
  function norm3(j) {
    if (!j) return null;
    if (j.node_type === "group") return { kind: "group", attrs: j.attributes || {} };
    const codecs = j.codecs || [], shard = codecs.find((c) => c.name === "sharding_indexed");
    const inner = shard && shard.configuration.chunk_shape;
    const names = (shard ? shard.configuration.codecs || [] : codecs).map((c) => c.name).filter((n) => n !== "bytes" && n !== "transpose");
    return {
      kind: "array", shape: j.shape, chunks: j.chunk_grid && j.chunk_grid.configuration.chunk_shape, inner,
      dims: j.dimension_names || null, attrs: j.attributes || {}, dtype: j.data_type, codec: names.join(", ") || "none"
    };
  }
  // the arrays directly inside a group, where the store lists them
  function children(path) {
    const pre = path ? path + "/" : "";
    if (consolidated) return Object.keys(consolidated).filter((k) => k.startsWith(pre) && !k.slice(pre.length).includes("/")).map((k) => k);
    const md = zmeta && zmeta.metadata;
    if (md) return [...new Set(Object.keys(md).filter((k) => k.startsWith(pre) && /\/\.zarray$/.test(k)).map((k) => k.replace(/\/\.zarray$/, "")))].filter((k) => !k.slice(pre.length).includes("/"));
    return [];
  }
  async function pickArray(path) {
    const n = await node(path);
    if (!n) throw new Error(`nothing at ${path || "the root"} of this store`);
    if (n.kind === "array") return { path, n, group: null };
    if (variable) {
      const vn = await node(sp(path, variable));
      if (vn && vn.kind === "array") return { path: sp(path, variable), n: vn, group: n };
    }
    const cands = [];
    for (const c of children(path)) {
      const cn = await node(c);
      if (cn && cn.kind === "array" && cn.shape.length >= 2) cands.push({ path: c, n: cn, group: n });
    }
    // the biggest array is the data, not a coordinate
    cands.sort((a, b) => b.n.shape.length - a.n.shape.length || b.n.shape.reduce((s, x) => s * x, 1) - a.n.shape.reduce((s, x) => s * x, 1));
    if (cands.length) return cands[0];
    throw new Error(`${path || "the root"} is a group and the store does not list its arrays: give the variable name`);
  }

  // the levels: multiscales in any of its forms, or one array
  const ms = rootAttrs.multiscales;
  let entries = [], tmsDef = null;
  if (Array.isArray(ms) && ms[0] && ms[0].datasets) {
    entries = ms[0].datasets.map((d) => ({ path: d.path, ome: d.coordinateTransformations, axes: ms[0].axes }));
  } else if (ms && Array.isArray(ms.layout)) {
    entries = ms.layout.map((l) => ({ path: l.asset ?? l.path, layout: l }));
  } else if (ms && ms.tile_matrix_set) {
    tmsDef = typeof ms.tile_matrix_set === "string" ? (ms.tile_matrix_set === "WebMercatorQuad" ? webMercatorQuad(30) : null) : tmsJsonStructure(ms.tile_matrix_set);
    const ids = tmsDef ? tmsDef.levels.map((L) => L.id ?? String(L.z)) : [];
    const lim = ms.tile_matrix_limits || {};
    entries = (Object.keys(lim).length ? Object.keys(lim) : ids.slice().reverse()).map((id) => ({ path: id, matrix: tmsDef && tmsDef.levels.find((L) => (L.id ?? String(L.z)) === id), limits: lim[id] }));
  } else entries = [{ path: "" }];

  const levels = [];
  let crs = crsFromAttrs(rootAttrs);
  for (const e of entries) {
    let a;
    try { a = await pickArray(e.path); } catch (err) { if (entries.length > 1 && levels.length) continue; throw err; }
    const n = a.n, attrs = { ...rootAttrs, ...(a.group ? a.group.attrs : {}), ...n.attrs };
    let dims = n.dims || n.shape.map((_, i) => `dim_${i}`);
    const sd = attrs["spatial:dimensions"];
    let iy = n.shape.length - 2, ix = n.shape.length - 1;
    if (Array.isArray(sd) && sd.length === 2 && dims.includes(sd[0]) && dims.includes(sd[1])) { iy = dims.indexOf(sd[0]); ix = dims.indexOf(sd[1]); }
    const W = n.shape[ix], H = n.shape[iy];
    const L = {
      name: e.path || a.path || "array", path: a.path, width: W, height: H,
      tileW: n.chunks ? n.chunks[ix] : W, tileH: n.chunks ? n.chunks[iy] : H,
      inner: n.inner ? [n.inner[ix], n.inner[iy]] : null,
      dtype: n.dtype, codec: n.codec,
      extra: dims.map((d, i) => (i === ix || i === iy ? null : { dim: d, size: n.shape[i], chunk: n.chunks ? n.chunks[i] : n.shape[i] })).filter(Boolean),
      dims: [dims[iy], dims[ix]]
    };
    // where the pixels are
    const tr = (e.layout && e.layout["spatial:transform"]) || attrs["spatial:transform"];
    let gm = null;
    if (attrs.grid_mapping) { gm = await node(sp(parent(a.path), attrs.grid_mapping)); if (gm && !gm.attrs) gm = null; }
    const gt = gm && gm.attrs.GeoTransform ? String(gm.attrs.GeoTransform).trim().split(/\s+/).map(Number) : null;
    if (Array.isArray(tr) && tr.length >= 6) Object.assign(L, { x0: tr[2], y0: tr[5], dx: tr[0], dy: tr[4], geo: "spatial:transform" });
    else if (e.matrix) Object.assign(L, { x0: e.matrix.x0, y0: e.matrix.y0, dx: e.matrix.dx, dy: e.matrix.dy, geo: "tile matrix" });
    else if (gt && gt.length === 6) Object.assign(L, { x0: gt[0], y0: gt[3], dx: gt[1], dy: gt[5], geo: "GeoTransform" });
    if (L.dx !== undefined && attrs["spatial:registration"] === "node") { L.x0 -= L.dx / 2; L.y0 -= L.dy / 2; }
    if (e.ome && L.dx === undefined) {
      const s = (e.ome.find((t) => t.type === "scale") || {}).scale, t = (e.ome.find((t) => t.type === "translation") || {}).translation;
      if (s) Object.assign(L, { x0: (t ? t[ix] : 0) - s[ix] / 2, y0: (t ? t[iy] : 0) - s[iy] / 2, dx: s[ix], dy: s[iy], geo: "coordinateTransformations" });
    }
    if (!crs) crs = crsFromAttrs(attrs) || (gm && crsFromAttrs(gm.attrs));
    levels.push(L);
  }
  if (!levels.length) throw new Error("no arrays found for the levels of this store");
  levels.sort((a, b) => b.width - a.width);
  // levels without their own transform share the first level's extent
  const ref = levels.find((L) => L.dx !== undefined);
  for (const L of levels) {
    if (L.dx === undefined) {
      if (ref) Object.assign(L, { x0: ref.x0, y0: ref.y0, dx: (ref.dx * ref.width) / L.width, dy: (ref.dy * ref.height) / L.height, geo: ref.geo + " (scaled)" });
      else Object.assign(L, { x0: 0, y0: 0, dx: 1, dy: -1, geo: "none" });
    }
    Object.assign(L, makeLevel(L));
  }
  levels.forEach((L) => { L.factor = levels[0].width / L.width; if (levels.length > 1) L.name = `level ${L.name}`; });
  const geod = levels[0].geo !== "none" && levels[0].geo !== "coordinateTransformations";
  return {
    kind: "zarr", crs: geod ? crs : null, levels, extent: levelExtent(levels[0]),
    info: { format: `Zarr v${version}`, consolidated: !!(consolidated || zmeta), multiscales: entries.length > 1 || !!ms, variable: levels[0].path, dtype: levels[0].dtype, codec: levels[0].codec, georef: levels[0].geo, extra: levels[0].extra, dims: levels[0].dims }
  };
}

function crsFromAttrs(a) {
  if (!a) return null;
  for (const k of ["proj:code", "proj:epsg", "crs", "proj:wkt2", "crs_wkt", "spatial_ref", "proj:projjson", "epsg"]) {
    if (a[k] === undefined || a[k] === null) continue;
    const c = parseCrsRef(a[k]);
    if (c && !c.unknown) return c;
  }
  return null;
}

// ---------------------------------------------------------------- typed specs

// A grid spec: extent (xmin, xmax, ymin, ymax), dimension in pixels, tile
// size and number of levels (blank: halve until the level fits in one tile).
export function specStructure({ crs, extent, dim, tile = 512, levels = 0 }) {
  const [xmin, xmax, ymin, ymax] = extent, [W, H] = dim;
  if (!(xmax > xmin && ymax > ymin)) throw new Error("the extent needs xmin < xmax and ymin < ymax");
  if (!(W >= 1 && H >= 1)) throw new Error("the dimension needs at least one column and one row");
  const tw = Math.max(1, Math.round(tile)), dx = (xmax - xmin) / W, dy = -(ymax - ymin) / H;
  const out = [];
  for (let f = 1, i = 0; i < 40; i++, f *= 2) {
    const w = overviewSize(W, f), h = overviewSize(H, f);
    out.push(makeLevel({ name: i ? `overview ${i}` : "full resolution", factor: f, width: w, height: h, x0: xmin, y0: ymax, dx: (dx * W) / w, dy: (dy * H) / h, tileW: tw, tileH: tw }));
    if (levels ? out.length >= levels : w <= tw && h <= tw) break;
    if (w === 1 && h === 1) break;
  }
  return { kind: "spec", crs: parseCrsRef(crs), levels: out, extent: [xmin, ymin, xmax, ymax], info: { scheme: "typed spec" } };
}

// ---------------------------------------------------------------- kinds

export function guessKind(url) {
  const u = url.trim();
  if (/\{z\}/i.test(u) && /\{x\}/i.test(u)) return "xyz";
  if (/\.(tiff?|gtiff?|cog)(\?|#|$)/i.test(u)) return "tiff";
  if (/WMTSCapabilities|SERVICE=WMTS|\/wmts\b/i.test(u)) return "wmts";
  if (/\/(MapServer|ImageServer)\b/i.test(u)) return "arcgis";
  if (/\.zarr\b|zarr\.json|\.zmetadata|\.zattrs/i.test(u)) return "zarr";
  if (/tileMatrixSets?\b|TileMatrixSet/i.test(u) || /\.json(\?|$)/i.test(u)) return "tmsjson";
  return "";
}
