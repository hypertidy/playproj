// The held byte-range table (src/load/heldrefs.js): ranges read once are
// answered from the table after, a held range answers reads inside it, the
// least recently read rows go when the table is full, and a virtual Icechunk
// store (test/make-held-fixture.py) read through it with icechunk-js and
// zarrita gives the values it should, with no request the second time.
import fs from "fs";
import http from "http";
import path from "path";
import { IcechunkStore, HttpStorage } from "icechunk-js";
import * as zarr from "zarrita";
import { heldRefs, memoryBackend, parseRange, versionOf } from "../src/load/heldrefs.js";

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---------------------------------------------------------------- the table

check(JSON.stringify(parseRange("bytes=10-19")) === '{"offset":10,"size":10}', "parseRange: bytes=10-19");
check(parseRange("bytes=-20") === null && parseRange("bytes=5-") === null && parseRange("bytes=0-1,4-5") === null && parseRange(undefined) === null, "parseRange: only a-b");

const blob = new Uint8Array(1000).map((_, i) => (i * 7) % 251);
{
  let clock = 0, reads = 0;
  const h = heldRefs({ limit: 300, low: 1, now: () => ++clock });
  const read = async (p, o, n) => { reads++; return blob.slice(o, o + n); };
  const a = await h.range("f", 100, 50, read);
  check(same(a, blob.slice(100, 150)) && reads === 1, "a range not held is read");
  const b = await h.range("f", 100, 50, read);
  check(same(b, blob.slice(100, 150)) && reads === 1 && h.stats.hits === 1, "a held range is not read again");
  const c = await h.range("f", 110, 20, read);
  check(same(c, blob.slice(110, 130)) && reads === 1, "a read inside a held range comes from it");
  await h.range("f", 140, 20, read);
  check(reads === 2, "a read that runs past a held range is read");
  await h.range("g", 100, 50, read);
  check(reads === 3, "the same range of another path is another row");
  // neighbours asked for together: one request, a row each
  {
    const h2 = heldRefs({ gap: 16 }), asked = [];
    const rd = async (p, o, n) => { asked.push([o, n]); return blob.slice(o, o + n); };
    const got = await Promise.all([h2.range("f", 300, 20, rd), h2.range("f", 200, 30, rd), h2.range("f", 240, 10, rd), h2.range("f", 700, 5, rd)]);
    check(same(got[0], blob.slice(300, 320)) && same(got[1], blob.slice(200, 230)) && same(got[2], blob.slice(240, 250)) && same(got[3], blob.slice(700, 705)), "ranges read together come back each as asked");
    check(JSON.stringify(asked) === "[[200,50],[300,20],[700,5]]", `near ranges go as one request: ${JSON.stringify(asked)}`);
    check(JSON.stringify(h2.table().map((r) => [r.offset, r.size])) === "[[200,30],[240,10],[300,20],[700,5]]", "and are held as the rows that were asked for");
  }
  // together: one request
  const before = reads;
  const [x, y] = await Promise.all([h.range("f", 500, 40, read), h.range("f", 500, 40, read)]);
  check(same(x, y) && reads === before + 1, "two readers of one range share a request");
  check(h.stats.bytes === 50 + 20 + 50 + 40 && h.stats.rows === 4, `rows and bytes held: ${h.stats.rows}, ${h.stats.bytes}`);
  // full: the least recently read go
  await h.range("f", 100, 50, read);
  await h.range("f", 600, 200, read);
  await h.settled();
  check(h.stats.bytes <= 300, `held bytes stay under the limit: ${h.stats.bytes}`);
  check(h.find("f", 600, 200) && h.find("f", 100, 50) && !h.find("g", 100, 50), "the least recently read rows are dropped first");
  // a range that covers held ones replaces them
  await h.range("f", 90, 80, read);
  check(h.table().filter((r) => r.path === "f" && r.offset >= 90 && r.offset < 170).length === 1, "a covering range replaces the rows it covers");
  const t = h.table();
  check(t.every((r) => typeof r.path === "string" && Number.isInteger(r.offset) && Number.isInteger(r.size) && r.version === ""), "table rows are path, offset, size, version");
  await h.clear();
  check(h.stats.rows === 0 && h.stats.bytes === 0 && !(await h.get("f", 600, 200)), "clear empties the table");
}

