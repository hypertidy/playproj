// playproj: texture mapping
//
// A mesh in three.js (left) and its UV layout over the texture image
// (right): the same triangles at their 3D positions and at their texture
// coordinates. Hovering either finds a triangle and a point's barycentric
// weights in it, and shows the u, v the GPU blends there, against where
// the point really is. The meshes, projections and lookups are
// src/core/texmap.js; the shader below repeats the inverses for the
// per-pixel lookup.

import * as THREE from "three";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import * as T from "../src/core/texmap.js";
import { loadCoastline } from "./data.js";
import { basemapControl } from "./basemap-ui.js";
import { makeStage, readParams, hashWriter, shareLinks, oneOf } from "../src/scene/index.js";

const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";
const EARTH_KM = 6371.0088;
const PROJ_IDS = Object.keys(T.PROJS);

const C = {
  bg: 0x05070d, edge: 0xdfe7f2, smear: 0xff5a5a, hi: 0xffd34d, truth: 0x7fe0ff,
  ink: "#dfe7f2", muted: "#8a97ab", edgeCss: "rgba(223,231,242,0.75)", smearCss: "#ff5a5a",
  hiCss: "#ffd34d", hiFill: "rgba(255,211,77,0.28)", truthCss: "#7fe0ff"
};

// divisions: what n means for each mesh, its range and default
const MESHES = {
  small: { label: "Small mesh", name: "Cells across", min: 1, max: 6, n: 2 },
  globe: { label: "Globe, lon/lat grid", name: "Rows of latitude", min: 2, max: 36, n: 6 },
  ico: { label: "Globe, icosphere", name: "Subdivisions", min: 1, max: 12, n: 2 },
  plane: { label: "Map", name: "Rows of latitude", min: 2, max: 36, n: 4 }
};

// ---------------------------------------------------------------- state

const defaults = {
  mesh: "small", n: 2, bend: 0, proj: "stere", seam: "split", pole: "split", look: "vertex",
  edges: 1, aff: 0, bm: "none", uv: "", cam: null
};
const state = { ...defaults };
function readHash() {
  readParams(state, defaults, {
    mesh: oneOf(Object.keys(MESHES), "small"), proj: oneOf(PROJ_IDS, "stere"),
    seam: oneOf(["split", "shared"], "split"), pole: oneOf(["split", "single"], "split"),
    look: oneOf(["vertex", "pixel"], "vertex"), bm: oneOf(["none", "gebco", "esri"], "none"),
    uv: (raw) => (/^[-0-9.,]*$/.test(raw) ? raw : "")
  });
  const M = MESHES[state.mesh];
  state.n = Math.round(Math.max(M.min, Math.min(M.max, state.n)));
  state.bend = Math.max(0, Math.min(1, state.bend));
}
readHash();
const writeHash = hashWriter(state, defaults, { digits: 3 });

// ---------------------------------------------------------------- the mesh

let mesh = null;   // the core mesh: { pos, uv, index, lonlat, xy? }
const isMap = () => state.mesh === "globe" || state.mesh === "ico" || state.mesh === "plane";

function makeMesh() {
  const n = state.n, opts = { seam: state.seam, pole: state.pole };
  if (state.mesh === "small") {
    const m = T.smallMesh(n, state.bend);
    // dragged corners, if they fit this mesh
    const e = state.uv ? state.uv.split(",").map(Number) : [];
    if (e.length === m.uv.length && e.every(isFinite)) m.uv = e;
    else state.uv = "";
    return m;
  }
  if (state.mesh === "globe") return T.globeMesh(n, 2 * n, opts);
  if (state.mesh === "ico") return T.icoMesh(n, opts);
  // the map, scaled to about 3.2 wide
  const m = T.planeMesh(state.proj, n, 2 * n, 1);
  let ext = 0;
  for (let k = 0; k < m.pos.length; k += 3) ext = Math.max(ext, Math.abs(m.pos[k]), Math.abs(m.pos[k + 1]) * 1.6);
  const s = 1.6 / ext;
  m.pos = m.pos.map((x) => x * s);
  return m;
}

