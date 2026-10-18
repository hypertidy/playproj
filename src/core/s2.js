// S2 cells: the sphere projected onto a cube from its centre (gnomonic onto
// six faces), stretched by a quadratic so cells are closer to equal area, and
// numbered along a Hilbert curve that runs face 0 to face 5.
//
// A port of the parts of s2geometry (Apache 2.0, Google) needed to go between
// lon/lat, face (u, v), face (s, t), cell ids and tokens.

const D2R = Math.PI / 180;
export const MAX_LEVEL = 30;
const SWAP = 1, INVERT = 2;
const POS_TO_IJ = [[0, 1, 3, 2], [0, 2, 3, 1], [3, 2, 0, 1], [3, 1, 0, 2]];
const POS_TO_ORIENTATION = [SWAP, 0, 0, INVERT | SWAP];
const LOOKUP_BITS = 4;

// lookup tables mapping 4 levels of (i, j, orientation) to (pos, orientation)
const lookupPos = new Int32Array(1 << (2 * LOOKUP_BITS + 2));
const lookupIJ = new Int32Array(1 << (2 * LOOKUP_BITS + 2));
function initLookup(level, i, j, origOrientation, pos, orientation) {
  if (level === LOOKUP_BITS) {
    const ij = (i << LOOKUP_BITS) + j;
    lookupPos[(ij << 2) + origOrientation] = (pos << 2) + orientation;
    lookupIJ[(pos << 2) + origOrientation] = (ij << 2) + orientation;
    return;
  }
  level++; i <<= 1; j <<= 1; pos <<= 2;
  const r = POS_TO_IJ[orientation];
  for (let k = 0; k < 4; k++)
    initLookup(level, i + (r[k] >> 1), j + (r[k] & 1), origOrientation, pos + k, orientation ^ POS_TO_ORIENTATION[k]);
}
for (const o of [0, SWAP, INVERT, SWAP | INVERT]) initLookup(0, 0, 0, o, 0, o);

// ---------------------------------------------------------------- geometry

// lon/lat (degrees) to a unit vector: x to (0, 0), y to (0, 90E), z north
export function toXYZ(lon, lat) {
  const cp = Math.cos(lat * D2R);
  return [cp * Math.cos(lon * D2R), cp * Math.sin(lon * D2R), Math.sin(lat * D2R)];
}
export function toLonLat(p) {
  return [Math.atan2(p[1], p[0]) / D2R, Math.atan2(p[2], Math.hypot(p[0], p[1])) / D2R];
}

export function faceOf(p) {
  const a = [Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])];
  const k = a[0] > a[1] ? (a[0] > a[2] ? 0 : 2) : a[1] > a[2] ? 1 : 2;
  return p[k] < 0 ? k + 3 : k;
}

// (u, v) on a given face; only meaningful where the face's axis is positive
export function faceUV(face, p) {
  const [x, y, z] = p;
  switch (face) {
    case 0: return [y / x, z / x];
    case 1: return [-x / y, z / y];
    case 2: return [-x / z, -y / z];
    case 3: return [z / x, y / x];
    case 4: return [z / y, -x / y];
    default: return [-y / z, -x / z];
  }
}
// the point on the face's plane (distance 1 from the centre)
export function faceUVtoXYZ(face, u, v) {
  switch (face) {
    case 0: return [1, u, v];
    case 1: return [-u, 1, v];
    case 2: return [-u, -v, 1];
    case 3: return [-1, -v, -u];
    case 4: return [v, -1, -u];
    default: return [v, u, -1];
  }
}
// the face's own axis, as a unit vector
export const faceAxis = (face) => faceUVtoXYZ(face, 0, 0);

// the quadratic stretch between u (gnomonic) and s (cell grid)
export const uvToST = (u) => (u >= 0 ? 0.5 * Math.sqrt(1 + 3 * u) : 1 - 0.5 * Math.sqrt(1 - 3 * u));
export const stToUV = (s) => (s >= 0.5 ? (4 * s * s - 1) / 3 : (1 - 4 * (1 - s) * (1 - s)) / 3);

// ---------------------------------------------------------------- cell ids

const LEAF = 1 << MAX_LEVEL;
const clampIJ = (x) => Math.max(0, Math.min(LEAF - 1, Math.floor(x * LEAF)));

function fromFaceIJ(face, i, j) {
  let n = BigInt(face) << 60n;
  let bits = face & SWAP;
  const mask = (1 << LOOKUP_BITS) - 1;
  for (let k = 7; k >= 0; k--) {
    bits += ((i >> (k * LOOKUP_BITS)) & mask) << (LOOKUP_BITS + 2);
    bits += ((j >> (k * LOOKUP_BITS)) & mask) << 2;
    bits = lookupPos[bits];
    n |= BigInt(bits >> 2) << BigInt(k * 2 * LOOKUP_BITS);
    bits &= SWAP | INVERT;
  }
  return n * 2n + 1n;
}