// a version is part of what a row is: the same range of a file that has changed is read again
{
  let reads = 0;
  const h = heldRefs(), read = async (p, o, n) => { reads++; return blob.slice(o, o + n); };
  await h.range("f", 10, 20, read, "etag-1");
  await h.range("f", 10, 20, read, "etag-1");
  check(reads === 1, "a range of one version is read once");
  await h.range("f", 10, 20, read, "etag-2");
  await h.range("f", 10, 20, read);
  check(reads === 3 && h.stats.rows === 3, "the same range of another version, or of none, is another row");
  check(JSON.stringify(h.table().map((r) => r.version)) === '["","etag-1","etag-2"]', "the table says which version each row is");
  check(versionOf({ "If-Match": '"abc"', Range: "bytes=0-1" }) === '"abc"' && versionOf(new Headers({ "if-unmodified-since": "x" })) === "x" && versionOf({}) === "", "versionOf reads the conditional headers");
}

// a range asked for again while its request is out shares it, in whatever turn it is asked
{
  let reads = 0, release;
  const gate = new Promise((ok) => { release = ok; });
  const h = heldRefs(), read = async (p, o, n) => { reads++; await gate; return blob.slice(o, o + n); };
  const a = h.range("f", 0, 8, read);
  await new Promise((ok) => setTimeout(ok, 20));
  const b = h.range("f", 0, 8, read);
  await new Promise((ok) => setTimeout(ok, 20));
  release();
  check(same(await a, await b) && reads === 1, `a range in flight is not fetched again (${reads} reads)`);
}

// many small rows: written a batch to a call, and trimmed to the low mark, not on every write
{
  const be = memoryBackend();
  let writes = 0, removes = 0;
  const backend = { ...be, writeMany: async (l) => { writes++; return be.writeMany(l); }, removeMany: async (k) => { removes++; return be.removeMany(k); } };
  let clock = 0;
  const h = heldRefs({ backend, limit: 4000, low: 0.5, gap: 0, now: () => ++clock });
  const read = async (p, o, n) => new Uint8Array(n).fill(o % 251);
  await Promise.all(Array.from({ length: 300 }, (_, i) => h.range("f", i * 20, 10, read)));
  await h.settled();
  check(writes === 1, `300 rows read together are written in one call (${writes})`);
  check(h.stats.rows === 300 && h.find("f", 2990 * 2, 10) && !h.find("f", 2990 * 2, 11), "each is its own row, found by offset");
  for (let k = 0; k < 20; k++) {
    await Promise.all(Array.from({ length: 10 }, (_, i) => h.range("g", (k * 10 + i) * 20, 10, read)));
    await h.settled();
  }
  check(h.stats.bytes <= 4000 && h.stats.bytes >= 2000, `a full table is trimmed to between the low mark and the limit (${h.stats.bytes})`);
  check(removes <= 2, `trimming is one pass each time the limit is passed, not one a write (${removes})`);
  check(h.find("g", 199 * 20, 10) && !h.find("f", 0, 10), "the newest rows stay and the oldest go");
  const got = await h.get("g", 199 * 20, 10);
  check(got && got[0] === (199 * 20) % 251, "and a row that stayed still has its bytes");
}

// a whole object held under its name
{
  let reads = 0;
  const h = heldRefs(), read = async () => { reads++; return blob.slice(0, 300); };
  const a = await h.whole("repo/manifests/M1", read), b = await h.whole("repo/manifests/M1", read);
  check(same(a, b) && reads === 1 && h.table()[0].whole === true, "an object read whole is read once");
  check(same(await h.range("repo/manifests/M1", 40, 10, async () => { reads++; return new Uint8Array(10); }), blob.slice(40, 50)) && reads === 1, "and answers ranged reads of it");
  await h.put("x", 0, blob.slice(0, 50));
  check(!h.findWhole("x"), "a range that starts at 0 is not taken for the whole object");
}

// rows a backend already holds are there on opening, and bytes that have
// gone from under a row make it no row
{
  const be = memoryBackend();
  const h1 = heldRefs({ backend: be });
  await h1.put("f", 0, blob.slice(0, 10));
  await h1.settled();
  const rows = h1.table().map((r) => ({ path: r.path, offset: r.offset, size: r.size, at: 1, n: 1 }));
  const h2 = heldRefs({ backend: { ...be, load: async () => rows } });
  check(same(await h2.get("f", 2, 4), blob.slice(2, 6)), "rows kept by the backend are held on opening");
  const h3 = heldRefs({ backend: { ...memoryBackend(), load: async () => rows } });
  check((await h3.get("f", 0, 10)) === null && h3.stats.rows === 0, "a row without its bytes is dropped");
}

// ---------------------------------------------------------------- over HTTP

