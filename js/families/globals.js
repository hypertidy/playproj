// Global maps and their interruptions: Mollweide, Equal Earth, Robinson and
// friends, cut into lobes the way Goode cut his homolosine, and an
// octahedral butterfly. Every formula here is spherical, on a unit sphere,
// and follows PROJ's own code (moll, sinu, goode, eck4, eqearth, robin,
// natearth, hammer, wintri, igh, igh_o, imoll, imoll_o and gnom), so the
// results agree with PROJ to rounding.
//
// An interrupted map is a set of lobes. Each lobe covers a band of
// longitude in one hemisphere and is the base projection with its own
// central meridian c, shifted along x so neighbouring lobes meet on the
// equator. The interruption amount s moves every lobe's central meridian
// from the map's own (s = 0, one unbroken map) to the lobe's (s = 1, the
// interrupted map), so the cuts open while the lobes straighten.

import { proj4Wkt } from "../geotiff-write.js";

export const R = 6370997;
const D2R = Math.PI / 180;
const HALFPI = Math.PI / 2;

// ---------------------------------------------------------------- bases

// Mollweide (PROJ moll.cpp, p = pi/2)
const MOLL = (() => {
  const p = HALFPI, sp = Math.sin(p), p2 = p + p;
  const r = Math.sqrt(2 * Math.PI * sp / (p2 + Math.sin(p2)));
  return { Cx: 2 * r / Math.PI, Cy: r / sp, Cp: p2 + Math.sin(p2) };
})();
function moll(lam, phi) {
  const k = MOLL.Cp * Math.sin(phi);
  let i = 30;
  for (; i; --i) {
    const V = (phi + Math.sin(phi) - k) / (1 + Math.cos(phi));
    phi -= V;
    if (Math.abs(V) < 1e-7) break;
  }
  if (!i) phi = phi < 0 ? -HALFPI : HALFPI;
  else phi *= 0.5;
  return [MOLL.Cx * lam * Math.cos(phi), MOLL.Cy * Math.sin(phi)];
}

const sinu = (lam, phi) => [lam * Math.cos(phi), phi];

// Goode homolosine: sinusoidal near the equator, Mollweide beyond, the
// Mollweide part shifted to meet the sinusoidal where their parallels have
// the same length. PROJ's goode and igh use slightly different constants.
const GOODE = { lim: 0.71093078197902358062, ycor: 0.05280 };
const IGH_LIM = (40 + 44 / 60 + 11.8 / 3600) * D2R;
const IGH = { lim: IGH_LIM, ycor: -(sinu(0, IGH_LIM)[1] - moll(0, IGH_LIM)[1]) };
function homolosine(k) {
  return (lam, phi) => {
    if (Math.abs(phi) < k.lim || (k === GOODE && Math.abs(phi) === k.lim)) return sinu(lam, phi);
    const xy = moll(lam, phi);
    xy[1] -= phi >= 0 ? k.ycor : -k.ycor;
    return xy;
  };
}

// Eckert IV (PROJ eck4.cpp)
function eck4(lam, phi) {
  const Cx = 0.42223820031577120149, Cy = 1.32650042817700232218, Cp = 3.57079632679489661922;
  const p = Cp * Math.sin(phi);
  let V = phi * phi, th = phi * (0.895168 + V * (0.0218849 + V * 0.00826809)), i = 6;
  for (; i; --i) {
    const c = Math.cos(th), s = Math.sin(th);
    V = (th + s * (c + 2) - p) / (1 + c * (c + 2) - s * s);
    th -= V;
    if (Math.abs(V) < 1e-7) break;
  }
  if (!i) return [Cx * lam, th < 0 ? -Cy : Cy];
  return [Cx * lam * (1 + Math.cos(th)), Cy * Math.sin(th)];
}

// Equal Earth (PROJ eqearth.cpp, sphere)
function eqearth(lam, phi) {
  const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796, M = Math.sqrt(3) / 2;
  const psi = Math.asin(M * Math.sin(phi)), p2 = psi * psi, p6 = p2 * p2 * p2;
  return [lam * Math.cos(psi) / (M * (A1 + 3 * A2 * p2 + p6 * (7 * A3 + 9 * A4 * p2))),
    psi * (A1 + A2 * p2 + p6 * (A3 + A4 * p2))];
}

