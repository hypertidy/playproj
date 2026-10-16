// GeoTIFF of one cell, tile or lobe, in its own CRS, filled from a basemap.
//
// The pixel grid is laid out in the CRS (a box in its units), each pixel
// centre is taken back to lon/lat with the CRS's inverse, and the basemap
// is read for the lon/lat window those pixels cover, at about the detail
// they need (basemap.js readWindow). Pixels outside the cell stay
// transparent, so a cell that is not a rectangle in its CRS keeps its shape.

import { readWindow, sampleWindow } from "./basemap.js";
import { writeGeoTIFF, esriGeoKeys, proj4Wkt } from "./geotiff-write.js";

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const wrap180 = (x) => ((((x + 180) % 360) + 360) % 360) - 180;

// GeoKeys for a CRS given as { epsg } (projected), { geographic: true }
// (WGS84 lon/lat) or { proj, R } (a PROJ string, carried as an ESRI PE
// string with a PROJ4 extension, which GDAL reads).
export function crsGeoKeys(crs) {
  if (crs.geographic) return [[1024, 2], [1025, 1], [2048, 4326], [2054, 9102]];
  if (crs.epsg) return [[1024, 1], [1025, 1], [3072, crs.epsg], [3076, 9001]];
  const name = crs.proj.split(" ")[0].replace("+proj=", "");
  return esriGeoKeys(proj4Wkt(name, crs.proj, crs.R), crs.R, `playproj ${crs.proj}`);
}

// Spherical gnomonic about (lat0, lon0) on a unit sphere, as PROJ's gnom:
// forward and inverse in sphere radii.
export function gnomonic(lat0, lon0) {
  const p0 = lat0 * D2R, s0 = Math.sin(p0), c0 = Math.cos(p0);
  return {
    forward(lon, lat) {
      const l = (lon - lon0) * D2R, p = lat * D2R, cp = Math.cos(p), sp = Math.sin(p), cl = Math.cos(l);
      const d = s0 * sp + c0 * cp * cl;
      if (d <= 1e-9) return null;
      return [(cp * Math.sin(l)) / d, (c0 * sp - s0 * cp * cl) / d];
    },
    inverse(x, y) {
      const rho = Math.hypot(x, y);
      if (rho === 0) return [lon0, lat0];
      const c = Math.atan(rho), sc = Math.sin(c), cc = Math.cos(c);
      const lat = Math.asin(cc * s0 + (y * sc * c0) / rho);
      const lon = lon0 + Math.atan2(x * sc, rho * c0 * cc - y * s0 * sc) * R2D;
      return [wrap180(lon), lat * R2D];
    }
  };
}

// Polar stereographic about the North Pole (south = true: the South Pole)
// on a unit sphere, true scale at the pole, as PROJ's stere +lat_0=90.
export function polarStere(south = false, lon0 = 0) {
  const sg = south ? -1 : 1;
  return {
    forward(lon, lat) {
      const rho = 2 * Math.tan(((90 - sg * lat) * D2R) / 2), l = (lon - lon0) * D2R;
      return [rho * Math.sin(l), -sg * rho * Math.cos(l)];
    },
    inverse(x, y) {
      const rho = Math.hypot(x, y);
      return [wrap180(lon0 + Math.atan2(x, -sg * y) * R2D), sg * (90 - 2 * Math.atan(rho / 2) * R2D)];
    }
  };
}

// A densified ring of lon/lat along the edges of a cell given as a function
// of (u, v) in 0..1 (u along, v up), per points on each edge.
export function ringOf(at, per = 16) {
  const out = [];
  for (let i = 0; i < per; i++) out.push(at(i / per, 0));
  for (let i = 0; i < per; i++) out.push(at(1, i / per));
  for (let i = 0; i < per; i++) out.push(at(1 - i / per, 1));
  for (let i = 0; i < per; i++) out.push(at(0, 1 - i / per));
  return out;
}

