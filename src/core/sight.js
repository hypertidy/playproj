// Sight and shade. What can be seen from an eye over terrain is decided in
// the eye's central (gnomonic) projection: through the eye onto a plane, so
// a straight line in 3D stays straight and a terrain triangle stays a
// triangle. A cast shadow is the same question asked of the sun, which is
// an eye at infinity: the rays are parallel and the projection becomes
// orthographic. These are the two ends of the light on the perspective
// page, here pointed at a landscape instead of a globe.
//
// The terrain is a TIN: the vertices are the grid nodes and each square of
// four is split on the diagonal from its lower-left to its upper-right
// corner. The method is the object-space visibility map (a horizon kept in
// the eye's projection while triangles are added front to back; see De
// Floriani and Magillo 1994, and lunashade docs/viewshed.md for one
// implementation), simplified here to vertices against a horizon kept at a
// fixed set of directions:
//
//   1. Around a finite eye, four 90 degree wedges (N, E, S, W), each a
//      gnomonic image: u = right.q / forward.q, v = z / forward.q, for q
//      the offset from the eye. At fixed u, v grows with elevation angle.
//      For the sun there is one image: u across the sun's azimuth and
//      v = z - w tan(elevation), w the distance towards the sun.
//   2. Squares are visited front to back with no sort: by |dcol| + |drow|
//      from the eye's square, or by distance in squares towards the sun.
//   3. A vertex is visible when it is not below the horizon left by the
//      squares in front of it, and not hidden by the square it sits behind
//      (checked along the ray). Then its squares raise the horizon: since a
//      projected triangle's edges are straight, the horizon is the upper
//      envelope of those edges, kept at bin centres.
//
// losVisible() marches the line of sight instead, for checking. Lengths
// are metres; azimuths degrees clockwise from north.

const D2R = Math.PI / 180;

// ------------------------------------------------------------- terrain

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A synthetic landscape: a few hills, a ridge with a saddle, and some
// rough ground, n x n squares of cell metres. Heights are in z, row major
// from the south-west corner: vertex (i, j) is at x = i cell, y = j cell.
export function makeTerrain({ n = 160, cell = 30, seed = 1 } = {}) {
  const rnd = mulberry32(seed * 7919 + 13), nv = n + 1, L = n * cell;
  const hills = [];
  for (let k = 0; k < 7; k++) hills.push({ x: rnd() * L, y: rnd() * L, s: (0.06 + 0.12 * rnd()) * L, h: 80 + 260 * rnd() });
  const ridge = { a: rnd() * Math.PI, c: 0.5 * L + (rnd() - 0.5) * 0.3 * L, s: 0.05 * L, h: 220 };
  const waves = [];
  for (let k = 0; k < 24; k++) {
    const f = (2 + 2 ** (k / 4)) / L * 2 * Math.PI, a = rnd() * 2 * Math.PI;
    waves.push({ kx: f * Math.cos(a), ky: f * Math.sin(a), p: rnd() * 2 * Math.PI, h: 50 / (1 + k / 2) });
  }
  const z = new Float64Array(nv * nv);
  for (let j = 0; j < nv; j++) for (let i = 0; i < nv; i++) {
    const x = i * cell, y = j * cell;
    let h = 0;
    for (const b of hills) h += b.h * Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (2 * b.s * b.s));
    const across = (x - L / 2) * Math.cos(ridge.a) + (y - L / 2) * Math.sin(ridge.a);
    const along = -(x - L / 2) * Math.sin(ridge.a) + (y - L / 2) * Math.cos(ridge.a);
    const saddle = 1 - 0.6 * Math.exp(-(along * along) / (2 * (0.08 * L) ** 2));
    h += ridge.h * saddle * Math.exp(-((across - (ridge.c - L / 2)) ** 2) / (2 * ridge.s * ridge.s));
    for (const w of waves) h += w.h * Math.sin(w.kx * x + w.ky * y + w.p);
    z[j * nv + i] = h;
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of z) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (let k = 0; k < z.length; k++) z[k] -= lo;
  return { n, nv, cell, size: L, z, zmax: hi - lo };
}

