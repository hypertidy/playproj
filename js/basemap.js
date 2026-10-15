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

// Read the smallest overview at least minWidth wide; never the full grid.
async function loadGebco(src, status) {
  status("Loading GeoTIFF reader...");
  if (typeof GeoTIFF === "undefined") await loadScript(GEOTIFF_JS);
  status("Reading GEBCO 2026 overviews...");
  const tiff = await GeoTIFF.fromUrl(src.url);
  const count = await tiff.getImageCount();
  let pick = null;
  for (let i = 0; i < count; i++) {
    const img = await tiff.getImage(i);
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

export function colourElevation(elev, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  const cell = 360 / width;
  const dyM = cell * 110540 / 12;  // 12x vertical exaggeration
  const sun = [-0.5, 0.5, 0.7071]; // from the north-west, 45 degrees up
  for (let j = 0; j < height; j++) {
    const lat = 90 - (j + 0.5) * cell;
    const dxM = Math.max(1, cell * 111320 * Math.cos(lat * Math.PI / 180)) / 12;
    const jn = Math.max(0, j - 1), js = Math.min(height - 1, j + 1);
    for (let i = 0; i < width; i++) {
      const k = j * width + i;
      let z = elev[k];
      if (z <= -32767) z = 0;
      const ie = (i + 1) % width, iw = (i - 1 + width) % width;
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
