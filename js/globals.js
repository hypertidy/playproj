// playproj: globals and interrupteds.
//
// Whole-sphere formulas have no light, cone or cylinder to trace, so the
// surface here is the map itself: a grid over each lobe in longitude and
// latitude, every node with its place on the globe and its place on the
// map. Unfold rolls the map out from the globe, so the cuts between lobes
// (and the seam) open up; Interrupt moves each lobe's central meridian from
// the map's own to the lobe's. The butterfly unfolds in two steps instead:
// the globe falls onto an octahedron along rays from its centre (the
// gnomonic projection), then the octahedron's faces open flat.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as fam from "../src/core/families/globals.js";
import { samplePoints, evenSpacing, SAMPLE_MODES } from "../src/core/landmesh.js";
import { loadCoastline } from "./data.js";
import { graticule } from "../src/core/geo.js";
import { sources } from "../src/core/basemap.js";
import { loadWorld, readWindow } from "./basemap-load.js";
import { writeGeoTIFF, esriGeoKeys } from "../src/core/geotiff-write.js";
import { crsGeoKeys } from "../src/core/cellexport.js";
import { saveBlob } from "./download.js";
import { displace, hasElevation } from "./relief.js";

const D2R = Math.PI / 180;
const DEG = "\u00b0";
const MAX_RAYS = 5000;
const SQRT3 = Math.sqrt(3);

const COLORS = {
  bg: 0x05070d,
  globe: 0x1e6fd9,
  coastOn: 0xd7ecff,
  grat: 0x2c4a73,
  surface: 0x3fa7a0,
  surfCoast: 0x6ab787,
  surfGrat: 0x2f6b66,
  cut: 0xffb347,
  link: 0x9aa3ad
};

// ---------------------------------------------------------------- state

const defaults = {
  base: fam.defaults.base, lobes: fam.defaults.lobes, gores: fam.defaults.gores, s: fam.defaults.s, lon0: fam.defaults.lon0,
  t: 0.6, links: 120, seed: 1, from: "tri", detail: "110m", cuts: 1, grat: 1, globe: 1, bm: "none", relief: 0, wire: 0, spin: 0, lobe: -1, cam: null
};
const BUTTERFLY_EDGE = -20; // Cahill-Keyes puts an octahedron edge on 20 W
const state = { ...defaults };
const embed = new URLSearchParams(location.search).has("embed");

const wrap180 = (v) => +(((v + 540) % 360) - 180).toFixed(4);
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  for (const k of Object.keys(defaults)) {
    if (!h.has(k)) continue;
    const raw = h.get(k);
    if (k === "base") state.base = raw in fam.BASES ? raw : defaults.base;
    else if (k === "lobes") state.lobes = raw in fam.LOBES ? raw : defaults.lobes;
    else if (k === "detail") state.detail = raw === "50m" ? "50m" : "110m";
    else if (k === "from") state.from = SAMPLE_MODES.includes(raw) ? raw : "tri";
    else if (k === "bm") state.bm = raw in sources ? raw : "none";
    else if (k === "cam") {
      const c = raw.split(",").map(Number);
      if (c.length === 6 && c.every(isFinite)) state.cam = c;
    } else if (isFinite(+raw)) state[k] = +raw;
  }
  state.lon0 = wrap180(state.lon0);
  state.t = Math.max(0, Math.min(1, state.t));
  state.s = Math.max(0, Math.min(1, state.s));
  state.gores = Math.max(2, Math.min(24, Math.round(state.gores)));
  state.links = Math.max(0, Math.min(MAX_RAYS, Math.round(state.links)));
  state.relief = Math.max(0, Math.min(100, state.relief));
}

let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const h = new URLSearchParams();
    for (const k of Object.keys(defaults)) {
      if (k === "cam") { if (state.cam) h.set("cam", state.cam.map((x) => +x.toFixed(2)).join(",")); continue; }
      const val = typeof state[k] === "number" ? +state[k].toFixed(4) : state[k];
      if (val !== defaults[k]) h.set(k, String(val));
    }
    const s = h.toString();
    history.replaceState(null, "", s ? "#" + s : location.pathname + location.search);
  }, 200);
}

const params = () => ({ base: state.base, lobes: state.lobes, gores: state.gores, s: state.s, lon0: state.lon0 });
const pkey = (p) => `${p.base},${p.lobes},${p.gores},${p.s},${p.lon0}`;
const isLobed = () => fam.BASES[state.base].lobes && state.lobes !== "none";

// ---------------------------------------------------------------- geometry

// The scene has north up (+y). On the globe, relative longitude 0 faces +z;
// the flat map stands in the plane z = 1, touching the globe there. The
// butterfly's net lies flat on top instead, in the plane y = sqrt(3) that
// touches the octahedron's North Pole vertex.
function onGlobe(lam, phi, out, i = 0) {
  const cp = Math.cos(phi * D2R);
  out[i] = cp * Math.sin(lam * D2R);
  out[i + 1] = Math.sin(phi * D2R);
  out[i + 2] = cp * Math.cos(lam * D2R);
  return out;
}
// the family's frame (x to lam = 0, y to lam = 90, z north) into the scene's
const toScene = (v) => [v[1], v[2], v[0]];

// A point of the map: everything the morph needs, computed once per map.
//   S: on the globe; X, Y: on the flat map (relative to the touch point);
//   for the butterfly also the face and the point's place on the face.
function mapPoint(map, q, lam, phi) {
  const S = onGlobe(lam, phi, [0, 0, 0]);
  const xy = q.flat(lam, phi);
  const pt = { S, x: xy[0], y: xy[1], q };
  return pt;
}

