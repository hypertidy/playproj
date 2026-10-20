// playproj: orthorectification
//
// A frame camera or a pushbroom scanner over synthetic terrain (three.js,
// top), and four images of the area (2D canvas, below): the map itself,
// the raw image the sensor records, that image rectified onto a flat
// datum, and the same image orthorectified with a DEM. One picked ground
// point is followed through all of them. Terrain, sensor models, ray
// tracing and the rectification are src/core/ortho.js.

import * as THREE from "three";
import * as O from "../src/core/ortho.js";
import { makeStage, readParams, hashWriter, shareLinks, oneOf } from "../src/scene/index.js";

const $ = (id) => document.getElementById(id);
const R2D = 180 / Math.PI;
const DEG = "\u00b0";
const S = O.SIZE;

const C = {
  bg: 0x05070d, ray: 0xffd34d, slip: 0xff8a3d, shift: 0xff4d6d, frust: 0x7fe0ff, track: 0x8a97ab, datum: 0x5aa0ff, pick: 0xff7ab8,
  ink: "#dfe7f2", muted: "#8a97ab", pickCss: "#ff7ab8", slipCss: "#ff8a3d", shiftCss: "#ff4d6d", roadCss: "rgba(127,224,255,0.9)", hidden: [190, 70, 190]
};

const PRESETS = [
  ["Vertical photo", { s: "frame", alt: 5, tilt: 0, az: 0, fov: 80, terr: "hills", rel: 1, dem: "true", occ: 0, px: 1200, py: -1800 }],
  ["Oblique photo", { s: "frame", alt: 4, tilt: 35, az: 30, fov: 60, terr: "hills", rel: 1, dem: "true", occ: 0, px: -2200, py: 1500 }],
  ["Spires lean out", { s: "frame", alt: 4, tilt: 0, az: 0, fov: 90, terr: "spires", rel: 1, dem: "true", occ: 1, px: 1500, py: -2600 }],
  ["Behind the ridge", { s: "frame", alt: 3, tilt: 40, az: 135, fov: 70, terr: "ridge", rel: 1.2, dem: "true", occ: 1, px: 400, py: -900 }],
  ["Satellite, nadir", { s: "push", alt: 8, tilt: 0, az: 0, fov: 70, terr: "hills", rel: 1, dem: "true", occ: 0, px: 1200, py: -1800 }],
  ["Satellite, off nadir", { s: "push", alt: 8, tilt: 30, az: 0, fov: 45, terr: "spires", rel: 1, dem: "true", occ: 1, px: -2000, py: -1500 }]
];

// ---------------------------------------------------------------- state

const defaults = {
  s: "frame", alt: 5, tilt: 15, az: 0, fov: 80, terr: "hills", rel: 1, dem: "true",
  occ: 0, arr: 1, ov: 1, img: 1, px: 1200, py: -1800, cam: null
};
const state = { ...defaults };
function readHash() {
  readParams(state, defaults, {
    s: oneOf(["frame", "push"], "frame"), terr: oneOf(Object.keys(O.TERRAINS), "hills"), dem: oneOf(["true", "smooth", "mean"], "true")
  });
  state.alt = Math.max(2, Math.min(15, state.alt));
  state.tilt = Math.max(0, Math.min(50, state.tilt));
  state.az = ((state.az % 360) + 360) % 360;
  state.fov = Math.max(20, Math.min(100, state.fov));
  state.rel = Math.max(0, Math.min(2, state.rel));
  state.px = Math.max(-S / 2, Math.min(S / 2, state.px));
  state.py = Math.max(-S / 2, Math.min(S / 2, state.py));
}
readHash();
const writeHash = hashWriter(state, defaults, { digits: 2 });

// ---------------------------------------------------------------- model

let dem = null, demKey = "", truth = null, sensor = null, raw = null, rectFlat = null, rectDem = null, zr = null, occDem = null;
let pick = null;   // { P, uv, flat, dm, vis }