// triangles of a map mesh whose u span says they blend across the whole
// image (on the small mesh any u, v is fair)
function smears(m) {
  const out = [];
  if (!isMap()) return out;
  for (let t = 0; t < m.index.length / 3; t++) {
    const us = [0, 1, 2].map((i) => m.uv[2 * m.index[3 * t + i]]);
    if (Math.max(...us) - Math.min(...us) > 0.5) out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- 3D

const stage = $("three");
const { renderer, scene, camera, controls, setCamera, resize } = makeStage(stage, {
  bg: C.bg, fov: 36, far: 100,
  onCamera: (c) => { state.cam = c; writeHash(); }
});
controls.minDistance = 0.8;
controls.maxDistance = 12;
const labels = new CSS2DRenderer();
labels.domElement.style.cssText = "position:absolute;inset:0;pointer-events:none";
stage.appendChild(labels.domElement);
new ResizeObserver(() => labels.setSize(stage.clientWidth, stage.clientHeight)).observe(stage);

const VERT = `
attribute vec2 xy;
varying vec2 vUv;
varying vec3 vP;
varying vec2 vXY;
varying vec3 vUvW;
varying vec4 vPW;
varying vec3 vXYW;
void main() {
  vec4 c = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = c;
  float w = c.w;
  vUv = uv; vP = position; vXY = xy;
  // the same values times w, and w: their ratio, interpolated, is the
  // screen-space (affine) blend rather than the perspective-correct one
  vUvW = vec3(uv * w, w); vPW = vec4(position * w, w); vXYW = vec3(xy * w, w);
}`;
const FRAG = `
uniform sampler2D map;
uniform int look;
uniform int kind;
uniform int proj;
uniform int aff;
varying vec2 vUv;
varying vec3 vP;
varying vec2 vXY;
varying vec3 vUvW;
varying vec4 vPW;
varying vec3 vXYW;
const float PI = 3.141592653589793;
// the projections' inverses (R = 1) to lon, lat in radians, as texmap.js
vec2 unproject(vec2 p) {
  if (proj == 0) return p;
  if (proj == 1) return vec2(p.x, atan(sinh(p.y)));
  if (proj == 2) return vec2(atan(p.x, p.y), 2.0 * atan(length(p) / 2.0) - PI / 2.0);
  float t = asin(clamp(p.y / sqrt(2.0), -1.0, 1.0));
  float lat = asin(clamp((2.0 * t + sin(2.0 * t)) / PI, -1.0, 1.0));
  return vec2(PI * p.x / (2.0 * sqrt(2.0) * max(cos(t), 1e-6)), lat);
}
void main() {
  vec2 uv;
  if (look == 0 || kind == 0) {
    uv = aff == 1 ? vUvW.xy / vUvW.z : vUv;
  } else {
    vec2 ll;
    if (kind == 1) {
      vec3 p = normalize(aff == 1 ? vPW.xyz / vPW.w : vP);
      ll = vec2(atan(p.x, p.z), asin(clamp(p.y, -1.0, 1.0)));
    } else {
      ll = unproject(aff == 1 ? vXYW.xy / vXYW.z : vXY);
    }
    // u jumps by 1 at the antimeridian; take whichever of u and u - 1/2
    // changes less across this pixel so the mip level stays right (Tarini)
    float u = ll.x / (2.0 * PI) + 0.5;
    float u2 = fract(u + 0.5) - 0.5;
    uv = vec2(fwidth(u) <= fwidth(u2) + 1e-6 ? u : u2, ll.y / PI + 0.5);
  }
  gl_FragColor = texture2D(map, uv);
}`;

const texture = new THREE.CanvasTexture(document.createElement("canvas"));
const material = new THREE.ShaderMaterial({
  vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide,
  uniforms: { map: { value: texture }, look: { value: 0 }, kind: { value: 0 }, proj: { value: 2 }, aff: { value: 0 } },
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
});
const surface = new THREE.Mesh(new THREE.BufferGeometry(), material);
scene.add(surface);

function lines(color, opacity = 1) {
  const o = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
  scene.add(o);
  return o;
}
const edgeLines = lines(C.edge, 0.55);
const smearLines = lines(C.smear);
const hiLines = lines(C.hi);
hiLines.renderOrder = 2; hiLines.material.depthTest = false;
const dot = (color) => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  m.renderOrder = 3; scene.add(m); return m;
};
const hereDot = dot(C.truth), readDot = dot(C.hi);
const labelGroup = new THREE.Group();
scene.add(labelGroup);

const corner = (m, t, i) => m.index[3 * t + i];
const posOf = (m, k) => [m.pos[3 * k], m.pos[3 * k + 1], m.pos[3 * k + 2]];
const uvOf = (m, k) => [m.uv[2 * k], m.uv[2 * k + 1]];

function edgeSegments(m, tris) {
  const out = [], seen = new Set();
  for (const t of tris) {
    for (let i = 0; i < 3; i++) {
      const a = corner(m, t, i), b = corner(m, t, (i + 1) % 3);
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(...posOf(m, a), ...posOf(m, b));
    }
  }
  return new THREE.Float32BufferAttribute(out, 3);
}
const allTris = (m) => Array.from({ length: m.index.length / 3 }, (_, t) => t);

function buildMesh() {
  mesh = makeMesh();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(mesh.pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(mesh.uv, 2));
  const xy = mesh.xy || new Array((mesh.pos.length / 3) * 2).fill(0);
  g.setAttribute("xy", new THREE.Float32BufferAttribute(xy, 2));
  g.setIndex(mesh.index);
  g.computeBoundingSphere();
  surface.geometry.dispose();
  surface.geometry = g;
  edgeLines.geometry.setAttribute("position", edgeSegments(mesh, allTris(mesh)));
  smearLines.geometry.setAttribute("position", edgeSegments(mesh, smears(mesh)));
  buildLabels();
  hover = null;
  buildHover();
}

// vertex numbers on the small mesh
function buildLabels() {
  for (const o of [...labelGroup.children]) { labelGroup.remove(o); o.element.remove(); }
  if (state.mesh !== "small") return;
  const nv = mesh.pos.length / 3;
  for (let k = 0; k < nv; k++) {
    const el = document.createElement("span");
    el.className = "vlabel"; el.textContent = k;
    const o = new CSS2DObject(el);
    o.position.fromArray(posOf(mesh, k));
    o.center.set(-0.2, 1.2);
    labelGroup.add(o);
  }
}

// only the u, v changed (dragging): update in place
function updateUv() {
  const a = surface.geometry.attributes.uv;
  a.array.set(mesh.uv); a.needsUpdate = true;
  smearLines.geometry.setAttribute("position", edgeSegments(mesh, smears(mesh)));
}

// ---------------------------------------------------------------- hover

let hover = null;   // { t, w } with the core lookup on it

function setHover(t, w) {
  if (t == null) { hover = null; return; }
  const projId = state.mesh === "plane" ? state.proj : null;
  hover = { t, w, ...T.lookup(mesh, t, w, projId) };
}

// In both views, cyan is the point itself and yellow is what a per-vertex
// lookup reads there (on the small mesh, which is no map, only yellow).
function buildHover() {
  const on = !!hover;
  hiLines.visible = hereDot.visible = on;
  readDot.visible = on && !!hover.truth;
  if (!on) return;
  hiLines.geometry.setAttribute("position", edgeSegments(mesh, [hover.t]));
  hereDot.position.fromArray(T.blend(hover.w, ...[0, 1, 2].map((i) => posOf(mesh, corner(mesh, hover.t, i)))));
  hereDot.material.color.setHex(hover.truth ? C.truth : C.hi);
  if (hover.truth) {
    const q = placeOf(...hover.read);
    if (q) readDot.position.fromArray(q); else readDot.visible = false;
  }
}

// where a lon/lat is on the current map mesh (the globe facet or the plane)
function placeOf(lon, lat) {
  if (state.mesh === "plane") {
    const P = T.PROJS[state.proj];
    if (lat < P.lat[0] || lat > P.lat[1]) return null;
    const [x, y] = P.forward(lon, lat), s = scaleOfPlane();
    return [x * s, y * s, 0.002];
  }
  return T.toXYZ(lon, lat).map((x) => x * 1.002);
}
function scaleOfPlane() {
  // the scale makeMesh used: any vertex not at the origin
  for (let k = 0; k < mesh.xy.length; k += 2) {
    const r = Math.hypot(mesh.xy[k], mesh.xy[k + 1]);
    if (r > 1e-6) return Math.hypot(mesh.pos[(k / 2) * 3], mesh.pos[(k / 2) * 3 + 1]) / r;
  }
  return 1;
}

const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
const tri = new THREE.Triangle(), bc = new THREE.Vector3();
renderer.domElement.addEventListener("pointermove", (e) => {
  if (e.buttons) return;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObject(surface)[0];
  if (!hit) setHover(null);
  else {
    const t = hit.faceIndex;
    const [A, B, Cc] = [0, 1, 2].map((i) => new THREE.Vector3(...posOf(mesh, corner(mesh, t, i))));
    tri.set(A, B, Cc).getBarycoord(hit.point, bc);
    setHover(t, [bc.x, bc.y, bc.z]);
  }
  buildHover(); drawUv(); readout();
});
renderer.domElement.addEventListener("pointerleave", () => { setHover(null); buildHover(); drawUv(); readout(); });

// ---------------------------------------------------------------- the texture

// The built-in image: an equirectangular test card of 30 degree cells
// lettered A to L west to east and numbered 1 to 6 north to south, with a
// 10 degree graticule, coastlines and the antimeridian in red.
function testCard(coast) {
  const W = 2048, H = 1024, cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  const X = (lon) => ((lon + 180) / 360) * W, Y = (lat) => ((90 - lat) / 180) * H;
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 6; j++) {
      g.fillStyle = `hsl(${(i * 30 + 200) % 360}, 45%, ${(i + j) % 2 ? 30 : 42}%)`;
      g.fillRect(X(-180 + 30 * i), Y(90 - 30 * j), W / 12 + 1, H / 6 + 1);
    }
  }
  g.lineWidth = 1; g.strokeStyle = "rgba(255,255,255,0.25)";
  for (let lon = -170; lon < 180; lon += 10) { g.beginPath(); g.moveTo(X(lon), 0); g.lineTo(X(lon), H); g.stroke(); }
  for (let lat = -80; lat < 90; lat += 10) { g.beginPath(); g.moveTo(0, Y(lat)); g.lineTo(W, Y(lat)); g.stroke(); }
  g.lineWidth = 3; g.strokeStyle = "rgba(255,255,255,0.6)";
  g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(W, Y(0)); g.moveTo(X(0), 0); g.lineTo(X(0), H); g.stroke();
  g.lineWidth = 2.5; g.strokeStyle = "#fff8e6"; g.lineJoin = "round";
  for (const l of coast) {
    g.beginPath();
    for (let i = 0; i < l.length; i += 2) {
      if (i && Math.abs(l[i] - l[i - 2]) > 180) g.moveTo(X(l[i]), Y(l[i + 1]));
      else (i ? g.lineTo : g.moveTo).call(g, X(l[i]), Y(l[i + 1]));
    }
    g.stroke();
  }
  g.font = "bold 56px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillStyle = "rgba(255,255,255,0.8)";
  for (let i = 0; i < 12; i++) for (let j = 0; j < 6; j++) g.fillText(`${"ABCDEFGHIJKL"[i]}${j + 1}`, X(-165 + 30 * i), Y(75 - 30 * j));
  g.fillStyle = "#ff5a5a"; g.fillRect(0, 0, 6, H); g.fillRect(W - 6, 0, 6, H);
  return cv;
}

