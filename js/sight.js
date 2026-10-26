// playproj: sight and shade
//
// A synthetic landscape, a spot on it and a light: an eye above the spot,
// moved away from it towards an azimuth and elevation, out to infinity
// where it is the sun. Above, the terrain coloured by what the light sees,
// with sight lines. Below, what the light sees: the terrain in the eye's
// four gnomonic wedges (or the sun's one orthographic view), drawn far to
// near, with the horizon. The visibility is src/core/sight.js.

import * as THREE from "three";
import * as S from "../src/core/sight.js";
import { makeStage, readParams, hashWriter, shareLinks } from "../src/scene/index.js";

const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";

const C = {
  bg: 0x05070d, seen: [0.93, 0.78, 0.42], unseen: [0.17, 0.24, 0.38], sky: "#0b1a33",
  ray: 0xffd34d, blocked: 0x5ed1ff, eye: 0xffd34d, spot: 0xff7ab8, horizon: "#ffb347", ink: "#dfe7f2", muted: "#8a97ab"
};

const T = S.makeTerrain({ n: 160, cell: 30, seed: 1 });
const K = 4 / T.size;             // metres to scene units
const D0 = 2000;                  // dist = D0 t / (1 - t)

// ---------------------------------------------------------------- state

const defaults = { x: 1500, y: 2400, h: 1.5, az: 300, el: 20, t: 0, rays: 1, sky: 1, cam: null };
const state = { ...defaults };

function readHash() {
  readParams(state, defaults);
  const cl = (k, a, b) => { state[k] = Math.max(a, Math.min(b, state[k])); };
  cl("x", 0, T.size); cl("y", 0, T.size); cl("h", 0.5, 100); cl("az", 0, 359); cl("el", 1, 89); cl("t", 0, 1);
}
readHash();
const writeHash = hashWriter(state, defaults);

const distOf = (t) => (t >= 1 ? Infinity : (D0 * t) / (1 - t));
const light = () => S.lightFrom(T, { x: state.x, y: state.y, h: state.h, az: state.az, el: state.el, dist: distOf(state.t) });

const PRESETS = [
  { label: "Viewshed, 1.5 m", s: { h: 1.5, t: 0 } },
  { label: "Tower, 30 m", s: { h: 30, t: 0 } },
  { label: "Aircraft, 4 km", s: { h: 1.5, t: 4000 / (4000 + D0), el: 20 } },
  { label: "Far away, 2000 km", s: { h: 1.5, t: 2e6 / (2e6 + D0), el: 20 } },
  { label: "The sun, low", s: { t: 1, el: 12 } },
  { label: "The sun, high", s: { t: 1, el: 45 } }
];

// ---------------------------------------------------------------- scene

const { renderer, scene, camera, controls, setCamera, resize } = makeStage($("three"), {
  bg: C.bg, fov: 36, far: 400,
  onCamera: (c) => { state.cam = c; writeHash(); }
});
const defaultCam = () => [3.2, 3.4, 4.6, 0, 0.2, 0];

// metres to the scene: x east, y up, z south; centred on the terrain
const toScene = (x, y, z) => new THREE.Vector3((x - T.size / 2) * K, z * K, -(y - T.size / 2) * K);

const nv = T.nv;
const pos = new Float32Array(nv * nv * 3), col = new Float32Array(nv * nv * 3), shade = new Float32Array(nv * nv);
for (let k = 0; k < nv * nv; k++) {
  const i = k % nv, j = (k - i) / nv, p = toScene(i * T.cell, j * T.cell, T.z[k]);
  pos[3 * k] = p.x; pos[3 * k + 1] = p.y; pos[3 * k + 2] = p.z;
  // relief shading from the north-west, for form only
  const zx = (T.z[j * nv + Math.min(nv - 1, i + 1)] - T.z[j * nv + Math.max(0, i - 1)]) / (2 * T.cell);
  const zy = (T.z[Math.min(nv - 1, j + 1) * nv + i] - T.z[Math.max(0, j - 1) * nv + i]) / (2 * T.cell);
  const n = [-zx, -zy, 1], ln = Math.hypot(...n), l = [-0.5, 0.5, 0.7071];
  shade[k] = 0.45 + 0.55 * Math.max(0, (n[0] * l[0] + n[1] * l[1] + n[2] * l[2]) / ln);
}
const idx = [];
for (let qj = 0; qj < T.n; qj++) for (let qi = 0; qi < T.n; qi++) {
  for (const tri of S.squareTriangles(T, qi, qj)) idx.push(tri[0], tri[1], tri[2]);
}
const geom = new THREE.BufferGeometry();
geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
// three.js winds counter-clockwise seen from the front; ours are
// counter-clockwise from above in x east, y north, which z south mirrors
geom.setIndex(idx);
const land = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
scene.add(land);

