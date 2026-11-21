// Two-dimensional shallow water equations on a regular grid.
//
// Finite volume, HLL flux, hydrostatic reconstruction (Audusse, Bouchut,
// Bristeau, Klein and Perthame 2004, SIAM J. Sci. Comput. 25, 2050-2065).
// The scheme is well balanced (lake at rest is preserved to round-off) and
// keeps depth non-negative under the CFL condition, so cells may wet and dry.
//
// order = 1: piecewise constant states, forward Euler.
// order = 2: MUSCL (minmod) reconstruction of h, u, v and h + z with the
//            centred bed source term of Audusse et al., Heun (SSP-RK2) in time.
//
// Layout: R matrices are column major, nrow = ny (row index i), ncol = nx
// (column index j). x runs along columns (spacing dx), y runs along rows
// (spacing dy). hv is momentum in the direction of increasing row index.
// Two ghost cells are kept on every side.

#include <Rcpp.h>
#include <cmath>
#include <vector>
#include <algorithm>

using namespace Rcpp;

namespace {

const int NG = 2;

enum Bc { WALL = 0, OPEN = 1 };

struct Grid {
  int nx, ny, NX, NY;
  double dx, dy, g;
  Grid(int nx_, int ny_, double dx_, double dy_, double g_)
    : nx(nx_), ny(ny_), NX(nx_ + 2 * NG), NY(ny_ + 2 * NG), dx(dx_), dy(dy_), g(g_) {}
  inline int id(int i, int j) const { return (i + NG) + (j + NG) * NY; }
  int size() const { return NX * NY; }
};

struct State {
  std::vector<double> h, hu, hv;
  explicit State(int n = 0) : h(n, 0.0), hu(n, 0.0), hv(n, 0.0) {}
};

inline double minmod(double a, double b) {
  if (a * b <= 0.0) return 0.0;
  return (std::fabs(a) < std::fabs(b)) ? a : b;
}

// HLL flux for the 1D system in the normal direction:
//   q = (h, h un, h ut),  F = (h un, h un^2 + g h^2 / 2, h un ut)
inline void hll(double hl, double ul, double vl,
                double hr, double ur, double vr,
                double g, double* f) {
  if (hl <= 0.0 && hr <= 0.0) { f[0] = f[1] = f[2] = 0.0; return; }
  double cl = std::sqrt(g * hl), cr = std::sqrt(g * hr);
  double sl = std::min(ul - cl, ur - cr);
  double sr = std::max(ul + cl, ur + cr);
  double fl0 = hl * ul, fl1 = hl * ul * ul + 0.5 * g * hl * hl, fl2 = hl * ul * vl;
  double fr0 = hr * ur, fr1 = hr * ur * ur + 0.5 * g * hr * hr, fr2 = hr * ur * vr;
  if (sl >= 0.0) { f[0] = fl0; f[1] = fl1; f[2] = fl2; return; }
  if (sr <= 0.0) { f[0] = fr0; f[1] = fr1; f[2] = fr2; return; }
  double inv = 1.0 / (sr - sl);
  f[0] = (sr * fl0 - sl * fr0 + sl * sr * (hr - hl)) * inv;
  f[1] = (sr * fl1 - sl * fr1 + sl * sr * (hr * ur - hl * ul)) * inv;
  f[2] = (sr * fl2 - sl * fr2 + sl * sr * (hr * vr - hl * vl)) * inv;
}

struct Solver {
  Grid G;
  std::vector<double> z;     // bed, with ghosts
  std::vector<double> nman;  // Manning n per cell (with ghosts)
  int bc[4];                 // west, east, north (row 0 side), south (row ny-1 side)
  int order;
  double hdry;               // below this depth velocity is taken as zero
  // boundary mass flux accumulated over one evaluation of the RHS (m^3/s out)
  double outflow_rate;

  Solver(const Grid& g) : G(g), z(g.size(), 0.0), nman(g.size(), 0.0),
    order(1), hdry(1e-6), outflow_rate(0.0), clipped(0.0) {}

  // Desingularised velocity (Kurganov and Petrova 2007): equals q / h for
  // h well above hdry, and goes smoothly to zero as h -> 0, so thin films
  // cannot carry spurious huge velocities.
  inline double vel(double h, double q) const {
    if (h <= 0.0) return 0.0;
    double h2 = h * h, h4 = h2 * h2, e4 = hdry * hdry * hdry * hdry;
    return std::sqrt(2.0) * h * q / std::sqrt(h4 + std::max(h4, e4));
  }

