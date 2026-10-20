// Orthorectification. An image from a camera or a pushbroom scanner over
// terrain is a central (or line-central) projection: every pixel is a ray
// from the sensor, and where that ray meets the ground depends on how high
// the ground is. Relief displacement is that dependence: a point h above
// the surface a picture is rectified onto lands h tan(theta) away from its
// true place, theta being the ray's angle from the vertical, and always
// away from the nadir.
//
// Orthorectification undoes it with a sensor model and a DEM: for each
// cell of the output map, take the ground height there, run the point
// (x, y, z) forward through the sensor model to an image position, and
// read the image there. No ray is traced on the way back; the DEM supplies
// the z the ray could not. Ground the sensor could not see (behind a ridge,
// the far side of a spire) has no pixel of its own: an ordinary
// orthorectification fills it from whatever was in front (the double image
// of the slope), a true ortho tests each cell against the DEM and masks it.
//
// Everything is in a local frame, in metres: x east, y north, z up, the
// study area a square of side SIZE centred on the origin. A synthetic
// terrain stands in for a DEM (a grid read bilinear, tapered to zero
// beyond the area). Two sensor models share one interface:
//
//   project(P) -> [u, v, depth] or null   ground to image (pixels, the
//                                          collinearity equations)
//   ray(u, v)  -> { o, d }                 image to a ray in space
//   centre(P)  -> [x, y, z]               the perspective centre P was
//                                          seen from
//
// frameCamera is a pinhole (an aerial frame camera); pushbroomCamera is a
// line scanner moving along a straight track, one image row per position,
// as most satellites are.

export const SIZE = 10000;        // the study area, metres on a side
const EXTENT = 7000;              // the DEM grid covers -EXTENT..EXTENT
const STEP = 50;                  // and has a node every STEP metres
const NODES = (2 * EXTENT) / STEP + 1;
const D2R = Math.PI / 180;

// ---------------------------------------------------------------- terrain

const gauss = (x, y, cx, cy, s, h) => h * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s));
const smoothstep = (a, b, t) => { const s = Math.max(0, Math.min(1, (t - a) / (b - a))); return s * s * (3 - 2 * s); };

export const TERRAINS = {
  hills: {
    label: "Hills",
    z: (x, y) => gauss(x, y, -2200, 1500, 1300, 850) + gauss(x, y, 1800, 2200, 1000, 600) + gauss(x, y, 1200, -1800, 1500, 1000) +
      gauss(x, y, -1800, -2400, 800, 450) + gauss(x, y, 300, 400, 600, 380) + gauss(x, y, 3600, -300, 900, 520)
  },
  ridge: {
    label: "Ridge and valley",
    z: (x, y) => {
      // a ridge running SW to NE, with a valley cut beside it
      const s = (x + y) / Math.SQRT2, n = (y - x) / Math.SQRT2;
      const crest = 900 + 250 * Math.sin(s / 900);
      return crest * Math.exp(-((n + 600) ** 2) / (2 * 700 ** 2)) + 260 * Math.exp(-((n - 2600) ** 2) / (2 * 1200 ** 2));
    }
  },
  spires: {
    label: "Escarpment and spires",
    z: (x, y) => {
      // a plateau ending in a steep scarp, and three narrow towers on the plain
      const scarp = 700 / (1 + Math.exp(-(y - 1200) / 120));
      return scarp + gauss(x, y, -2000, -1500, 180, 900) + gauss(x, y, 1500, -2600, 220, 1100) + gauss(x, y, 2600, -400, 160, 750);
    }
  },
  flat: { label: "Flat", z: () => 0 }
};

// A terrain as a DEM: its grid of heights (scaled by relief), a bilinear
// height(x, y) that is 0 beyond the grid, and its range over the area.
export function makeTerrain(kind = "hills", relief = 1) {
  const t = TERRAINS[kind] || TERRAINS.hills;
  const z = new Float32Array(NODES * NODES);
  for (let j = 0; j < NODES; j++) {
    const y = EXTENT - j * STEP;
    for (let i = 0; i < NODES; i++) {
      const x = -EXTENT + i * STEP;
      const w = 1 - smoothstep(SIZE / 2 + 500, EXTENT - 200, Math.max(Math.abs(x), Math.abs(y)));
      z[j * NODES + i] = relief * t.z(x, y) * w;
    }
  }
  return demFromGrid(z, kind);
}

