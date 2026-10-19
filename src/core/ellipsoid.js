// The ellipsoid of revolution: radii, eccentricity, the three latitudes
// (geodetic, geocentric, parametric), the radii of curvature M and N, and
// an exaggerated copy for drawing. Formulas as in Snyder (1987) and
// PROJ's ellipsoid parameters (ellps=); lengths in the units of a.

const D2R = Math.PI / 180;

// PROJ ellps names, with a and the inverse flattening rf (Clarke 1866 is
// defined by a and b in PROJ; rf here is from those).
export const ELLIPSOIDS = [
  { id: "WGS84", name: "WGS 84", a: 6378137, rf: 298.257223563 },
  { id: "GRS80", name: "GRS 1980", a: 6378137, rf: 298.257222101 },
  { id: "intl", name: "International 1924 (Hayford)", a: 6378388, rf: 297 },
  { id: "aust_SA", name: "Australian National 1965", a: 6378160, rf: 298.25 },
  { id: "krass", name: "Krassovsky 1942", a: 6378245, rf: 298.3 },
  { id: "clrk66", name: "Clarke 1866", a: 6378206.4, rf: 6378206.4 / (6378206.4 - 6356583.8) },
  { id: "clrk80", name: "Clarke 1880 (mod.)", a: 6378249.145, rf: 293.4663 },
  { id: "bessel", name: "Bessel 1841", a: 6377397.155, rf: 299.1528128 },
  { id: "airy", name: "Airy 1830", a: 6377563.396, rf: 299.3249646 }
];

// The flattening an exaggerated ellipsoid is allowed to reach: b stays a
// quarter of a, so the shape is still an ellipsoid on screen.
export const F_MAX = 0.75;

// An ellipsoid from a and f (f = 0 is the sphere of radius a).
export function ellipsoid(a, f) {
  const e2 = f * (2 - f), b = a * (1 - f);
  return { a, f, b, e2, e: Math.sqrt(e2), ep2: e2 / (1 - e2), rf: f ? 1 / f : Infinity };
}
export const fromRecord = (r) => ellipsoid(r.a, 1 / r.rf);

// The same ellipsoid with its flattening multiplied by k (k = 1 is the
// true shape), capped at F_MAX.
export const exaggerate = (E, k) => ellipsoid(E.a, Math.min(F_MAX, E.f * k));
// The largest k that exaggerate() honours for E.
export const maxExaggeration = (E) => (E.f > 0 ? F_MAX / E.f : 1);

// N (prime vertical: the length of the normal from the surface to the
// polar axis) and M (meridian: the radius of the osculating circle in the
// meridian plane) at geodetic latitude lat (degrees).
export function radii(E, lat) {
  const s = Math.sin(lat * D2R), w2 = 1 - E.e2 * s * s, w = Math.sqrt(w2);
  return { N: E.a / w, M: (E.a * (1 - E.e2)) / (w2 * w) };
}

// The point at geodetic latitude lat in its meridian plane: p from the
// axis, z along it.
export function meridianPoint(E, lat, h = 0) {
  const p = lat * D2R, { N } = radii(E, lat);
  return [(N + h) * Math.cos(p), (N * (1 - E.e2) + h) * Math.sin(p)];
}

// Earth-centred x, y, z (PROJ's +proj=cart) at lon, lat, height h.
export function toXYZ(E, lon, lat, h = 0) {
  const [p, z] = meridianPoint(E, lat, h), l = lon * D2R;
  return [p * Math.cos(l), p * Math.sin(l), z];
}

// Geodetic latitude from x, y, z on (or near) the surface, by Bowring's
// iteration; returns [lon, lat] in degrees.
export function fromXYZ(E, x, y, z) {
  const p = Math.hypot(x, y), lon = Math.atan2(y, x) / D2R;
  if (p < 1e-12 * E.a) return [lon, z >= 0 ? 90 : -90];
  let lat = Math.atan2(z, p * (1 - E.e2));
  for (let i = 0; i < 6; i++) {
    const s = Math.sin(lat), N = E.a / Math.sqrt(1 - E.e2 * s * s);
    lat = Math.atan2(z + E.e2 * N * s, p);
  }
  return [lon, lat / D2R];
}

// The other two latitudes of the point at geodetic latitude lat: the
// geocentric (the angle at the centre) and the parametric or reduced (the
// angle at the centre of the point straight out from it, along the
// parallel's plane, on the circle of radius a).
const atanScaled = (k, lat) => (Math.abs(lat) >= 90 ? lat : Math.atan(k * Math.tan(lat * D2R)) / D2R);
export const geocentricLatitude = (E, lat) => atanScaled(1 - E.e2, lat);
export const parametricLatitude = (E, lat) => atanScaled(1 - E.f, lat);
export const geodeticFromGeocentric = (E, lat) => atanScaled(1 / (1 - E.e2), lat);

// Where the normal at lat meets the polar axis, as z (the normal through a
// point off the equator misses the centre, crossing the axis on the other
// side of the equator).
export const normalAxisZ = (E, lat) => -radii(E, lat).N * E.e2 * Math.sin(lat * D2R);

// The latitude where geodetic and geocentric latitude differ most, and by
// how much (degrees): tan of it is sqrt(1/(1-e2)) on any ellipsoid.
export function maxLatitudeDifference(E) {
  const lat = Math.atan(1 / Math.sqrt(1 - E.e2)) / D2R;
  return { lat, diff: lat - geocentricLatitude(E, lat) };
}

// Length along the meridian from the equator to lat, by Simpson's rule on
// M (n even); the quarter meridian is meridianArc(E, 90).
export function meridianArc(E, lat, n = 2048) {
  const h = (lat * D2R) / n, Mi = (i) => radii(E, (i * h) / D2R).M;
  let s = Mi(0) + Mi(n);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * Mi(i);
  return (s * h) / 3;
}

// The meridian ellipse as n + 1 [p, z] points from the south pole, round
// through the equator at p = a, to the north pole (one half of the
// section; mirror p for the other).
export function meridianOutline(E, n = 180) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / n;
    out.push([E.a * Math.cos(t), E.b * Math.sin(t)]);
  }
  return out;
}

// The PROJ string for E: the ellps name when it is one, else +a and +rf.
export function projString(E, id) {
  if (id) return `+ellps=${id}`;
  return E.f > 0 ? `+a=${E.a} +rf=${+E.rf.toFixed(9)}` : `+R=${E.a}`;
}
