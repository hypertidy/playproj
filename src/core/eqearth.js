// Equal Earth (Savric, Patterson and Jenny 2018) on the sphere and on the
// ellipsoid, as PROJ's eqearth.cpp has it. On the ellipsoid PROJ projects
// the authalic latitude and scales the map by the authalic radius, so the
// map stays equal-area; EPSG:8857 is this on WGS 84.
//
// proj4js 2.12.1's eqearth (the version every page loads) is the sphere
// only: it sets es = 0 and scales by the semi-major axis, so on WGS 84 it
// is not equal-area and lands about 20 km from PROJ in northing at 45
// degrees. useEqearth(proj4) puts this one in its place, under the same
// names, for every proj4 definition made after it.

const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796;
const M = Math.sqrt(3) / 2;
// y of the pole line on the unit sphere, where psi = pi / 3. PROJ writes it
// 1.3173627591574, a little short, so its inverse puts the pole at
// 89.9999934 degrees; this one is exact.
const PSI_P = Math.PI / 3, PSI_P2 = PSI_P * PSI_P;
export const MAX_Y = PSI_P * (A1 + A2 * PSI_P2 + PSI_P2 ** 3 * (A3 + A4 * PSI_P2));
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// Snyder's q (3-12): the authalic function of the latitude's sine
function qsfn(s, e, es) {
  if (e < 1e-10) return 2 * s;
  const c = e * s;
  return (1 - es) * (s / (1 - c * c) - (0.5 / e) * Math.log((1 - c) / (1 + c)));
}

// what the ellipsoid needs: e, es, q at the pole, and the authalic radius
// over a (rqda; 1 on a sphere)
export function figure(es = 0) {
  if (!(es > 1e-15)) return { es: 0, e: 0, qp: 2, rqda: 1 };
  const e = Math.sqrt(es), qp = qsfn(1, e, es);
  return { es, e, qp, rqda: Math.sqrt(0.5 * qp) };
}

// sine of the authalic latitude from the geodetic latitude (radians)
function sinBeta(phi, E) {
  const s = Math.sin(phi);
  if (!E.es) return s;
  const b = qsfn(s, E.e, E.es) / E.qp;
  return Math.max(-1, Math.min(1, b));
}

// the geodetic latitude from the authalic one (radians), by Newton's method
// on q (Snyder 3-16), to rounding
function fromBeta(beta, E) {
  if (!E.es) return beta;
  const sb = Math.sin(beta);
  if (1 - Math.abs(sb) < 1e-15) return Math.sign(sb) * Math.PI / 2;
  const q = sb * E.qp;
  let phi = Math.asin(Math.max(-1, Math.min(1, q / 2)));
  for (let i = 0; i < 20; i++) {
    const s = Math.sin(phi), c = Math.cos(phi), w = 1 - E.es * s * s;
    const d = ((w * w) / (2 * c)) * (q / (1 - E.es) - s / w + (0.5 / E.e) * Math.log((1 - E.e * s) / (1 + E.e * s)));
    phi += d;
    if (!(Math.abs(d) > 1e-15)) break;
  }
  return phi;
}

// the projection on the unit authalic sphere: lam, phi in radians
function fwd(lam, phi, E) {
  const psi = Math.asin(M * sinBeta(phi, E)), p2 = psi * psi, p6 = p2 * p2 * p2;
  const x = (lam * Math.cos(psi)) / (M * (A1 + 3 * A2 * p2 + p6 * (7 * A3 + 9 * A4 * p2)));
  const y = psi * (A1 + A2 * p2 + p6 * (A3 + A4 * p2));
  return [x * E.rqda, y * E.rqda];
}

function inv(x, y, E) {
  x /= E.rqda; y /= E.rqda;
  y = Math.max(-MAX_Y, Math.min(MAX_Y, y));
  let yc = y, ok = false;
  for (let i = 0; i < 12; i++) {
    const y2 = yc * yc, y6 = y2 * y2 * y2;
    const f = yc * (A1 + A2 * y2 + y6 * (A3 + A4 * y2)) - y;
    const d = f / (A1 + 3 * A2 * y2 + y6 * (7 * A3 + 9 * A4 * y2));
    yc -= d;
    if (Math.abs(d) < 1e-11) { ok = true; break; }
  }
  if (!ok) return null;
  const y2 = yc * yc, y6 = y2 * y2 * y2;
  const lam = (M * x * (A1 + 3 * A2 * y2 + y6 * (7 * A3 + 9 * A4 * y2))) / Math.cos(yc);
  return [lam, fromBeta(Math.asin(Math.max(-1, Math.min(1, Math.sin(yc) / M))), E)];
}

const wrap = (l) => (Math.abs(l) <= Math.PI ? l : l - 2 * Math.PI * Math.floor((l + Math.PI) / (2 * Math.PI)));

// Degrees in, map units out (units of a; a = 1 is the unit sphere's map).
export function forward(lon, lat, { lon0 = 0, a = 1, es = 0 } = {}) {
  const [x, y] = fwd(wrap((lon - lon0) * D2R), lat * D2R, figure(es));
  return [a * x, a * y];
}

// The way back: null where the map has no point (past the pole line), and a
// longitude past the outline wrapped round, as PROJ does.
export function inverse(x, y, { lon0 = 0, a = 1, es = 0 } = {}) {
  const r = inv(x / a, y / a, figure(es));
  return r ? [wrap(r[0] + lon0 * D2R) * R2D, r[1] * R2D] : null;
}

// The projection as proj4js wants it: this.a, this.es, this.long0, this.x0
// and this.y0 come from the definition; points are radians in, metres out.
export const proj4Projection = {
  names: ["eqearth", "Equal Earth", "Equal_Earth"],
  init() {
    this.long0 = this.long0 !== undefined ? this.long0 : 0;
    this.eqearth = figure(this.es || 0);
  },
  forward(p) {
    const [x, y] = fwd(wrap(p.x - this.long0), p.y, this.eqearth);
    p.x = this.a * x + (this.x0 || 0);
    p.y = this.a * y + (this.y0 || 0);
    return p;
  },
  inverse(p) {
    const r = inv((p.x - (this.x0 || 0)) / this.a, (p.y - (this.y0 || 0)) / this.a, this.eqearth);
    if (!r) { p.x = p.y = NaN; return p; }
    p.x = wrap(r[0] + this.long0);
    p.y = r[1];
    return p;
  }
};

// Put this Equal Earth in proj4js's place (its own is the sphere only).
// Returns proj4, so a page can write useEqearth(window.proj4).
export function useEqearth(proj4) {
  if (proj4 && proj4.Proj && proj4.Proj.projections) proj4.Proj.projections.add(proj4Projection);
  return proj4;
}