function demFromGrid(z, kind) {
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  for (let j = 0; j < NODES; j++) {
    const y = EXTENT - j * STEP;
    if (Math.abs(y) > SIZE / 2) continue;
    for (let i = 0; i < NODES; i++) {
      const x = -EXTENT + i * STEP;
      if (Math.abs(x) > SIZE / 2) continue;
      const v = z[j * NODES + i];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v; n++;
    }
  }
  let top = -Infinity;
  for (const v of z) if (v > top) top = v;
  const height = (x, y) => {
    const fi = (x + EXTENT) / STEP, fj = (EXTENT - y) / STEP;
    if (!(fi >= 0 && fj >= 0 && fi < NODES - 1 && fj < NODES - 1)) return 0;
    const i = fi | 0, j = fj | 0, a = fi - i, b = fj - j, k = j * NODES + i;
    return (z[k] * (1 - a) + z[k + 1] * a) * (1 - b) + (z[k + NODES] * (1 - a) + z[k + NODES + 1] * a) * b;
  };
  return { kind, z, nodes: NODES, step: STEP, extent: EXTENT, height, min, max, mean: sum / n, top: Math.max(top, 0) };
}

// The same DEM with a box blur of about radius metres, applied twice: the
// coarse DEM a rectification might have to make do with.
export function smoothed(dem, radius = 500) {
  const r = Math.max(1, Math.round(radius / dem.step)), n = dem.nodes;
  let a = Float32Array.from(dem.z), b = new Float32Array(a.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let s = 0, c = 0;
        for (let d = -r; d <= r; d++) { const ii = i + d; if (ii >= 0 && ii < n) { s += a[j * n + ii]; c++; } }
        b[j * n + i] = s / c;
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let s = 0, c = 0;
        for (let d = -r; d <= r; d++) { const jj = j + d; if (jj >= 0 && jj < n) { s += b[jj * n + i]; c++; } }
        a[j * n + i] = s / c;
      }
    }
  }
  return demFromGrid(a, dem.kind + "-smooth");
}

// The height function a rectification uses: "true" (the DEM itself),
// "smooth" (blurred), "mean" (a flat plane at the area's mean height) or
// "flat" (the datum, z = 0: no DEM at all).
export function rectSurface(dem, which) {
  if (which === "true") return dem.height;
  if (which === "smooth") return smoothed(dem).height;
  if (which === "mean") { const m = dem.mean; return () => m; }
  return () => 0;
}

// ---------------------------------------------------------------- vectors

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
const add = (a, b, s = 1) => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];

// ---------------------------------------------------------------- sensors

// A frame camera (pinhole) alt metres above the datum, its optical axis
// tilt degrees from the vertical towards azimuth az (clockwise from north),
// aimed at the centre of the area, with a square image of n pixels across
// fov degrees. Image x runs right, image y down; at zero tilt north is up.
//
// The collinearity equations are project(): with the perspective centre C
// and the camera axes r (right), dn (down), f (forward),
//   u = cx + c (P - C).r / (P - C).f,   v = cy + c (P - C).dn / (P - C).f
// where c = (n / 2) / tan(fov / 2) is the principal distance in pixels.
export function frameCamera({ alt = 6000, tilt = 0, az = 0, fov = 60, n = 256 } = {}) {
  const t = tilt * D2R, a = az * D2R;
  const f = [Math.sin(t) * Math.sin(a), Math.sin(t) * Math.cos(a), -Math.cos(t)];
  const r = norm(cross(f, [0, 1, 0]));
  const dn = cross(f, r);
  const C = add([0, 0, 0], f, -alt / Math.cos(t));
  const c = (n / 2) / Math.tan((fov * D2R) / 2), cx = n / 2, cy = n / 2;
  return {
    kind: "frame", n, alt, tilt, az, fov, c, C, f, r, dn,
    nadir: [C[0], C[1], 0],
    centre: () => C,
    project(P) {
      const w = sub(P, C), z = dot(w, f);
      if (z <= 0) return null;
      return [cx + (c * dot(w, r)) / z, cy + (c * dot(w, dn)) / z, z];
    },
    ray(u, v) {
      return { o: C, d: norm(add(add(f, r, (u - cx) / c), dn, (v - cy) / c)) };
    }
  };
}