function buildModel(n) {
  const key = `${state.terr}|${state.rel}`;
  const fresh = key !== demKey;
  if (fresh) { dem = O.makeTerrain(state.terr, state.rel); demKey = key; truth = null; }
  if (!truth || truth.n !== n) truth = { n, px: O.renderTruth(dem, n) };
  sensor = O.makeSensor(state.s, { alt: state.alt * 1000, tilt: state.tilt, az: state.az, fov: state.fov, n });
  raw = O.renderRaw(dem, sensor);
  const smooth = state.dem === "smooth" ? O.smoothed(dem) : null;
  zr = state.dem === "true" ? dem.height : smooth ? smooth.height : (() => { const m = dem.mean; return () => m; })();
  occDem = state.dem === "true" ? dem : smooth;
  rectFlat = O.orthorectify(raw, sensor, () => 0, n);
  rectDem = O.orthorectify(raw, sensor, zr, n, { occlusion: state.occ && occDem ? occDem : null });
  return fresh;
}

function buildPick() {
  const P = [state.px, state.py, dem.height(state.px, state.py)];
  const uv = sensor.project(P);
  const flat = O.displacement(sensor, P, () => 0);
  const dm = O.displacement(sensor, P, zr);
  const vis = O.visible(dem, sensor, P);
  const inImage = !!uv && uv[0] >= 0 && uv[0] <= sensor.n && uv[1] >= 0 && uv[1] <= sensor.n;
  pick = { P, uv, flat, dm, vis, inImage };
}

// ---------------------------------------------------------------- scene

// metres (x east, y north, z up) to scene km (y up, north towards -z)
const K = 1 / 1000;
const v3 = (p) => new THREE.Vector3(p[0] * K, p[2] * K, -p[1] * K);

const stage = $("three");
const { renderer, scene, camera, controls, setCamera, resize } = makeStage(stage, {
  bg: C.bg, fov: 40, near: 0.05, far: 200,
  onCamera: (c) => { state.cam = c; writeHash(); }
});
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 2;
controls.maxDistance = 60;

// terrain: a mesh over the DEM's grid, coloured by the map
const TN = 140, TE = 7000;
const terrGeo = new THREE.PlaneGeometry(2 * TE * K, 2 * TE * K, TN, TN);
terrGeo.rotateX(-Math.PI / 2);
const terrCanvas = document.createElement("canvas");
terrCanvas.width = terrCanvas.height = 1024;
const terrTex = new THREE.CanvasTexture(terrCanvas);
terrTex.colorSpace = THREE.SRGBColorSpace;
terrTex.anisotropy = 4;
const terrain = new THREE.Mesh(terrGeo, new THREE.MeshBasicMaterial({ map: terrTex }));
scene.add(terrain);

function buildTerrain() {
  const pos = terrGeo.attributes.position;
  for (let k = 0; k < pos.count; k++) pos.setY(k, dem.height(pos.getX(k) / K, -pos.getZ(k) / K) * K);
  pos.needsUpdate = true;
  terrGeo.computeBoundingSphere();
  const n = terrCanvas.width, ctx = terrCanvas.getContext("2d"), im = ctx.createImageData(n, n), c = [0, 0, 0];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      O.groundColour(dem, -TE + ((i + 0.5) * 2 * TE) / n, TE - ((j + 0.5) * 2 * TE) / n, c);
      const k = 4 * (j * n + i);
      im.data[k] = c[0]; im.data[k + 1] = c[1]; im.data[k + 2] = c[2]; im.data[k + 3] = 255;
    }
  }
  ctx.putImageData(im, 0, 0);
  terrTex.needsUpdate = true;
}

// the reference surface of the "with DEM" panel when it is a level plane
const datum = new THREE.Mesh(new THREE.PlaneGeometry(S * K, S * K), new THREE.MeshBasicMaterial({
  color: C.datum, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false
}));
datum.rotateX(-Math.PI / 2);
scene.add(datum);

