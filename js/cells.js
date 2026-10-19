// playproj: s2 cells.
//
// Six square patches, one per cube face, each textured with its own canvas
// drawn in the face's (s, t) cell coordinates. Unfold moves every patch from
// the globe out to the cube (radially, the gnomonic projection) and then
// hinges the faces open into the staircase net 0-1-2-3-4-5, along which the
// Hilbert curve runs unbroken.
//
// Close up restricts the view to the picked cell and its neighbours on the
// same face, placed in doubles and then moved into a local frame scaled to
// the window, so the deepest levels are drawn as well as the first.

import * as THREE from "three";
import * as s2 from "../src/core/s2.js";
import { loadCoastline } from "./data.js";
import { warpCanvas, readWindow } from "./basemap-load.js";
import { sampleWindow } from "../src/core/basemap.js";
import { basemapControl, exportControl } from "./basemap-ui.js";
import { gnomonic, ringOf } from "../src/core/cellexport.js";
import { makeStage, readParams, hashWriter, shareLinks, copyText } from "../src/scene/index.js";

const DEG = "\u00b0";
const TEX = 1024;
const N = 32;                      // patch grid per face
const MAX_DRAW = { grid: 8, curve: 7 };

const COLORS = {
  bg: 0x05070d,
  face: ["#1c3557", "#1d3a3a", "#33284f", "#3d2a26", "#2c3a22", "#3a2c3f"],
  coast: "#d7ecff",
  grid: "rgba(215,236,255,0.35)",
  uv: "rgba(255,179,71,0.75)",
  pick: "#ffd34d"
};

// s2 x, y, z (x to 0,0; z north) to the scene: face 0 towards the camera
const toScene = (p) => new THREE.Vector3(p[1], p[2], p[0]);

// ---------------------------------------------------------------- state

const defaults = { lvl: 3, t: 0, curve: 1, grid: 1, coast: 1, uvgrid: 0, cell: "", close: 0, bm: "none", cam: null };
const state = { ...defaults };

function readHash() {
  readParams(state, defaults, {
    bm: String,
    cell: (raw) => (s2.fromToken(raw) ? raw.toLowerCase() : "")
  });
  state.lvl = Math.max(0, Math.min(12, Math.round(state.lvl)));
  state.t = Math.max(0, Math.min(1, state.t));
  state.close = state.close && state.cell ? 1 : 0;
}

const writeHash = hashWriter(state, defaults);

// ---------------------------------------------------------------- face textures

let coastPaths = null;   // per face, a Path2D in texture pixels

function buildCoast(lines) {
  coastPaths = [];
  for (let face = 0; face < 6; face++) {
    const ax = s2.faceAxis(face), path = new Path2D();
    for (const l of lines) {
      let pen = false;
      for (let i = 0; i < l.length; i += 2) {
        const p = s2.toXYZ(l[i], l[i + 1]);
        // keep points within reach of this face, so lines run off its edges
        if (p[0] * ax[0] + p[1] * ax[1] + p[2] * ax[2] < 0.3) { pen = false; continue; }
        const [u, v] = s2.faceUV(face, p);
        const x = s2.uvToST(u) * TEX, y = (1 - s2.uvToST(v)) * TEX;
        if (pen) path.lineTo(x, y); else path.moveTo(x, y);
        pen = true;
      }
    }
    coastPaths.push(path);
  }
}

const canvases = [], textures = [];
for (let f = 0; f < 6; f++) {
  const c = document.createElement("canvas");
  c.width = c.height = TEX;
  canvases.push(c);
  const tx = new THREE.CanvasTexture(c);
  tx.colorSpace = THREE.SRGBColorSpace;
  tx.anisotropy = 4;
  textures.push(tx);
}

// the basemap on each face, warped into the face's (s, t)
let bmFaces = null;
const BM_TEX = 512;
function buildBasemapFaces(world) {
  bmFaces = !world ? null : [0, 1, 2, 3, 4, 5].map((f) =>
    warpCanvas(world, BM_TEX, BM_TEX, (s, t) => s2.toLonLat(s2.faceUVtoXYZ(f, s2.stToUV(s), s2.stToUV(t)))));
}