  void fill_ghosts(State& s) const {
    // columns (west / east)
    for (int i = 0; i < G.ny; i++) {
      for (int k = 1; k <= NG; k++) {
        int jw = -k, je = G.nx - 1 + k;
        int sw = (bc[0] == WALL) ? (k - 1) : 0;
        int se = (bc[1] == WALL) ? (G.nx - k) : (G.nx - 1);
        int a = G.id(i, jw), b = G.id(i, sw), c = G.id(i, je), d = G.id(i, se);
        s.h[a] = s.h[b]; s.hv[a] = s.hv[b];
        s.hu[a] = (bc[0] == WALL) ? -s.hu[b] : s.hu[b];
        s.h[c] = s.h[d]; s.hv[c] = s.hv[d];
        s.hu[c] = (bc[1] == WALL) ? -s.hu[d] : s.hu[d];
      }
    }
    // rows (north / south), including corners
    for (int j = -NG; j < G.nx + NG; j++) {
      for (int k = 1; k <= NG; k++) {
        int in = -k, is = G.ny - 1 + k;
        int sn = (bc[2] == WALL) ? (k - 1) : 0;
        int ss = (bc[3] == WALL) ? (G.ny - k) : (G.ny - 1);
        int a = G.id(in, j), b = G.id(sn, j), c = G.id(is, j), d = G.id(ss, j);
        s.h[a] = s.h[b]; s.hu[a] = s.hu[b];
        s.hv[a] = (bc[2] == WALL) ? -s.hv[b] : s.hv[b];
        s.h[c] = s.h[d]; s.hu[c] = s.hu[d];
        s.hv[c] = (bc[3] == WALL) ? -s.hv[d] : s.hv[d];
      }
    }
  }

  void fill_bed_ghosts() {
    for (int i = 0; i < G.ny; i++) for (int k = 1; k <= NG; k++) {
      int sw = (bc[0] == WALL) ? (k - 1) : 0;
      int se = (bc[1] == WALL) ? (G.nx - k) : (G.nx - 1);
      z[G.id(i, -k)] = z[G.id(i, sw)];  nman[G.id(i, -k)] = nman[G.id(i, sw)];
      z[G.id(i, G.nx - 1 + k)] = z[G.id(i, se)]; nman[G.id(i, G.nx - 1 + k)] = nman[G.id(i, se)];
    }
    for (int j = -NG; j < G.nx + NG; j++) for (int k = 1; k <= NG; k++) {
      int sn = (bc[2] == WALL) ? (k - 1) : 0;
      int ss = (bc[3] == WALL) ? (G.ny - k) : (G.ny - 1);
      z[G.id(-k, j)] = z[G.id(sn, j)]; nman[G.id(-k, j)] = nman[G.id(sn, j)];
      z[G.id(G.ny - 1 + k, j)] = z[G.id(ss, j)]; nman[G.id(G.ny - 1 + k, j)] = nman[G.id(ss, j)];
    }
  }

  // Face states of cell c along a line with neighbours cm (minus) and cp (plus).
  // un is the normal momentum array, ut the tangential one.
  // Returns minus-face (m) and plus-face (p) values of h, un, ut, z.
  inline void faces(const State& s, const std::vector<double>& qn, const std::vector<double>& qt,
                    int cm, int c, int cp,
                    double& hm, double& unm, double& utm, double& zm,
                    double& hp, double& unp, double& utp, double& zp) const {
    double h = s.h[c];
    double un = vel(h, qn[c]), ut = vel(h, qt[c]);
    if (order == 1) {
      hm = hp = h; unm = unp = un; utm = utp = ut; zm = zp = z[c];
      return;
    }
    double hM = s.h[cm], hP = s.h[cp];
    double eta = h + z[c], etaM = hM + z[cm], etaP = hP + z[cp];
    double sh = minmod(h - hM, hP - h);
    double se = minmod(eta - etaM, etaP - eta);
    double su = minmod(un - vel(hM, qn[cm]), vel(hP, qn[cp]) - un);
    double sv = minmod(ut - vel(hM, qt[cm]), vel(hP, qt[cp]) - ut);
    hm = h - 0.5 * sh; hp = h + 0.5 * sh;
    // keep the reconstructed velocity consistent with the cell momentum
    // (FullSWOF style weighting); falls back to plain slopes when dry
    if (h > hdry) {
      unm = un - 0.5 * (hp / h) * su; unp = un + 0.5 * (hm / h) * su;
      utm = ut - 0.5 * (hp / h) * sv; utp = ut + 0.5 * (hm / h) * sv;
    } else {
      unm = unp = un; utm = utp = ut;
    }
    zm = (eta - 0.5 * se) - hm;
    zp = (eta + 0.5 * se) - hp;
  }

