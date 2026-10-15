// Minimal GeoTIFF writer for an RGBA image on a projected grid.
//
// geotiff.js can only write SHORT geokeys, and a user-defined projection
// needs DOUBLE parameters, so this writes the file directly: one IFD,
// deflate-compressed strips, RGBA bytes, ModelPixelScale + ModelTiepoint
// and a GeoKeyDirectory with its double and ASCII parameter tags.
//
// geoKeys is a list of [keyId, value] where value is an integer (stored
// as SHORT), { double: number } or { ascii: string }.

const SHORT = 3, LONG = 4, ASCII = 2, DOUBLE = 12;
const TYPE_SIZE = { [SHORT]: 2, [LONG]: 4, [ASCII]: 1, [DOUBLE]: 8 };

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function geoKeyTags(geoKeys) {
  const keys = [...geoKeys].sort((a, b) => a[0] - b[0]);
  const dir = [1, 1, 0, keys.length];
  const doubles = [];
  let ascii = "";
  for (const [id, v] of keys) {
    if (typeof v === "number") dir.push(id, 0, 1, v);
    else if ("double" in v) { dir.push(id, 34736, 1, doubles.length); doubles.push(v.double); }
    else {
      const s = v.ascii.replace(/[^\x20-\x7e]/g, "?") + "|";
      dir.push(id, 34737, s.length, ascii.length);
      ascii += s;
    }
  }
  const tags = [[34735, SHORT, dir]];
  if (doubles.length) tags.push([34736, DOUBLE, doubles]);
  if (ascii.length) tags.push([34737, ASCII, ascii + "\0"]);
  return tags;
}

// rgba: Uint8ClampedArray of width * height * 4, rows from the top (north).
// origin: [x, y] of the top-left corner; pixelSize: [dx, dy] (both positive).
export async function writeGeoTIFF({ width, height, rgba, origin, pixelSize, geoKeys }) {
  const rowsPerStrip = Math.max(1, Math.floor(65536 / (width * 4)));
  const jobs = [];
  for (let r = 0; r < height; r += rowsPerStrip) {
    const end = Math.min(height, r + rowsPerStrip);
    jobs.push(deflate(rgba.subarray(r * width * 4, end * width * 4)));
  }
  const strips = await Promise.all(jobs);

  const tags = [
    [256, LONG, [width]],
    [257, LONG, [height]],
    [258, SHORT, [8, 8, 8, 8]],
    [259, SHORT, [8]],             // deflate
    [262, SHORT, [2]],             // RGB
    [273, LONG, strips.map(() => 0)],
    [277, SHORT, [4]],
    [278, LONG, [rowsPerStrip]],
    [279, LONG, strips.map((s) => s.length)],
    [284, SHORT, [1]],             // interleaved
    [338, SHORT, [2]],             // unassociated alpha
    [339, SHORT, [1, 1, 1, 1]],    // unsigned
    [33550, DOUBLE, [pixelSize[0], pixelSize[1], 0]],
    [33922, DOUBLE, [0, 0, 0, origin[0], origin[1], 0]],
    ...geoKeyTags(geoKeys)
  ].sort((a, b) => a[0] - b[0]);

  // layout: header, IFD, out-of-line tag values, strip data
  const ifdSize = 2 + tags.length * 12 + 4;
  let cursor = 8 + ifdSize;
  const valueOffsets = tags.map(([, type, vals]) => {
    const n = type === ASCII ? vals.length : vals.length;
    const bytes = n * TYPE_SIZE[type];
    if (bytes <= 4) return null;
    const off = cursor;
    cursor += bytes + (bytes % 2);
    return off;
  });
  const stripOffsets = [];
  for (const s of strips) { stripOffsets.push(cursor); cursor += s.length; }
  tags.find((t) => t[0] === 273)[2] = stripOffsets;

  const buf = new ArrayBuffer(cursor);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set([0x49, 0x49, 42, 0]);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, tags.length, true);

  const writeVals = (pos, type, vals) => {
    if (type === ASCII) { for (let i = 0; i < vals.length; i++) u8[pos + i] = vals.charCodeAt(i); return; }
    vals.forEach((v, i) => {
      if (type === SHORT) dv.setUint16(pos + i * 2, v, true);
      else if (type === LONG) dv.setUint32(pos + i * 4, v, true);
      else dv.setFloat64(pos + i * 8, v, true);
    });
  };

  tags.forEach(([tag, type, vals], i) => {
    const e = 10 + i * 12;
    dv.setUint16(e, tag, true);
    dv.setUint16(e + 2, type, true);
    dv.setUint32(e + 4, vals.length, true);
    if (valueOffsets[i] === null) writeVals(e + 8, type, vals);
    else { dv.setUint32(e + 8, valueOffsets[i], true); writeVals(valueOffsets[i], type, vals); }
  });
  dv.setUint32(10 + tags.length * 12, 0, true);
  strips.forEach((s, i) => u8.set(s, stripOffsets[i]));
  return new Blob([buf], { type: "image/tiff" });
}