const spotMark = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), new THREE.MeshBasicMaterial({ color: C.spot }));
const eyeMark = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), new THREE.MeshBasicMaterial({ color: C.eye }));
scene.add(spotMark, eyeMark);
let guide = null, rays = null;

// ---------------------------------------------------------------- compute

let result = null, L = null, ms = 0;

function compute() {
  L = light();
  const t0 = performance.now();
  result = S.horizonVisible(T, L, { bins: 2048 });
  ms = performance.now() - t0;
  for (let k = 0; k < nv * nv; k++) {
    const c = result.vis[k] ? C.seen : C.unseen, s = shade[k];
    col[3 * k] = c[0] * s; col[3 * k + 1] = c[1] * s; col[3 * k + 2] = c[2] * s;
  }
  geom.attributes.color.needsUpdate = true;
  buildMarks();
}

// a point along the way to the light, at most far scene units out
function towardsLight(p, far) {
  if (L.inf) return p.clone().add(new THREE.Vector3(L.d[0], L.d[2], -L.d[1]).multiplyScalar(far));
  const e = toScene(L.x, L.y, L.z), d = e.clone().sub(p), len = d.length();
  return len <= far ? e : p.clone().add(d.multiplyScalar(far / len));
}

function buildMarks() {
  const g = S.heightAt(T, state.x, state.y);
  const spot = toScene(state.x, state.y, g);
  spotMark.position.copy(spot);
  const base = toScene(state.x, state.y, g + state.h);
  const far = 7;
  const eye = towardsLight(base, far);
  eyeMark.position.copy(eye);
  eyeMark.visible = !L.inf;
  if (guide) { scene.remove(guide); guide.geometry.dispose(); }
  guide = new THREE.Line(new THREE.BufferGeometry().setFromPoints([spot, eye]),
    new THREE.LineDashedMaterial({ color: C.eye, dashSize: 0.06, gapSize: 0.05 }));
  guide.computeLineDistances();
  scene.add(guide);

  if (rays) { scene.remove(rays); rays.geometry.dispose(); rays = null; }
  if (!state.rays) return;
  // sight lines to a fixed sample of vertices, bright where they arrive
  const pts = [], cols = [], cs = new THREE.Color(C.ray), cb = new THREE.Color(C.blocked);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let s = 0; s < 220; s++) {
    const k = Math.floor(rnd() * nv * nv), i = k % nv, j = (k - i) / nv;
    const p = toScene(i * T.cell, j * T.cell, T.z[k]), q = towardsLight(p, far);
    const c = result.vis[k] ? cs : cb;
    if (!result.vis[k] && s % 3) continue;   // fewer of the blocked ones
    pts.push(p.x, p.y, p.z, q.x, q.y, q.z);
    cols.push(c.r, c.g, c.b, c.r, c.g, c.b);
  }
  const rg = new THREE.BufferGeometry();
  rg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  rg.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  rays = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45 }));
  scene.add(rays);
}

// ---------------------------------------------------------------- the view

const map = $("map");
let stretch = 1;

