// Azimuthal perspective family.
//
// A sphere of radius R touches a plane at the tangent point (lat_0, lon_0).
// A point of light sits on the axis through the sphere centre and the
// tangent point, at signed distance `a` (in sphere radii) from the centre:
// the tangent point is at +1, the centre at 0, the antipode at -1.
// Every map point is found by casting a ray from the light, through the
// point on the sphere, onto the plane.
//
//   a = -1        stereographic   (+proj=stere)
//   a =  0        gnomonic        (+proj=gnom)
//   a >  1        near-side perspective (+proj=nsper +h=(a-1)R)
//   a = +/-Inf    orthographic    (+proj=ortho), rays are parallel
//
// Other values of `a` are valid perspective constructions with no PROJ
// equivalent, and the playground draws them anyway.
//
// The plane can also be lowered from the tangent point to cut the sphere
// (a secant plane). It then sits at height h = sin(lat_ts) above the centre
// and meets the sphere in the circle at lat_ts (in the polar sense: 90 - c
// degrees from the tangent point), where the map is at true scale along the
// circle. Every map point scales by k0 = (h - a) / (1 - a), the ratio of the
// two planes' distances from the light; parallel rays (orthographic) give
// the same map on every parallel plane.

import { esriGeoKeys } from "../geotiff-write.js";

export const R = 6370997; // the PROJ "sphere" radius used in the 2016 examples

// Stereographic from the South Pole, on the tangent plane.
export const defaults = { a: -1, lat0: -90, lon0: 0, ts: 90 };

const D2R = Math.PI / 180;

export const presets = [
  { id: "stere", label: "Stereographic", v: -0.5 },
  { id: "gnom", label: "Gnomonic", v: 0 },
  { id: "nsper", label: "Perspective", v: 0.75 },
  { id: "ortho", label: "Orthographic", v: 1 }
];

// Slider position v in [-1, 1] maps to light position a = tan(v * pi / 2),
// so v = -0.5 is the antipode, 0 the centre and +/-1 infinitely far away.
export function lightFromSlider(v) {
  if (Math.abs(v) >= 0.9999) return v > 0 ? Infinity : -Infinity;
  let a = Math.tan(v * Math.PI / 2);
  if (Math.abs(a - 1) < 1e-3) a = 1 + Math.sign(a - 1 || 1) * 1e-3; // light on the plane is degenerate
  return a;
}

export function sliderFromLight(a) {
  if (!isFinite(a)) return a > 0 ? 1 : -1;
  return Math.atan(a) * 2 / Math.PI;
}

// Snap slider values close to a named projection so the PROJ match is exact.
export function snapSlider(v, tol = 0.01) {
  for (const s of [-1, -0.5, 0, 1]) if (Math.abs(v - s) < tol) return s;
  return v;
}

// Smallest cos(c) (c = angular distance from the tangent point) that still
// reaches the plane: inside the sphere a ray must head towards the plane,
// outside it the sphere point must face the light.
export function horizonCos(a) {
  if (!isFinite(a)) return 0;
  return Math.abs(a) <= 1 ? a : 1 / a;
}

// Height of the plane above the sphere centre, from lat_ts in degrees
// (90 = tangent). It is kept on the far side of a light inside the sphere,
// so the rays still head out to it.
export function planeY(p) {
  let h = Math.sin((p.ts ?? 90) * D2R);
  if (isFinite(p.a) && p.a < 1) h = Math.max(h, Math.min(1, p.a + 0.02));
  return h;
}

// Scale of the plane at planeY relative to the tangent plane: k0.
export function planeScale(p) {
  return isFinite(p.a) ? (planeY(p) - p.a) / (1 - p.a) : 1;
}

const secant = (p) => planeY(p) < 1 - 1e-12;