  // Right-hand side L(U) for interior cells. Returns max wave speed / spacing.
  double rhs(State& s, State& r) {
    fill_ghosts(s);
    std::fill(r.h.begin(), r.h.end(), 0.0);
    std::fill(r.hu.begin(), r.hu.end(), 0.0);
    std::fill(r.hv.begin(), r.hv.end(), 0.0);
    const double g = G.g;
    double out = 0.0;
    // x sweep: interfaces between (i, j) and (i, j + 1), j = -1 .. nx - 1
    // rows are independent, so they can run in parallel
    #pragma omp parallel for reduction(+:out) schedule(static)
    for (int i = 0; i < G.ny; i++) {
      double f[3];
      double hmL, uL, vL, zmL, hpL, upL, vpL, zpL;   // cell j faces
      double hmR, umR, vmR, zmR, hpR, uR, vR, zpR;   // cell j + 1 faces
      faces(s, s.hu, s.hv, G.id(i, -2), G.id(i, -1), G.id(i, 0),
            hmL, uL, vL, zmL, hpL, upL, vpL, zpL);
      for (int j = -1; j < G.nx; j++) {
        faces(s, s.hu, s.hv, G.id(i, j), G.id(i, j + 1), G.id(i, j + 2),
              hmR, umR, vmR, zmR, hpR, uR, vR, zpR);
        // interface: left = plus face of cell j, right = minus face of cell j + 1
        double zs = std::max(zpL, zmR);
        double hl = std::max(0.0, hpL + zpL - zs);
        double hr = std::max(0.0, hmR + zmR - zs);
        hll(hl, upL, vpL, hr, umR, vmR, g, f);
        double corrL = 0.5 * g * (hpL * hpL - hl * hl);
        double corrR = 0.5 * g * (hmR * hmR - hr * hr);
        if (j >= 0) {
          int c = G.id(i, j);
          r.h[c] -= f[0] / G.dx; r.hu[c] -= (f[1] + corrL) / G.dx; r.hv[c] -= f[2] / G.dx;
        } else {
          out -= f[0] * G.dy;  // inflow through west edge counts as negative outflow
        }
        if (j + 1 < G.nx) {
          int c = G.id(i, j + 1);
          r.h[c] += f[0] / G.dx; r.hu[c] += (f[1] + corrR) / G.dx; r.hv[c] += f[2] / G.dx;
          // centred source (zero for order 1)
          r.hu[c] += -g * 0.5 * (hmR + hpR) * (zpR - zmR) / G.dx;
        } else {
          out += f[0] * G.dy;
        }
        hmL = hmR; uL = umR; vL = vmR; zmL = zmR; hpL = hpR; upL = uR; vpL = vR; zpL = zpR;
      }
    }
    // y sweep: interfaces between (i, j) and (i + 1, j); normal momentum is hv
    #pragma omp parallel for reduction(+:out) schedule(static)
    for (int j = 0; j < G.nx; j++) {
      double f[3];
      double hmL, vL, uL, zmL, hpL, vpL, upL, zpL;
      double hmR, vmR, umR, zmR, hpR, vR, uR, zpR;
      faces(s, s.hv, s.hu, G.id(-2, j), G.id(-1, j), G.id(0, j),
            hmL, vL, uL, zmL, hpL, vpL, upL, zpL);
      for (int i = -1; i < G.ny; i++) {
        faces(s, s.hv, s.hu, G.id(i, j), G.id(i + 1, j), G.id(i + 2, j),
              hmR, vmR, umR, zmR, hpR, vR, uR, zpR);
        double zs = std::max(zpL, zmR);
        double hl = std::max(0.0, hpL + zpL - zs);
        double hr = std::max(0.0, hmR + zmR - zs);
        hll(hl, vpL, upL, hr, vmR, umR, g, f);   // f = (mass, normal mom, tangential mom)
        double corrL = 0.5 * g * (hpL * hpL - hl * hl);
        double corrR = 0.5 * g * (hmR * hmR - hr * hr);
        if (i >= 0) {
          int c = G.id(i, j);
          r.h[c] -= f[0] / G.dy; r.hv[c] -= (f[1] + corrL) / G.dy; r.hu[c] -= f[2] / G.dy;
        } else {
          out -= f[0] * G.dx;
        }
        if (i + 1 < G.ny) {
          int c = G.id(i + 1, j);
          r.h[c] += f[0] / G.dy; r.hv[c] += (f[1] + corrR) / G.dy; r.hu[c] += f[2] / G.dy;
          r.hv[c] += -g * 0.5 * (hmR + hpR) * (zpR - zmR) / G.dy;
        } else {
          out += f[0] * G.dx;
        }
        hmL = hmR; vL = vmR; uL = umR; zmL = zmR; hpL = hpR; vpL = vR; upL = uR; zpL = zpR;
      }
    }
    outflow_rate = out;
    return 0.0;
  }

