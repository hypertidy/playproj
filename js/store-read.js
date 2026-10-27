// Reading a Zarr or Icechunk store for the store page: open it, list its
// arrays, and describe where one variable's cells are and in which CRS.
//
// Icechunk repositories are read with icechunk-js (EarthyScience), plain
// Zarr with zarrita's FetchStore; both give zarrita an AsyncReadable, as in
// gridlook. Only metadata, 1D coordinates and the chunks asked for are read.
// It runs in Node too (the test reads the fixture stores through it).

import { IcechunkStore } from "icechunk-js";
import * as zarr from "zarrita";
import { zarrStructure, parseCrsRef } from "../src/core/structure.js";
import { cfProj, axisRole, axisOf, unitScale, gridOf, LAT_NAMES, LON_NAMES } from "../src/core/storecrs.js";

const ICECHUNK = "icechunk+";
const dec = new TextDecoder();
const trim = (u) => u.replace(/\/+$/, "");
const join = (...p) => p.filter((s) => s !== "" && s !== undefined && s !== null).join("/").replace(/^\/+/, "");
const parentOf = (p) => p.split("/").slice(0, -1).join("/");

// An s3:// or gs:// address as https, the way icechunk-js writes virtual refs.
export function httpUrl(url) {
  const u = url.trim();
  let m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(u);
  if (m) return `https://${m[1]}.s3.amazonaws.com/${m[2]}`;
  m = /^gc?s:\/\/([^/]+)\/?(.*)$/.exec(u);
  if (m) return `https://storage.googleapis.com/${m[1]}/${m[2]}`;
  return u;
}