function lines(color, opacity = 1, dashed = false) {
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 0.12, gapSize: 0.08, transparent: opacity < 1, opacity })
    : new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  const o = new THREE.LineSegments(new THREE.BufferGeometry(), mat);
  o.frustumCulled = false;
  scene.add(o);
  return o;
}
const setLines = (o, pts) => {
  o.geometry.setFromPoints(pts);
  if (o.material.isLineDashedMaterial) o.computeLineDistances();
};
const frust = lines(C.frust, 0.6);
const foot = lines(C.frust, 0.95);
const track = lines(C.track, 0.8, true);
const rayLine = lines(C.ray);
const slipLine = lines(C.slip, 1, true);
const shiftLine = lines(C.shift);

const dot = (color, r = 0.06) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color })); scene.add(m); return m; };
const pickDot = dot(C.pick), flatDot = dot(C.shift, 0.05), pixDot = dot(C.ray, 0.03), sensorDot = dot(0xffffff, 0.08);

// the image plane (frame camera) as a positive in front of the lens
const imgCanvas = document.createElement("canvas");
const imgTex = new THREE.CanvasTexture(imgCanvas);
imgTex.colorSpace = THREE.SRGBColorSpace;
const imgGeo = new THREE.BufferGeometry();
imgGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(12), 3));
imgGeo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
imgGeo.setIndex([0, 2, 1, 0, 3, 2]);
const imgPlane = new THREE.Mesh(imgGeo, new THREE.MeshBasicMaterial({ map: imgTex, side: THREE.DoubleSide, transparent: true }));
imgPlane.frustumCulled = false;
scene.add(imgPlane);
// the scan plane (pushbroom) through the picked point's row
const fanGeo = new THREE.BufferGeometry();
const fan = new THREE.Mesh(fanGeo, new THREE.MeshBasicMaterial({ color: C.frust, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
fan.frustumCulled = false;
scene.add(fan);

// image plane distance from the perspective centre, km
const PD = 1.2;

function imageCorner(u, v) {
  const s = sensor, cx = s.n / 2, w = PD / K;
  const d = [s.f[0] + (s.r[0] * (u - cx) + s.dn[0] * (v - cx)) / s.c, s.f[1] + (s.r[1] * (u - cx) + s.dn[1] * (v - cx)) / s.c, s.f[2] + (s.r[2] * (u - cx) + s.dn[2] * (v - cx)) / s.c];
  return [s.C[0] + w * d[0], s.C[1] + w * d[1], s.C[2] + w * d[2]];
}

function buildSensor() {
  const s = sensor, n = s.n;
  const fp = O.footprint(dem, s, 24);
  const fpv = [];
  for (let i = 0; i < fp.length; i++) fpv.push(v3(fp[i]).add(new THREE.Vector3(0, 0.01, 0)), v3(fp[(i + 1) % fp.length]).add(new THREE.Vector3(0, 0.01, 0)));
  setLines(foot, fpv);
  const isFrame = s.kind === "frame";
  imgPlane.visible = isFrame && !!state.img;
  track.visible = !isFrame;
  fan.visible = !isFrame;
  if (isFrame) {
    sensorDot.position.copy(v3(s.C));
    // rays to the footprint's corners
    const corners = [[0, 0], [n, 0], [n, n], [0, n]], fr = [];
    for (const [u, v] of corners) {
      const { o, d } = s.ray(u, v);
      const P = O.intersect(dem.height, dem.top, o, d);
      if (P) fr.push(v3(s.C), v3(P));
    }
    setLines(frust, fr);
    const pa = imgGeo.attributes.position;
    corners.forEach(([u, v], i) => { const q = v3(imageCorner(u, v)); pa.setXYZ(i, q.x, q.y, q.z); });
    pa.needsUpdate = true;
    imgCanvas.width = imgCanvas.height = n;
    imgCanvas.getContext("2d").putImageData(new ImageData(raw, n, n), 0, 0);
    imgTex.needsUpdate = true;
  } else {
    const a = s.at(-S / 2 - 1500), b = s.at(S / 2 + 1500);
    setLines(track, [v3(a), v3(b)]);
  }
}

function buildPickScene() {
  const { P, flat } = pick, s = sensor, Cp = s.centre(P);
  pickDot.position.copy(v3(P));
  rayLine.visible = slipLine.visible = shiftLine.visible = flatDot.visible = true;
  setLines(rayLine, [v3(Cp), v3(P)]);
  // carried on to the datum (flat) and, beside P, the shift on the datum
  if (flat.Q) {
    setLines(slipLine, [v3(P), v3(flat.Q)]);
    setLines(shiftLine, [v3([P[0], P[1], 0]), v3(flat.Q)]);
    flatDot.position.copy(v3(flat.Q));
  } else { slipLine.visible = shiftLine.visible = flatDot.visible = false; }
  pixDot.visible = s.kind === "frame" && !!state.img && pick.inImage;
  if (pixDot.visible) pixDot.position.copy(v3(imageCorner(pick.uv[0], pick.uv[1])));
  if (s.kind === "push") {
    sensorDot.position.copy(v3(Cp));
    // the scan line of P's row on the ground, and the fan up to the sensor
    const row = s.row(P), pts = [v3(Cp)], idx = [], m = 48;
    for (let k = 0; k <= m; k++) {
      const { o, d } = s.ray((k / m) * s.n, row);
      const G = O.intersect(dem.height, dem.top, o, d);
      if (G) pts.push(v3(G).add(new THREE.Vector3(0, 0.01, 0)));
    }
    for (let k = 1; k < pts.length - 1; k++) idx.push(0, k, k + 1);
    fanGeo.setFromPoints(pts);
    fanGeo.setIndex(idx);
    const fr = [v3(Cp), pts[1], v3(Cp), pts[pts.length - 1]];
    setLines(frust, fr);
  }
  datum.visible = state.dem === "mean";
  datum.position.y = dem.mean * K;
}

// from the south south west, far enough back to take in the sensor
function defaultCam() {
  const d = 9 + 1.8 * state.alt, ty = state.alt * 0.45;
  return [-0.45 * d, ty + 0.55 * d, 0.85 * d, 0, ty, 0];
}

// ---------------------------------------------------------------- the four images

const map = $("map");
let panels = [];   // [{ key, x, y, w }]

const TITLES = {
  truth: ["The map (the truth)", "The map"],
  raw: () => [sensor.kind === "frame" ? "Raw image (frame camera)" : "Raw image (pushbroom strip)", "Raw image"],
  flat: ["Rectified on the datum, no DEM", "No DEM"],
  dem: () => [({ true: "Orthorectified with the true DEM", smooth: "Orthorectified, smoothed DEM", mean: "Rectified on the mean height" })[state.dem],
    ({ true: "True DEM", smooth: "Smoothed DEM", mean: "Mean height" })[state.dem]]
};

function toCanvas(px, n, hidden) {
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const im = new ImageData(n, n);
  im.data.set(px);
  if (hidden) {
    for (let k = 0; k < hidden.length; k++) {
      if (!hidden[k]) continue;
      const i = k % n, j = (k / n) | 0, on = ((i + j) >> 1) % 2 === 0;
      im.data[4 * k] = on ? C.hidden[0] : 60; im.data[4 * k + 1] = on ? C.hidden[1] : 20; im.data[4 * k + 2] = on ? C.hidden[2] : 60; im.data[4 * k + 3] = 255;
    }
  }
  c.getContext("2d").putImageData(im, 0, 0);
  return c;
}

let images = null;
function buildImages() {
  const n = sensor.n;
  images = {
    truth: toCanvas(truth.px, n),
    raw: toCanvas(raw, n),
    flat: toCanvas(rectFlat.px, n),
    dem: toCanvas(rectDem.px, n, rectDem.hidden)
  };
}

function layout(w, h) {
  // room at the foot for the page's label
  const pad = 8, top = 20;
  h -= 18;
  const wide = w / h > 2.4;
  const cols = wide ? 4 : 2, rows = wide ? 1 : 2;
  const side = Math.max(40, Math.min((w - pad * (cols + 1)) / cols, (h - (pad + top) * rows - pad) / rows));
  const gx = (w - cols * side) / (cols + 1), out = [];
  ["truth", "raw", "flat", "dem"].forEach((key, i) => {
    const c = i % cols, r = (i / cols) | 0;
    out.push({ key, x: gx + c * (side + gx), y: pad + top + r * (side + pad + top), w: side });
  });
  return out;
}

function drawMap() {
  const box = map.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, box.width), h = Math.max(10, box.height);
  map.width = Math.round(w * dpr); map.height = Math.round(h * dpr);
  const ctx = map.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#05070d"; ctx.fillRect(0, 0, w, h);
  if (!images) return;
  panels = layout(w, h);
  ctx.font = "12px system-ui, sans-serif"; ctx.textBaseline = "bottom"; ctx.textAlign = "left";
  for (const p of panels) {
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = "#0b1120"; ctx.fillRect(p.x, p.y, p.w, p.w);
    ctx.drawImage(images[p.key], p.x, p.y, p.w, p.w);
    ctx.strokeStyle = "rgba(140,196,255,0.35)"; ctx.lineWidth = 1; ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.w - 1);
    const t = typeof TITLES[p.key] === "function" ? TITLES[p.key]() : TITLES[p.key];
    ctx.fillStyle = C.ink; ctx.fillText(ctx.measureText(t[0]).width <= p.w ? t[0] : t[1], p.x, p.y - 4);
    ctx.save();
    ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.w); ctx.clip();
    overlay(ctx, p);
    ctx.restore();
  }
}

