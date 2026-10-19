// Rhumb lines and great circles. A ship that holds one compass course
// sails a rhumb line (a loxodrome): it crosses every meridian at the same
// angle, so it is straight on Mercator and spirals in to the pole. The
// shortest way between two places is a great circle (an orthodrome; on
// the ellipsoid, a geodesic): straight on a gnomonic map, and through the
// centre of any azimuthal map centred on one end, but its course changes
// all the way along. The difference between them grows with distance and
// with latitude, which is why it matters so much in the Southern Ocean:
// the great circle from Hobart to the stations in the west, or to Cape
// Town, bends south towards the ice, and the rhumb line keeps north.
//
// Lengths are on the WGS84 ellipsoid: the geodesic by Vincenty (1975),
// the rhumb line from the meridian distance and the isometric latitude
// (Snyder 1987, eqs 3-7 and 3-21), as GeographicLib's Rhumb class does
// it exactly. Lines for drawing are on the sphere, which no map at these
// scales can tell apart. Longitudes and latitudes are degrees, distances
// metres, bearings degrees clockwise from north.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const WGS84 = { a: 6378137, f: 1 / 298.257223563 };
export const R_MEAN = 6371008.8;   // mean radius (2a + b) / 3, for the sphere

const wrap180 = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
const wrapPi = (x) => Math.atan2(Math.sin(x), Math.cos(x));
const norm360 = (x) => ((x % 360) + 360) % 360;

// ------------------------------------------------------------- ellipsoid

function consts(ell = WGS84) {
  const e2 = ell.f * (2 - ell.f);
  return { a: ell.a, f: ell.f, e2, e: Math.sqrt(e2), b: ell.a * (1 - ell.f) };
}

// Isometric latitude (radians in, out): the Mercator y on a unit map.
export function isometric(phi, ell = WGS84) {
  const { e } = consts(ell), s = Math.sin(phi);
  return Math.atanh(s) - e * Math.atanh(e * s);
}

// Latitude (radians) from isometric latitude, by fixed point iteration.
export function fromIsometric(psi, ell = WGS84) {
  const { e } = consts(ell);
  let phi = 2 * Math.atan(Math.exp(psi)) - Math.PI / 2;
  for (let i = 0; i < 20; i++) {
    const s = Math.sin(phi);
    const next = 2 * Math.atan(Math.exp(psi) * ((1 + e * s) / (1 - e * s)) ** (e / 2)) - Math.PI / 2;
    if (Math.abs(next - phi) < 1e-15) return next;
    phi = next;
  }
  return phi;
}

// Distance along the meridian from the equator to latitude phi (radians).
export function meridian(phi, ell = WGS84) {
  const { a, e2 } = consts(ell), e4 = e2 * e2, e6 = e4 * e2;
  return a * ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi
    - ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi)
    + ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi)
    - ((35 * e6) / 3072) * Math.sin(6 * phi));
}

// ------------------------------------------------------------ rhumb line

// The rhumb line from one point to another, the short way round in
// longitude: { s, azi } with s its length and azi the constant course.
export function rhumbInverse(lon1, lat1, lon2, lat2, ell = WGS84) {
  const { a, e2 } = consts(ell);
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = wrap180(lon2 - lon1) * D2R;
  const dpsi = isometric(p2, ell) - isometric(p1, ell);
  // length = |dM| / |cos azi| = hypot(dl, dpsi) * dM / dpsi, and dM / dpsi
  // goes to N cos(phi) (the radius of the parallel) as dpsi goes to 0
  let k;
  if (Math.abs(dpsi) > 1e-9) k = (meridian(p2, ell) - meridian(p1, ell)) / dpsi;
  else { const pm = (p1 + p2) / 2; k = (a * Math.cos(pm)) / Math.sqrt(1 - e2 * Math.sin(pm) ** 2); }
  return { s: Math.hypot(dl, dpsi) * k, azi: norm360(Math.atan2(dl, dpsi) * R2D) };
}

// Points along the rhumb line from one point to another (n + 1 of them,
// even in Mercator, which is even in distance except near the poles).
export function rhumbPoints(lon1, lat1, lon2, lat2, n = 128, ell = WGS84) {
  const dl = wrap180(lon2 - lon1), q1 = isometric(lat1 * D2R, ell), q2 = isometric(lat2 * D2R, ell), out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([wrap180(lon1 + t * dl), fromIsometric(q1 + t * (q2 - q1), ell) * R2D]);
  }
  out[n] = [wrap180(lon2), lat2];
  return out;
}

// The whole loxodrome through one point on a course: from near one pole
// to near the other (to latitude +-limit), as points even in Mercator.
// It winds round each pole without end, but its length is finite.
export function loxodrome(lon, lat, azi, { n = 4000, limit = 89.9 } = {}, ell = WGS84) {
  const al = azi * D2R, c = Math.cos(al);
  if (Math.abs(c) < 1e-9) return [];   // a parallel: no poles to reach
  const q0 = isometric(lat * D2R, ell), qmax = isometric(limit * D2R, ell), out = [];
  const tanA = Math.tan(al);
  for (let i = 0; i <= n; i++) {
    const q = -qmax + (2 * qmax * i) / n, prev = -qmax + (2 * qmax * (i - 1)) / n;
    if (i && prev < q0 && q0 <= q) out.push([wrap180(lon), lat]);   // through the point itself
    out.push([wrap180(lon + (q - q0) * tanA * R2D), fromIsometric(q, ell) * R2D]);
  }
  return out;
}

