// Shared geographic helpers: graticules, seeded randomness and the
// rotation that puts the tangent point at the top of the scene. Coastline
// polylines are a flat [lon, lat, lon, lat, ...] array each; data.js loads
// the ones playproj ships.

const D2R = Math.PI / 180;
// Graticule lines in the flat polyline format.
export function graticule(step = 15, res = 2) {
  const lines = [];
  for (let lon = -180; lon < 180; lon += step) {
    const l = [];
    for (let lat = -90; lat <= 90; lat += res) l.push(lon, lat);
    lines.push(l);
  }
  for (let lat = -90 + step; lat < 90; lat += step) {
    const l = [];
    for (let lon = -180; lon <= 180; lon += res) l.push(lon, lat);
    lines.push(l);
  }
  return lines;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Returns a function that places lon/lat (degrees) on the unit sphere in the
// scene frame, where the tangent point (lat0, lon0) is straight up (+y), east
// at the tangent point is +x and north is -z. Plane coordinates (x, y) from a
// projection then sit at scene position (x, 1, -y).
export function sceneFrame(lat0, lon0) {
  const p = lat0 * D2R, l = lon0 * D2R;
  const n = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  const e = [-Math.sin(l), Math.cos(l), 0];
  const u = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
  return (lon, lat, out, i = 0) => {
    const cp = Math.cos(lat * D2R);
    const x = cp * Math.cos(lon * D2R), y = cp * Math.sin(lon * D2R), z = Math.sin(lat * D2R);
    out[i] = x * e[0] + y * e[1] + z * e[2];
    out[i + 1] = x * n[0] + y * n[1] + z * n[2];
    out[i + 2] = -(x * u[0] + y * u[1] + z * u[2]);
    return out;
  };
}
