// Held byte ranges: a table of the ranges a page has read, with the bytes
// kept beside it, so the same range is not fetched twice.
//
// Each row is the byte-reference half of a byterefs row with the version of
// the file it was read from: { path, offset, size, version }. path is the
// address the bytes were read from; version is the checksum the store's ref
// carries for that file (an ETag, a last-modified time), or "" where it
// carries none. A virtual store's chunk is exactly such a range, so the
// table is keyed by what the store itself points at, not by a chunk's
// index: two stores (or two snapshots of one) that point at the same bytes
// share the held copy, a file rewritten in place and virtualized again is
// a different version and is read again, and the table can be written out
// and joined to a refs table on those columns.
//
// A read answered from the table costs no request. A read that is not held
// is fetched, kept and recorded; neighbours asked for together are fetched
// as one request and still recorded as the rows they are. A held range
// also answers any read that falls inside it. An object that never changes
// under its name (an Icechunk manifest, a snapshot) is held whole.
// The bytes held are the bytes as stored: encoded chunks, small and exact.
//
// No DOM. The bytes live in a backend: memory (Node, and the fallback), or
// IndexedDB in a browser so they outlast the page. Nothing is revalidated:
// only what a version or a name pins belongs here.

// held bytes can be fetched again: no need to wait for the disk
const RELAXED = { durability: "relaxed" };
const keyOf = (r) => `${r.path}\n${r.version}\n${r.offset}\n${r.size}`;

// rows kept in memory only
export function memoryBackend() {
  const bytes = new Map();
  return {
    kind: "memory",
    async load() { return []; },
    async read(key) { return bytes.get(key); },
    async writeMany(list) { for (const [key, , data] of list) bytes.set(key, data); },
    async touch() {},
    async removeMany(keys) { for (const k of keys) bytes.delete(k); },
    async clear() { bytes.clear(); }
  };
}