// Length of the whole loxodrome on course azi, pole to pole: the meridian
// from pole to pole over |cos azi|.
export function loxodromeLength(azi, ell = WGS84) {
  const c = Math.abs(Math.cos(azi * D2R));
  return c < 1e-12 ? Infinity : (2 * meridian(Math.PI / 2, ell)) / c;
}

// -------------------------------------------------------------- geodesic

// The geodesic between two points (Vincenty's inverse): { s, azi1, azi2 }
// with azi2 the course on arrival. Near antipodal points, where Vincenty
// does not converge, the great circle on the mean sphere is given and
// flagged sphere: true.
export function geodesicInverse(lon1, lat1, lon2, lat2, ell = WGS84) {
  const { a, b, f } = consts(ell);
  const L = wrap180(lon2 - lon1) * D2R;
  const U1 = Math.atan((1 - f) * Math.tan(lat1 * D2R)), U2 = Math.atan((1 - f) * Math.tan(lat2 * D2R));
  const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2);
  let lam = L, sinS = 0, cosS = 0, sig = 0, sinA = 0, cos2A = 1, cos2Sm = 0, iter = 0;
  for (; iter < 200; iter++) {
    const sl = Math.sin(lam), cl = Math.cos(lam);
    sinS = Math.hypot(cU2 * sl, cU1 * sU2 - sU1 * cU2 * cl);
    if (sinS === 0) return { s: 0, azi1: 0, azi2: 0 };
    cosS = sU1 * sU2 + cU1 * cU2 * cl;
    sig = Math.atan2(sinS, cosS);
    sinA = (cU1 * cU2 * sl) / sinS;
    cos2A = 1 - sinA * sinA;
    cos2Sm = cos2A !== 0 ? cosS - (2 * sU1 * sU2) / cos2A : 0;
    const C = (f / 16) * cos2A * (4 + f * (4 - 3 * cos2A));
    const prev = lam;
    lam = L + (1 - C) * f * sinA * (sig + C * sinS * (cos2Sm + C * cosS * (-1 + 2 * cos2Sm * cos2Sm)));
    if (Math.abs(lam - prev) < 1e-13) break;
  }
  if (iter >= 200 || Math.abs(lam) > Math.PI) {
    const g = greatCircle(lon1, lat1, lon2, lat2);
    return { s: g.s, azi1: g.azi1, azi2: g.azi2, sphere: true };
  }
  const u2 = (cos2A * (a * a - b * b)) / (b * b);
  const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dS = B * sinS * (cos2Sm + (B / 4) * (cosS * (-1 + 2 * cos2Sm * cos2Sm) - (B / 6) * cos2Sm * (-3 + 4 * sinS * sinS) * (-3 + 4 * cos2Sm * cos2Sm)));
  const sl = Math.sin(lam), cl = Math.cos(lam);
  return {
    s: b * A * (sig - dS),
    azi1: norm360(Math.atan2(cU2 * sl, cU1 * sU2 - sU1 * cU2 * cl) * R2D),
    azi2: norm360(Math.atan2(cU1 * sl, -sU1 * cU2 + cU1 * sU2 * cl) * R2D)
  };
}

// The vertex of the geodesic leaving lat1 on course azi1: the latitude
// nearest a pole it reaches (Clairaut: cos(beta) sin(azi) is constant along
// it, with beta the reduced latitude), signed for the pole it heads to.
export function vertexLatitude(lat1, azi1, ell = WGS84) {
  const { f } = consts(ell);
  const b1 = Math.atan((1 - f) * Math.tan(lat1 * D2R));
  const bv = Math.acos(Math.min(1, Math.abs(Math.cos(b1) * Math.sin(azi1 * D2R))));
  const sign = Math.cos(azi1 * D2R) >= 0 ? 1 : -1;
  return sign * Math.atan(Math.tan(bv) / (1 - f)) * R2D;
}

// --------------------------------------------------------------- sphere

const vec = (lon, lat) => [Math.cos(lat * D2R) * Math.cos(lon * D2R), Math.cos(lat * D2R) * Math.sin(lon * D2R), Math.sin(lat * D2R)];
const unvec = (v) => [Math.atan2(v[1], v[0]) * R2D, Math.atan2(v[2], Math.hypot(v[0], v[1])) * R2D];

// The great circle on a sphere of radius R: { s, azi1, azi2 }.
export function greatCircle(lon1, lat1, lon2, lat2, R = R_MEAN) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const az = (pa, pb, d) => norm360(Math.atan2(Math.sin(d) * Math.cos(pb), Math.cos(pa) * Math.sin(pb) - Math.sin(pa) * Math.cos(pb) * Math.cos(d)) * R2D);
  return { s: 2 * R * Math.asin(Math.min(1, Math.sqrt(h))), azi1: az(p1, p2, dl), azi2: norm360(az(p2, p1, -dl) + 180) };
}

