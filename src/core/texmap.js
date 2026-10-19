// Texture mapping: meshes whose vertices carry a texture coordinate (u, v),
// and the projections a lon/lat image is draped through.
//
// A renderer stores u, v at each vertex and, for every pixel a triangle
// covers, blends the three by the pixel's barycentric weights; the texture
// is read there. For an equirectangular (lon/lat) image, u, v at a vertex
// is just its lon and lat, so the blend is exact only where lon and lat
// are linear across the triangle, which in a curved or projected surface
// they are not. The meshes here are built to show that, and where the
// seams and poles go wrong.
//
// Scene axes are the geoid page's: y up through the north pole, lon 0 lat 0
// towards +z, so x = cos(lat) sin(lon), y = sin(lat), z = cos(lat) cos(lon).
// Plane coordinates are in sphere radii. u runs 0 to 1 from lon -180 to 180
// and v 0 to 1 from lat -90 to 90 (three.js's v points up the image).

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const SQ2 = Math.SQRT2;

export const lonLatToUv = (lon, lat) => [(lon + 180) / 360, (lat + 90) / 180];
export const uvToLonLat = (u, v) => [u * 360 - 180, v * 180 - 90];

export function toXYZ(lon, lat) {
  const l = lon * D2R, p = lat * D2R;
  return [Math.cos(p) * Math.sin(l), Math.sin(p), Math.cos(p) * Math.cos(l)];
}
export function fromXYZ(x, y, z) {
  return [Math.atan2(x, z) * R2D, Math.atan2(y, Math.hypot(x, z)) * R2D];
}

// Great circle distance in degrees of arc.
export function arc(lon0, lat0, lon1, lat1) {
  const a = toXYZ(lon0, lat0), b = toXYZ(lon1, lat1);
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return Math.atan2(Math.hypot(...c), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * R2D;
}

// ------------------------------------------------------------------ projections

// Spherical, R = 1, in degrees. lat: the latitudes the page meshes. The
// same inverses are written in GLSL for the per-pixel lookup.
function mollTheta(lat) {
  const p = lat * D2R, k = Math.PI * Math.sin(p);
  if (Math.abs(Math.abs(p) - Math.PI / 2) < 1e-12) return p;
  let t = p;
  for (let i = 0; i < 50; i++) {
    const d = (2 * t + Math.sin(2 * t) - k) / (2 + 2 * Math.cos(2 * t));
    t -= d;
    if (Math.abs(d) < 1e-14) break;
  }
  return t;
}

export const PROJS = {
  eqc: {
    label: "Plate carree", proj: "+proj=eqc +R=1", lat: [-90, 90],
    forward: (lon, lat) => [lon * D2R, lat * D2R],
    inverse: (x, y) => [x * R2D, y * R2D]
  },
  merc: {
    label: "Mercator", proj: "+proj=merc +R=1", lat: [-80, 80],
    forward: (lon, lat) => [lon * D2R, Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2))],
    inverse: (x, y) => [x * R2D, Math.atan(Math.sinh(y)) * R2D]
  },
  stere: {
    label: "Polar stereographic (south)", proj: "+proj=stere +lat_0=-90 +R=1", lat: [-90, 0],
    forward: (lon, lat) => {
      const r = 2 * Math.tan(Math.PI / 4 + lat * D2R / 2);
      return [r * Math.sin(lon * D2R), r * Math.cos(lon * D2R)];
    },
    inverse: (x, y) => [Math.atan2(x, y) * R2D, (2 * Math.atan(Math.hypot(x, y) / 2) - Math.PI / 2) * R2D]
  },
  moll: {
    label: "Mollweide", proj: "+proj=moll +R=1", lat: [-90, 90],
    forward: (lon, lat) => {
      const t = mollTheta(lat);
      return [(2 * SQ2 / Math.PI) * lon * D2R * Math.cos(t), SQ2 * Math.sin(t)];
    },
    inverse: (x, y) => {
      const t = Math.asin(Math.max(-1, Math.min(1, y / SQ2)));
      const lat = Math.asin(Math.max(-1, Math.min(1, (2 * t + Math.sin(2 * t)) / Math.PI)));
      const c = Math.cos(t);
      return [c < 1e-12 ? 0 : (Math.PI * x / (2 * SQ2 * c)) * R2D, lat * R2D];
    }
  }
};

// ------------------------------------------------------------------ meshes

// Every mesh is { pos, uv, index, lonlat }: flat arrays of xyz, uv and
// triangle corners, and each vertex's own lon/lat (null where the mesh is
// not a map). lonlat is what the vertex is; uv is what the renderer is told.

