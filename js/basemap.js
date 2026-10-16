// Basemaps. Each source is loaded once as a global image in longitude and
// latitude (an RGBA "world" grid from -180 to 180, 90 to -90), which can be
// wrapped on the globe as a texture and reprojected onto the plane pixel by
// pixel with a family's inverse.

const GEOTIFF_JS = "https://cdn.jsdelivr.net/npm/geotiff@3.0.5/dist-browser/geotiff.js";

export const sources = {
  none: { label: "None" },
  gebco: {
    label: "GEBCO 2026 elevation",
    url: "https://data.source.coop/ausantarctic/gebco/GEBCO_2026.tif",
    minWidth: 2048,
    credit: 'GEBCO Compilation Group (2026) GEBCO 2026 Grid, from <a href="https://source.coop/ausantarctic/gebco">Source Cooperative</a>'
  },
  esri: {
    label: "Esri World Imagery",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    zoom: 3,
    credit: "Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community"
  }
};

const cache = new Map();

export function loadWorld(id, status = () => {}) {
  if (!cache.has(id)) {
    const p = (id === "gebco" ? loadGebco(sources.gebco, status) : loadEsri(sources.esri, status));
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return cache.get(id);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}

// ------------------------------------------------------------------ GEBCO

// The file's full grid and overviews, opened once.
let gebcoImages = null;
function gebcoLevels(src, status) {
  if (!gebcoImages) {
    gebcoImages = (async () => {
      status("Loading GeoTIFF reader...");
      if (typeof GeoTIFF === "undefined") await loadScript(GEOTIFF_JS);
      status("Reading GEBCO 2026 overviews...");
      const tiff = await GeoTIFF.fromUrl(src.url);
      const count = await tiff.getImageCount(), out = [];
      for (let i = 0; i < count; i++) out.push(await tiff.getImage(i));
      return out;
    })();
    gebcoImages.catch(() => { gebcoImages = null; });
  }
  return gebcoImages;
}

// Read the smallest overview at least minWidth wide; never the full grid.
async function loadGebco(src, status) {
  const levels = await gebcoLevels(src, status);
  let pick = null;
  for (const img of levels) {
    const w = img.getWidth();
    if (w >= src.minWidth && (!pick || w < pick.getWidth())) pick = img;
  }
  if (!pick || pick.getWidth() > 12000) throw new Error("GEBCO file has no small overview to read");
  const width = pick.getWidth(), height = pick.getHeight();
  status(`Reading GEBCO 2026 overview, ${width} x ${height}...`);
  const [elev] = await pick.readRasters({ samples: [0] });
  return colourElevation(elev, width, height);
}

// Hypsometric tints with a hillshade, so both the ocean floor and the land
// read on a small map.
const OCEAN = [[-9000, 8, 20, 50], [-6000, 16, 45, 95], [-4000, 28, 78, 140], [-2000, 50, 115, 180], [-200, 95, 165, 215], [0, 165, 212, 236]];
const LAND = [[0, 72, 122, 72], [300, 122, 152, 92], [1000, 172, 162, 112], [2000, 152, 122, 92], [3500, 205, 196, 186], [5500, 252, 252, 252]];

function ramp(stops, z) {
  if (z <= stops[0][0]) return stops[0];
  for (let i = 1; i < stops.length; i++) {
    if (z <= stops[i][0]) {
      const [z0, r0, g0, b0] = stops[i - 1], [z1, r1, g1, b1] = stops[i];
      const t = (z - z0) / (z1 - z0);
      return [z, r0 + t * (r1 - r0), g0 + t * (g1 - g0), b0 + t * (b1 - b0)];
    }
  }
  return stops[stops.length - 1];
}

// A window of the grid (not the whole world) passes its cell sizes in
// degrees, its top latitude, and wrap = false.
export function colourElevation(elev, width, height, { dx = 360 / width, dy = dx, top = 90, wrap = true } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const dyM = dy * 110540 / 12;  // 12x vertical exaggeration
  const sun = [-0.5, 0.5, 0.7071]; // from the north-west, 45 degrees up
  for (let j = 0; j < height; j++) {
    const lat = top - (j + 0.5) * dy;
    const dxM = Math.max(1, dx * 111320 * Math.cos(lat * Math.PI / 180)) / 12;
    const jn = Math.max(0, j - 1), js = Math.min(height - 1, j + 1);
    for (let i = 0; i < width; i++) {
      const k = j * width + i;
      let z = elev[k];
      if (z <= -32767) z = 0;
      const ie = wrap ? (i + 1) % width : Math.min(width - 1, i + 1), iw = wrap ? (i - 1 + width) % width : Math.max(0, i - 1);
      const gx = (elev[j * width + ie] - elev[j * width + iw]) / (2 * dxM);
      const gy = (elev[jn * width + i] - elev[js * width + i]) / (2 * dyM);
      const len = Math.hypot(gx, gy, 1);
      const shade = Math.max(0, (-gx * sun[0] - gy * sun[1] + sun[2]) / len);
      const f = 0.45 + 0.75 * shade;
      const c = ramp(z > 0 ? LAND : OCEAN, z);
      data[k * 4] = c[1] * f; data[k * 4 + 1] = c[2] * f; data[k * 4 + 2] = c[3] * f; data[k * 4 + 3] = 255;
    }
  }
  const world = toWorld(data, width, height);
  world.elev = elev;
  return world;
}

// ------------------------------------------------------------------ Esri

// Mosaic one zoom level of Web Mercator tiles, then resample to lon/lat.
// Web Mercator stops at 85.05 degrees, so the polar caps are left dark.
async function loadEsri(src, status) {
  const z = src.zoom, n = 2 ** z, size = 256 * n;
  status(`Loading ${n * n} Esri imagery tiles...`);
  const merc = document.createElement("canvas");
  merc.width = merc.height = size;
  const mctx = merc.getContext("2d");
  const tile = (x, y) => new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { mctx.drawImage(img, x * 256, y * 256); resolve(); };
    img.onerror = () => reject(new Error("Esri imagery tiles did not load"));
    img.src = src.url.replace("{z}", z).replace("{y}", y).replace("{x}", x);
  });
  const jobs = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) jobs.push(tile(x, y));
  await Promise.all(jobs);
  const m = mctx.getImageData(0, 0, size, size).data;

  const width = size, height = size / 2;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let j = 0; j < height; j++) {
    const lat = 90 - (j + 0.5) * 180 / height;
    const phi = lat * Math.PI / 180;
    const my = (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2 * size;
    const row = Math.floor(my);
    for (let i = 0; i < width; i++) {
      const k = (j * width + i) * 4;
      if (row < 0 || row >= size) { data[k] = 12; data[k + 1] = 18; data[k + 2] = 30; data[k + 3] = 255; continue; }
      const s = (row * size + i) * 4;
      data[k] = m[s]; data[k + 1] = m[s + 1]; data[k + 2] = m[s + 2]; data[k + 3] = 255;
    }
  }
  return toWorld(data, width, height);
}