// Robinson (PROJ robin.cpp): the table is single precision there too
const ROB_X = [[1.0, 2.2199e-17, -7.15515e-05, 3.1103e-06], [0.9986, -0.000482243, -2.4897e-05, -1.3309e-06],
  [0.9954, -0.00083103, -4.48605e-05, -9.86701e-07], [0.99, -0.00135364, -5.9661e-05, 3.6777e-06],
  [0.9822, -0.00167442, -4.49547e-06, -5.72411e-06], [0.973, -0.00214868, -9.03571e-05, 1.8736e-08],
  [0.96, -0.00305085, -9.00761e-05, 1.64917e-06], [0.9427, -0.00382792, -6.53386e-05, -2.6154e-06],
  [0.9216, -0.00467746, -0.00010457, 4.81243e-06], [0.8962, -0.00536223, -3.23831e-05, -5.43432e-06],
  [0.8679, -0.00609363, -0.000113898, 3.32484e-06], [0.835, -0.00698325, -6.40253e-05, 9.34959e-07],
  [0.7986, -0.00755338, -5.00009e-05, 9.35324e-07], [0.7597, -0.00798324, -3.5971e-05, -2.27626e-06],
  [0.7186, -0.00851367, -7.01149e-05, -8.6303e-06], [0.6732, -0.00986209, -0.000199569, 1.91974e-05],
  [0.6213, -0.010418, 8.83923e-05, 6.24051e-06], [0.5722, -0.00906601, 0.000182, 6.24051e-06],
  [0.5322, -0.00677797, 0.000275608, 6.24051e-06]].map((r) => r.map(Math.fround));
const ROB_Y = [[-5.20417e-18, 0.0124, 1.21431e-18, -8.45284e-11], [0.062, 0.0124, -1.26793e-09, 4.22642e-10],
  [0.124, 0.0124, 5.07171e-09, -1.60604e-09], [0.186, 0.0123999, -1.90189e-08, 6.00152e-09],
  [0.248, 0.0124002, 7.10039e-08, -2.24e-08], [0.31, 0.0123992, -2.64997e-07, 8.35986e-08],
  [0.372, 0.0124029, 9.88983e-07, -3.11994e-07], [0.434, 0.0123893, -3.69093e-06, -4.35621e-07],
  [0.4958, 0.0123198, -1.02252e-05, -3.45523e-07], [0.5571, 0.0121916, -1.54081e-05, -5.82288e-07],
  [0.6176, 0.0119938, -2.41424e-05, -5.25327e-07], [0.6769, 0.011713, -3.20223e-05, -5.16405e-07],
  [0.7346, 0.0113541, -3.97684e-05, -6.09052e-07], [0.7903, 0.0109107, -4.89042e-05, -1.04739e-06],
  [0.8435, 0.0103431, -6.4615e-05, -1.40374e-09], [0.8936, 0.00969686, -6.4636e-05, -8.547e-06],
  [0.9394, 0.00840947, -0.000192841, -4.2106e-06], [0.9761, 0.00616527, -0.000256, -4.2106e-06],
  [1.0, 0.00328947, -0.000319159, -4.2106e-06]].map((r) => r.map(Math.fround));
function robin(lam, phi) {
  const V = (c, z) => c[0] + z * (c[1] + z * (c[2] + z * c[3]));
  let d = Math.abs(phi);
  const i = Math.min(18, Math.floor(Math.floor(d * 11.45915590261646417544 + 1e-15)));
  d = (d - 0.08726646259971647884 * i) / D2R;
  const y = V(ROB_Y[i], d) * 1.3523;
  return [V(ROB_X[i], d) * 0.8487 * lam, phi < 0 ? -y : y];
}

// Natural Earth (PROJ natearth.cpp)
function natearth(lam, phi) {
  const p2 = phi * phi, p4 = p2 * p2;
  return [lam * (0.8707 + p2 * (-0.131979 + p2 * (-0.013791 + p4 * p2 * (0.003971 + p2 * -0.001529)))),
    phi * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 + -0.005916 * p4)))];
}

// Hammer (PROJ hammer.cpp, W = 0.5, M = 1)
function hammer(lam, phi) {
  const c = Math.cos(phi), l = lam * 0.5, d = Math.sqrt(2 / (1 + c * Math.cos(l)));
  return [2 * d * c * Math.sin(l), d * Math.sin(phi)];
}

