// Shallow water solver: a line-for-line port of the shallows R package's
// C++ kernel (shallows/src/swe.cpp), so the browser and R give the same
// numbers.
//
// Finite volume, HLL flux, hydrostatic reconstruction (Audusse et al. 2004):
// well balanced, depth stays non-negative, cells wet and dry.
// order 1: piecewise constant, forward Euler.
// order 2: MUSCL (minmod) on h, u, v, h + z with the centred bed source,
//          Heun (SSP-RK2) in time.
// Kurganov-Petrova velocity desingularisation; CFL plus bed-slope
// acceleration time step; semi-implicit Manning friction; rain.
//
// Layout: row-major here (index = i * NX + j, row i, column j) with two ghost
// cells on every side. Row 0 is the north (top) edge, as in a raster.
// hv is momentum towards increasing row number.

const NG = 2;
export const WALL = 0, OPEN = 1, PERIODIC = 2;

/** Coriolis parameter 2 omega sin(lat), lat in degrees (negative south). */
export const coriolis = (lat, omega = 7.2921159e-5) => 2 * omega * Math.sin(lat * Math.PI / 180);

function minmod(a, b) {
  if (a * b <= 0) return 0;
  return Math.abs(a) < Math.abs(b) ? a : b;
}

// HLL flux into f[0..2] for (h, h un, h ut)
function hll(hl, ul, vl, hr, ur, vr, g, f) {
  if (hl <= 0 && hr <= 0) { f[0] = f[1] = f[2] = 0; return; }
  const cl = Math.sqrt(g * hl), cr = Math.sqrt(g * hr);
  const sl = Math.min(ul - cl, ur - cr);
  const sr = Math.max(ul + cl, ur + cr);
  const fl0 = hl * ul, fl1 = hl * ul * ul + 0.5 * g * hl * hl, fl2 = hl * ul * vl;
  const fr0 = hr * ur, fr1 = hr * ur * ur + 0.5 * g * hr * hr, fr2 = hr * ur * vr;
  if (sl >= 0) { f[0] = fl0; f[1] = fl1; f[2] = fl2; return; }
  if (sr <= 0) { f[0] = fr0; f[1] = fr1; f[2] = fr2; return; }
  const inv = 1 / (sr - sl);
  f[0] = (sr * fl0 - sl * fr0 + sl * sr * (hr - hl)) * inv;
  f[1] = (sr * fl1 - sl * fr1 + sl * sr * (hr * ur - hl * ul)) * inv;
  f[2] = (sr * fl2 - sl * fr2 + sl * sr * (hr * vr - hl * vl)) * inv;
}

/**
 * Create a solver.
 * @param {object} o
 * @param {number} o.nx columns
 * @param {number} o.ny rows
 * @param {number} o.dx cell width (m)
 * @param {number} [o.dy] cell height (m)
 * @param {ArrayLike<number>} o.z bed, row-major ny * nx
 * @param {ArrayLike<number>} [o.h] depth
 * @param {ArrayLike<number>} [o.hu] [o.hv] momentum
 * @param {number|ArrayLike<number>} [o.manning]
 * @param {number|ArrayLike<number>} [o.rain] m/s
 * @param {number|ArrayLike<number>} [o.f] Coriolis parameter (1/s), > 0 north
 * @param {number[]} [o.bc] west, east, north, south: WALL, OPEN or PERIODIC
 * @param {number} [o.order] 1 or 2
 * @param {number} [o.cfl]
 * @param {number} [o.hdry]
 * @param {number} [o.g]
 */
