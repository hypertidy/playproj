// The held byte-range table (src/load/heldrefs.js): ranges read once are
// answered from the table after, a held range answers reads inside it, the
// least recently read rows go when the table is full, and a virtual Icechunk
// store (test/make-held-fixture.py) read through it with icechunk-js and
// zarrita gives the values it should, with no request the second time.
import fs from "fs";
import http from "http";
import path from "path";
import { IcechunkStore } from "icechunk-js";
import * as zarr from "zarrita";
import { heldRefs, memoryBackend, parseRange } from "../src/load/heldrefs.js";

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL " + msg); } };
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---------------------------------------------------------------- the table

check(JSON.stringify(parseRange("bytes=10-19")) === '{"offset":10,"size":10}', "parseRange: bytes=10-19");
check(parseRange("bytes=-20") === null && parseRange("bytes=5-") === null && parseRange("bytes=0-1,4-5") === null && parseRange(undefined) === null, "parseRange: only a-b");

const blob = new Uint8Array(1000).map((_, i) => (i * 7) % 251);
{
  let clock = 0, reads = 0;
  const h = heldRefs({ limit: 300, now: () => ++clock });
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
  check(t.every((r) => typeof r.path === "string" && Number.isInteger(r.offset) && Number.isInteger(r.size)), "table rows are path, offset, size");
  await h.clear();
  check(h.stats.rows === 0 && h.stats.bytes === 0 && !(await h.get("f", 600, 200)), "clear empties the table");
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
const seen = [];
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  const buf = fs.readFileSync(p), m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (p.endsWith("ocean.bin")) seen.push(req.headers.range || "");
  if (m) {
    let a0, b0;
    if (m[1] === "") { a0 = Math.max(0, buf.length - +m[2]); b0 = buf.length - 1; } else { a0 = +m[1]; b0 = m[2] === "" ? buf.length - 1 : Math.min(+m[2], buf.length - 1); }
    res.writeHead(206, { "content-range": `bytes ${a0}-${b0}/${buf.length}`, "content-length": b0 - a0 + 1 });
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
async function readAll(h) {
  const store = await IcechunkStore.open(`${base}/ocean.icechunk`, { fetchClient: h.fetchClient(there) });
  const arr = await zarr.open(store.resolve("/" + fx.variable), { kind: "array" });
  const [row, col] = fx.column, out = [];
  for (let t = 0; t < fx.shape[0]; t++) {
    const c = await zarr.get(arr, [t, null, row, col]);
    out.push(Array.from(c.data, (v) => (Number.isNaN(v) ? null : v)));
  }
  return out;
}
{
  const h = heldRefs();
  seen.length = 0;
  const v1 = await readAll(h);
  const n1 = seen.length;
  check(JSON.stringify(v1) === JSON.stringify(fx.values), "values through the held table are the store's");
  check(n1 > 0 && h.stats.rows > 0, `the first read fetched (${n1} requests, ${h.stats.rows} rows)`);
  // a new store over the same table: nothing more is fetched
  const v2 = await readAll(h);
  check(JSON.stringify(v2) === JSON.stringify(fx.values), "values the second time are the same");
  check(seen.length === n1, `the second read made no request (${seen.length - n1})`);
  // every held row lies in the file the refs name, and every ref read is covered by one
  const t = h.table();
  check(t.every((r) => r.path === fx.location), "held rows carry the path the refs name");
  const [row, col] = fx.column, cy = Math.floor(row / fx.chunks[2]), cx = Math.floor(col / fx.chunks[3]);
  const want = fx.refs.filter((r) => { const k = r.key.split("/").map(Number); return k[2] === cy && k[3] === cx; });
  const rows = new Set(t.map((r) => r.offset + "," + r.size));
  check(want.length === fx.shape[0] * (fx.shape[1] / fx.chunks[1]) && t.length === want.length && want.every((r) => rows.has(r.offset + "," + r.size)),
    `the held rows are the refs of the chunks read, one each (${t.length} rows, ${want.length} refs)`);
  check(n1 < want.length, `neighbouring refs went as fewer requests (${n1} for ${want.length} chunks)`);
}

server.close();
if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log("heldrefs ok");