// Winkel tripel (PROJ aitoff.cpp, lat_1 = acos(2 / pi))
function wintri(lam, phi) {
  const c = 0.5 * lam, d = Math.acos(Math.cos(phi) * Math.cos(c));
  let x = 0, y = 0;
  if (d !== 0) { const r = 1 / Math.sin(d); x = 2 * d * Math.cos(phi) * Math.sin(c) * r; y = d * Math.sin(phi) * r; }
  return [(x + lam * 0.636619772367581343) * 0.5, (y + phi) * 0.5];
}

// lobes: whether the base keeps a straight, evenly divided equator, which
// lobes need to meet each other along it.
export const BASES = {
  moll: { label: "Mollweide", proj: "moll", f: moll, lobes: true, area: true },
  goode: { label: "Goode homolosine", proj: "goode", f: homolosine(GOODE), fi: homolosine(IGH), lobes: true, area: true },
  sinu: { label: "Sinusoidal", proj: "sinu", f: sinu, lobes: true, area: true },
  eck4: { label: "Eckert IV", proj: "eck4", f: eck4, lobes: true, area: true },
  eqearth: { label: "Equal Earth", proj: "eqearth", f: eqearth, lobes: true, area: true },
  robin: { label: "Robinson", proj: "robin", f: robin, lobes: true },
  natearth: { label: "Natural Earth", proj: "natearth", f: natearth, lobes: true },
  hammer: { label: "Hammer", proj: "hammer", f: hammer, lobes: false, area: true },
  // lat_1 is spelled out: PROJ's own default is acos(2 / pi), but a PROJ
  // string read as a CRS (as GDAL does) gets lat_1 = 0
  wintri: { label: "Winkel tripel", proj: "wintri", extra: " +lat_1=50.4597762521898", f: wintri, lobes: false },
  butterfly: { label: "Octahedral butterfly", proj: null, lobes: false }
};
for (const b of Object.values(BASES)) if (b.f) b.C = b.f(1, 0)[0];

// ---------------------------------------------------------------- lobes

// Lobe sets in degrees: the cut meridians of each hemisphere and the
// lobes' central meridians, from PROJ's igh (land) and igh_o (ocean).
export const LOBES = {
  none: { label: "None" },
  land: { label: "Goode, land", north: [[-180, -40, 180], [-100, 30]], south: [[-180, -100, -20, 80, 180], [-160, -60, 20, 140]] },
  ocean: { label: "Goode, oceans", north: [[-180, -90, 60, 180], [-140, -10, 130]], south: [[-180, -60, 90, 180], [-110, 20, 150]] },
  gores: { label: "Gores" }
};

// PROJ names the interrupted maps it has.
const INTERRUPTED = { "goode:land": "igh", "goode:ocean": "igh_o", "moll:land": "imoll", "moll:ocean": "imoll_o" };

export const defaults = { base: "goode", lobes: "land", gores: 12, s: 1, lon0: 0 };

function goreSet(n) {
  const b = [], c = [];
  for (let k = 0; k <= n; k++) b.push(-180 + (360 * k) / n);
  for (let k = 0; k < n; k++) c.push(-180 + (360 * (k + 0.5)) / n);
  return { north: [b, c], south: [b, c] };
}

const wrapRad = (l) => {
  if (Math.abs(l) <= Math.PI) return l;
  l = (l + Math.PI) % (2 * Math.PI);
  if (l < 0) l += 2 * Math.PI;
  return l - Math.PI;
};
const wrapDeg = (l) => ((((l + 180) % 360) + 360) % 360) - 180;