// ground x, y (metres) to a point in a map panel, and an image u, v to the raw panel
const mapXY = (p, x, y) => [p.x + ((x + S / 2) / S) * p.w, p.y + ((S / 2 - y) / S) * p.w];
const rawXY = (p, u, v) => [p.x + (u / sensor.n) * p.w, p.y + (v / sensor.n) * p.w];

function overlay(ctx, p) {
  const isMap = p.key !== "raw";
  if (state.ov && (p.key === "flat" || p.key === "dem")) {
    ctx.strokeStyle = C.roadCss; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    for (const [x0, y0, x1, y1] of O.ROADS) {
      const a = mapXY(p, x0, y0), b = mapXY(p, x1, y1);
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  if (state.arr && (p.key === "flat" || p.key === "dem")) {
    const field = O.displacementField(dem, sensor, p.key === "flat" ? () => 0 : zr, 11);
    ctx.strokeStyle = C.shiftCss; ctx.fillStyle = C.shiftCss; ctx.lineWidth = 1.3;
    for (const [x, y, qx, qy] of field) {
      if (!isFinite(qx)) continue;
      const uv = sensor.project([x, y, dem.height(x, y)]);
      if (!uv || uv[0] < 0 || uv[1] < 0 || uv[0] > sensor.n || uv[1] > sensor.n) continue;
      const a = mapXY(p, x, y), b = mapXY(p, qx, qy);
      arrow(ctx, a, b);
    }
  }
  if (sensor.kind === "frame") {
    // the nadir, which everything leans away from
    const [nx, ny] = sensor.nadir, N = [nx, ny, dem.height(nx, ny)];
    let q = null;
    if (p.key === "raw") { const uv = sensor.project(N); if (uv) q = rawXY(p, uv[0], uv[1]); } else q = mapXY(p, nx, ny);
    if (q) cross(ctx, q);
  } else if (p.key !== "raw") {
    // the ground track, which everything leans across
    const a = sensor.at(-S), b = sensor.at(S);
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 1.2; ctx.setLineDash([2, 5]);
    ctx.beginPath(); ctx.moveTo(...mapXY(p, a[0], a[1])); ctx.lineTo(...mapXY(p, b[0], b[1])); ctx.stroke();
    ctx.restore();
  }
  if (!pick) return;
  let at = null;
  if (p.key === "truth") at = mapXY(p, pick.P[0], pick.P[1]);
  else if (p.key === "raw") at = pick.uv ? rawXY(p, pick.uv[0], pick.uv[1]) : null;
  else {
    const d = p.key === "flat" ? pick.flat : pick.dm;
    if (d.Q) {
      at = mapXY(p, d.Q[0], d.Q[1]);
      // where it should be
      const t = mapXY(p, pick.P[0], pick.P[1]);
      ring(ctx, t, 6, "rgba(255,255,255,0.9)", true);
      if (Math.hypot(at[0] - t[0], at[1] - t[1]) > 2) { ctx.strokeStyle = C.slipCss; ctx.lineWidth = 2; arrow(ctx, t, at); }
    }
  }
  if (at) ring(ctx, at, 6, C.pickCss);
}

function cross(ctx, [x, y], r = 6) {
  ctx.save();
  ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.6)";
  for (const pass of [0, 1]) {
    ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke();
    if (!pass) { ctx.lineWidth = 1.4; ctx.strokeStyle = "#ffffff"; }
  }
  ctx.restore();
}

function ring(ctx, [x, y], r, color, dashed = false) {
  ctx.save();
  ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.lineWidth = 4;
  if (dashed) ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.stroke();
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  ctx.restore();
}

function arrow(ctx, [x0, y0], [x1, y1]) {
  const L = Math.hypot(x1 - x0, y1 - y0);
  if (L < 1.5) { ctx.beginPath(); ctx.arc(x0, y0, 1, 0, 2 * Math.PI); ctx.fill(); return; }
  const ux = (x1 - x0) / L, uy = (y1 - y0) / L, hl = Math.min(6, L * 0.45);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - hl * ux + hl * 0.5 * uy, y1 - hl * uy - hl * 0.5 * ux);
  ctx.lineTo(x1 - hl * ux - hl * 0.5 * uy, y1 - hl * uy + hl * 0.5 * ux);
  ctx.closePath(); ctx.fillStyle = ctx.strokeStyle; ctx.fill();
}