// Project lon/lat (degrees) to plane x/y in sphere radii (east, north of the
// tangent point). Returns null where the ray never reaches the plane.
export function project(lon, lat, p, eps = 1e-6) {
  const { a, lat0, lon0 } = p;
  const phi = lat * D2R, phi0 = lat0 * D2R, dlam = (lon - lon0) * D2R;
  const sp = Math.sin(phi), cp = Math.cos(phi);
  const sp0 = Math.sin(phi0), cp0 = Math.cos(phi0);
  const cdl = Math.cos(dlam);
  const cosc = sp0 * sp + cp0 * cp * cdl;
  if (cosc <= horizonCos(a) + eps) return null;
  const k = (isFinite(a) ? (1 - a) / (cosc - a) : 1) * planeScale(p);
  return [k * cp * Math.sin(dlam), k * (cp0 * sp - sp0 * cp * cdl)];
}

// Inverse: plane x/y (sphere radii) back to [lon, lat] in degrees, by casting
// the ray from the light through the plane point and finding where it meets
// the sphere. Of the two crossings, the one nearest the tangent point is the
// one the forward projection uses. Returns null where the ray misses.
export function inverse(x, y, p, eps = 1e-6) {
  const { a, lat0, lon0 } = p;
  // the same ray meets the tangent plane at x / k0, y / k0
  const s = planeScale(p);
  x /= s; y /= s;
  // scene frame: tangent point at +Y, plane point at (x, 1, -y)
  let ox, oy, oz, dx, dy, dz, tmin;
  if (isFinite(a)) {
    ox = 0; oy = a; oz = 0;
    dx = x; dy = 1 - a; dz = -y;
    tmin = 1e-9;
  } else {
    ox = x; oy = 1; oz = -y;
    dx = 0; dy = 1; dz = 0;
    tmin = -Infinity;
  }
  const A = dx * dx + dy * dy + dz * dz;
  const B = 2 * (ox * dx + oy * dy + oz * dz);
  const C = ox * ox + oy * oy + oz * oz - 1;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let best = null;
  for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
    if (t <= tmin) continue;
    const sy = oy + t * dy;
    if (!best || sy > best[1]) best = [ox + t * dx, sy, oz + t * dz];
  }
  if (!best || best[1] <= horizonCos(a) + eps) return null;
  const [east, up, south] = best;
  const north = -south;
  const phi0 = lat0 * D2R;
  const sp0 = Math.sin(phi0), cp0 = Math.cos(phi0);
  const lat = Math.asin(Math.max(-1, Math.min(1, up * sp0 + north * cp0))) / D2R;
  let lon = lon0 + Math.atan2(east, up * cp0 - north * sp0) / D2R;
  lon = ((lon + 540) % 360) - 180;
  return [lon, lat];
}

// The projection on the tangent plane.
function tangentString(p) {
  const { a, lat0, lon0 } = p;
  const c = `+lat_0=${fmt(lat0)} +lon_0=${fmt(lon0)} +R=${R}`;
  if (!isFinite(a)) return `+proj=ortho ${c}`;
  if (Math.abs(a + 1) < 1e-9) return `+proj=stere ${c}`;
  if (a === 0) return `+proj=gnom ${c}`;
  if (a > 1) return `+proj=nsper ${c} +h=${fmt((a - 1) * R)}`;
  return null;
}

// With a secant plane: stere takes +lat_ts at the poles and +k_0 elsewhere,
// ortho does not change, and gnom and nsper (which ignore +k_0) are scaled
// by an affine step in a pipeline.
export function projString(p) {
  const t = tangentString(p);
  if (!t || !secant(p) || t.startsWith("+proj=ortho")) return t;
  const k = fmt(planeScale(p), 14);
  if (t.startsWith("+proj=stere")) {
    if (Math.abs(Math.abs(p.lat0) - 90) < 1e-9) return `${t} +lat_ts=${fmt(Math.sign(p.lat0) * Math.asin(planeY(p)) / D2R)}`;
    return `${t} +k_0=${k}`;
  }
  return `+proj=pipeline +step ${t} +step +proj=affine +s11=${k} +s22=${k}`;
}

// proj4js has no "nsper", but "tpers" with no tilt is the same projection.
// Its gnom and ortho need explicit false origins or they return NaN. This is
// always the tangent-plane projection: multiply by proj4Scale(p) for the
// secant plane.
export function proj4String(p) {
  const s = tangentString(p);
  return s && s.replace("+proj=nsper", "+proj=tpers +tilt=0 +azi=0") + " +x_0=0 +y_0=0";
}

