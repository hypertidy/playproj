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
// Or, for an image that is not north up, gt: a GDAL geotransform, written
// as a ModelTransformation in place of the origin and pixel size.
export async function writeGeoTIFF({ width, height, rgba, origin, pixelSize, gt, geoKeys }) {
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
    ...(gt ? transformRef(gt, geoKeys) : georef(origin, pixelSize, geoKeys))
  ];
  return assemble(tags, strips);
}

// Float32 bands on a projected grid, one plane per band (planar
// configuration 2), NaN as nodata, and each band's name as its GDAL
// description. bands: list of Float32Array of width * height, rows from
// the top; names: one per band.
export async function writeFloatGeoTIFF({ width, height, bands, names = [], origin, pixelSize, geoKeys }) {
  const n = bands.length, rowsPerStrip = Math.max(1, Math.floor(65536 / (width * 4)));
  const jobs = [];
  for (const band of bands) {
    // TIFF is little-endian here, and so is every platform this runs on;
    // copy anyway so a view into a bigger buffer writes only its own rows
    const bytes = new Uint8Array(Float32Array.from(band).buffer);
    for (let r = 0; r < height; r += rowsPerStrip) {
      const end = Math.min(height, r + rowsPerStrip);
      jobs.push(deflate(bytes.subarray(r * width * 4, end * width * 4)));
    }
  }
  const strips = await Promise.all(jobs);
  const meta = names.map((s, i) => `<Item name="DESCRIPTION" sample="${i}" role="description">${s.replace(/[^\w .-]/g, "_")}</Item>`).join("");
  const tags = [
    [256, LONG, [width]],
    [257, LONG, [height]],
    [258, SHORT, new Array(n).fill(32)],
    [259, SHORT, [8]],             // deflate
    [262, SHORT, [1]],             // black is zero
    [273, LONG, strips.map(() => 0)],
    [277, SHORT, [n]],
    [278, LONG, [rowsPerStrip]],
    [279, LONG, strips.map((s) => s.length)],
    [284, SHORT, [2]],             // one plane per band
    [339, SHORT, new Array(n).fill(3)], // IEEE float
    [42113, ASCII, "nan\0"],       // GDAL_NODATA
    ...georef(origin, pixelSize, geoKeys)
  ];
  if (n > 1) tags.push([338, SHORT, new Array(n - 1).fill(0)]);
  if (meta) tags.push([42112, ASCII, `<GDALMetadata>${meta}</GDALMetadata>\0`]);
  return assemble(tags, strips);
}

const georef = (origin, pixelSize, geoKeys) => [
  [33550, DOUBLE, [pixelSize[0], pixelSize[1], 0]],
  [33922, DOUBLE, [0, 0, 0, origin[0], origin[1], 0]],
  ...geoKeyTags(geoKeys)
];

// ModelTransformationTag: the 4 x 4 matrix taking raster (col, row, 0, 1),
// corners counted from the top-left of the top-left pixel, to model x, y.
const transformRef = (gt, geoKeys) => [
  [34264, DOUBLE, [gt[1], gt[2], 0, gt[0], gt[4], gt[5], 0, gt[3], 0, 0, 0, 0, 0, 0, 0, 1]],
  ...geoKeyTags(geoKeys)
];

// Lay out a little-endian TIFF: header, one IFD, out-of-line tag values,
// then the compressed strips. Tag 273 (StripOffsets) is filled in here.
function assemble(tags, strips) {
  tags = tags.sort((a, b) => a[0] - b[0]);

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

// GeoKeys carrying a CRS as an ESRI PE string, laid out the way GDAL writes
// them (GEOTIFF_KEYS_FLAVOR=ESRI_PE), for projections GeoTIFF has no
// coordinate transformation code for. sphereRadius sets the user-defined
// sphere that GDAL also reads (or the semi-major axis, with semiMinor for
// an ellipsoid).
export function esriGeoKeys(wkt, sphereRadius, citation, semiMinor = sphereRadius) {
  const geog = semiMinor === sphereRadius ? `Sphere R=${sphereRadius}` : `Ellipsoid a=${sphereRadius} b=${semiMinor}`;
  return [
    [1024, 32767], [1025, 1], [1026, { ascii: citation }],
    [2048, 32767], [2049, { ascii: geog }], [2050, 32767], [2051, 8901],
    [2054, 9102], [2056, 32767], [2057, { double: sphereRadius }], [2058, { double: semiMinor }],
    [3073, { ascii: `ESRI PE String = ${wkt}` }], [3076, 9001]
  ];
}

// An ESRI PE string for any PROJ string on a sphere of radius R (or an
// ellipsoid of semi-major axis R and inverse flattening invf): a custom
// projection with the PROJ string in its PROJ4 extension, which GDAL reads.
export function proj4Wkt(name, proj, R, invf = 0) {
  const sph = invf ? `GEOGCS["GCS_Ellipsoid",DATUM["D_Ellipsoid",SPHEROID["Ellipsoid",${R},${invf}]],`
    : `GEOGCS["GCS_Sphere",DATUM["D_Sphere",SPHEROID["Sphere",${R},0.0]],`;
  return `PROJCS["playproj_${name}",${sph}` +
    `PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["custom_proj4"],UNIT["Meter",1.0],` +
    `EXTENSION["PROJ4","${proj} +wktext +no_defs"]]`;
}
