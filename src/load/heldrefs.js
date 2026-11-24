// Held byte ranges: a table of the ranges a page has read, with the bytes
// kept beside it, so the same range is not fetched twice.
//
// Each row is the byte-reference half of a byterefs row: { path, offset,
// size }, where path is the address the bytes were read from. A virtual
// store's chunk is exactly such a range, so the table is keyed by what the
// store itself points at, not by a chunk's index: two stores (or two
// snapshots of one) that point at the same bytes share the held copy, and
// the table can be written out and joined to a refs table on those three
// columns.
//
// A read answered from the table costs no request. A read that is not held
// is fetched, kept and recorded; neighbours asked for together are fetched
// as one request and still recorded as the rows they are. A held range
// also answers any read that falls inside it.
// The bytes held are the bytes as stored: encoded chunks, small and exact.
//
// No DOM. The bytes live in a backend: memory (Node, and the fallback), or
// IndexedDB in a browser so they outlast the page. Only ranges of objects
// that do not change belong here; nothing is revalidated.

// held bytes can be fetched again: no need to wait for the disk
const RELAXED = { durability: "relaxed" };
const keyOf = (path, offset, size) => `${path}\n${offset}\n${size}`;

// rows kept in memory only
export function memoryBackend() {
  const bytes = new Map();
  return {
    kind: "memory",
    async load() { return []; },
    async read(key) { return bytes.get(key); },
    async write(key, row, data) { bytes.set(key, data); },
    async touch() {},
    async remove(key) { bytes.delete(key); },
    async clear() { bytes.clear(); }
  };
}

// rows and bytes in IndexedDB (two object stores, so listing the rows does
// not read the bytes); null where there is no IndexedDB or it will not open
export async function idbBackend(name = "heldrefs") {
  const idb = globalThis.indexedDB;
  if (!idb) return null;
  const wait = (req) => new Promise((ok, no) => { req.onsuccess = () => ok(req.result); req.onerror = () => no(req.error); });
  let db;
  try {
    const req = idb.open(name, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("rows"); req.result.createObjectStore("bytes"); };
    db = await wait(req);
  } catch (e) { return null; }
  const done = (tx) => new Promise((ok, no) => { tx.oncomplete = () => ok(); tx.onerror = tx.onabort = () => no(tx.error); });
  const reading = [], touched = new Map();
  return {
    kind: "indexeddb",
    async load() { return wait(db.transaction("rows").objectStore("rows").getAll()); },
    // reads asked for together share a transaction, and so do the notes of
    // when rows were last read: a transaction each costs far more than the read
    read(key) {
      return new Promise((ok, no) => {
        if (!reading.length) setTimeout(() => {
          const batch = reading.splice(0);
          let store;
          try { store = db.transaction("bytes").objectStore("bytes"); } catch (e) { for (const r of batch) r.no(e); return; }
          for (const r of batch) {
            const req = store.get(r.key);
            req.onsuccess = () => r.ok(req.result ? new Uint8Array(req.result) : undefined);
            req.onerror = () => r.no(req.error);
          }
        }, 0);
        reading.push({ key, ok, no });
      });
    },
    async write(key, row, data) {
      const tx = db.transaction(["rows", "bytes"], "readwrite", RELAXED);
      tx.objectStore("rows").put(row, key);
      // a copy that owns its buffer (data may be a view into a larger one)
      tx.objectStore("bytes").put(data.slice().buffer, key);
      await done(tx);
    },
    async touch(key, row) {
      if (!touched.size) setTimeout(() => {
        const rows = [...touched]; touched.clear();
        try { const st = db.transaction("rows", "readwrite", RELAXED).objectStore("rows"); for (const [k, r] of rows) st.put(r, k); } catch (e) { /* a note only */ }
      }, 1000);
      touched.set(key, row);
    },
    async remove(key) {
      const tx = db.transaction(["rows", "bytes"], "readwrite", RELAXED);
      tx.objectStore("rows").delete(key); tx.objectStore("bytes").delete(key);
      await done(tx);
    },
    async clear() {
      const tx = db.transaction(["rows", "bytes"], "readwrite", RELAXED);
      tx.objectStore("rows").clear(); tx.objectStore("bytes").clear();
      await done(tx);
    }
  };
}

// "bytes=a-b" as { offset, size }; null for anything else (a suffix range,
// several ranges, no Range at all)
export function parseRange(h) {
  const m = /^bytes=(\d+)-(\d+)$/.exec(String(h || "").trim());
  if (!m) return null;
  const a = +m[1], b = +m[2];
  return b >= a ? { offset: a, size: b - a + 1 } : null;
}