// Butterfly faces, unfolded like a paper model. Each northern face turns
// about the North Pole vertex, which stays put, from its place on the
// octahedron to its place on the net; each southern face hangs from its
// northern twin on their shared equator edge, its hinge opening from the
// octahedron's fold to flat at the same time.
const FOLD = Math.PI - Math.acos(-1 / 3); // 70.53 degrees: 180 less the dihedral angle
const POLE = new THREE.Vector3(0, SQRT3, 0);
function facePoses(map) {
  const net = (q, x, y) => {
    const c = Math.cos(q.theta), s = Math.sin(q.theta);
    return new THREE.Vector3(c * x - s * y + q.T[0], SQRT3, -(s * x + c * y + q.T[1]));
  };
  const frames = (q) => {
    const F = q.frame, c = Math.cos(q.theta), s = Math.sin(q.theta);
    const m0 = new THREE.Matrix4().makeBasis(new THREE.Vector3(...toScene(F.e)), new THREE.Vector3(...toScene(F.u)), new THREE.Vector3(...toScene(F.n)));
    const m1 = new THREE.Matrix4().makeBasis(new THREE.Vector3(c, 0, -s), new THREE.Vector3(-s, 0, -c), new THREE.Vector3(0, 1, 0));
    return { m0, m1, n: toScene(F.n) };
  };
  for (const q of map.pieces) {
    const f = frames(q);
    // the rotation taking the face from the net to the octahedron
    const r = new THREE.Matrix4().multiplyMatrices(f.m0, f.m1.clone().transpose());
    q.pose = { n: f.n, r: new THREE.Quaternion().setFromRotationMatrix(r) };
  }
  for (const q of map.pieces) {
    if (q.hemi !== "s") continue;
    const twin = map.pieces[q.k], [a, b] = q.cut;
    const A = net(twin, ...fam.gnomFace(twin, a, 0)), B = net(twin, ...fam.gnomFace(twin, b, 0));
    q.pose.twin = twin;
    q.pose.edge = A;
    q.pose.axis = B.clone().sub(A).normalize();
    // fold the way that puts the face on the octahedron
    const local = [0.1, -0.2], want = new THREE.Vector3(...faceOnOcta(q, ...local));
    const P = net(q, ...local);
    q.pose.sign = 1;
    const one = hingeAt(q, P, 0, new THREE.Vector3()).distanceTo(want);
    q.pose.sign = -1;
    const two = hingeAt(q, P, 0, new THREE.Vector3()).distanceTo(want);
    q.pose.sign = one < two ? 1 : -1;
  }
}
function faceOnOcta(q, x, y) {
  const F = q.frame, v = [0, 1, 2].map((k) => F.n[k] + x * F.e[k] + y * F.u[k]);
  return toScene(v);
}
const tmpQ = new THREE.Quaternion(), tmpH = new THREE.Quaternion(), IDQ = new THREE.Quaternion();
// a net point P of face q at unfold u (0 on the octahedron, 1 flat)
function hingeAt(q, P, u, out) {
  out.copy(P);
  const pose = q.pose;
  if (pose.twin) {
    tmpH.setFromAxisAngle(pose.axis, pose.sign * FOLD * (1 - u));
    out.sub(pose.edge).applyQuaternion(tmpH).add(pose.edge);
  }
  tmpQ.slerpQuaternions((pose.twin || q).pose.r, IDQ, u);
  return out.sub(POLE).applyQuaternion(tmpQ).add(POLE);
}

// Where a map point sits at unfold t.
const tmpV = new THREE.Vector3(), tmpN = new THREE.Vector3();
function morph(map, pt, t, out, i = 0) {
  if (map.butterfly) {
    const P = pt.q.pose;
    if (t <= 0.5) {
      // straight out along the ray from the centre, onto the face
      const w = 2 * t, d = pt.S[0] * P.n[0] + pt.S[1] * P.n[1] + pt.S[2] * P.n[2];
      for (let k = 0; k < 3; k++) out[i + k] = (1 - w) * pt.S[k] + (w * pt.S[k]) / d;
      return out;
    }
    // then the octahedron opens out flat
    tmpN.set(pt.x, SQRT3, -pt.y);
    hingeAt(pt.q, tmpN, 2 * t - 1, tmpV);
    out[i] = tmpV.x; out[i + 1] = tmpV.y; out[i + 2] = tmpV.z;
    return out;
  }
  // the map rolled onto a cylinder whose radius grows from the globe's to
  // infinity, while every point moves from the globe onto it
  const X = pt.x - map.ox, Y = pt.y - map.oy;
  if (t >= 1) { out[i] = X; out[i + 1] = Y; out[i + 2] = 1; return out; }
  const rho = 1 / (1 - t), a = X / rho;
  const cx = rho * Math.sin(a), cz = 1 - rho + rho * Math.cos(a);
  out[i] = (1 - t) * pt.S[0] + t * cx;
  out[i + 1] = (1 - t) * pt.S[1] + t * Y;
  out[i + 2] = (1 - t) * pt.S[2] + t * cz;
  return out;
}

// ---------------------------------------------------------------- scene

const stage = document.getElementById("three");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(COLORS.bg);
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const DEFAULT_CAM = [2.6, 2.3, 8.2, 0, 0.1, 0.6];
const BUTTERFLY_CAM = [0.5, 11, 8.5, 0, 0.6, 0];
const defaultCam = () => (state.base === "butterfly" ? BUTTERFLY_CAM : DEFAULT_CAM);
function setCamera(c) {
  camera.position.set(c[0], c[1], c[2]);
  controls.target.set(c[3], c[4], c[5]);
  controls.update();
}
setCamera(DEFAULT_CAM);
controls.addEventListener("end", () => {
  const p = camera.position, t = controls.target;
  state.cam = [p.x, p.y, p.z, t.x, t.y, t.z];
  writeHash();
});

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(3, 5, 4);
scene.add(sun);