const lsbForLevel = (level) => 1n << BigInt(2 * (MAX_LEVEL - level));

export function parent(id, level) {
  const lsb = lsbForLevel(level);
  return (id & -lsb) | lsb;
}

export function levelOf(id) {
  let lsb = id & -id, level = MAX_LEVEL;
  while (lsb > 1n) { lsb >>= 2n; level--; }
  return level;
}

export function cellFromLonLat(lon, lat, level = MAX_LEVEL) {
  const p = toXYZ(lon, lat), face = faceOf(p);
  const [u, v] = faceUV(face, p);
  return parent(fromFaceIJ(face, clampIJ(uvToST(u)), clampIJ(uvToST(v))), level);
}

export function cellFromFaceST(face, s, t, level) {
  return parent(fromFaceIJ(face, clampIJ(s), clampIJ(t)), level);
}

// face, leaf i and j at the cell's lower-left corner, and level
export function cellToFaceIJ(id) {
  const face = Number(id >> 61n);
  let bits = face & SWAP, i = 0, j = 0;
  for (let k = 7; k >= 0; k--) {
    const nbits = k === 7 ? MAX_LEVEL - 7 * LOOKUP_BITS : LOOKUP_BITS;
    bits += Number((id >> BigInt(k * 2 * LOOKUP_BITS + 1)) & BigInt((1 << (2 * nbits)) - 1)) << 2;
    bits = lookupIJ[bits];
    i += (bits >> (LOOKUP_BITS + 2)) << (k * LOOKUP_BITS);
    j += ((bits >> 2) & ((1 << LOOKUP_BITS) - 1)) << (k * LOOKUP_BITS);
    bits &= SWAP | INVERT;
  }
  const level = levelOf(id), size = 1 << (MAX_LEVEL - level);
  return { face, i: i & -size, j: j & -size, level, size };
}

// the cell's (s, t) square and its four corners in lon/lat, counterclockwise
export function cellBounds(id) {
  const { face, i, j, level, size } = cellToFaceIJ(id);
  const s0 = i / LEAF, t0 = j / LEAF, d = size / LEAF;
  const corners = [[s0, t0], [s0 + d, t0], [s0 + d, t0 + d], [s0, t0 + d]]
    .map(([s, t]) => toLonLat(faceUVtoXYZ(face, stToUV(s), stToUV(t))));
  return { face, level, s0, t0, d, corners };
}

export function toToken(id) {
  if (id === 0n) return "X";
  return id.toString(16).padStart(16, "0").replace(/0+$/, "");
}
export function fromToken(token) {
  if (!/^[0-9a-fA-F]{1,16}$/.test(token)) return null;
  const id = BigInt("0x" + token.padEnd(16, "0"));
  if (id === 0n || Number(id >> 61n) > 5) return null;
  return id;
}

// The cells of one face at a level, in Hilbert curve order, as (i, j)
// indices of that level.
export function hilbertCells(face, level) {
  const out = [];
  const walk = (lev, i, j, orientation) => {
    if (lev === level) { out.push([i, j]); return; }
    const r = POS_TO_IJ[orientation];
    for (let k = 0; k < 4; k++)
      walk(lev + 1, 2 * i + (r[k] >> 1), 2 * j + (r[k] & 1), orientation ^ POS_TO_ORIENTATION[k]);
  };
  walk(0, 0, 0, face & SWAP);
  return out;
}

// ---------------------------------------------------------------- grid

// The cells at a level as a grid in the sense of grids.js: six patches,
// one per face, each 2^level cells square in (s, t). u and v in a patch
// are s and t, so a cell (i, j) is the one cellFromFaceST finds at its
// centre.
export function grid(level) {
  const n = 2 ** level;
  const patches = [0, 1, 2, 3, 4, 5].map((face) => {
    const axis = faceAxis(face);
    return {
      name: "face " + face, face, ni: n, nj: n,
      fromIndex: (s, t) => toLonLat(faceUVtoXYZ(face, stToUV(s), stToUV(t))),
      toIndex(lon, lat) {
        const p = toXYZ(lon, lat);
        if (p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2] <= 1e-12) return null;
        const [u, v] = faceUV(face, p);
        return [uvToST(u), uvToST(v)];
      }
    };
  });
  return { kind: "s2", level, patches };
}