// A pushbroom scanner flying a straight, level track alt metres up on
// heading az (clockwise from north), its line of n detectors looking
// across the track, tilted roll degrees to the right of the vertical,
// spanning fov degrees. Each image row is one position along the track:
// n rows cover the area's length, the first row at the far end (so at
// heading 0, north is up). The attitude is fixed, so the scan plane is
// always normal to the track and the row a point falls in is just its
// distance along the track: relief moves points across the track only.
export function pushbroomCamera({ alt = 6000, tilt = 0, az = 0, fov = 60, n = 256 } = {}) {
  const t = tilt * D2R, a = az * D2R;
  const T = [Math.sin(a), Math.cos(a), 0];      // along track
  const A = cross(T, [0, 0, 1]);                 // across, to the right
  const f = add([0, 0, -Math.cos(t)], A, Math.sin(t));
  const r = add([0, 0, Math.sin(t)], A, Math.cos(t));
  const dn = cross(f, r);
  const C0 = add([0, 0, 0], f, -alt / Math.cos(t));
  const c = (n / 2) / Math.tan((fov * D2R) / 2), cx = n / 2;
  const dt = SIZE / n, top = SIZE / 2;
  const at = (s) => add(C0, T, s);
  return {
    kind: "push", n, alt, tilt, az, fov, c, C: C0, f, r, dn, T, dt,
    nadir: [C0[0], C0[1], 0],
    at,
    row: (P) => (top - dot(sub(P, C0), T)) / dt,
    centre(P) { return at(dot(sub(P, C0), T)); },
    project(P) {
      const s = dot(sub(P, C0), T), w = sub(P, at(s)), z = dot(w, f);
      if (z <= 0) return null;
      return [cx + (c * dot(w, r)) / z, (top - s) / dt, z];
    },
    ray(u, v) {
      return { o: at(top - v * dt), d: norm(add(f, r, (u - cx) / c)) };
    }
  };
}

export function makeSensor(kind, opts) {
  return kind === "push" ? pushbroomCamera(opts) : frameCamera(opts);
}

// ---------------------------------------------------------------- rays

// Where the ray o + s d first meets the ground z = height(x, y), or null if
// it misses (or runs away from the ground). Marched in steps of step
// metres from where it comes down to the highest ground (top), then
// bisected.
export function intersect(height, top, o, d, step = 25) {
  if (d[2] >= 0) return null;
  let s = o[2] > top ? (o[2] - top - 1) / -d[2] : 0;
  const far = (o[2] + 1) / -d[2] + 1;
  const above = (q) => o[2] + q * d[2] - height(o[0] + q * d[0], o[1] + q * d[1]);
  if (above(s) < 0) return null;
  let prev = s;
  while (s < far) {
    s += step;
    if (above(s) <= 0) {
      let lo = prev, hi = s;
      for (let k = 0; k < 24; k++) { const m = (lo + hi) / 2; if (above(m) > 0) lo = m; else hi = m; }
      const q = (lo + hi) / 2;
      return [o[0] + q * d[0], o[1] + q * d[1], o[2] + q * d[2]];
    }
    prev = s;
  }
  return null;
}

// Where the ray meets the level plane z = z0, or null.
export function onPlane(o, d, z0 = 0) {
  if (d[2] >= 0 || o[2] <= z0) return null;
  const q = (o[2] - z0) / -d[2];
  return [o[0] + q * d[0], o[1] + q * d[1], z0];
}

// Can the sensor see P? Marches from P towards its perspective centre and
// says false if the ground gets in the way first.
export function visible(dem, sensor, P, step = 25) {
  const C = sensor.centre(P), d = sub(C, P), L = Math.hypot(d[0], d[1], d[2]);
  const u = [d[0] / L, d[1] / L, d[2] / L];
  const top = dem.top;
  for (let s = step; s < L; s += step) {
    const z = P[2] + s * u[2];
    if (z > top) return true;
    if (z < dem.height(P[0] + s * u[0], P[1] + s * u[1]) - 0.5) return false;
  }
  return true;
}