function toWorld(data, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  canvas.getContext("2d").putImageData(new ImageData(data, width, height), 0, 0);
  return { width, height, data, canvas };
}

// Elevation in metres at a lon/lat, bilinear, or 0 where the world has none
// (only GEBCO carries elevation). No-data cells count as sea level.
export function sampleElev(world, lon, lat) {
  const e = world && world.elev;
  if (!e) return 0;
  const W = world.width, H = world.height;
  const u = ((lon + 180) / 360) * W - 0.5;
  const v = Math.min(H - 1.001, Math.max(0, ((90 - lat) / 180) * H - 0.5));
  const u0 = Math.floor(u), v0 = Math.floor(v), fu = u - u0, fv = v - v0;
  const a = ((u0 % W) + W) % W, b = (a + 1) % W, r0 = v0 * W, r1 = r0 + W;
  const z = (k) => (e[k] <= -32767 ? 0 : e[k]);
  return (z(r0 + a) * (1 - fu) + z(r0 + b) * fu) * (1 - fv) + (z(r1 + a) * (1 - fu) + z(r1 + b) * fu) * fv;
}

// ------------------------------------------------------------------ reproject

// Fill an RGBA buffer of size x size covering the plane square [-w, w],
// sampling the world image bilinearly where the family's inverse lands.
export function reproject(world, inverse, p, w, size) {
  return reprojectBox(world, inverse, p, [-w, -w, w, w], size, size);
}

// The same for any box [xmin, ymin, xmax, ymax] at nx by ny pixels.
export function reprojectBox(world, inverse, p, box, nx, ny) {
  const out = new Uint8ClampedArray(nx * ny * 4);
  const { width: W, height: H, data: src } = world;
  const [x0, y0, x1, y1] = box;
  const sx = (x1 - x0) / nx, sy = (y1 - y0) / ny;
  for (let j = 0; j < ny; j++) {
    const y = y1 - (j + 0.5) * sy;
    for (let i = 0; i < nx; i++) {
      const ll = inverse(x0 + (i + 0.5) * sx, y, p);
      if (!ll) continue;
      const u = ((ll[0] + 180) / 360) * W - 0.5;
      const v = Math.min(H - 1.001, Math.max(0, ((90 - ll[1]) / 180) * H - 0.5));
      const u0 = Math.floor(u), v0 = Math.floor(v), fu = u - u0, fv = v - v0;
      const a = ((u0 % W) + W) % W, b = (a + 1) % W;
      const r0 = v0 * W, r1 = (v0 + 1) * W;
      const k = (j * nx + i) * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[(r0 + a) * 4 + c] * (1 - fu) + src[(r0 + b) * 4 + c] * fu;
        const bot = src[(r1 + a) * 4 + c] * (1 - fu) + src[(r1 + b) * 4 + c] * fu;
        out[k + c] = top * (1 - fv) + bot * fv;
      }
      out[k + 3] = 255;
    }
  }
  return out;
}