const hue = (x) => `hsl(${Math.round(300 * x)}, 85%, 62%)`;

function drawFace(face, picked) {
  const ctx = canvases[face].getContext("2d"), L = state.lvl, n = 1 << L;
  ctx.fillStyle = COLORS.face[face];
  if (bmFaces) {
    ctx.drawImage(bmFaces[face], 0, 0, TEX, TEX);
    ctx.globalAlpha = 0.3;
  }
  ctx.fillRect(0, 0, TEX, TEX);
  ctx.globalAlpha = 1;

  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.font = `bold ${TEX * 0.5}px system-ui, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(String(face), TEX / 2, TEX / 2);

  if (state.coast && coastPaths) {
    ctx.strokeStyle = COLORS.coast; ctx.lineWidth = 1.6; ctx.globalAlpha = 0.85;
    ctx.stroke(coastPaths[face]);
    ctx.globalAlpha = 1;
  }

  if (state.grid && L <= MAX_DRAW.grid) {
    ctx.strokeStyle = COLORS.grid; ctx.lineWidth = L > 6 ? 0.6 : 1.2;
    ctx.beginPath();
    for (let k = 0; k <= n; k++) {
      const x = (k / n) * TEX;
      ctx.moveTo(x, 0); ctx.lineTo(x, TEX); ctx.moveTo(0, x); ctx.lineTo(TEX, x);
    }
    ctx.stroke();
  }
  if (state.uvgrid && L <= MAX_DRAW.grid) {
    // the same grid without the quadratic stretch: even steps in u, v
    ctx.strokeStyle = COLORS.uv; ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let k = 0; k <= n; k++) {
      const x = s2.uvToST(-1 + (2 * k) / n) * TEX;
      ctx.moveTo(x, 0); ctx.lineTo(x, TEX); ctx.moveTo(0, TEX - x); ctx.lineTo(TEX, TEX - x);
    }
    ctx.stroke();
  }

  if (state.curve && L <= MAX_DRAW.curve) {
    const cells = s2.hilbertCells(face, L), total = 6 * cells.length;
    ctx.lineWidth = L > 5 ? 1.5 : 3; ctx.lineJoin = "round";
    const pt = ([i, j]) => [((i + 0.5) / n) * TEX, (1 - (j + 0.5) / n) * TEX];
    const chunk = Math.max(1, cells.length >> 6);
    for (let k = 0; k < cells.length - 1; k += chunk) {
      ctx.strokeStyle = hue((face * cells.length + k) / total);
      ctx.beginPath(); ctx.moveTo(...pt(cells[k]));
      for (let m = k + 1; m <= Math.min(k + chunk, cells.length - 1); m++) ctx.lineTo(...pt(cells[m]));
      ctx.stroke();
    }
    if (L === 0) {
      ctx.fillStyle = hue(face / 6);
      ctx.beginPath(); ctx.arc(TEX / 2, TEX / 2, 10, 0, 2 * Math.PI); ctx.fill();
    }
    // where the curve enters this face, and where it leaves for the next
    ctx.fillStyle = "#ffffff";
    for (const c of [cells[0], cells[cells.length - 1]]) {
      ctx.beginPath(); ctx.arc(...pt(c), L > 5 ? 4 : 7, 0, 2 * Math.PI); ctx.fill();
    }
  }

  if (picked && picked.face === face) {
    const x = picked.s0 * TEX, y = (1 - picked.t0 - picked.d) * TEX, w = picked.d * TEX;
    ctx.strokeStyle = COLORS.pick; ctx.lineWidth = 4;
    ctx.strokeRect(x, y, Math.max(w, 1), Math.max(w, 1));
    if (w < 12) {
      ctx.beginPath(); ctx.arc(x + w / 2, y + w / 2, 14, 0, 2 * Math.PI); ctx.stroke();
    } else {
      ctx.fillStyle = "rgba(255,211,77,0.25)"; ctx.fillRect(x, y, w, w);
    }
  }
  textures[face].needsUpdate = true;
}

// ---------------------------------------------------------------- scene

const stage = document.getElementById("three");
const { renderer, scene, camera, controls, setCamera, resize } = makeStage(stage, {
  bg: COLORS.bg,
  onCamera: (c) => { state.cam = c; writeHash(); }
});

const DEFAULT_CAM = [2.4, 1.9, 5.4, 0, 0, 0];
const CLOSE_CAM = [0.5, -1.1, 2.9, 0, 0, 0];
const defaultCam = () => (state.close ? CLOSE_CAM : DEFAULT_CAM);

// Close up holds the camera near the window: nothing outside it is drawn
function viewLimits() {
  controls.minDistance = state.close ? 0.4 : 0;
  controls.maxDistance = state.close ? 8 : Infinity;
}
setCamera(defaultCam());

const group = new THREE.Group();
scene.add(group);

const index = [];
for (let j = 0; j < N; j++)
  for (let i = 0; i < N; i++) {
    const a = j * (N + 1) + i, b = a + N + 1;
    index.push(a, a + 1, b, a + 1, b + 1, b);
  }
const uv = new Float32Array((N + 1) * (N + 1) * 2);
for (let j = 0, k = 0; j <= N; j++)
  for (let i = 0; i <= N; i++, k++) { uv[2 * k] = i / N; uv[2 * k + 1] = j / N; }

const meshes = [];
for (let f = 0; f < 6; f++) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array((N + 1) * (N + 1) * 3), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: textures[f], side: THREE.DoubleSide }));
  mesh.userData.face = f;
  meshes.push(mesh);
  group.add(mesh);
}

// The hinges of the staircase net: face k opens about the cube edge it
// shares with face k - 1. Each hinge is an axis through two points and the
// sign that opens the face outwards, found from the folded cube.
const hinges = [null];
for (let k = 1; k < 6; k++) {
  const a = toScene(s2.faceAxis(k - 1)), b = toScene(s2.faceAxis(k));
  const c = new THREE.Vector3().crossVectors(a, b);
  const p0 = a.clone().add(b).sub(c), p1 = a.clone().add(b).add(c);
  const axis = c.clone().normalize(), mid = a.clone().add(b);
  // open outwards: the face's centre ends up on the far side of the hinge from the parent's
  const test = b.clone().sub(mid).applyAxisAngle(axis, Math.PI / 2);
  const sign = test.dot(a.clone().sub(mid)) < 0 ? 1 : -1;
  hinges.push({ p0, axis, sign, p1 });
}

// position of face (s, t) at unfold t: 0 globe, 0.5 cube, 1 net
function placer(face, t) {
  const a1 = Math.min(1, 2 * t), a2 = Math.max(0, 2 * t - 1);
  const ang = (Math.PI / 2) * a2;
  const q = [];
  for (let k = face; k >= 1; k--) q.push(new THREE.Quaternion().setFromAxisAngle(hinges[k].axis, hinges[k].sign * ang));
  const v = new THREE.Vector3();
  return (s, t2, out, i) => {
    const p = s2.faceUVtoXYZ(face, s2.stToUV(s), s2.stToUV(t2));
    const r = Math.hypot(p[0], p[1], p[2]);
    const m = 1 / r + (1 - 1 / r) * a1;
    v.set(p[1] * m, p[2] * m, p[0] * m);
    // hinge from the deepest face up: each rotation about its edge as it is in the cube
    for (let k = face, n = 0; k >= 1; k--, n++) v.sub(hinges[k].p0).applyQuaternion(q[n]).add(hinges[k].p0);
    out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
  };
}

// centre of the open net, to slide it into view as it opens
const netCentre = (() => {
  const c = new THREE.Vector3(), o = [0, 0, 0];
  for (let f = 0; f < 6; f++) { placer(f, 1)(0.5, 0.5, o, 0); c.add(new THREE.Vector3(...o)); }
  return c.divideScalar(6);
})();

const ease = (x) => x * x * (3 - 2 * x);

function rebuildScene() {
  for (let f = 0; f < 6; f++) {
    const place = placer(f, state.t), pos = meshes[f].geometry.attributes.position;
    for (let j = 0, k = 0; j <= N; j++)
      for (let i = 0; i <= N; i++, k++) place(i / N, j / N, pos.array, 3 * k);
    pos.needsUpdate = true;
    meshes[f].geometry.computeBoundingSphere();
  }
  const e = ease(Math.max(0, 2 * state.t - 1));
  group.position.copy(netCentre).multiplyScalar(-e * 0.55);
  group.scale.setScalar(1 - 0.45 * e);
}

// ---------------------------------------------------------------- close up

const TEXC = 2048;
const closeCanvas = document.createElement("canvas");
closeCanvas.width = closeCanvas.height = TEXC;
const closeTex = new THREE.CanvasTexture(closeCanvas);
closeTex.colorSpace = THREE.SRGBColorSpace;
closeTex.anisotropy = 4;
const closeMesh = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array((N + 1) * (N + 1) * 3), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: closeTex, side: THREE.DoubleSide }));
})();
closeMesh.visible = false;
scene.add(closeMesh);

// the picked cell and up to one cell either side of it, in its face's (s, t)
function closeWindow(c) {
  const s0 = Math.max(0, c.s0 - c.d), s1 = Math.min(1, c.s0 + 2 * c.d);
  const t0 = Math.max(0, c.t0 - c.d), t1 = Math.min(1, c.t0 + 2 * c.d);
  return { face: c.face, level: c.level, d: c.d, s0, s1, t0, t1, key: `${c.face}/${c.level}/${s0}/${t0}` };
}
const winLonLat = (w, a, b) =>
  s2.toLonLat(s2.faceUVtoXYZ(w.face, s2.stToUV(w.s0 + a * (w.s1 - w.s0)), s2.stToUV(w.t0 + b * (w.t1 - w.t0))));

// the basemap under the window: the global image warped at once, then a
// finer read where the source has one
let closeBm = { key: "", canvas: null };
function closeBasemap(w) {
  const key = `${basemap.id}:${w.key}`;
  if (!basemap.world) return null;
  if (closeBm.key === key) return closeBm.canvas;
  closeBm = { key, canvas: warpCanvas(basemap.world, 512, 512, (a, b) => winLonLat(w, a, b)) };
  const ll = [];
  for (let k = 0; k <= 8; k++) for (const [a, b] of [[k / 8, 0], [k / 8, 1], [0, k / 8], [1, k / 8]]) ll.push(winLonLat(w, a, b));
  const lon = ll.map((p) => p[0]), lat = ll.map((p) => p[1]);
  const box = { west: Math.min(...lon), east: Math.max(...lon), south: Math.min(...lat), north: Math.max(...lat) };
  // across the antimeridian or a pole the global image has to do
  if (box.east - box.west < 90 && Math.abs(box.north) < 89 && Math.abs(box.south) < 89) {
    readWindow(basemap.id, box, Math.max(box.east - box.west, box.north - box.south) / 512).then((win) => {
      if (closeBm.key !== key || win.global) return;
      const c = document.createElement("canvas");
      c.width = c.height = 512;
      const ctx = c.getContext("2d"), img = ctx.createImageData(512, 512);
      for (let j = 0; j < 512; j++)
        for (let i = 0; i < 512; i++) {
          const [lo, la] = winLonLat(w, (i + 0.5) / 512, 1 - (j + 0.5) / 512);
          sampleWindow(win, lo, la, img.data, (j * 512 + i) * 4);
        }
      ctx.putImageData(img, 0, 0);
      closeBm.canvas = c;
      sync();
    }, () => {});
  }
  return closeBm.canvas;
}

let coastFine = null;   // 50 m coastline, loaded the first time close up is on

// a segment clipped to the box [lo, hi] in both x and y (Liang-Barsky), or null
function clipSeg(x0, y0, x1, y1, lo, hi) {
  let a = 0, b = 1;
  const dx = x1 - x0, dy = y1 - y0;
  for (const [p, q] of [[-dx, x0 - lo], [dx, hi - x0], [-dy, y0 - lo], [dy, hi - y0]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > b) return null; if (r > a) a = r; } else { if (r < a) return null; if (r < b) b = r; }
  }
  return [x0 + a * dx, y0 + a * dy, x0 + b * dx, y0 + b * dy];
}

function drawClose(w, picked) {
  const ctx = closeCanvas.getContext("2d"), W = w.s1 - w.s0, H = w.t1 - w.t0;
  const X = (s) => ((s - w.s0) / W) * TEXC, Y = (t) => (1 - (t - w.t0) / H) * TEXC;
  ctx.fillStyle = COLORS.face[w.face];
  const bm = closeBasemap(w);
  if (bm) { ctx.drawImage(bm, 0, 0, TEXC, TEXC); ctx.globalAlpha = 0.3; }
  ctx.fillRect(0, 0, TEXC, TEXC);
  ctx.globalAlpha = 1;

  const lines = state.coast && (coastFine || null);
  if (lines) {
    const ax = s2.faceAxis(w.face);
    ctx.strokeStyle = COLORS.coast; ctx.lineWidth = 3; ctx.globalAlpha = 0.85;
    ctx.beginPath();
    for (const l of lines) {
      let prev = null;
      for (let i = 0; i < l.length; i += 2) {
        const p = s2.toXYZ(l[i], l[i + 1]);
        if (p[0] * ax[0] + p[1] * ax[1] + p[2] * ax[2] < 0.3) { prev = null; continue; }
        const [u, v] = s2.faceUV(w.face, p);
        const cur = [(s2.uvToST(u) - w.s0) / W, (s2.uvToST(v) - w.t0) / H];
        if (prev) {
          const c = clipSeg(prev[0], prev[1], cur[0], cur[1], -0.01, 1.01);
          if (c) { ctx.moveTo(c[0] * TEXC, (1 - c[1]) * TEXC); ctx.lineTo(c[2] * TEXC, (1 - c[3]) * TEXC); }
        }
        prev = cur;
      }
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // the grid at the picked level and the two below it, faint to strong
  if (state.grid) {
    for (let k = 2; k >= 0; k--) {
      if (w.level + k > s2.MAX_LEVEL) continue;
      const step = w.d / 2 ** k;
      ctx.strokeStyle = COLORS.grid; ctx.lineWidth = [3, 1.6, 0.8][k]; ctx.globalAlpha = [1, 0.7, 0.45][k];
      ctx.beginPath();
      for (let s = w.s0; s <= w.s1 + step / 2; s += step) { ctx.moveTo(X(s), 0); ctx.lineTo(X(s), TEXC); }
      for (let t = w.t0; t <= w.t1 + step / 2; t += step) { ctx.moveTo(0, Y(t)); ctx.lineTo(TEXC, Y(t)); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // the curve three levels down: the window's cells in id order, broken
  // where the curve leaves the window and comes back
  if (state.curve) {
    const L = Math.min(s2.MAX_LEVEL, w.level + 3), dc = w.d / 2 ** (L - w.level);
    const ni = Math.round(W / dc), nj = Math.round(H / dc), cells = [];
    for (let j = 0; j < nj; j++)
      for (let i = 0; i < ni; i++) {
        const s = w.s0 + (i + 0.5) * dc, t = w.t0 + (j + 0.5) * dc;
        cells.push({ id: s2.cellFromFaceST(w.face, s, t, L), x: X(s), y: Y(t) });
      }
    cells.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const stepId = 2n << BigInt(2 * (s2.MAX_LEVEL - L));
    ctx.lineWidth = 4; ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (let k = 1; k < cells.length; k++) {
      if (cells[k].id - cells[k - 1].id !== stepId) continue;
      ctx.strokeStyle = hue(k / cells.length);
      ctx.beginPath(); ctx.moveTo(cells[k - 1].x, cells[k - 1].y); ctx.lineTo(cells[k].x, cells[k].y); ctx.stroke();
    }
  }

  // each cell of the picked level with its token
  const px = (w.d / W) * TEXC;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let t = w.t0 + w.d / 2; t < w.t1; t += w.d)
    for (let s = w.s0 + w.d / 2; s < w.s1; s += w.d) {
      const tok = s2.toToken(s2.cellFromFaceST(w.face, s, t, w.level));
      ctx.font = `bold ${Math.min(px * 0.11, (px * 1.5) / tok.length)}px system-ui, sans-serif`;
      ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillText(tok, X(s) + 2, Y(t) + 2);
      ctx.fillStyle = tok === state.cell ? COLORS.pick : "rgba(255,255,255,0.85)"; ctx.fillText(tok, X(s), Y(t));
    }
  ctx.strokeStyle = COLORS.pick; ctx.lineWidth = 8;
  ctx.strokeRect(X(picked.s0), Y(picked.t0 + picked.d), px, (picked.d / H) * TEXC);
  closeTex.needsUpdate = true;
}

// The window placed as the whole scene would place it at unfold t, in
// doubles, then shifted to its centre, turned so it faces +z with s to the
// right, and scaled to about two units across.
function rebuildClose(w) {
  const place = placer(w.face, state.t), o = [0, 0, 0];
  const at = (a, b) => { place(w.s0 + a * (w.s1 - w.s0), w.t0 + b * (w.t1 - w.t0), o, 0); return [o[0], o[1], o[2]]; };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => { const r = Math.hypot(...a); return [a[0] / r, a[1] / r, a[2] / r]; };
  const c = at(0.5, 0.5), es = sub(at(1, 0.5), at(0, 0.5)), et = sub(at(0.5, 1), at(0.5, 0));
  const e1 = unit(es), n = unit(cross(es, et)), e2 = cross(n, e1);
  const k = 2 / Math.max(Math.hypot(...es), Math.hypot(...et));
  const pos = closeMesh.geometry.attributes.position;
  for (let j = 0, m = 0; j <= N; j++)
    for (let i = 0; i <= N; i++, m++) {
      const d = sub(at(i / N, j / N), c);
      pos.array[3 * m] = k * dot(d, e1); pos.array[3 * m + 1] = k * dot(d, e2); pos.array[3 * m + 2] = k * dot(d, n);
    }
  pos.needsUpdate = true;
  closeMesh.geometry.computeBoundingSphere();
}

// ---------------------------------------------------------------- panel

const $ = (id) => document.getElementById(id);
const ui = {
  lvl: $("lvl"), lvlOut: $("lvl-out"), t: $("t"), tOut: $("t-out"),
  token: $("token"), cellLevel: $("cell-level"), info: $("cell-info"),
  curve: $("curve"), grid: $("grid"), coast: $("coast"), uvgrid: $("uvgrid"),
  geojson: $("copy-geojson"), up: $("cell-up"), down: $("cell-down"),
  close: $("close-up"), closeHint: $("close-hint"),
  bm: $("basemap"), tif: $("download-tif")
};

// The picked cell as a GeoTIFF: in the gnomonic projection about its face's
// centre, where its edges (great circles) are straight. S2's own sphere has
// radius 6371010 m.
const S2_R = 6371010;
const basemap = basemapControl({
  select: ui.bm, status: $("bm-status"), credit: $("credit"),
  onWorld: (world) => { buildBasemapFaces(world); sync(); }
});
const tifOut = exportControl({
  button: ui.tif, size: $("tif-size"), status: $("bm-status"), bm: () => basemap.id,
  job: () => {
    const c = pickedCell();
    if (!c) return null;
    const { face, s0, t0, d } = c;
    // the face's centre: a whole number of degrees, 180 rather than -180
    const [lo, la] = s2.toLonLat(s2.faceAxis(face)), lat0 = Math.round(la);
    const lon0 = Math.abs(lat0) === 90 ? 0 : Math.round(lo) === -180 ? 180 : Math.round(lo);
    const g = gnomonic(lat0, lon0);
    const at = (a, b) => s2.toLonLat(s2.faceUVtoXYZ(face, s2.stToUV(s0 + a * d), s2.stToUV(t0 + b * d)));
    return {
      name: `playproj-s2-${s2.toToken(c.id)}`,
      crs: { proj: `+proj=gnom +lat_0=${lat0} +lon_0=${lon0} +R=${S2_R}`, R: S2_R }, scale: S2_R,
      forward: g.forward, inverse: g.inverse, ring: ringOf(at),
      inside: (lon, lat) => {
        const p = s2.toXYZ(lon, lat);
        if (s2.faceOf(p) !== face) return false;
        const [u, v] = s2.faceUV(face, p), s = s2.uvToST(u), t = s2.uvToST(v);
        return s >= s0 && s <= s0 + d && t >= t0 && t <= t0 + d;
      }
    };
  }
});

const EARTH_AREA = 510065621.7;   // km2 on the authalic sphere
const fmtArea = (a) => a >= 100 ? Math.round(a).toLocaleString("en") + " km2" : a >= 0.01 ? a.toPrecision(3) + " km2" : (a * 1e6).toPrecision(3) + " m2";

// spherical area of a cell's quadrilateral (two triangles, l'Huilier-free:
// Van Oosterom and Strackee)
function cellArea(corners) {
  const p = corners.map(([lon, lat]) => s2.toXYZ(lon, lat));
  const tri = (a, b, c) => {
    const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    return 2 * Math.atan2(Math.abs(det), 1 + dot(a, b) + dot(b, c) + dot(c, a));
  };
  return ((tri(p[0], p[1], p[2]) + tri(p[0], p[2], p[3])) / (4 * Math.PI)) * EARTH_AREA;
}

function pickedCell() {
  const id = state.cell && s2.fromToken(state.cell);
  return id ? { id, ...s2.cellBounds(id) } : null;
}

function updatePanel(picked) {
  ui.lvl.value = state.lvl;
  const n = 6 * 4 ** state.lvl;
  ui.lvlOut.textContent = `${state.lvl} (${n.toLocaleString("en")} cells, about ${fmtArea(EARTH_AREA / n)} each)`;
  ui.t.value = state.t;
  ui.tOut.textContent = state.t === 0 ? "globe" : state.t === 0.5 ? "cube" : state.t === 1 ? "net" : state.t < 0.5 ? "to the cube" : "opening";
  ui.curve.checked = !!state.curve; ui.grid.checked = !!state.grid;
  ui.coast.checked = !!state.coast; ui.uvgrid.checked = !!state.uvgrid;
  if (document.activeElement !== ui.token) ui.token.value = state.cell;
  ui.token.classList.remove("bad");
  ui.geojson.disabled = ui.up.disabled = ui.down.disabled = ui.close.disabled = !picked;
  ui.close.textContent = state.close ? "Whole globe" : "Close up";
  ui.lvl.disabled = ui.uvgrid.disabled = !!state.close;
  ui.closeHint.hidden = !state.close;
  if (!tifOut.busy) ui.tif.disabled = !picked || !basemap.world;
  if (picked) {
    ui.up.disabled = picked.level === 0; ui.down.disabled = picked.level === s2.MAX_LEVEL;
    const [lon, lat] = s2.toLonLat(s2.faceUVtoXYZ(picked.face, s2.stToUV(picked.s0 + picked.d / 2), s2.stToUV(picked.t0 + picked.d / 2)));
    ui.cellLevel.textContent = `level ${picked.level}, face ${picked.face}`;
    ui.info.textContent = `Centre ${lon.toFixed(4)}${DEG}, ${lat.toFixed(4)}${DEG}; area ${fmtArea(cellArea(picked.corners))}; id ${picked.id}.`;
    const lv = picked.level, deeper = [lv + 1, lv + 2].filter((x) => x <= s2.MAX_LEVEL);
    ui.closeHint.textContent = `Level ${lv} cells round the picked one on face ${picked.face}` +
      (deeper.length ? `, with the grid at level${deeper.length > 1 ? "s" : ""} ${deeper.join(" and ")} and` : ", with") +
      ` the curve at level ${Math.min(s2.MAX_LEVEL, lv + 3)}. Click a cell to move; Parent and Child change the level.`;
  } else {
    ui.cellLevel.textContent = "";
    ui.info.textContent = "Click a cell for its token, or paste one.";
  }
}

let rafPending = false, drawFaces = true;
function sync(faces = true) {
  writeHash();
  drawFaces = drawFaces || faces;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const picked = pickedCell();
    if (!picked) state.close = 0;
    const win = state.close ? closeWindow(picked) : null;
    if (drawFaces) {
      if (win) drawClose(win, picked);
      else for (let f = 0; f < 6; f++) drawFace(f, picked);
    }
    drawFaces = false;
    group.visible = !win; closeMesh.visible = !!win;
    if (win) rebuildClose(win); else rebuildScene();
    viewLimits();
    updatePanel(picked);
  });
}

ui.lvl.addEventListener("input", () => { state.lvl = +ui.lvl.value; sync(); });
ui.t.addEventListener("input", () => { stopAnim(); state.t = +ui.t.value; sync(false); });
for (const k of ["curve", "grid", "coast", "uvgrid"])
  ui[k].addEventListener("change", () => { state[k] = ui[k].checked ? 1 : 0; sync(); });
ui.token.addEventListener("change", () => {
  const raw = ui.token.value.trim().toLowerCase();
  if (!raw) { state.cell = ""; if (state.close) return setClose(false); return sync(); }
  const id = s2.fromToken(raw);
  if (!id) { ui.token.classList.add("bad"); return; }
  state.cell = s2.toToken(id);
  sync();
});
ui.up.addEventListener("click", () => {
  const c = pickedCell();
  if (c && c.level > 0) { state.cell = s2.toToken(s2.parent(c.id, c.level - 1)); sync(); }
});
ui.down.addEventListener("click", () => {
  // the child under the middle of the cell's Hilbert path: its first child
  const c = pickedCell();
  if (c && c.level < s2.MAX_LEVEL) { state.cell = s2.toToken(c.id - (c.id & -c.id) + ((c.id & -c.id) >> 2n)); sync(); }
});
ui.geojson.addEventListener("click", (e) => {
  const c = pickedCell();
  if (!c) return;
  const ring = [...c.corners, c.corners[0]].map(([x, y]) => [+x.toFixed(9), +y.toFixed(9)]);
  copyText(JSON.stringify({ type: "Feature", properties: { token: s2.toToken(c.id), level: c.level, face: c.face },
    geometry: { type: "Polygon", coordinates: [ring] } }), e.target);
});
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(defaultCam()); writeHash(); });
function setClose(on) {
  state.close = on && pickedCell() ? 1 : 0;
  state.cam = null;
  viewLimits();
  setCamera(defaultCam());
  if (state.close && !coastFine) loadCoastline("50m").then((l) => { coastFine = l; sync(); }, () => {});
  sync();
}
ui.close.addEventListener("click", () => setClose(!state.close));

// click (not drag) on a face picks the cell under the pointer at the current level
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  let id;
  if (state.close) {
    // a neighbour at the same level, which becomes the middle of the window
    const hit = ray.intersectObject(closeMesh)[0], c = pickedCell();
    if (!hit || !c) return;
    const w = closeWindow(c);
    id = s2.cellFromFaceST(w.face, w.s0 + hit.uv.x * (w.s1 - w.s0), w.t0 + hit.uv.y * (w.t1 - w.t0), w.level);
  } else {
    const hit = ray.intersectObjects(meshes)[0];
    if (!hit) return;
    id = s2.cellFromFaceST(hit.object.userData.face, hit.uv.x, hit.uv.y, state.lvl);
  }
  state.cell = s2.toToken(id);
  sync();
});

let anim = false, dir = 1, lastT = 0;
const playBtn = $("play");
function stopAnim() { anim = false; playBtn.textContent = state.t >= 1 ? "Fold" : "Unfold"; }
playBtn.addEventListener("click", () => {
  if (anim) return stopAnim();
  anim = true; dir = state.t >= 1 ? -1 : 1; playBtn.textContent = "Stop"; lastT = performance.now();
});

shareLinks("s2 cells");

// ---------------------------------------------------------------- loop

function tick(now) {
  if (anim) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    state.t = Math.max(0, Math.min(1, state.t + dir * dt * 0.25));
    if (state.t === 1 || state.t === 0) stopAnim();
    sync(false);
  }
  lastT = now;
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

ui.bm.addEventListener("change", () => { state.bm = ui.bm.value; writeHash(); basemap.set(state.bm); });

window.addEventListener("hashchange", () => {
  readHash();
  setCamera(state.cam || defaultCam());
  if (state.close && !coastFine) loadCoastline("50m").then((l) => { coastFine = l; sync(); }, () => {});
  basemap.set(state.bm); sync();
});

readHash();
setCamera(state.cam || defaultCam());
if (state.close) loadCoastline("50m").then((l) => { coastFine = l; sync(); }, () => {});
resize();
sync();
basemap.set(state.bm);
loadCoastline("110m").then((lines) => { buildCoast(lines); sync(); document.body.classList.add("ready"); });
requestAnimationFrame(tick);