// Relief displacement of the ground point P = (x, y, h) for a picture
// rectified onto the surface z = zr(x, y): the ray from P's perspective
// centre through P, carried on to that surface (Q), against where P really
// is. theta is the ray's angle from the vertical; for a level surface the
// shift is (h - zr) tan(theta), radially away from the nadir (frame) or
// straight across the track (pushbroom).
export function displacement(sensor, P, zr = () => 0) {
  const C = sensor.centre(P), d = norm(sub(P, C));
  const theta = Math.acos(-d[2]);
  // the ray meets z = zr(x, y): step the level plane guess to convergence
  let Q = P;
  for (let k = 0; k < 30; k++) {
    const z = zr(Q[0], Q[1]), q = onPlane(C, d, z);
    if (!q) return { theta, Q: null, shift: NaN };
    if (Math.hypot(q[0] - Q[0], q[1] - Q[1]) < 1e-6) { Q = q; break; }
    Q = q;
  }
  return { theta, Q, shift: Math.hypot(Q[0] - P[0], Q[1] - P[1]), dz: P[2] - Q[2] };
}

// ---------------------------------------------------------------- the map

// The ground's own colours, as the "truth" an image is taken of: a tint by
// height, hill shading, a kilometre grid, and roads (straight lines on the
// map, so any bend in an image of them is distortion).
export const ROADS = [
  [-5000, -3800, 5000, 3200],
  [-1500, -5000, -1500, 5000],
  [-5000, 2600, 5000, 2600],
  [5000, -4200, -2000, 5000]
];
const HYPS = [[0, 92, 132, 84], [300, 140, 168, 96], [700, 196, 176, 120], [1100, 168, 140, 112], [1500, 214, 210, 204], [2400, 250, 250, 250]];
function tint(z) {
  if (z <= HYPS[0][0]) return HYPS[0].slice(1);
  for (let i = 1; i < HYPS.length; i++) {
    if (z <= HYPS[i][0]) {
      const [z0, r0, g0, b0] = HYPS[i - 1], [z1, r1, g1, b1] = HYPS[i], t = (z - z0) / (z1 - z0);
      return [r0 + t * (r1 - r0), g0 + t * (g1 - g0), b0 + t * (b1 - b0)];
    }
  }
  return HYPS[HYPS.length - 1].slice(1);
}
function segDist(x, y, [x0, y0, x1, y1]) {
  const dx = x1 - x0, dy = y1 - y0, t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - x0 - t * dx, y - y0 - t * dy);
}

// [r, g, b] (0..255) of the ground at x, y.
export function groundColour(dem, x, y, out = [0, 0, 0]) {
  const h = dem.height, e = 30;
  const z = h(x, y);
  const gx = (h(x + e, y) - h(x - e, y)) / (2 * e), gy = (h(x, y + e) - h(x, y - e)) / (2 * e);
  // light from the north west, 45 degrees up
  const nl = Math.hypot(gx, gy, 1), L = [-0.5, 0.5, Math.SQRT1_2];
  const shade = Math.max(0, (-gx * L[0] - gy * L[1] + L[2]) / nl);
  let [r, g, b] = tint(z);
  const k = 0.35 + 0.85 * shade;
  r *= k; g *= k; b *= k;
  const inside = Math.abs(x) <= SIZE / 2 && Math.abs(y) <= SIZE / 2;
  if (!inside) { const m = (r + g + b) / 3; r = 0.5 * r + 0.3 * m; g = 0.5 * g + 0.3 * m; b = 0.5 * b + 0.3 * m; }
  const gxm = Math.abs(x - 1000 * Math.round(x / 1000)), gym = Math.abs(y - 1000 * Math.round(y / 1000));
  if (Math.min(gxm, gym) < 14) { r *= 0.45; g *= 0.45; b *= 0.5; }
  if (inside) {
    let dr = Infinity;
    for (const s of ROADS) dr = Math.min(dr, segDist(x, y, s));
    if (dr < 22) { r = 250; g = 206; b = 64; } else if (dr < 34) { r = 70; g = 50; b = 30; }
  }
  out[0] = r; out[1] = g; out[2] = b;
  return out;
}

// The truth: the ground seen straight down, n x n pixels over the area,
// RGBA. A perfect orthorectification reproduces this, apart from ground
// the sensor never saw.
export function renderTruth(dem, n = 256) {
  const px = new Uint8ClampedArray(n * n * 4), c = [0, 0, 0];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [x, y] = cellXY(i, j, n);
      groundColour(dem, x, y, c);
      const k = 4 * (j * n + i);
      px[k] = c[0]; px[k + 1] = c[1]; px[k + 2] = c[2]; px[k + 3] = 255;
    }
  }
  return px;
}

