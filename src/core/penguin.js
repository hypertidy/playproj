// The penguin datum. A reference surface for lon/lat that is not an
// ellipsoid but a closed body of any shape: here a king penguin, built as
// a smooth union of ellipsoids (an implicit surface F(p) = 0, negative
// inside), scaled to the volume of the earth.
//
// The rule that turns a shape into a lon/lat surface is the one planetary
// science uses for irregular bodies (IAU planetocentric coordinates): a
// direction from the body's centre of mass is a longitude and latitude,
// and the surface in that direction is where the ray from the centre
// leaves the body. That gives one radius per direction only when the body
// is star-shaped from its centre: every ray crosses the surface once. A
// penguin is not. Rays leave the chin and enter the beak, leave the body
// and enter a flipper or a foot, so some directions meet the surface two,
// three or four times, and the parts of the surface between (the underside
// of the beak, the inside of a flipper, the tops of the feet) are on no
// ray's last exit: no lon/lat reaches them. The "decree surface" takes the
// last exit, so a raster of radius in penguin lon/lat is well defined but
// shrink-wraps the penguin, with radial cliffs where the radius jumps.
//
// Body frame: x forward (the belly), y to the penguin's left, z up (the
// crown of the head). Penguin longitude is atan2(y, x), latitude asin(z),
// from the centre of mass. Model units are about a penguin height of 2;
// scale() takes them to metres.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// Mawson Peak, Heard Island: the decree puts it at penguin lon 0, lat 0
export const HEARD = { lon: 73.513, lat: -53.106 };
// the radius of the sphere with the WGS84 ellipsoid's volume (m)
export const R_EARTH = 6371000.79;
export const WGS84 = { a: 6378137, f: 1 / 298.257223563 };

export const DEFAULTS = { beak: 1, flip: 0.35, feet: 1 };
// the smooth union's blend width (model units)
const K = 0.07;

// ------------------------------------------------------------------ small vectors

const unit = (lon, lat) => {
  const l = lon * D2R, p = lat * D2R;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
};
const toLonLat = (v) => [Math.atan2(v[1], v[0]) * R2D, Math.atan2(v[2], Math.hypot(v[0], v[1])) * R2D];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const dirOf = unit;
export const lonLatOf = toLonLat;

// a rotation about y by t (radians): local x tips down for t > 0
const rotY = (t) => [[Math.cos(t), 0, -Math.sin(t)], [0, 1, 0], [Math.sin(t), 0, Math.cos(t)]];

// ------------------------------------------------------------------ the bird

// The parts as ellipsoids: centre c, semi-axes r, and the local axes ax
// (three unit vectors in the body frame) where the part is turned.
// beak: length, 0 for none, 1 for a king penguin's. flip: flippers from
// 0 (pressed to the sides) to 1 (held out level). feet: 0 tucked under
// the body (and no tail), 1 a penguin's, stuck out in front.
export function parts({ beak = DEFAULTS.beak, flip = DEFAULTS.flip, feet = DEFAULTS.feet } = {}) {
  const P = [
    { id: "body", c: [0, 0, -0.15], r: [0.5, 0.46, 0.8] },
    { id: "belly", c: [0.07, 0, -0.32], r: [0.46, 0.43, 0.58] },
    { id: "neck", c: [0.035, 0, 0.5], r: [0.33, 0.31, 0.26] },
    { id: "head", c: [0.05, 0, 0.78], r: [0.29, 0.27, 0.29] }
  ];
  // the tail comes with the feet: a stub tucked in, a wedge sticking out
  if (feet > 0) P.push({ id: "tail", c: [-0.38 - 0.04 * feet, 0, -0.84], r: [0.06 + 0.08 * feet, 0.1, 0.045], ax: rotY(-25 * D2R) });
  if (beak > 0) {
    const L = 0.2 * beak;
    P.push({ id: "beak", c: [0.28 + 0.92 * L, 0, 0.75 - 0.18 * L], r: [L, 0.045, 0.04], ax: rotY(10 * D2R) });
  }
  // flippers hang from the shoulders and swing out about the body's x axis
  const a = (4 + 76 * flip) * D2R, half = 0.4;
  for (const s of [1, -1]) {
    const S = [0, s * 0.4, 0.36], d = [0, s * Math.sin(a), -Math.cos(a)], t = [0, s * Math.cos(a), Math.sin(a)];
    P.push({ id: "flipper", side: s, c: [S[0] + half * d[0], S[1] + half * d[1], S[2] + half * d[2]], r: [0.13, 0.035, half], ax: [[1, 0, 0], t, d] });
  }
  for (const s of [1, -1]) {
    P.push({ id: "foot", side: s, c: [0.04 + 0.2 * feet, s * 0.17, -0.92], r: [0.11 + 0.09 * feet, 0.09, 0.045] });
  }
  return P;
}

