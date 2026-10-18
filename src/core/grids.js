// Model grids: the curvilinear grids climate and ocean models compute on.
//
// A grid is a map from index space to the sphere. It is one or more
// patches, { kind, patches: [patch, ...] }, and a patch is a regular array
// of cells:
//
//   ni, nj              cells across and up (integers)
//   fromIndex(u, v)     [lon, lat] in degrees at index position u, v, each
//                       0 to 1 across the patch (cell i spans i/ni to
//                       (i+1)/ni)
//   toIndex(lon, lat)   [u, v], outside 0..1 where the point is off the
//                       patch, or null where there is no answer; toIndex
//                       itself may be null (a grid read from arrays)
//   name                optional label
//
// A grid or patch can carry more (poles, a seam, the cube layout, ROMS
// vertex arrays). The model grids here, the ROMS grids (roms.js, one patch
// each) and the s2 cells (s2.js grid) all follow this. The page draws in
// index space, where the model's grid is straight, and moves each patch
// between the globe and a flat array.
//
// Angles are in degrees unless named otherwise.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

const wrap180 = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export const toXYZ = (lon, lat) => {
  const p = lat * D2R, l = lon * D2R;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
};
export const toLonLat = (v) => {
  const r = Math.hypot(v[0], v[1], v[2]);
  return [Math.atan2(v[1], v[0]) * R2D, Math.asin(clamp(v[2] / r, -1, 1)) * R2D];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---------------------------------------------------------------- rotated pole

// PROJ's ob_tran with o_proj=longlat (Snyder 5-7, 5-8b): geographic lon/lat to
// rotated lon/lat, given o_lat_p, o_lon_p and lon_0. In CF terms o_lat_p is
// grid_north_pole_latitude, lon_0 is 180 + grid_north_pole_longitude and
// o_lon_p is north_pole_grid_longitude (usually 0).
export function obTran({ oLatP, oLonP = 0, lon0 }) {
  const sp = Math.sin(oLatP * D2R), cp = Math.cos(oLatP * D2R), lamp = oLonP * D2R;
  return {
    forward(lon, lat) {
      const lam = (lon - lon0) * D2R, phi = lat * D2R;
      const cl = Math.cos(lam), sphi = Math.sin(phi), cphi = Math.cos(phi);
      const rl = Math.atan2(cphi * Math.sin(lam), sp * cphi * cl + cp * sphi) + lamp;
      const rp = Math.asin(clamp(sp * sphi - cp * cphi * cl, -1, 1));
      return [wrap180(rl * R2D), rp * R2D];
    },
    inverse(rlon, rlat) {
      const lam = rlon * D2R - lamp, phi = rlat * D2R;
      const cl = Math.cos(lam), sphi = Math.sin(phi), cphi = Math.cos(phi);
      const lat = Math.asin(clamp(sp * sphi + cp * cphi * cl, -1, 1));
      const lon = Math.atan2(cphi * Math.sin(lam), sp * cphi * cl - cp * sphi);
      return [wrap180(lon * R2D + lon0), lat * R2D];
    }
  };
}

// A grid in rotated lon/lat over a window [rlon0, rlon1] x [rlat0, rlat1].
function rotatedPatch(name, ob, win, step) {
  const [x0, x1, y0, y1] = win, w = x1 - x0, h = y1 - y0;
  const full = w >= 360;
  return {
    name, ni: Math.round(w / step), nj: Math.round(h / step),
    width: w * D2R, height: h * D2R,
    fromIndex: (u, v) => ob.inverse(x0 + u * w, y0 + v * h),
    toIndex(lon, lat) {
      let [rl, rp] = ob.forward(lon, lat);
      if (full) rl = x0 + ((((rl - x0) % 360) + 360) % 360);
      return [(rl - x0) / w, (rp - y0) / h];
    },
    // rotated longitude wraps: a jump across the patch is a seam, not a line
    seam: full ? 0.5 : 2
  };
}

// CF: grid_north_pole_longitude / latitude; returns the PROJ parameters
export const cfToObTran = (plon, plat, olon = 0) => ({ oLatP: plat, oLonP: olon, lon0: wrap180(180 + plon) });

export function rotatedPole({ plon = -162, plat = 39.25, step = 10, domain = null }) {
  const ob = obTran(cfToObTran(plon, plat));
  const patch = rotatedPatch("rotated", ob, [-180, 180, -90, 90], step);
  return {
    kind: "rot", patches: [patch], ob,
    poles: [[plon, plat], [wrap180(plon + 180), -plat]],
    domain
  };
}

// EURO-CORDEX (EUR-11) in rotated coordinates, about the pole at 39.25N 162W
export const EURO_CORDEX = { plon: -162, plat: 39.25, win: [-28.375, 18.155, -23.375, 21.835] };

// ---------------------------------------------------------------- tripolar

// Murray (1996) tripolar grid, as GFDL's MOM builds it: Mercator-spaced lat/lon
// south of lat_join, and north of it a bipolar cap. The cap is a lat/lon grid
// on a second sphere whose own poles sit on its equator (a rotated-pole grid
// with o_lat_p = 0), carried onto the cap by polar stereographic projection
// scaled to fit. Its circles round each pole continue the meridians from the
// south, so the grid stays orthogonal and conformal, and its pole-to-pole
// arcs carry on the parallels until the arc over the North Pole, where the
// grid folds onto itself.
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
const mercLat = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * R2D;

// The second sphere's northern hemisphere onto the cap north of lat_join:
// polar stereographic out, and back in with the plane scaled by
// R = tan((90 - lat_join) / 2), so the equator lands on the join.
export function auxToCap(R, lon, lat) {
  const th = 2 * Math.atan(R * Math.tan(((90 - lat) * D2R) / 2));
  return [lon, 90 - th * R2D];
}

export function tripolar({ plon = 80, join = 65, step = 10, south = -80 }) {
  const dl = step * D2R, ni = Math.round(360 / step);
  const yJ = mercY(join);
  const nS = Math.max(1, Math.round((yJ - mercY(south)) / dl));
  const yS = yJ - nS * dl;
  const nN = Math.round(90 / step), nj = nS + nN;
  const R = Math.tan(((90 - join) * D2R) / 2);           // cap radius in the stereographic plane
  const lonW = plon - 180;                               // the index space starts at the other pole
  const P = toXYZ(plon, 0), E = toXYZ(plon + 90, 0), N = [0, 0, 1];

  // a point of the cap from its column longitude and its arc angle (0 at the
  // join, 90 at the fold)
  function capPoint(lonCol, alpha) {
    let d = wrap180(lonCol - plon), a = alpha;
    if (d < 0) { d = -d; a = 180 - alpha; }
    const sd = Math.sin(d * D2R), cd = Math.cos(d * D2R), ca = Math.cos(a * D2R), sa = Math.sin(a * D2R);
    const X = [0, 1, 2].map((k) => cd * P[k] + sd * (ca * E[k] + sa * N[k]));
    return auxToCap(R, ...toLonLat(X));
  }

  const patch = {
    name: "tripolar", ni, nj, width: 2 * Math.PI, height: nj * dl,
    fromIndex(u, v) {
      const lonCol = lonW + u * 360, J = v * nj;
      if (J <= nS) return [wrap180(lonCol), mercLat(yS + J * dl)];
      return capPoint(lonCol, Math.min(90, (J - nS) * step));
    },
    toIndex(lon, lat) {
      if (lat < south - step) return null;
      if (lat <= join) {
        const u = ((((lon - lonW) % 360) + 360) % 360) / 360;
        return [u, (mercY(Math.max(lat, -89.9)) - yS) / dl / nj];
      }
      const th = (90 - lat) * D2R;
      const thA = 2 * Math.atan(Math.tan(th / 2) / R);
      const X = toXYZ(lon, 90 - thA * R2D);
      const d = Math.acos(clamp(dot(X, P), -1, 1)) * R2D;
      const alpha = Math.atan2(dot(X, N), dot(X, E)) * R2D;
      const [lonCol, row] = alpha <= 90 ? [plon + d, alpha] : [plon - d, 180 - alpha];
      const u = ((((lonCol - lonW) % 360) + 360) % 360) / 360;
      return [u, (nS + row / step) / nj];
    },
    seam: 0.25,
    fold: nS / nj   // the cap starts here; the top row is the fold
  };
  return {
    kind: "tri", patches: [patch],
    poles: [[wrap180(plon), join], [wrap180(plon + 180), join], [0, -90]],
    nS, nN, yS, R, capPoint
  };
}

// ---------------------------------------------------------------- cubed sphere

// Equiangular gnomonic cubed sphere (Ronchi et al. 1996; the FV3 grid): six
// faces, each a gnomonic projection with even steps in angle, xi and eta from
// -45 to 45 degrees. S2 uses the same cube with a quadratic stretch instead.
// Faces 0-3 round the equator from 0E, 4 north, 5 south; laid out as a cross.
const CUBE = [
  { c: [1, 0, 0], a: [0, 1, 0], b: [0, 0, 1], at: [0, 0] },
  { c: [0, 1, 0], a: [-1, 0, 0], b: [0, 0, 1], at: [1, 0] },
  { c: [-1, 0, 0], a: [0, -1, 0], b: [0, 0, 1], at: [2, 0] },
  { c: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1], at: [-1, 0] },
  { c: [0, 0, 1], a: [0, 1, 0], b: [-1, 0, 0], at: [0, 1] },
  { c: [0, 0, -1], a: [0, 1, 0], b: [1, 0, 0], at: [0, -1] }
];
export const CUBE_FACES = CUBE;

