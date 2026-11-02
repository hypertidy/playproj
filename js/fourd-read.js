// Reading for the 4D page: a registry entry opened as its description
// (flat/arrays.json) and its Icechunk store, and windows of it read through
// zarrita into a byte-budgeted cache. Every request goes through one fetch
// wrapper that counts reads, bytes and failures per host, so the page can
// say which hosts a browser can read. It runs in Node too.

import { IcechunkStore } from "icechunk-js";
import * as zarr from "zarrita";
import * as F from "../src/core/fourd.js";

// Per host: { ok, fail, bytes, ms, error }.
export const hosts = new Map();
const hostOf = (url) => { try { return new URL(url).host; } catch (e) { return String(url); } };
function note(url, fields) {
  const h = hostOf(url), s = hosts.get(h) || { ok: 0, fail: 0, bytes: 0, ms: 0, error: "" };
  if (fields.ok) { s.ok++; s.bytes += fields.bytes || 0; s.ms = fields.ms; } else { s.fail++; s.error = fields.error; }
  hosts.set(h, s);
}
let onFetch = null;
export const setFetchListener = (fn) => { onFetch = fn; };

export const fetchClient = {
  async fetch(url, init) {
    const t0 = Date.now();
    try {
      const r = await globalThis.fetch(url, init);
      if (!r.ok && r.status !== 206 && r.status !== 404) note(url, { ok: false, error: `HTTP ${r.status}` });
      else note(url, { ok: true, bytes: +(r.headers.get("content-length") || 0), ms: Date.now() - t0 });
      if (onFetch) onFetch();
      return r;
    } catch (e) {
      // a browser gives a bare TypeError when the host sends no CORS header
      note(url, { ok: false, error: "no response (blocked, unreachable, or no CORS header)" });
      if (onFetch) onFetch();
      throw e;
    }
  }
};

const metaCache = new Map();
async function getJson(url) {
  if (!metaCache.has(url)) {
    metaCache.set(url, (async () => {
      const r = await fetchClient.fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return r.json();
    })());
  }
  return metaCache.get(url);
}

// Open a registry entry: { entry, desc, meta, read(t, k, y0, y1, x0, x1) }.
// read returns physical values (NaN for missing), rows y0..y1-1 by columns
// x0..x1-1, for time index t and level k (k is ignored with no level); k
// as [k0, k1] reads those levels, level by level in the result.
export async function openDataset(entry, base) {
  if (entry.synthetic) {
    const s = F.syntheticOcean();
    const read = async (t, k, y0, y1, x0, x1) => {
      if (!Array.isArray(k)) return s.read(t, k, y0, y1, x0, x1);
      const n = (y1 - y0) * (x1 - x0), out = new Float32Array((k[1] - k[0]) * n);
      for (let kk = k[0]; kk < k[1]; kk++) out.set(s.read(t, kk, y0, y1, x0, x1), (kk - k[0]) * n);
      return out;
    };
    return { entry, desc: s.desc, meta: null, read };
  }
  const urls = F.storeUrls(base, entry);
  const meta = await getJson(urls.arrays);
  const desc = F.describe(meta, entry.var);
  const store = await IcechunkStore.open(urls.icechunk, { fetchClient });
  const arr = await zarr.open(zarr.root(store).resolve(entry.var), { kind: "array" });
  const read = async (t, k, y0, y1, x0, x1) => {
    const sel = desc.roles.map((r) => r === "t" ? t : r === "z" ? (Array.isArray(k) ? zarr.slice(k[0], k[1]) : (k ?? 0)) : r === "y" ? zarr.slice(y0, y1) : r === "x" ? zarr.slice(x0, x1) : 0);
    const c = await zarr.get(arr, sel);
    return F.unpack(c.data, desc, { valid: entry.valid || null });
  };
  return { entry, desc, meta, urls, read };
}

// A cache of decoded windows shared by every layer, keyed by dataset, time,
// level and window; in flight reads are shared too.
export function makeReader({ budget = 256 * 2 ** 20 } = {}) {
  const cache = new F.ByteLRU(budget);
  const inflight = new Map();
  const key = (ds, t, k, w) => `${ds.entry.id}|${t}|${k}|${w.join(",")}`;
  function slab(ds, t, k, w) {
    const kk = key(ds, t, k, w);
    const hit = cache.get(kk);
    if (hit) return Promise.resolve(hit);
    if (inflight.has(kk)) return inflight.get(kk);
    const p = ds.read(t, k, w[0], w[1], w[2], w[3]).then((v) => { cache.set(kk, v); inflight.delete(kk); return v; },
      (e) => { inflight.delete(kk); throw e; });
    inflight.set(kk, p);
    return p;
  }
  const cached = (ds, t, k, w) => cache.has(key(ds, t, k, w));
  return { slab, cached, cache };
}
