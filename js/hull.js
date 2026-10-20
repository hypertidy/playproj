// playproj: convex hull on the sphere
//
// Points on a globe (left) and in a stereographic map (right). The 3D
// convex hull of the points is drawn flat or pushed out onto the sphere,
// where it is the Delaunay triangulation; its face normals are the Voronoi
// vertices. The hull, circles, cells and map are src/core/sphull.js.

import * as THREE from "three";
import * as H from "../src/core/sphull.js";
import { loadCoastline } from "./data.js";
import { makeStage, readParams, hashWriter, shareLinks, oneOf } from "../src/scene/index.js";

const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";
const EARTH_KM = 6371.0088;

const C = {
  bg: 0x05070d, sphere: 0x0f1a2e, coast: 0x5c6b82, face: 0x2f6f73, back: 0xd08a2c,
  del: 0xdfe7f2, vor: 0x7fe0ff, hi: 0xffd34d, pt: 0xffffff, normal: 0xffd34d,
  delCss: "rgba(223,231,242,0.85)", backCss: "#ffb347", vorCss: "#7fe0ff", hiCss: "#ffd34d",
  hullCss: "#6ab787", coastCss: "rgba(138,151,171,0.6)", ink: "#dfe7f2", muted: "#8a97ab"
};

// Antarctic stations, approximate positions (lon, lat)
const STATIONS = [
  ["Mawson", 62.87, -67.6], ["Davis", 77.97, -68.58], ["Casey", 110.53, -66.28], ["McMurdo", 166.67, -77.85],
  ["Amundsen-Scott", 0, -90], ["Vostok", 106.84, -78.46], ["Concordia", 123.33, -75.1],
  ["Dumont d'Urville", 140.0, -66.66], ["Rothera", -68.13, -67.57], ["Halley", -26.2, -75.6],
  ["Neumayer III", -8.27, -70.67], ["Syowa", 39.58, -69.0], ["Troll", 2.53, -72.01], ["Zhongshan", 76.37, -69.37],
  ["Palmer", -64.05, -64.77], ["Esperanza", -56.99, -63.4], ["Novolazarevskaya", 11.83, -70.77],
  ["Mario Zucchelli", 164.12, -74.69], ["Kunlun", 77.12, -80.42], ["Dome Fuji", 39.7, -77.32]
];
const SETS = ["random", "fib", "cap", "cube", "octahedron", "icosahedron", "stations", "edit"];

// ---------------------------------------------------------------- state

const defaults = {
  set: "random", n: 40, seed: 1, pts: "", inflate: 1, hull: 1, del: 1, vor: 1, cells: 0, circ: 1, coast: 1,
  mlon: 0, mlat: -90, z: 1, cam: null
};
const state = { ...defaults };
function readHash() {
  readParams(state, defaults, {
    set: oneOf(SETS, "random"),
    pts: (raw) => (/^[-0-9.,]*$/.test(raw) ? raw : "")
  });
  state.n = Math.round(Math.max(4, Math.min(1000, state.n)));
  state.seed = Math.round(Math.max(1, Math.min(50, state.seed)));
  state.inflate = Math.max(0, Math.min(1, state.inflate));
  state.mlon = Math.max(-180, Math.min(180, state.mlon));
  state.mlat = Math.max(-90, Math.min(90, state.mlat));
  state.z = Math.max(0.2, Math.min(20, state.z));
  if (state.set === "edit" && !state.pts) state.set = "random";
}
readHash();
const writeHash = hashWriter(state, defaults, { digits: 2 });

// the points, as [lon, lat], and names where they have them
let pts = [], names = [];
function pointsFor() {
  names = [];
  switch (state.set) {
    case "fib": return H.fibonacci(state.n);
    case "cap": return H.random(state.n, state.seed, { cap: 45, lon: 100, lat: -60 });
    case "cube": case "octahedron": case "icosahedron": return H.SOLIDS[state.set].map((p) => p.slice());
    case "stations": names = STATIONS.map((s) => s[0]); return STATIONS.map((s) => [s[1], s[2]]);
    case "edit": {
      const e = state.pts.split(",").map(Number), out = [];
      for (let k = 0; k + 1 < e.length; k += 2) if (isFinite(e[k]) && isFinite(e[k + 1])) out.push([e[k], Math.max(-90, Math.min(90, e[k + 1]))]);
      return out;
    }
    default: return H.random(state.n, state.seed);
  }
}
// once a point moves, the set is the points themselves, in the hash
function edited() {
  if (state.set !== "edit") state.set = "edit";
  state.pts = pts.map(([lon, lat]) => `${+lon.toFixed(2)},${+lat.toFixed(2)}`).join(",");
}

