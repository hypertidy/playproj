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
// Equal Earth is not one of gridlook's; its key is in gridlook's style.
export const DISPLAY = [
  { key: "nearside_perspective", label: "Globe", def: null },
  { key: "equirectangular", label: "Equirectangular", def: "+proj=eqc" },
  { key: "mercator", label: "Mercator", def: "+proj=merc" },
  { key: "robinson", label: "Robinson", def: "+proj=robin" },
  { key: "mollweide", label: "Mollweide", def: "+proj=moll" },
  { key: "equal_earth", label: "Equal Earth", def: "+proj=eqearth" },
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

// The order of a 1D coordinate along its index: "increasing", "decreasing",
// "constant" or "unordered", with the steps that go against the overall
// direction and the indexes of the smallest and largest values. A time axis
// joined from files in the wrong order comes out unordered.
export function coordOrder(values) {
  const v = Array.from(values, Number), n = v.length;
  let up = 0, down = 0, lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    if (v[i] < v[lo]) lo = i;
    if (v[i] > v[hi]) hi = i;
    if (i) { if (v[i] > v[i - 1]) up++; else if (v[i] < v[i - 1]) down++; }
  }
  const order = !up && !down ? "constant" : !down ? "increasing" : !up ? "decreasing" : "unordered";
  return { order, n, against: Math.min(up, down), lo, hi };
}

// ---------------------------------------------------------------- CF calendars

