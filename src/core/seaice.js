// Sea ice concentration from the NSIDC Sea Ice Index (G02135, version 4):
// one small GeoTIFF a day on the 25 km polar stereographic grid, at the
// address the R package sds builds in nsidc_seaice(). Values are tenths of
// a percent, with flags above 1000 for the pole hole, coast, land and
// missing data.

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

// The southern grid: 316 x 332 cells of 25 km, upper left at
// (-3950 km, 4350 km), in EPSG:3412 (EPSG:3976 is the same grid on WGS84).
export const SOUTH = { crs: "EPSG:3412", width: 316, height: 332, x0: -3950000, y0: 4350000, dx: 25000, dy: 25000 };
export const NORTH = { crs: "EPSG:3411", width: 304, height: 448, x0: -3850000, y0: 5850000, dx: 25000, dy: 25000 };

// The daily file for a UTC date (a Date, or "YYYY-MM-DD"), as sds builds it.
export function nsidcUrl(date, hemisphere = "south") {
  const d = typeof date === "string" ? new Date(date + "T00:00:00Z") : date;
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  const H = hemisphere === "north" ? "N" : "S";
  return `https://noaadata.apps.nsidc.org/NOAA/G02135/${hemisphere}/daily/geotiff/${y}/${pad(m + 1)}_${MON[m]}/${H}_${y}${pad(m + 1)}${pad(day)}_concentration_v4.0.tif`;
}

// A URL template with {YYYY}, {MM}, {DD}, {Mon} (Jan..Dec) and {YYYYMMDD}
// filled from a UTC date.
export function fillTemplate(tpl, date) {
  const d = typeof date === "string" ? new Date(date + "T00:00:00Z") : date;
  const y = String(d.getUTCFullYear()), m = pad(d.getUTCMonth() + 1), day = pad(d.getUTCDate());
  return tpl.replaceAll("{YYYYMMDD}", y + m + day).replaceAll("{YYYY}", y).replaceAll("{MM}", m)
    .replaceAll("{DD}", day).replaceAll("{Mon}", MON[d.getUTCMonth()]);
}

export const FLAGS = { 2510: "pole hole", 2530: "coast", 2540: "land", 2550: "missing" };

// A cell value as a fraction 0..1 of ice, or null for a flag or no data.
// Files with 8-bit cells store whole percent (0..100, flags above).
export function decode(v, bits = 16) {
  if (!Number.isFinite(v) || v < 0) return null;
  if (bits === 8) return v <= 100 ? v / 100 : null;
  return v <= 1000 ? v / 1000 : null;
}

// What a flagged cell is ("land", "coast", ...), or "" for a value.
export function flagOf(v, bits = 16) {
  if (bits === 8) return v > 100 ? (v === 254 ? "land" : v === 253 ? "coast" : v === 251 ? "pole hole" : "missing") : "";
  return v > 1000 ? FLAGS[v] || "missing" : "";
}

// The cell (i, j) of grid g holding native (x, y), or null outside it.
export function cellOf(g, x, y) {
  const i = Math.floor((x - g.x0) / g.dx), j = Math.floor((g.y0 - y) / g.dy);
  return i >= 0 && j >= 0 && i < g.width && j < g.height ? [i, j] : null;
}

// The grid of a GeoTIFF image from its size, origin and resolution (as
// geotiff.js reports them) and its EPSG code; known G02135 sizes fall back
// to the published grids when the file has no usable georeferencing.
export function gridOf({ width, height, origin, resolution, epsg }) {
  if (origin && resolution && Number.isFinite(origin[0]) && Math.abs(resolution[0]) > 0) {
    const crs = epsg ? `EPSG:${epsg}` : width === NORTH.width ? NORTH.crs : SOUTH.crs;
    return { crs, width, height, x0: origin[0], y0: origin[1], dx: Math.abs(resolution[0]), dy: Math.abs(resolution[1]) };
  }
  if (width === SOUTH.width && height === SOUTH.height) return { ...SOUTH };
  if (width === NORTH.width && height === NORTH.height) return { ...NORTH };
  return null;
}

// RGBA for a concentration c (0..1) over the map below: nothing under 15
// percent (the usual edge), then white more and more opaque.
export function iceColour(c, out, k) {
  if (c === null || c < 0.15) return false;
  const a = 0.35 + 0.6 * Math.min(1, (c - 0.15) / 0.7);
  out[k] = out[k] * (1 - a) + 236 * a;
  out[k + 1] = out[k + 1] * (1 - a) + 244 * a;
  out[k + 2] = out[k + 2] * (1 - a) + 252 * a;
  return true;
}