let T = null;   // the triangulation (H.triangulate)
let hover = null;   // { kind: "face" | "point" | "cell", i }
function solve() { T = H.triangulate(pts); }

// ---------------------------------------------------------------- 3D

// unit vector (z north, x at lon 0) to the scene, y up and lon 0 facing +z
const S3 = (p, r = 1) => new THREE.Vector3(p[1] * r, p[2] * r, p[0] * r);
const fromScene = (v) => [v.z, v.x, v.y];

const stage = $("three");
const { renderer, scene, camera, controls, setCamera, resize } = makeStage(stage, {
  bg: C.bg, fov: 36, far: 100,
  onCamera: (c) => { state.cam = c; writeHash(); }
});
controls.minDistance = 1.3;
controls.maxDistance = 12;
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(1, 1.5, 2);
camera.add(sun);
scene.add(camera);

// The sphere, and the Voronoi cells painted on it pixel by pixel: each
// pixel takes the colour of its nearest point, read from a texture of the
// points (exact at any size, where a mesh of cell fans is not once a cell
// is wider than a hemisphere).
const MAXPTS = 1024;
const ptTex = new THREE.DataTexture(new Float32Array(MAXPTS * 4), MAXPTS, 1, THREE.RGBAFormat, THREE.FloatType);
const sphereMat = new THREE.ShaderMaterial({
  uniforms: {
    pts: { value: ptTex }, count: { value: 0 }, cells: { value: 0 },
    base: { value: new THREE.Color(C.sphere) }, opacity: { value: 0.45 }
  },
  vertexShader: `
varying vec3 vP;
void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
uniform sampler2D pts;
uniform int count;
uniform int cells;
uniform vec3 base;
uniform float opacity;
varying vec3 vP;
vec3 hsl(float h, float s, float l) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return l + s * (k - 0.5) * (1.0 - abs(2.0 * l - 1.0));
}
void main() {
  vec3 c = base;
  if (cells == 1) {
    vec3 p = normalize(vP);
    float best = -2.0;
    int bi = 0;
    for (int i = 0; i < ${MAXPTS}; i++) {
      if (i >= count) break;
      float d = dot(p, texelFetch(pts, ivec2(i, 0), 0).xyz);
      if (d > best) { best = d; bi = i; }
    }
    c = hsl(fract(float(bi) * 0.618034), 0.45, 0.42);
  }
  gl_FragColor = vec4(c, opacity);
}`,
  transparent: true, depthWrite: false
});
const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), sphereMat);
sphere.renderOrder = -1;
scene.add(sphere);
function paintCells() {
  const d = ptTex.image.data, X = T ? T.xyz : [];
  X.slice(0, MAXPTS).forEach((p, i) => { const v = S3(p); d.set([v.x, v.y, v.z, 1], 4 * i); });
  ptTex.needsUpdate = true;
  const u = sphereMat.uniforms;
  u.count.value = Math.min(X.length, MAXPTS);
  u.cells.value = state.cells ? 1 : 0;
  u.opacity.value = state.cells ? 0.85 : 0.45;
}

const group = new THREE.Group();   // everything rebuilt with the points
scene.add(group);
const hoverGroup = new THREE.Group();
scene.add(hoverGroup);
let coastLines = null;