let card = null, world = null;
function setTexture() {
  const img = world ? world.canvas : card;
  if (!img) return;
  texture.image = img;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  drawUv();
}

// ---------------------------------------------------------------- UV view

const map = $("map");
let frame = null;   // u, v to canvas pixels and back

function uvRange() {
  if (state.mesh === "small") return [-0.25, 1.25, -0.25, 1.25];
  let u0 = 0, u1 = 1;
  for (let k = 0; k < mesh.uv.length; k += 2) { u0 = Math.min(u0, mesh.uv[k]); u1 = Math.max(u1, mesh.uv[k]); }
  return [u0, u1, 0, 1];
}

function drawUv() {
  const box = map.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, box.width), h = Math.max(10, box.height);
  map.width = Math.round(w * dpr); map.height = Math.round(h * dpr);
  const g = map.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = "#05070d"; g.fillRect(0, 0, w, h);
  if (!mesh) return;
  // the image keeps its 2:1 shape: a unit of v is half a unit of u
  const [u0, u1, v0, v1] = uvRange(), pad = 24;
  const s = Math.min((w - 2 * pad - 44) / (u1 - u0), (h - 2 * pad - 20) / ((v1 - v0) / 2));
  const ox = Math.max(44, (w - s * (u1 - u0)) / 2), oy = (h - 20 - s * (v1 - v0) / 2) / 2;
  const X = (u) => ox + (u - u0) * s, Y = (v) => oy + (v1 - v) * s / 2;
  frame = { X, Y, s, ox, oy, u0, v1 };
  const img = texture.image;
  if (img && img.width > 1) {
    g.imageSmoothingEnabled = true;
    // the image repeats across u (the texture wraps), drawn faint outside 0 to 1
    for (let k = Math.floor(u0); k < Math.ceil(u1); k++) {
      g.globalAlpha = k === 0 ? 1 : 0.35;
      g.drawImage(img, X(k), Y(1), s, s / 2);
    }
    g.globalAlpha = 1;
  }
  g.strokeStyle = "rgba(140,196,255,0.5)"; g.lineWidth = 1;
  g.strokeRect(X(0), Y(1), s, s / 2);

  const tris = allTris(mesh), bad = new Set(smears(mesh));
  const path = (t, du = 0) => {
    g.beginPath();
    for (let i = 0; i < 3; i++) {
      const [u, v] = uvOf(mesh, corner(mesh, t, i));
      (i ? g.lineTo : g.moveTo).call(g, X(u + du), Y(v));
    }
    g.closePath();
  };
  if (hover) {
    path(hover.t); g.fillStyle = C.hiFill; g.fill();
  }
  if (state.edges || mesh.index.length / 3 <= 64) {
    g.lineWidth = tris.length > 2000 ? 0.5 : 1;
    g.strokeStyle = C.edgeCss;
    for (const t of tris) if (!bad.has(t)) { path(t); g.stroke(); }
  }
  g.lineWidth = 2; g.strokeStyle = C.smearCss;
  for (const t of bad) { path(t); g.stroke(); }
  if (hover) {
    g.lineWidth = 2; g.strokeStyle = C.hiCss; path(hover.t); g.stroke();
  }

  // vertices, numbered on the small mesh (and draggable there)
  const nv = mesh.uv.length / 2;
  if (nv <= 400) {
    g.fillStyle = C.ink;
    for (let k = 0; k < nv; k++) {
      const [u, v] = uvOf(mesh, k);
      g.beginPath(); g.arc(X(u), Y(v), state.mesh === "small" ? 5 : 2, 0, 2 * Math.PI); g.fill();
    }
    if (state.mesh === "small") {
      g.font = "bold 12px system-ui, sans-serif"; g.textAlign = "left"; g.textBaseline = "bottom";
      for (let k = 0; k < nv; k++) {
        const [u, v] = uvOf(mesh, k);
        g.fillStyle = "rgba(5,7,13,0.75)"; g.fillRect(X(u) + 5, Y(v) - 18, 8 * String(k).length + 6, 15);
        g.fillStyle = C.hiCss; g.fillText(k, X(u) + 8, Y(v) - 4);
      }
    }
  }

  if (hover) {
    // the blend of the corners' u, v: what a per-vertex lookup reads
    const [u, v] = hover.uv;
    const mark = (x, y, c) => {
      g.beginPath(); g.arc(x, y, 5, 0, 2 * Math.PI); g.fillStyle = c; g.fill();
      g.lineWidth = 1.5; g.strokeStyle = "#05070d"; g.stroke();
    };
    if (hover.truth) {
      // and where the point really is in the image
      const tu = (hover.truth[0] + 180) / 360, tv = (hover.truth[1] + 90) / 180;
      const du = Math.round(u - tu);
      g.strokeStyle = C.truthCss; g.lineWidth = 1.5; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(X(u), Y(v)); g.lineTo(X(tu + du), Y(tv)); g.stroke(); g.setLineDash([]);
      mark(X(tu + du), Y(tv), C.truthCss);
    }
    mark(X(u), Y(v), C.hiCss);
  }

  // the axes
  g.font = "12px system-ui, sans-serif"; g.fillStyle = C.muted;
  g.textAlign = "center"; g.textBaseline = "top";
  for (const u of [0, 0.5, 1]) g.fillText(`u = ${u}`, X(u), Y(v0) + 6);
  g.textAlign = "right"; g.textBaseline = "middle";
  for (const v of [0, 1]) g.fillText(`v = ${v}`, X(u0) - 6, Y(v));
}