// Height of the TIN at x, y (metres), or NaN outside it.
export function heightAt(T, x, y) {
  const gx = x / T.cell, gy = y / T.cell;
  if (!(gx >= 0 && gy >= 0 && gx <= T.n && gy <= T.n)) return NaN;
  const qi = Math.min(T.n - 1, Math.floor(gx)), qj = Math.min(T.n - 1, Math.floor(gy));
  const fx = gx - qi, fy = gy - qj, nv = T.nv, k = qj * nv + qi;
  const z00 = T.z[k], z10 = T.z[k + 1], z01 = T.z[k + nv], z11 = T.z[k + nv + 1];
  return fx >= fy ? z00 + fx * (z10 - z00) + fy * (z11 - z10) : z00 + fy * (z01 - z00) + fx * (z11 - z01);
}

// ------------------------------------------------------------- the light

// The unit vector towards a light at azimuth az, elevation el (degrees).
export function towards(az, el) {
  const a = az * D2R, e = el * D2R;
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}

// The light for a spot on the ground (x, y metres), an eye h metres above
// it, and the light dist metres further away towards az, el. dist = Infinity
// is the sun: { inf: true, d }. Otherwise { x, y, z } for the eye.
export function lightFrom(T, { x, y, h = 1.5, az = 315, el = 30, dist = 0 }) {
  const d = towards(az, el);
  if (!isFinite(dist)) return { inf: true, d, az, el };
  const g = heightAt(T, x, y);
  const z0 = (isFinite(g) ? g : 0) + h;
  return { inf: false, x: x + dist * d[0], y: y + dist * d[1], z: z0 + dist * d[2] };
}

// ------------------------------------------------------------- projection

// The images a light sees: four gnomonic wedges for an eye, one
// orthographic image for the sun. Each has forward and right in plan.
export function views(L) {
  if (!L.inf) return [
    { name: "N", f: [0, 1], r: [1, 0] }, { name: "E", f: [1, 0], r: [0, -1] },
    { name: "S", f: [0, -1], r: [-1, 0] }, { name: "W", f: [-1, 0], r: [0, 1] }
  ];
  const hz = Math.hypot(L.d[0], L.d[1]) || 1;
  const a = [L.d[0] / hz, L.d[1] / hz];
  return [{ name: "sun", f: a, r: [a[1], -a[0]], tan: L.d[2] / hz }];
}

// Clip the polygon pts (offsets from the eye, [x, y, z]) to wedge V:
// forward >= |right| and forward > 0. Returns the clipped points.
function clipWedge(pts, V) {
  const planes = [
    (p) => (V.f[0] - V.r[0]) * p[0] + (V.f[1] - V.r[1]) * p[1],
    (p) => (V.f[0] + V.r[0]) * p[0] + (V.f[1] + V.r[1]) * p[1],
    (p) => V.f[0] * p[0] + V.f[1] * p[1] - 1e-3
  ];
  let poly = pts;
  for (const s of planes) {
    if (poly.length === 0) break;
    const out = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length], sa = s(a), sb = s(b);
      if (sa >= 0) out.push(a);
      if ((sa >= 0) !== (sb >= 0)) {
        const t = sa / (sa - sb);
        out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
      }
    }
    poly = out;
  }
  return poly;
}

// A point in view V of light L: [u, v], from an offset q (eye) or a
// position p (sun).
export function uv(L, V, q) {
  if (L.inf) {
    const w = V.f[0] * q[0] + V.f[1] * q[1];
    return [V.r[0] * q[0] + V.r[1] * q[1], q[2] - w * V.tan];
  }
  const f = V.f[0] * q[0] + V.f[1] * q[1];
  return [(V.r[0] * q[0] + V.r[1] * q[1]) / f, q[2] / f];
}