// a click in a panel to the ground point it shows
function groundAt(clientX, clientY) {
  const r = map.getBoundingClientRect(), x = clientX - r.left, y = clientY - r.top;
  const p = panels.find((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.w);
  if (!p) return null;
  const fx = (x - p.x) / p.w, fy = (y - p.y) / p.w;
  const gx = -S / 2 + fx * S, gy = S / 2 - fy * S;
  let uv;
  if (p.key === "truth") return [gx, gy];
  if (p.key === "raw") uv = [fx * sensor.n, fy * sensor.n];
  // the rectified panels show, at (gx, gy), the pixel that (gx, gy, surface) projects to
  else uv = sensor.project([gx, gy, p.key === "flat" ? 0 : zr(gx, gy)]);
  if (!uv) return null;
  const { o, d } = sensor.ray(uv[0], uv[1]);
  const G = O.intersect(dem.height, dem.top, o, d);
  return G ? [G[0], G[1]] : null;
}

// ---------------------------------------------------------------- readout

const m = (v) => `${Math.round(v).toLocaleString("en")} m`;

function readout() {
  if (!pick) return;
  const { P, uv, flat, dm, vis, inImage } = pick, s = sensor, Cp = s.centre(P);
  const D = Math.hypot(P[0] - Cp[0], P[1] - Cp[1]);
  const rows = [
    [`<span style="color:${C.pickCss}">Picked point</span>`, `x ${m(P[0])}, y ${m(P[1])}`],
    ["Ground height h", m(P[2])],
    [s.kind === "frame" ? "Camera height H" : "Sensor height H (its row)", m(Cp[2])],
    [s.kind === "frame" ? "Distance from the nadir D" : "Distance across the track", m(D)],
    ["Ray angle from the vertical", `${(flat.theta * R2D).toFixed(1)}${DEG}`],
    ["Image position u, v", inImage ? `${uv[0].toFixed(1)}, ${uv[1].toFixed(1)} px of ${s.n}` : "outside the image"],
    ["Seen by the sensor", vis ? "yes" : "no, hidden behind higher ground"],
    [`<span style="color:${C.shiftCss}">Shift on the datum</span>, h tan(theta)`, `${m(flat.shift)}`]
  ];
  if (s.kind === "frame" && state.tilt === 0) rows.push(["Vertical photo: D h / (H - h)", m((D * P[2]) / (Cp[2] - P[2]))]);
  rows.push([`Shift with the ${({ true: "true", smooth: "smoothed", mean: "mean height" })[state.dem]} DEM`, isFinite(dm.shift) ? m(dm.shift) : "-"]);
  rows.push(["Terrain over the area", `${m(dem.min)} to ${m(dem.max)}, mean ${m(dem.mean)}`]);
  const hid = rectDem.hidden.reduce((a, b) => a + b, 0);
  if (state.occ) rows.push(["Hidden cells (masked)", `${(100 * hid / rectDem.hidden.length).toFixed(1)}%`]);
  $("out").innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("");
}

// ---------------------------------------------------------------- UI

for (const [k, t] of Object.entries(O.TERRAINS)) $("terr").add(new Option(t.label, k));

for (const [name, p] of PRESETS) {
  const bt = document.createElement("button");
  bt.type = "button"; bt.textContent = name;
  bt.addEventListener("click", () => { Object.assign(state, p); state.cam = null; update(); setCamera(defaultCam()); });
  $("presets").appendChild(bt);
}

const sliders = ["alt", "tilt", "az", "fov", "rel"];
for (const k of sliders) {
  $(k).addEventListener("input", () => { state[k] = +$(k).value; schedule(128); });
  $(k).addEventListener("change", () => { state[k] = +$(k).value; schedule(256); });
}
for (const k of ["sensor", "terr", "dem"]) {
  $(k).addEventListener("change", () => { state[k === "sensor" ? "s" : k] = $(k).value; schedule(256); });
}
for (const k of ["occ", "arr", "ov", "img"]) {
  $(k).addEventListener("change", () => { state[k] = $(k).checked ? 1 : 0; schedule(256); });
}
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(defaultCam()); writeHash(); });

