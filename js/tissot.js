// Tissot's indicatrix for any forward projection.
//
// A small circle on the globe projects to (very nearly) an ellipse on the
// map. Its axes a and b are the largest and smallest scale at the point, so
// one picture shows the whole local distortion: a = b everywhere means
// conformal, a * b = 1 everywhere means equal area.
//
// The numbers follow PROJ's proj_factors() exactly (src/factors.cpp): the
// derivatives come from the same four-point difference about the point, and
// h, k, s, omega, theta' and convergence from the same formulas (Snyder 1987,
// pp. 20-26), as in Bill Huber's https://gis.stackexchange.com/a/5075.
// Unlike PROJ it needs nothing but a forward function, so it works on a ray
// construction or any other projection that has no PROJ string.
//
// A forward function takes lon, lat in degrees and returns [x, y] in units of
// the semi-major axis (sphere radius), or null where the point does not
// project. Angles in results are in degrees, like pyproj's get_factors().

const D2R = Math.PI / 180, R2D = 180 / Math.PI, HALFPI = Math.PI / 2;

const aasin = (v) => Math.asin(Math.max(-1, Math.min(1, v)));

// The four-point derivative of PROJ's pj_deriv(): the projection at the
// corners (lam +/- h, phi +/- h) about (lam + dl, phi), per radian.
function stencil(fwd, lam, phi, h, dl = 0) {
  const at = (a, b) => fwd((lam + dl + a) * R2D, (phi + b) * R2D);
  const pp = at(h, h), pm = at(h, -h), mm = at(-h, -h), mp = at(-h, h);
  if (!pp || !pm || !mm || !mp) return null;
  const d = 4 * h;
  const v = [
    (pp[0] + pm[0] - mm[0] - mp[0]) / d, // x_l
    (pp[0] - pm[0] - mm[0] + mp[0]) / d, // x_p
    (pp[1] + pm[1] - mm[1] - mp[1]) / d, // y_l
    (pp[1] - pm[1] - mm[1] + mp[1]) / d  // y_p
  ];
  return v.every(Number.isFinite) ? v : null;
}

const norm = (v) => Math.hypot(v[0], v[1], v[2], v[3]);

// PROJ differences the projection before it wraps longitude, so a point on
// the far meridian (the seam of the map) still gets one side's derivative.
// A forward function that wraps instead jumps across the seam, and the
// stencil then spans both edges of the map. When it does (the derivative
// dwarfs both one-sided ones), use the smaller side, extrapolated.
function deriv(fwd, lam, phi, h) {
  const c = stencil(fwd, lam, phi, h);
  // a step of 2h moving the map point by more than 0.1 radii is a scale
  // over 5000: either a jump or close enough to a singularity to check
  if (c && Math.hypot(c[0], c[2]) * 2 * h < 0.1) return c;
  const l = stencil(fwd, lam, phi, h, -h), r = stencil(fwd, lam, phi, h, h);
  if (c && l && r) {
    const nl = norm(l), nr = norm(r);
    if (norm(c) <= 1e3 * Math.min(nl, nr)) return c;
    // extrapolate that side's derivative back to lam from one step further
    // out: second order, like the centred stencil
    const sg = nl < nr ? -1 : 1, d1 = sg < 0 ? l : r, d2 = stencil(fwd, lam, phi, h, 2 * sg * h);
    return d2 ? d1.map((v, i) => 2 * v - d2[i]) : d1;
  }
  // at an edge of the domain a one-sided stencil may still exist
  return c || l || r;
}

// The factors from the four derivatives at latitude phi (radians), with
// PROJ's formulas (factors.cpp). Angles come back in degrees.
export function fromDerivatives(x_l, x_p, y_l, y_p, phi, es = 0) {
  const cosphi = Math.cos(phi);
  let hs = Math.hypot(x_p, y_p), ks = Math.hypot(x_l, y_l) / cosphi, r = 1;
  if (es !== 0) {
    const t = 1 - es * Math.sin(phi) ** 2, n = Math.sqrt(t);
    hs *= t * n / (1 - es);
    ks *= n;
    r = t * t / (1 - es);
  }
  const conv = -Math.atan2(x_p, y_p);
  const s = (y_p * x_l - x_p * y_l) * r / cosphi;
  const thetap = aasin(s / (hs * ks));
  let t = ks * ks + hs * hs;
  let a = Math.sqrt(t + 2 * s);
  t = t - 2 * s;
  t = t <= 0 ? 0 : Math.sqrt(t);
  const b = 0.5 * (a - t);
  a = 0.5 * (a + t);
  const omega = 2 * aasin((a - b) / (a + b));

  // Unit steps east and north on the ground (in units of the semi-major
  // axis) carried onto the plane: the columns of the local Jacobian.
  let mE = cosphi, mN = 1;
  if (es !== 0) {
    const w = 1 - es * Math.sin(phi) ** 2;
    mE = cosphi / Math.sqrt(w);           // N cos(phi), prime vertical radius
    mN = (1 - es) / (w * Math.sqrt(w));   // M, meridian radius
  }
  return {
    h: hs, k: ks, s, a, b,
    omega: omega * R2D, thetap: thetap * R2D, conv: conv * R2D,
    dx_dlam: x_l, dx_dphi: x_p, dy_dlam: y_l, dy_dphi: y_p,
    east: [x_l / mE, y_l / mE], north: [x_p / mN, y_p / mN]
  };
}