// The field of the union: F(x, y, z) < 0 inside, about the distance to
// the surface near it (a lower bound away from the blends), and which(x,
// y, z) the index of the nearest part. The ellipsoid distance is the
// conservative (|q / r| - 1) min(r).
export function makeField(prm = {}) {
  const P = parts(prm);
  const n = P.length;
  const C = new Float64Array(n * 3), IR = new Float64Array(n * 3), AX = new Float64Array(n * 9), RM = new Float64Array(n), HAS = new Uint8Array(n);
  P.forEach((p, i) => {
    C.set(p.c, 3 * i);
    IR.set(p.r.map((v) => 1 / v), 3 * i);
    RM[i] = Math.min(...p.r);
    if (p.ax) { HAS[i] = 1; AX.set([...p.ax[0], ...p.ax[1], ...p.ax[2]], 9 * i); }
  });
  function partD(i, x, y, z) {
    let dx = x - C[3 * i], dy = y - C[3 * i + 1], dz = z - C[3 * i + 2];
    if (HAS[i]) {
      const m = 9 * i;
      const qx = AX[m] * dx + AX[m + 1] * dy + AX[m + 2] * dz;
      const qy = AX[m + 3] * dx + AX[m + 4] * dy + AX[m + 5] * dz;
      const qz = AX[m + 6] * dx + AX[m + 7] * dy + AX[m + 8] * dz;
      dx = qx; dy = qy; dz = qz;
    }
    dx *= IR[3 * i]; dy *= IR[3 * i + 1]; dz *= IR[3 * i + 2];
    return (Math.sqrt(dx * dx + dy * dy + dz * dz) - 1) * RM[i];
  }
  function F(x, y, z) {
    let d = partD(0, x, y, z);
    for (let i = 1; i < n; i++) {
      const b = partD(i, x, y, z), h = Math.max(K - Math.abs(d - b), 0) / K;
      d = Math.min(d, b) - h * h * K * 0.25;
    }
    return d;
  }
  function which(x, y, z) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = partD(i, x, y, z); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  return { F, which, parts: P };
}

// The outward unit normal at p, from the field's gradient.
export function normalAt(F, x, y, z, e = 1e-4) {
  const g = [F(x + e, y, z) - F(x - e, y, z), F(x, y + e, z) - F(x, y - e, z), F(x, y, z + e) - F(x, y, z - e)];
  const m = Math.hypot(...g) || 1;
  return [g[0] / m, g[1] / m, g[2] / m];
}

// ------------------------------------------------------------------ sampling

// F on a cube of (n + 1)^3 nodes from lo to hi on each axis, with the
// volume inside and its centroid (the centre of mass at uniform density).
// The inside of each node is weighted smoothly over one spacing, so the
// volume converges as n grows.
export function sampleGrid(F, n = 96, lo = -1.5, hi = 1.5) {
  const m = n + 1, h = (hi - lo) / n, v = new Float32Array(m * m * m);
  let vol = 0, cx = 0, cy = 0, cz = 0;
  for (let k = 0, q = 0; k < m; k++) {
    const z = lo + k * h;
    for (let j = 0; j < m; j++) {
      const y = lo + j * h;
      for (let i = 0; i < m; i++, q++) {
        const x = lo + i * h, f = F(x, y, z);
        v[q] = f;
        const w = Math.max(0, Math.min(1, 0.5 - f / h));
        if (w) { vol += w; cx += w * x; cy += w * y; cz += w * z; }
      }
    }
  }
  return { n, lo, h, v, volume: vol * h * h * h, centroid: [cx / vol, cy / vol, cz / vol] };
}