function clear(g) {
  for (const o of [...g.children]) { g.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
}
const lineMat = (color, opacity = 1, extra = {}) => new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, ...extra });
function segments(list, mat) {
  const g = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(list, 3));
  return new THREE.LineSegments(g, mat);
}
// a polyline of unit vectors (scaled by r) as segment pairs, pushed onto out
function pushLine(out, line, r = 1) {
  for (let k = 0; k + 1 < line.length; k++) {
    const a = S3(line[k], r), b = S3(line[k + 1], r);
    out.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
}

// a point between the chord and the sphere: t = 0 on the flat face, 1 on the sphere
const lift = (p, t) => {
  const l = Math.hypot(...p), s = 1 - t + t / l;
  return [p[0] * s, p[1] * s, p[2] * s];
};
const mix = (a, b, c, u, v) => {
  const w = 1 - u - v;
  return [w * a[0] + u * b[0] + v * c[0], w * a[1] + u * b[1] + v * c[1], w * a[2] + u * b[2] + v * c[2]];
};
// the chord from a to b, steps segments, lifted by t
const chord = (a, b, t, steps) => Array.from({ length: steps + 1 }, (_, k) => lift(mix(a, b, b, k / steps, 0), t));

const hue = (i) => (i * 0.618034) % 1;

function build() {
  clear(group);
  paintCells();
  if (!T || T.flat) return;
  const t = state.inflate, X = T.xyz, F = T.faces.length;
  // finer faces as they near the sphere, fewer when there are many
  const sub = t === 0 ? 1 : Math.max(2, Math.min(10, Math.round(60 / Math.sqrt(F))));
  const rise = 1 + 0.004 * t;   // lines just off the surface once it is round

  if (state.hull) {
    // the faces the centre sees (amber) fade as they reach the sphere,
    // where they would only cover the others again
    for (const back of [false, true]) {
      const pos = [], col = [], c = new THREE.Color();
      T.faces.forEach(([a, b, cc], f) => {
        if (T.back[f] !== back) return;
        if (back) c.set(C.back);
        else c.set(C.face).offsetHSL(0, 0, (hue(f) - 0.5) * 0.12);
        const P = X[a], Q = X[b], R = X[cc];
        const v = (i, j) => S3(lift(mix(P, Q, R, i / sub, j / sub), t), 0.996 + 0.002 * (1 - t));
        for (let i = 0; i < sub; i++) {
          for (let j = 0; j < sub - i; j++) {
            const tri = [[v(i, j), v(i + 1, j), v(i, j + 1)]];
            if (j < sub - i - 1) tri.push([v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)]);
            for (const q of tri) for (const p of q) { pos.push(p.x, p.y, p.z); col.push(c.r, c.g, c.b); }
          }
        }
      });
      if (!pos.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      g.computeVertexNormals();
      group.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({
        vertexColors: true, transparent: true, opacity: back ? 0.8 - 0.65 * t : 0.8, side: THREE.DoubleSide,
        flatShading: t < 0.5, depthWrite: !back
      })));
    }
  }

  if (state.del) {
    const front = [], back = [];
    for (const [i, j, f, g] of T.edges) {
      const steps = Math.max(2, Math.ceil(H.angle(X[i], X[j]) * 24));
      pushLine(T.back[f] && T.back[g] ? back : front, chord(X[i], X[j], t, steps), rise);
    }
    group.add(segments(front, lineMat(C.del, 0.9)));
    if (back.length) {
      const l = segments(back, new THREE.LineDashedMaterial({ color: C.back, dashSize: 0.03, gapSize: 0.025 }));
      l.computeLineDistances();
      group.add(l);
    }
  }

  if (state.vor) {
    const out = [];
    for (const [, , f, g] of T.edges) {
      const a = T.centres[f], b = T.centres[g];
      pushLine(out, H.arc(a, b, Math.max(2, Math.ceil(H.angle(a, b) * 24))), 1.005);
    }
    group.add(segments(out, lineMat(C.vor, 0.95)));
    const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshBasicMaterial({ color: C.vor }), F);
    const m = new THREE.Matrix4(), r = pointSize() * 0.6;
    T.centres.forEach((p, f) => { const v = S3(p, 1.005); dots.setMatrixAt(f, m.makeScale(r, r, r).setPosition(v)); });
    group.add(dots);
  }

  const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: C.pt }), X.length);
  const m = new THREE.Matrix4(), r = pointSize();
  X.forEach((p, i) => dots.setMatrixAt(i, m.makeScale(r, r, r).setPosition(S3(p, 1.004))));
  group.add(dots);
}
const pointSize = () => Math.max(0.006, Math.min(0.02, 0.12 / Math.sqrt(pts.length)));

