// The Navigation page's other scenes: shapes as 3D programs try their
// cameras on (a teapot on a pedestal, three linked rings), a globe, and the
// king penguin of the Penguin datum page. Each stands on z, as the map
// does, so the page's turntable, orbit and trackball mean the same in all
// of them. A scene is { group, meshes (what a double-click finds), cam
// (the view it opens with), size (across, in scene units) }; drawAs()
// draws a scene's meshes solid, as a wire mesh, or both.

import * as THREE from "three";
import { TeapotGeometry } from "three/addons/geometries/TeapotGeometry.js";
import * as N from "../src/core/navigate.js";
import * as P from "../src/core/penguin.js";

const Z = new THREE.Vector3(0, 0, 1);

// The Utah teapot, stood upright on a pedestal no wider than its foot, so
// the spout (to +x) and the handle reach out over nothing and can be seen
// from below. three.js makes it with y up, as most 3D programs have it;
// here it is turned onto z like everything else, so an orbit about +y
// (three.js's own) has it on its side.
export function teapotScene() {
  const g = new TeapotGeometry(1, 14, true, true, true, true, true);
  g.rotateX(Math.PI / 2);
  g.computeBoundingBox();
  let b = g.boundingBox;
  const s = 3.2 / (b.max.x - b.min.x);
  g.scale(s, s, s);
  g.computeBoundingBox();
  b = g.boundingBox;
  g.translate(-(b.max.x + b.min.x) / 2, -(b.max.y + b.min.y) / 2, -b.min.z);
  const pot = new THREE.Mesh(g, new THREE.MeshPhongMaterial({ color: 0xe6dfd0, specular: 0x444444, shininess: 70 }));
  // the foot: how far out the teapot's lowest vertices reach
  const at = g.attributes.position.array;
  let foot = 0;
  for (let i = 0; i < at.length; i += 3) if (at[i + 2] < 0.02) foot = Math.max(foot, Math.hypot(at[i], at[i + 1]));
  const pg = new THREE.CylinderGeometry(foot * 1.05, foot * 1.25, 0.7, 96).rotateX(Math.PI / 2).translate(0, 0, -0.35);
  const plinth = new THREE.Mesh(pg, new THREE.MeshLambertMaterial({ color: 0x4a5566 }));
  // a mark on the pedestal's front, to see it go round
  const mark = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.04, 0.3), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
  mark.position.set(0, -foot * 1.15 - 0.01, -0.35);
  const group = new THREE.Group();
  group.add(pot, plinth, mark);
  const h = b.max.z - b.min.z;
  return { group, meshes: [pot, plinth], cam: [0, -6.6, 2.6, 0, 0, h / 2 - 0.2], size: 3.2, what: "teapot", height: h };
}

// Three rings in a chain at right angles (N.linkedRings): red about z,
// green about y, blue about x, each with its axis drawn through its hole,
// which shrinks to a dot when the view is straight through the ring.
export const RING_COLOURS = [[0xe4572e, "red"], [0x5fb947, "green"], [0x3d8bfd, "blue"]];
export function ringsScene() {
  const r = 1.15, rings = N.linkedRings(r), group = new THREE.Group(), meshes = [];
  rings.forEach((q, k) => {
    const [hex] = RING_COLOURS[k], ax = new THREE.Vector3(...q.axis);
    const m = new THREE.Mesh(new THREE.TorusGeometry(r, 0.1, 32, 144), new THREE.MeshPhongMaterial({ color: hex, specular: 0x333333, shininess: 50 }));
    m.quaternion.setFromUnitVectors(Z, ax);
    m.position.set(...q.centre);
    const c = new THREE.Vector3(...q.centre), a = c.clone().addScaledVector(ax, -1.25 * r), e = c.clone().addScaledVector(ax, 1.25 * r);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, e]), new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 0.7 }));
    group.add(m, line);
    meshes.push(m);
  });
  return { group, meshes, rings, cam: [3.2, -6.4, 3.4, 0, 0, 0], size: 3.6, what: "chain" };
}