export function createSolver(o) {
  const nx = o.nx, ny = o.ny, dx = o.dx, dy = o.dy ?? o.dx, g = o.g ?? 9.81;
  const NX = nx + 2 * NG, NY = ny + 2 * NG, N = NX * NY;
  const id = (i, j) => (i + NG) * NX + (j + NG);
  const S = {
    nx, ny, dx, dy, g, NX, NY,
    order: o.order ?? 2, cfl: o.cfl ?? 0.45, hdry: o.hdry ?? 1e-5, dtMax: o.dtMax ?? Infinity,
    bc: (o.bc ?? [WALL, WALL, WALL, WALL]).slice(),
    z: new Float64Array(N), n: new Float64Array(N), rain: new Float64Array(N), f: new Float64Array(N),
    h: new Float64Array(N), hu: new Float64Array(N), hv: new Float64Array(N),
    acc: new Float64Array(N),
    t: 0, steps: 0, rainIn: 0, outflow: 0, added: 0, clipped: 0, lastDt: 0,
    id,
  };
  const r1 = { h: new Float64Array(N), hu: new Float64Array(N), hv: new Float64Array(N) };
  const r2 = { h: new Float64Array(N), hu: new Float64Array(N), hv: new Float64Array(N) };
  const u1 = { h: new Float64Array(N), hu: new Float64Array(N), hv: new Float64Array(N) };
  const f = new Float64Array(3);
  const fv = new Float64Array(16);  // face values scratch

  const load = (dst, src, def = 0) => {
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
      dst[id(i, j)] = src == null ? def : (typeof src === 'number' ? src : src[i * nx + j]);
    }
  };
  load(S.z, o.z); load(S.h, o.h); load(S.hu, o.hu); load(S.hv, o.hv);
  load(S.n, o.manning ?? 0); load(S.rain, o.rain ?? 0); load(S.f, o.f ?? 0);

  function vel(h, q) {
    if (h <= 0) return 0;
    const h2 = h * h, h4 = h2 * h2, e = S.hdry, e4 = e * e * e * e;
    return Math.SQRT2 * h * q / Math.sqrt(h4 + Math.max(h4, e4));
  }
  S.vel = vel;

  // interior index copied into ghost k on the low (west / north) or high side
  const src = (b, k, n, low) => b === WALL ? (low ? k - 1 : n - k) : b === PERIODIC ? (low ? n - k : k - 1) : (low ? 0 : n - 1);

  function fillBedGhosts() {
    const b = S.bc;
    for (let i = 0; i < ny; i++) for (let k = 1; k <= NG; k++) {
      const sw = src(b[0], k, nx, true), se = src(b[1], k, nx, false);
      S.z[id(i, -k)] = S.z[id(i, sw)]; S.n[id(i, -k)] = S.n[id(i, sw)];
      S.z[id(i, nx - 1 + k)] = S.z[id(i, se)]; S.n[id(i, nx - 1 + k)] = S.n[id(i, se)];
    }
    for (let j = -NG; j < nx + NG; j++) for (let k = 1; k <= NG; k++) {
      const sn = src(b[2], k, ny, true), ss = src(b[3], k, ny, false);
      S.z[id(-k, j)] = S.z[id(sn, j)]; S.n[id(-k, j)] = S.n[id(sn, j)];
      S.z[id(ny - 1 + k, j)] = S.z[id(ss, j)]; S.n[id(ny - 1 + k, j)] = S.n[id(ss, j)];
    }
  }
  function bedAccel() {
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
      const c = id(i, j), z = S.z;
      const sx = Math.max(Math.abs(z[id(i, j + 1)] - z[c]), Math.abs(z[c] - z[id(i, j - 1)])) / dx;
      const sy = Math.max(Math.abs(z[id(i + 1, j)] - z[c]), Math.abs(z[c] - z[id(i - 1, j)])) / dy;
      S.acc[c] = g * (sx / dx + sy / dy);
    }
  }
  /** Call after changing z, manning or bc. */
  S.prepare = () => { fillBedGhosts(); bedAccel(); };
  S.prepare();

  function fillGhosts(s) {
    const b = S.bc;
    for (let i = 0; i < ny; i++) for (let k = 1; k <= NG; k++) {
      const sw = src(b[0], k, nx, true), se = src(b[1], k, nx, false);
      const a = id(i, -k), bb = id(i, sw), c = id(i, nx - 1 + k), d = id(i, se);
      s.h[a] = s.h[bb]; s.hv[a] = s.hv[bb]; s.hu[a] = b[0] === WALL ? -s.hu[bb] : s.hu[bb];
      s.h[c] = s.h[d]; s.hv[c] = s.hv[d]; s.hu[c] = b[1] === WALL ? -s.hu[d] : s.hu[d];
    }
    for (let j = -NG; j < nx + NG; j++) for (let k = 1; k <= NG; k++) {
      const sn = src(b[2], k, ny, true), ss = src(b[3], k, ny, false);
      const a = id(-k, j), bb = id(sn, j), c = id(ny - 1 + k, j), d = id(ss, j);
      s.h[a] = s.h[bb]; s.hu[a] = s.hu[bb]; s.hv[a] = b[2] === WALL ? -s.hv[bb] : s.hv[bb];
      s.h[c] = s.h[d]; s.hu[c] = s.hu[d]; s.hv[c] = b[3] === WALL ? -s.hv[d] : s.hv[d];
    }
  }

  // faces of cell c into fv[o..o+7]: hm, unm, utm, zm, hp, unp, utp, zp
  function faces(s, qn, qt, cm, c, cp, o) {
    const h = s.h[c], z = S.z;
    const un = vel(h, qn[c]), ut = vel(h, qt[c]);
    if (S.order === 1) {
      fv[o] = fv[o + 4] = h; fv[o + 1] = fv[o + 5] = un; fv[o + 2] = fv[o + 6] = ut;
      fv[o + 3] = fv[o + 7] = z[c];
      return;
    }
    const hM = s.h[cm], hP = s.h[cp];
    const eta = h + z[c], etaM = hM + z[cm], etaP = hP + z[cp];
    const sh = minmod(h - hM, hP - h);
    const se = minmod(eta - etaM, etaP - eta);
    const su = minmod(un - vel(hM, qn[cm]), vel(hP, qn[cp]) - un);
    const sv = minmod(ut - vel(hM, qt[cm]), vel(hP, qt[cp]) - ut);
    const hm = h - 0.5 * sh, hp = h + 0.5 * sh;
    let unm, unp, utm, utp;
    if (h > S.hdry) {
      unm = un - 0.5 * (hp / h) * su; unp = un + 0.5 * (hm / h) * su;
      utm = ut - 0.5 * (hp / h) * sv; utp = ut + 0.5 * (hm / h) * sv;
    } else { unm = unp = un; utm = utp = ut; }
    fv[o] = hm; fv[o + 1] = unm; fv[o + 2] = utm; fv[o + 3] = (eta - 0.5 * se) - hm;
    fv[o + 4] = hp; fv[o + 5] = unp; fv[o + 6] = utp; fv[o + 7] = (eta + 0.5 * se) - hp;
  }

  // returns outflow rate (m3/s) through the edges
  function rhs(s, r) {
    fillGhosts(s);
    r.h.fill(0); r.hu.fill(0); r.hv.fill(0);
    let out = 0;
    // x sweep; L = fv[0..7] (cell j), R = fv[8..15] (cell j+1)
    for (let i = 0; i < ny; i++) {
      faces(s, s.hu, s.hv, id(i, -2), id(i, -1), id(i, 0), 0);
      for (let j = -1; j < nx; j++) {
        faces(s, s.hu, s.hv, id(i, j), id(i, j + 1), id(i, j + 2), 8);
        const hpL = fv[4], upL = fv[5], vpL = fv[6], zpL = fv[7];
        const hmR = fv[8], umR = fv[9], vmR = fv[10], zmR = fv[11], hpR = fv[12], zpR = fv[15];
        const zs = Math.max(zpL, zmR);
        const hl = Math.max(0, hpL + zpL - zs), hr = Math.max(0, hmR + zmR - zs);
        hll(hl, upL, vpL, hr, umR, vmR, g, f);
        const corrL = 0.5 * g * (hpL * hpL - hl * hl), corrR = 0.5 * g * (hmR * hmR - hr * hr);
        if (j >= 0) {
          const c = id(i, j);
          r.h[c] -= f[0] / dx; r.hu[c] -= (f[1] + corrL) / dx; r.hv[c] -= f[2] / dx;
        } else out -= f[0] * dy;
        if (j + 1 < nx) {
          const c = id(i, j + 1);
          r.h[c] += f[0] / dx; r.hu[c] += (f[1] + corrR) / dx; r.hv[c] += f[2] / dx;
          r.hu[c] += -g * 0.5 * (hmR + hpR) * (zpR - zmR) / dx;
        } else out += f[0] * dy;
        for (let k = 0; k < 8; k++) fv[k] = fv[k + 8];
      }
    }
    // y sweep; normal momentum is hv
    for (let j = 0; j < nx; j++) {
      faces(s, s.hv, s.hu, id(-2, j), id(-1, j), id(0, j), 0);
      for (let i = -1; i < ny; i++) {
        faces(s, s.hv, s.hu, id(i, j), id(i + 1, j), id(i + 2, j), 8);
        const hpL = fv[4], vpL = fv[5], upL = fv[6], zpL = fv[7];
        const hmR = fv[8], vmR = fv[9], umR = fv[10], zmR = fv[11], hpR = fv[12], zpR = fv[15];
        const zs = Math.max(zpL, zmR);
        const hl = Math.max(0, hpL + zpL - zs), hr = Math.max(0, hmR + zmR - zs);
        hll(hl, vpL, upL, hr, vmR, umR, g, f);
        const corrL = 0.5 * g * (hpL * hpL - hl * hl), corrR = 0.5 * g * (hmR * hmR - hr * hr);
        if (i >= 0) {
          const c = id(i, j);
          r.h[c] -= f[0] / dy; r.hv[c] -= (f[1] + corrL) / dy; r.hu[c] -= f[2] / dy;
        } else out -= f[0] * dx;
        if (i + 1 < ny) {
          const c = id(i + 1, j);
          r.h[c] += f[0] / dy; r.hv[c] += (f[1] + corrR) / dy; r.hu[c] += f[2] / dy;
          r.hv[c] += -g * 0.5 * (hmR + hpR) * (zpR - zmR) / dy;
        } else out += f[0] * dx;
        for (let k = 0; k < 8; k++) fv[k] = fv[k + 8];
      }
    }
    return out;
  }

  function stableDt(s, cap) {
    let dt = cap, wet = false;
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
      const c = id(i, j), h = s.h[c];
      if (h <= 0) continue;
      wet = true;
      const cw = Math.sqrt(g * h);
      const B = (Math.abs(vel(h, s.hu[c])) + cw) / dx + (Math.abs(vel(h, s.hv[c])) + cw) / dy;
      const A = S.acc[c];
      const d = A > 0 ? 2 * S.cfl / (B + Math.sqrt(B * B + 4 * A * S.cfl)) : S.cfl / B;
      if (d < dt) dt = d;
    }
    if (!wet) dt = Math.min(dt, 1);  // a dry grid steps at 1 s (rain on dry ground)
    return dt;
  }

  function clean(s) {
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
      const c = id(i, j);
      if (s.h[c] < 0) { S.clipped -= s.h[c] * dx * dy; s.h[c] = 0; }
      if (s.h[c] < 1e-12) { s.hu[c] = 0; s.hv[c] = 0; }
      else if (s.h[c] < S.hdry) {
        s.hu[c] = s.h[c] * vel(s.h[c], s.hu[c]);
        s.hv[c] = s.h[c] * vel(s.h[c], s.hv[c]);
      }
    }
  }

  // Coriolis as an exact rotation of momentum; north-positive (U, V) = (hu, -hv)
  let rotating = false;
  for (let c = 0; c < N; c++) if (S.f[c] !== 0) { rotating = true; break; }
  function coriolisTurn(s, dt) {
    if (!rotating) return;
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
      const c = id(i, j), f = S.f[c];
      if (f === 0 || s.h[c] <= 0) continue;
      const th = f * dt, cs = Math.cos(th), sn = Math.sin(th);
      const U = s.hu[c], V = -s.hv[c];
      s.hu[c] = U * cs + V * sn;
      s.hv[c] = -(-U * sn + V * cs);
    }
  }
  /** Set the Coriolis parameter (number or row-major array). */
  S.setF = (fv2) => {
    rotating = false;
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
      const v = typeof fv2 === 'number' ? fv2 : fv2[i * nx + j];
      S.f[id(i, j)] = v; if (v !== 0) rotating = true;
    }
  };

  function friction(s, dt) {
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
      const c = id(i, j), n = S.n[c], h = s.h[c];
      if (n <= 0 || h <= 1e-12) continue;
      const u = vel(h, s.hu[c]), v = vel(h, s.hv[c]);
      const sp = Math.sqrt(u * u + v * v);
      const fac = 1 + dt * g * n * n * sp / Math.pow(h, 4 / 3);
      s.hu[c] /= fac; s.hv[c] /= fac;
    }
  }

  let rainRateVol = 0;
  S.setRain = (rate) => {
    rainRateVol = 0;
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
      const c = id(i, j);
      S.rain[c] = typeof rate === 'number' ? rate : rate[i * nx + j];
      rainRateVol += S.rain[c];
    }
    rainRateVol *= dx * dy;
  };
  S.setRain(o.rain ?? 0);
  clean(S);  // once at start, as the C++ does (clean is not idempotent for thin films)

  /** Advance one step, never past tLimit. Returns dt. */
  S.step = (tLimit = Infinity) => {
    let dt = stableDt(S, S.dtMax);
    S.lastDt = dt;
    if (S.t + dt > tLimit) dt = tLimit - S.t;
    if (dt <= 0) return 0;
    coriolisTurn(S, 0.5 * dt);  // Strang splitting: half turn, flow step, half turn
    const out1 = rhs(S, r1);
    if (S.order === 1) {
      for (let c = 0; c < N; c++) { S.h[c] += dt * r1.h[c]; S.hu[c] += dt * r1.hu[c]; S.hv[c] += dt * r1.hv[c]; }
      S.outflow += dt * out1;
    } else {
      for (let c = 0; c < N; c++) {
        u1.h[c] = S.h[c] + dt * r1.h[c]; u1.hu[c] = S.hu[c] + dt * r1.hu[c]; u1.hv[c] = S.hv[c] + dt * r1.hv[c];
      }
      clean(u1);
      const out2 = rhs(u1, r2);
      for (let c = 0; c < N; c++) {
        S.h[c] = 0.5 * (S.h[c] + u1.h[c] + dt * r2.h[c]);
        S.hu[c] = 0.5 * (S.hu[c] + u1.hu[c] + dt * r2.hu[c]);
        S.hv[c] = 0.5 * (S.hv[c] + u1.hv[c] + dt * r2.hv[c]);
      }
      S.outflow += 0.5 * dt * (out1 + out2);
    }
    if (rainRateVol > 0) {
      for (let c = 0; c < N; c++) S.h[c] += dt * S.rain[c];
      S.rainIn += dt * rainRateVol;
    }
    friction(S, dt);
    coriolisTurn(S, 0.5 * dt);
    clean(S);
    S.t += dt; S.steps++;
    return dt;
  };

  /** Run to time t (s). */
  S.runTo = (t) => { while (S.t < t - 1e-12) S.step(t); };

  S.volume = () => {
    let v = 0;
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) v += S.h[id(i, j)];
    return v * dx * dy;
  };
  S.volume0 = S.volume();
  /** Water budget: stored - (initial + added + rain - outflow). */
  S.budgetError = () => S.volume() - (S.volume0 + S.added + S.rainIn - S.outflow);

  /** Add a column of water of depth d (m) within radius r (m) of cell (i, j). */
  S.addWater = (ci, cj, r, d) => {
    let v = 0;
    const ri = Math.ceil(r / dy), rj = Math.ceil(r / dx);
    for (let i = Math.max(0, ci - ri); i <= Math.min(ny - 1, ci + ri); i++)
      for (let j = Math.max(0, cj - rj); j <= Math.min(nx - 1, cj + rj); j++) {
        const ddx = (j - cj) * dx, ddy = (i - ci) * dy;
        if (ddx * ddx + ddy * ddy <= r * r) { S.h[id(i, j)] += d; v += d; }
      }
    S.added += v * dx * dy;
    return v * dx * dy;
  };

  /** Copy interior field into a row-major ny * nx array. */
  S.field = (name, outArr) => {
    const a = S[name], o2 = outArr ?? new Float64Array(nx * ny);
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) o2[i * nx + j] = a[id(i, j)];
    return o2;
  };
  S.at = (name, i, j) => S[name][id(i, j)];
  return S;
}