function buildHover() {
  clear(hoverGroup);
  if (!T || T.flat || !hover) return;
  const X = T.xyz, t = state.inflate, rise = 1 + 0.006 * t;
  if (hover.kind === "face") {
    const f = hover.i, [a, b, c] = T.faces[f], out = [];
    for (const [p, q] of [[a, b], [b, c], [c, a]]) pushLine(out, chord(X[p], X[q], t, 24), rise);
    hoverGroup.add(segments(out, lineMat(C.hi)));
    const n = T.centres[f], d = T.offset[f];
    if (state.circ) {
      // the face's plane, where it cuts the sphere, and the circle
      const ring = H.circle(n, d, 128);
      const loop = [];
      pushLine(loop, [...ring, ring[0]], 1.003);
      hoverGroup.add(segments(loop, lineMat(C.hi)));
      const disc = new THREE.Mesh(new THREE.CircleGeometry(Math.sqrt(Math.max(0, 1 - d * d)), 96),
        new THREE.MeshBasicMaterial({ color: C.hi, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
      disc.position.copy(S3(n, d));
      disc.lookAt(S3(n, d + 1));
      hoverGroup.add(disc);
    }
    // the normal from the middle of the flat face to its Voronoi vertex
    const m = mix(X[a], X[b], X[c], 1 / 3, 1 / 3);
    hoverGroup.add(segments([...S3(m).toArray(), ...S3(n, 1.006).toArray()], lineMat(C.normal)));
    const dot = new THREE.Mesh(new THREE.SphereGeometry(pointSize() * 1.2, 12, 8), new THREE.MeshBasicMaterial({ color: C.hi }));
    dot.position.copy(S3(n, 1.006));
    hoverGroup.add(dot);
  } else {
    const ring = T.cells[hover.i], out = [];
    for (let r = 0; r < ring.length; r++) {
      const a = T.centres[ring[r]], b = T.centres[ring[(r + 1) % ring.length]];
      pushLine(out, H.arc(a, b, Math.max(2, Math.ceil(H.angle(a, b) * 32))), 1.007);
    }
    hoverGroup.add(segments(out, lineMat(C.hi)));
    const dot = new THREE.Mesh(new THREE.SphereGeometry(pointSize() * 1.5, 12, 8), new THREE.MeshBasicMaterial({ color: C.hi }));
    dot.position.copy(S3(X[hover.i], 1.004));
    hoverGroup.add(dot);
  }
}

function buildCoast(coast) {
  const out = [];
  for (const l of coast) {
    const line = [];
    for (let k = 0; k < l.length; k += 2) line.push(H.toXYZ(l[k], l[k + 1]));
    pushLine(out, line, 1.0015);
  }
  coastLines = segments(out, lineMat(C.coast, 0.8));
  coastLines.visible = !!state.coast;
  scene.add(coastLines);
}

// ---------------------------------------------------------------- the map

const map = $("map");
let mapFrame = null;   // { S, k, cx, cy } map units to pixels
function frameMap() {
  const box = map.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, box.width), h = Math.max(1, box.height);
  if (map.width !== Math.round(w * dpr) || map.height !== Math.round(h * dpr)) { map.width = Math.round(w * dpr); map.height = Math.round(h * dpr); }
  // the hemisphere about the centre is a circle of radius 2
  mapFrame = { S: H.stereo(state.mlon, state.mlat), k: (Math.min(w, h) / 2 / 2.3) * state.z, cx: w / 2, cy: h / 2, w, h, dpr };
}
const toPx = ([x, y]) => [mapFrame.cx + x * mapFrame.k, mapFrame.cy - y * mapFrame.k];
const fromPx = (px, py) => [(px - mapFrame.cx) / mapFrame.k, (mapFrame.cy - py) / mapFrame.k];
const FAR = 1e4;   // pixels: past this a line is near the point at infinity

// a polyline of unit vectors in the map, broken where it runs off to infinity
function mapPath(g, line) {
  let pen = false;
  for (const p of line) {
    const q = toPx(mapFrame.S.forward(p));
    if (!(Math.abs(q[0]) < FAR && Math.abs(q[1]) < FAR)) { pen = false; continue; }
    if (pen) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]);
    pen = true;
  }
}