// A globe, north on +z and 0 E on +x (N.globeXYZ): the sea, the coast and
// a graticule every 15 degrees, the equator brighter, and a pin out of
// each pole, red at the north.
export const GLOBE_R = 2.5;
export function globeScene() {
  const R = GLOBE_R, group = new THREE.Group();
  const sg = new THREE.SphereGeometry(R, 128, 64).rotateX(Math.PI / 2);
  const globe = new THREE.Mesh(sg, new THREE.MeshLambertMaterial({ color: 0x1c4a78 }));
  const lines = (pts, color, opacity) => {
    const o = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    o.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return o;
  };
  // a lon/lat polyline as segments just off the surface
  const seg = (ll, out, r = R * 1.002) => {
    for (let i = 2; i < ll.length; i += 2) out.push(...N.globeXYZ(ll[i - 2], ll[i - 1], r), ...N.globeXYZ(ll[i], ll[i + 1], r));
  };
  const grat = [], eq = [];
  for (let lon = -180; lon < 180; lon += 15) { const l = []; for (let lat = -90; lat <= 90; lat += 1) l.push(lon, lat); seg(l, grat); }
  for (let lat = -75; lat <= 75; lat += 15) {
    const l = [];
    for (let lon = -180; lon <= 180; lon += 1) l.push(lon, lat);
    seg(l, lat === 0 ? eq : grat);
  }
  const coast = lines([], 0xf1f4f8, 0.9);
  group.add(globe, lines(grat, 0x8fa3bd, 0.4), lines(eq, 0xffd166, 0.8), coast);
  for (const [s, hex] of [[1, 0xe4572e], [-1, 0xdbe7f5]]) {
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 16).rotateX(Math.PI / 2), new THREE.MeshLambertMaterial({ color: hex }));
    pin.position.set(0, 0, s * (R + 0.25));
    group.add(pin);
  }
  // coastlines when they come: lon/lat polylines and closed rings
  function setCoast(world, rings) {
    const out = [];
    for (const l of world) seg(l, out);
    for (const r of rings) seg([...r, r[0], r[1]], out);
    coast.geometry.dispose();
    coast.geometry = new THREE.BufferGeometry();
    coast.geometry.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  }
  // the opening view: from over 25 S 140 E
  const c = N.globeXYZ(140, -25, 9.5);
  return { group, meshes: [globe], setCoast, cam: [...c, 0, 0, 0], size: 2 * R, what: "globe" };
}

// The king penguin of the Penguin datum page (src/core/penguin.js): its
// smooth union of ellipsoids as a surface-nets mesh, coloured as its
// plumage, belly to the front (-y), standing on a see-through floe. Under
// its beak, inside its flippers and on top of its feet are the places no
// ray from its centre leaves it last, so no penguin lon/lat reaches them.
export function penguinScene() {
  const field = P.makeField(), grid = P.sampleGrid(field.F, 96), mesh = P.surfaceNets(grid);
  const { positions, index } = mesh, nv = positions.length / 3, o = grid.centroid, s = 1.6;
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
  let zmin = Infinity;
  for (let q = 0; q < nv; q++) {
    const x = positions[3 * q], y = positions[3 * q + 1], z = positions[3 * q + 2], n = P.normalAt(field.F, x, y, z);
    // body x (the belly) to -y, body y (its left) to +x, z up
    pos[3 * q] = (y - o[1]) * s; pos[3 * q + 1] = -(x - o[0]) * s; pos[3 * q + 2] = (z - o[2]) * s;
    nrm[3 * q] = n[1]; nrm[3 * q + 1] = -n[0]; nrm[3 * q + 2] = n[2];
    col.set(P.plumage(field.parts[field.which(x, y, z)].id, [x, y, z], n), 3 * q);
    zmin = Math.min(zmin, pos[3 * q + 2]);
  }
  for (let q = 0; q < nv; q++) pos[3 * q + 2] -= zmin;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const bird = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  const floe = new THREE.Mesh(new THREE.CircleGeometry(2.4, 96),
    new THREE.MeshBasicMaterial({ color: 0xdfe8f2, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }));
  floe.renderOrder = 2;
  const group = new THREE.Group();
  group.add(bird, floe);
  const h = g.boundingBox.max.z;
  return { group, meshes: [bird, floe], cam: [2.2, -7.0, 2.6, 0, 0, h / 2], size: h, what: "penguin", height: h };
}

// Draw a scene's meshes solid, as a wire mesh (the edges of their
// triangles, and nothing of the solid: what is behind shows through), or
// both (the solid, with its edges dark over it). The wire is a second
// mesh on the same geometry, made the first time, and never picked: a
// double-click still finds the mesh itself.
export function drawAs(meshes, mode) {
  for (const m of meshes) {
    if (m.material.transparent) continue; // a floe or veil stays as it is
    let w = m.userData.wire;
    if (!w && mode !== "solid") {
      const vc = !!m.material.vertexColors;
      const lit = new THREE.MeshBasicMaterial({ wireframe: true, vertexColors: vc, color: vc ? 0xffffff : m.material.color });
      const dark = new THREE.MeshBasicMaterial({ wireframe: true, color: 0x0b1220, transparent: true, opacity: 0.4 });
      w = new THREE.Mesh(m.geometry, lit);
      w.userData.materials = { lit, dark };
      w.raycast = () => {};
      m.add(w);
      m.userData.wire = w;
    }
    m.material.visible = mode !== "wire";
    m.material.polygonOffset = mode === "both";
    m.material.polygonOffsetFactor = 1;
    m.material.polygonOffsetUnits = 1;
    m.material.needsUpdate = true;
    if (w) {
      w.visible = mode !== "solid";
      w.material = mode === "wire" ? w.userData.materials.lit : w.userData.materials.dark;
    }
  }
}
