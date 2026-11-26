// The Navigation page's ice-shelf cavity: BedMachine Antarctica v4.1 read
// over a box round an ice shelf (the geometry is src/core/cavity.js) and
// drawn as a block. On top is the ice, with its front where it stops over
// the sea; under the floating ice is its base, the roof of the cavity; then
// the bed, and a see-through sea surface over the open water. Down the
// block's four sides run bands of ice, water and rock (a band under the
// bed, as deep everywhere). A section cuts away
// the near side of the block and shows the same bands where it cuts.
// Heights are drawn times vx by stretching the block's z, so changing the
// exaggeration moves nothing else.

import * as THREE from "three";
import * as C from "../src/core/cavity.js";
import { openGeoTiff } from "./basemap-load.js";

export const cellWords = (d) => (d < 600 ? "500 m" : `${Math.round(d / 1000)} km`);

// The four layers over the plan's window, at its level of each file.
export async function readBedMachine(plan, status = () => {}) {
  const names = C.BEDMACHINE.layers, out = {};
  status(`Reading BedMachine v4.1 at ${cellWords(plan.d)} (${names.join(", ")}), ${plan.w} x ${plan.h} cells...`);
  await Promise.all(names.map(async (name) => {
    const tiff = await openGeoTiff(`${C.BEDMACHINE.base}${name}.tif`);
    const count = await tiff.getImageCount();
    let img = null;
    for (let i = 0; i < count && !img; i++) {
      const im = await tiff.getImage(i);
      if (im.getWidth() === plan.W) img = im;
    }
    if (!img) throw new Error(`${name}.tif has no level ${plan.W} cells wide`);
    const [band] = await img.readRasters({ window: [plan.c0, plan.r0, plan.c1, plan.r1], samples: [0] });
    out[name] = band;
  }));
  return out;
}

// scene units: the box's longer side is 6 across, its middle at 0, 0
export function frameOf(box) {
  return { s: 6 / Math.max(box.x1 - box.x0, box.y1 - box.y0), cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2 };
}

// colour ramps: [height, r, g, b] stops
const ramp = (stops) => (z) => {
  if (z <= stops[0][0]) return stops[0].slice(1);
  for (let i = 1; i < stops.length; i++) {
    const [z1, ...b] = stops[i];
    if (z <= z1) {
      const [z0, ...a] = stops[i - 1], t = (z - z0) / (z1 - z0);
      return a.map((v, k) => v + t * (b[k] - v));
    }
  }
  return stops[stops.length - 1].slice(1);
};
const iceTint = ramp([[0, 188, 205, 222], [1500, 226, 234, 243], [4000, 250, 252, 255]]);
const shelfTint = ramp([[0, 176, 204, 228], [150, 206, 224, 240]]);
const baseTint = ramp([[-2500, 46, 76, 112], [-1000, 98, 134, 170], [0, 176, 202, 224]]);
// the bed: sand to mud under water, so the cavity's floor is not the
// colour of its roof; grey-brown rock under the ice and on land
const floorTint = ramp([[-3000, 72, 58, 44], [-1000, 128, 104, 74], [0, 196, 172, 126]]);
const rockTint = ramp([[-2500, 66, 62, 58], [0, 108, 100, 92], [2500, 150, 142, 132]]);

const BAND = {
  ice: () => new THREE.MeshBasicMaterial({ color: 0xe4ecf5, side: THREE.DoubleSide }),
  water: () => new THREE.MeshBasicMaterial({ color: 0x2f7fc0, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }),
  rock: () => new THREE.MeshBasicMaterial({ color: 0x6b5644, side: THREE.DoubleSide })
};