export function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// Render and write the GeoTIFF.
//   bm: basemap id; size: pixels along the longer side
//   crs: as crsGeoKeys; scale: CRS units per forward/inverse unit (R for
//     a projection on a unit sphere, 1 for metres or degrees)
//   forward(lon, lat) -> [x, y] and inverse(x, y) -> [lon, lat] or null,
//     in forward/inverse units
//   box [x0, y0, x1, y1] in those units, or ring (lon/lat) to take it from;
//     periodX: the period of x (360 for lon/lat axes) so a box across it
//     stays whole
//   inside(lon, lat): whether a point belongs to the cell (optional)
// Returns { blob, width, height, note }.
export async function renderCell({ bm, size, crs, scale = 1, forward, inverse, box, ring, periodX = 0, inside = null, status = () => {} }) {
  if (!box) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, ref = null;
    for (const [lon, lat] of ring) {
      const xy = forward(lon, lat);
      if (!xy) continue;
      let [x, y] = xy;
      if (periodX) { if (ref === null) ref = x; x = ref + (((x - ref + periodX / 2) % periodX) + periodX) % periodX - periodX / 2; }
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    box = [x0, y0, x1, y1];
  }
  const [x0, y0, x1, y1] = box;
  // square pixels, unless that leaves a long thin cell (a polar bin) only
  // a few pixels across
  const px = Math.max(x1 - x0, y1 - y0) / size, MIN = Math.min(16, size);
  let nx = Math.max(1, Math.ceil((x1 - x0) / px - 1e-9)), ny = Math.max(1, Math.ceil((y1 - y0) / px - 1e-9));
  let pxX = px, pxY = px;
  if (nx < MIN) { nx = MIN; pxX = (x1 - x0) / nx; }
  if (ny < MIN) { ny = MIN; pxY = (y1 - y0) / ny; }

  // every pixel centre in lon/lat (NaN where it is not in the cell)
  const ll = new Float64Array(nx * ny * 2).fill(NaN);
  let ref = null, w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  for (let j = 0; j < ny; j++) {
    const y = y1 - (j + 0.5) * pxY;
    for (let i = 0; i < nx; i++) {
      const p = inverse(x0 + (i + 0.5) * pxX, y);
      if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
      if (inside && !inside(p[0], p[1])) continue;
      const k = 2 * (j * nx + i);
      ll[k] = p[0]; ll[k + 1] = p[1];
      if (ref === null) ref = p[0];
      const lon = ref + wrap180(p[0] - ref);
      w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, p[1]); n = Math.max(n, p[1]);
    }
  }
  if (ref === null) throw new Error("the cell has no pixels");

  // the detail the pixels need: the median ground size of a pixel, in
  // degrees of arc, from the pixel to its east neighbour
  const steps = [];
  const stride = Math.max(1, Math.floor((nx * ny) / 400));
  for (let k = 0; k < nx * ny; k += stride) {
    const i = k % nx;
    if (i === nx - 1 || isNaN(ll[2 * k]) || isNaN(ll[2 * k + 2])) continue;
    const [l1, p1, l2, p2] = [ll[2 * k], ll[2 * k + 1], ll[2 * k + 2], ll[2 * k + 3]];
    const c = Math.sin(p1 * D2R) * Math.sin(p2 * D2R) + Math.cos(p1 * D2R) * Math.cos(p2 * D2R) * Math.cos((l2 - l1) * D2R);
    steps.push(Math.acos(Math.max(-1, Math.min(1, c))) * R2D);
  }
  steps.sort((a, b) => a - b);
  const res = steps.length ? Math.max(1e-6, steps[steps.length >> 1]) : Math.max(e - w, n - s) / size;

  // the lon/lat window: whole circles of longitude when the cell wraps
  // round (it holds a pole), padded by a few pixels
  const pad = 3 * res, round = e - w > 300;
  const win = {
    west: round ? -180 : w - pad, east: round ? 180 : e + pad,
    south: Math.max(-90, s - pad), north: Math.min(90, n + pad)
  };
  const source = await readWindow(bm, win, res, status);

  status("Rendering...");
  const rgba = new Uint8ClampedArray(nx * ny * 4);
  for (let k = 0; k < nx * ny; k++) if (!isNaN(ll[2 * k])) sampleWindow(source, ll[2 * k], ll[2 * k + 1], rgba, 4 * k);
  const blob = await writeGeoTIFF({
    width: nx, height: ny, rgba,
    origin: [x0 * scale, y1 * scale], pixelSize: [pxX * scale, pxY * scale],
    geoKeys: crsGeoKeys(crs)
  });
  return { blob, width: nx, height: ny, note: source.note || "", res: source.dx };
}