// u, v under a canvas point
function uvAt(e) {
  if (!frame) return null;
  const r = map.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  return [frame.u0 + (x - frame.ox) / frame.s, frame.v1 - (y - frame.oy) / (frame.s / 2)];
}

let drag = -1;
map.addEventListener("pointerdown", (e) => {
  if (state.mesh !== "small" || !frame) return;
  const r = map.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  let best = -1, bd = 12;
  for (let k = 0; k < mesh.uv.length / 2; k++) {
    const [u, v] = uvOf(mesh, k), d = Math.hypot(frame.X(u) - x, frame.Y(v) - y);
    if (d < bd) { bd = d; best = k; }
  }
  if (best >= 0) { drag = best; map.setPointerCapture(e.pointerId); }
});
map.addEventListener("pointermove", (e) => {
  const p = uvAt(e);
  if (!p) return;
  if (drag >= 0) {
    mesh.uv[2 * drag] = +Math.max(-0.25, Math.min(1.25, p[0])).toFixed(3);
    mesh.uv[2 * drag + 1] = +Math.max(-0.25, Math.min(1.25, p[1])).toFixed(3);
    updateUv();
    if (hover) setHover(hover.t, hover.w);
    buildHover(); drawUv(); readout();
    return;
  }
  const hit = T.triangleAtUv(mesh, p[0], p[1]);
  if (hit) setHover(hit.t, hit.w); else setHover(null);
  buildHover(); drawUv(); readout();
});
const endDrag = () => {
  if (drag < 0) return;
  drag = -1;
  state.uv = mesh.uv.join(",");
  sync();
};
map.addEventListener("pointerup", endDrag);
map.addEventListener("pointercancel", endDrag);
map.addEventListener("pointerleave", () => { if (drag < 0) { setHover(null); buildHover(); drawUv(); readout(); } });