// Distortion at lon, lat (degrees). `es` is the eccentricity squared of the
// ellipsoid the forward function works on (0 for a sphere). Returns null
// where the projection is undefined at or next to the point.
export function factors(fwd, lon, lat, { es = 0, h = 1e-5 } = {}) {
  if (!(Math.abs(lat) <= 90)) return null;
  let phi = lat * D2R;
  // like PROJ, step just inside the pole so the difference still exists
  if (Math.abs(phi) > HALFPI - h) phi = phi < 0 ? -(HALFPI - h) : HALFPI - h;
  const d = deriv(fwd, lon * D2R, phi, h);
  if (!d) return null;
  const f = fromDerivatives(d[0], d[1], d[2], d[3], phi, es);
  if (![f.h, f.k, f.s, f.a, f.b].every(Number.isFinite)) return null;
  f.lon = lon; f.lat = lat;
  return f;
}

// The indicatrix of radius r (ground distance, in units of the semi-major
// axis) as a closed ring of n + 1 map points about centre [cx, cy]: the image
// of the circle under the local linear map. It is exact as r goes to zero.
export function ellipse(f, cx, cy, r, n = 48) {
  const out = new Float64Array(2 * (n + 1));
  for (let i = 0; i <= n; i++) {
    const t = (2 * Math.PI * i) / n, c = Math.cos(t) * r, s = Math.sin(t) * r;
    out[2 * i] = cx + c * f.east[0] + s * f.north[0];
    out[2 * i + 1] = cy + c * f.east[1] + s * f.north[1];
  }
  return out;
}

// Map direction (radians, counterclockwise from +x) of the semi-major axis.
export function majorAxis(f) {
  const [p, q] = f.east, [u, v] = f.north;
  // J = [[p, u], [q, v]]; the major axis is the top eigenvector of J J^T
  const A = p * p + u * u, B = p * q + u * v, C = q * q + v * v;
  return 0.5 * Math.atan2(2 * B, A - C);
}

// A small circle of angular radius r (degrees) about lon, lat on the sphere,
// as n + 1 [lon, lat] pairs in a flat array (closed).
export function smallCircle(lon, lat, r, n = 48) {
  const out = new Float64Array(2 * (n + 1));
  const p1 = lat * D2R, l1 = lon * D2R, d = r * D2R;
  const sp = Math.sin(p1), cp = Math.cos(p1), sd = Math.sin(d), cd = Math.cos(d);
  for (let i = 0; i <= n; i++) {
    const az = (2 * Math.PI * i) / n;
    const p2 = Math.asin(Math.max(-1, Math.min(1, sp * cd + cp * sd * Math.cos(az))));
    const l2 = l1 + Math.atan2(Math.sin(az) * sd * cp, cd - sp * Math.sin(p2));
    out[2 * i] = (((l2 * R2D + 540) % 360) - 180);
    out[2 * i + 1] = p2 * R2D;
  }
  return out;
}

// A forward function from a PROJ string, through proj4js. Returns
// { fwd, es, a } with fwd in units of a, or null if proj4js rejects the
// string. Points that do not survive the round trip back to lon/lat are
// treated as off the map (proj4js often returns numbers past the horizon).
// proj4js returns NaN without explicit lon_0, lat_0, x_0 and y_0 (and
// lat_ts for cea), and wants +approx for a spherical transverse Mercator;
// add them where missing. PROJ's defaults are the same zeros.
export function proj4Def(def) {
  let s = def.trim();
  const keys = ["lon_0", "lat_0", "x_0", "y_0"];
  if (/\+proj=cea\b/.test(s)) keys.push("lat_ts");
  for (const k of keys) if (!new RegExp(`\\+${k}=`).test(s)) s += ` +${k}=0`;
  if (/\+proj=tmerc\b/.test(s) && /\+R=/.test(s) && !/\+approx\b/.test(s)) s += " +approx";
  return s;
}

export function proj4Forward(proj4, def, { check = true } = {}) {
  let P, tr;
  def = proj4Def(def);
  try {
    P = proj4.Proj(def);
    const b = P.b ?? P.a * Math.sqrt(1 - P.es);
    tr = proj4(`+proj=longlat +a=${P.a} +b=${b} +no_defs`, def);
  } catch (e) {
    return null;
  }
  const A = P.a;
  const fwd = (lon, lat) => {
    let q;
    try { q = tr.forward([lon, lat]); } catch (e) { return null; }
    if (!q || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) return null;
    if (check) {
      let ll;
      try { ll = tr.inverse([q[0], q[1]]); } catch (e) { return null; }
      if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return null;
      let dl = Math.abs(ll[0] - lon) % 360; dl = Math.min(dl, 360 - dl);
      if (Math.abs(ll[1] - lat) > 1e-4 || (Math.abs(lat) < 89.9 && dl * Math.cos(lat * D2R) > 1e-4)) return null;
    }
    return [q[0] / A, q[1] / A];
  };
  const inv = (x, y) => {
    let ll;
    try { ll = tr.inverse([x * A, y * A]); } catch (e) { return null; }
    if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1]) || Math.abs(ll[1]) > 90) return null;
    const q = fwd(ll[0], ll[1]);
    return q && Math.hypot(q[0] - x, q[1] - y) < 1e-6 ? ll : null;
  };
  return { fwd, inv, es: P.es || 0, a: A };
}

// A one-line description of what the sampled factors say about the map.
export function classify(list) {
  let wmax = 0, smin = Infinity, smax = -Infinity;
  for (const f of list) {
    if (!f) continue;
    wmax = Math.max(wmax, f.omega);
    smin = Math.min(smin, f.s); smax = Math.max(smax, f.s);
  }
  if (!Number.isFinite(smin)) return { kind: "none", wmax, smin, smax };
  const conformal = wmax < 1e-4, equal = (smax - smin) / smax < 1e-4;
  return { kind: conformal ? "conformal" : equal ? "equal-area" : "compromise", wmax, smin, smax };
}
