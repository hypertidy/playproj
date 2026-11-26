// REMA, the Reference Elevation Model of Antarctica (v2.0, the Polar
// Geospatial Center and the Byrd Polar and Climate Research Center), read
// as GDAL reads it through an overview VRT: the 2 m mosaic's tiles under
// 10 m and 32 m tile VRTs and whole-continent 100 m, 500 m and 1 km COGs,
// all in EPSG:3031. Heights are metres above the WGS84 ellipsoid.
//
// A page reads it without GDAL: the VRT's XML for its grid, its overviews
// and its sources (parseVrt), GDAL's file names made into URLs a browser can
// fetch (httpUrl), a window of cells round a place on any level (windowAt),
// the sources a window needs and where each lands in it (sourcesIn), and the
// level nearest a cell size (pickLevel). No three.js and no DOM here.

export const REMA = {
  vrt: "https://raw.githubusercontent.com/mdsumner/rema-ovr/main/REMA-2m_dem_ovr.vrt",
  nodata: -9999,
  doi: "10.7910/DVN/EBW8UC"
};

// GDAL's names for a file as URLs: /vsicurl/ dropped; /vsis3/bucket/key as
// the bucket's own host; and GitHub's /raw/ links, which answer with a
// redirect a page may not follow (it has no CORS header), as the hosts they
// redirect to: raw.githubusercontent.com for text, and for a GeoTIFF, which
// a repository keeps in Git LFS, media.githubusercontent.com.
export function httpUrl(name) {
  let u = String(name).trim().replace(/^\/vsicurl\//, "");
  const s3 = u.match(/^\/vsis3\/([^/]+)\/(.*)$/);
  if (s3) return `https://${s3[1]}.s3.amazonaws.com/${s3[2]}`;
  const gh = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/(.*)$/);
  if (gh) {
    const [, owner, repo, rest] = gh;
    u = /\.tiff?$/i.test(rest)
      ? `https://media.githubusercontent.com/media/${owner}/${repo}/${rest}`
      : `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`;
  }
  return u;
}

const num = (s) => Number(String(s).trim());
const attrs = (tag) => {
  const o = {};
  for (const m of tag.matchAll(/(\w+)="([^"]*)"/g)) o[m[1]] = m[2];
  return o;
};
const rect = (block, name) => {
  const m = block.match(new RegExp(`<${name}\\b([^>]*)/?>`));
  if (!m) return null;
  const a = attrs(m[1]);
  return [num(a.xOff), num(a.yOff), num(a.xSize), num(a.ySize)];
};

// A VRT's first band as { width, height, gt, nodata, overviews: [url],
// sources: [{ url, src: [x, y, w, h], dst: [x, y, w, h], nodata }] }, gt as
// GDAL's geotransform. Simple and complex sources alike; a source without
// a SrcRect or DstRect takes the whole of the one it has.
export function parseVrt(text) {
  const head = text.match(/<VRTDataset\b([^>]*)>/);
  if (!head) throw new Error("not a VRT: no <VRTDataset>");
  const a = attrs(head[1]);
  const gtm = text.match(/<GeoTransform>([^<]*)<\/GeoTransform>/);
  const gt = gtm ? gtm[1].split(",").map(num) : [0, 1, 0, 0, 0, 1];
  const band = text.match(/<VRTRasterBand\b[\s\S]*?(?:<\/VRTRasterBand>|$)/);
  const body = band ? band[0] : text;
  const nd = body.match(/<NoDataValue>([^<]*)<\/NoDataValue>/);
  const overviews = [...body.matchAll(/<Overview>[\s\S]*?<SourceFilename[^>]*>([^<]*)<\/SourceFilename>[\s\S]*?<\/Overview>/g)].map((m) => httpUrl(m[1]));
  const sources = [];
  for (const m of body.matchAll(/<(Simple|Complex)Source>([\s\S]*?)<\/\1Source>/g)) {
    const b = m[2], f = b.match(/<SourceFilename[^>]*>([^<]*)<\/SourceFilename>/);
    if (!f) continue;
    const p = b.match(/<SourceProperties\b([^>]*)\/?>/), size = p ? attrs(p[1]) : {};
    const whole = size.RasterXSize ? [0, 0, num(size.RasterXSize), num(size.RasterYSize)] : null;
    const src = rect(b, "SrcRect") || whole, dst = rect(b, "DstRect") || src;
    const n = b.match(/<NODATA>([^<]*)<\/NODATA>/);
    sources.push({ url: httpUrl(f[1]), src, dst, nodata: n ? num(n[1]) : null });
  }
  return { width: num(a.rasterXSize), height: num(a.rasterYSize), gt, nodata: nd ? num(nd[1]) : null, overviews, sources };
}