export function cubeFace(f, xi, eta) {
  const F = CUBE[f], x = Math.tan(xi * D2R), y = Math.tan(eta * D2R);
  return [0, 1, 2].map((k) => F.c[k] + x * F.a[k] + y * F.b[k]);
}

export function cubedSphere({ n = 6, stretch = "angle" }) {
  // stretch "angle": equiangular; "plain": even steps on the cube face
  const toS = stretch === "angle" ? (s) => (s * 90 - 45) : (s) => Math.atan(2 * s - 1) * R2D;
  const fromAng = stretch === "angle" ? (a) => (a + 45) / 90 : (a) => (Math.tan(a * D2R) + 1) / 2;
  const patches = CUBE.map((F, f) => ({
    name: "face " + f, face: f, ni: n, nj: n, width: Math.PI / 2, height: Math.PI / 2, at: F.at,
    fromIndex: (u, v) => toLonLat(cubeFace(f, toS(u), toS(v))),
    toIndex(lon, lat) {
      const p = toXYZ(lon, lat), pc = dot(p, F.c);
      if (pc < 0.35) return null;                         // far side of the cube: not on this face
      return [fromAng(Math.atan(dot(p, F.a) / pc) * R2D), fromAng(Math.atan(dot(p, F.b) / pc) * R2D)];
    },
    seam: 2
  }));
  const poles = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) poles.push(toLonLat([sx, sy, sz]));
  return { kind: "cube", patches, poles };
}