// ---------------------------------------------------------------- readout

const f3 = (x) => x.toFixed(3);
const fmtLL = ([lon, lat]) => `${Math.abs(lat).toFixed(2)}${DEG}${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(2)}${DEG}${lon < 0 ? "W" : "E"}`;

function readout() {
  if (!mesh) return;
  const nv = mesh.pos.length / 3, nt = mesh.index.length / 3, bad = smears(mesh).length;
  const rows = [["Mesh", `${nv} vertices, ${nt} triangles`]];
  if (bad) rows.push([`<span style="color:${C.smearCss}">Smeared</span>`, `${bad} triangle${bad > 1 ? "s" : ""} span more than half the image in u`]);
  if (!hover) {
    rows.push(["", '<span class="hint">Hover the mesh or the image</span>']);
  } else {
    const ks = [0, 1, 2].map((i) => corner(mesh, hover.t, i));
    rows.push([`Triangle ${hover.t}`, `corners ${ks.join(", ")}`]);
    ks.forEach((k, i) => {
      const [u, v] = uvOf(mesh, k);
      rows.push([`Corner ${k}`, `u, v ${f3(u)}, ${f3(v)} &times; ${f3(hover.w[i])}`]);
    });
    rows.push(["Blend of u, v", `${f3(hover.uv[0])}, ${f3(hover.uv[1])}`]);
    if (hover.truth) {
      rows.push([`<span style="color:${C.hiCss}">Per vertex reads</span>`, fmtLL(hover.read)]);
      rows.push([`<span style="color:${C.truthCss}">The point is at</span>`, fmtLL(hover.truth)]);
      const km = hover.miss * Math.PI / 180 * EARTH_KM;
      rows.push(["Per-vertex miss", `${km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString("en")} km (${hover.miss.toFixed(2)}${DEG})`]);
      rows.push(["Drawn with", state.look === "pixel" ? "per pixel, exact" : "per vertex"]);
    }
  }
  // the whole vertex table for a small mesh
  let table = "";
  if (state.mesh === "small" && nv <= 16) {
    const hl = hover ? new Set([0, 1, 2].map((i) => corner(mesh, hover.t, i))) : new Set();
    table = `<tr><td colspan="2"><table class="vtable"><tr><th>#</th><th>x</th><th>y</th><th>z</th><th>u</th><th>v</th></tr>` +
      Array.from({ length: nv }, (_, k) => {
        const p = posOf(mesh, k), [u, v] = uvOf(mesh, k);
        return `<tr${hl.has(k) ? ' class="on"' : ""}><td>${k}</td>${[...p, u, v].map((x) => `<td>${x.toFixed(2)}</td>`).join("")}</tr>`;
      }).join("") + "</table></td></tr>";
  }
  $("out").innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("") + table;
}

