// Cones, with the cylinder and the plane as its two limits.
//
// A cone touches the sphere along one standard parallel, phi1. Its cone
// constant n = sin(phi1) is the fraction of a full circle the cone fills
// when it is cut along a meridian and laid flat:
//
//   phi1 = 0    n = 0   cylinder (touches the equator)
//   0 < phi1    0<n<1   cone
//   phi1 = 90   n = 1   plane (touches the pole)
//
// Where each parallel lands along the cone depends on the property kept:
//
//   property     cylinder   cone   plane
//   equidistant  eqc        eqdc   aeqd
//   conformal    merc       lcc    stere
//   equal-area   cea        aea    laea
//
// so one slider for phi1 morphs each row continuously. Southern cones
// (phi1 < 0) are the mirror image of northern ones.

import { esriGeoKeys } from "../geotiff-write.js";

export const R = 6370997;
const D2R = Math.PI / 180;
const EPS_N = 1e-9;

export const properties = [
  { id: "eqd", label: "Equidistant", note: "meridians keep their true length" },
  { id: "conf", label: "Conformal", note: "angles and small shapes are kept" },
  { id: "area", label: "Equal-area", note: "areas are kept" }
];

const NAMES = {
  eqd: ["eqc", "eqdc", "aeqd"],
  conf: ["merc", "lcc", "stere"],
  area: ["cea", "aea", "laea"]
};

// Rho (distance from the apex in the flat map, sphere radii) for latitude
// phi on the northern cone with standard parallel phi1 (both radians, phi1 > 0).
function rhoOf(prop, phi, phi1, n) {
  if (prop === "eqd") return 1 / Math.tan(phi1) + phi1 - phi;
  if (prop === "conf") {
    const F = Math.cos(phi1) * Math.pow(Math.tan(Math.PI / 4 + phi1 / 2), n) / n;
    return F / Math.pow(Math.tan(Math.PI / 4 + phi / 2), n);
  }
  const C = Math.cos(phi1) ** 2 + 2 * n * Math.sin(phi1);
  return Math.sqrt(Math.max(0, C - 2 * n * Math.sin(phi))) / n;
}

function phiOf(prop, rho, phi1, n) {
  if (prop === "eqd") return 1 / Math.tan(phi1) + phi1 - rho;
  if (prop === "conf") {
    const F = Math.cos(phi1) * Math.pow(Math.tan(Math.PI / 4 + phi1 / 2), n) / n;
    return 2 * Math.atan(Math.pow(F / rho, 1 / n)) - Math.PI / 2;
  }
  const C = Math.cos(phi1) ** 2 + 2 * n * Math.sin(phi1);
  const s = (C - rho * rho * n * n) / (2 * n);
  return Math.abs(s) <= 1 ? Math.asin(s) : NaN;
}

// Cylinder (n = 0) y as a function of latitude, and back.
const CYL = {
  eqd: [(phi) => phi, (y) => y],
  conf: [(phi) => Math.log(Math.tan(Math.PI / 4 + phi / 2)), (y) => 2 * Math.atan(Math.exp(y)) - Math.PI / 2],
  area: [(phi) => Math.sin(phi), (y) => (Math.abs(y) <= 1 ? Math.asin(y) : NaN)]
};

// Plane at the pole (n = 1): rho from colatitude, and back.
const POLAR = {
  eqd: [(phi) => Math.PI / 2 - phi, (r) => (r <= Math.PI ? Math.PI / 2 - r : NaN)],
  conf: [(phi) => 2 * Math.tan(Math.PI / 4 - phi / 2), (r) => Math.PI / 2 - 2 * Math.atan(r / 2)],
  area: [(phi) => 2 * Math.sin(Math.PI / 4 - phi / 2), (r) => (r <= 2 ? Math.PI / 2 - 2 * Math.asin(r / 2) : NaN)]
};

export function kind(p) {
  const n = Math.sin(Math.abs(p.lat1) * D2R);
  return n < EPS_N ? 0 : n > 1 - EPS_N ? 2 : 1;
}

export function coneConstant(p) {
  return Math.sin(Math.abs(p.lat1) * D2R);
}

// Forward: lon/lat degrees -> flat map x/y in sphere radii, origin at the
// standard parallel on the central meridian. Null where undefined.
export function project(lon, lat, p) {
  const s = p.lat1 < 0 ? -1 : 1;
  const phi = s * lat * D2R, phi1 = Math.abs(p.lat1) * D2R;
  let dl = ((lon - p.lon0 + 540) % 360) - 180;
  const lam = dl * D2R;
  const k = kind(p);
  let x, y;
  if (k === 0) {
    if (p.prop === "conf" && Math.abs(phi) > 89.5 * D2R) return null;
    x = lam; y = CYL[p.prop][0](phi);
  } else if (k === 2) {
    if (p.prop === "conf" && phi < -89.5 * D2R) return null;
    const r = POLAR[p.prop][0](phi);
    x = r * Math.sin(lam); y = -r * Math.cos(lam);
  } else {
    if (p.prop === "conf" && phi < -89.5 * D2R) return null;
    const n = Math.sin(phi1);
    const rho = rhoOf(p.prop, phi, phi1, n), rho0 = 1 / Math.tan(phi1);
    x = rho * Math.sin(n * lam); y = rho0 - rho * Math.cos(n * lam);
  }
  return isFinite(x) && isFinite(y) ? [x, s * y] : null;
}