  // Bed slope term per cell: g * max one-sided bed slope in x and y,
  // divided by the spacing. A thin film on a steep bed accelerates at
  // about g * slope, which the wave speed alone does not see.
  std::vector<double> acc;
  void bed_accel() {
    acc.assign(G.size(), 0.0);
    for (int i = 0; i < G.ny; i++) for (int j = 0; j < G.nx; j++) {
      int c = G.id(i, j);
      double sx = std::max(std::fabs(z[G.id(i, j + 1)] - z[c]), std::fabs(z[c] - z[G.id(i, j - 1)])) / G.dx;
      double sy = std::max(std::fabs(z[G.id(i + 1, j)] - z[c]), std::fabs(z[c] - z[G.id(i - 1, j)])) / G.dy;
      acc[c] = G.g * (sx / G.dx + sy / G.dy);
    }
  }

  // Largest stable step: dt * (B + A dt) <= cfl per wet cell, where B is
  // the usual (|u| + c) / dx sum and A the bed acceleration term.
  double stable_dt(const State& s, double cfl, double dt_cap) const {
    double dt = dt_cap;
    for (int i = 0; i < G.ny; i++) for (int j = 0; j < G.nx; j++) {
      int c = G.id(i, j);
      double h = s.h[c];
      if (h <= 0.0) continue;
      double cw = std::sqrt(G.g * h);
      double B = (std::fabs(vel(h, s.hu[c])) + cw) / G.dx + (std::fabs(vel(h, s.hv[c])) + cw) / G.dy;
      double A = acc[c];
      double d = (A > 0.0) ? 2.0 * cfl / (B + std::sqrt(B * B + 4.0 * A * cfl)) : cfl / B;
      if (d < dt) dt = d;
    }
    return dt;
  }

  // mass added by clipping negative depths (m of depth summed over cells);
  // should stay at round-off level, reported so a user can check
  double clipped;
  void clean(State& s) {
    for (int i = 0; i < G.ny; i++) for (int j = 0; j < G.nx; j++) {
      int c = G.id(i, j);
      if (s.h[c] < 0.0) { clipped -= s.h[c]; s.h[c] = 0.0; }
      if (s.h[c] < 1e-12) { s.hu[c] = 0.0; s.hv[c] = 0.0; }
      else if (s.h[c] < hdry) {
        // keep momentum consistent with the desingularised velocity
        s.hu[c] = s.h[c] * vel(s.h[c], s.hu[c]);
        s.hv[c] = s.h[c] * vel(s.h[c], s.hv[c]);
      }
    }
  }

  // semi-implicit Manning friction
  void friction(State& s, double dt) const {
    for (int i = 0; i < G.ny; i++) for (int j = 0; j < G.nx; j++) {
      int c = G.id(i, j);
      double n = nman[c], h = s.h[c];
      if (n <= 0.0 || h <= 1e-12) continue;
      double u = vel(h, s.hu[c]), v = vel(h, s.hv[c]);
      double sp = std::sqrt(u * u + v * v);
      double fac = 1.0 + dt * G.g * n * n * sp / std::pow(h, 4.0 / 3.0);
      s.hu[c] /= fac; s.hv[c] /= fac;
    }
  }
};

NumericMatrix to_matrix(const Grid& G, const std::vector<double>& a) {
  NumericMatrix m(G.ny, G.nx);
  for (int j = 0; j < G.nx; j++) for (int i = 0; i < G.ny; i++) m(i, j) = a[G.id(i, j)];
  return m;
}

void from_matrix(const Grid& G, const NumericMatrix& m, std::vector<double>& a) {
  for (int j = 0; j < G.nx; j++) for (int i = 0; i < G.ny; i++) a[G.id(i, j)] = m(i, j);
}

double volume(const Grid& G, const State& s) {
  double v = 0.0;
  for (int j = 0; j < G.nx; j++) for (int i = 0; i < G.ny; i++) v += s.h[G.id(i, j)];
  return v * G.dx * G.dy;
}

}  // namespace