// Days from 1970-01-01 on the proleptic Gregorian calendar and back, for
// any year (Hinnant's days_from_civil), with year 0 the year before 1.
const fdiv = (a, b) => Math.floor(a / b);
function gregorianDays(y, m, d) {
  y -= m <= 2;
  const era = fdiv(y, 400), yoe = y - era * 400;
  const doy = fdiv(153 * (m > 2 ? m - 3 : m + 9) + 2, 5) + d - 1;
  return era * 146097 + yoe * 365 + fdiv(yoe, 4) - fdiv(yoe, 100) + doy - 719468;
}
function gregorianDate(n) {
  n += 719468;
  const era = fdiv(n, 146097), doe = n - era * 146097;
  const yoe = fdiv(doe - fdiv(doe, 1460) + fdiv(doe, 36524) - fdiv(doe, 146096), 365);
  return marchDate(yoe + era * 400, doe - (365 * yoe + fdiv(yoe, 4) - fdiv(yoe, 100)));
}
// the same on the Julian calendar (a leap year every 4), counted so that a
// day has the same number on both: Julian 1582-10-05 is Gregorian 1582-10-15
function julianRaw(y, m, d) {
  y -= m <= 2;
  const era = fdiv(y, 4), yoe = y - era * 4;
  return era * 1461 + yoe * 365 + fdiv(153 * (m > 2 ? m - 3 : m + 9) + 2, 5) + d - 1;
}
const CUTOVER = gregorianDays(1582, 10, 15), JULIAN = CUTOVER - julianRaw(1582, 10, 5);
const julianDays = (y, m, d) => julianRaw(y, m, d) + JULIAN;
function julianDate(n) {
  n -= JULIAN;
  const era = fdiv(n, 1461), doe = n - era * 1461, yoe = fdiv(doe - fdiv(doe, 1460), 365);
  return marchDate(yoe + era * 4, doe - 365 * yoe);
}
// year, month, day from a year that starts on 1 March and the day in it
function marchDate(y, doy) {
  const mp = fdiv(5 * doy + 2, 153), d = doy - fdiv(153 * mp + 2, 5) + 1, m = mp < 10 ? mp + 3 : mp - 9;
  return [y + (m <= 2), m, d];
}
// calendars with years all one length: noleap, all_leap and 360_day
function fixedYear(months) {
  const start = [0];
  months.forEach((n, i) => start.push(start[i] + n));
  const len = start[12];
  return {
    days: (y, m, d) => y * len + start[m - 1] + d - 1,
    date(n) {
      const y = fdiv(n, len), r = n - y * len;
      let m = 0;
      while (start[m + 1] <= r) m++;
      return [y, m + 1, r - start[m] + 1];
    }
  };
}
const NOLEAP = fixedYear([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
const ALL_LEAP = fixedYear([31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
const DAY360 = fixedYear(Array(12).fill(30));
const PROLEPTIC = { days: gregorianDays, date: gregorianDate, yearZero: true };
// the CF default: Julian up to 1582-10-04, Gregorian from the next day,
// 1582-10-15. It and julian have no year 0 (year -1 comes before year 1),
// as cftime has them; the others count year 0.
const STANDARD = {
  days: (y, m, d) => (y > 1582 || (y === 1582 && (m > 10 || (m === 10 && d >= 15))) ? gregorianDays(y, m, d) : julianDays(y, m, d)),
  date: (n) => (n >= CUTOVER ? gregorianDate(n) : julianDate(n))
};
const CALENDARS = {
  standard: STANDARD, gregorian: STANDARD, utc: PROLEPTIC, tai: PROLEPTIC,
  proleptic_gregorian: PROLEPTIC, julian: { days: julianDays, date: julianDate },
  noleap: { ...NOLEAP, yearZero: true }, "365_day": { ...NOLEAP, yearZero: true },
  all_leap: { ...ALL_LEAP, yearZero: true }, "366_day": { ...ALL_LEAP, yearZero: true },
  "360_day": { ...DAY360, yearZero: true }
};

// The CF calendars this reads, by the names the calendar attribute uses.
export const CF_CALENDARS = Object.keys(CALENDARS);

// A CF time value as a date and time, for units "<unit> since <date>[
// <time>]" (seconds to days) on the CF calendar named (any case; none
// given is "standard"), to the second; null where the units are not a time
// or the calendar is not one CF defines (such as "none").
export function cfTime(x, units, calendar) {
  if (typeof x === "bigint") x = Number(x);
  const cal = CALENDARS[String(calendar || "standard").trim().toLowerCase()];
  const m = /^\s*(seconds?|minutes?|hours?|days?)\s+since\s+(-?\d{1,4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d*)?))?)?/.exec(units || "");
  if (!cal || !m || !Number.isFinite(x)) return null;
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[m[1][0]];
  let Y = +m[2];
  if (!cal.yearZero && Y < 0) Y++;
  const t = Math.round(cal.days(Y, +m[3], +m[4]) * 86400 + (+m[5] || 0) * 3600 + (+m[6] || 0) * 60 + (+m[7] || 0) + x * unit);
  if (!Number.isSafeInteger(t)) return null;
  const n = fdiv(t, 86400), sec = t - n * 86400;
  let [y, mo, d] = cal.date(n);
  if (!cal.yearZero && y <= 0) y--;
  const p2 = (v) => String(v).padStart(2, "0");
  const date = `${y < 0 ? "-" : ""}${String(Math.abs(y)).padStart(4, "0")}-${p2(mo)}-${p2(d)}`;
  if (!sec) return date;
  const hh = fdiv(sec, 3600), mm = fdiv(sec % 3600, 60), ss = sec % 60;
  return `${date} ${p2(hh)}:${p2(mm)}${ss ? ":" + p2(ss) : ""}`;
}

// The other way: a date ("YYYY-MM-DD", maybe " HH:MM[:SS]" or "THH:MM")
// as a value in CF time units on the calendar named, or null where either
// is not one cfTime reads. cfTime(cfValue(d, u, c), u, c) is d again.
export function cfValue(date, units, calendar) {
  const cal = CALENDARS[String(calendar || "standard").trim().toLowerCase()];
  const re = /^\s*(-?\d{1,4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d*)?))?)?\s*$/;
  const m = /^\s*(seconds?|minutes?|hours?|days?)\s+since\s+(.*)$/.exec(units || "");
  const d = re.exec(String(date || "")), e = m && re.exec(m[2].replace(/\s*(UTC|Z|[+-]00(:?00)?)\s*$/i, ""));
  if (!cal || !d || !e) return null;
  const secs = (p) => {
    let Y = +p[1];
    if (!cal.yearZero && Y < 0) Y++;
    return cal.days(Y, +p[2], +p[3]) * 86400 + (+p[4] || 0) * 3600 + (+p[5] || 0) * 60 + (+p[6] || 0);
  };
  return (secs(d) - secs(e)) / { s: 1, m: 60, h: 3600, d: 86400 }[m[1][0]];
}