let coast = null;
function drawMap() {
  frameMap();
  const g = map.getContext("2d"), { S, k, cx, cy, w, h, dpr } = mapFrame;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = "#05070d"; g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(138,151,171,0.35)"; g.lineWidth = 1;
  g.beginPath(); g.arc(cx, cy, 2 * k, 0, 2 * Math.PI); g.stroke();
  g.lineJoin = "round";

  if (coast && state.coast) {
    g.strokeStyle = C.coastCss; g.lineWidth = 1;
    g.beginPath();
    for (const l of coast) {
      const line = [];
      for (let i = 0; i < l.length; i += 2) line.push(H.toXYZ(l[i], l[i + 1]));
      mapPath(g, line);
    }
    g.stroke();
  }
  if (!T || T.flat) { drawPoints(g); return; }
  const X = T.xyz;
  const far = H.nearest(T, S.centre.map((x) => -x));

  if (state.cells) {
    T.cells.forEach((ring, i) => {
      if (i === far) return;   // this one holds the point at infinity
      g.fillStyle = `hsla(${hue(i) * 360}, 45%, 42%, 0.55)`;
      g.beginPath();
      const line = [];
      for (let r = 0; r <= ring.length; r++) {
        const a = T.centres[ring[r % ring.length]], b = T.centres[ring[(r + 1) % ring.length]];
        if (r < ring.length) line.push(...H.arc(a, b, Math.max(2, Math.ceil(H.angle(a, b) * 24))));
      }
      mapPath(g, line);
      g.closePath(); g.fill();
    });
  }

  if (state.hull) {
    // the faces round the far point are the map's outside: their edges
    // with the rest are its convex hull
    g.strokeStyle = C.hullCss; g.lineWidth = 3.5;
    g.beginPath();
    for (const [i, j] of H.mapHull(T, S)) mapPath(g, H.arc(X[i], X[j], 24));
    g.stroke();
  }

  if (state.del) {
    g.lineWidth = 1.2;
    g.strokeStyle = C.delCss;
    g.beginPath();
    for (const [i, j, f, gg] of T.edges) if (!(T.back[f] && T.back[gg])) mapPath(g, H.arc(X[i], X[j], Math.max(2, Math.ceil(H.angle(X[i], X[j]) * 24))));
    g.stroke();
    g.strokeStyle = C.backCss; g.setLineDash([5, 4]);
    g.beginPath();
    for (const [i, j, f, gg] of T.edges) if (T.back[f] && T.back[gg]) mapPath(g, H.arc(X[i], X[j], Math.max(2, Math.ceil(H.angle(X[i], X[j]) * 24))));
    g.stroke();
    g.setLineDash([]);
  }

  if (state.vor) {
    g.strokeStyle = C.vorCss; g.lineWidth = 1.2;
    g.beginPath();
    for (const [, , f, gg] of T.edges) {
      const a = T.centres[f], b = T.centres[gg];
      mapPath(g, H.arc(a, b, Math.max(4, Math.ceil(H.angle(a, b) * 48))));
    }
    g.stroke();
  }

  if (hover && hover.kind === "face") {
    const f = hover.i, [a, b, c] = T.faces[f];
    g.strokeStyle = C.hiCss; g.lineWidth = 2;
    g.beginPath();
    mapPath(g, [...H.arc(X[a], X[b], 32), ...H.arc(X[b], X[c], 32), ...H.arc(X[c], X[a], 32)]);
    g.stroke();
    const cc = state.circ && H.mapCircle(T, f, S);
    if (cc && cc.r * k < FAR) {
      // drawn as a true circle: stereographic keeps it one
      const [px, py] = toPx([cc.x, cc.y]);
      g.lineWidth = 1.5; g.setLineDash(cc.outside ? [6, 4] : []);
      g.beginPath(); g.arc(px, py, cc.r * k, 0, 2 * Math.PI); g.stroke();
      g.setLineDash([]);
    }
  } else if (hover) {
    const ring = T.cells[hover.i];
    g.strokeStyle = C.hiCss; g.lineWidth = 2;
    g.beginPath();
    const line = [];
    for (let r = 0; r < ring.length; r++) {
      const a = T.centres[ring[r]], b = T.centres[ring[(r + 1) % ring.length]];
      line.push(...H.arc(a, b, Math.max(4, Math.ceil(H.angle(a, b) * 48))));
    }
    mapPath(g, line);
    g.stroke();
  }
  drawPoints(g);
}
function drawPoints(g) {
  const r = pts.length > 300 ? 1.8 : 3;
  g.fillStyle = "#fff";
  for (const p of T ? T.xyz : pts.map(([lon, lat]) => H.toXYZ(lon, lat))) {
    const q = toPx(mapFrame.S.forward(p));
    if (Math.abs(q[0]) > FAR || Math.abs(q[1]) > FAR) continue;
    g.beginPath(); g.arc(q[0], q[1], r, 0, 2 * Math.PI); g.fill();
  }
  if (hover && hover.kind !== "face") {
    const q = toPx(mapFrame.S.forward(T.xyz[hover.i]));
    g.fillStyle = C.hiCss;
    g.beginPath(); g.arc(q[0], q[1], r + 2, 0, 2 * Math.PI); g.fill();
  }
  // the map centre
  g.strokeStyle = "rgba(223,231,242,0.5)"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(mapFrame.cx - 6, mapFrame.cy); g.lineTo(mapFrame.cx + 6, mapFrame.cy);
  g.moveTo(mapFrame.cx, mapFrame.cy - 6); g.lineTo(mapFrame.cx, mapFrame.cy + 6); g.stroke();
}

// ---------------------------------------------------------------- picking and dragging