// The surface as a mesh by surface nets: a vertex in each cell the
// surface passes through (the mean of its edge crossings), and a quad
// across each grid edge the surface cuts. Positions in model units.
export function surfaceNets(g) {
  const { n, lo, h, v } = g, m = n + 1;
  const node = (i, j, k) => (k * m + j) * m + i;
  const cellIdx = new Int32Array(n * n * n).fill(-1);
  const pos = [];
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const val = new Float64Array(8);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let inside = 0;
    for (let c = 0; c < 8; c++) {
      val[c] = v[node(i + corner[c][0], j + corner[c][1], k + corner[c][2])];
      if (val[c] < 0) inside++;
    }
    if (inside === 0 || inside === 8) continue;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const [a, b] of edges) {
      const fa = val[a], fb = val[b];
      if ((fa < 0) === (fb < 0)) continue;
      const t = fa / (fa - fb);
      sx += corner[a][0] + t * (corner[b][0] - corner[a][0]);
      sy += corner[a][1] + t * (corner[b][1] - corner[a][1]);
      sz += corner[a][2] + t * (corner[b][2] - corner[a][2]);
      cnt++;
    }
    cellIdx[(k * n + j) * n + i] = pos.length / 3;
    pos.push(lo + (i + sx / cnt) * h, lo + (j + sy / cnt) * h, lo + (k + sz / cnt) * h);
  }
  const idx = [];
  const cell = (ijk) => (ijk[0] < 0 || ijk[1] < 0 || ijk[2] < 0 || ijk[0] >= n || ijk[1] >= n || ijk[2] >= n) ? -1 : cellIdx[(ijk[2] * n + ijk[1]) * n + ijk[0]];
  for (let k = 0; k < m; k++) for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
    const p = [i, j, k], f0 = v[node(i, j, k)];
    for (let a = 0; a < 3; a++) {
      if (p[a] >= n) continue;
      const q = p.slice(); q[a]++;
      const f1 = v[node(q[0], q[1], q[2])];
      if ((f0 < 0) === (f1 < 0)) continue;
      const b = (a + 1) % 3, c = (a + 2) % 3;
      const at = (db, dc) => { const r = p.slice(); r[b] += db; r[c] += dc; return cell(r); };
      const A = at(-1, -1), B = at(0, -1), Cc = at(0, 0), D = at(-1, 0);
      if (A < 0 || B < 0 || Cc < 0 || D < 0) continue;
      if (f0 < 0) idx.push(A, B, Cc, A, Cc, D);
      else idx.push(A, Cc, B, A, D, Cc);
    }
  }
  return { positions: new Float32Array(pos), index: new Uint32Array(idx) };
}

// ------------------------------------------------------------------ rays

// Where the ray from o along unit u crosses the surface, outward to rmax:
// a list of { r, exit } (exit true where it leaves the body), each found
// by sphere tracing on |F| and refined by bisection.
export function rayCrossings(F, o, u, { rmax = 2.4, minStep = 0.003, r0 = 0 } = {}) {
  const out = [];
  const at = (r) => F(o[0] + r * u[0], o[1] + r * u[1], o[2] + r * u[2]);
  let r = r0, f = at(r), inside = f < 0;
  while (r < rmax) {
    const r1 = r + Math.max(minStep, 0.8 * Math.abs(f)), f1 = at(r1);
    if ((f1 < 0) !== inside) {
      let a = r, b = r1;
      for (let s = 0; s < 30; s++) { const c = (a + b) / 2; if ((at(c) < 0) === inside) a = c; else b = c; }
      out.push({ r: (a + b) / 2, exit: inside });
      inside = !inside;
    }
    r = r1; f = f1;
  }
  return out;
}

