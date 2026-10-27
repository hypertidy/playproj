// The CRS of a gridded variable in a Zarr or Icechunk store, and the
// numbers that say how its grid behaves on the earth.
//
// A store says where its cells are in one of a few ways: an affine transform
// (GDAL's GeoTransform on a CF grid_mapping variable, GeoZarr's
// spatial:transform), or 1D coordinate arrays along the last two dimensions,
// in degrees (latitude, longitude) or in the units of a projection named by
// the CF grid_mapping attributes (CF conventions, appendix F). This module
// turns those into one description: a CRS (a PROJ string, or a rotated pole)
// and a regular axis for x and y with the edges of the first cell. Reading
// the store is left to the page; nothing here touches the network or DOM.
//
// It also reads and writes the URL hash gridlook uses,
// #<store URL>::name=value::name=value, so a link works in both.
//
// Angles are in degrees unless named otherwise.

import { obTran, cfToObTran } from "./grids.js";
import { knownProj4 } from "./structure.js";

const D2R = Math.PI / 180;

// ---------------------------------------------------------------- the hash

// "#https://host/store.zarr::varname=tas::projection=mollweide" as the URL
// and a Map of the rest; values are URL-encoded.
export function parseHash(hash) {
  const parts = String(hash || "").replace(/^#/, "").split("::");
  const dec = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  const url = dec(parts.shift() || "").trim();
  const params = new Map();
  for (const p of parts) {
    const k = p.indexOf("=");
    if (k > 0) params.set(p.slice(0, k), dec(p.slice(k + 1)));
  }
  return { url, params };
}

// The hash for url and params ({} or Map), skipping empty values. The URL
// keeps its slashes and colons, as gridlook writes it.
export function hashString(url, params = {}) {
  const enc = (s) => encodeURIComponent(s).replace(/%2F/gi, "/").replace(/%3A/gi, ":").replace(/%2C/gi, ",");
  const out = [encodeURI(url || "")];
  const entries = params instanceof Map ? [...params] : Object.entries(params);
  for (const [k, v] of entries) if (v !== undefined && v !== null && v !== "") out.push(`${k}=${enc(String(v))}`);
  return out.join("::");
}

// ---------------------------------------------------------------- display

// gridlook's projections (its "projection" hash value), as PROJ strings on a
// unit sphere. gridlook rotates each about lat, lon as d3 does; here lon is
// the central meridian of all, and lat the centre of the azimuthals only.
// Its cylindrical equal area is d3's default, standard parallel 38.58.
export const DISPLAY = [
  { key: "nearside_perspective", label: "Globe", def: null },
  { key: "equirectangular", label: "Equirectangular", def: "+proj=eqc" },
  { key: "mercator", label: "Mercator", def: "+proj=merc" },
  { key: "robinson", label: "Robinson", def: "+proj=robin" },
  { key: "mollweide", label: "Mollweide", def: "+proj=moll" },
  { key: "cylindrical_equal_area", label: "Cylindrical equal area", def: "+proj=cea +lat_ts=38.58" },
  { key: "azimuthal_equidistant", label: "Azimuthal equidistant", def: "+proj=aeqd", centred: true },
  { key: "lambert_azimuthal_equal_area", label: "Lambert azimuthal equal area", def: "+proj=laea", centred: true },
  // not in PROJ's proj4js set: drawn by src/core/families/spilhaus.js
  { key: "spilhaus", label: "Spilhaus (the world ocean)", def: null },
  { key: "native", label: "The store's own CRS", def: null }
];
export const DISPLAY_KEYS = DISPLAY.map((d) => d.key);

export function displayDef(key, lon = 0, lat = 0) {
  const d = DISPLAY.find((p) => p.key === key);
  if (!d || !d.def) return null;
  const c = d.centred ? ` +lat_0=${+lat.toFixed(6)}` : " +lat_0=0";
  return `${d.def} +lon_0=${+lon.toFixed(6)}${c} +x_0=0 +y_0=0 +R=1 +no_defs`;
}

// ---------------------------------------------------------------- CF grid mappings

const num = (v) => (v === undefined || v === null || v === "" ? undefined : Array.isArray(v) ? v.map(Number) : +v);
const fmt = (v) => +(+v).toPrecision(15);

// The figure of the earth from CF attributes, as PROJ parameters. CF's
// default where nothing is given is not defined; PROJ (and pyproj's
// from_cf) then takes WGS 84, and so does this.
export function cfEllipsoid(a) {
  const R = num(a.earth_radius), A = num(a.semi_major_axis), B = num(a.semi_minor_axis), rf = num(a.inverse_flattening);
  if (R) return `+R=${fmt(R)}`;
  if (A && B) return A === B ? `+R=${fmt(A)}` : `+a=${fmt(A)} +b=${fmt(B)}`;
  if (A && rf) return `+a=${fmt(A)} +rf=${fmt(rf)}`;
  if (A && rf === 0) return `+R=${fmt(A)}`;
  if (A) return `+R=${fmt(A)}`;
  return "+datum=WGS84";
}

// A CF grid_mapping variable's attributes as { proj4 } (a PROJ string),
// { rotated: [plon, plat, olon] } or { longlat: proj4 }, with name = the
// grid_mapping_name. null where the mapping is missing or not one of these.
export function cfProj(a) {
  if (!a || !a.grid_mapping_name) return null;
  const name = String(a.grid_mapping_name).trim();
  const ell = cfEllipsoid(a);
  const fe = num(a.false_easting) || 0, fn = num(a.false_northing) || 0;
  const off = `+x_0=${fmt(fe)} +y_0=${fmt(fn)}`;
  const lat0 = num(a.latitude_of_projection_origin) || 0;
  const lonc = num(a.longitude_of_central_meridian), lonp = num(a.longitude_of_projection_origin);
  const sp = num(a.standard_parallel);
  const sps = sp === undefined ? [] : Array.isArray(sp) ? sp : [sp];
  const k = num(a.scale_factor_at_projection_origin), kc = num(a.scale_factor_at_central_meridian);
  const out = (s) => ({ proj4: `${s} ${off} ${ell} +units=m +no_defs`, name });
  switch (name) {
    case "latitude_longitude":
      return { longlat: `+proj=longlat ${ell} +no_defs`, name };
    case "rotated_latitude_longitude":
      return { rotated: [num(a.grid_north_pole_longitude) || 0, num(a.grid_north_pole_latitude) ?? 90, num(a.north_pole_grid_longitude) || 0], ell, name };
    case "albers_conical_equal_area": {
      const [p1, p2 = p1] = sps.length ? sps : [0];
      return out(`+proj=aea +lat_0=${fmt(lat0)} +lon_0=${fmt(lonc ?? 0)} +lat_1=${fmt(p1)} +lat_2=${fmt(p2)}`);
    }
    case "lambert_conformal_conic": {
      const [p1, p2 = p1] = sps.length ? sps : [lat0];
      return out(`+proj=lcc +lat_0=${fmt(lat0)} +lon_0=${fmt(lonc ?? 0)} +lat_1=${fmt(p1)} +lat_2=${fmt(p2)}`);
    }
    case "lambert_azimuthal_equal_area":
      return out(`+proj=laea +lat_0=${fmt(lat0)} +lon_0=${fmt(lonp ?? 0)}`);
    case "azimuthal_equidistant":
      return out(`+proj=aeqd +lat_0=${fmt(lat0)} +lon_0=${fmt(lonp ?? 0)}`);
    case "orthographic":
      return out(`+proj=ortho +lat_0=${fmt(lat0)} +lon_0=${fmt(lonp ?? 0)}`);
    case "stereographic":
      return out(`+proj=stere +lat_0=${fmt(lat0)} +lon_0=${fmt(lonp ?? 0)} +k=${fmt(k ?? 1)}`);
    case "polar_stereographic": {
      const lon0 = num(a.straight_vertical_longitude_from_pole) ?? lonp ?? 0;
      const pole = lat0 < 0 ? -90 : 90;
      return out(`+proj=stere +lat_0=${pole} +lon_0=${fmt(lon0)} ` + (sps.length ? `+lat_ts=${fmt(sps[0])}` : `+k=${fmt(k ?? 1)}`));
    }
    case "transverse_mercator":
      return out(`+proj=tmerc +lat_0=${fmt(lat0)} +lon_0=${fmt(lonc ?? 0)} +k=${fmt(kc ?? k ?? 1)}`);
    case "mercator":
      return out(`+proj=merc +lon_0=${fmt(lonp ?? lonc ?? 0)} ` + (sps.length ? `+lat_ts=${fmt(sps[0])}` : `+k=${fmt(k ?? 1)}`));
    case "lambert_cylindrical_equal_area":
      return out(`+proj=cea +lon_0=${fmt(lonc ?? 0)} +lat_ts=${fmt(sps.length ? sps[0] : 0)}`);
    case "sinusoidal":
      return out(`+proj=sinu +lon_0=${fmt(lonc ?? 0)}`);
    case "geostationary": {
      const sweep = String(a.sweep_angle_axis || (a.fixed_angle_axis === "y" ? "x" : "y")).trim();
      return out(`+proj=geos +h=${fmt(num(a.perspective_point_height))} +lon_0=${fmt(lonp ?? 0)} +sweep=${sweep}`);
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- coordinates

// Recognise coordinate variables by CF standard_name, units, axis or the
// names everyone uses. attrs may be missing.
// includes NEMO (gphi*, glam*), CESM POP (tlat, ulat) and WRF (xlat) names
export const LAT_NAMES = new Set(["lat", "latitude", "nav_lat", "y_lat", "lats", "gphit", "gphiu", "gphiv", "gphif", "tlat", "ulat", "xlat"]);
export const LON_NAMES = new Set(["lon", "longitude", "nav_lon", "x_lon", "lons", "long", "glamt", "glamu", "glamv", "glamf", "tlong", "ulong", "xlong"]);
export function axisRole(name, attrs = {}) {
  const sn = String(attrs.standard_name || "").toLowerCase(), u = String(attrs.units || "").toLowerCase().replace(/\s+/g, "_");
  const base = String(name || "").split("/").pop().toLowerCase();
  if (sn === "latitude" || /^degrees?_?n(orth)?$/.test(u) || u === "degree_n" || LAT_NAMES.has(base)) return "lat";
  if (sn === "longitude" || /^degrees?_?e(ast)?$/.test(u) || u === "degree_e" || LON_NAMES.has(base)) return "lon";
  if (sn === "grid_latitude" || base === "rlat") return "rlat";
  if (sn === "grid_longitude" || base === "rlon") return "rlon";
  if (sn === "projection_x_coordinate" || attrs.axis === "X" || base === "x" || base === "xc") return "x";
  if (sn === "projection_y_coordinate" || attrs.axis === "Y" || base === "y" || base === "yc") return "y";
  return null;
}

// metres per unit of a projected coordinate
export function unitScale(units, h = 0) {
  const u = String(units || "m").trim().toLowerCase();
  // geostationary scan angles: radians times the satellite height
  if (h && (u === "rad" || u === "radian" || u === "radians")) return h;
  if (u === "km" || u === "kilometre" || u === "kilometer" || u === "kilometres" || u === "kilometers") return 1000;
  if (u === "100 km") return 1e5;
  if (u === "cm") return 0.01;
  return 1;
}

// A 1D coordinate (cell centres) as a regular axis: the step, the outer
// edge of the first cell, and how far the worst centre is from the line,
// in steps. Longitudes are unwrapped first, so 0..359.75 and -180..180 both
// come out increasing.
export function axisOf(values, { lon = false } = {}) {
  const v = Array.from(values, Number), n = v.length;
  if (!n) return null;
  if (lon) for (let i = 1; i < n; i++) { while (v[i] - v[i - 1] > 180) v[i] -= 360; while (v[i] - v[i - 1] < -180) v[i] += 360; }
  if (n === 1) return { n, step: 0, edge0: v[0], c0: v[0], c1: v[0], regular: true, dev: 0 };
  const step = (v[n - 1] - v[0]) / (n - 1);
  let dev = 0;
  for (let i = 0; i < n; i++) dev = Math.max(dev, Math.abs(v[i] - (v[0] + i * step)));
  dev = step ? dev / Math.abs(step) : Infinity;
  return { n, step, edge0: v[0] - step / 2, c0: v[0], c1: v[n - 1], regular: dev < 1e-3, dev };
}

// ---------------------------------------------------------------- the grid

// One description of where the cells are, from what the store gave:
//   t     an affine { x0, y0, dx, dy } (edges of the first cell) or null
//   x, y  axisOf() of the coordinate arrays, or null
//   crs   { proj4 } | { longlat } | { rotated } | { epsg } | { wkt } | null
// Returns { x0, dx, y0, dy, nx, ny, crs, geo } with x0 the left edge of
// column 0 and y0 the edge of row 0 (above it when dy < 0), or null.
export function gridOf({ t = null, x = null, y = null, nx, ny, crs = null, xScale = 1, yScale = 1 }) {
  if (t && isFinite(t.dx) && isFinite(t.dy)) return { x0: t.x0, dx: t.dx, y0: t.y0, dy: t.dy, nx, ny, crs, geo: t.geo || "transform" };
  if (x && y && x.n === nx && y.n === ny && x.step && y.step)
    return { x0: x.edge0 * xScale, dx: x.step * xScale, y0: y.edge0 * yScale, dy: y.step * yScale, nx, ny, crs, geo: "coordinates", regular: x.regular && y.regular, dev: Math.max(x.dev, y.dev) };
  return null;
}

// A coordinate at fractional edge index f (0 at the outer edge of the first
// cell, n at the far edge of the last) from n cell-centre values that need
// not be evenly spaced: linear between centres, so cell edges fall at the
// midpoints, and carried on past the end centres.
export function axisAt(c, f) {
  const n = c.length;
  if (n === 1) return c[0];
  const u = Math.max(-0.5, Math.min(n - 0.5, f - 0.5));
  const k = Math.max(0, Math.min(n - 2, Math.floor(u)));
  return c[k] + (u - k) * (c[k + 1] - c[k]);
}

// lon/lat at fractional edge index (fi, fj) of a curvilinear grid whose cell
// centres are lat[j * nx + i], lon[j * nx + i]: bilinear on unit vectors
// (so the seam and the poles do no harm), carried half a cell past the
// outermost centres. null where a corner is missing.
export function curvAt(g, fi, fj) {
  const { nx, ny, lat, lon } = g;
  const u = Math.max(-0.5, Math.min(nx - 0.5, fi - 0.5)), v = Math.max(-0.5, Math.min(ny - 0.5, fj - 0.5));
  const i0 = Math.max(0, Math.min(nx - 2, Math.floor(u))), j0 = Math.max(0, Math.min(ny - 2, Math.floor(v)));
  const a = nx > 1 ? u - i0 : 0, b = ny > 1 ? v - j0 : 0;
  const p = [0, 0, 0];
  const w = [[i0, j0, (1 - a) * (1 - b)], [i0 + 1, j0, a * (1 - b)], [i0, j0 + 1, (1 - a) * b], [i0 + 1, j0 + 1, a * b]];
  for (const [i, j, wt] of w) {
    if (!wt) continue;
    const m = Math.min(ny - 1, j) * nx + Math.min(nx - 1, i), la = lat[m] * D2R, lo = lon[m] * D2R;
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(lat[m]) > 90) return null;
    p[0] += wt * Math.cos(la) * Math.cos(lo); p[1] += wt * Math.cos(la) * Math.sin(lo); p[2] += wt * Math.sin(la);
  }
  const r = Math.hypot(p[0], p[1], p[2]);
  if (r < 1e-9) return null;
  return [Math.atan2(p[1], p[0]) / D2R, Math.asin(p[2] / r) / D2R];
}

// The area of a quadrilateral on the unit sphere with corners [lon, lat]
// in order: two spherical triangles (Van Oosterom and Strackee).
export function sphereQuadArea(q) {
  const v = q.map(([lo, la]) => [Math.cos(la * D2R) * Math.cos(lo * D2R), Math.cos(la * D2R) * Math.sin(lo * D2R), Math.sin(la * D2R)]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const tri = (a, b, c) => {
    const x = [b[1] * c[2] - b[2] * c[1], b[2] * c[0] - b[0] * c[2], b[0] * c[1] - b[1] * c[0]];
    return Math.abs(2 * Math.atan2(dot(a, x), 1 + dot(a, b) + dot(b, c) + dot(c, a)));
  };
  return tri(v[0], v[1], v[2]) + tri(v[0], v[2], v[3]);
}

// How far a cell is from square on the ground: the angular distortion
// (degrees) of the map from index space to the earth at a point, given
// the ground steps of one column (ei) and one row (ej) as [east, north].
export function cellShape(ei, ej) {
  const [p, q] = ei, [r, s] = ej;
  const A = p * p + q * q, B = p * r + q * s, C2 = r * r + s * s;
  const tr = A + C2, det = Math.abs(p * s - q * r), disc = Math.sqrt(Math.max(0, tr * tr / 4 - det * det));
  const a = Math.sqrt(tr / 2 + disc), b = Math.sqrt(Math.max(0, tr / 2 - disc));
  return { a, b, area: det, omega: (2 * Math.asin((a - b) / (a + b))) / D2R };
}

// the extent [xmin, ymin, xmax, ymax] of a grid's cell edges
export function gridExtent(g) {
  const xa = g.x0, xb = g.x0 + g.nx * g.dx, ya = g.y0, yb = g.y0 + g.ny * g.dy;
  return [Math.min(xa, xb), Math.min(ya, yb), Math.max(xa, xb), Math.max(ya, yb)];
}

// grid cell (i column, j row; fractions inside) to x, y and back
export const cellXY = (g, i, j) => [g.x0 + i * g.dx, g.y0 + j * g.dy];
export const xyCell = (g, x, y) => [(x - g.x0) / g.dx, (y - g.y0) / g.dy];

// The chunk holding index idx (one per dimension) and its key in the store.
export function chunkOf(idx, chunks) { return idx.map((v, d) => Math.floor(v / chunks[d])); }
export function chunkKey(c, { version = 3, separator } = {}) {
  const sep = separator || (version === 3 ? "/" : ".");
  return (version === 3 ? "c" + sep : "") + c.join(sep);
}

// ---------------------------------------------------------------- cell size on the earth

// The area of the band of an ellipsoid between two latitudes, per radian of
// longitude (the authalic latitude form; a sphere where es = 0). In units of
// a squared.
export function bandArea(lat1, lat2, es = 0) {
  const q = (phi) => {
    const s = Math.sin(phi * D2R);
    if (es < 1e-12) return 2 * s;
    const e = Math.sqrt(es);
    return (1 - es) * (s / (1 - es * s * s) - (1 / (2 * e)) * Math.log((1 - e * s) / (1 + e * s)));
  };
  return Math.abs(q(lat2) - q(lat1)) / 2;
}

// The ground area of a cell dlon wide between lat1 and lat2 (degrees), in
// units of a squared: exact on the ellipsoid, which a longlat grid makes easy.
export const lonLatCellArea = (dlon, lat1, lat2, es = 0) =>
  Math.abs(dlon * D2R) * bandArea(Math.max(-90, Math.min(90, lat1)), Math.max(-90, Math.min(90, lat2)), es);

// The ground area of a projected cell from its map area and the areal scale
// s at its centre (factors().s): both in units of a squared.
export const projectedCellArea = (mapArea, s) => mapArea / s;

// ---------------------------------------------------------------- reading cost

// Chunks and (uncompressed) bytes behind a whole 2D slice at one index of
// every other dimension.
export function sliceCost(shape, chunks, iy, ix, bytesPer = 4) {
  const cy = Math.ceil(shape[iy] / chunks[iy]), cx = Math.ceil(shape[ix] / chunks[ix]);
  let per = bytesPer;
  for (const c of chunks) per *= c;
  return { chunks: cx * cy, cx, cy, bytes: cx * cy * per, chunkBytes: per };
}

export const DTYPE_BYTES = { int8: 1, uint8: 1, bool: 1, int16: 2, uint16: 2, float16: 2, int32: 4, uint32: 4, float32: 4, int64: 8, uint64: 8, float64: 8 };
export function dtypeBytes(dt) {
  const s = String(dt || "").replace(/^[<>|=]/, "");
  if (DTYPE_BYTES[s]) return DTYPE_BYTES[s];
  const m = /^[fiub](\d+)$/.exec(s);
  return m ? +m[1] : 4;
}

// ---------------------------------------------------------------- CRS functions

const finite2 = (q) => q && Number.isFinite(q[0]) && Number.isFinite(q[1]);

// Forward and inverse for a CRS description (cfProj(), or { epsg },
// { wkt }, { proj4 }), with proj4js passed in:
//   fwd(lon, lat) -> [x, y] in the CRS's own units, or null
//   inv(x, y) -> [lon, lat], or null where the inverse does not come back
//   unit(lon, lat) -> [x, y] in units of the semi-major axis (radians for
//          an angular CRS), for factors()
//   es, a, angular, def (the PROJ string, or a description), label
// lookup(code) may give a PROJ string for an EPSG code knownProj4 lacks.
// Returns null where proj4js cannot make sense of it.
export function crsFunctions(crs, proj4, lookup = () => null) {
  if (!crs) return null;
  if (crs.rotated) {
    const [plon, plat, olon] = crs.rotated;
    const o = cfToObTran(plon, plat, olon), ob = obTran(o);
    const R = /\+R=([\d.eE+-]+)/.exec(crs.ell || "");
    return {
      fwd: (lon, lat) => ob.forward(lon, lat), inv: (x, y) => (Math.abs(y) <= 90 ? ob.inverse(x, y) : null),
      unit: (lon, lat) => { const q = ob.forward(lon, lat); return [q[0] * D2R, q[1] * D2R]; },
      es: 0, a: R ? +R[1] : 6371229, angular: true, label: "rotated pole",
      def: `+proj=ob_tran +o_proj=longlat +o_lat_p=${fmt(o.oLatP)} +o_lon_p=${fmt(o.oLonP)} +lon_0=${fmt(o.lon0)} ${crs.ell && crs.ell !== "+datum=WGS84" ? crs.ell : "+R=6371229"} +no_defs`
    };
  }
  let def = crs.proj4 || crs.longlat || null, label = crs.name || null;
  if (!def && crs.epsg) { def = knownProj4(crs.epsg) || lookup(crs.epsg); label = `EPSG:${crs.epsg}`; }
  if (!def && crs.wkt) { def = crs.wkt; label = label || "WKT"; }
  if (!def) return null;
  let P, tr;
  try {
    P = proj4.Proj(def);
    const b = P.b ?? P.a * Math.sqrt(1 - (P.es || 0));
    tr = proj4(`+proj=longlat +a=${P.a} +b=${b} +no_defs`, def);
  } catch (e) {
    return null;
  }
  const angular = P.projName === "longlat" || P.projName === "lonlat" || P.projName === "latlong" || P.projName === "identity";
  const a = P.a, es = P.es || 0;
  const fwd = (lon, lat) => {
    if (angular) return [lon, lat];
    let q;
    try { q = tr.forward([lon, lat]); } catch (e) { return null; }
    return finite2(q) ? [q[0], q[1]] : null;
  };
  const inv = (x, y) => {
    if (angular) return Math.abs(y) <= 90 ? [x, y] : null;
    let q;
    try { q = tr.inverse([x, y]); } catch (e) { return null; }
    if (!finite2(q) || Math.abs(q[1]) > 90) return null;
    // outside the CRS's domain proj4js can still answer: insist on the way back
    const b = fwd(q[0], q[1]);
    return b && Math.hypot(b[0] - x, b[1] - y) <= 1e-5 * Math.max(1, Math.hypot(x, y)) ? [q[0], q[1]] : null;
  };
  const unit = angular ? (lon, lat) => [lon * D2R, lat * D2R] : (lon, lat) => {
    const q = fwd(lon, lat);
    if (!q) return null;
    // as tissot.proj4Forward: points that do not come back are off the map
    const r = inv(q[0], q[1]);
    if (!r) return null;
    let dl = Math.abs(r[0] - lon) % 360; dl = Math.min(dl, 360 - dl);
    if (Math.abs(r[1] - lat) > 1e-4 || (Math.abs(lat) < 89.9 && dl * Math.cos(lat * D2R) > 1e-4)) return null;
    return [q[0] / a, q[1] / a];
  };
  return { fwd, inv, unit, es, a, angular, def: String(def), label: label || (angular ? "longitude, latitude" : P.projName) };
}