export function inverse(x, y, p) {
  const s = p.lat1 < 0 ? -1 : 1;
  y *= s;
  const phi1 = Math.abs(p.lat1) * D2R;
  const k = kind(p);
  let lam, phi;
  if (k === 0) {
    lam = x; phi = CYL[p.prop][1](y);
  } else if (k === 2) {
    const r = Math.hypot(x, y);
    lam = Math.atan2(x, -y); phi = POLAR[p.prop][1](r);
  } else {
    const n = Math.sin(phi1), rho0 = 1 / Math.tan(phi1);
    const rho = Math.hypot(x, rho0 - y);
    lam = Math.atan2(x, rho0 - y) / n;
    phi = phiOf(p.prop, rho, phi1, n);
  }
  if (!isFinite(phi) || Math.abs(lam) > Math.PI + 1e-12 || Math.abs(phi) > Math.PI / 2) return null;
  const lon = ((p.lon0 + lam / D2R + 540) % 360) - 180;
  return [lon, s * phi / D2R];
}

// Flat polar coordinates (rho, alpha) about the apex for a lon/lat, used to
// roll the flat map back onto a cone. For the cylinder the apex is put far
// away (n = 1e-4), which is indistinguishable at this scale.
export const N_MIN = 1e-4;
export function flatPolar(lon, lat, p) {
  const xy = project(lon, lat, p);
  if (!xy) return null;
  const n = Math.max(N_MIN, coneConstant(p));
  const s = p.lat1 < 0 ? -1 : 1;
  const x = xy[0], y = s * xy[1];
  // plane and cylinder maps measure from a different origin than the apex
  const k = kind(p);
  const rho0 = k === 2 ? 0 : 1 / Math.tan(Math.max(Math.asin(N_MIN), Math.abs(p.lat1) * D2R));
  return [Math.hypot(x, rho0 - y), Math.atan2(x, rho0 - y), rho0, n];
}

export function projString(p) {
  const k = kind(p);
  const name = NAMES[p.prop][k];
  const lon = `+lon_0=${fmt(p.lon0)}`;
  const tail = `+R=${R}`;
  if (k === 0) {
    if (name === "eqc") return `+proj=eqc +lat_0=0 ${lon} ${tail}`;
    if (name === "cea") return `+proj=cea +lat_ts=0 ${lon} ${tail}`;
    return `+proj=merc ${lon} ${tail}`;
  }
  if (k === 2) return `+proj=${name} +lat_0=${p.lat1 < 0 ? -90 : 90} ${lon} ${tail}`;
  const l1 = fmt(p.lat1);
  if (name === "lcc") return `+proj=lcc +lat_0=${l1} +lat_1=${l1} ${lon} ${tail}`;
  return `+proj=${name} +lat_0=${l1} +lat_1=${l1} +lat_2=${l1} ${lon} ${tail}`;
}

export function proj4String(p) {
  return projString(p) + " +x_0=0 +y_0=0";
}

export function describe(p) {
  const k = kind(p);
  const prop = properties.find((q) => q.id === p.prop);
  const where = k === 0 ? "A cylinder touches the equator" :
    k === 2 ? `A plane touches the ${p.lat1 < 0 ? "south" : "north"} pole` :
    `A cone touches the parallel at ${fmt(p.lat1)} degrees, and fills ${fmt(100 * coneConstant(p))}% of a circle when flat`;
  return `${where}. ${prop.label}: ${prop.note}.`;
}

export function geoKeys(p) {
  const k = kind(p), name = NAMES[p.prop][k];
  const sph = `GEOGCS["GCS_Sphere",DATUM["D_Sphere",SPHEROID["Sphere",${R},0.0]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]`;
  const fe = `PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0]`;
  const cm = `PARAMETER["Central_Meridian",${p.lon0}]`;
  const l1 = p.lat1, pole = l1 < 0 ? -90 : 90;
  const body = {
    eqc: `PROJECTION["Equidistant_Cylindrical"],${fe},${cm},PARAMETER["Standard_Parallel_1",0.0]`,
    merc: `PROJECTION["Mercator"],${fe},${cm},PARAMETER["Standard_Parallel_1",0.0]`,
    cea: `PROJECTION["Cylindrical_Equal_Area"],${fe},${cm},PARAMETER["Standard_Parallel_1",0.0]`,
    eqdc: `PROJECTION["Equidistant_Conic"],${fe},${cm},PARAMETER["Standard_Parallel_1",${l1}],PARAMETER["Standard_Parallel_2",${l1}],PARAMETER["Latitude_Of_Origin",${l1}]`,
    lcc: `PROJECTION["Lambert_Conformal_Conic"],${fe},${cm},PARAMETER["Standard_Parallel_1",${l1}],PARAMETER["Scale_Factor",1.0],PARAMETER["Latitude_Of_Origin",${l1}]`,
    aea: `PROJECTION["Albers"],${fe},${cm},PARAMETER["Standard_Parallel_1",${l1}],PARAMETER["Standard_Parallel_2",${l1}],PARAMETER["Latitude_Of_Origin",${l1}]`,
    aeqd: `PROJECTION["Azimuthal_Equidistant"],${fe},${cm},PARAMETER["Latitude_Of_Origin",${pole}]`,
    stere: `PROJECTION["Stereographic"],${fe},${cm},PARAMETER["Scale_Factor",1.0],PARAMETER["Latitude_Of_Origin",${pole}]`,
    laea: `PROJECTION["Lambert_Azimuthal_Equal_Area"],${fe},${cm},PARAMETER["Latitude_Of_Origin",${pole}]`
  }[name];
  return esriGeoKeys(`PROJCS["playproj_${name}",${sph},${body},UNIT["Meter",1.0]]`, R, `playproj ${name}`);
}

function fmt(x) {
  return String(+(+x).toFixed(4));
}
