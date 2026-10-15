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