export function cavityScene(cols, plan, box) {
  const fr = frameOf(box), { s, cx, cy } = fr, { w, h, d, x0, y0 } = plan, n = w * h, { kind, top, base, bed } = cols;
  const sample = C.columnSampler(cols, plan), view = C.shelfView(cols, plan);
  const gridBox = { x0, x1: x0 + (w - 1) * d, y0: y0 - (h - 1) * d, y1: y0 };
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < n; k++) if (kind[k] >= 0) { lo = Math.min(lo, bed[k]); hi = Math.max(hi, top[k]); }
  // the rock drawn under the bed: a band as deep everywhere
  const depth = Math.max(200, 0.08 * (hi - lo));

  // what the section cuts away: points on the negative side of the plane
  // (put far off when there is no section)
  const clip = new THREE.Plane(new THREE.Vector3(1, 0, 0), 1e9), planes = [clip];
  const group = new THREE.Group(), block = new THREE.Group();
  group.add(block);
  const sx = (x) => (x - cx) * s, sy = (y) => (y - cy) * s;

  function surface(zs, keep, tint, material) {
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        pos[3 * k] = sx(x0 + i * d); pos[3 * k + 1] = sy(y0 - j * d); pos[3 * k + 2] = zs ? zs[k] * s : 0;
        if (tint && kind[k] >= 0) { const c = tint(k); col[3 * k] = c[0] / 255; col[3 * k + 1] = c[1] / 255; col[3 * k + 2] = c[2] / 255; }
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    if (tint) g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(C.gridTriangles(w, h, keep), 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return new THREE.Mesh(g, material);
  }
  const lambert = (o = {}) => new THREE.MeshLambertMaterial({ vertexColors: true, clippingPlanes: planes, ...o });
  const ice = (k) => kind[k] >= 2, ok = (k) => kind[k] >= 0;
  const topKeep = (a, b, c) => ice(a) && ice(b) && ice(c);
  const iceTop = surface(top, topKeep, (k) => (kind[k] === 3 ? shelfTint(top[k]) : iceTint(top[k])), lambert());
  // the base where any corner floats, so it meets the bed at the grounding line
  const iceBase = surface(base, (a, b, c) => topKeep(a, b, c) && (kind[a] >= 3 || kind[b] >= 3 || kind[c] >= 3),
    (k) => baseTint(base[k]), lambert({ side: THREE.DoubleSide }));
  const bedMesh = surface(bed, (a, b, c) => ok(a) && ok(b) && ok(c),
    (k) => (kind[k] === 1 || kind[k] === 2 ? rockTint(bed[k]) : floorTint(bed[k])), lambert());
  // from beneath, the bed is a veil, so the cavity's roof shows through it
  const veil = new THREE.Mesh(bedMesh.geometry, new THREE.MeshBasicMaterial({ vertexColors: true, color: 0x55657a, transparent: true,
    opacity: 0.35, depthWrite: false, side: THREE.BackSide, clippingPlanes: planes }));
  veil.renderOrder = 3;
  const sea = surface(null, (a, b, c) => ok(a) && ok(b) && ok(c) && (kind[a] === 0 || kind[b] === 0 || kind[c] === 0), null,
    new THREE.MeshBasicMaterial({ color: 0x5b9bd5, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, clippingPlanes: planes }));
  sea.renderOrder = 2;

  // the ice front: a face from the top to the base along every edge where
  // the ice stops inside the box
  const edges = C.openEdges(w, h, topKeep), fp = [];
  const P = (k, z) => [sx(x0 + (k % w) * d), sy(y0 - Math.floor(k / w) * d), z[k] * s];
  for (let e = 0; e < edges.length; e += 2) {
    const p = edges[e], q = edges[e + 1];
    fp.push(...P(p, top), ...P(q, top), ...P(q, base), ...P(p, top), ...P(q, base), ...P(p, base));
  }
  const fg = new THREE.BufferGeometry();
  fg.setAttribute("position", new THREE.Float32BufferAttribute(fp, 3));
  fg.computeVertexNormals();
  const front = new THREE.Mesh(fg, new THREE.MeshLambertMaterial({ color: 0xdde8f3, side: THREE.DoubleSide, clippingPlanes: planes }));

  // bands down the block's four sides
  const colPt = (x, y, c) => (c ? { x: sx(x), y: sy(y), top: c.top * s, base: c.base * s, bed: c.bed * s } : null);
  const vertexPt = (i, j) => {
    const k = j * w + i;
    return kind[k] < 0 ? null : colPt(x0 + i * d, y0 - j * d, { top: top[k], base: base[k], bed: bed[k] });
  };
  const sides = { ice: [], water: [], rock: [] };
  const run = (len, at) => {
    const b = C.layerStrip(Array.from({ length: len }, (_, t) => at(t)), depth * s);
    for (const k of Object.keys(sides)) sides[k].push(...b[k]);
  };
  run(w, (i) => vertexPt(i, 0)); run(w, (i) => vertexPt(i, h - 1));
  run(h, (j) => vertexPt(0, j)); run(h, (j) => vertexPt(w - 1, j));
  const walls = Object.entries(sides).map(([k, a]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(a, 3));
    const m = BAND[k]();
    m.clippingPlanes = planes;
    const mesh = new THREE.Mesh(g, m);
    if (k === "water") mesh.renderOrder = 1;
    return mesh;
  });

  // the section: room for bands at every cell along the box's diagonal
  const most = Math.ceil(Math.hypot(w, h)) + 4;
  const sectionGroup = new THREE.Group();
  // (in the block's frame: drawn, it is stretched with the block)
  const sphere = new THREE.Sphere(new THREE.Vector3(), Math.hypot(4.3, Math.max(depth - lo, hi) * s) + 0.1);
  const section = ["ice", "water", "rock"].map((k) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(most * 18), 3));
    g.setDrawRange(0, 0);
    g.boundingSphere = sphere;
    const mesh = new THREE.Mesh(g, BAND[k]());
    mesh.userData.band = k;
    if (k === "water") mesh.renderOrder = 1;
    return mesh;
  });
  const rim = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd166 }));
  rim.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(most * 3), 3));
  rim.geometry.setDrawRange(0, 0);
  rim.geometry.boundingSphere = sphere;
  sectionGroup.add(...section, rim);
  sectionGroup.visible = false;

  // the picked place: a line from the top of its column to the bed, a bead
  // at the top, the base of floating ice, and the bed; drawn over everything
  const drop = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff6b5a, depthTest: false }));
  const beads = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xff6b5a, size: 9, sizeAttenuation: false, depthTest: false }));
  drop.renderOrder = beads.renderOrder = 5;
  drop.visible = beads.visible = false;

  block.add(bedMesh, veil, iceBase, iceTop, front, sea, ...walls, sectionGroup, drop, beads);

  let vx = 1;
  function setVx(v) { vx = v; block.scale.z = v; }

  // a section through x, y (scene units) whose plane faces nx, ny: what is
  // on the side it faces away from is cut away; null for none
  function setSection(p) {
    if (!p) { clip.normal.set(1, 0, 0); clip.constant = 1e9; sectionGroup.visible = false; return; }
    clip.normal.set(p.nx, p.ny, 0);
    clip.constant = -(p.nx * p.x + p.ny * p.y);
    const X = p.x / s + cx, Y = p.y / s + cy, tx = -p.ny, ty = p.nx, span = C.lineInBox(gridBox, X, Y, tx, ty);
    const pts = [];
    if (span) {
      const [t0, t1] = [span[0] + 1e-6 * d, span[1] - 1e-6 * d], steps = Math.min(most - 1, Math.max(1, Math.ceil((t1 - t0) / d)));
      for (let k = 0; k <= steps; k++) {
        const t = t0 + ((t1 - t0) * k) / steps, x = X + t * tx, y = Y + t * ty;
        pts.push(colPt(x, y, sample(x, y)));
      }
    }
    const b = C.layerStrip(pts, depth * s);
    for (const m of section) {
      const a = b[m.userData.band], attr = m.geometry.attributes.position;
      attr.array.set(a.length > attr.array.length ? a.slice(0, attr.array.length) : a);
      attr.needsUpdate = true;
      m.geometry.setDrawRange(0, Math.min(a.length, attr.array.length) / 3);
    }
    const ra = rim.geometry.attributes.position;
    let r = 0;
    for (const q of pts) if (q && r < most) { ra.array[3 * r] = q.x; ra.array[3 * r + 1] = q.y; ra.array[3 * r + 2] = q.top; r++; }
    ra.needsUpdate = true;
    rim.geometry.setDrawRange(0, r);
    sectionGroup.visible = true;
  }

  // Ice drawn solid, see-through, or not at all (its base still is)
  function setIce(mode) {
    iceTop.visible = front.visible = mode !== "off";
    for (const m of [iceTop.material, front.material]) {
      const see = mode === "see";
      m.transparent = see; m.opacity = see ? 0.35 : 1; m.depthWrite = !see; m.needsUpdate = true;
    }
  }

  // every material on the block cut by the section (the section's own
  // bands, which lie in its plane, and the picked line excepted): run again
  // after the wire meshes are made
  function clipAll() {
    block.traverse((o) => {
      if (!o.material || sectionGroup.children.includes(o) || o === drop || o === beads) return;
      o.material.clippingPlanes = planes;
    });
  }

  // scene point <-> map metres and metres of height
  const toMap = (p) => ({ x: p.x / s + cx, y: p.y / s + cy, z: p.z / (s * vx) });
  const fromMap = (x, y, z) => new THREE.Vector3(sx(x), sy(y), z * s * vx);

  function setPick(x, y) {
    const c = x === null ? null : sample(x, y);
    drop.visible = beads.visible = !!c;
    if (!c) return null;
    const X = sx(x), Y = sy(y), zs = [c.top, ...(c.base < c.top - 0.5 && c.base > c.bed + 0.5 ? [c.base] : []), c.bed];
    const pts = zs.map((z) => [X, Y, z * s]).flat();
    for (const [M, arr] of [[drop, [X, Y, c.top * s, X, Y, c.bed * s]], [beads, pts]]) {
      M.geometry.dispose();
      M.geometry = new THREE.BufferGeometry();
      M.geometry.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    }
    return c;
  }

  // What a ray meets, nearest first, on the side the section keeps and on
  // what is shown: [{ point, distance, what }], what being top, front,
  // base, bed (from above), under (the bed from beneath), sea, side or
  // section.
  const ROLE = new Map([[iceTop, "top"], [front, "front"], [iceBase, "base"], [sea, "sea"], ...walls.map((m) => [m, "side"]), ...section.map((m) => [m, "section"])]);
  function hits(ray) {
    if (!group.visible) return [];
    const out = [];
    const keep = (hit) => clip.distanceToPoint(hit.point) >= -1e-6;
    for (const [m, what] of ROLE) {
      if (!m.visible || (what === "section" && !sectionGroup.visible)) continue;
      for (const hit of ray.intersectObject(m, false)) if (what === "section" || keep(hit)) { out.push({ point: hit.point, distance: hit.distance, what }); break; }
    }
    bedMesh.material.side = THREE.DoubleSide;
    const bh = ray.intersectObject(bedMesh, false);
    bedMesh.material.side = THREE.FrontSide;
    for (const hit of bh) {
      if (!keep(hit)) continue;
      // the face's normal is in the block's frame: up is up, stretched or not
      out.push({ point: hit.point, distance: hit.distance, what: hit.face.normal.z * ray.ray.direction.z < 0 ? "bed" : "under" });
      break;
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  // the opening view: from the side of the shelf, the open sea on the
  // right, 25 degrees down onto the middle of the floating ice, half way
  // down its water; so a section facing the view runs from the sea,
  // through the ice front and along the cavity to the grounding line
  function defaultCam(v = vx) {
    if (!view) return [0, -5, 3, 0, 0, 0];
    const t = [sx(view.at[0]), sy(view.at[1]), view.mid * s * v], D = 7.5, e = (25 * Math.PI) / 180, [ex, ey] = view.sea;
    return [t[0] + D * Math.cos(e) * ey, t[1] - D * Math.cos(e) * ex, t[2] + D * Math.sin(e), ...t];
  }
  // the section that view opens with: upright through its pivot, facing
  // the way it looks, so from the sea along the cavity
  function openingSection() {
    if (!view) return null;
    const [ex, ey] = view.sea;
    return { x: sx(view.at[0]), y: sy(view.at[1]), nx: -ey, ny: ex };
  }

  return {
    group, block, frame: fr, plan, view, depth, lo, hi, sample, setVx, setSection, setIce, setPick, clipAll, hits, toMap, fromMap, defaultCam, openingSection,
    meshes: [iceTop, iceBase, bedMesh], what: "block"
  };
}