const globe = new THREE.Mesh(
  new THREE.BufferGeometry(),
  new THREE.MeshPhongMaterial({ color: COLORS.globe, transparent: true, opacity: 0.25, shininess: 30, depthWrite: false })
);
scene.add(globe);

const surface = new THREE.Mesh(
  new THREE.BufferGeometry(),
  new THREE.MeshBasicMaterial({ color: COLORS.surface, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false })
);
scene.add(surface);

function gridIndex(nx, ny, base = 0, idx = []) {
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = base + j * (nx + 1) + i, b = a + nx + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  return idx;
}

const globeGrids = {};
function globeGrid(nx, ny) {
  if (!globeGrids[nx]) {
    const uv = [];
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++) uv.push(i / nx, 1 - j / ny);
    globeGrids[nx] = { index: gridIndex(nx, ny), uv };
  }
  return globeGrids[nx];
}
const reliefOn = () => state.relief > 0 && hasElevation(world);

function setMesh(mesh, pos, uv, index, normals) {
  mesh.geometry.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  if (normals) g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  mesh.geometry = g;
}

const layers = {};
function setLines(name, positions, color, opacity = 1, order = 0) {
  let obj = layers[name];
  if (!obj) {
    obj = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }));
    obj.renderOrder = order;
    layers[name] = obj;
    scene.add(obj);
  }
  obj.geometry.dispose();
  obj.geometry = new THREE.BufferGeometry();
  obj.geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return obj;
}

// ---------------------------------------------------------------- data

let coast = [];
const grat = graticule(15, 2);
let linkPool = [];

function buildLinkPool() {
  linkPool = samplePoints(coast, state.from, state.seed, MAX_RAYS);
}

// ---------------------------------------------------------------- the map

// Everything about the current map that does not depend on unfold: the
// surface grid of each piece, the cut outlines, and the coastlines and
// graticule split where they cross a cut. Cached on the map parameters.
let cur = null;

function currentMap() {
  const p = params(), key = pkey(p) + "|" + state.detail + "|" + (reliefOn() ? (state.wire ? "w" : "r") : "");
  if (cur && cur.key === key) return cur;
  const map = fam.makeMap(p);
  if (map.butterfly) { facePoses(map); map.ox = map.oy = 0; }
  else { const o = map.locate(0, 0).flat(0, 0); map.ox = o[0]; map.oy = o[1]; }
  const relief = reliefOn();
  const step = relief ? (state.wire ? 1 : 0.5) : 2;
  cur = { key, p, map, mesh: surfaceMesh(map, step), outlines: outlines(map), coast: splitLines(map, coast), grat: splitLines(map, grat) };
  cur.box = flatBox(cur.outlines);
  return cur;
}

// the absolute longitude of relative longitude 0, for texture coordinates
const lonOf = (map) => fam.wrapDeg(-map.rel(0));

function surfaceMesh(map, step) {
  const pts = [], uv = [], index = [], ll = [];
  const L0 = lonOf(map);
  for (const q of map.pieces) {
    const base = pts.length;
    if (map.butterfly) {
      // a triangle grid over the face, through the octahedron's plane
      const N = Math.max(8, Math.round(90 / step));
      const [a, b, p0, p1] = q.bounds, north = q.hemi === "n";
      const corner = (lam, phi) => onGlobe(lam, phi, [0, 0, 0]);
      const P = corner(q.lamC, north ? 90 : -90), A = corner(a, 0), B = corner(b, 0);
      const F = toScene(q.frame.n);
      const onFace = (v) => { const d = v[0] * F[0] + v[1] * F[1] + v[2] * F[2]; return v.map((c) => c / d); };
      const fP = onFace(P), fA = onFace(A), fB = onFace(B);
      for (let i = 0; i <= N; i++)
        for (let j = 0; j <= N - i; j++) {
          const wa = j / N, wp = i / N, wb = 1 - wa - wp;
          const v = [0, 1, 2].map((k) => wp * fP[k] + wa * fA[k] + wb * fB[k]);
          const r = Math.hypot(...v);
          let phi = Math.asin(v[1] / r) / D2R;
          let lam = i === N ? q.lamC : Math.atan2(v[0], v[2]) / D2R;
          lam = q.lamC + fam.wrapDeg(lam - q.lamC);
          lam = Math.max(a, Math.min(b, lam));
          if (i === N) phi = north ? 90 : -90;
          pts.push(mapPoint(map, q, lam, phi));
          uv.push((lam + L0 + 180) / 360, (phi + 90) / 180);
          ll.push(lam + L0, phi);
        }
      // rows of the triangle grid: row i has N - i + 1 nodes
      const row = (i) => base + i * (N + 1) - (i * (i - 1)) / 2;
      for (let i = 0; i < N; i++)
        for (let j = 0; j < N - i; j++) {
          const a0 = row(i) + j, a1 = a0 + 1, b0 = row(i + 1) + j;
          index.push(a0, a1, b0);
          if (j < N - i - 1) index.push(a1, b0 + 1, b0);
        }
      continue;
    }
    const [a, b, p0, p1] = q.bounds;
    const nx = Math.max(2, Math.ceil((b - a) / step)), ny = Math.ceil((p1 - p0) / step);
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++) {
        const lam = a + ((b - a) * i) / nx, phi = p1 - ((p1 - p0) * j) / ny;
        pts.push(mapPoint(map, q, lam, phi));
        uv.push((lam + L0 + 180) / 360, (phi + 90) / 180);
        ll.push(lam + L0, phi);
      }
    gridIndex(nx, ny, base, index);
  }
  return { pts, uv, index, ll };
}

