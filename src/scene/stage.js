// A three.js stage in a page element: renderer, scene, perspective camera
// and orbit controls, sized to the element as it changes.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// el: the element to draw in. bg: clear colour. onCamera(cam) is called
// with [x, y, z, tx, ty, tz] when the user stops moving the view;
// onResize(w, h) after each resize. Nothing is sized until resize() is
// called (pages call it once their scene is built).
export function makeStage(el, { bg = 0x000000, fov = 38, near = 0.05, far = 200, onCamera, onResize } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(bg);
  el.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, 1, near, far);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // (and stops the view coasting on from a drag: see still())
  function setCamera(c) {
    camera.position.set(c[0], c[1], c[2]);
    controls.target.set(c[3], c[4], c[5]);
    if (held) still(held);
    else controls.update();
  }
  function getCamera() {
    const p = camera.position, t = controls.target;
    return [p.x, p.y, p.z, t.x, t.y, t.z];
  }
  if (onCamera) controls.addEventListener("end", () => onCamera(getCamera()));

  // OrbitControls turn about camera.up as it stood when they were made, and
  // about no other axis. controlsFor(axis) makes, once, another set that turns
  // about axis ([x, y, z]) over the same target, and passes its events on to
  // controls. turnAbout(axis) gives that set the mouse as soon as nothing is
  // dragged or still moving, and from then controls.update() moves the camera
  // with it; turnAbout(null) gives the mouse to no set, for a page that moves
  // the camera some other way. The camera's roll is still camera.up's, as
  // lookAt makes it, so a page can lean that from one axis to the other in its
  // own time. While another set has the mouse, controls.enabled is false, and
  // the other settings of controls are that set's.
  const sets = [[camera.up.toArray(), controls]];
  let held = controls, wanted = controls, dragging = false, moved = false;
  controls.addEventListener("start", () => { dragging = true; });
  controls.addEventListener("end", () => { dragging = false; });
  const own = controls.update;
  const SETTINGS = ["enableDamping", "dampingFactor", "enableZoom", "zoomSpeed", "enableRotate", "rotateSpeed",
    "enablePan", "panSpeed", "screenSpacePanning", "keyPanSpeed", "zoomToCursor", "minDistance", "maxDistance"];
  // OrbitControls keep the rest of a drag's turn to spend after the camera
  // stops moving (held at a pole, say), and spend it the next time they
  // move the camera: from wherever it has been put since, or when they have
  // the mouse again. still(c) has c spend it at once (damping off), then
  // puts the camera back.
  function still(c) {
    const p = camera.position.clone(), t = controls.target.clone(), d = c.enableDamping, run = c === controls ? own : () => c.update();
    c.enableDamping = false;
    run();
    camera.position.copy(p); controls.target.copy(t);
    run();
    c.enableDamping = d;
  }
  function update(dt) {
    // (before this frame's move, so a page that has just set camera.up for the
    // new axis never has a frame turned by the old one)
    if (wanted !== held && !dragging && !moved) {
      if (held) held.enabled = false;
      if (wanted) { wanted.enabled = true; still(wanted); }
      held = wanted;
    }
    if (held && held !== controls) for (const k of SETTINGS) held[k] = controls[k];
    moved = held === controls ? own(dt) : held ? held.update(dt) : false;
    return moved;
  }
  function controlsFor(axis) {
    const a = new THREE.Vector3(...axis).normalize().toArray();
    const got = sets.find(([u]) => u.every((x, i) => Math.abs(x - a[i]) < 1e-9));
    if (got) return got[1];
    const up = camera.up.clone();
    camera.up.fromArray(a);
    const c = new OrbitControls(camera, renderer.domElement);
    camera.up.copy(up);
    c.enabled = false;
    c.target = controls.target;
    c.mouseButtons = controls.mouseButtons;
    c.touches = controls.touches;
    for (const type of ["start", "change", "end"]) c.addEventListener(type, () => controls.dispatchEvent({ type }));
    controls.update = update;
    sets.push([a, c]);
    return c;
  }
  function turnAbout(axis) {
    controls.update = update;
    wanted = axis ? controlsFor(axis) : null;
    return wanted;
  }

  function resize() {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (onResize) onResize(w, h);
  }
  new ResizeObserver(resize).observe(el);

  return { renderer, scene, camera, controls, setCamera, getCamera, resize, controlsFor, turnAbout };
}