let pending = 0, pendingN = 256;
function schedule(n) {
  pendingN = n;
  if (pending) return;
  pending = requestAnimationFrame(() => { pending = 0; update(pendingN); });
}

function setPick(xy) {
  if (!xy) return;
  state.px = Math.round(Math.max(-S / 2, Math.min(S / 2, xy[0])));
  state.py = Math.round(Math.max(-S / 2, Math.min(S / 2, xy[1])));
  buildPick(); buildPickScene(); drawMap(); readout(); writeHash();
}

map.addEventListener("click", (e) => setPick(groundAt(e.clientX, e.clientY)));

// click (not drag) on the terrain: pick there
const caster = new THREE.Raycaster(), ptr = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  caster.setFromCamera(ptr, camera);
  const hit = caster.intersectObject(terrain)[0];
  if (hit) setPick([hit.point.x / K, -hit.point.z / K]);
});

function update(n = 256) {
  const fresh = buildModel(n);
  if (fresh) buildTerrain();
  buildSensor();
  buildPick();
  buildPickScene();
  buildImages();
  sync();
}

function sync() {
  for (const k of sliders) $(k).value = state[k];
  $("sensor").value = state.s; $("terr").value = state.terr; $("dem").value = state.dem;
  for (const k of ["occ", "arr", "ov", "img"]) $(k).checked = !!state[k];
  $("img").disabled = state.s !== "frame";
  const push = state.s === "push";
  $("tilt-name").textContent = push ? "Roll, off nadir across the track" : "Tilt from the vertical";
  $("az-name").textContent = push ? "Flying towards" : "Looking towards";
  $("alt-out").textContent = `${state.alt.toFixed(1)} km`;
  $("tilt-out").textContent = `${state.tilt}${DEG}`;
  $("az-out").textContent = `${state.az}${DEG}`;
  $("fov-out").textContent = `${state.fov}${DEG}`;
  $("rel-out").textContent = `${state.rel.toFixed(2)} x`;
  $("scene-label").textContent = `${push ? "Pushbroom scanner" : "Frame camera"} ${state.alt.toFixed(1)} km up over ${O.TERRAINS[state.terr].label.toLowerCase()} (true scale, km)`;
  drawMap();
  readout();
  writeHash();
}

// ---------------------------------------------------------------- start

window.addEventListener("hashchange", () => { readHash(); update(); });
new ResizeObserver(() => drawMap()).observe(map.parentElement);
shareLinks("playproj: Orthorectification", { height: 680 });

function tick() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

update();
resize();
setCamera(state.cam || defaultCam());
requestAnimationFrame(tick);
