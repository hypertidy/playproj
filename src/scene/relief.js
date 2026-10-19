// Relief for any surface: push each vertex along the surface's own normal
// (pointing away from the globe's centre) by its elevation times the
// exaggeration. Sea level stays on the surface, so coastlines stay on it.

import * as THREE from "three";
import { sampleElev } from "../core/basemap.js";

export const EARTH_R = 6371000;

export const hasElevation = (world) => !!(world && world.elev);

// pos: Float32Array of xyz; index: triangle indices; lonlat(k) -> [lon, lat]
// or null for vertex k. Returns the normals of the displaced surface.
export function displace(pos, index, lonlat, world, exaggeration) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  const n = g.attributes.normal.array;
  const s = exaggeration / EARTH_R;
  for (let k = 0, v = 0; v < pos.length; k++, v += 3) {
    const ll = lonlat(k);
    if (!ll) continue;
    const z = sampleElev(world, ll[0], ll[1]) * s;
    const out = n[v] * pos[v] + n[v + 1] * pos[v + 1] + n[v + 2] * pos[v + 2] < 0 ? -1 : 1;
    pos[v] += out * z * n[v]; pos[v + 1] += out * z * n[v + 1]; pos[v + 2] += out * z * n[v + 2];
  }
  g.computeVertexNormals();
  const normals = g.attributes.normal.array.slice();
  g.dispose();
  return normals;
}