// Each piece's edge, as a closed line in relative lon/lat.
function outlines(map) {
  const out = [];
  for (const q of map.pieces) {
    const [a, b, p0, p1] = q.bounds, line = [];
    const add = (lam, phi) => line.push(mapPoint(map, q, lam, phi));
    for (let phi = p0; phi < p1; phi += 1) add(a, phi);
    for (let lam = a; lam < b; lam += 1) add(lam, p1);
    for (let phi = p1; phi > p0; phi -= 1) add(b, phi);
    for (let lam = b; lam > a; lam -= 1) add(lam, p0);
    add(a, p0);
    out.push(line);
  }
  return out;
}

// Lines (flat [lon, lat, ...] arrays) as runs of map points, broken where a
// segment crosses from one piece to another or over the seam. The crossing
// is found by bisection and both runs end on it, so lines reach the cuts.
function splitLines(map, lines) {
  const runs = [];
  for (const line of lines) {
    let run = [];
    for (let i = 0; i < line.length; i += 2) {
      const lamB = map.rel(line[i]), phiB = line[i + 1];
      if (i === 0) { run.push(mapPoint(map, map.locate(lamB, phiB), lamB, phiB)); continue; }
      const lamA = map.rel(line[i - 2]), phiA = line[i - 1];
      // B unwrapped to within 180 degrees of A, exactly lamB plus a whole turn
      const uA = lamA, uB = lamB + 360 * Math.round((lamA + fam.wrapDeg(lamB - lamA) - lamB) / 360);
      const at = (f) => [uA + (uB - uA) * f, phiA + (phiB - phiA) * f];
      const pieceAt = (f) => { const [l, p] = at(f); return map.locate(fam.wrapDeg(l), p); };
      // a change of piece, or of side of the seam
      const code = (f) => pieceAt(f).id + ":" + Math.floor((at(f)[0] + 180) / 360);
      let f0 = 0;
      for (let guard = 0; guard < 8 && code(f0) !== code(1); guard++) {
        let lo = f0, hi = 1;
        const k0 = code(f0);
        for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (code(m) === k0) lo = m; else hi = m; }
        const [la, pa] = at(lo), [lb, pb] = at(hi);
        run.push(pointIn(map, pieceAt(lo), la, pa));
        if (run.length > 1) runs.push(run);
        run = [pointIn(map, pieceAt(hi), lb, pb)];
        f0 = hi;
      }
      run.push(mapPoint(map, map.locate(lamB, phiB), lamB, phiB));
    }
    if (run.length > 1) runs.push(run);
  }
  return runs;
}

// a map point in a given piece, its longitude brought into the piece's band
function pointIn(map, q, lam, phi) {
  lam = fam.wrapDeg(lam);
  const [a, b] = q.bounds;
  if (lam < a - 1e-6) lam += 360;
  if (lam > b + 1e-6) lam -= 360;
  lam = Math.max(a, Math.min(b, lam));
  phi = Math.max(-90, Math.min(90, phi));
  return mapPoint(map, q, lam, phi);
}

function flatBox(lines) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const line of lines)
    for (const pt of line) {
      x0 = Math.min(x0, pt.x); x1 = Math.max(x1, pt.x);
      y0 = Math.min(y0, pt.y); y1 = Math.max(y1, pt.y);
    }
  return [x0, y0, x1, y1];
}

// ---------------------------------------------------------------- rebuild

function rebuild() {
  const c = currentMap(), { map } = c, t = state.t;
  const A = [0, 0, 0], B = [0, 0, 0];
  const L0 = lonOf(map);

  // the globe, finer and raised when it carries relief
  const relief = reliefOn();
  const GX = relief ? (state.wire ? 180 : 360) : 144, GY = GX / 2, gGrid = globeGrid(GX, GY);
  const gp = new Float32Array((GX + 1) * (GY + 1) * 3);
  for (let j = 0, k = 0; j <= GY; j++)
    for (let i = 0; i <= GX; i++, k += 3) onGlobe(-180 + (360 * i) / GX - L0, 90 - (180 * j) / GY, gp, k);
  const gn = relief
    ? displace(gp, gGrid.index, (k) => [-180 + (360 * (k % (GX + 1))) / GX, 90 - (180 * Math.floor(k / (GX + 1))) / GY], world, state.relief)
    : gp.slice();
  setMesh(globe, gp, gGrid.uv, gGrid.index, gn);
  globe.visible = !!state.globe;
  globe.material.wireframe = surface.material.wireframe = relief && !!state.wire;
  globe.material.depthWrite = relief;
  globe.material.opacity = relief ? 0.95 : world ? 0.35 : 0.25;

  // the surface
  const m = c.mesh, sp = new Float32Array(m.pts.length * 3);
  for (let k = 0; k < m.pts.length; k++) morph(map, m.pts[k], t, sp, 3 * k);
  if (relief) displace(sp, m.index, (k) => [m.ll[2 * k], m.ll[2 * k + 1]], world, state.relief);
  setMesh(surface, sp, m.uv, m.index);

  // cuts and lobe edges
  const cuts = [];
  if (state.cuts)
    for (const line of c.outlines)
      for (let i = 1; i < line.length; i++) cuts.push(...morph(map, line[i - 1], t, A), ...morph(map, line[i], t, B));
  setLines("cuts", cuts, COLORS.cut, 0.85, 4).visible = !!state.cuts;

  // coastlines and graticule, on the globe and on the surface
  const drawRuns = (runs, surfOut) => {
    for (const run of runs)
      for (let i = 1; i < run.length; i++) surfOut.push(...morph(map, run[i - 1], t, A), ...morph(map, run[i], t, B));
  };
  const drawGlobe = (lines, out) => {
    for (const line of lines)
      for (let i = 2; i < line.length; i += 2) {
        onGlobe(line[i - 2] - L0, line[i - 1], A); onGlobe(line[i] - L0, line[i + 1], B);
        out.push(...A, ...B);
      }
  };
  const cg = [], cs = [], gg = [], gs = [];
  if (state.globe) drawGlobe(coast, cg);
  if (state.globe && state.grat) drawGlobe(grat, gg);
  drawRuns(c.coast, cs);
  if (state.grat) drawRuns(c.grat, gs);
  setLines("coastGlobe", cg, COLORS.coastOn, 0.6).visible = !!state.globe;
  setLines("coastSurf", cs, COLORS.surfCoast, 1, 3);
  setLines("gratGlobe", gg, COLORS.grat, 0.45).visible = !!state.grat && !!state.globe;
  setLines("gratSurf", gs, COLORS.surfGrat, 0.8, 1).visible = !!state.grat;

  // links from the globe to the surface
  const links = [];
  let count = 0;
  for (const [lon, lat] of linkPool) {
    if (count >= state.links && state.from !== "even") break;
    const lam = map.rel(lon), pt = mapPoint(map, map.locate(lam, lat), lam, lat);
    links.push(...pt.S, ...morph(map, pt, t, A));
    count++;
  }
  setLines("links", links, COLORS.link, 0.35, 1);

  scheduleFlat(c);
  drawMap(c);
  updatePanel(c);
}