// ------------------------------------------------------------------ windows

// A window is a piece of a basemap on a lon/lat grid: RGBA rows from the
// north, its west edge and top latitude, and cell sizes dx, dy in degrees.
// west can be below -180 (the window then runs across the antimeridian).
// The whole world is a window too, one that wraps.
export function worldWindow(world) {
  return { ...world, west: -180, north: 90, dx: 360 / world.width, dy: 180 / world.height, global: true };
}

const MAX_WINDOW = 4000;   // pixels on a side, within a texture
const ESRI_MAX_ZOOM = 17, ESRI_MAX_TILES = 64;
const MERC_LIM = 85.0511287798;
const D2R = Math.PI / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// The basemap over a lon/lat box { west, east, south, north } at about
// res degrees per pixel (or finer), read from the source at the level that
// suits: GEBCO's own overviews, or Esri tiles at a deeper zoom. Where the
// global image already has the detail, or the finer read fails, the global
// image is used (and the window says why in `note`).
export async function readWindow(id, box, res, status = () => {}) {
  const world = await loadWorld(id, status);
  const global = worldWindow(world);
  if (res >= global.dx * 0.999) return global;
  try {
    const w = id === "gebco" ? await gebcoWindow(box, res, status) : await esriWindow(box, res, status);
    return w || global;
  } catch (e) {
    return { ...global, note: `the finer read failed (${e.message}), so this uses the global image` };
  }
}

async function gebcoWindow(box, res, status) {
  const levels = (await gebcoLevels(sources.gebco, status))
    .map((img) => ({ img, r: 360 / img.getWidth() }))
    .sort((a, b) => a.r - b.r);
  // the coarsest level not coarser than res, then coarser while too big
  let k = 0;
  for (let i = 0; i < levels.length; i++) if (levels[i].r <= res) k = i;
  const size = (r) => Math.max((box.east - box.west) / r, (box.north - box.south) / r);
  while (k < levels.length - 1 && size(levels[k].r) > MAX_WINDOW) k++;
  const { img, r } = levels[k], W = img.getWidth(), H = img.getHeight();
  let x0 = Math.floor((box.west + 180) / r) - 2, x1 = Math.ceil((box.east + 180) / r) + 2;
  if (x1 - x0 > W) { x0 = 0; x1 = W; }
  const y0 = Math.max(0, Math.floor((90 - box.north) / r) - 2), y1 = Math.min(H, Math.ceil((90 - box.south) / r) + 2);
  const w = x1 - x0, h = y1 - y0;
  status(`Reading GEBCO 2026, ${w} x ${h} at ${(r * 3600).toFixed(0)} arc seconds...`);
  const elev = new Float32Array(w * h);
  // the window's columns taken modulo the grid, in runs that do not wrap
  for (let x = x0; x < x1;) {
    const xm = ((x % W) + W) % W, run = Math.min(x1 - x, W - xm);
    const [band] = await img.readRasters({ window: [xm, y0, xm + run, y1], samples: [0] });
    for (let j = 0; j < h; j++)
      for (let i = 0; i < run; i++) elev[j * w + (x - x0) + i] = band[j * run + i];
    x += run;
  }
  const full = w === W;
  const out = colourElevation(elev, w, h, { dx: r, dy: r, top: 90 - y0 * r, wrap: full });
  return { ...out, west: -180 + x0 * r, north: 90 - y0 * r, dx: r, dy: r, global: full && y0 === 0 && y1 === H };
}

