// The icosahedron that icosahedral grids (H3, ISEA, DGGRID) are built on:
// faces found from the 12 vertices, a gnomonic frame on each face, and the
// hinges that fold the faces open into the classic strip net (five faces
// round the top vertex, a band of ten, five round the bottom).
//
// Vectors are plain [x, y, z] arrays, x to (0, 0), y to (0, 90E), z north.
// Folded, the faces sit in planes at distance 1 from the centre, so a point
// on the sphere goes to its face by the gnomonic projection, p / (p . c).

const D2R = Math.PI / 180;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a) => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

export function toXYZ(lon, lat) {
  const cp = Math.cos(lat * D2R);
  return [cp * Math.cos(lon * D2R), cp * Math.sin(lon * D2R), Math.sin(lat * D2R)];
}
export function toLonLat(p) {
  return [Math.atan2(p[1], p[0]) / D2R, Math.atan2(p[2], Math.hypot(p[0], p[1])) / D2R];
}

// the angle between neighbouring vertices (63.43 deg) and between two faces
export const EDGE = 2 * Math.atan(2 / (1 + Math.sqrt(5)));
export const DIHEDRAL = Math.acos(-Math.sqrt(5) / 3);

// rotate p about the unit axis k through the origin by angle a (Rodrigues)
function rotate(p, k, a) {
  const c = Math.cos(a), s = Math.sin(a), kp = cross(k, p), kd = dot(k, p) * (1 - c);
  return [p[0] * c + kp[0] * s + k[0] * kd, p[1] * c + kp[1] * s + k[1] * kd, p[2] * c + kp[2] * s + k[2] * kd];
}

// verts: 12 [lon, lat] in degrees. Returns faces as vertex triples, counter
// clockwise seen from outside, each with its centre and gnomonic frame.
export function icosahedron(verts) {
  const v = verts.map(([lon, lat]) => toXYZ(lon, lat));
  const near = (i, j) => Math.abs(Math.acos(Math.max(-1, Math.min(1, dot(v[i], v[j])))) - EDGE) < 1e-4;
  const faces = [];
  for (let i = 0; i < 12; i++)
    for (let j = i + 1; j < 12; j++) {
      if (!near(i, j)) continue;
      for (let k = j + 1; k < 12; k++) {
        if (!near(i, k) || !near(j, k)) continue;
        const c = unit(add(add(v[i], v[j]), v[k]));
        const ccw = dot(cross(sub(v[j], v[i]), sub(v[k], v[i])), c) > 0;
        const ids = ccw ? [i, j, k] : [i, k, j];
        const e1 = unit(sub(v[ids[0]], scale(c, dot(v[ids[0]], c))));
        faces.push({ v: ids, c, e1, e2: cross(c, e1) });
      }
    }
  if (faces.length !== 20) throw new Error(`icosahedron: ${faces.length} faces from these vertices, not 20`);
  // the distance from the centre to a face, with vertices on the unit sphere
  const inr = dot(v[faces[0].v[0]], faces[0].c);
  return { verts: v, faces, inradius: inr };
}

// Put the faces in a given order, such as a grid system's own numbering:
// faceId(c) names the face whose centre is c.
export function renumber(ico, faceId) {
  const faces = new Array(ico.faces.length);
  for (const f of ico.faces) {
    const id = faceId(f.c);
    if (faces[id]) throw new Error(`renumber: two faces called ${id}`);
    faces[id] = f;
  }
  return { ...ico, faces };
}

// the face a unit vector falls on: the one whose centre is nearest
export function faceOf(ico, p) {
  let best = 0, bd = -2;
  ico.faces.forEach((f, i) => { const d = dot(p, f.c); if (d > bd) { bd = d; best = i; } });
  return best;
}

// gnomonic: a unit vector to (x, y) on face f's plane, and back
export function toPlane(ico, f, p) {
  const F = ico.faces[f], w = dot(p, F.c);
  return [dot(p, F.e1) / w, dot(p, F.e2) / w];
}
export function fromPlane(ico, f, x, y) {
  const F = ico.faces[f];
  return unit([F.c[0] + x * F.e1[0] + y * F.e2[0], F.c[1] + x * F.e1[1] + y * F.e2[1], F.c[2] + x * F.e1[2] + y * F.e2[2]]);
}
// the face's three corners in its own plane (all faces alike, at radius
// tan of 37.38 deg from the centre)
export function corners(ico, f) {
  return ico.faces[f].v.map((i) => toPlane(ico, f, ico.verts[i]));
}