// Which view a point falls in (eye only), or -1 straight below the eye.
export function viewOf(L, q) {
  if (L.inf) return 0;
  const ax = Math.abs(q[0]), ay = Math.abs(q[1]);
  if (ax < 1e-9 && ay < 1e-9) return -1;
  return ay >= ax ? (q[1] > 0 ? 0 : 2) : (q[0] > 0 ? 1 : 3);
}

// The two triangles of square (qi, qj), as vertex indices.
export function squareTriangles(T, qi, qj) {
  const k = qj * T.nv + qi, nv = T.nv;
  return [[k, k + 1, k + nv + 1], [k, k + nv + 1, k + nv]];
}

const vertexXYZ = (T, k) => [(k % T.nv) * T.cell, Math.floor(k / T.nv) * T.cell, T.z[k]];

// A triangle (vertex indices) as polygons in each view it reaches:
// [{ view, uv: [[u, v], ...] }].
export function projectTriangle(T, L, VS, tri) {
  const pts = tri.map((k) => {
    const p = vertexXYZ(T, k);
    return L.inf ? p : [p[0] - L.x, p[1] - L.y, p[2] - L.z];
  });
  if (L.inf) return [{ view: 0, uv: pts.map((q) => uv(L, VS[0], q)) }];
  const out = [];
  for (let w = 0; w < 4; w++) {
    const V = VS[w];
    let allOut = false;
    for (const s of [[V.f[0] - V.r[0], V.f[1] - V.r[1]], [V.f[0] + V.r[0], V.f[1] + V.r[1]]]) {
      if (pts.every((p) => s[0] * p[0] + s[1] * p[1] < 0)) allOut = true;
    }
    if (allOut) continue;
    const poly = clipWedge(pts, V);
    if (poly.length >= 3) out.push({ view: w, uv: poly.map((q) => uv(L, V, q)) });
  }
  return out;
}

// ------------------------------------------------------------- order

// Front-to-back level of square (qi, qj), and of vertex (i, j): the level
// of the square it sits behind. Lower is nearer the light.
function orderer(T, L) {
  if (L.inf) {
    const sx = Math.sign(L.d[0]), sy = Math.sign(L.d[1]);
    const sq = (qi, qj) => -(sx * qi + sy * qj);
    const near = (i, j) => [sx < 0 ? i - 1 : i, sy < 0 ? j - 1 : j];
    return { sq, vx: (i, j) => sq(...near(i, j)), near };
  }
  const gx = L.x / T.cell, gy = L.y / T.cell, ci = Math.floor(gx), cj = Math.floor(gy);
  const sq = (qi, qj) => Math.abs(qi - ci) + Math.abs(qj - cj);
  const near = (i, j) => [i > gx ? i - 1 : i, j > gy ? j - 1 : j];
  return { sq, vx: (i, j) => sq(...near(i, j)), near };
}

// ------------------------------------------------------------- the horizon

// Is vertex k hidden by the TIN along its own first stretch of ray, within
// the square it sits behind? Sampled along the ray to the square's edge.
function hiddenNearby(T, L, k, sq) {
  const p = vertexXYZ(T, k);
  let dx, dy, rise;
  if (L.inf) {
    const hz = Math.hypot(L.d[0], L.d[1]);
    if (hz < 1e-12) return false;
    dx = L.d[0] / hz; dy = L.d[1] / hz; rise = L.d[2] / hz;
  } else {
    const ex = L.x - p[0], ey = L.y - p[1], hz = Math.hypot(ex, ey);
    if (hz < 1e-9) return false;
    dx = ex / hz; dy = ey / hz; rise = (L.z - p[2]) / hz;
  }
  // stay in square sq: plan distance to its edge along (dx, dy)
  const x0 = sq[0] * T.cell, y0 = sq[1] * T.cell, x1 = x0 + T.cell, y1 = y0 + T.cell;
  let tmax = Infinity;
  if (dx > 0) tmax = Math.min(tmax, (x1 - p[0]) / dx); else if (dx < 0) tmax = Math.min(tmax, (x0 - p[0]) / dx);
  if (dy > 0) tmax = Math.min(tmax, (y1 - p[1]) / dy); else if (dy < 0) tmax = Math.min(tmax, (y0 - p[1]) / dy);
  if (!L.inf) tmax = Math.min(tmax, Math.hypot(L.x - p[0], L.y - p[1]));
  if (!(tmax > 0)) return false;
  const tol = 1e-6 * T.cell;
  for (let s = 1; s <= 16; s++) {
    const t = tmax * (s === 1 ? 0.01 : (s - 1) / 15);
    const g = heightAt(T, p[0] + t * dx, p[1] + t * dy);
    if (isFinite(g) && g > p[2] + t * rise + tol) return true;
  }
  return false;
}

