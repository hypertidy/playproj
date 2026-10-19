// playproj: Eratosthenes' measurement of the Earth, as 3D geometry on the
// unit sphere. A well at Syene, a gnomon (an upright stick) at Alexandria
// on the same meridian, and the sun's rays all parallel. The angle the
// shadow makes with the stick is the angle between the two cities at the
// centre of the Earth, less the sun's angle from overhead at Syene.

const D2R = Math.PI / 180;

export const xyz = (lon, lat) => {
  const l = lon * D2R, p = lat * D2R;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
};
const add = (a, b, k = 1) => [a[0] + k * b[0], a[1] + k * b[1], a[2] + k * b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// The two places, as they really are (WGS84 latitude and longitude of
// Aswan's Elephantine island and the ancient harbour of Alexandria).
export const SYENE = { name: "Syene (Aswan)", lon: 32.8998, lat: 24.0889 };
export const ALEXANDRIA = { name: "Alexandria", lon: 29.9187, lat: 31.2001 };

// What Cleomedes reports: the shadow 1/50 of a circle, the cities 5000
// stadia apart. Later writers (Strabo, Pliny) give 252,000 stadia round.
export const ANGLE = 360 / 50;
export const STADIA = 5000;
export const STADIA_ROUND = 252000;

// The Earth's mean meridian, km (WGS84 quarter meridian 10,001.966 km).
export const MERIDIAN_KM = 40007.86;

// The scene on the unit sphere, everything in one meridian plane at lon:
// Syene at lat, Alexandria sep degrees north of it, the sun zenith degrees
// from overhead at Syene (positive: the subsolar point is south of Syene).
// h is the gnomon's height, in Earth radii.
export function scene({ lon = SYENE.lon, lat = SYENE.lat, sep = ANGLE, zenith = 0, h = 0.25 } = {}) {
  const S = xyz(lon, lat), A = xyz(lon, lat + sep);
  const sun = xyz(lon, lat - zenith);          // unit vector towards the sun
  const tip = add(A, A, h);                    // top of the gnomon
  // the ray past the tip meets the ground plane at A: (tip - t sun - A) . A = 0
  const t = h / dot(sun, A);
  const shadow = add(tip, sun, -t);
  const ang = (u, v) => Math.atan2(Math.hypot(...cross(u, v)), dot(u, v)) / D2R;
  return {
    S, A, sun, tip, shadow, h,
    zenithA: ang(sun, A),                      // the shadow's angle at Alexandria
    zenithS: ang(sun, S),                      // the sun's angle at the well
    centre: ang(S, A),                         // the cities' angle at the centre
    shadowLength: Math.hypot(shadow[0] - A[0], shadow[1] - A[1], shadow[2] - A[2])
  };
}

// An orthographic camera looking at the sphere from (lon0, lat0), the same
// view as d3.geoOrthographic().rotate([-lon0, -lat0]) at unit scale: x east,
// y north (d3 flips y), depth towards the viewer.
export function camera(lon0, lat0) {
  const l = lon0 * D2R, p = lat0 * D2R;
  const e = [-Math.sin(l), Math.cos(l), 0];
  const n = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
  const c = xyz(lon0, lat0);
  const f = (P) => [dot(e, P), dot(n, P), dot(c, P)];
  // hidden behind the sphere's near surface (points inside it count as hidden)
  f.hidden = (P) => {
    const [x, y, z] = f(P), r2 = x * x + y * y;
    return r2 < 1 && z < Math.sqrt(1 - r2) - 1e-9;
  };
  return f;
}

// Great-circle distance, degrees of arc.
export function arc(a, b) {
  const u = xyz(a.lon, a.lat), v = xyz(b.lon, b.lat);
  return Math.atan2(Math.hypot(...cross(u, v)), dot(u, v)) / D2R;
}

// The obliquity of the ecliptic, degrees, for a (proleptic Julian) year, from
// Laskar (1986) in Julian millennia from J2000; good over 10,000 years.
export function obliquity(year) {
  const U = (year - 2000) / 10000;
  const c = [84381.448, -4680.93, -1.55, 1999.25, -51.38, -249.67, -39.05, 7.12, 27.87, 5.79, 2.45];
  let s = 0;
  for (let k = c.length - 1; k >= 0; k--) s = s * U + c[k];
  return s / 3600;
}