// ---------------------------------------------------------------- UI

const PRESETS = [
  ["A small mesh", { mesh: "small", n: 2, bend: 0, look: "vertex", aff: 0, uv: "" }],
  ["Roll it into a tube", { mesh: "small", n: 4, bend: 1, look: "vertex", aff: 0, uv: "" }],
  ["Affine wobble", { mesh: "small", n: 1, bend: 0, look: "vertex", aff: 1, uv: "", dir: [-2.4, 0.3, 0.6] }],
  ["Coarse globe", { mesh: "globe", n: 3, seam: "split", pole: "split", look: "vertex", aff: 0 }],
  ["Shared seam", { mesh: "globe", n: 6, seam: "shared", pole: "split", look: "vertex", aff: 0, dir: [-0.5, 0.3, -1] }],
  ["One pole vertex", { mesh: "globe", n: 6, seam: "split", pole: "single", look: "vertex", aff: 0, dir: [0.15, 1, 0.35] }],
  ["Icosphere seam", { mesh: "ico", n: 2, seam: "shared", pole: "split", look: "vertex", aff: 0, dir: [-0.4, 0.2, -1] }],
  ["Stereographic, coarse", { mesh: "plane", proj: "stere", n: 3, look: "vertex", aff: 0 }],
  ["Mollweide, coarse", { mesh: "plane", proj: "moll", n: 4, look: "vertex", aff: 0 }],
  ["Per pixel fixes it", { mesh: "plane", proj: "stere", n: 3, look: "pixel", aff: 0 }]
];
for (const [name, p] of PRESETS) {
  const bt = document.createElement("button");
  bt.type = "button"; bt.textContent = name;
  bt.addEventListener("click", () => {
    const { dir, ...q } = p;
    Object.assign(state, { cam: null }, q);
    rebuild();
    setCamera(defaultCam(dir));
  });
  $("presets").appendChild(bt);
}