// ------------------------------------------------------------------ the decree

// Everything the page needs for one penguin: its field, mesh, centre,
// volume, and the radial table at step degree cells of penguin lon/lat
// (rows from the north, columns from -180): the last exit radius rOut,
// the number of exits, the cosine between the surface normal and the ray
// there, and the area factor (surface area per cell over the same cell on
// the sphere of equal volume, both in model units).
export function buildPenguin(prm = {}, { n = 96, step = 1 } = {}) {
  const field = makeField(prm);
  const { F } = field;
  const grid = sampleGrid(F, n);
  const o = grid.centroid;
  const Rv = Math.cbrt(3 * grid.volume / (4 * Math.PI));
  const nx = Math.round(360 / step), ny = Math.round(180 / step);
  const rOut = new Float32Array(nx * ny), exits = new Uint8Array(nx * ny), cosNU = new Float32Array(nx * ny), area = new Float32Array(nx * ny);
  let decreeVol = 0, decreeArea = 0, contested = 0, contestedSolid = 0;
  for (let j = 0; j < ny; j++) {
    const lat = 90 - (j + 0.5) * step;
    const dOmega = step * D2R * (Math.sin((lat + step / 2) * D2R) - Math.sin((lat - step / 2) * D2R));
    for (let i = 0; i < nx; i++) {
      const lon = -180 + (i + 0.5) * step, u = unit(lon, lat), k = j * nx + i;
      const xs = rayCrossings(F, o, u);
      const ex = xs.filter((c) => c.exit);
      const r = ex.length ? ex[ex.length - 1].r : 0;
      const p = [o[0] + r * u[0], o[1] + r * u[1], o[2] + r * u[2]];
      const nn = normalAt(F, p[0], p[1], p[2]);
      const cs = Math.max(1e-3, dot(nn, u));
      rOut[k] = r; exits[k] = ex.length; cosNU[k] = cs;
      area[k] = (r * r) / (cs * Rv * Rv);
      decreeVol += r * r * r / 3 * dOmega;
      decreeArea += r * r / cs * dOmega;
      if (ex.length > 1) { contested++; contestedSolid += dOmega; }
    }
  }
  const mesh = surfaceNets(grid);
  return {
    prm: { ...DEFAULTS, ...prm }, field, grid, centroid: o, volume: grid.volume, Rv, mesh,
    table: { step, nx, ny, rOut, exits, cosNU, area },
    decreeVolume: decreeVol, decreeArea, contestedCells: contested, contestedFraction: contestedSolid / (4 * Math.PI)
  };
}

// The table cell (i, j) at penguin lon, lat, and the value of a band there
// (nearest cell).
export function cellAt(t, lon, lat) {
  let x = (lon + 180) / t.step;
  x = ((Math.floor(x) % t.nx) + t.nx) % t.nx;
  const y = Math.max(0, Math.min(t.ny - 1, Math.floor((90 - lat) / t.step)));
  return { i: x, j: y, k: y * t.nx + x };
}

// For each mesh vertex: its direction from the centre (penguin lon, lat),
// its radius, and whether it is hidden from the decree (the ray meets the
// surface again beyond it, so its direction's last exit is further out:
// the vertex is an earlier exit, or an entry from outside).
export function vertexReach(pg) {
  const { positions } = pg.mesh, F = pg.field.F, o = pg.centroid;
  const nv = positions.length / 3;
  const lon = new Float32Array(nv), lat = new Float32Array(nv), rad = new Float32Array(nv), hidden = new Uint8Array(nv);
  for (let q = 0; q < nv; q++) {
    const d = [positions[3 * q] - o[0], positions[3 * q + 1] - o[1], positions[3 * q + 2] - o[2]];
    const r = Math.hypot(...d), u = [d[0] / r, d[1] / r, d[2] / r];
    const ll = toLonLat(u);
    lon[q] = ll[0]; lat[q] = ll[1]; rad[q] = r;
    // march on outward from just past the surface: any crossing means hidden
    hidden[q] = rayCrossings(F, o, u, { r0: r + 0.02 }).length ? 1 : 0;
  }
  return { lon, lat, rad, hidden };
}