// ---------------------------------------------------------------- basemap

let world = null, worldTexture = null;

function applyBasemapMaterials() {
  const gm = globe.material, sm = surface.material;
  if (world) {
    if (!worldTexture || worldTexture.image !== world.canvas) {
      worldTexture = new THREE.CanvasTexture(world.canvas);
      worldTexture.colorSpace = THREE.SRGBColorSpace;
      worldTexture.wrapS = THREE.RepeatWrapping;
    }
    gm.map = worldTexture; gm.color.set(0xffffff);
    sm.map = worldTexture; sm.color.set(0xffffff); sm.opacity = 0.92;
  } else {
    gm.map = null; gm.color.set(COLORS.globe);
    sm.map = null; sm.color.set(COLORS.surface); sm.opacity = 0.2;
  }
  flatImage = null;
  gm.needsUpdate = sm.needsUpdate = true;
}

// The flat map with its basemap: the surface laid flat (positions are the
// map's own x, y), drawn by the GPU into an image. The same image, larger,
// is the GeoTIFF export.
const flatScene = new THREE.Scene();
const flatMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
flatScene.add(flatMesh);

function renderFlat(mesh, box, nx, ny, texture = worldTexture) {
  const pos = new Float32Array(mesh.pts.length * 3);
  mesh.pts.forEach((pt, k) => { pos[3 * k] = pt.x; pos[3 * k + 1] = pt.y; });
  flatMesh.geometry.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(mesh.uv, 2));
  g.setIndex(mesh.index);
  flatMesh.geometry = g;
  flatMesh.material.map = texture;
  flatMesh.material.needsUpdate = true;
  const cam = new THREE.OrthographicCamera(box[0], box[2], box[3], box[1], -1, 1);
  const rt = new THREE.WebGLRenderTarget(nx, ny, { colorSpace: THREE.SRGBColorSpace });
  const clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(flatScene, cam);
  const buf = new Uint8Array(nx * ny * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, nx, ny, buf);
  renderer.setRenderTarget(null);
  renderer.setClearColor(clear, alpha);
  rt.dispose();
  // rows come back bottom up
  const out = new Uint8ClampedArray(nx * ny * 4), row = nx * 4;
  for (let j = 0; j < ny; j++) out.set(buf.subarray((ny - 1 - j) * row, (ny - j) * row), j * row);
  return out;
}

let flatImage = null, flatTimer = 0;
const flatCanvas = document.createElement("canvas");
function scheduleFlat(c) {
  if (!world || (flatImage && flatImage.key === c.key + state.bm)) return;
  clearTimeout(flatTimer);
  flatTimer = setTimeout(() => {
    const now = currentMap();
    const [x0, y0, x1, y1] = now.box, nx = 1024, ny = Math.max(1, Math.round((nx * (y1 - y0)) / (x1 - x0)));
    flatCanvas.width = nx; flatCanvas.height = ny;
    flatCanvas.getContext("2d").putImageData(new ImageData(renderFlat(now.mesh, now.box, nx, ny), nx, ny), 0, 0);
    flatImage = { key: now.key + state.bm };
    drawMap(now);
  }, 120);
}

async function setBasemap() {
  const id = state.bm;
  writeHash();
  ui.credit.innerHTML = sources[id].credit || "";
  if (id === "none") {
    world = null; ui.bmStatus.textContent = ""; applyBasemapMaterials(); cur = null; sync();
    return;
  }
  try {
    const w = await loadWorld(id, (msg) => { if (state.bm === id) ui.bmStatus.textContent = msg; });
    if (state.bm !== id) return;
    world = w;
    ui.bmStatus.textContent = "";
  } catch (e) {
    if (state.bm !== id) return;
    world = null;
    ui.bmStatus.textContent = `${sources[id].label} did not load (${e.message}). Check the connection and try again.`;
  }
  applyBasemapMaterials();
  cur = null;
  sync();
}