const projSel = $("proj");
for (const id of PROJ_IDS) projSel.add(new Option(T.PROJS[id].label, id));

const ui = {
  mesh: $("mesh"), n: $("n"), bend: $("bend"), proj: projSel, seam: $("seam"), pole: $("pole"),
  look: $("look"), edges: $("edges"), aff: $("aff")
};
ui.mesh.addEventListener("change", () => {
  state.mesh = ui.mesh.value; state.n = MESHES[state.mesh].n; state.uv = ""; state.cam = null;
  rebuild(); setCamera(defaultCam());
});
ui.n.addEventListener("input", () => { state.n = +ui.n.value; state.uv = ""; rebuild(); });
ui.bend.addEventListener("input", () => { state.bend = +ui.bend.value; rebuild(); });
for (const k of ["proj", "seam", "pole", "look"]) ui[k].addEventListener("change", () => { state[k] = ui[k].value; rebuild(); });
for (const k of ["edges", "aff"]) ui[k].addEventListener("change", () => { state[k] = ui[k].checked ? 1 : 0; sync(); });
$("reset-uv").addEventListener("click", () => { state.uv = ""; rebuild(); });
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(defaultCam()); writeHash(); });

const basemap = basemapControl({
  select: $("basemap"), status: $("bm-status"), credit: $("credit"),
  onWorld: (wd) => { world = wd; setTexture(); }
});
$("basemap").options[0].textContent = "Test card (built in)";
$("basemap").addEventListener("change", () => { state.bm = $("basemap").value; basemap.set(state.bm); writeHash(); });