// Faces next to each other share two vertices.
function shared(a, b) {
  return a.v.filter((i) => b.v.includes(i));
}

// The strip net: top is the vertex the five upper faces share (by default
// the northernmost). The band of ten is cut between two of its faces and
// laid out as a path; each upper and lower face hangs off its band
// neighbour. Returns parent[f] (-1 at the root, the middle of the band) and
// the order the band runs in.
export function stripNet(ico, top) {
  const { faces, verts } = ico;
  if (top == null) top = verts.reduce((b, p, i) => (p[2] > verts[b][2] ? i : b), 0);
  const bottom = verts.reduce((b, p, i) => (dot(p, verts[top]) < dot(verts[b], verts[top]) ? i : b), 0);
  const upper = [], lower = [], band = [];
  faces.forEach((f, i) => (f.v.includes(top) ? upper : f.v.includes(bottom) ? lower : band).push(i));
  const nb = (i, set) => set.filter((j) => j !== i && shared(faces[i], faces[j]).length === 2);
  // walk the band eastward from the face the upper ring's first face sits on
  const ring = [nb(upper[0], band)[0]];
  const east = (i, j) => dot(cross(faces[i].c, faces[j].c), verts[top]) > 0;
  while (ring.length < band.length) {
    const last = ring[ring.length - 1], next = nb(last, band).filter((j) => !ring.includes(j));
    ring.push(next.length === 2 ? (east(last, next[0]) ? next[0] : next[1]) : next[0]);
  }
  const parent = new Array(20).fill(-1), root = ring[4];
  for (let k = 0; k < ring.length; k++) if (k !== 4) parent[ring[k]] = ring[k < 4 ? k + 1 : k - 1];
  for (const f of [...upper, ...lower]) parent[f] = nb(f, band)[0];
  return { parent, root, band: ring, top, bottom };
}

// Hinges for a net: for each face but the root, the edge it shares with its
// parent (on the folded solid, faces at distance 1) and the turn that lays
// it into the parent's plane.
export function hinges(ico, parent) {
  const open = Math.PI - DIHEDRAL, s = 1 / ico.inradius;
  return ico.faces.map((F, f) => {
    if (parent[f] < 0) return null;
    const P = ico.faces[parent[f]], [a, b] = shared(F, P);
    const pa = scale(ico.verts[a], s), pb = scale(ico.verts[b], s), axis = unit(sub(pb, pa));
    // the sign that brings this face's centre into the parent's plane
    const c = sub(F.c, pa);
    const sign = Math.abs(dot(add(rotate(c, axis, open), pa), P.c) - 1) < 1e-9 ? 1 : -1;
    return { pa, axis, angle: sign * open };
  });
}

// Where the point (x, y) on face f's plane sits as the faces open by a
// fraction `a` (0 folded, 1 flat), turning about each hinge from the face
// up to the root.
export function placer(ico, parent, hinge, f) {
  const chain = [];
  for (let k = f; parent[k] >= 0; k = parent[k]) chain.push(hinge[k]);
  const F = ico.faces[f];
  return (x, y, a) => {
    let p = [F.c[0] + x * F.e1[0] + y * F.e2[0], F.c[1] + x * F.e1[1] + y * F.e2[1], F.c[2] + x * F.e1[2] + y * F.e2[2]];
    if (a) for (const h of chain) p = add(rotate(sub(p, h.pa), h.axis, h.angle * a), h.pa);
    return p;
  };
}

// The flat net in 2D: each face's plane (x, y) to net coordinates in the
// root's plane, as an affine [a, b, c, d, e, f]: X = a x + b y + c, Y = d x + e y + f.
export function netAffines(ico, parent, hinge) {
  const R = ico.faces[parent.indexOf(-1)];
  const to2 = (p) => [dot(p, R.e1), dot(p, R.e2)];
  return ico.faces.map((F, f) => {
    const place = placer(ico, parent, hinge, f);
    const o = to2(place(0, 0, 1)), px = to2(place(1, 0, 1)), py = to2(place(0, 1, 1));
    return [px[0] - o[0], py[0] - o[0], o[0], px[1] - o[1], py[1] - o[1], o[1]];
  });
}