// what is under unit vector p: a point within tol (radians), a triangle, or
// the cell of the nearest point outside the hull
function pick(p, tol) {
  if (!T || T.flat) return null;
  const i = H.nearest(T, p);
  if (i >= 0 && H.angle(p, T.xyz[i]) < tol) return { kind: "point", i };
  const f = H.locate(T, p);
  return f >= 0 ? { kind: "face", i: f } : { kind: "cell", i };
}
function setHover(h) {
  const same = (h && hover && h.kind === hover.kind && h.i === hover.i) || (!h && !hover);
  hover = h;
  if (!same) { buildHover(); drawMap(); readout(); }
}

const ray = new THREE.Raycaster();
function globeHit(e) {
  const box = renderer.domElement.getBoundingClientRect();
  const v = new THREE.Vector2(((e.clientX - box.left) / box.width) * 2 - 1, -((e.clientY - box.top) / box.height) * 2 + 1);
  ray.setFromCamera(v, camera);
  const hit = ray.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), new THREE.Vector3());
  return hit ? fromScene(hit) : null;
}
// angular size of tol pixels on the globe
const globeTol = (px) => {
  const d = camera.position.length() - 1, hpx = renderer.domElement.clientHeight || 1;
  return (2 * d * Math.tan((camera.fov * Math.PI) / 360) * px) / hpx;
};

function movePoint(i, p) {
  pts[i] = H.toLonLat(p);
  edited(); solve(); build(); buildHover(); drawMap(); readout(); writeHash();
}
function addPoint(p) {
  pts.push(H.toLonLat(p));
  if (state.set === "stations") names.push("");
  edited(); solve(); build(); setHover(null); buildHover(); drawMap(); readout(); sync(); writeHash();
}
function removePoint(i) {
  if (pts.length <= 4) return;
  pts.splice(i, 1);
  if (names.length) names.splice(i, 1);
  edited(); solve(); hover = null; build(); buildHover(); drawMap(); readout(); sync(); writeHash();
}

// drag a point, click to add, shift-click to remove; anything else orbits
function pointerTool(el, { hit, tol, onPan }) {
  let drag = null, down = null;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const p = hit(e);
    down = { x: e.clientX, y: e.clientY, p };
    const h = p && pick(p, tol());
    if (h && h.kind === "point") {
      if (e.shiftKey) { removePoint(h.i); down = null; return; }
      drag = h.i;
      controls.enabled = false;
      el.setPointerCapture(e.pointerId);
      e.stopImmediatePropagation();
    } else if (onPan) onPan.start(e);
  }, { capture: true });
  el.addEventListener("pointermove", (e) => {
    if (drag !== null) { const p = hit(e); if (p) movePoint(drag, p); return; }
    if (down && onPan && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) { onPan.move(e); return; }
    if (e.buttons) return;
    const p = hit(e);
    setHover(p ? pick(p, tol()) : null);
  });
  el.addEventListener("pointerup", (e) => {
    if (drag !== null) { drag = null; controls.enabled = true; down = null; return; }
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4 && down.p && !e.shiftKey) addPoint(down.p);
    if (onPan) onPan.end();
    down = null;
  });
  el.addEventListener("pointerleave", () => { if (drag === null) setHover(null); });
}

pointerTool(renderer.domElement, { hit: globeHit, tol: () => globeTol(9) });

const mapHit = (e) => {
  const box = map.getBoundingClientRect();
  return H.unit(mapFrame.S.inverse(fromPx(e.clientX - box.left, e.clientY - box.top)));
};
// the map's background drags its centre: the point grabbed follows the pointer
let pan = null;
pointerTool(map, {
  hit: mapHit,
  // a pixel in the map is 1 / k map units, about 1 / k radians near the centre
  tol: () => 9 / mapFrame.k,
  onPan: {
    start(e) { pan = { x: e.clientX, y: e.clientY, S: mapFrame.S }; },
    move(e) {
      if (!pan) return;
      const dx = (e.clientX - pan.x) / mapFrame.k, dy = (e.clientY - pan.y) / mapFrame.k;
      const [lon, lat] = H.toLonLat(H.unit(pan.S.inverse([-dx, dy])));
      state.mlon = Math.round(lon * 10) / 10; state.mlat = Math.round(lat * 10) / 10;
      drawMap(); sync(); writeHash();
    },
    end() { pan = null; }
  }
});
map.addEventListener("wheel", (e) => {
  e.preventDefault();
  state.z = Math.max(0.2, Math.min(20, state.z * Math.exp(-e.deltaY * 0.0015)));
  drawMap(); writeHash();
}, { passive: false });

// ---------------------------------------------------------------- readout