// A small square of (n + 1) x (n + 1) vertices, u, v from 0 to 1, bent
// round a cylinder by bend (0 flat, 1 a whole turn, the u = 0 and u = 1
// edges meeting).
export function smallMesh(n = 2, bend = 0) {
  const pos = [], uv = [], index = [];
  const w = 2, h = 1.2;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const s = i / n, t = j / n, y = (t - 0.5) * h;
      if (bend < 1e-6) pos.push((s - 0.5) * w, y, 0);
      else {
        const a = bend * 2 * Math.PI, r = w / a, th = (s - 0.5) * a;
        pos.push(r * Math.sin(th), y, r * Math.cos(th) - r);
      }
      uv.push(s, t);
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      index.push(a, b, d, a, d, c);
    }
  }
  return { pos, uv, index, lonlat: null };
}

// A lon/lat grid of rows x cols cells from lat0 to lat1, its vertices
// placed by at(lon, lat) -> xyz. seam "split" gives the -180 and 180
// meridians a vertex each (u = 0 and u = 1); "shared" gives them one, so
// the last column of cells runs from u near 1 back to u = 0 and smears the
// whole image across itself. pole "split" gives each cell at a pole its own
// pole vertex at the cell's middle u; "single" gives the pole one vertex
// (u = 0.5), so those triangles shear.
export function gridMesh({ rows, cols, lat0 = -90, lat1 = 90, at, seam = "split", pole = "split" }) {
  const pos = [], uv = [], lonlat = [], index = [];
  const nc = seam === "shared" ? cols : cols + 1;
  const add = (lon, lat, u, v) => {
    pos.push(...at(lon, lat)); uv.push(u, v); lonlat.push(lon, lat);
    return lonlat.length / 2 - 1;
  };
  const latOf = (j) => lat0 + (lat1 - lat0) * j / rows;
  const atPole = (lat) => Math.abs(Math.abs(lat) - 90) < 1e-9;
  const row = [];
  for (let j = 0; j <= rows; j++) {
    const lat = latOf(j), v = (lat + 90) / 180, r = [];
    if (atPole(lat)) {
      if (pole === "single") { const k = add(0, lat, 0.5, v); for (let i = 0; i <= cols; i++) r.push(k); }
      else for (let i = 0; i < cols; i++) r.push(add(-180 + 360 * (i + 0.5) / cols, lat, (i + 0.5) / cols, v));
      r.pole = true;
    } else {
      for (let i = 0; i < nc; i++) r.push(add(-180 + 360 * i / cols, lat, i / cols, v));
      if (seam === "shared") r.push(r[0]);
    }
    row.push(r);
  }
  for (let j = 0; j < rows; j++) {
    const lo = row[j], hi = row[j + 1];
    for (let i = 0; i < cols; i++) {
      if (lo.pole) index.push(lo[i], hi[i + 1], hi[i]);
      else if (hi.pole) index.push(lo[i], lo[i + 1], hi[i]);
      else index.push(lo[i], lo[i + 1], hi[i + 1], lo[i], hi[i + 1], hi[i]);
    }
  }
  return { pos, uv, index, lonlat };
}

// An icosahedron with a vertex at each pole, each face cut into level x
// level triangles pushed out to the sphere. u, v come from each vertex's
// lon/lat, so faces across the antimeridian span u from near 1 to near 0.
// seam "split" copies the low-u corners of those faces at u + 1 (the
// texture repeats in u); pole "split" gives each face at a pole its own
// pole corner at the middle of the face's other two u.
export function icoMesh(level = 2, { seam = "split", pole = "split" } = {}) {
  const ring = Math.atan(0.5) * R2D, base = [[0, 90]];
  for (let i = 0; i < 5; i++) base.push([-180 + 72 * i, ring]);
  for (let i = 0; i < 5; i++) base.push([-144 + 72 * i, -ring]);
  base.push([0, -90]);
  const P = base.map(([lon, lat]) => toXYZ(lon, lat));
  const F = [];
  for (let i = 0; i < 5; i++) {
    const a = 1 + i, b = 1 + (i + 1) % 5, c = 6 + i, d = 6 + (i + 1) % 5;
    F.push([0, b, a], [a, b, c], [b, d, c], [11, c, d]);
  }
  // subdivide each face, sharing vertices along shared edges
  const pts = [], key = new Map();
  const vert = (p) => {
    const l = Math.hypot(...p), q = p.map((x) => x / l);
    const k = q.map((x) => x.toFixed(9)).join(",");
    if (!key.has(k)) { key.set(k, pts.length); pts.push(q); }
    return key.get(k);
  };
  const tris = [];
  for (const [a, b, c] of F) {
    const A = P[a], B = P[b], C = P[c], g = [];
    for (let i = 0; i <= level; i++) {
      g.push([]);
      for (let j = 0; j <= level - i; j++) {
        const s = i / level, t = j / level, r = 1 - s - t;
        g[i].push(vert([0, 1, 2].map((k) => r * A[k] + s * B[k] + t * C[k])));
      }
    }
    for (let i = 0; i < level; i++) {
      for (let j = 0; j < level - i; j++) {
        tris.push([g[i][j], g[i + 1][j], g[i][j + 1]]);
        if (j < level - i - 1) tris.push([g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]]);
      }
    }
  }
  const ll = pts.map((p) => fromXYZ(...p));
  const pos = [], uv = [], lonlat = [], index = [];
  const shared = ll.map(() => -1);
  const add = (k, u, v) => {
    pos.push(...pts[k]); uv.push(u, v); lonlat.push(...ll[k]);
    return lonlat.length / 2 - 1;
  };
  const isPole = (k) => Math.abs(Math.abs(ll[k][1]) - 90) < 1e-6;
  for (const t of tris) {
    let us = t.map((k) => (ll[k][0] + 180) / 360);
    const np = t.filter((k) => !isPole(k)).map((k) => (ll[k][0] + 180) / 360);
    if (seam === "split" && np.length && Math.max(...np) - Math.min(...np) > 0.5) us = us.map((u) => (u < 0.5 ? u + 1 : u));
    if (pole === "split") {
      const other = t.map((k, i) => (isPole(k) ? null : us[i])).filter((u) => u !== null);
      us = us.map((u, i) => (isPole(t[i]) ? other.reduce((s, x) => s + x, 0) / other.length : u));
    }
    for (let i = 0; i < 3; i++) {
      const k = t[i], v = (ll[k][1] + 90) / 180, u0 = (ll[k][0] + 180) / 360;
      if (us[i] === u0 && !(pole === "split" && isPole(k))) {
        if (shared[k] < 0) shared[k] = add(k, us[i], v);
        index.push(shared[k]);
      } else index.push(add(k, us[i], v));
    }
  }
  return { pos, uv, index, lonlat };
}