// Area of the mesh, and of the part of it the decree cannot reach (a
// triangle counts as hidden when its vertices are, in proportion).
export function meshAreas(mesh, hidden) {
  const p = mesh.positions, ix = mesh.index;
  let all = 0, hid = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = 3 * ix[t], b = 3 * ix[t + 1], c = 3 * ix[t + 2];
    const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const A = Math.hypot(...cross(u, v)) / 2;
    all += A;
    if (hidden) hid += A * (hidden[ix[t]] + hidden[ix[t + 1]] + hidden[ix[t + 2]]) / 3;
  }
  return { area: all, hidden: hid };
}

// Model units to metres: the penguin at the earth's volume.
export const scale = (pg) => R_EARTH / pg.Rv;

// ------------------------------------------------------------------ the earth

// Rotations between earth directions (geocentric lon, lat) and penguin
// directions. "heard": Heard Island on the belly (penguin 0, 0) and the
// meridian north from it running up the penguin's front to the crown,
// so the crown is over 36.894 N 73.513 E (the Karakoram). "greenwich":
// earth's axis up the penguin, lon 0 lat 0 on the belly.
export function frame(orient = "heard") {
  if (orient !== "heard") return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const ex = unit(HEARD.lon, HEARD.lat), ez = unit(HEARD.lon, HEARD.lat + 90), ey = cross(ez, ex);
  return [ex, ey, ez];
}
export function earthToPenguin(M, lon, lat) {
  const e = unit(lon, lat);
  return toLonLat([dot(M[0], e), dot(M[1], e), dot(M[2], e)]);
}
export function penguinToEarth(M, lon, lat) {
  const p = unit(lon, lat);
  return toLonLat([0, 1, 2].map((a) => M[0][a] * p[0] + M[1][a] * p[1] + M[2][a] * p[2]));
}
// the new pole for PROJ's ob_tran: where the penguin's crown is on earth
export function crown(M) { return toLonLat(M[2]); }

// The geocentric radius of WGS84 (m) at geocentric latitude lat.
export function ellipsoidRadius(lat) {
  const a = WGS84.a, b = a * (1 - WGS84.f), p = lat * D2R;
  return a * b / Math.hypot(b * Math.cos(p), a * Math.sin(p));
}

// ------------------------------------------------------------------ colour

// A king penguin: black back and head, white front, an orange patch at
// each ear and on the upper breast, an orange stripe on a dark beak,
// dark feet. part: the part's id; p: position (body frame); nrm: normal.
export function plumage(part, p, nrm) {
  const BLACK = [0.07, 0.08, 0.11], WHITE = [0.94, 0.94, 0.92], ORANGE = [0.98, 0.55, 0.12], GOLD = [1.0, 0.78, 0.3], SLATE = [0.32, 0.36, 0.44];
  const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * Math.max(0, Math.min(1, t)));
  if (part === "beak") return p[2] < 0.735 - 0.06 * (p[0] - 0.3) && Math.abs(p[1]) > 0.012 ? ORANGE : BLACK;
  if (part === "foot" || part === "tail") return BLACK;
  if (part === "flipper") return mix(SLATE, WHITE, (Math.abs(p[1]) > 0.42 ? -nrm[1] * Math.sign(p[1]) : 0) * 3);
  if (part === "head") {
    // the ear patch: on the side, a little behind and below the eye
    const ear = Math.hypot((p[0] + 0.02) / 0.1, (p[2] - 0.7) / 0.11) < 1 && Math.abs(nrm[1]) > 0.5;
    if (ear) return ORANGE;
    return p[2] < 0.62 && nrm[0] > 0.2 ? mix(BLACK, GOLD, (nrm[0] - 0.2) * 3) : BLACK;
  }
  // body and belly: white in front, black behind, gold up the breast
  const front = nrm[0] + 0.25 - 0.2 * Math.abs(nrm[1]);
  const base = mix(BLACK, WHITE, front * 5);
  return p[2] > 0.25 && front > 0 ? mix(base, GOLD, (p[2] - 0.25) * 4 * Math.min(1, front * 4)) : base;
}