// The map for a parameter set: a list of pieces, each with
//   locate: whether a relative lon/lat (degrees) belongs to it
//   flat(lam, phi): plane x, y (unit sphere) for relative lon/lat in degrees
//   bounds: [lamMin, lamMax, phiMin, phiMax] in relative degrees
// plus project(lon, lat) -> [x, y, piece] for absolute lon/lat.
export function makeMap(p = {}) {
  p = { ...defaults, ...p };
  const base = BASES[p.base] || BASES.goode;
  if (p.base === "butterfly") return butterfly(p);
  const lobed = base.lobes && p.lobes !== "none";
  const f = lobed && base.fi ? base.fi : base.f;
  const set = !lobed ? { north: [[-180, 180], [0]], south: [[-180, 180], [0]] }
    : p.lobes === "gores" ? goreSet(Math.max(2, Math.min(36, Math.round(p.gores)))) : LOBES[p.lobes];
  const s = lobed ? Math.max(0, Math.min(1, p.s)) : 0, C = base.C;
  const anchor = set.north[1][0] * D2R * s;
  const pieces = [];
  for (const [hemi, [b, c]] of [["n", set.north], ["s", set.south]]) {
    for (let k = 0; k < c.length; k++) {
      const cr = c[k] * D2R * s;
      // x offset so lobes meet on the equator; PROJ anchors the first
      // northern lobe at x = its own central meridian (radians)
      const x0 = C * cr + (1 - C) * anchor;
      pieces.push({
        hemi, k, c: c[k] * s, cut: [b[k], b[k + 1]],
        bounds: [b[k], b[k + 1], hemi === "n" ? 0 : -90, hemi === "n" ? 90 : 0],
        flat: (lam, phi) => {
          const xy = f(lam * D2R - cr, phi * D2R);
          return [xy[0] + x0, xy[1]];
        }
      });
    }
  }
  const north = pieces.filter((q) => q.hemi === "n"), south = pieces.filter((q) => q.hemi === "s");
  const locate = (lam, phi) => {
    const list = phi >= 0 ? north : south;
    for (const q of list) if (lam <= q.cut[1]) return q;
    return list[list.length - 1];
  };
  return finish(p, pieces, locate, lobed, s);
}

function finish(p, pieces, locate, lobed, s) {
  pieces.forEach((q, i) => (q.id = i));
  const map = {
    p, pieces, lobed, s,
    // relative longitude: the map's central meridian is 0
    rel: (lon) => wrapDeg(lon - p.lon0),
    locate,
    project(lon, lat) {
      const lam = map.rel(lon), q = locate(lam, lat), xy = q.flat(lam, lat);
      return [xy[0], xy[1], q.id];
    }
  };
  return map;
}

// ---------------------------------------------------------------- butterfly

// Cahill's butterfly: the globe on a circumscribed octahedron, each of the
// eight faces a gnomonic map from its own centre (a light at the centre of
// the globe), unfolded with the four northern faces around the North Pole
// and each southern face hanging from its northern twin. lon0 is the
// meridian of one octahedron edge; Cahill-Keyes uses 20 W.
export const OCTA_LAT = Math.atan(1 / Math.SQRT2) / D2R; // 35.26 degrees, face centre latitude
const WING = [-135, -45, 45, 135];

export function faceFrame(q) {
  // centre, east and north at the face centre, in a lon/lat-to-xyz frame
  // with relative longitude: x toward lam = 0, y toward lam = 90, z north
  const l = q.lamC * D2R, ph = q.phiC * D2R;
  return {
    n: [Math.cos(ph) * Math.cos(l), Math.cos(ph) * Math.sin(l), Math.sin(ph)],
    e: [-Math.sin(l), Math.cos(l), 0],
    u: [-Math.sin(ph) * Math.cos(l), -Math.sin(ph) * Math.sin(l), Math.cos(ph)]
  };
}

// gnomonic onto the face plane, in the face's east/north frame
export function gnomFace(q, lam, phi) {
  const F = q.frame, l = lam * D2R, ph = phi * D2R, cp = Math.cos(ph);
  const v = [cp * Math.cos(l), cp * Math.sin(l), Math.sin(ph)];
  const d = v[0] * F.n[0] + v[1] * F.n[1] + v[2] * F.n[2];
  return [(v[0] * F.e[0] + v[1] * F.e[1] + v[2] * F.e[2]) / d, (v[0] * F.u[0] + v[1] * F.u[1] + v[2] * F.u[2]) / d];
}

function butterfly(p) {
  const pieces = [];
  for (const hemi of ["n", "s"])
    for (let k = 0; k < 4; k++) {
      const a = WING[k] * D2R, th = a + HALFPI, ct = Math.cos(th), st = Math.sin(th);
      // north face centres sit sqrt(2) out from the pole, south ones twice that
      const dist = hemi === "n" ? Math.SQRT2 : 2 * Math.SQRT2;
      const T = [dist * Math.cos(a), dist * Math.sin(a)];
      const q = {
        hemi, k, lamC: -135 + 90 * k, phiC: hemi === "n" ? OCTA_LAT : -OCTA_LAT,
        cut: [-180 + 90 * k, -90 + 90 * k], theta: th, T,
        bounds: [-180 + 90 * k, -90 + 90 * k, hemi === "n" ? 0 : -90, hemi === "n" ? 90 : 0]
      };
      q.frame = faceFrame(q);
      q.flat = (lam, phi) => {
        const [x, y] = gnomFace(q, lam, phi);
        return [ct * x - st * y + T[0], st * x + ct * y + T[1]];
      };
      pieces.push(q);
    }
  // relative longitude here is measured from lon0 + 180, so the faces run
  // from the edge meridian lon0 eastward
  const locate = (lam, phi) => {
    const k = Math.max(0, Math.min(3, Math.floor((lam + 180) / 90)));
    return pieces[(phi >= 0 ? 0 : 4) + k];
  };
  const map = finish({ ...p, lon0: wrapDeg(p.lon0 + 180) }, pieces, locate, false, 0);
  map.p = p;
  map.butterfly = true;
  return map;
}