// ---------------------------------------------------------------- Yin-Yang

// Kageyama and Sato (2004): two identical lat/lon patches, |lon| <= 135 and
// |lat| <= 45, the second turned by (x, y, z) -> (-x, z, y). Each is the low
// latitude part of a lat/lon grid, so neither has a pole; together they
// overlap a little and cover the sphere. Yang is a rotated-pole grid with its
// pole on the equator at 90E: ob_tran o_lat_p = 0, o_lon_p = 90, lon_0 = -90.
export const YANG = { oLatP: 0, oLonP: 90, lon0: -90 };

export function yinYang({ step = 10 }) {
  const win = [-135, 135, -45, 45];
  const yin = rotatedPatch("Yin", { forward: (l, p) => [wrap180(l), p], inverse: (l, p) => [l, p] }, win, step);
  const yang = rotatedPatch("Yang", obTran(YANG), win, step);
  for (const p of [yin, yang]) {
    const to = p.toIndex;
    p.toIndex = (lon, lat) => {
      const uv = to(lon, lat);
      return uv[0] > -0.15 && uv[0] < 1.15 && uv[1] > -0.3 && uv[1] < 1.3 ? uv : null;
    };
  }
  return { kind: "yy", patches: [yin, yang], poles: [] };
}

// ---------------------------------------------------------------- cells

// spherical area of a quadrilateral (Van Oosterom and Strackee, two triangles)
export function quadArea(corners) {
  const p = corners.map(([lon, lat]) => toXYZ(lon, lat));
  const tri = (a, b, c) => {
    const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    return 2 * Math.atan2(Math.abs(det), 1 + dot(a, b) + dot(b, c) + dot(c, a));
  };
  return tri(p[0], p[1], p[2]) + tri(p[0], p[2], p[3]);
}

// the corners of cell (i, j) of a patch, counterclockwise from lower left
export const cellCorners = (patch, i, j) =>
  [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([a, b]) => patch.fromIndex(a / patch.ni, b / patch.nj));

// angle between the cell's two grid directions at its centre, in degrees:
// 90 for an orthogonal grid
export function cellAngle(patch, i, j) {
  const h = 1e-6, u = (i + 0.5) / patch.ni, v = (j + 0.5) / patch.nj;
  const at = (a, b) => toXYZ(...patch.fromIndex(a, b));
  const sub = (a, b) => a.map((x, k) => x - b[k]);
  const du = sub(at(u + h, v), at(u - h, v)), dv = sub(at(u, v + h), at(u, v - h));
  return Math.acos(clamp(dot(du, dv) / Math.hypot(...du) / Math.hypot(...dv), -1, 1)) * R2D;
}

// the PROJ gnomonic projection of each cube face: its plane coordinates on
// the unit sphere are the tangents of the face's angles xi and eta
export const cubeFaceProj = (f) => ["+proj=gnom +lat_0=0 +lon_0=0", "+proj=gnom +lat_0=0 +lon_0=90",
  "+proj=gnom +lat_0=0 +lon_0=180", "+proj=gnom +lat_0=0 +lon_0=-90",
  "+proj=gnom +lat_0=90 +lon_0=0", "+proj=gnom +lat_0=-90 +lon_0=0"][f];