// The globe as a lon/lat grid on the unit sphere.
export function globeMesh(rows, cols, opts = {}) {
  return gridMesh({ rows, cols, at: toXYZ, ...opts });
}

// A lon/lat grid laid flat in a projection: xy in the plane (z = 0),
// scaled by s; also returns each vertex's plane coordinates in radii.
export function planeMesh(projId, rows, cols, s = 1) {
  const P = PROJS[projId];
  const m = gridMesh({
    rows, cols, lat0: P.lat[0], lat1: P.lat[1],
    at: (lon, lat) => { const [x, y] = P.forward(lon, lat); return [x * s, y * s, 0]; }
  });
  m.xy = [];
  for (let k = 0; k < m.lonlat.length; k += 2) m.xy.push(...P.forward(m.lonlat[k], m.lonlat[k + 1]));
  return m;
}

// ------------------------------------------------------------------ interpolation

// Barycentric weights of 2D point p in triangle a, b, c, or null if the
// triangle has no area.
export function bary2(p, a, b, c) {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(d) < 1e-15) return null;
  const l0 = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / d;
  const l1 = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / d;
  return [l0, l1, 1 - l0 - l1];
}

// Blend per-vertex values (arrays of the same length) by weights w.
export const blend = (w, a, b, c) => a.map((x, i) => w[0] * x + w[1] * b[i] + w[2] * c[i]);

// The triangle of mesh m whose uv contains (u, v), as { t, w }, trying
// u - 1 and u + 1 too for meshes that wrap; null if none does.
export function triangleAtUv(m, u, v) {
  const n = m.index.length / 3;
  for (const du of [0, 1, -1]) {
    for (let t = 0; t < n; t++) {
      const [a, b, c] = [0, 1, 2].map((i) => m.index[3 * t + i]);
      const w = bary2([u + du, v], [m.uv[2 * a], m.uv[2 * a + 1]], [m.uv[2 * b], m.uv[2 * b + 1]], [m.uv[2 * c], m.uv[2 * c + 1]]);
      if (w && w.every((x) => x >= -1e-9)) return { t, w, du };
    }
  }
  return null;
}

// The lon/lat a per-vertex lookup reads at weights w in triangle t (from
// the blended u, v), and where that point really is (from the blended
// position: pushed out to the sphere, or through the plane's inverse).
// miss is the great circle distance between them in degrees.
export function lookup(m, t, w, projId = null) {
  const [a, b, c] = [0, 1, 2].map((i) => m.index[3 * t + i]);
  const g = (arr, n, k) => arr.slice(n * k, n * k + n);
  const uv = blend(w, g(m.uv, 2, a), g(m.uv, 2, b), g(m.uv, 2, c));
  let [lon, lat] = uvToLonLat(uv[0] - Math.floor(uv[0]), uv[1]);
  if (!m.lonlat) return { uv, read: [lon, lat], truth: null, miss: null };
  let truth;
  if (projId) truth = PROJS[projId].inverse(...blend(w, g(m.xy, 2, a), g(m.xy, 2, b), g(m.xy, 2, c)));
  else truth = fromXYZ(...blend(w, g(m.pos, 3, a), g(m.pos, 3, b), g(m.pos, 3, c)));
  return { uv, read: [lon, lat], truth, miss: arc(lon, lat, ...truth) };
}