// Visibility of every vertex from light L. Returns { vis (1 visible,
// 0 hidden), views (with the horizon E at bins centred on u0 + (b + 0.5) du),
// order (squares front to back, for drawing back to front) }.
export function horizonVisible(T, L, { bins = 2048 } = {}) {
  const VS = views(L), nv = T.nv, n = T.n, ord = orderer(T, L);

  // u range per view, from the vertices that fall in it
  for (const V of VS) { V.lo = Infinity; V.hi = -Infinity; }
  for (let k = 0; k < nv * nv; k++) {
    const p = vertexXYZ(T, k), q = L.inf ? p : [p[0] - L.x, p[1] - L.y, p[2] - L.z];
    const w = viewOf(L, q);
    if (w < 0) continue;
    const u = uv(L, VS[w], q)[0];
    if (u < VS[w].lo) VS[w].lo = u;
    if (u > VS[w].hi) VS[w].hi = u;
  }
  for (const V of VS) {
    if (!(V.hi > V.lo)) { V.lo = -1; V.hi = 1; }
    const pad = 0.02 * (V.hi - V.lo) + 1e-9;
    if (!L.inf) { V.lo = Math.max(-1, V.lo - pad); V.hi = Math.min(1, V.hi + pad); }
    else { V.lo -= pad; V.hi += pad; }
    V.du = (V.hi - V.lo) / bins;
    V.E = new Float64Array(bins).fill(-Infinity);
  }

  // bucket squares and vertices by level
  let lmin = Infinity, lmax = -Infinity;
  const sqL = new Int32Array(n * n), vxL = new Int32Array(nv * nv);
  for (let qj = 0; qj < n; qj++) for (let qi = 0; qi < n; qi++) {
    const l = ord.sq(qi, qj); sqL[qj * n + qi] = l;
    if (l < lmin) lmin = l; if (l > lmax) lmax = l;
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nv; i++) {
    const l = ord.vx(i, j); vxL[j * nv + i] = l;
    if (l < lmin) lmin = l; if (l > lmax) lmax = l;
  }
  const nl = lmax - lmin + 1;
  const bucket = (levels, count) => {
    const start = new Int32Array(nl + 1);
    for (let k = 0; k < count; k++) start[levels[k] - lmin + 1]++;
    for (let l = 0; l < nl; l++) start[l + 1] += start[l];
    const items = new Int32Array(count), fill = start.slice();
    for (let k = 0; k < count; k++) items[fill[levels[k] - lmin]++] = k;
    return { start, items };
  };
  const SQ = bucket(sqL, n * n), VX = bucket(vxL, nv * nv);

  const raise = (V, a, b) => {
    const E = V.E;
    let [u0, v0] = a, [u1, v1] = b;
    const bin = (u) => Math.floor((u - V.lo) / V.du);
    for (const [u, v] of [a, b]) { const k = bin(u); if (k >= 0 && k < bins && v > E[k]) E[k] = v; }
    if (u1 < u0) { [u0, u1] = [u1, u0]; [v0, v1] = [v1, v0]; }
    if (u1 - u0 < 1e-15) return;
    const k0 = Math.max(0, Math.ceil((u0 - V.lo) / V.du - 0.5)), k1 = Math.min(bins - 1, Math.floor((u1 - V.lo) / V.du - 0.5));
    for (let k = k0; k <= k1; k++) {
      const uc = V.lo + (k + 0.5) * V.du, v = v0 + (uc - u0) / (u1 - u0) * (v1 - v0);
      if (v > E[k]) E[k] = v;
    }
  };
  const horizonAt = (V, u) => {
    const b = (u - V.lo) / V.du - 0.5, k = Math.floor(b), t = b - k, E = V.E;
    const a = k >= 0 && k < bins ? E[k] : -Infinity, c = k + 1 >= 0 && k + 1 < bins ? E[k + 1] : -Infinity;
    if (a === -Infinity) return c;
    if (c === -Infinity) return a;
    return a + t * (c - a);
  };

  const vis = new Uint8Array(nv * nv), order = new Int32Array(n * n);
  let no = 0;
  for (let l = 0; l < nl; l++) {
    for (let s = VX.start[l]; s < VX.start[l + 1]; s++) {
      const k = VX.items[s], i = k % nv, j = (k - i) / nv;
      const p = vertexXYZ(T, k), q = L.inf ? p : [p[0] - L.x, p[1] - L.y, p[2] - L.z];
      const w = viewOf(L, q);
      if (w < 0) { vis[k] = 1; continue; }
      const [u, v] = uv(L, VS[w], q), E = horizonAt(VS[w], u);
      // a millimetre at the point, in the view's units
      const tol = L.inf ? 1e-3 : 1e-3 / (VS[w].f[0] * q[0] + VS[w].f[1] * q[1]);
      vis[k] = v + tol >= E && !hiddenNearby(T, L, k, ord.near(i, j)) ? 1 : 0;
    }
    for (let s = SQ.start[l]; s < SQ.start[l + 1]; s++) {
      const sq = SQ.items[s], qi = sq % n, qj = (sq - qi) / n;
      order[no++] = sq;
      for (const tri of squareTriangles(T, qi, qj)) {
        for (const piece of projectTriangle(T, L, VS, tri)) {
          const V = VS[piece.view], P = piece.uv;
          for (let e = 0; e < P.length; e++) raise(V, P[e], P[(e + 1) % P.length]);
        }
      }
    }
  }
  return { vis, views: VS, order };
}