// Rows and bytes in IndexedDB (two object stores, so listing the rows does
// not read the bytes); null where there is no IndexedDB or it will not
// open. A transaction costs far more than what it carries (tens of
// milliseconds in some browsers), so reads asked for together share one,
// writes come a batch to a transaction, and so do the notes of when rows
// were last read.
export async function idbBackend(name = "heldrefs") {
  const idb = globalThis.indexedDB;
  if (!idb) return null;
  const wait = (req) => new Promise((ok, no) => { req.onsuccess = () => ok(req.result); req.onerror = () => no(req.error); });
  let db;
  try {
    // 2: rows carry a version (rows written before that are dropped)
    const req = idb.open(name, 2);
    req.onupgradeneeded = () => {
      for (const s of ["rows", "bytes"]) { if (req.result.objectStoreNames.contains(s)) req.result.deleteObjectStore(s); req.result.createObjectStore(s); }
    };
    db = await wait(req);
  } catch (e) { return null; }
  const done = (tx) => new Promise((ok, no) => { tx.oncomplete = () => ok(); tx.onerror = tx.onabort = () => no(tx.error); });
  const reading = [], touched = new Map();
  return {
    kind: "indexeddb",
    async load() { return wait(db.transaction("rows").objectStore("rows").getAll()); },
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
    async writeMany(list) {
      const tx = db.transaction(["rows", "bytes"], "readwrite", RELAXED);
      const rows = tx.objectStore("rows"), bytes = tx.objectStore("bytes");
      for (const [key, row, data] of list) {
        rows.put(row, key);
        // a buffer of its own (data may be a view into a larger one)
        bytes.put(data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.slice().buffer, key);
      }
      await done(tx);
    },
    async touch(key, row) {
      if (!touched.size) setTimeout(() => {
        const rows = [...touched]; touched.clear();
        try { const st = db.transaction("rows", "readwrite", RELAXED).objectStore("rows"); for (const [k, r] of rows) st.put(r, k); } catch (e) { /* a note only */ }
      }, 1000);
      touched.set(key, row);
    },
    async removeMany(keys) {
      const tx = db.transaction(["rows", "bytes"], "readwrite", RELAXED);
      const rows = tx.objectStore("rows"), bytes = tx.objectStore("bytes");
      for (const k of keys) { rows.delete(k); bytes.delete(k); touched.delete(k); }
      await done(tx);
    },
    async clear() {
      touched.clear();
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

const header = (h, name) => {
  if (!h) return null;
  if (typeof h.get === "function") return h.get(name);
  for (const k of Object.keys(h)) if (k.toLowerCase() === name) return h[k];
  return null;
};
// headers as a plain object, with some set (a null value takes one out)
const withHeaders = (h, set) => {
  const out = {};
  if (h && typeof h.forEach === "function") h.forEach((v, k) => { out[k] = v; });
  else for (const k of Object.keys(h || {})) out[k] = h[k];
  for (const name of Object.keys(set)) {
    for (const k of Object.keys(out)) if (k.toLowerCase() === name.toLowerCase()) delete out[k];
    if (set[name] !== null) out[name] = set[name];
  }
  return out;
};
// The version a request pins its file to: the conditional headers a store
// sends with a ref that carries a checksum
export const versionOf = (h) => [header(h, "if-match"), header(h, "if-unmodified-since")].filter(Boolean).join(" ");

class NotRange extends Error { constructor(res) { super("not a range"); this.res = res; this.taken = false; } }

// The table. limit: the most bytes to hold; past it the least recently
// read rows go, down to low of the limit, so that a full table is not
// trimmed on every write. gap: ranges read together that lie this close go
// as one request, of at most `most` bytes. now: a clock, for tests.
export function heldRefs({ backend = memoryBackend(), limit = 512 * 2 ** 20, low = 0.8, gap = 32768, most = 64 * 2 ** 20, now = () => Date.now() } = {}) {
  // path and version -> { rows sorted by offset, longest row }
  const files = new Map();
  const stats = { rows: 0, bytes: 0, hits: 0, misses: 0, requests: 0, bytesHeld: 0, bytesFetched: 0, kind: backend.kind };
  let failed = false;
  // bytes on their way into the backend
  const fresh = new Map();
  let writing = [], flushing = null;
  const busy = new Set();

  const fileKey = (path, version) => path + "\n" + version;
  // the index of the first row at or after offset
  const lower = (rows, offset) => {
    let lo = 0, hi = rows.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].offset < offset) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const insert = (row) => {
    const k = fileKey(row.path, row.version);
    let f = files.get(k);
    if (!f) files.set(k, (f = { rows: [], longest: 0 }));
    let i = lower(f.rows, row.offset);
    while (i < f.rows.length && f.rows[i].offset === row.offset && f.rows[i].size < row.size) i++;
    f.rows.splice(i, 0, row);
    if (row.size > f.longest) f.longest = row.size;
    stats.rows++; stats.bytes += row.size;
  };
  const drop = (row) => {
    const k = fileKey(row.path, row.version), f = files.get(k);
    if (!f) return false;
    let i = lower(f.rows, row.offset);
    while (i < f.rows.length && f.rows[i] !== row && f.rows[i].offset === row.offset) i++;
    if (f.rows[i] !== row) return false;
    f.rows.splice(i, 1);
    if (!f.rows.length) files.delete(k);
    stats.rows--; stats.bytes -= row.size;
    return true;
  };
  // A held row that covers [offset, offset + size): the search starts at the
  // last row that begins at or before offset and goes back only as far as
  // the file's longest row could still reach.
  const find = (path, offset, size, version = "") => {
    const f = files.get(fileKey(path, version));
    if (!f) return null;
    for (let i = lower(f.rows, offset + 1) - 1; i >= 0; i--) {
      const r = f.rows[i];
      if (r.offset + f.longest < offset + size) break;
      if (r.offset + r.size >= offset + size) return r;
    }
    return null;
  };
  // a whole object held under its name
  const findWhole = (path, version = "") => {
    const f = files.get(fileKey(path, version));
    if (!f) return null;
    for (let i = 0; i < f.rows.length && f.rows[i].offset === 0; i++) if (f.rows[i].whole) return f.rows[i];
    return null;
  };

  const ready = (async () => {
    let rows = [];
    try { rows = await backend.load(); } catch (e) { failed = true; }
    for (const r of rows) {
      if (!r || typeof r.path !== "string") continue;
      const row = { path: r.path, version: r.version || "", offset: r.offset, size: r.size, at: r.at || 0, n: r.n || 0 };
      if (r.whole) row.whole = true;
      insert(row);
    }
  })();

  async function evict() {
    if (stats.bytes <= limit) return;
    const all = [];
    for (const f of files.values()) for (const r of f.rows) all.push(r);
    all.sort((a, b) => a.at - b.at);
    const gone = [];
    for (const r of all) {
      if (stats.bytes <= limit * low) break;
      if (drop(r)) gone.push(keyOf(r));
    }
    for (const k of gone) fresh.delete(k);
    try { await backend.removeMany(gone); } catch (e) { /* the rows are gone from the table either way */ }
  }

  async function bytesOf(r) {
    const key = keyOf(r);
    let data = fresh.get(key);
    if (!data) { try { data = await backend.read(key); } catch (e) { data = undefined; } }
    // a row whose bytes have gone (storage cleared under us) is no row
    if (!data || data.length !== r.size) { drop(r); return null; }
    r.at = now(); r.n++;
    backend.touch(key, r).catch(() => {});
    return data;
  }

  // the bytes of a range if they are held, else null
  async function get(path, offset, size, version = "") {
    await ready;
    const r = find(path, offset, size, version);
    const data = r && await bytesOf(r);
    if (!data) return null;
    stats.hits++; stats.bytesHeld += size;
    return r.offset === offset && r.size === size ? data : data.subarray(offset - r.offset, offset - r.offset + size);
  }

  // Rows written together reach the backend together. The rows are in the
  // table at once; their bytes are served from memory until the write is in.
  function flushWrites() {
    const list = writing;
    writing = [];
    const w = backend.writeMany(list).then(
      () => { for (const [key] of list) fresh.delete(key); },
      () => { failed = true; for (const [key, row] of list) { fresh.delete(key); drop(row); } }
    ).then(evict).then(() => { busy.delete(w); });
    busy.add(w);
  }

  // Hold a range that was read.
  async function put(path, offset, data, version = "", whole = false) {
    await ready;
    hold(path, offset, data, version, whole);
  }
  // (the table must be ready)
  function hold(path, offset, data, version, whole) {
    if (!data || !data.length || data.length > limit) return;
    if (whole ? findWhole(path, version) : find(path, offset, data.length, version)) return;
    const row = { path, version, offset, size: data.length, at: now(), n: 1 };
    if (whole) row.whole = true;
    // rows this one covers are redundant
    const f = files.get(fileKey(path, version));
    if (f) {
      const gone = [];
      for (let i = lower(f.rows, offset); i < f.rows.length && f.rows[i].offset < offset + data.length; i++) {
        if (f.rows[i].offset + f.rows[i].size <= offset + data.length) gone.push(f.rows[i]);
      }
      for (const r of gone) { drop(r); fresh.delete(keyOf(r)); }
      if (gone.length) backend.removeMany(gone.map(keyOf)).catch(() => {});
    }
    insert(row);
    const key = keyOf(row);
    fresh.set(key, data);
    if (!writing.length) flushing = setTimeout(flushWrites, 0);
    writing.push([key, row, data]);
  }
  // every write so far is in the backend
  const settled = async () => {
    if (writing.length) { clearTimeout(flushing); flushWrites(); }
    while (busy.size) await Promise.all([...busy]);
  };

  // Ranges not held that are asked for together (in one turn of the event
  // loop) and lie within gap bytes of each other in one file go as one
  // request, and each comes back out of it as its own row: the rows stay
  // the ranges that were asked for (a store's refs), whatever was fetched.
  // A range asked for again while its request is out shares that request.
  const waiting = new Map(), flying = new Map();
  function flush(fk, path, version, read) {
    const batch = waiting.get(fk);
    waiting.delete(fk);
    const asks = [...batch.values()].sort((a, b) => a.offset - b.offset);
    const runs = [];
    for (const a of asks) {
      const r = runs[runs.length - 1];
      if (r && a.offset - r.end <= gap && Math.max(r.end, a.offset + a.size) - r.offset <= most) { r.asks.push(a); r.end = Math.max(r.end, a.offset + a.size); }
      else runs.push({ offset: a.offset, end: a.offset + a.size, asks: [a] });
    }
    for (const r of runs) {
      (async () => {
        const data = await read(path, r.offset, r.end - r.offset);
        stats.misses += r.asks.length; stats.requests++; stats.bytesFetched += data.length;
        // a short answer is handed back as it is, and not held
        const whole = data.length === r.end - r.offset;
        for (const a of r.asks) {
          const part = !whole ? data : r.asks.length === 1 ? data : data.slice(a.offset - r.offset, a.offset - r.offset + a.size);
          if (whole) hold(path, a.offset, part, version, false);
          a.ok(part);
        }
      })().catch((e) => { for (const a of r.asks) a.no(e); });
    }
  }

  // A range read through the table: held bytes, or fetched (once, however
  // many readers ask) and then held. read(path, offset, size) must return a
  // Uint8Array of that range, for any range of the file.
  async function range(path, offset, size, read, version = "") {
    const held = await get(path, offset, size, version);
    if (held) return held;
    const fk = fileKey(path, version), k = fk + "\n" + offset + "\n" + size;
    if (flying.has(k)) return flying.get(k);
    let batch = waiting.get(fk);
    if (!batch) {
      waiting.set(fk, (batch = new Map()));
      setTimeout(() => flush(fk, path, version, read), 0);
    }
    const ask = { offset, size };
    const p = new Promise((ok, no) => { ask.ok = ok; ask.no = no; });
    batch.set(offset + "\n" + size, ask);
    flying.set(k, p);
    const land = () => { if (flying.get(k) === p) flying.delete(k); };
    p.then(land, land);
    return p;
  }

  // A whole object read through the table, for one that never changes
  // under its name. read() must return its bytes.
  async function whole(path, read, version = "") {
    await ready;
    const r = findWhole(path, version);
    const data = r && await bytesOf(r);
    if (data) { stats.hits++; stats.bytesHeld += data.length; return data; }
    const k = fileKey(path, version) + "\nwhole";
    if (flying.has(k)) return flying.get(k);
    const p = (async () => {
      const got = await read();
      stats.misses++; stats.requests++; stats.bytesFetched += got.length;
      hold(path, 0, got, version, true);
      return got;
    })();
    flying.set(k, p);
    const land = () => { if (flying.get(k) === p) flying.delete(k); };
    p.then(land, land);
    return p;
  }

  // A fetch that answers ranged GETs from the table, shaped as a fetch
  // client ({ fetch(url, init) }). Anything that is not a plain "bytes=a-b"
  // GET goes straight through. Conditional headers name the version and
  // are not sent on (the table keeps to the version; a browser would ask
  // the server's leave to send them). Each answer is a Response: for
  // thousands of small ranges, icechunk() below costs less.
  function fetchClient(inner = (url, init) => globalThis.fetch(url, init)) {
    return {
      async fetch(url, init) {
        const method = ((init && init.method) || "GET").toUpperCase();
        const r = method === "GET" ? parseRange(header(init && init.headers, "range")) : null;
        if (!r) return inner(url, init);
        const version = versionOf(init.headers);
        let data;
        try {
          data = await range(String(url), r.offset, r.size, async (path, offset, size) => {
            // the range asked for here may be several readers' ranges joined
            const res = await inner(url, { ...init, headers: withHeaders(init.headers, { Range: `bytes=${offset}-${offset + size - 1}`, "If-Match": null, "If-Unmodified-Since": null }) });
            // only a 206 is the range that was asked for: anything else goes
            // back to its caller as it came, and is not held
            if (res.status !== 206) throw new NotRange(res);
            return new Uint8Array(await res.arrayBuffer());
          }, version);
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

  // The options that read an Icechunk store's virtual chunks through the
  // table: spread them into IcechunkStore.open(url, { ... }).
  //
  // icechunk-js hands withRangeCoalescing one range store for each file and
  // checksum, which returns bytes, so nothing is wrapped in a Response for
  // each chunk. That store does not say which file it reads, so the first
  // read of each asks it for one byte and takes the address, and the
  // checksum, from the request it makes: the fetch client below sees that
  // request as it is made and answers it without the network. If that does
  // not work (another icechunk-js may make its request later), the file is
  // read as it would be without the table: joined, not held.
  // validateChecksums is what makes icechunk-js put a ref's checksum on the
  // request; the headers that carry it are taken off again before a request
  // leaves, so no server is asked for leave to send them.
  function icechunk({ fetch = (url, init) => globalThis.fetch(url, init) } = {}) {
    let probe = null;
    const client = {
      fetch(url, init) {
        if (probe) {
          probe.path = String(url); probe.version = versionOf(init && init.headers);
          probe = null;
          return Promise.resolve(new Response(new Uint8Array(1), { status: 206 }));
        }
        const h = init && init.headers;
        return fetch(url, h ? { ...init, headers: withHeaders(h, { "If-Match": null, "If-Unmodified-Since": null }) } : init);
      }
    };
    const withRangeCoalescing = (raw) => {
      let who = null;
      const identify = async () => {
        const mine = {};
        let p;
        probe = mine;
        try { p = raw.getRange("/", { offset: 0, length: 1 }); } finally { if (probe === mine) probe = null; }
        try { await p; } catch (e) { /* no address: read it unheld */ }
        return typeof mine.path === "string" ? mine : null;
      };
      // joined as the table joins, for a file whose address was not learned
      const unheld = heldless(raw, gap, most);
      return {
        get: (key, options) => raw.get(key, options),
        async getRange(key, rng, options) {
          if (!rng || !("offset" in rng)) return raw.getRange(key, rng, options);
          // a store of many keys (icechunk-js's one store of all native
          // chunks) is not one file: no address to learn, joined key by key
          if (key !== "/") return unheld(key, rng);
          if (who === null) who = identify();
          const f = await who;
          if (!f) return unheld(key, rng);
          return range(f.path, rng.offset, rng.length, (path, offset, size) => raw.getRange(key, { offset, length: size }), f.version);
        }
      };
    };
    return { fetchClient: client, withRangeCoalescing, validateChecksums: true };
  }

  // An Icechunk Storage ({ getObject, exists, listPrefix }) whose objects
  // that never change under their names are read through the table:
  // snapshots, manifests and transaction logs are named by id, and chunks
  // by their content. base is the repository's address. Everything else
  // (the branch and tag refs, the repository's own file) passes through.
  function storage(inner, base, immutable = /^\/?(snapshots|manifests|transactions|chunks)\//) {
    const root = String(base).replace(/\/+$/, "") + "/";
    return {
      async getObject(path, rng, options) {
        if (!immutable.test(path)) return inner.getObject(path, rng, options);
        const p = root + String(path).replace(/^\/+/, "");
        if (rng) return range(p, rng.start, rng.end - rng.start, (_, offset, size) => inner.getObject(path, { start: offset, end: offset + size }, options));
        return whole(p, () => inner.getObject(path, undefined, options));
      },
      exists: (...a) => inner.exists(...a),
      listPrefix: (...a) => inner.listPrefix(...a)
    };
  }

  // the table as rows, in path, version and offset order
  function table() {
    const out = [];
    for (const k of [...files.keys()].sort()) {
      for (const r of files.get(k).rows) out.push({ path: r.path, offset: r.offset, size: r.size, version: r.version, whole: !!r.whole, last_read: r.at, reads: r.n });
    }
    return out;
  }

  async function clear() {
    await ready;
    await settled();
    files.clear(); fresh.clear();
    stats.rows = 0; stats.bytes = 0;
    try { await backend.clear(); } catch (e) { failed = true; }
  }

  return { ready, find, findWhole, get, put, range, whole, fetchClient, icechunk, storage, table, clear, settled, stats, get failed() { return failed; } };
}

// Reads of one range store joined as the table joins them, with nothing
// held. A store may serve many keys: only reads of one key are joined.
function heldless(raw, gap, most) {
  let asks = [];
  const flush = () => {
    const list = asks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.offset - b.offset));
    asks = [];
    const runs = [];
    for (const a of list) {
      const r = runs[runs.length - 1];
      if (r && r.key === a.key && a.offset - r.end <= gap && Math.max(r.end, a.offset + a.length) - r.offset <= most) { r.asks.push(a); r.end = Math.max(r.end, a.offset + a.length); }
      else runs.push({ key: a.key, offset: a.offset, end: a.offset + a.length, asks: [a] });
    }
    for (const r of runs) {
      raw.getRange(r.key, { offset: r.offset, length: r.end - r.offset }).then(
        (data) => { for (const a of r.asks) a.ok(data.slice(a.offset - r.offset, a.offset - r.offset + a.length)); },
        (e) => { for (const a of r.asks) a.no(e); });
    }
  };
  return (key, rng) => new Promise((ok, no) => {
    if (!asks.length) setTimeout(flush, 0);
    asks.push({ key, offset: rng.offset, length: rng.length, ok, no });
  });
}

// A table over IndexedDB where there is one, else over memory.
export async function openHeld(opts = {}) {
  const backend = (await idbBackend(opts.name)) || memoryBackend();
  const h = heldRefs({ ...opts, backend });
  await h.ready;
  return h;
}