// looking from direction dir (or the mesh's own), far enough back that the
// mesh fits the narrower side of the view
const DIRS = { small: [0.1, 0.15, 1], globe: [0.3, 0.35, 1], ico: [0.3, 0.35, 1], plane: [0, 0, 1] };
const FIT = { small: 1.1, globe: 1.1, ico: 1.1 };
function defaultCam(dir = DIRS[state.mesh]) {
  const vf = camera.fov * Math.PI / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
  // the map is at most 3.2 wide and 2 high, and flat
  const d = state.mesh === "plane" ? 1.08 * Math.max(1.6 / Math.tan(hf / 2), 1 / Math.tan(vf / 2))
    : FIT[state.mesh] / Math.sin(Math.min(vf, hf) / 2);
  const l = Math.hypot(...dir);
  return [...dir.map((x) => (x / l) * d), 0, 0, 0];
}

function rebuild() { buildMesh(); sync(); }

const HINTS = {
  small: "Drag the numbered corners on the image to move their u, v. Bend rolls the sheet into a tube, where u = 0 meets u = 1.",
  globe: "Each vertex's u, v is its own lon and lat. Red triangles blend across the whole image.",
  ico: "Triangles that straddle the antimeridian need their western corners copied at u + 1.",
  plane: "Vertices sit on a lon/lat grid, placed by the projection; between them, the blend is straight."
};

function sync() {
  const M = MESHES[state.mesh];
  ui.mesh.value = state.mesh;
  ui.n.min = M.min; ui.n.max = M.max; ui.n.value = state.n;
  $("n-name").textContent = M.name;
  $("n-out").textContent = state.mesh === "globe" || state.mesh === "plane"
    ? `${state.n} (${(180 / state.n * (state.mesh === "plane" ? (T.PROJS[state.proj].lat[1] - T.PROJS[state.proj].lat[0]) / 180 : 1)).toFixed(1)}${DEG} cells)` : state.n;
  ui.bend.value = state.bend; $("bend-out").textContent = `${Math.round(state.bend * 360)}${DEG}`;
  ui.proj.value = state.proj; ui.seam.value = state.seam; ui.pole.value = state.pole; ui.look.value = state.look;
  ui.edges.checked = !!state.edges; ui.aff.checked = !!state.aff;
  $("bend-box").hidden = state.mesh !== "small";
  $("proj-box").hidden = state.mesh !== "plane";
  $("sphere-box").hidden = !(state.mesh === "globe" || state.mesh === "ico");
  ui.look.disabled = !isMap();
  $("reset-uv").hidden = state.mesh !== "small";
  $("hint").textContent = HINTS[state.mesh];

  const u = material.uniforms;
  u.look.value = state.look === "pixel" ? 1 : 0;
  u.kind.value = state.mesh === "small" ? 0 : state.mesh === "plane" ? 2 : 1;
  u.proj.value = PROJ_IDS.indexOf(state.proj);
  u.aff.value = state.aff;
  edgeLines.visible = !!state.edges;

  const what = state.mesh === "plane" ? `${T.PROJS[state.proj].label} (${T.PROJS[state.proj].proj.replace(" +R=1", "")})` : M.label;
  $("mesh-label").textContent = `${what}, ${state.look === "pixel" && isMap() ? "per-pixel" : "per-vertex"} lookup${state.aff ? ", affine" : ""}`;
  $("uv-label").textContent = "The image in u, v, with the mesh's triangles at their texture coordinates";
  drawUv();
  readout();
  writeHash();
}

// ---------------------------------------------------------------- start

window.addEventListener("hashchange", () => {
  readHash(); rebuild(); setCamera(state.cam || defaultCam());
  if (state.bm !== basemap.id) basemap.set(state.bm);
});
new ResizeObserver(() => drawUv()).observe(map.parentElement);
const main = $("stage");
new ResizeObserver(() => main.classList.toggle("stacked", main.clientHeight > main.clientWidth)).observe(main);
shareLinks("playproj: Texture mapping", { height: 600 });

function tick() {
  controls.update();
  renderer.render(scene, camera);
  labels.render(scene, camera);
  requestAnimationFrame(tick);
}

card = testCard([]);
setTexture();
rebuild();
resize();
labels.setSize(stage.clientWidth, stage.clientHeight);
setCamera(state.cam || defaultCam());
requestAnimationFrame(tick);
loadCoastline("110m").then((c) => { card = testCard(c); if (!world) setTexture(); }).catch(() => {});
if (state.bm !== "none") basemap.set(state.bm);
