// Ways round a scene, added to a page's stage (stage.js): a double-click
// turns the view about a place, a ring marks the place while the view
// moves, and a click picks a thing, after a wait so that a double-click
// picks nothing. The store page and the Navigation page share them.

import * as THREE from "three";

const GLIDE_MS = 350, RING_MS = 700, PICK_WAIT = 300;
const ease = (x) => x * x * (3 - 2 * x);

// The view turns about the place a double-click gives: pivotAt(px, py,
// through) is that place (a THREE.Vector3) for a double-click at px, py on
// the canvas, through being whether Shift was held, or null for none. The
// view glides there, so the place comes to the middle with the camera's
// direction kept, and onCamera(cam) has the camera when it arrives. A ring
// marks the place the view turns about while it is dragged, zoomed or
// gliding, then fades. step(now) moves both: the page calls it each frame
// before controls.update(). glideTo(p) glides as a double-click would.
export function addPivot(stage, { pivotAt, onCamera = () => {} }) {
  const { scene, camera, controls, renderer } = stage, el = renderer.domElement;
  let glide = null;
  function glideTo(p) {
    glide = { t0: performance.now(), from: [camera.position.clone(), controls.target.clone()], d: p.clone().sub(controls.target) };
  }
  el.addEventListener("dblclick", (e) => {
    const r = el.getBoundingClientRect();
    const p = pivotAt(e.clientX - r.left, e.clientY - r.top, e.shiftKey);
    if (p) glideTo(p);
  });

  const ring = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    g.strokeStyle = g.fillStyle = "#ffffff"; g.lineWidth = 6;
    g.beginPath(); g.arc(32, 32, 24, 0, 2 * Math.PI); g.stroke();
    g.beginPath(); g.arc(32, 32, 5, 0, 2 * Math.PI); g.fill();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const m = new THREE.Points(geo, new THREE.PointsMaterial({ size: 20, sizeAttenuation: false, map: new THREE.CanvasTexture(c), transparent: true, depthTest: false, depthWrite: false }));
    m.renderOrder = 10; m.frustumCulled = false; m.visible = false;
    scene.add(m);
    return m;
  })();
  // (only when the view does move: a click starts the controls too)
  let turning = false, ringUntil = 0;
  controls.addEventListener("start", () => { turning = true; });
  controls.addEventListener("end", () => { turning = false; });
  controls.addEventListener("change", () => { if (turning) ringUntil = performance.now() + RING_MS; });

  function step(now) {
    if (glide) {
      const f = Math.min(1, (now - glide.t0) / GLIDE_MS), e = ease(f);
      camera.position.copy(glide.from[0]).addScaledVector(glide.d, e);
      controls.target.copy(glide.from[1]).addScaledVector(glide.d, e);
      if (f === 1) { glide = null; ringUntil = now + RING_MS; onCamera(stage.getCamera()); }
    }
    const left = glide ? 1 : (ringUntil - now) / RING_MS;
    ring.visible = left > 0;
    if (!ring.visible) return;
    ring.position.copy(controls.target);
    ring.material.opacity = 0.85 * Math.min(1, left);
  }
  return { step, glideTo, ring };
}

// A click (not a drag) picks what pickAt(px, py, e) gives for px, py on the
// canvas: a function that makes the pick, or null where there is nothing to
// pick. With Shift a click picks nothing (a Shift-double-click looks through
// to what hangs below, which a pick could move). The pick waits 0.3 s and a
// double-click drops it, so a double-click turns the view and picks
// nothing. The wait stops while the button is down again, so a slow
// double-click is still one; a drag begun in the wait lets the pick go
// ahead when it ends, and a click on nothing leaves it waiting.
export function addClickPick(stage, pickAt) {
  const el = stage.renderer.domElement;
  let downAt = null, pending = null, timer = 0;
  function now() {
    clearTimeout(timer);
    const f = pending;
    pending = null;
    if (f) f();
  }
  function later(f) {
    clearTimeout(timer);
    pending = f;
    if (f) timer = setTimeout(now, PICK_WAIT);
  }
  el.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; clearTimeout(timer); });
  el.addEventListener("pointercancel", now);
  el.addEventListener("pointerup", (e) => {
    if (!downAt) return;
    if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return now();
    if (e.shiftKey) return later(pending);
    const r = el.getBoundingClientRect();
    later(pickAt(e.clientX - r.left, e.clientY - r.top, e) || pending);
  });
  el.addEventListener("dblclick", () => later(null));
}

// A ray through px, py on the canvas, from the camera.
export function rayAt(stage, px, py, ray = new THREE.Raycaster()) {
  const r = stage.renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2((px / r.width) * 2 - 1, -(py / r.height) * 2 + 1), stage.camera);
  return ray;
}

// The point of obj's points, or of its line segments (lines: pairs of
// points), nearest px, py on the canvas within 8 px, as [point, distance
// from the camera], or null. skip(v) leaves out a point out of sight.
export function nearestOnScreen(stage, obj, px, py, { lines = false, skip = () => false } = {}) {
  const pos = obj.visible && obj.geometry.attributes.position;
  if (!pos) return null;
  const { camera } = stage;
  const a = pos.array, r = stage.renderer.domElement.getBoundingClientRect(), v = new THREE.Vector3();
  const M = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
  const screen = (m) => {
    v.set(a[3 * m], a[3 * m + 1], a[3 * m + 2]);
    if (skip(v)) return null;
    const w = M[3] * v.x + M[7] * v.y + M[11] * v.z + M[15];
    if (w <= 0) return null;
    return [(((M[0] * v.x + M[4] * v.y + M[8] * v.z + M[12]) / w + 1) / 2) * r.width, ((1 - (M[1] * v.x + M[5] * v.y + M[9] * v.z + M[13]) / w) / 2) * r.height];
  };
  const n = a.length / 3, step = lines ? 2 : 1;
  let best = null, bd = 64;
  for (let m = 0; m + step <= n; m += step) {
    const s0 = screen(m);
    if (!s0) continue;
    let t = 0, sx = s0[0], sy = s0[1];
    if (lines) {
      const s1 = screen(m + 1);
      if (!s1) continue;
      const dx = s1[0] - s0[0], dy = s1[1] - s0[1], L = dx * dx + dy * dy;
      t = L > 0 ? Math.max(0, Math.min(1, ((px - s0[0]) * dx + (py - s0[1]) * dy) / L)) : 0;
      sx += t * dx; sy += t * dy;
    }
    const d = (sx - px) ** 2 + (sy - py) ** 2;
    if (d < bd) { bd = d; best = [m, t]; }
  }
  if (!best) return null;
  const [m, t] = best, p = new THREE.Vector3(a[3 * m], a[3 * m + 1], a[3 * m + 2]);
  if (lines) p.lerp(new THREE.Vector3(a[3 * m + 3], a[3 * m + 4], a[3 * m + 5]), t);
  return [p, p.distanceTo(camera.position)];
}

// The nearest of [point, distance] pairs (nulls left out), or null.
export const nearestHit = (list) => list.reduce((b, h) => (h && (!b || h[1] < b[1]) ? h : b), null);