// ---- analytic solutions (same as the R package) ----

export function dambreakRitter(x, t, h0, x0 = 0, g = 9.81) {
  const c0 = Math.sqrt(g * h0), xi = (x - x0) / t;
  if (xi <= -c0) return h0;
  if (xi >= 2 * c0) return 0;
  return (2 * c0 - xi) ** 2 / (9 * g);
}

export function dambreakStoker(hl, hr, g = 9.81) {
  const cl = Math.sqrt(g * hl);
  const fn = (hm) => 2 * (cl - Math.sqrt(g * hm)) - (hm - hr) * Math.sqrt(0.5 * g * (hm + hr) / (hm * hr));
  let a = hr, b = hl;
  for (let k = 0; k < 200; k++) { const m = 0.5 * (a + b); if (fn(a) * fn(m) <= 0) b = m; else a = m; }
  const hm = 0.5 * (a + b), cm = Math.sqrt(g * hm), um = 2 * (cl - cm), s = hm * um / (hm - hr);
  return (x, t, x0 = 0) => {
    const xi = (x - x0) / t;
    if (xi <= -cl) return hl;
    if (xi <= um - cm) return (2 * cl - xi) ** 2 / (9 * g);
    if (xi <= s) return hm;
    return hr;
  };
}

export function thackerBowl(x, y, t, D0 = 0.1, L = 1, eta0 = 0.5, g = 9.81) {
  const omega = Math.sqrt(2 * g * D0) / L;
  const z = D0 * ((x * x + y * y) / (L * L) - 1);
  const eta = (eta0 * D0 / (L * L)) * (2 * x * Math.cos(omega * t) + 2 * y * Math.sin(omega * t) - eta0);
  const h = Math.max(eta - z, 0);
  const wet = h > 0;
  return { z, h, u: wet ? -eta0 * omega * Math.sin(omega * t) : 0, v: wet ? eta0 * omega * Math.cos(omega * t) : 0,
    period: 2 * Math.PI / omega };
}