// ------------------------------------------------------------------ the decree as PROJ

// The PROJ string for penguin lon/lat as a rotated sphere. A geodetic CRS
// in PROJ (and so in GeoTIFF and in CF) needs an ellipsoid or a sphere;
// it cannot name a penguin. So the decree is a rotation of the sphere of
// equal volume (ob_tran moves Heard Island to 0, 0) and the penguin itself
// a radius grid in those coordinates, as planetary DEMs carry radius.
export function projString(M, R = R_EARTH) {
  const [plon, plat] = crown(M);
  if (plat > 89.9999) return `+proj=longlat +R=${R} +no_defs`;
  return `+proj=ob_tran +o_proj=longlat +o_lon_p=180 +o_lat_p=${+plat.toFixed(6)} +lon_0=${+(plon + 180 > 180 ? plon - 180 : plon + 180).toFixed(6)} +R=${R} +no_defs`;
}

// The decree as PROJJSON (a DerivedGeographicCRS, the shape PROJ gives
// for that string), with the penguin in its remarks: no PROJ object holds
// a shape, so the radius grid is named there.
export function projjson(M, pg, R = R_EARTH) {
  const [plon, plat] = crown(M);
  const s = pg ? scale(pg) : 1;
  const base = {
    type: "GeographicCRS",
    name: "Penguin mean sphere",
    datum: {
      type: "GeodeticReferenceFrame",
      name: "Republic of Heard Island Penguin Datum 2026",
      ellipsoid: { name: "Sphere of the penguin's volume (the earth's)", radius: R }
    },
    coordinate_system: {
      subtype: "ellipsoidal",
      axis: [
        { name: "Longitude", abbreviation: "lon", direction: "east", unit: "degree" },
        { name: "Latitude", abbreviation: "lat", direction: "north", unit: "degree" }
      ]
    }
  };
  let out = plat > 89.9999 ? { ...base, name: "Penguin CRS (earth axis up)" } : {
    type: "DerivedGeographicCRS",
    name: "Penguin CRS (Heard Island on the belly)",
    base_crs: base,
    conversion: {
      name: "Pole rotation (Heard Island decree)",
      method: { name: "PROJ ob_tran o_proj=longlat" },
      parameters: [
        { name: "o_lon_p", value: 180, unit: "degree" },
        { name: "o_lat_p", value: +plat.toFixed(6), unit: "degree" },
        { name: "lon_0", value: +(plon + 180 > 180 ? plon - 180 : plon + 180).toFixed(6), unit: "degree" }
      ]
    },
    coordinate_system: base.coordinate_system
  };
  out = { $schema: "https://proj.org/schemas/v0.7/projjson.schema.json", ...out };
  out.remarks = "Surface: the last exit of the ray from the penguin's centre of mass (radius grid penguin_radius_1deg.tif, " +
    `metres, in these coordinates). Penguin height ${pg ? Math.round(heightOf(pg) * s / 1000) : "?"} km. ` +
    "Not star-shaped: directions with more than one exit keep the outermost.";
  return out;
}

// The penguin's height, crown to toe, in model units.
export function heightOf(pg) {
  const p = pg.mesh.positions;
  let lo = Infinity, hi = -Infinity;
  for (let q = 2; q < p.length; q += 3) { if (p[q] < lo) lo = p[q]; if (p[q] > hi) hi = p[q]; }
  return hi - lo;
}