// How many of a CF time's units make a day (1 for days, 24 for hours), or
// null where the units are not a time since a date.
export function cfPerDay(units) {
  const m = /^\s*(seconds?|minutes?|hours?|days?)\s+since\s/.exec(units || "");
  return m ? 86400 / { s: 1, m: 60, h: 3600, d: 86400 }[m[1][0]] : null;
}

// A CF time span (units a time unit with no "since", as a forecast's lead
// time is) as days, hours and minutes: "0 h", "3 h", "1 d 6 h", "15 d"; null
// where the units are not a time unit.
export function cfDuration(x, units) {
  if (typeof x === "bigint") x = Number(x);
  const m = /^\s*(seconds?|secs?|s|minutes?|mins?|hours?|hrs?|h|days?|d)\s*$/i.exec(units || "");
  if (!m || !Number.isFinite(x)) return null;
  const u = m[1].toLowerCase(), sec = Math.round(x * (u.startsWith("d") ? 86400 : u.startsWith("h") ? 3600 : u.startsWith("m") ? 60 : 1));
  const a = Math.abs(sec), d = Math.floor(a / 86400), h = Math.floor((a % 86400) / 3600), mi = Math.floor((a % 3600) / 60), s = a % 60;
  const parts = [d && `${d} d`, h && `${h} h`, mi && `${mi} min`, s && `${s} s`].filter(Boolean);
  return (sec < 0 ? "-" : "") + (parts.join(" ") || "0 h");
}

// Whether a calendar's dates are not the Gregorian ones everyone keeps
// (noleap, 360_day and the like), so that a page says which it is.
export function oddCalendar(calendar) {
  const c = String(calendar || "standard").trim().toLowerCase();
  return !["standard", "gregorian", "proleptic_gregorian", "utc", "tai"].includes(c);
}

// ---------------------------------------------------------------- fill values

// A _FillValue or missing_value attribute as numbers: a number, a list of
// them, "NaN" and the like, or a float as xarray writes it in Zarr v3
// attributes (base64 of the 8 bytes of a little-endian double).
export function attrFill(a) {
  if (typeof a === "number") return [a];
  if (typeof a === "bigint") return [Number(a)];
  if (Array.isArray(a)) return a.flatMap(attrFill);
  if (typeof a !== "string") return [];
  const t = a.trim(), named = { NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity };
  if (t in named) return [named[t]];
  if (/^[A-Za-z0-9+/]{11}=$/.test(t)) {
    const bin = atob(t), b = new Uint8Array(8);
    for (let i = 0; i < 8; i++) b[i] = bin.charCodeAt(i);
    return [new DataView(b.buffer).getFloat64(0, true)];
  }
  return t !== "" && Number.isFinite(+t) ? [+t] : [];
}

// ---------------------------------------------------------------- profiles