export const proj4Scale = planeScale;

export function describe(p) {
  const base = describeLight(p);
  if (!secant(p)) return base;
  const ts = Math.asin(planeY(p)) / D2R;
  const where = Math.abs(Math.abs(p.lat0) - 90) < 1e-9 ? `latitude ${fmt(Math.sign(p.lat0) * ts)}` : `the circle ${fmt(90 - ts)} degrees from the tangent point`;
  const k = isFinite(p.a) ? ` Everything shrinks by k0 = ${fmt(planeScale(p))}.` : " Parallel rays draw the same map on any parallel plane.";
  return `${base} The plane is lowered to cut the sphere along ${where}, where the scale is true.${k}`;
}

function describeLight(p) {
  const { a } = p;
  if (!isFinite(a)) return "Orthographic: the light is infinitely far away, so the rays are parallel.";
  if (Math.abs(a + 1) < 1e-9) return "Stereographic: the light sits on the far side of the sphere, at the antipode of the tangent point.";
  if (a === 0) return "Gnomonic: the light sits at the centre of the sphere.";
  if (a > 1) return `Near-side perspective: the light is ${fmt((a - 1))} radii above the tangent point, like a camera in orbit.`;
  if (a < -1) return "Far-side perspective: the light is outside the sphere behind it, and the rays pass through the globe.";
  return "Internal perspective: the light is inside the sphere. This is a valid construction with no PROJ equivalent.";
}

function fmt(x, digits = 4) {
  return String(+x.toFixed(digits));
}

// GeoTIFF georeferencing for the current construction, as geokeys for
// geotiff-write.js: a user-defined sphere and projection where GeoTIFF has
// a coordinate transformation code, an ESRI PE string (which GDAL reads)
// for near-side perspective, and a plain citation otherwise.
const CT = { stere: 14, gnom: 19, ortho: 21 };

export function geoKeys(p) {
  const s = projString(p);
  const name = s ? s.split(" ")[0].slice(6) : null;
  // GeoTIFF's stereographic carries a scale factor; a scaled gnom or nsper
  // has no geokeys, so it gets a citation with its PROJ pipeline
  if (name === "pipeline") return [[1025, 1], [1026, { ascii: `playproj ${s}` }]];
  const sphere = [
    [2048, 32767], [2049, { ascii: `Sphere R=${R}` }], [2050, 32767], [2051, 8901],
    [2054, 9102], [2056, 32767], [2057, { double: R }], [2058, { double: R }]
  ];
  if (name in CT) {
    return [
      [1024, 1], [1025, 1], ...sphere,
      [3072, 32767], [3073, { ascii: `playproj ${s}` }], [3074, 32767], [3075, CT[name]], [3076, 9001],
      [3080, { double: p.lon0 }], [3081, { double: p.lat0 }],
      [3082, { double: 0 }], [3083, { double: 0 }],
      [3088, { double: p.lon0 }], [3089, { double: p.lat0 }],
      [3092, { double: planeScale(p) }]
    ];
  }
  if (name === "nsper") {
    const wkt = `PROJCS["playproj_near_side_perspective",GEOGCS["GCS_Sphere",DATUM["D_Sphere",SPHEROID["Sphere",${R},0.0]],` +
      `PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Vertical_Near_Side_Perspective"],` +
      `PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Longitude_Of_Center",${p.lon0}],` +
      `PARAMETER["Latitude_Of_Center",${p.lat0}],PARAMETER["Height",${(p.a - 1) * R}],UNIT["Meter",1.0]]`;
    return esriGeoKeys(wkt, R, "playproj near-side perspective");
  }
  return [[1025, 1], [1026, { ascii: `playproj perspective, light at ${fmt(p.a)} R, tangent ${fmt(p.lat0)} ${fmt(p.lon0)}, sphere R=${R}, no PROJ equivalent` }]];
}
