// A scenespec mesh layer as a three.js mesh: one triangle after another
// (unindexed), so a face colour is flat and a pick's face index is the
// triangle's row in the face table. Positions come from the caller each
// time they change (the two homes of core/meshframe.js, blended), in the
// scene frame (east +x, up +y, north -z).

import * as THREE from "three";

// mesh: from src/load meshArrays(); colour: { colour, flat } from
// meshColours(). Returns { object, setPositions(xyz per vertex), edges }.
export function makeMeshLayer(mesh, colour, { stroke = null } = {}) {
  const n = mesh.ntri * 3, idx = mesh.index;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const src = colour.flat ? 3 * k : 3 * idx[k];
    col[3 * k] = colour.colour[src]; col[3 * k + 1] = colour.colour[src + 1]; col[3 * k + 2] = colour.colour[src + 2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const object = new THREE.Mesh(g, material);
  const group = new THREE.Group();
  group.add(object);

  let edges = null;
  if (stroke) {
    const eg = new THREE.WireframeGeometry(g);
    edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({
      color: new THREE.Color(stroke[0] / 255, stroke[1] / 255, stroke[2] / 255),
      transparent: stroke[3] < 255, opacity: stroke[3] / 255
    }));
    group.add(edges);
  }

  // xyz: Float32Array, three per vertex of the mesh (not per corner)
  function setPositions(xyz) {
    for (let k = 0; k < n; k++) {
      const v = 3 * idx[k];
      pos[3 * k] = xyz[v]; pos[3 * k + 1] = xyz[v + 1]; pos[3 * k + 2] = xyz[v + 2];
    }
    g.attributes.position.needsUpdate = true;
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    if (edges) {
      edges.geometry.dispose();
      edges.geometry = new THREE.WireframeGeometry(g);
    }
  }

  // swap colours in place (a new fill or a distortion field)
  function setColours(c) {
    for (let k = 0; k < n; k++) {
      const src = c.flat ? 3 * k : 3 * idx[k];
      col[3 * k] = c.colour[src]; col[3 * k + 1] = c.colour[src + 1]; col[3 * k + 2] = c.colour[src + 2];
    }
    g.attributes.color.needsUpdate = true;
  }

  function dispose() {
    g.dispose(); material.dispose();
    if (edges) { edges.geometry.dispose(); edges.material.dispose(); }
  }
  return { object: group, mesh: object, setPositions, setColours, dispose };
}