// A collection of profiles (a CF discrete sampling geometry, as Argo and
// MEOP files have them): a variable on (profile, level) with one latitude
// and longitude per profile, 1D arrays along the profile dimension. From
// the variable's dims and attributes and the arrays beside it ({ name,
// dims, attrs }), the names of their roles:
//   instance  the profile dimension; level  the other one
//   lat, lon  a position per profile; time  a CF time per profile, if any
//   z         pressure or depth, per (profile, level) or per level, if any
//   group     which platform or file each profile came from, if any (a
//             trajectory_id, or an index into a source_names attribute)
// or null where it is not one. A grid's lat(lat) and lon(lon) are each on
// their own dimension, so a grid is never taken for one.
export function profileRoles(vdims, vattrs, arrays) {
  if (!Array.isArray(vdims) || vdims.length !== 2 || vdims[0] === vdims[1]) return null;
  const listed = new Set(typeof (vattrs || {}).coordinates === "string" ? vattrs.coordinates.split(/\s+/) : []);
  // the best-scoring array, those the variable lists as its coordinates first
  const best = (list, score) => {
    let top = null, hi = 0;
    for (const a of list) {
      const sc = score(a.attrs || {}, a.name);
      if (sc > 0 && sc + (listed.has(a.name) ? 100 : 0) > hi) { hi = sc + (listed.has(a.name) ? 100 : 0); top = a.name; }
    }
    return top;
  };
  for (const d of vdims) {
    const on = arrays.filter((a) => Array.isArray(a.dims) && a.dims.length === 1 && a.dims[0] === d && a.name !== d);
    const lat = best(on, (at, n) => (axisRole(n, at) === "lat" ? 1 : 0));
    const lon = best(on, (at, n) => (axisRole(n, at) === "lon" ? 1 : 0));
    if (!lat || !lon) continue;
    const level = vdims.find((x) => x !== d);
    const time = best(on, (at, n) => (/\bsince\b/.test(String(at.units || "")) ?
      1 + (at.standard_name === "time" ? 8 : 0) + (at.axis === "T" ? 4 : 0) + (/^(time|juld)$/i.test(n) ? 2 : 0) : 0));
    const zs = arrays.filter((a) => Array.isArray(a.dims) && (String(a.dims) === String(vdims) || (a.dims.length === 1 && a.dims[0] === level)));
    const z = best(zs, (at, n) => (/^(sea_water_pressure|depth|altitude|height|air_pressure)/.test(String(at.standard_name || "")) ? 8 : 0) +
      (at.axis === "Z" ? 4 : 0) + (at.positive === "up" || at.positive === "down" ? 2 : 0) +
      (/^(pres|pressure|depth|z|lev|level|plev|deptht)$/i.test(n) ? 2 : 0));
    const group = best(on, (at) => (at.cf_role === "trajectory_id" || Array.isArray(at.source_names) ? 1 : 0));
    return { instance: d, level, lat, lon, time, z, group };
  }
  return null;
}

// A profile's value at depth (or pressure) target: at the level whose z is
// nearest, among levels with a value, if that level is within tol of the
// target; NaN where the profile has no value that close (it stops short,
// or starts below). z is the profile's own z, or the collection's.
export function valueAt(values, z, target, tol) {
  let best = NaN, bd = Infinity;
  const n = Math.min(values.length, z.length);
  for (let k = 0; k < n; k++) {
    const d = Math.abs(z[k] - target);
    if (d < bd && Number.isFinite(values[k])) { bd = d; best = values[k]; }
  }
  return bd <= tol ? best : NaN;
}

// The deepest z a profile has a value at (the largest, for pressure and
// depth; the smallest where z grows upwards), or NaN where it has none.
export function deepestAt(values, z, down = true) {
  let out = NaN;
  const n = Math.min(values.length, z.length);
  for (let k = 0; k < n; k++)
    if (Number.isFinite(values[k]) && Number.isFinite(z[k]) && !(down ? z[k] <= out : z[k] >= out)) out = z[k];
  return out;
}

// How many of the values (times, one per profile) fall in each of n equal
// bins from lo to hi (hi in the last bin); values outside are not counted.
export function binCounts(values, lo, hi, n) {
  const out = new Uint32Array(n), w = (hi - lo) / n;
  for (const t of values) {
    if (!(t >= lo && t <= hi)) continue;
    out[w > 0 ? Math.min(n - 1, Math.floor((t - lo) / w)) : 0]++;
  }
  return out;
}

// The smallest lon/lat box { west, east, south, north } around points,
// padded by pad degrees: across the antimeridian where that is smaller,
// with east then past 180 (west < east always, east - west <= 360). null
// with no point.
export function lonLatBox(lons, lats, pad = 0) {
  const L = [];
  let s = 90, n = -90;
  for (let k = 0; k < lons.length; k++) {
    if (!Number.isFinite(lons[k]) || !(Math.abs(lats[k]) <= 90)) continue;
    L.push((((lons[k] + 180) % 360) + 360) % 360 - 180);
    s = Math.min(s, lats[k]); n = Math.max(n, lats[k]);
  }
  if (!L.length) return null;
  L.sort((a, b) => a - b);
  // the box is everything but the widest gap between neighbours, round the circle
  let gap = L[0] + 360 - L[L.length - 1], at = 0;
  for (let k = 1; k < L.length; k++) if (L[k] - L[k - 1] > gap) { gap = L[k] - L[k - 1]; at = k; }
  let west = L[at], east = at === 0 ? L[L.length - 1] : L[at - 1] + 360;
  if (east - west + 2 * pad >= 360) { west = -180; east = 180; }
  else { west -= pad; east += pad; }
  return { west, east, south: Math.max(-90, s - pad), north: Math.min(90, n + pad) };
}