async function downloadTIF() {
  const p = params(), wkt = fam.geoWkt(p);
  if (!world || !wkt) return;
  const size = +ui.tifSize.value, R = fam.R;
  const label = ui.tif.textContent;
  ui.tif.textContent = "Rendering...";
  ui.tif.disabled = true;
  await new Promise((r) => setTimeout(r, 20));
  try {
    // a finer surface than the screen needs, for a sharp export
    const map = fam.makeMap(p), mesh = surfaceMesh(map, 0.5), box = flatBox(outlines(map));
    const px = (box[2] - box[0]) / size, ny = Math.ceil((box[3] - box[1]) / px);
    const top = box[1] + ny * px;
    const rgba = renderFlat(mesh, [box[0], box[1], box[2], top], size, ny);
    const blob = await writeGeoTIFF({
      width: size, height: ny, rgba,
      origin: [box[0] * R, top * R], pixelSize: [px * R, px * R],
      geoKeys: esriGeoKeys(wkt, R, `playproj ${fam.BASES[p.base].proj}`)
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const name = fam.projString(p).split(" ")[0].replace("+proj=", "");
    a.download = `playproj-${name}${p.lon0 ? `-lon${p.lon0}` : ""}-${state.bm}-${size}.tif`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } finally {
    ui.tif.textContent = label;
    updatePanel(currentMap());
  }
}

// One lobe (or butterfly face) on its own: the lobe's own projection about
// its own central meridian, at the detail the basemap has there (read for
// the lobe's lon/lat box, not the global image). The GPU draws the lobe's
// mesh into the image, so no inverse projection is needed.
let lobeBusy = false;
const pickable = () => (isLobed() || state.base === "butterfly");
function pickedPiece(c) {
  if (!pickable()) return null;
  return c.map.pieces[state.lobe] || null;
}

async function downloadLobe() {
  const c = currentMap(), q = pickedPiece(c);
  if (!world || !q) return;
  const pp = fam.pieceProjection(c.p, q), size = +ui.tifSize.value, R = fam.R;
  lobeBusy = true;
  ui.lobeTif.textContent = "Rendering...";
  ui.lobeTif.disabled = true;
  try {
    // the lobe's surface, laid out in the lobe's own projection
    const L0 = lonOf(c.map), mesh = surfaceMesh({ ...c.map, pieces: [q] }, 0.5);
    const pts = [];
    for (let k = 0; k < mesh.pts.length; k++) {
      const [x, y] = pp.flat(mesh.ll[2 * k] - L0, mesh.ll[2 * k + 1]);
      pts.push({ x, y });
    }
    const box = flatBox([pts]);
    const px = Math.max(box[2] - box[0], box[3] - box[1]) / size;
    const nx = Math.ceil((box[2] - box[0]) / px), ny = Math.ceil((box[3] - box[1]) / px);
    const top = box[1] + ny * px;
    // the basemap for the lobe's lon/lat box, at about one pixel's detail
    const [a, b, p0, p1] = q.bounds, pad = 1;
    const win = await readWindow(state.bm, { west: a + L0 - pad, east: b + L0 + pad, south: Math.max(-90, p0 - pad), north: Math.min(90, p1 + pad) },
      (px * 180) / Math.PI, (msg) => (ui.bmStatus.textContent = msg));
    const tex = new THREE.CanvasTexture(win.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    const W = win.width * win.dx, H = win.height * win.dy;
    const uv = [];
    for (let k = 0; k < mesh.pts.length; k++) uv.push((mesh.ll[2 * k] - win.west) / W, 1 - (win.north - mesh.ll[2 * k + 1]) / H);
    ui.bmStatus.textContent = "Rendering...";
    const rgba = renderFlat({ pts, uv, index: mesh.index }, [box[0], box[1], box[2], top], nx, ny, tex);
    tex.dispose();
    const blob = await writeGeoTIFF({
      width: nx, height: ny, rgba,
      origin: [box[0] * R, top * R], pixelSize: [px * R, px * R],
      geoKeys: crsGeoKeys({ proj: pp.proj, R })
    });
    const what = c.map.butterfly ? `face${q.id + 1}` : `${q.hemi}${q.k + 1}`;
    const name = pp.proj.split(" ")[0].replace("+proj=", "");
    saveBlob(blob, `playproj-${name}-${state.lobes === "gores" && !c.map.butterfly ? "gore" : c.map.butterfly ? "butterfly" : state.lobes}-${what}-${state.bm}-${nx}.tif`);
    ui.bmStatus.textContent = win.note ? `Written; ${win.note}.` : "";
  } catch (e) {
    ui.bmStatus.textContent = `The lobe could not be written (${e.message}).`;
  } finally {
    lobeBusy = false;
    updatePanel(currentMap());
  }
}

// ---------------------------------------------------------------- 2D map

const mapCanvas = document.getElementById("map2d");

function drawMap(c) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = mapCanvas.clientWidth, ch = mapCanvas.clientHeight;
  if (!cw || !ch) return;
  if (mapCanvas.width !== Math.round(cw * dpr)) { mapCanvas.width = Math.round(cw * dpr); mapCanvas.height = Math.round(ch * dpr); }
  const ctx = mapCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#05070d";
  ctx.fillRect(0, 0, cw, ch);

  const [x0, y0, x1, y1] = c.box;
  const s = Math.min(cw / (x1 - x0), ch / (y1 - y0)) * 0.94;
  const X = (x) => cw / 2 + (x - (x0 + x1) / 2) * s, Y = (y) => ch / 2 - (y - (y0 + y1) / 2) * s;
  const path = (line) => { line.forEach((pt, i) => (i ? ctx.lineTo(X(pt.x), Y(pt.y)) : ctx.moveTo(X(pt.x), Y(pt.y)))); };
  mapFrame = { cw, ch, s, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };

  ctx.fillStyle = "#0d1a2b";
  ctx.beginPath();
  for (const line of c.outlines) { path(line); ctx.closePath(); }
  ctx.fill();
  if (world && flatImage && flatImage.key === c.key + state.bm) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(flatCanvas, X(x0), Y(y1), (x1 - x0) * s, (y1 - y0) * s);
  }
  const stroke = (runs, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath();
    for (const run of runs) path(run);
    ctx.stroke();
  };
  if (state.grat) stroke(c.grat, "rgba(63,167,160,0.6)", 0.8);
  stroke(c.coast, "#6ab787", 1.1);
  stroke(c.outlines, state.cuts ? "rgba(255,179,71,0.8)" : "#8899aa", 1);
  const q = pickedPiece(c);
  if (q) {
    ctx.fillStyle = "rgba(255,211,77,0.18)";
    ctx.beginPath(); path(c.outlines[q.id]); ctx.closePath(); ctx.fill();
    stroke([c.outlines[q.id]], "#ffd34d", 2);
  }
}

// click the flat map: the lobe (or face) under the pointer, again to drop it
let mapFrame = null;
function pieceAt(c, x, y) {
  for (let k = c.outlines.length - 1; k >= 0; k--) {
    const line = c.outlines[k];
    let inside = false;
    for (let i = 0, j = line.length - 1; i < line.length; j = i++) {
      const a = line[i], b = line[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    if (inside) return k;
  }
  return -1;
}
mapCanvas.addEventListener("click", (ev) => {
  if (!mapFrame || !pickable()) return;
  const r = mapCanvas.getBoundingClientRect(), f = mapFrame;
  const x = f.cx + (ev.clientX - r.left - f.cw / 2) / f.s, y = f.cy - (ev.clientY - r.top - f.ch / 2) / f.s;
  const k = pieceAt(currentMap(), x, y);
  state.lobe = k === state.lobe ? -1 : k;
  sync();
});

// ---------------------------------------------------------------- panel

const $ = (id) => document.getElementById(id);
const ui = {
  base: $("base"), lobes: $("lobes"), gores: $("gores"), goresOut: $("gores-out"), goresRow: $("gores-row"),
  s: $("s"), sOut: $("s-out"), sRow: $("s-row"), lon0: $("lon0"), lon0Out: $("lon0-out"), lon0Label: $("lon0-label"),
  t: $("t"), tOut: $("t-out"), tMid: $("t-mid"), links: $("links"), linksOut: $("links-out"),
  proj: $("projstring"), describe: $("describe"), badge: $("badge"),
  cuts: $("cuts"), grat: $("grat"), globe: $("globe"), detail: $("detail"), from: $("from"), spin: $("spin"),
  relief: $("relief"), reliefOut: $("relief-out"), wire: $("wire"), bm: $("basemap"), bmStatus: $("bm-status"), credit: $("credit"),
  tifSize: $("tif-size"), tif: $("download-tif"), tifHint: $("tif-hint"), playI: $("play-interrupt"),
  lobeTif: $("download-lobe"), lobeHint: $("lobe-hint")
};

for (const [id, src] of Object.entries(sources)) ui.bm.add(new Option(src.label, id));
for (const [id, b] of Object.entries(fam.BASES)) ui.base.add(new Option(b.label, id));
for (const [id, l] of Object.entries(fam.LOBES)) ui.lobes.add(new Option(l.label, id));

function updatePanel(c) {
  const fly = state.base === "butterfly", lobable = fam.BASES[state.base].lobes;
  ui.base.value = state.base;
  ui.lobes.value = lobable ? state.lobes : "none";
  ui.lobes.disabled = !lobable;
  ui.goresRow.hidden = !(lobable && state.lobes === "gores");
  ui.gores.value = state.gores; ui.goresOut.textContent = state.gores;
  ui.sRow.hidden = !isLobed();
  ui.playI.hidden = !isLobed();
  ui.s.value = state.s;
  ui.sOut.textContent = state.s === 0 ? "one map" : state.s === 1 ? "lobes" : `${Math.round(state.s * 100)}%`;
  ui.lon0.value = state.lon0;
  ui.lon0Label.textContent = fly ? "Octahedron edge" : "Central meridian";
  ui.lon0Out.textContent = (+state.lon0.toFixed(2)) + DEG;
  ui.t.value = state.t;
  ui.tMid.textContent = fly ? "octahedron" : "";
  ui.tOut.textContent = state.t === 0 ? "globe" : state.t === 1 ? (fly ? "net" : "map") : fly && state.t === 0.5 ? "octahedron" : `${Math.round(state.t * 100)}%`;
  ui.links.value = state.links;
  ui.linksOut.textContent = state.from === "even" && coast.length
    ? `${state.links} on land, ${evenSpacing(coast, state.links).toFixed(1)}${DEG} apart`
    : state.links;
  ui.cuts.checked = !!state.cuts; ui.grat.checked = !!state.grat; ui.globe.checked = !!state.globe;
  ui.detail.value = state.detail; ui.from.value = state.from; ui.bm.value = state.bm; ui.spin.checked = !!state.spin;
  ui.relief.value = state.relief; ui.wire.checked = !!state.wire;
  ui.relief.disabled = ui.wire.disabled = !hasElevation(world);
  ui.reliefOut.textContent = !hasElevation(world) ? "needs GEBCO" : state.relief ? `${state.relief}x` : "off";

  const p = c.p, str = fam.projString(p);
  ui.proj.classList.toggle("none", !str);
  ui.proj.style.whiteSpace = fly ? "pre-line" : "";
  if (str) ui.proj.textContent = str;
  else if (fly) ui.proj.textContent = fam.faceStrings(p).join("\n");
  else if (state.s < 1) ui.proj.textContent = "No PROJ string while the lobes are part way open.";
  else ui.proj.textContent = `No single PROJ string: each lobe is +proj=${fam.BASES[p.base].proj} with its own +lon_0.`;
  ui.describe.textContent = fam.describe(p);
  ui.tif.disabled = !world || !str;
  ui.tifHint.textContent = str || !world
    ? "The flat map with its basemap, as RGBA with its CRS, readable by GDAL."
    : "PROJ has no single projection for this map, so a GeoTIFF could not say what its CRS is: pick a lobe instead.";
  const q = pickedPiece(c), what = fly ? "face" : "lobe";
  ui.lobeTif.hidden = ui.lobeHint.hidden = !pickable();
  if (!lobeBusy) { ui.lobeTif.textContent = `Download ${what}`; ui.lobeTif.disabled = !world || !q; }
  ui.lobeHint.textContent = !q ? `Click a ${what} on the flat map to pick it.`
    : `${fly ? "Face" : q.hemi === "n" ? "Northern lobe" : "Southern lobe"} ${fly ? q.id + 1 : q.k + 1}: ${fam.pieceProjection(c.p, q).proj}. ` +
      `Written in its own CRS, with the basemap read at the detail the ${what} needs.`;
}

let rafPending = false;
function sync() {
  writeHash();
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; rebuild(); });
}

ui.base.addEventListener("change", () => {
  const was = state.base;
  state.base = ui.base.value;
  state.lobe = -1;
  // the butterfly's natural edge meridian is not the globals' central meridian
  if (state.base === "butterfly" && was !== "butterfly" && state.lon0 === defaults.lon0) state.lon0 = BUTTERFLY_EDGE;
  if (state.base !== "butterfly" && was === "butterfly" && state.lon0 === BUTTERFLY_EDGE) state.lon0 = defaults.lon0;
  if ((state.base === "butterfly") !== (was === "butterfly") && !state.cam) setCamera(defaultCam());
  sync();
});
ui.lobes.addEventListener("change", () => { state.lobes = ui.lobes.value; state.lobe = -1; sync(); });
ui.gores.addEventListener("input", () => { state.gores = +ui.gores.value; state.lobe = -1; sync(); });
ui.s.addEventListener("input", () => { stopAnim(); state.s = +ui.s.value; sync(); });
ui.lon0.addEventListener("input", () => { state.lon0 = +ui.lon0.value; sync(); });
ui.t.addEventListener("input", () => { stopAnim(); state.t = +ui.t.value; sync(); });
ui.links.addEventListener("input", () => { state.links = +ui.links.value; if (state.from === "even") buildLinkPool(); sync(); });
ui.cuts.addEventListener("change", () => { state.cuts = ui.cuts.checked ? 1 : 0; sync(); });
ui.grat.addEventListener("change", () => { state.grat = ui.grat.checked ? 1 : 0; sync(); });
ui.globe.addEventListener("change", () => { state.globe = ui.globe.checked ? 1 : 0; sync(); });
ui.detail.addEventListener("change", async () => { state.detail = ui.detail.value; await loadData(); sync(); });
ui.from.addEventListener("change", () => { state.from = ui.from.value; buildLinkPool(); sync(); });
ui.bm.addEventListener("change", () => { state.bm = ui.bm.value; setBasemap(); });
ui.spin.addEventListener("change", () => { state.spin = ui.spin.checked ? 1 : 0; controls.autoRotate = !!state.spin; writeHash(); });
ui.tif.addEventListener("click", downloadTIF);
ui.lobeTif.addEventListener("click", downloadLobe);
ui.relief.addEventListener("input", () => { state.relief = +ui.relief.value; sync(); });
ui.wire.addEventListener("change", () => { state.wire = ui.wire.checked ? 1 : 0; sync(); });
$("reseed").addEventListener("click", () => { state.seed = (state.seed % 9999) + 1; buildLinkPool(); sync(); });
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(defaultCam()); writeHash(); });