const fmt = (x, d = 1) => (Math.abs(x) < 10 ** -d / 2 ? 0 : x).toFixed(d);
const ll = ([lon, lat]) => `${fmt(Math.abs(lon))}${DEG}${lon < 0 ? "W" : "E"} ${fmt(Math.abs(lat))}${DEG}${lat < 0 ? "S" : "N"}`;
const km2 = (sr) => {
  const a = sr * EARTH_KM * EARTH_KM;
  return a >= 1e6 ? `${(a / 1e6).toFixed(2)} million km\u00b2` : `${Math.round(a).toLocaleString("en")} km\u00b2`;
};
const label = (i) => (names[i] ? names[i] : `point ${i + 1}`);

function readout() {
  const rows = [];
  if (!T || T.flat) {
    rows.push(["Points", pts.length], ["Hull", "none: the points lie in one plane"]);
  } else {
    const n = pts.length, F = T.faces.length, back = T.back.filter(Boolean).length;
    const ties = T.edges.filter(([, , f, g]) => H.dot(T.centres[f], T.centres[g]) > 1 - 1e-9).length;
    rows.push(["Points (corners)", n], ["Faces, Delaunay triangles", `${F} (2n - 4 = ${2 * n - 4})`],
      ["Edges", `${T.edges.length} (3n - 6 = ${3 * n - 6})`], ["Voronoi vertices", F],
      ["Centre of the sphere", back ? `outside the hull, ${back} faces see it` : "inside the hull"]);
    if (ties) rows.push(["Ties", `${ties} edges join two triangles in one plane`]);
    if (hover && hover.kind === "face") {
      const f = hover.i, v = T.faces[f];
      const margin = Math.min(...T.xyz.map((p, i) => (v.includes(i) ? Infinity : H.angle(T.centres[f], p)))) - T.radius[f];
      const [a, b, c] = v.map((i) => T.xyz[i]);
      rows.push(["Triangle", v.map(label).join(", ")],
        ["Circle radius", `${fmt(T.radius[f] * 180 / Math.PI, 2)}${DEG}${T.back[f] ? " (wider than a hemisphere)" : ""}`],
        ["Centre (Voronoi vertex)", ll(H.toLonLat(T.centres[f]))],
        ["Nearest other point", isFinite(margin) ? `${fmt(margin * 180 / Math.PI, 2)}${DEG} outside the circle` : "none"],
        ["Area", T.back[f] ? `${km2(-H.triArea(a, b, c))} (the same ground as front faces)` : km2(H.triArea(a, b, c))]);
    } else if (hover) {
      const i = hover.i;
      rows.push([hover.kind === "point" ? "Point" : "Nearest point", label(i)], ["At", ll(pts[i])],
        ["Neighbours", T.cells[i].length], ["Voronoi cell", `${km2(H.cellArea(T, i))}, ${fmt(H.cellArea(T, i) / (4 * Math.PI) * 100, 2)}% of the sphere`]);
    }
    if (T.dropped.length) rows.push(["Dropped", `${T.dropped.length} repeated points`]);
  }
  $("out").innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
}

// ---------------------------------------------------------------- controls

const PRESETS = [
  ["The hull, flat", { set: "random", n: 30, seed: 3, inflate: 0, hull: 1, del: 1, vor: 0, cells: 0, circ: 1 }],
  ["Pushed onto the sphere", { set: "random", n: 30, seed: 3, inflate: 1, hull: 1, del: 1, vor: 0, cells: 0, circ: 1 }],
  ["Normals are Voronoi", { set: "random", n: 30, seed: 3, inflate: 0.35, hull: 1, del: 1, vor: 1, cells: 0, circ: 1 }],
  ["Voronoi cells", { set: "fib", n: 120, inflate: 1, hull: 0, del: 0, vor: 1, cells: 1, circ: 0 }],
  ["Four on a circle", { set: "cube", inflate: 0, hull: 1, del: 1, vor: 1, cells: 0, circ: 1 }],
  ["One hemisphere", { set: "cap", n: 40, seed: 2, inflate: 1, hull: 1, del: 1, vor: 1, cells: 0, circ: 1, mlon: 100, mlat: -60 }],
  ["Nearest station", { set: "stations", inflate: 1, hull: 0, del: 0, vor: 1, cells: 1, circ: 0, mlon: 0, mlat: -90, z: 3.5 }],
  ["Planar Delaunay", { set: "random", n: 60, seed: 5, inflate: 1, hull: 1, del: 1, vor: 0, cells: 0, circ: 1, mlon: 0, mlat: 90, z: 1 }]
];
for (const [name, p] of PRESETS) {
  const bt = document.createElement("button");
  bt.type = "button"; bt.textContent = name;
  bt.addEventListener("click", () => {
    Object.assign(state, { mlon: 0, mlat: -90, z: 1, pts: "" }, p);
    hover = null;
    reset();
  });
  $("presets").appendChild(bt);
}