const root = path.resolve(new URL("./fixtures/held/", import.meta.url).pathname);
const fx = JSON.parse(fs.readFileSync(path.join(root, "ocean.json")));
const seen = [], meta = [], conditional = [];
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  const buf = fs.readFileSync(p), m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (p.endsWith("ocean.bin")) seen.push(req.headers.range || ""); else meta.push(req.url);
  if (req.headers["if-match"] || req.headers["if-unmodified-since"]) conditional.push(req.url);
  if (m) {
    let a0, b0;
    if (m[1] === "") { a0 = Math.max(0, buf.length - +m[2]); b0 = buf.length - 1; } else { a0 = +m[1]; b0 = m[2] === "" ? buf.length - 1 : Math.min(+m[2], buf.length - 1); }
    const tag = /[?&]etag=([^&]+)/.exec(req.url);   // a file that says which version it is
    res.writeHead(206, { "content-range": `bytes ${a0}-${b0}/${buf.length}`, "content-length": b0 - a0 + 1, ...(tag ? { etag: `"${tag[1]}"` } : {}) });
    res.end(buf.subarray(a0, b0 + 1));
  } else { res.writeHead(200, { "content-length": buf.length }); res.end(buf); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
// the refs name an address that does not exist: the bytes are here
const there = (url, init) => fetch(String(url).replace("https://held.invalid/", base + "/"), init);

// the fetch client alone: a plain ranged GET is held, the rest pass through
{
  const h = heldRefs(), fc = h.fetchClient(there);
  const r1 = await fc.fetch(fx.location, { headers: { Range: "bytes=7-190" } });
  const b1 = new Uint8Array(await r1.arrayBuffer());
  const r2 = await fc.fetch(fx.location, { headers: new Headers({ range: "bytes=7-190" }) });
  const b2 = new Uint8Array(await r2.arrayBuffer());
  check(r1.status === 206 && r2.status === 206 && same(b1, b2) && b1.length === 184 && seen.length === 1, `a ranged GET is fetched once (${seen.length} requests)`);
  const r3 = await fc.fetch(fx.location, { headers: { Range: "bytes=-16" } });
  check(r3.status === 206 && seen.length === 2 && h.stats.rows === 1, "a suffix range passes through and is not held");
  const r4 = await fc.fetch(fx.location.replace("ocean.bin", "none.bin"), { headers: { Range: "bytes=0-9" } });
  check(r4.status === 404 && h.stats.rows === 1, "a failed read comes back as it is and is not held");
}

// the store: every level of one column at every time, through icechunk-js
async function readAll(h, how) {
  const store = await IcechunkStore.open(how === "client" ? `${base}/ocean.icechunk` : h.storage(new HttpStorage(`${base}/ocean.icechunk`), `${base}/ocean.icechunk`),
    how === "client" ? { fetchClient: h.fetchClient(there) } : h.icechunk({ fetch: there }));
  const arr = await zarr.open(store.resolve("/" + fx.variable), { kind: "array" });
  const [row, col] = fx.column, out = [];
  for (let t = 0; t < fx.shape[0]; t++) {
    const c = await zarr.get(arr, [t, null, row, col]);
    out.push(Array.from(c.data, (v) => (Number.isNaN(v) ? null : v)));
  }
  return out;
}
for (const how of ["client", "icechunk"]) {
  const h = heldRefs();
  seen.length = 0; meta.length = 0; conditional.length = 0;
  const v1 = await readAll(h, how);
  await h.settled();
  const n1 = seen.length, m1 = meta.length;
  check(JSON.stringify(v1) === JSON.stringify(fx.values), `${how}: values through the held table are the store's`);
  check(n1 > 0 && h.stats.rows > 0, `${how}: the first read fetched (${n1} requests, ${h.stats.rows} rows)`);
  // a new store over the same table: nothing more is fetched
  const v2 = await readAll(h, how);
  check(JSON.stringify(v2) === JSON.stringify(fx.values), `${how}: values the second time are the same`);
  check(seen.length === n1, `${how}: the second read made no request for chunks (${seen.length - n1})`);
  // the chunk rows are exactly the refs of the chunks read, in the file the refs name
  const t = h.table().filter((r) => r.path === fx.location);
  const [row, col] = fx.column, cy = Math.floor(row / fx.chunks[2]), cx = Math.floor(col / fx.chunks[3]);
  const want = fx.refs.filter((r) => { const k = r.key.split("/").map(Number); return k[2] === cy && k[3] === cx; });
  const rows = new Set(t.map((r) => r.offset + "," + r.size));
  check(want.length === fx.shape[0] * (fx.shape[1] / fx.chunks[1]) && t.length === want.length && want.every((r) => rows.has(r.offset + "," + r.size)),
    `${how}: the held rows are the refs of the chunks read, one each (${t.length} rows, ${want.length} refs)`);
  check(n1 < want.length, `${how}: neighbouring refs went as fewer requests (${n1} for ${want.length} chunks)`);
  check(conditional.length === 0, `${how}: no conditional header reached the server (${conditional.length})`);
  if (how === "icechunk") {
    // the options for an Icechunk store: the ref's checksum is the row's version, and the
    // repository's objects that are named by id are held whole
    check(t.every((r) => r.version.includes(fx.etag)), `icechunk: rows carry the ref's checksum as their version (${JSON.stringify(t[0].version)})`);
    const objs = h.table().filter((r) => r.path.startsWith(base + "/ocean.icechunk/"));
    check(objs.length > 0 && objs.every((r) => r.whole && /\/(snapshots|manifests|transactions|chunks)\//.test(r.path)),
      `icechunk: snapshots and manifests are held whole (${objs.map((r) => r.path.split("/").slice(-2, -1)[0]).join(", ")})`);
    const again = meta.slice(m1).filter((p) => /\/(snapshots|manifests|transactions|chunks)\//.test(p));
    check(again.length === 0, `icechunk: the second open fetched none of them again (${again.length})`);
    check(meta.slice(m1).length > 0, "icechunk: what can change (the branch) is still asked for");
  } else check(t.every((r) => r.version === ""), "client: without checksums on the request, rows have no version");
}

// a geotiff.js client: a file's ranges through the table, under the version
// the file itself gives
{
  const h = heldRefs(), bin = new Uint8Array(fs.readFileSync(path.join(root, "ocean.bin")));
  const url = `${base}/ocean.bin?etag=one`, n0 = seen.length;
  const c = await h.geotiff(url);
  check(c && c.url === url && c.version === 'etag "one"' && seen.length === n0 + 1, `the file is asked once which version it is (${c && c.version})`);
  const r1 = await c.request({ headers: { Range: "bytes=10-73" } });
  const d1 = new Uint8Array(await r1.getData());
  check(r1.ok && r1.status === 206 && same(d1, bin.slice(10, 74)) && r1.getHeader("content-range") === `bytes 10-73/${bin.length}` && r1.getHeader("Content-Type") === "application/octet-stream",
    `a range comes back as geotiff.js reads one (${r1.getHeader("content-range")})`);
  const n1 = seen.length;
  const [r2, r3] = await Promise.all([c.request({ headers: { Range: "bytes=10-73" } }), c.request({ headers: { Range: "bytes=20-29" } })]);
  check(seen.length === n1 && same(new Uint8Array(await r2.getData()), d1) && same(new Uint8Array(await r3.getData()), bin.slice(20, 30)), "held ranges, and ranges inside them, make no request");
  check((await r2.getData()) instanceof ArrayBuffer && (await r3.getData()).byteLength === 10, "the data is an ArrayBuffer of the range alone");
  const again = await h.geotiff(url);
  await again.request({ headers: { Range: "bytes=10-73" } });
  check(seen.length === n1 + 1, `the next visit asks only for the version (${seen.length - n1} request)`);
  const other = await h.geotiff(`${base}/ocean.bin?etag=two`);
  check(other.version === 'etag "two"' && h.find(url, 10, 64, 'etag "two"') === null, "another version of the file is not answered from the first's rows");
  check((await h.geotiff(`${base}/ocean.bin`)) === null, "a file that does not say which version it is gets no client");
  check((await h.geotiff(`${base}/none.bin`)) === null, "nor does one that cannot be read");
}

// a range store of many keys (icechunk-js keeps one for every native chunk):
// reads made together that start at the same offset are different objects
{
  const h = heldRefs();
  const objects = { "chunks/A": new Uint8Array(40).fill(1), "chunks/B": new Uint8Array(40).fill(2), "chunks/C": new Uint8Array(40).fill(3) };
  const asked = [];
  const raw = {
    get: async (key) => objects[key],
    getRange: async (key, r) => { asked.push(`${key} ${r.offset}+${r.length}`); return objects[key].slice(r.offset, r.offset + r.length); }
  };
  const st = h.icechunk({ fetch: there }).withRangeCoalescing(raw);
  const got = await Promise.all([st.getRange("chunks/B", { offset: 0, length: 10 }), st.getRange("chunks/A", { offset: 0, length: 10 }),
    st.getRange("chunks/C", { offset: 0, length: 10 }), st.getRange("chunks/A", { offset: 12, length: 8 })]);
  check(got.map((d) => `${d[0]}x${d.length}`).join(" ") === "2x10 1x10 3x10 1x8", `reads of several keys at once each get their own object (${got.map((d) => `${d[0]}x${d.length}`).join(" ")})`);
  check(asked.length === 3 && asked.includes("chunks/A 0+20"), `only reads of one key are joined (${asked.join(", ")})`);
  check(!asked.some((a) => a.startsWith("/ ")) && h.stats.rows === 0, "a store of many keys is not asked for an address, and is not held here");
}

server.close();
if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log("heldrefs ok");