function drawView() {
  const box = map.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, box.width), h = Math.max(10, box.height);
  map.width = Math.round(w * dpr); map.height = Math.round(h * dpr);
  const ctx = map.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#05070d"; ctx.fillRect(0, 0, w, h);
  if (!result) return;
  const VS = result.views;

  // every triangle's pieces, in panorama coordinates: view w spans
  // x in [2w - 1, 2w + 1] for the eye; the sun's view is x = u
  const pieces = [];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let s = result.order.length - 1; s >= 0; s--) {
    const sq = result.order[s], qi = sq % T.n, qj = (sq - qi) / T.n;
    for (const tri of S.squareTriangles(T, qi, qj)) {
      let r = 0, g = 0, b = 0;
      for (const k of tri) {
        const c = result.vis[k] ? C.seen : C.unseen, f = shade[k] / 3;
        r += c[0] * f; g += c[1] * f; b += c[2] * f;
      }
      const fill = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
      for (const piece of S.projectTriangle(T, L, VS, tri)) {
        const off = L.inf ? 0 : 2 * piece.view;
        const P = piece.uv.map(([u, v]) => [off + u, v]);
        for (const [x, y] of P) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y > y1) y1 = y; if (y < y0) y0 = y;
        }
        pieces.push([P, fill]);
      }
    }
  }
  if (!pieces.length) return;
  // the eye's own ground runs off to v = -infinity below it: stop at 45
  // degrees down in the image; keep the skyline in view
  // for an eye on the spot, from the skyline down to 20 degrees below it
  if (!L.inf && distOf(state.t) < 1) {
    let lo = Infinity, hi = -Infinity;
    for (const V of VS) for (const e of V.E) if (e > -Infinity) { if (e < lo) lo = e; if (e > hi) hi = e; }
    if (hi > -Infinity) { y1 = hi; y0 = Math.max(y0, Math.tan(Math.atan(lo) - 20 * Math.PI / 180)); }
  }
  // the sun's view is sheared (v = z - w tan(el)); cos(el) makes it the
  // view square on to the sun
  const ys = L.inf ? Math.cos(state.el * Math.PI / 180) : 1;
  y0 *= ys; y1 *= ys;
  const pad = 0.03 * Math.max(x1 - x0, y1 - y0);
  x0 -= pad; x1 += pad; y0 -= pad; y1 += pad * 2;
  const sc = Math.min((w - 16) / (x1 - x0), (h - 30) / (y1 - y0));
  // a wide panorama would be a thin strip: stretch heights to fill
  stretch = Math.max(1, Math.min(8, Math.floor((0.9 * (h - 30)) / (sc * (y1 - y0)))));
  const sy = sc * stretch;
  const ox = (w - sc * (x1 - x0)) / 2, oy = 8 + (h - 30 - sy * (y1 - y0)) / 2;
  const X = (x) => ox + (x - x0) * sc, Y = (y) => oy + (y1 - y * ys) * sy;

  const top = oy, bot = oy + (y1 - y0) * sy;
  ctx.fillStyle = C.sky; ctx.fillRect(X(x0), top, (x1 - x0) * sc, bot - top);
  ctx.save();
  ctx.beginPath(); ctx.rect(X(x0), top, (x1 - x0) * sc, bot - top); ctx.clip();
  for (const [P, fill] of pieces) {
    ctx.beginPath();
    ctx.moveTo(X(P[0][0]), Y(P[0][1]));
    for (let k = 1; k < P.length; k++) ctx.lineTo(X(P[k][0]), Y(P[k][1]));
    ctx.closePath();
    ctx.fillStyle = fill; ctx.strokeStyle = fill; ctx.lineWidth = 0.6;
    ctx.fill(); ctx.stroke();
  }
  // the horizon left at the end: the skyline
  if (state.sky) {
    ctx.strokeStyle = C.horizon; ctx.lineWidth = 1.6;
    VS.forEach((V, wi) => {
      const off = L.inf ? 0 : 2 * wi;
      ctx.beginPath();
      let on = false;
      for (let b = 0; b < V.E.length; b++) {
        const e = V.E[b];
        if (e === -Infinity) { on = false; continue; }
        const x = X(off + V.lo + (b + 0.5) * V.du), y = Y(e);
        if (on) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        on = true;
      }
      ctx.stroke();
    });
  }
  ctx.restore();
  // wedge edges and names
  ctx.font = "12px system-ui, sans-serif"; ctx.fillStyle = C.muted; ctx.textAlign = "center";
  if (!L.inf) {
    ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = 1;
    for (let wi = 0; wi < 4; wi++) {
      const xc = 2 * wi;
      if (xc + 1 >= x0 && xc + 1 <= x1) { ctx.beginPath(); ctx.moveTo(X(xc + 1), top); ctx.lineTo(X(xc + 1), bot); ctx.stroke(); }
      if (xc >= x0 && xc <= x1) ctx.fillText(VS[wi].name, X(xc), top + 14);
    }
  } else ctx.fillText("towards the sun", X((x0 + x1) / 2), top + 14);
  if (stretch > 1) { ctx.textAlign = "right"; ctx.fillText(`heights x ${stretch}`, X(x1) - 4, top + 14); }
}