// play the unfold, or the interruption, to its end and back
let anim = null, dir = 1, lastT = 0;
const playU = $("play-unfold");
function stopAnim() { anim = null; playU.textContent = "Unfold"; ui.playI.textContent = "Interrupt"; }
function play(key, btn) {
  if (anim === key) return stopAnim();
  stopAnim();
  anim = key; dir = state[key] >= 1 ? -1 : 1; btn.textContent = "Stop"; lastT = performance.now();
}
playU.addEventListener("click", () => play("t", playU));
ui.playI.addEventListener("click", () => play("s", ui.playI));

function copy(text, btn) {
  const done = () => { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1200); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {});
}
const pageUrl = () => location.origin + location.pathname;
$("copy-link").addEventListener("click", (e) => copy(pageUrl() + location.hash, e.target));
$("copy-embed").addEventListener("click", (e) => copy(
  `<iframe src="${pageUrl()}?embed=1${location.hash}" width="100%" height="480" style="border:0" loading="lazy" title="Map projection playground"></iframe>`,
  e.target));
$("copy-proj").addEventListener("click", (e) => copy(ui.proj.textContent, e.target));
$("open-full").href = pageUrl() + location.hash;

// ---------------------------------------------------------------- loop

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (coast.length) drawMap(currentMap());
}
new ResizeObserver(resize).observe(stage);
new ResizeObserver(() => { if (coast.length) drawMap(currentMap()); }).observe(mapCanvas);

function tick(now) {
  if (anim) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    state[anim] = Math.max(0, Math.min(1, state[anim] + dir * dt * 0.25));
    if (state[anim] === 1 || state[anim] === 0) stopAnim();
    sync();
  }
  lastT = now;
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

async function loadData() {
  coast = await loadCoastline(state.detail);
  cur = null;
  buildLinkPool();
}

window.addEventListener("hashchange", () => { readHash(); controls.autoRotate = !!state.spin; if (state.cam) setCamera(state.cam); setBasemap(); loadData().then(sync); });

if (embed) {
  document.body.classList.add("embed");
  $("open-full").hidden = false;
}

readHash();
setCamera(state.cam || defaultCam());
controls.autoRotate = !!state.spin;
controls.autoRotateSpeed = 0.8;
resize();
loadData().then(() => { rebuild(); document.body.classList.add("ready"); });
setBasemap();
requestAnimationFrame(tick);