export const looksIcechunk = (url) => url.startsWith(ICECHUNK) || /\.icechunk\/?$/.test(url.split(/[?#]/)[0]);

async function tryIcechunk(url) {
  try { return await IcechunkStore.open(url); } catch (e) { return null; }
}

// Open url as Icechunk (a repository root, maybe followed by a group path,
// as gridlook allows) or as Zarr. Returns
// { kind, url, group, store, getJson(path), arrays() -> [{ path, shape, dims }] }.
export async function openStore(raw) {
  let url = trim(httpUrl(raw.replace(/^icechunk\+/, "")));
  const forceIce = looksIcechunk(raw);
  let ice = null, group = "";
  // a Zarr store answers with metadata at its root; an Icechunk one does not
  const zj = forceIce ? null : await fetchJson(url + "/zarr.json");
  const zm = forceIce || zj ? null : await fetchJson(url + "/.zmetadata");
  if (!zj && !zm) {
    const parts = url.split("/");
    for (let i = parts.length; i >= 4 && !ice; i--) {
      ice = await tryIcechunk(parts.slice(0, i).join("/"));
      if (ice) { url = parts.slice(0, i).join("/"); group = parts.slice(i).join("/"); }
    }
    if (!ice) throw new Error(forceIce ? "could not open this Icechunk repository: is it public, and does it allow reads from other sites?" :
      "no Zarr metadata or Icechunk repository at this address (or the server does not allow reads from other sites)");
  }
  if (ice) {
    const store = group ? ice.resolve(group) : ice;
    const getJson = async (p) => {
      const b = await ice.get("/" + join(group, p));
      return b ? JSON.parse(dec.decode(b)) : null;
    };
    const arrays = () => ice.listNodes()
      .filter((n) => n.nodeData.type === "array")
      .map((n) => { const m = ice.getMetadata(n.path) || {}; return { path: n.path.replace(/^\//, ""), shape: m.shape || [], dims: m.dimension_names || null }; })
      .filter((a) => !group || a.path.startsWith(group + "/"))
      .map((a) => ({ ...a, path: group ? a.path.slice(group.length + 1) : a.path }));
    return { kind: "icechunk", url, group, root: ice, store, getJson, arrays, open: (p) => zarr.open(ice.resolve("/" + join(group, p)), { kind: "array" }) };
  }
  const fs = new zarr.FetchStore(url);
  const cache = new Map();
  const getJson = async (p) => {
    if (!cache.has(p)) cache.set(p, fetchJson(url + "/" + p));
    return cache.get(p);
  };
  const arrays = () => {
    if (zj) {
      const md = (zj.consolidated_metadata && zj.consolidated_metadata.metadata) || {};
      return Object.entries(md).filter(([, m]) => m.node_type === "array").map(([p, m]) => ({ path: p, shape: m.shape, dims: m.dimension_names || null }));
    }
    const md = zm.metadata || {};
    return Object.keys(md).filter((k) => k.endsWith("/.zarray")).map((k) => {
      const p = k.slice(0, -"/.zarray".length), za = md[p + "/.zattrs"] || {};
      return { path: p, shape: md[k].shape, dims: za._ARRAY_DIMENSIONS || null };
    });
  };
  return { kind: zj ? "zarr3" : "zarr2", url, group: "", store: fs, getJson, arrays, open: (p) => zarr.open(zarr.root(fs).resolve(p), { kind: "array" }) };
}

// A local Zarr store: the files of a folder the viewer picked (an
// <input webkitdirectory> FileList), keyed by their path inside it.
// Nothing leaves the browser.
export function openFiles(files) {
  const map = new Map();
  let top = "";
  for (const f of files) {
    const rel = f.webkitRelativePath || f.name;
    top = top || rel.split("/")[0];
    map.set(rel.split("/").slice(1).join("/"), f);
  }
  const bytes = async (k) => { const f = map.get(k.replace(/^\/+/, "")); return f ? new Uint8Array(await f.arrayBuffer()) : undefined; };
  const store = { get: bytes };
  const getJson = async (p) => { const b = await bytes(p); if (!b) return null; try { return JSON.parse(dec.decode(b)); } catch (e) { return null; } };
  const arrays = () => {
    const out = [];
    for (const [k] of map) {
      const m = /^(.*?)\/?(zarr\.json|\.zarray)$/.exec(k);
      if (!m || !m[1]) continue;
      out.push({ path: m[1], file: k });
    }
    return out;
  };
  const open = (p) => zarr.open(zarr.root(store).resolve(p), { kind: "array" });
  return {
    kind: map.has("zarr.json") ? "zarr3" : "zarr2", url: "local:" + top, group: "", store, getJson, open, local: true,
    // shapes come from each array's metadata, read when listed
    async listArrays() {
      const out = [];
      for (const a of arrays()) {
        const j = await getJson(a.file);
        if (!j || (j.node_type && j.node_type !== "array")) continue;
        const za = j.node_type ? null : await getJson(a.path + "/.zattrs");
        out.push({ path: a.path, shape: j.shape || [], dims: j.dimension_names || (za && za._ARRAY_DIMENSIONS) || null });
      }
      return out;
    }
  };
}

async function fetchJson(url) {
  let r;
  try { r = await fetch(url); } catch (e) { return null; }
  if (!r.ok) return null;
  try { return await r.json(); } catch (e) { return null; }
}

// the arrays worth showing: two or more dimensions, biggest first
export function dataArrays(list) {
  return list.filter((a) => a.shape && a.shape.length >= 2)
    .sort((a, b) => b.shape.length - a.shape.length || b.shape.reduce((s, x) => s * x, 1) - a.shape.reduce((s, x) => s * x, 1));
}

// metadata of one node, v2 or v3, as { shape, chunks, inner, dims, attrs, dtype, codecs, fill }
async function nodeMeta(s, path) {
  const j = await s.getJson(join(path, "zarr.json"));
  if (j) {
    if (j.node_type !== "array") return { group: true, attrs: j.attributes || {} };
    const codecs = j.codecs || [], shard = codecs.find((c) => c.name === "sharding_indexed");
    const names = (shard ? shard.configuration.codecs || [] : codecs).map((c) => c.name).filter((n) => n !== "bytes" && n !== "transpose");
    return {
      version: 3, shape: j.shape, chunks: j.chunk_grid && j.chunk_grid.configuration && j.chunk_grid.configuration.chunk_shape,
      inner: shard ? shard.configuration.chunk_shape : null, dims: j.dimension_names || null, attrs: j.attributes || {},
      dtype: j.data_type, codecs: names, fill: j.fill_value, separator: j.chunk_key_encoding && j.chunk_key_encoding.configuration && j.chunk_key_encoding.configuration.separator
    };
  }
  const za = (await s.getJson(join(path, ".zarray")));
  if (!za) return null;
  const at = (await s.getJson(join(path, ".zattrs"))) || {};
  return {
    version: 2, shape: za.shape, chunks: za.chunks, inner: null, dims: at._ARRAY_DIMENSIONS || null, attrs: at,
    dtype: za.dtype, codecs: za.compressor ? [za.compressor.id] : [], fill: za.fill_value, separator: za.dimension_separator || "."
  };
}

const MAX_CURV = 16e6;
const unwrapped = (vals, lon) => {
  const v = Array.from(vals, Number);
  if (lon) for (let i = 1; i < v.length; i++) { while (v[i] - v[i - 1] > 180) v[i] -= 360; while (v[i] - v[i - 1] < -180) v[i] += 360; }
  return v;
};

// read a small 1D array whole
async function read1d(s, path, max = 1e6) {
  const m = await nodeMeta(s, path);
  if (!m || m.group || !m.shape || m.shape.length !== 1 || m.shape[0] > max) return null;
  const a = await s.open(path);
  const v = await zarr.get(a);
  // CF packing (GOES stores its scan angles as scaled int16)
  const sf = Number(m.attrs.scale_factor ?? 1), ao = Number(m.attrs.add_offset ?? 0);
  if (sf !== 1 || ao !== 0) return { values: Float64Array.from(v.data, (x) => Number(x) * sf + ao), attrs: m.attrs };
  return { values: v.data, attrs: m.attrs };
}

// Where the cells of the variable at path are, and in which CRS:
// { path, meta, dims, ix, iy, grid (storecrs.gridOf), crs (a cfProj()-like
// description or null), crsFrom, notes[] }.
export async function describeVariable(s, path) {
  const meta = await nodeMeta(s, path);
  if (!meta || meta.group) throw new Error(`${path || "the root"} is not an array`);
  const nd = meta.shape.length;
  if (nd < 2) throw new Error(`${path} has ${nd} dimension: there is no grid to draw`);
  const dims = meta.dims || meta.shape.map((_, i) => `dim_${i}`);
  const dir = parentOf(path), notes = [];

  // which dimensions are the grid: the roles of their coordinate variables
  const coords = await Promise.all(dims.map(async (d) => {
    const m = await nodeMeta(s, join(dir, d)).catch(() => null);
    return m && !m.group ? m : null;
  }));
  const role = dims.map((d, i) => axisRole(d, coords[i] ? coords[i].attrs : {}));
  let ix = role.findIndex((r) => r === "lon" || r === "x" || r === "rlon");
  let iy = role.findIndex((r) => r === "lat" || r === "y" || r === "rlat");
  if (ix < 0 || iy < 0 || ix === iy) { iy = nd - 2; ix = nd - 1; }
  const nx = meta.shape[ix], ny = meta.shape[iy];

  // the grid mapping, if the variable names one
  let gmName = typeof meta.attrs.grid_mapping === "string" ? meta.attrs.grid_mapping.split(/[\s:]+/)[0] : null;
  let gm = gmName ? await nodeMeta(s, join(dir, gmName)).catch(() => null) : null;
  // no grid_mapping attribute: a CRS variable listed in "coordinates" (as
  // rioxarray writes it) or a sibling named spatial_ref or crs
  if (!gmName) {
    const cands = [...(typeof meta.attrs.coordinates === "string" ? meta.attrs.coordinates.split(/\s+/) : []), "spatial_ref", "crs"];
    for (const c of new Set(cands)) {
      const m = await nodeMeta(s, join(dir, c)).catch(() => null);
      if (m && m.attrs && (m.attrs.grid_mapping_name || m.attrs.crs_wkt || m.attrs.spatial_ref)) { gmName = c; gm = m; break; }
    }
  }
  const gma = gm ? gm.attrs : null;

  // an affine transform, where the store has one (structure.js reads them all)
  let t = null, crsRef = null;
  try {
    const st = await zarrStructure(s.getJson, { variable: path });
    const L = st.levels[0];
    if (L && L.geo && L.geo !== "none" && L.geo !== "coordinateTransformations" && L.width === nx && L.height === ny)
      t = { x0: L.x0, y0: L.y0, dx: L.dx, dy: L.dy, geo: L.geo };
    crsRef = st.crs;
  } catch (e) { /* no transform: the coordinates say where the cells are */ }

  // the CRS: CF grid mapping parameters first, then a code or WKT
  let crs = null, crsFrom = "";
  const cf = gma ? cfProj(gma) : null;
  if (cf) { crs = cf; crsFrom = `grid_mapping "${gmName}" (${gma.grid_mapping_name})`; }
  if (gma) {
    const ref = parseCrsRef(gma.crs_wkt || gma.spatial_ref || gma["proj:wkt2"] || gma["proj:code"] || null);
    if (ref && ref.epsg && (!crs || crs.longlat)) { crs = { ...ref, name: `EPSG:${ref.epsg}` }; crsFrom = `grid_mapping "${gmName}" (EPSG:${ref.epsg} in its WKT)`; }
    else if (ref && !crs) { crs = ref; crsFrom = `grid_mapping "${gmName}" (WKT)`; }
  }
  if (!crs && crsRef) { crs = crsRef; crsFrom = "the store's attributes"; }

  // 2D latitude and longitude along the grid: a curvilinear grid, unless a
  // grid mapping already says what x and y mean
  let curv = null;
  if (!t && !(crs && !crs.longlat)) {
    const names = new Set([...(typeof meta.attrs.coordinates === "string" ? meta.attrs.coordinates.split(/\s+/) : []), ...[...LAT_NAMES, ...LON_NAMES].flatMap((n) => [n, n.toUpperCase()])]);
    const two = {};
    for (const n of names) {
      if (!n) continue;
      const m = await nodeMeta(s, join(dir, n)).catch(() => null);
      if (!m || m.group || !m.shape || m.shape.length !== 2) continue;
      const md = m.dims || [];
      if (m.shape[0] !== ny || m.shape[1] !== nx || (md.length && (md[0] !== dims[iy] || md[1] !== dims[ix]))) continue;
      const r = axisRole(n, m.attrs);
      if ((r === "lat" || r === "lon") && !two[r]) two[r] = n;
    }
    if (two.lat && two.lon) {
      if (nx * ny > MAX_CURV) notes.push(`its 2D latitude and longitude (${nx} x ${ny}) are too big to read here: drawn in index space`);
      else {
        const [la, lo] = await Promise.all([s.open(join(dir, two.lat)), s.open(join(dir, two.lon))].map(async (p) => zarr.get(await p)));
        curv = { lat: la.data, lon: lo.data, names: [two.lat, two.lon] };
      }
    }
  }

  // without a transform, the coordinate arrays
  let x = null, y = null, xs = 1, ys = 1, xc = null, yc = null;
  if (!t && !curv) {
    const cx = coords[ix] ? await read1d(s, join(dir, dims[ix])) : null;
    const cy = coords[iy] ? await read1d(s, join(dir, dims[iy])) : null;
    if (cx && cy) {
      const lonlat = role[ix] === "lon" && role[iy] === "lat";
      x = axisOf(cx.values, { lon: lonlat || role[ix] === "rlon" });
      y = axisOf(cy.values);
      if (!lonlat && role[ix] !== "rlon") {
        const h = crs && /\+proj=geos\b/.test(crs.def || crs.proj4 || "") && gma ? Number(gma.perspective_point_height) || 0 : 0;
        xs = unitScale(cx.attrs.units, h); ys = unitScale(cy.attrs.units, h);
      }
      if (xs !== 1) notes.push(`x and y are in ${cx.attrs.units}: multiplied by ${xs} for the CRS, which is in metres`);
      // uneven but 1D (a Gaussian grid's latitudes, say): kept as they are
      if (!x.regular) xc = unwrapped(cx.values, lonlat || role[ix] === "rlon").map((v) => v * xs);
      if (!y.regular) yc = Array.from(cy.values, (v) => v * ys);
      if (xc || yc) notes.push(`the ${[xc && dims[ix], yc && dims[iy]].filter(Boolean).join(" and ")} coordinates are not evenly spaced (worst ${Math.max(x.dev, y.dev).toFixed(3)} of a step): cells drawn between the midpoints`);
      if (!crs && lonlat) { crs = { longlat: "+proj=longlat +datum=WGS84 +no_defs", name: "longitude, latitude" }; crsFrom = "latitude and longitude coordinates (WGS 84 assumed: the store names no datum)"; }
      if (!crs && role[ix] === "rlon") notes.push("rotated coordinates, but no grid_mapping says where the pole is");
    } else if (typeof meta.attrs.coordinates === "string") {
      notes.push(`its coordinates (${meta.attrs.coordinates}) are not along the grid's two dimensions: drawn in index space`);
    }
  }
  let grid = gridOf({ t, x, y, nx, ny, crs, xScale: xs, yScale: ys });
  if (grid && (xc || yc)) grid = { ...grid, kind: "rectilinear", xc, yc };
  if (curv) {
    grid = { x0: 0, dx: 1, y0: 0, dy: 1, nx, ny, kind: "curvilinear", geo: `2D ${curv.names.join(" and ")}`, lat: curv.lat, lon: curv.lon };
    crs = null; crsFrom = "";
    notes.push(`a curvilinear grid: each cell centre has its own latitude and longitude (${curv.names.join(", ")}), and no CRS makes the grid regular`);
  }
  if (!grid) notes.push("nothing in the store says where the cells are: drawn in index space");
  if (!crs && !curv) notes.push("no CRS found");
  return { path, meta, dims, ix, iy, role, grid, crs, crsFrom, gm: gma, notes };
}

// One chunk of the variable, as { data, shape } for the grid dimensions at
// cy, cx with every other dimension at index other[d] (its chunk).
export async function readChunk(s, v, cy, cx, other = {}) {
  const a = await s.open(v.path);
  const idx = v.meta.shape.map((_, d) => (d === v.iy ? cy : d === v.ix ? cx : Math.floor((other[d] || 0) / v.meta.chunks[d])));
  const c = await a.getChunk(idx);
  return { chunk: c, idx, array: a };
}

// A 2D slice of the grid dims at the given indices of the others, read in
// whole (for small arrays only: the page decides).
export async function readSlice(s, v, other = {}) {
  const a = await s.open(v.path);
  const sel = v.meta.shape.map((_, d) => (d === v.iy || d === v.ix ? null : other[d] || 0));
  const out = await zarr.get(a, sel);
  // zarr.get gives the grid dims in their own order; make it rows (y) by columns (x)
  return { data: out.data, ny: v.meta.shape[v.iy], nx: v.meta.shape[v.ix], transposed: v.ix < v.iy, stride: out.stride };
}