// ---------------------------------------------------------------- strings

const fmt = (x) => +(+x).toFixed(6);

// The PROJ string, or null where PROJ has no single projection for the map.
export function projString(p = {}) {
  p = { ...defaults, ...p };
  const base = BASES[p.base];
  if (!base || !base.proj) return null;
  const lon0 = fmt(wrapDeg(p.lon0)), l = lon0 ? ` +lon_0=${lon0}` : "";
  if (!base.lobes || p.lobes === "none") return `+proj=${base.proj}${l}${base.extra || ""} +R=${R}`;
  const name = INTERRUPTED[`${p.base}:${p.lobes}`];
  if (!name || p.s !== 1) return null;
  return `+proj=${name}${l} +R=${R}`;
}

// The gnomonic face projections that make up the butterfly.
export function faceStrings(p = {}) {
  p = { ...defaults, ...p };
  return makeMap({ ...p, base: "butterfly" }).pieces.map((q) =>
    `+proj=gnom +lat_0=${fmt(q.phiC)} +lon_0=${fmt(wrapDeg(q.lamC + p.lon0 + 180))} +R=${R}`);
}

// One piece of a map as a map of its own: the PROJ string of a lobe (its
// base projection about the lobe's own central meridian; Goode's lobes use
// PROJ's goode) or of a butterfly face, and flat(lam, phi), its x, y on a
// unit sphere for relative lon/lat in degrees.
export function pieceProjection(p, q) {
  p = { ...defaults, ...p };
  if (p.base === "butterfly") return { proj: faceStrings(p)[q.id], flat: (lam, phi) => gnomFace(q, lam, phi) };
  const base = BASES[p.base], cr = q.c * D2R;
  return {
    proj: `+proj=${base.proj} +lon_0=${fmt(wrapDeg(p.lon0 + q.c))}${base.extra || ""} +R=${R}`,
    flat: (lam, phi) => base.f(lam * D2R - cr, phi * D2R)
  };
}

export function describe(p = {}) {
  p = { ...defaults, ...p };
  const base = BASES[p.base];
  if (p.base === "butterfly")
    return "Eight gnomonic maps, one per face of an octahedron around the globe, unfolded like a butterfly around the North Pole: Cahill's 1909 idea. Each face is a true light-at-the-centre projection; only the cuts between the faces break the map.";
  const what = base.area ? "equal-area" : "compromise";
  if (!base.lobes) return `${base.label}, a ${what} map of the whole sphere with curved parallels. Its equator is not evenly divided, so its lobes could not meet there: it is only cut at the seam.`;
  if (p.lobes === "none") return `${base.label}, a ${what} map of the whole sphere, cut only along one meridian: the seam, opposite the central meridian.`;
  const lobes = p.lobes === "gores" ? `${Math.round(p.gores)} gores in each hemisphere, like a globe maker's` : p.lobes === "land" ? "Goode's land lobes, cut through the oceans" : "Goode's ocean lobes, cut through the continents";
  const name = INTERRUPTED[`${p.base}:${p.lobes}`];
  const proj = name ? ` (PROJ's ${name} when fully interrupted)` : "";
  return `${base.label}, ${what}, interrupted into ${lobes}${proj}. Each lobe has its own central meridian, so shapes near it stay true; the price is the cuts.`;
}

// GeoTIFF keys for the maps PROJ can name, carried as a PROJ string in an
// ESRI PE string's PROJ4 extension (as for Spilhaus), which GDAL reads.
export function geoWkt(p) {
  const s = projString(p);
  return s ? proj4Wkt(BASES[p.base].proj, s, R) : null;
}

export { wrapDeg, wrapRad };