// [[Rcpp::export]]
List swe_run_cpp(NumericMatrix h, NumericMatrix hu, NumericMatrix hv, NumericMatrix z,
                 NumericMatrix manning, NumericMatrix rain,
                 double dx, double dy, double g,
                 NumericVector times, double cfl, int order,
                 IntegerVector bc, double hdry, int max_steps, double dt_max) {
  int ny = h.nrow(), nx = h.ncol();
  Grid G(nx, ny, dx, dy, g);
  Solver S(G);
  S.order = order; S.hdry = hdry;
  for (int k = 0; k < 4; k++) S.bc[k] = bc[k];
  from_matrix(G, z, S.z);
  from_matrix(G, manning, S.nman);
  S.fill_bed_ghosts();
  S.bed_accel();
  std::vector<double> rainv(G.size(), 0.0);
  from_matrix(G, rain, rainv);

  State U(G.size()), R1(G.size()), R2(G.size()), U1(G.size());
  from_matrix(G, h, U.h); from_matrix(G, hu, U.hu); from_matrix(G, hv, U.hv);
  S.clean(U);

  int nt = times.size();
  List H(nt), HU(nt), HV(nt);
  NumericVector vol(nt), outcum(nt), raincum(nt), dtmin(nt), dtmax(nt), clip(nt);
  IntegerVector nsteps(nt);
  double rain_rate_vol = 0.0;
  for (int i = 0; i < ny; i++) for (int j = 0; j < nx; j++) rain_rate_vol += rainv[G.id(i, j)];
  rain_rate_vol *= dx * dy;

  double t = 0.0, out_total = 0.0, rain_total = 0.0;
  int steps = 0;
  double dmin = R_PosInf, dmax = 0.0;
  for (int k = 0; k < nt; k++) {
    double target = times[k];
    while (t < target - 1e-12) {
      if (steps >= max_steps) stop("max_steps reached at t = %f", t);
      double dt = S.stable_dt(U, cfl, dt_max);
      // dt_min / dt_max report the stability limit, not the short steps
      // taken to land exactly on an output time
      dmin = std::min(dmin, dt); dmax = std::max(dmax, dt);
      if (t + dt > target) dt = target - t;
      S.rhs(U, R1);
      double out1 = S.outflow_rate;
      if (order == 1) {
        for (size_t c = 0; c < U.h.size(); c++) {
          U.h[c] += dt * R1.h[c]; U.hu[c] += dt * R1.hu[c]; U.hv[c] += dt * R1.hv[c];
        }
        out_total += dt * out1;
      } else {
        for (size_t c = 0; c < U.h.size(); c++) {
          U1.h[c] = U.h[c] + dt * R1.h[c];
          U1.hu[c] = U.hu[c] + dt * R1.hu[c];
          U1.hv[c] = U.hv[c] + dt * R1.hv[c];
        }
        S.clean(U1);
        S.rhs(U1, R2);
        double out2 = S.outflow_rate;
        for (size_t c = 0; c < U.h.size(); c++) {
          U.h[c] = 0.5 * (U.h[c] + U1.h[c] + dt * R2.h[c]);
          U.hu[c] = 0.5 * (U.hu[c] + U1.hu[c] + dt * R2.hu[c]);
          U.hv[c] = 0.5 * (U.hv[c] + U1.hv[c] + dt * R2.hv[c]);
        }
        out_total += 0.5 * dt * (out1 + out2);
      }
      if (rain_rate_vol > 0.0) {
        for (size_t c = 0; c < U.h.size(); c++) U.h[c] += dt * rainv[c];
        rain_total += dt * rain_rate_vol;
      }
      S.friction(U, dt);
      S.clean(U);
      t += dt;
      steps++;
      if (steps % 1000 == 0) checkUserInterrupt();
    }
    H[k] = to_matrix(G, U.h); HU[k] = to_matrix(G, U.hu); HV[k] = to_matrix(G, U.hv);
    vol[k] = volume(G, U); outcum[k] = out_total; raincum[k] = rain_total;
    nsteps[k] = steps; dtmin[k] = dmin; dtmax[k] = dmax; clip[k] = S.clipped * dx * dy;
  }
  return List::create(_["h"] = H, _["hu"] = HU, _["hv"] = HV,
                      _["diag"] = DataFrame::create(_["time"] = times, _["volume"] = vol,
                                                    _["outflow"] = outcum, _["rain"] = raincum,
                                                    _["steps"] = nsteps, _["dt_min"] = dtmin,
                                                    _["dt_max"] = dtmax, _["clipped"] = clip));
}
