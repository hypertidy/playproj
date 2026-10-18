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

  function setCamera(c) {
    camera.position.set(c[0], c[1], c[2]);
    controls.target.set(c[3], c[4], c[5]);
    controls.update();
  }
  function getCamera() {
    const p = camera.position, t = controls.target;
    return [p.x, p.y, p.z, t.x, t.y, t.z];
  }
  if (onCamera) controls.addEventListener("end", () => onCamera(getCamera()));

  function resize() {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (onResize) onResize(w, h);
  }
  new ResizeObserver(resize).observe(el);

  return { renderer, scene, camera, controls, setCamera, getCamera, resize };
}
