// Basemaps in the browser: fetch each source once, through geotiff.js for
// GEBCO and image tiles for Esri, and give every world and window a canvas
// for textures. The reading, colouring and resampling are in basemap.js.

import {
  sources, readGebcoOverview, readGebcoWindow, esriGlobal, esriPlan, esriWindow, worldWindow, warpPixels
} from "../src/core/basemap.js";

const GEOTIFF_JS = "https://cdn.jsdelivr.net/npm/geotiff@3.0.5/dist-browser/geotiff.js";

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

// RGBA rows as a canvas, kept on the world or window it came with.
function withCanvas(img) {
  const canvas = document.createElement("canvas");
  canvas.width = img.width; canvas.height = img.height;
  canvas.getContext("2d").putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return { ...img, canvas };
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

async function loadGebco(src, status) {
  return withCanvas(await readGebcoOverview(await gebcoLevels(src, status), src, status));
}

// ------------------------------------------------------------------ Esri

// Tiles x0..x1, y0..y1 at zoom z drawn into one canvas; RGBA rows back.
async function mosaic(src, z, x0, x1, y0, y1) {
  const n = 2 ** z, merc = document.createElement("canvas");
  merc.width = (x1 - x0 + 1) * 256; merc.height = (y1 - y0 + 1) * 256;
  const mctx = merc.getContext("2d");
  const jobs = [];
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      jobs.push(new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => { mctx.drawImage(img, (x - x0) * 256, (y - y0) * 256); resolve(); };
        img.onerror = () => reject(new Error("Esri imagery tiles did not load"));
        img.src = src.url.replace("{z}", z).replace("{y}", y).replace("{x}", ((x % n) + n) % n);
      }));
  await Promise.all(jobs);
  return mctx.getImageData(0, 0, merc.width, merc.height).data;
}

async function loadEsri(src, status) {
  const z = src.zoom, n = 2 ** z;
  status(`Loading ${n * n} Esri imagery tiles...`);
  return withCanvas(esriGlobal(await mosaic(src, z, 0, n - 1, 0, n - 1), 256 * n));
}

// ------------------------------------------------------------------ windows

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
    let w = null;
    if (id === "gebco") w = await readGebcoWindow(await gebcoLevels(sources.gebco, status), box, res, status);
    else {
      const plan = esriPlan(box, res);
      if (plan) {
        const { z, tx0, tx1, ty0, ty1 } = plan;
        status(`Loading ${(tx1 - tx0 + 1) * (ty1 - ty0 + 1)} Esri imagery tiles at zoom ${z}...`);
        w = esriWindow(await mosaic(sources.esri, z, tx0, tx1, ty0, ty1), plan, box);
      }
    }
    return w ? withCanvas(w) : global;
  } catch (e) {
    return { ...global, note: `the finer read failed (${e.message}), so this uses the global image` };
  }
}

// A canvas W x H of the global basemap warped into a page's own texture
// frame, as basemap.js warpPixels.
export function warpCanvas(world, W, H, inv) {
  return withCanvas({ width: W, height: H, data: warpPixels(world, W, H, inv) }).canvas;
}