// ---------------------------------------------------------------- UI

const fmtDist = (d) => (!isFinite(d) ? "infinity: the sun" : d < 1 ? "0 m, on the spot" : d < 1000 ? `${d.toFixed(0)} m` : `${(d / 1000).toLocaleString("en", { maximumFractionDigits: d < 1e4 ? 1 : 0 })} km`);

for (const p of PRESETS) {
  const bt = document.createElement("button");
  bt.type = "button"; bt.textContent = p.label;
  bt.addEventListener("click", () => { Object.assign(state, p.s); update(); });
  $("presets").appendChild(bt);
}

const ui = { dist: $("dist"), h: $("h"), az: $("az"), el: $("el"), rays: $("rays"), sky: $("sky") };
ui.dist.addEventListener("input", () => { state.t = +ui.dist.value; update(); });
for (const k of ["h", "az", "el"]) ui[k].addEventListener("input", () => { state[k] = +ui[k].value; update(); });
for (const k of ["rays", "sky"]) ui[k].addEventListener("change", () => { state[k] = ui[k].checked ? 1 : 0; update(); });
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(defaultCam()); writeHash(); });

// click (not drag): move the spot there
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObject(land)[0];
  if (!hit) return;
  state.x = Math.round(hit.point.x / K + T.size / 2);
  state.y = Math.round(-hit.point.z / K + T.size / 2);
  update();
});

let pending = 0;
function update() {
  if (pending) return;
  pending = requestAnimationFrame(() => { pending = 0; compute(); sync(); });
}

function sync() {
  ui.dist.value = state.t; ui.h.value = state.h; ui.az.value = state.az; ui.el.value = state.el;
  ui.rays.checked = !!state.rays; ui.sky.checked = !!state.sky;
  const d = distOf(state.t);
  $("dist-out").textContent = fmtDist(d);
  $("h-out").textContent = `${state.h} m`;
  $("az-out").textContent = `${state.az}${DEG}`;
  $("el-out").textContent = `${state.el}${DEG}`;
  ui.h.disabled = L.inf;
  const frac = (S.visibleFraction(result.vis) * 100).toFixed(1);
  $("scene-label").textContent = L.inf ? "Lit ground (yellow) and cast shadow (blue)" : "Ground the eye can see (yellow) and cannot (blue)";
  $("view-label").textContent = L.inf ? "The sun's view: orthographic, parallel rays" :
    d < 1 ? "The eye's view: four gnomonic wedges, N E S W" : "The eye's view: gnomonic wedges, narrowing as it moves away";
  const rows = [
    ["Light", L.inf ? `the sun, ${state.az}${DEG} at ${state.el}${DEG} up` : `an eye ${fmtDist(d) === "0 m, on the spot" ? `${state.h} m above the spot` : `${fmtDist(d)} from the spot`}`],
    ["Projection", L.inf ? "orthographic (one view)" : "gnomonic (four wedges)"],
    [L.inf ? "Lit" : "Visible", `${frac}% of the ground`],
    ["Computed in", `${ms.toFixed(0)} ms, ${(T.n * T.n * 2).toLocaleString("en")} triangles`]
  ];
  $("out").innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("");
  drawView();
  writeHash();
}

// ---------------------------------------------------------------- start

window.addEventListener("hashchange", () => { readHash(); update(); });
new ResizeObserver(() => drawView()).observe(map.parentElement);
shareLinks("playproj: Sight and shade", { height: 640 });

function tick() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

compute();
sync();
resize();
setCamera(state.cam || defaultCam());
requestAnimationFrame(tick);