// A level's grid: its top left corner, its cells' sizes, and its cells
// across and down, from a geotransform (north up) or a COG's own.
export function gridOf(gt, w, h) {
  return { x0: gt[0], y0: gt[3], dx: gt[1], dy: -gt[5], w, h };
}

// The window of n x n cells (fewer at the grid's edges) with the cell
// holding x, y at its middle: { c0, r0, w, h } in the grid's cells.
export function windowAt(g, x, y, n) {
  const c = Math.floor((x - g.x0) / g.dx), r = Math.floor((g.y0 - y) / g.dy), half = Math.floor(n / 2);
  const c0 = Math.max(0, c - half), r0 = Math.max(0, r - half);
  const c1 = Math.min(g.w, c - half + n), r1 = Math.min(g.h, r - half + n);
  if (c1 <= c0 || r1 <= r0) return null;
  return { c0, r0, w: c1 - c0, h: r1 - r0 };
}

// The sources a window of a VRT needs, in the VRT's order (a later source
// is drawn over an earlier one), each with the part of the source to read
// (read: [x0, y0, x1, y1] in its own pixels), how many cells that makes
// (cols, rows: more or fewer than it reads where SrcRect and DstRect
// differ in size), and where they land in the window (at: [col, row]).
export function sourcesIn(sources, win) {
  const out = [], wx1 = win.c0 + win.w, wy1 = win.r0 + win.h;
  for (const s of sources) {
    const [dx, dy, dw, dh] = s.dst, [sx, sy, sw, sh] = s.src;
    const x0 = Math.max(win.c0, dx), y0 = Math.max(win.r0, dy), x1 = Math.min(wx1, dx + dw), y1 = Math.min(wy1, dy + dh);
    if (x1 <= x0 || y1 <= y0) continue;
    const kx = sw / dw, ky = sh / dh;
    out.push({
      url: s.url, nodata: s.nodata,
      read: [sx + Math.floor((x0 - dx) * kx), sy + Math.floor((y0 - dy) * ky), sx + Math.ceil((x1 - dx) * kx), sy + Math.ceil((y1 - dy) * ky)],
      cols: x1 - x0, rows: y1 - y0, at: [x0 - win.c0, y0 - win.r0]
    });
  }
  return out;
}

// Paste a block of cols x rows values into a window's array (w across) at
// [col, row], leaving what is there where the block has its nodata.
export function paste(out, w, block, { cols, rows, at, nodata }) {
  for (let j = 0; j < rows; j++) {
    const o = (at[1] + j) * w + at[0], b = j * cols;
    for (let i = 0; i < cols; i++) {
      const v = block[b + i];
      if (v !== nodata && v === v) out[o + i] = v;
    }
  }
}

// Of levels [{ dx, ... }], the one whose cells are nearest d in ratio.
export function pickLevel(levels, d) {
  let best = null, err = Infinity;
  for (const l of levels) {
    const e = Math.abs(Math.log(l.dx / d));
    if (e < err - 1e-12) { best = l; err = e; }
  }
  return best;
}

// Cell sizes in words: "2 m", "500 m", "8 km".
export function cellWords(d) {
  return d >= 1000 ? `${+(d / 1000).toFixed(d >= 1e4 ? 0 : 1)} km` : `${+d.toFixed(d < 10 ? 1 : 0)} m`;
}