const ui = {
  set: $("set"), n: $("n"), seed: $("seed"), inflate: $("inflate"), mlon: $("mlon"), mlat: $("mlat"),
  hull: $("hull"), del: $("del"), vor: $("vor"), cells: $("cells"), circ: $("circ"), coast: $("coast")
};
ui.set.addEventListener("change", () => { state.set = ui.set.value; if (state.set !== "edit") state.pts = ""; hover = null; reset(); });
for (const k of ["n", "seed"]) ui[k].addEventListener("input", () => { state[k] = +ui[k].value; hover = null; reset(); });
ui.inflate.addEventListener("input", () => { state.inflate = +ui.inflate.value; build(); buildHover(); sync(); writeHash(); });
for (const k of ["mlon", "mlat"]) ui[k].addEventListener("input", () => { state[k] = +ui[k].value; drawMap(); sync(); writeHash(); });
for (const k of ["hull", "del", "vor", "cells", "circ", "coast"]) {
  ui[k].addEventListener("change", () => { state[k] = ui[k].checked ? 1 : 0; build(); buildHover(); drawMap(); sync(); writeHash(); });
}
$("reset-pts").addEventListener("click", () => {
  if (state.set === "edit") state.set = "random";
  state.pts = ""; hover = null; reset();
});
$("reset-view").addEventListener("click", () => { state.cam = null; state.z = 1; setCamera(defaultCam()); drawMap(); writeHash(); });

function defaultCam() {
  // looking at the middle of the points, from far enough to see the globe
  const s = pts.reduce((a, [lon, lat]) => { const p = H.toXYZ(lon, lat); return a.map((x, k) => x + p[k]); }, [0, 0, 0]);
  const d = Math.hypot(...s) > 0.3 * pts.length ? H.unit(s) : H.toXYZ(20, 25);
  const vf = (camera.fov * Math.PI) / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
  const v = S3(H.unit([d[0] + 0.1, d[1] + 0.05, d[2] + 0.12]), 1.12 / Math.sin(Math.min(vf, hf) / 2));
  return [v.x, v.y, v.z, 0, 0, 0];
}

function sync() {
  ui.set.value = state.set;
  ui.n.value = state.n; ui.seed.value = state.seed;
  $("n-out").textContent = state.set === "edit" || !["random", "fib", "cap"].includes(state.set) ? pts.length : state.n;
  $("seed-out").textContent = state.seed;
  $("n-box").hidden = !["random", "fib", "cap"].includes(state.set);
  ui.seed.disabled = state.set === "fib";
  ui.inflate.value = state.inflate;
  $("inflate-out").textContent = state.inflate === 0 ? "flat" : state.inflate === 1 ? "on the sphere" : state.inflate.toFixed(2);
  ui.mlon.value = state.mlon; ui.mlat.value = state.mlat;
  $("mlon-out").textContent = `${fmt(state.mlon)}${DEG}`; $("mlat-out").textContent = `${fmt(state.mlat)}${DEG}`;
  for (const k of ["hull", "del", "vor", "cells", "circ", "coast"]) ui[k].checked = !!state[k];
  if (coastLines) coastLines.visible = !!state.coast;
  $("map-label").textContent = `Stereographic, centred ${ll([state.mlon, state.mlat])}`;
}

// new points from the state, and everything after
function reset({ keepCam = false } = {}) {
  pts = pointsFor();
  if (state.set === "edit" && pts.length < 4) { state.set = "random"; state.pts = ""; pts = pointsFor(); }
  solve(); build(); buildHover(); drawMap(); readout(); sync();
  if (!keepCam) { state.cam = null; setCamera(defaultCam()); }
  writeHash();
}

window.addEventListener("hashchange", () => {
  readHash();
  hover = null;
  reset({ keepCam: true });
  if (state.cam) setCamera(state.cam);
});

const main = $("stage");
new ResizeObserver(() => { main.classList.toggle("stacked", main.clientHeight > main.clientWidth); drawMap(); }).observe(main);
shareLinks("playproj: convex hull on the sphere", { height: 520 });

// ---------------------------------------------------------------- go

pts = pointsFor();
solve(); build(); sync(); readout();
resize();
setCamera(state.cam || defaultCam());
drawMap();
loadCoastline("110m").then((c) => { coast = c; buildCoast(c); drawMap(); }).catch(() => {});

renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
// for tests: the triangulation on show
window.__hull = () => T;
