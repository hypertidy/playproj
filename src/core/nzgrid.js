// New Zealand Transverse Mercator 2000 (NZTM2000, EPSG:2193) and the
// NZTopo50 map sheets cut from it.
//
// NZTM is one transverse Mercator for the whole country on NZGD2000 (GRS80):
// central meridian 173E, scale 0.9996, false easting 1 600 000 and false
// northing 10 000 000. Krueger's series as PROJ's tmerc (krueger() from
// src/core/osgb.js).
//
// Topo50 sheets are 24 km wide and 36 km tall on a lattice of NZTM: a sheet's
// west edge is E 988 000 + 24 000 x its column number, and its north edge is
// N 6 810 000 - 36 000 x its row, the rows lettered AA, AB ... AZ, BA ...
// from the north, without I and O. The sheet list is LINZ's
// (data/nz-topo50.json); test/check-nzgrid.mjs checks the lattice against
// every sheet in it and the projection against PROJ.
//
// NZGD2000 is fixed to New Zealand at 2000.0 and GPS (WGS84, ITRF)
// positions move away from it with the plate, by a few centimetres a year;
// here the two are taken as the same.

import { krueger } from "./osgb.js";

export const GRS80 = { a: 6378137, f: 1 / 298.257222101 };
export const NZTM = { lon0: 173, k0: 0.9996, x0: 1600000, y0: 10000000 };
const TM = krueger(GRS80.a, GRS80.f);
const D2R = Math.PI / 180;

export function toGrid(lon, lat) {
  const [x, y] = TM.forward(lon, lat, NZTM.lon0, NZTM.k0);
  return [x + NZTM.x0, y + NZTM.y0];
}
export function fromGrid(e, n) {
  return TM.inverse(e - NZTM.x0, n - NZTM.y0, NZTM.lon0, NZTM.k0);
}

export function scaleAndConvergence(lon, lat) {
  const d = 1e-6, [x1, y1] = toGrid(lon, lat - d), [x2, y2] = toGrid(lon, lat + d);
  const s = Math.sin(lat * D2R), w = Math.sqrt(1 - TM.e2 * s * s), rho = (GRS80.a * (1 - TM.e2)) / (w * w * w);
  return { k: Math.hypot(x2 - x1, y2 - y1) / (rho * 2 * d * D2R), conv: Math.atan2(x2 - x1, y2 - y1) / D2R };
}
export function trueScaleOffset(lat) {
  let lo = 0, hi = 6;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (scaleAndConvergence(NZTM.lon0 + mid, lat).k < 1) lo = mid; else hi = mid;
  }
  return toGrid(NZTM.lon0 + lo, lat)[0] - NZTM.x0;
}

// ---------------------------------------------------------------- Topo50 sheets

export const SHEET = { w: 24000, h: 36000, x0: 988000, y0: 6810000 };
const ROWL = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // 24 letters, no I or O

export const rowName = (r) => ROWL[Math.floor(r / 24)] + ROWL[r % 24];
export function rowIndex(name) {
  const a = ROWL.indexOf(name[0]), b = ROWL.indexOf(name[1]);
  return a < 0 || b < 0 ? -1 : a * 24 + b;
}

// The sheet (on the lattice) holding e, n: its code and edges.
export function sheetAt(e, n) {
  const col = Math.floor((e - SHEET.x0) / SHEET.w), row = Math.floor((SHEET.y0 - n) / SHEET.h);
  if (col < 0 || col > 99 || row < 0 || row >= 24 * 24) return null;
  return sheetFrame(rowName(row) + String(col).padStart(2, "0"));
}
// The edges of a sheet from its code ("BQ31").
export function sheetFrame(code) {
  const m = /^([A-Z]{2})(\d{2})$/.exec(String(code).toUpperCase());
  if (!m) return null;
  const row = rowIndex(m[1]), col = +m[2];
  if (row < 0) return null;
  const west = SHEET.x0 + col * SHEET.w, north = SHEET.y0 - row * SHEET.h;
  return { code: m[1] + m[2], row, col, west, north, east: west + SHEET.w, south: north - SHEET.h };
}

// A grid reference on a sheet: the sheet code, then easting and northing
// digits inside the 100 km square (the 100 km digits are left off, as on
// the sheet's margin), each truncated to the cell the point falls in.
export function gridRef(e, n, figures = 6) {
  const s = sheetAt(e, n), d = figures / 2;
  const part = (v) => String(Math.floor(v % 1e5)).padStart(5, "0").slice(0, d);
  return { sheet: s && s.code, e: part(e), n: part(n), text: `${s ? s.code + " " : ""}${part(e)} ${part(n)}` };
}

// Everything the explainer says about a lon, lat (NZGD2000, taken as GPS).
export function describe(lon, lat) {
  const [e, n] = toGrid(lon, lat), { k, conv } = scaleAndConvergence(lon, lat);
  return { lon, lat, e, n, k, conv, sheet: sheetAt(e, n), six: gridRef(e, n, 6), eight: gridRef(e, n, 8), trueScale: trueScaleOffset(lat), fromCM: e - NZTM.x0 };
}

// New Zealand's main islands and near ones, loosely (not the Chatham or
// subantarctic islands, which have grids of their own).
export const inNZ = (lon, lat) => lon > 166 && lon < 179 && lat > -47.5 && lat < -34;