// ------------------------------------------------------------- checking

// Is vertex k visible from L? Marches the line of sight across the TIN in
// steps of step cells (the slow, obvious way).
export function losVisible(T, L, k, { step = 0.125 } = {}) {
  const p = vertexXYZ(T, k);
  let dx, dy, rise, tmax;
  if (L.inf) {
    const hz = Math.hypot(L.d[0], L.d[1]);
    if (hz < 1e-12) return true;
    dx = L.d[0] / hz; dy = L.d[1] / hz; rise = L.d[2] / hz; tmax = Infinity;
  } else {
    const ex = L.x - p[0], ey = L.y - p[1], hz = Math.hypot(ex, ey);
    if (hz < 1e-9) return L.z >= p[2];
    dx = ex / hz; dy = ey / hz; rise = (L.z - p[2]) / hz; tmax = hz;
  }
  const ds = step * T.cell, tol = 1e-6 * T.cell;
  for (let t = ds * 0.1; t < tmax; t += t < ds ? ds * 0.9 : ds) {
    const zr = p[2] + t * rise;
    if (zr > T.zmax + 1) break;
    const g = heightAt(T, p[0] + t * dx, p[1] + t * dy);
    if (!isFinite(g)) break;
    if (g > zr + tol) return false;
  }
  return true;
}

// Fraction of the ground (by vertex) that is visible.
export function visibleFraction(vis) {
  let s = 0;
  for (const v of vis) s += v;
  return s / vis.length;
}
