// Azimuthal projections with no point of light, drawn on the same sphere and
// tangent plane as the perspective family. Each point keeps its direction
// (azimuth) from the tangent point; only its distance on the plane differs:
//
//   laea  compass: the straight chord from the tangent point to the point,
//         swung down onto the plane, so rho = 2 sin(c / 2)
//   aeqd  string: the great-circle arc from the tangent point, laid flat,
//         so rho = c
//
// where c is the angular distance from the tangent point.

import { esriGeoKeys } from "../geotiff-write.js";

export const R = 6370997;

export const defaults = { mode: "laea", lat0: -90, lon0: 0 };
const D2R = Math.PI / 180;

export const modes = {
  laea: {
    label: "Compass (equal-area)",
    rho: (c) => 2 * Math.sin(c / 2),
    c: (r) => (r <= 2 ? 2 * Math.asin(r / 2) : NaN),
    esri: "Lambert_Azimuthal_Equal_Area",
    text: "Lambert azimuthal equal-area: each point's straight-line distance (the chord) from the tangent point is swung down onto the plane like a compass."
  },
  aeqd: {
    label: "String (equidistant)",
    rho: (c) => c,
    c: (r) => (r <= Math.PI ? r : NaN),
    esri: "Azimuthal_Equidistant",
    text: "Azimuthal equidistant: the great-circle path from the tangent point to each point is laid flat on the plane like a string."
  }
};

// Every point but the antipode reaches the plane.
export function horizonCos() {
  return -1;
}

// The antipode lands on a circle around the tangent point: the edge of the map.
export function edgeRadius(p) {
  return modes[p.mode].rho(Math.PI);
}

export function project(lon, lat, p) {
  const m = modes[p.mode];
  const phi = lat * D2R, phi0 = p.lat0 * D2R, dl = (lon - p.lon0) * D2R;
  const sp = Math.sin(phi), cp = Math.cos(phi), sp0 = Math.sin(phi0), cp0 = Math.cos(phi0);
  const cosc = Math.max(-1, Math.min(1, sp0 * sp + cp0 * cp * Math.cos(dl)));
  const c = Math.acos(cosc);
  if (c > Math.PI - 1e-6) return null;
  const e = cp * Math.sin(dl), nth = cp0 * sp - sp0 * cp * Math.cos(dl);
  if (c < 1e-12) return [0, 0];
  const k = m.rho(c) / Math.sin(c);
  return [k * e, k * nth];
}

export function inverse(x, y, p) {
  const m = modes[p.mode];
  const r = Math.hypot(x, y);
  const c = m.c(r);
  if (!isFinite(c)) return null;
  if (r < 1e-12) return [p.lon0, p.lat0];
  const phi0 = p.lat0 * D2R, sp0 = Math.sin(phi0), cp0 = Math.cos(phi0);
  const sc = Math.sin(c), cc = Math.cos(c);
  const lat = Math.asin(Math.max(-1, Math.min(1, cc * sp0 + (y * sc * cp0) / r))) / D2R;
  let lon = p.lon0 + Math.atan2(x * sc, r * cp0 * cc - y * sp0 * sc) / D2R;
  lon = ((lon + 540) % 360) - 180;
  return [lon, lat];
}

export function projString(p) {
  return `+proj=${p.mode} +lat_0=${fmt(p.lat0)} +lon_0=${fmt(p.lon0)} +R=${R}`;
}

export function proj4String(p) {
  return projString(p) + " +x_0=0 +y_0=0";
}

export function describe(p) {
  return modes[p.mode].text;
}

export function geoKeys(p) {
  const wkt = `PROJCS["playproj_${p.mode}",GEOGCS["GCS_Sphere",DATUM["D_Sphere",SPHEROID["Sphere",${R},0.0]],` +
    `PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["${modes[p.mode].esri}"],` +
    `PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",${p.lon0}],` +
    `PARAMETER["Latitude_Of_Origin",${p.lat0}],UNIT["Meter",1.0]]`;
  return esriGeoKeys(wkt, R, `playproj ${p.mode}`);
}

function fmt(x) {
  return String(+(+x).toFixed(4));
}