// Esri tiles at the zoom that suits, mosaicked and resampled to lon/lat.
async function esriWindow(box, res, status) {
  const src = sources.esri;
  const tyOf = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + clamp(lat, -MERC_LIM, MERC_LIM) * D2R / 2)) / Math.PI) / 2;
  let z = clamp(Math.ceil(Math.log2(360 / (256 * res))), src.zoom, ESRI_MAX_ZOOM), n, tx0, tx1, ty0, ty1;
  for (;; z--) {
    n = 2 ** z;
    tx0 = Math.floor(((box.west + 180) / 360) * n); tx1 = Math.floor(((box.east + 180) / 360) * n - 1e-9);
    if (tx1 - tx0 + 1 > n) { tx0 = 0; tx1 = n - 1; }
    ty0 = Math.floor(tyOf(box.north) * n); ty1 = Math.min(n - 1, Math.floor(tyOf(box.south) * n));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= ESRI_MAX_TILES || z <= src.zoom) break;
  }
  if (z <= src.zoom) return null;
  const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;
  status(`Loading ${cols * rows} Esri imagery tiles at zoom ${z}...`);
  const merc = document.createElement("canvas");
  merc.width = cols * 256; merc.height = rows * 256;
  const mctx = merc.getContext("2d");
  const jobs = [];
  for (let y = ty0; y <= ty1; y++)
    for (let x = tx0; x <= tx1; x++)
      jobs.push(new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => { mctx.drawImage(img, (x - tx0) * 256, (y - ty0) * 256); resolve(); };
        img.onerror = () => reject(new Error("Esri imagery tiles did not load"));
        img.src = src.url.replace("{z}", z).replace("{y}", y).replace("{x}", ((x % n) + n) % n);
      }));
  await Promise.all(jobs);
  const m = mctx.getImageData(0, 0, merc.width, merc.height).data;
  // lon/lat cells as wide as a tile pixel, as tall as one at the middle latitude
  const dx = 360 / (256 * n), mid = (clamp(box.north, -MERC_LIM, MERC_LIM) + clamp(box.south, -MERC_LIM, MERC_LIM)) / 2;
  const dy = dx * Math.max(0.05, Math.cos(mid * D2R));
  const top = Math.min(box.north, MERC_LIM), bottom = Math.max(box.south, -MERC_LIM);
  const width = cols * 256, height = Math.max(1, Math.ceil((top - bottom) / dy));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let j = 0; j < height; j++) {
    const lat = top - (j + 0.5) * dy;
    const row = Math.floor(tyOf(lat) * n * 256) - ty0 * 256;
    if (row < 0 || row >= merc.height) continue;
    for (let i = 0; i < width; i++) {
      const s = (row * width + i) * 4, k = (j * width + i) * 4;
      data[k] = m[s]; data[k + 1] = m[s + 1]; data[k + 2] = m[s + 2]; data[k + 3] = 255;
    }
  }
  return { ...toWorld(data, width, height), west: -180 + (tx0 / n) * 360, north: top, dx, dy, global: false };
}

// The basemap colour at lon/lat, bilinear, into out[k..k+3]; false (and
// nothing written) outside the window.
export function sampleWindow(win, lon, lat, out, k) {
  const { width: W, height: H, data } = win;
  const v = (win.north - lat) / win.dy - 0.5;
  if (v < -1 || v > H) return false;
  if (!win.global) {
    lon = win.west + ((((lon - win.west) % 360) + 360) % 360);
    if ((lon - win.west) / win.dx - 0.5 > W) return false;
  }
  const u = (lon - win.west) / win.dx - 0.5;
  const vc = clamp(v, 0, H - 1.001), v0 = Math.floor(vc), fv = vc - v0;
  let a, b, fu;
  if (win.global) {
    const u0 = Math.floor(u); fu = u - u0;
    a = ((u0 % W) + W) % W; b = (a + 1) % W;
  } else {
    const uc = clamp(u, 0, W - 1.001), u0 = Math.floor(uc); fu = uc - u0;
    a = u0; b = u0 + 1;
  }
  const r0 = v0 * W, r1 = r0 + W;
  if (data[(r0 + a) * 4 + 3] === 0 && data[(r1 + b) * 4 + 3] === 0) return false;
  for (let c = 0; c < 3; c++) {
    const top = data[(r0 + a) * 4 + c] * (1 - fu) + data[(r0 + b) * 4 + c] * fu;
    const bot = data[(r1 + a) * 4 + c] * (1 - fu) + data[(r1 + b) * 4 + c] * fu;
    out[k + c] = top * (1 - fv) + bot * fv;
  }
  out[k + 3] = 255;
  return true;
}

// A canvas W x H of the global basemap warped into a page's own texture
// frame: inv(u, v) gives the lon/lat at texture position u (0 to 1, left to
// right) and v (0 to 1, bottom to top), or null where there is nothing.
export function warpCanvas(world, W, H, inv) {
  const win = worldWindow(world), out = new Uint8ClampedArray(W * H * 4);
  for (let j = 0; j < H; j++) {
    const v = 1 - (j + 0.5) / H;
    for (let i = 0; i < W; i++) {
      const ll = inv((i + 0.5) / W, v);
      if (ll) sampleWindow(win, ll[0], ll[1], out, (j * W + i) * 4);
    }
  }
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  c.getContext("2d").putImageData(new ImageData(out, W, H), 0, 0);
  return c;
}