// Cell (i, j) of an n x n map of the area to its centre in metres, and back.
export const cellXY = (i, j, n) => [-SIZE / 2 + ((i + 0.5) * SIZE) / n, SIZE / 2 - ((j + 0.5) * SIZE) / n];
export const xyCell = (x, y, n) => [((x + SIZE / 2) * n) / SIZE - 0.5, ((SIZE / 2 - y) * n) / SIZE - 0.5];

// ---------------------------------------------------------------- images

// The raw image the sensor records: each pixel's ray traced to the ground
// and the ground's colour there. RGBA, n x n; sky (a miss) is transparent.
export function renderRaw(dem, sensor) {
  const n = sensor.n, px = new Uint8ClampedArray(n * n * 4), c = [0, 0, 0];
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      const { o, d } = sensor.ray(u + 0.5, v + 0.5);
      const P = intersect(dem.height, dem.top, o, d);
      if (!P) continue;
      groundColour(dem, P[0], P[1], c);
      const k = 4 * (v * n + u);
      px[k] = c[0]; px[k + 1] = c[1]; px[k + 2] = c[2]; px[k + 3] = 255;
    }
  }
  return px;
}

// Bilinear read of an RGBA image (n x n) at pixel position u, v (pixel
// centres at k + 0.5), into out; false if outside or on no data.
export function sample(img, n, u, v, out) {
  const x = u - 0.5, y = v - 0.5;
  if (!(x >= 0 && y >= 0 && x <= n - 1 && y <= n - 1)) return false;
  const i = Math.min(n - 2, x | 0), j = Math.min(n - 2, y | 0), a = x - i, b = y - j;
  const k00 = 4 * (j * n + i), k10 = k00 + 4, k01 = k00 + 4 * n, k11 = k01 + 4;
  if (!(img[k00 + 3] && img[k10 + 3] && img[k01 + 3] && img[k11 + 3])) return false;
  for (let c = 0; c < 3; c++) {
    out[c] = (img[k00 + c] * (1 - a) + img[k10 + c] * a) * (1 - b) + (img[k01 + c] * (1 - a) + img[k11 + c] * a) * b;
  }
  return true;
}

// Orthorectify: for each cell of an n x n map of the area, z from the
// surface zr(x, y), (x, y, z) through the sensor model to the image, read
// there. With occlusion (the true DEM, for a true ortho) cells in the image
// that the sensor could not see are flagged and left out. Returns { px, hidden }, hidden
// a Uint8Array of the flagged cells.
export function orthorectify(raw, sensor, zr, n = 256, { occlusion = null } = {}) {
  const px = new Uint8ClampedArray(n * n * 4), hidden = new Uint8Array(n * n), c = [0, 0, 0];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [x, y] = cellXY(i, j, n), P = [x, y, zr(x, y)];
      const k = j * n + i;
      const uv = sensor.project(P);
      if (!uv || !sample(raw, sensor.n, uv[0], uv[1], c)) continue;
      if (occlusion && !visible(occlusion, sensor, P)) { hidden[k] = 1; continue; }
      px[4 * k] = c[0]; px[4 * k + 1] = c[1]; px[4 * k + 2] = c[2]; px[4 * k + 3] = 255;
    }
  }
  return { px, hidden };
}

// Where each cell of an n x n map lands in the image, and where the image
// pixel it lands on puts it back on the ground if rectified onto zr: the
// displacement field, as [x, y, qx, qy] per cell (qx NaN where it misses).
export function displacementField(dem, sensor, zr, n = 12) {
  const out = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [x, y] = cellXY(i, j, n), P = [x, y, dem.height(x, y)];
      const { Q } = displacement(sensor, P, zr);
      out.push([x, y, Q ? Q[0] : NaN, Q ? Q[1] : NaN]);
    }
  }
  return out;
}

// The footprint: where the image border meets the ground, as a closed
// polyline of [x, y, z] (m points a side; misses dropped).
export function footprint(dem, sensor, m = 24) {
  const n = sensor.n, pts = [], edge = [];
  for (let k = 0; k < m; k++) edge.push([(k / m) * n, 0]);
  for (let k = 0; k < m; k++) edge.push([n, (k / m) * n]);
  for (let k = 0; k < m; k++) edge.push([n - (k / m) * n, n]);
  for (let k = 0; k < m; k++) edge.push([0, n - (k / m) * n]);
  for (const [u, v] of edge) {
    const { o, d } = sensor.ray(u, v);
    const P = intersect(dem.height, dem.top, o, d);
    if (P) pts.push(P);
  }
  return pts;
}
