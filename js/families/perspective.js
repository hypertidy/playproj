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

export const R = 6370997; // the PROJ "sphere" radius used in the 2016 examples

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
  const k = isFinite(a) ? (1 - a) / (cosc - a) : 1;
  return [k * cp * Math.sin(dlam), k * (cp0 * sp - sp0 * cp * cdl)];
}

// Inverse: plane x/y (sphere radii) back to [lon, lat] in degrees, by casting
// the ray from the light through the plane point and finding where it meets
// the sphere. Of the two crossings, the one nearest the tangent point is the
// one the forward projection uses. Returns null where the ray misses.
export function inverse(x, y, p, eps = 1e-6) {
  const { a, lat0, lon0 } = p;
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

export function projString(p) {
  const { a, lat0, lon0 } = p;
  const c = `+lat_0=${fmt(lat0)} +lon_0=${fmt(lon0)} +R=${R}`;
  if (!isFinite(a)) return `+proj=ortho ${c}`;
  if (Math.abs(a + 1) < 1e-9) return `+proj=stere ${c}`;
  if (a === 0) return `+proj=gnom ${c}`;
  if (a > 1) return `+proj=nsper ${c} +h=${fmt((a - 1) * R)}`;
  return null;
}

// proj4js has no "nsper", but "tpers" with no tilt is the same projection.
// Its gnom and ortho need explicit false origins or they return NaN.
export function proj4String(p) {
  const s = projString(p);
  return s && s.replace("+proj=nsper", "+proj=tpers +tilt=0 +azi=0") + " +x_0=0 +y_0=0";
}

export function describe(p) {
  const { a } = p;
  if (!isFinite(a)) return "Orthographic: the light is infinitely far away, so the rays are parallel.";
  if (Math.abs(a + 1) < 1e-9) return "Stereographic: the light sits on the far side of the sphere, at the antipode of the tangent point.";
  if (a === 0) return "Gnomonic: the light sits at the centre of the sphere.";
  if (a > 1) return `Near-side perspective: the light is ${fmt((a - 1))} radii above the tangent point, like a camera in orbit.`;
  if (a < -1) return "Far-side perspective: the light is outside the sphere behind it, and the rays pass through the globe.";
  return "Internal perspective: the light is inside the sphere. This is a valid construction with no PROJ equivalent.";
}

function fmt(x) {
  return String(+x.toFixed(4));
}

// GeoTIFF georeferencing for the current construction, as geokeys for
// geotiff-write.js: a user-defined sphere and projection where GeoTIFF has
// a coordinate transformation code, an ESRI PE string (which GDAL reads)
// for near-side perspective, and a plain citation otherwise.
const CT = { stere: 14, gnom: 19, ortho: 21 };

export function geoKeys(p) {
  const s = projString(p);
  const name = s ? s.split(" ")[0].slice(6) : null;
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
      [3092, { double: 1 }]
    ];
  }
  if (name === "nsper") {
    const wkt = `PROJCS["playproj_near_side_perspective",GEOGCS["GCS_Sphere",DATUM["D_Sphere",SPHEROID["Sphere",${R},0.0]],` +
      `PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Vertical_Near_Side_Perspective"],` +
      `PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Longitude_Of_Center",${p.lon0}],` +
      `PARAMETER["Latitude_Of_Center",${p.lat0}],PARAMETER["Height",${(p.a - 1) * R}],UNIT["Meter",1.0]]`;
    // the same keys GDAL writes with GEOTIFF_KEYS_FLAVOR=ESRI_PE
    return [
      [1024, 32767], [1025, 1], [1026, { ascii: "playproj near-side perspective" }], ...sphere,
      [3073, { ascii: `ESRI PE String = ${wkt}` }], [3076, 9001]
    ];
  }
  return [[1025, 1], [1026, { ascii: `playproj perspective, light at ${fmt(p.a)} R, tangent ${fmt(p.lat0)} ${fmt(p.lon0)}, sphere R=${R}, no PROJ equivalent` }]];
}