// A grid's value at lon, lat, bilinear between cell centres: the grid is
// { elev, width, height, west, north, dx, dy } with west and north the
// outer edges of its first cell (as GEBCO windows are read), rows going
// south. Longitudes are taken round to the grid's own; NaN off the grid.
export function gridSample(g, lon, lat) {
  let fx = (lon - g.west) / g.dx - 0.5;
  const wrap = Math.round(360 / g.dx);
  if (fx < -0.5) fx += wrap; else if (fx > g.width - 0.5) fx -= wrap;
  const fy = (g.north - lat) / g.dy - 0.5;
  if (!(fx >= -0.5 && fx <= g.width - 0.5 && fy >= -0.5 && fy <= g.height - 0.5)) return NaN;
  const x0 = Math.max(0, Math.min(g.width - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(g.height - 2, Math.floor(fy)));
  const x1 = Math.min(g.width - 1, x0 + 1), y1 = Math.min(g.height - 1, y0 + 1);
  const u = Math.max(0, Math.min(1, fx - x0)), v = Math.max(0, Math.min(1, fy - y0)), e = g.elev, w = g.width;
  return (e[y0 * w + x0] * (1 - u) + e[y0 * w + x1] * u) * (1 - v) + (e[y1 * w + x0] * (1 - u) + e[y1 * w + x1] * u) * v;
}

// Where value v falls along the levels z (increasing, NaN past the end),
// as a fractional level index, carried on past the last level (and before
// the first) at the spacing there.
export function levelOf(z, v) {
  let n = z.length;
  while (n > 0 && !Number.isFinite(z[n - 1])) n--;
  if (n === 0) return NaN;
  if (n === 1) return v === z[0] ? 0 : NaN;
  if (v <= z[0]) return (v - z[0]) / (z[1] - z[0]);
  for (let k = 1; k < n; k++) if (v <= z[k]) return k - 1 + (v - z[k - 1]) / (z[k] - z[k - 1]);
  return n - 1 + (v - z[n - 1]) / (z[n - 1] - z[n - 2]);
}

// The profiles (indices into times) in the window [t0, t1), in index order
export function inWindow(times, t0, t1) {
  const out = [];
  for (let i = 0; i < times.length; i++) if (times[i] >= t0 && times[i] < t1) out.push(i);
  return out;
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

// Which way a grid's rows and columns run on the earth, from the longitude
// and latitude at its lattice nodes (row by row, nu + 1 to a row, null where
// a node is not on the earth). rows is "north" when latitude grows with the
// row index between most neighbours (south first, as model output usually
// is), "south" when it falls (north first, as an image), and null when
// neither has two thirds of the votes (a polar grid, whose rows cross the
// pole). cols is "east", "west" or null the same way, across the antimeridian.
export function gridDirections(ll, nu, nv) {
  let rn = 0, rs = 0, ce = 0, cw = 0;
  const at = (i, j) => ll[j * (nu + 1) + i];
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      const p = at(i, j);
      if (!p) continue;
      const r = j < nv ? at(i, j + 1) : null, c = i < nu ? at(i + 1, j) : null;
      if (r) { const d = r[1] - p[1]; if (d > 1e-9) rn++; else if (d < -1e-9) rs++; }
      if (c) { let d = c[0] - p[0]; d -= 360 * Math.round(d / 360); if (d > 1e-9) ce++; else if (d < -1e-9) cw++; }
    }
  const win = (a, b, A, B) => (a + b === 0 ? null : a >= 2 * b ? A : b >= 2 * a ? B : null);
  return { rows: win(rn, rs, "north", "south"), cols: win(ce, cw, "east", "west") };
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