// Points along the great circle from one point to another (n + 1).
export function greatCirclePoints(lon1, lat1, lon2, lat2, n = 128) {
  const A = vec(lon1, lat1), B = vec(lon2, lat2);
  const w = Math.acos(Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2])));
  const s = Math.sin(w), out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (s < 1e-12) { out.push([lon1, lat1]); continue; }
    const ka = Math.sin((1 - t) * w) / s, kb = Math.sin(t * w) / s;
    out.push(unvec([ka * A[0] + kb * B[0], ka * A[1] + kb * B[1], ka * A[2] + kb * B[2]]));
  }
  out[n] = [wrap180(lon2), lat2];
  return out;
}

// How far (metres, on the sphere) a point is from the great circle through
// two others, signed: positive to the right of the way from the first.
export function crossTrack(lon1, lat1, lon2, lat2, lon, lat, R = R_MEAN) {
  const d13 = greatCircle(lon1, lat1, lon, lat, R), t12 = greatCircle(lon1, lat1, lon2, lat2, R).azi1;
  return R * Math.asin(Math.sin(d13.s / R) * Math.sin((d13.azi1 - t12) * D2R));
}

// The farthest the rhumb line gets from the great circle between two
// points: { s, lon, lat } (metres, on the sphere).
export function separation(lon1, lat1, lon2, lat2, n = 256) {
  let best = { s: 0, lon: lon1, lat: lat1 };
  for (const [lon, lat] of rhumbPoints(lon1, lat1, lon2, lat2, n)) {
    const x = Math.abs(crossTrack(lon1, lat1, lon2, lat2, lon, lat));
    if (x > best.s) best = { s: x, lon, lat };
  }
  return best;
}

// Composite great circle sailing, the navigator's way round a limit (the
// ice, say): a great circle from the start that just touches the parallel
// at latitude lim, along the parallel, and a great circle from it to the
// end. On the sphere. null when the plain great circle never passes lim
// between the two points (it is then the way to go) or an end is beyond lim.
export function composite(lon1, lat1, lon2, lat2, lim, R = R_MEAN) {
  const sg = Math.sign(lim);
  if (!sg || sg * lat1 >= sg * lim || sg * lat2 >= sg * lim) return null;
  const pts = greatCirclePoints(lon1, lat1, lon2, lat2, 256);
  if (!pts.some(([, la]) => sg * la > sg * lim)) return null;
  const L = lim * D2R, dl = wrap180(lon2 - lon1), dir = dl >= 0 ? 1 : -1;
  // a great circle with its vertex on lim passes through lat when
  // tan(lat) = tan(lim) cos(lon - vertex lon)
  const off = (lat) => Math.acos(Math.min(1, Math.tan(lat * D2R) / Math.tan(L))) * R2D;
  const v1 = lon1 + dir * off(lat1), v2 = lon1 + dl - dir * off(lat2);
  const along = (v2 - v1) * dir;
  if (along < 0) return null;
  // from the vertex to a point at lat along such a circle: sin(lat) = sin(lim) cos(d)
  const leg = (lat) => R * Math.acos(Math.min(1, Math.sin(lat * D2R) / Math.sin(L)));
  const s1 = leg(lat1), s2 = R * Math.cos(L) * along * D2R, s3 = leg(lat2);
  const k = Math.max(2, Math.ceil(along / 2));
  const parallel = [];
  for (let i = 0; i <= k; i++) parallel.push([wrap180(v1 + (dir * along * i) / k), lim]);
  return {
    s: s1 + s2 + s3, legs: [s1, s2, s3],
    vertices: [[wrap180(v1), lim], [wrap180(v2), lim]],
    points: [...greatCirclePoints(lon1, lat1, v1, lim, 64), ...parallel.slice(1), ...greatCirclePoints(v2, lim, lon2, lat2, 64).slice(1)]
  };
}

// Length (metres, geodesic) of a polyline of [lon, lat].
export function pathLength(pts, ell = WGS84) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += geodesicInverse(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], ell).s;
  return s;
}

// Everything a page shows for a pair of points.
export function compare(lon1, lat1, lon2, lat2, { lim = 0 } = {}) {
  const g = geodesicInverse(lon1, lat1, lon2, lat2), r = rhumbInverse(lon1, lat1, lon2, lat2);
  const gc = greatCirclePoints(lon1, lat1, lon2, lat2, 256);
  let vi = 0;
  for (let i = 1; i < gc.length; i++) if (Math.abs(gc[i][1]) > Math.abs(gc[vi][1])) vi = i;
  return {
    geodesic: g, rhumb: r,
    extra: g.s > 0 ? r.s / g.s - 1 : 0,
    vertex: { lat: vertexLatitude(lat1, g.azi1), between: vi > 0 && vi < gc.length - 1, lon: gc[vi][0], latOnPath: gc[vi][1] },
    apart: separation(lon1, lat1, lon2, lat2),
    composite: lim ? composite(lon1, lat1, lon2, lat2, lim) : null
  };
}