const rangeHeader = (init) => {
  const h = init && init.headers;
  if (!h) return null;
  if (typeof h.get === "function") return h.get("Range");
  for (const k of Object.keys(h)) if (k.toLowerCase() === "range") return h[k];
  return null;
};

class NotRange extends Error { constructor(res) { super("not a range"); this.res = res; this.taken = false; } }

// headers with Range set to r, whatever shape they came in
const withRange = (h, r) => {
  const out = {};
  if (h && typeof h.forEach === "function") h.forEach((v, k) => { out[k] = v; });
  else for (const k of Object.keys(h || {})) out[k] = h[k];
  for (const k of Object.keys(out)) if (k.toLowerCase() === "range") delete out[k];
  out.Range = r;
  return out;
};

// The table. limit: the most bytes to hold (the least recently used rows go
// first); gap: ranges read together that lie this close go as one request,
// of at most `most` bytes; now: a clock, for tests.
export function heldRefs({ backend = memoryBackend(), limit = 512 * 2 ** 20, gap = 32768, most = 64 * 2 ** 20, now = () => Date.now() } = {}) {
  // path -> rows sorted by offset; each row { path, offset, size, at, n }
  const byPath = new Map();
  const stats = { rows: 0, bytes: 0, hits: 0, misses: 0, requests: 0, bytesHeld: 0, bytesFetched: 0, kind: backend.kind };
  let failed = false;
  // bytes on their way into the backend, and the writes carrying them
  const fresh = new Map(), writes = new Set();

  const insert = (row) => {
    let list = byPath.get(row.path);
    if (!list) byPath.set(row.path, (list = []));
    let i = list.length;
    while (i > 0 && list[i - 1].offset > row.offset) i--;
    list.splice(i, 0, row);
    stats.rows++; stats.bytes += row.size;
  };
  const drop = (row) => {
    const list = byPath.get(row.path);
    const i = list ? list.indexOf(row) : -1;
    if (i < 0) return;
    list.splice(i, 1);
    if (!list.length) byPath.delete(row.path);
    stats.rows--; stats.bytes -= row.size;
  };
  // a held row that covers [offset, offset + size)
  const find = (path, offset, size) => {
    const list = byPath.get(path);
    if (!list) return null;
    for (const r of list) {
      if (r.offset > offset) break;
      if (r.offset + r.size >= offset + size) return r;
    }
    return null;
  };

  const ready = (async () => {
    let rows = [];
    try { rows = await backend.load(); } catch (e) { failed = true; }
    for (const r of rows) if (r && typeof r.path === "string") insert({ path: r.path, offset: r.offset, size: r.size, at: r.at || 0, n: r.n || 0 });
  })();

  async function evict(keep) {
    if (stats.bytes <= limit) return;
    const all = [];
    for (const list of byPath.values()) for (const r of list) if (r !== keep) all.push(r);
    all.sort((a, b) => a.at - b.at);
    for (const r of all) {
      if (stats.bytes <= limit) break;
      drop(r);
      try { await backend.remove(keyOf(r.path, r.offset, r.size)); } catch (e) { /* the row is gone from the table either way */ }
    }
  }

  // the bytes of a range if they are held, else null
  async function get(path, offset, size) {
    await ready;
    const r = find(path, offset, size);
    if (!r) return null;
    const key = keyOf(r.path, r.offset, r.size);
    let data = fresh.get(key);
    if (!data) { try { data = await backend.read(key); } catch (e) { data = undefined; } }
    // a row whose bytes have gone (storage cleared under us) is no row
    if (!data || data.length !== r.size) { drop(r); return null; }
    r.at = now(); r.n++;
    backend.touch(keyOf(r.path, r.offset, r.size), r).catch(() => {});
    stats.hits++; stats.bytesHeld += size;
    return r.offset === offset && r.size === size ? data : data.subarray(offset - r.offset, offset - r.offset + size);
  }

  // Hold a range that was read. The row is in the table at once; its bytes
  // are written behind the reader (a browser's storage can take a third of
  // a second to say a write is safe), and served from memory until then.
  async function put(path, offset, data) {
    await ready;
    if (!data || !data.length || data.length > limit || find(path, offset, data.length)) return;
    const row = { path, offset, size: data.length, at: now(), n: 1 };
    // rows this one covers are redundant
    for (const r of (byPath.get(path) || []).slice()) {
      if (r.offset >= offset && r.offset + r.size <= offset + data.length) {
        drop(r);
        backend.remove(keyOf(r.path, r.offset, r.size)).catch(() => {});
      }
    }
    insert(row);
    const key = keyOf(path, offset, data.length);
    fresh.set(key, data);
    const w = backend.write(key, row, data).then(() => evict(row), () => { drop(row); failed = true; }).then(() => { fresh.delete(key); writes.delete(w); });
    writes.add(w);
  }
  // every write so far is in the backend
  const settled = async () => { while (writes.size) await Promise.all([...writes]); };

  // Ranges not held that are asked for together (in one turn of the event
  // loop) and lie within gap bytes of each other in one path go as one
  // request, and each comes back out of it as its own row: the rows stay
  // the ranges that were asked for (a store's refs), whatever was fetched.
  const waiting = new Map();
  function flush(path, read) {
    const batch = waiting.get(path);
    waiting.delete(path);
    const asks = [...batch.asks.values()].sort((a, b) => a.offset - b.offset);
    const runs = [];
    for (const a of asks) {
      const r = runs[runs.length - 1];
      if (r && a.offset - r.end <= gap && Math.max(r.end, a.offset + a.size) - r.offset <= most) { r.asks.push(a); r.end = Math.max(r.end, a.offset + a.size); }
      else runs.push({ offset: a.offset, end: a.offset + a.size, asks: [a] });
    }
    for (const r of runs) {
      (async () => {
        const data = await read(path, r.offset, r.end - r.offset);
        stats.misses++; stats.requests++; stats.bytesFetched += data.length;
        // a short answer is handed back as it is, and not held
        const whole = data.length === r.end - r.offset;
        for (const a of r.asks) {
          const part = whole ? data.slice(a.offset - r.offset, a.offset - r.offset + a.size) : data;
          if (whole) await put(path, a.offset, part);
          a.ok(part);
        }
      })().catch((e) => { for (const a of r.asks) a.no(e); });
    }
  }

  // A range read through the table: held bytes, or fetched (once, however
  // many readers ask together) and then held. read(path, offset, size) must
  // return a Uint8Array of that range, for any range.
  async function range(path, offset, size, read) {
    const held = await get(path, offset, size);
    if (held) return held;
    let batch = waiting.get(path);
    if (!batch) {
      waiting.set(path, (batch = { asks: new Map() }));
      setTimeout(() => flush(path, read), 0);
    }
    const k = offset + "\n" + size;
    let ask = batch.asks.get(k);
    if (!ask) {
      ask = { offset, size };
      ask.promise = new Promise((ok, no) => { ask.ok = ok; ask.no = no; });
      batch.asks.set(k, ask);
    }
    return ask.promise;
  }

  // A fetch that answers ranged GETs from the table, shaped as icechunk-js's
  // FetchClient ({ fetch(url, init) }) for a virtual store's chunk reads.
  // Anything that is not a plain "bytes=a-b" GET goes straight through.
  function fetchClient(inner = (url, init) => globalThis.fetch(url, init)) {
    return {
      async fetch(url, init) {
        const method = ((init && init.method) || "GET").toUpperCase();
        const r = method === "GET" ? parseRange(rangeHeader(init)) : null;
        if (!r) return inner(url, init);
        let data;
        try {
          data = await range(String(url), r.offset, r.size, async (path, offset, size) => {
            // the range asked for here may be several readers' ranges joined
            const res = await inner(url, { ...init, headers: withRange(init.headers, `bytes=${offset}-${offset + size - 1}`) });
            // only a 206 is the range that was asked for: anything else goes
            // back to its caller as it came, and is not held
            if (res.status !== 206) throw new NotRange(res);
            return new Uint8Array(await res.arrayBuffer());
          });
        } catch (e) {
          if (!(e instanceof NotRange)) throw e;
          // a response can be read once: readers that shared the request ask again
          if (e.taken) return inner(url, init);
          e.taken = true;
          return e.res;
        }
        return new Response(data, { status: 206, headers: { "Content-Length": String(data.length), "Content-Range": `bytes ${r.offset}-${r.offset + data.length - 1}/*` } });
      }
    };
  }

  // the table as rows, in path and offset order
  function table() {
    const out = [];
    for (const path of [...byPath.keys()].sort()) for (const r of byPath.get(path)) out.push({ path: r.path, offset: r.offset, size: r.size, last_read: r.at, reads: r.n });
    return out;
  }

  async function clear() {
    await ready;
    await settled();
    byPath.clear();
    stats.rows = 0; stats.bytes = 0;
    try { await backend.clear(); } catch (e) { failed = true; }
  }

  return { ready, find, get, put, range, fetchClient, table, clear, settled, stats, get failed() { return failed; } };
}

// A table over IndexedDB where there is one, else over memory.
export async function openHeld(opts = {}) {
  const backend = (await idbBackend(opts.name)) || memoryBackend();
  const h = heldRefs({ ...opts, backend });
  await h.ready;
  return h;
}
