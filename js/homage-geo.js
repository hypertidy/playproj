// playproj: projections for the homage page that d3-geo does not carry,
// written as d3 raw projections (unit sphere, y up) so they match PROJ with
// +R=1. Each takes d3 as an argument, so the page (UMD d3 on window) and the
// tests (d3-geo from npm) share them.

const D2R = Math.PI / 180;

// Cylindrical equal-area with standard parallel lat_ts: +proj=cea +lat_ts.
// 45 is Gall-Peters, 37.5 is Hobo-Dyer.
export function ceaRaw(latTs) {
  const c = Math.cos(latTs * D2R);
  const raw = (l, p) => [l * c, Math.sin(p) / c];
  raw.invert = (x, y) => [x / c, Math.asin(Math.max(-1, Math.min(1, y * c)))];
  return raw;
}

// Robinson (PROJ +proj=robin): Robinson's table of lengths at 5 degree steps,
// joined by the cubic PROJ uses in each step. PROJ keeps these coefficients
// as single-precision floats; they are recovered here from PROJ itself
// (test/fixtures/homage-proj.json checks the result between the nodes).
// Each row is [c0, c1, c2, c3] in degrees from the step's start.
const ROB_X = [
  [1, 0, -7.1551498e-05, 3.11029999e-06], [0.998600006, -0.000482242991, -2.48969991e-05, -1.33089998e-06],
  [0.995400012, -0.000831030018, -4.48604987e-05, -9.86701025e-07], [0.99000001, -0.00135363999, -5.96610007e-05, 3.67770008e-06],
  [0.982200027, -0.00167441997, -4.49546997e-06, -5.72411e-06], [0.97299999, -0.00214867992, -9.03570981e-05, 1.87359994e-08],
  [0.959999979, -0.00305085001, -9.00761006e-05, 1.64917003e-06], [0.942700028, -0.00382791995, -6.53386014e-05, -2.61540004e-06],
  [0.921599984, -0.00467746006, -0.000104569997, 4.81242978e-06], [0.896200001, -0.00536222989, -3.23831009e-05, -5.43431997e-06],
  [0.867900014, -0.0060936301, -0.000113898001, 3.32484001e-06], [0.834999979, -0.00698324991, -6.40252983e-05, 9.34959019e-07],
  [0.798600018, -0.00755337998, -5.0000901e-05, 9.3532401e-07], [0.7597, -0.0079832403, -3.59709993e-05, -2.27625992e-06],
  [0.718599975, -0.00851367041, -7.01148965e-05, -8.63029982e-06], [0.673200011, -0.00986209046, -0.000199568996, 1.91973995e-05],
  [0.621299982, -0.0104179997, 8.83922985e-05, 6.24051017e-06], [0.5722, -0.00906600989, 0.000182000003, 6.24051017e-06]
];
const ROB_Y = [
  [0, 0.0124000004, 0, -8.45283985e-11], [0.061999999, 0.0124000004, -1.2679301e-09, 4.22642025e-10],
  [0.123999998, 0.0124000004, 5.07171016e-09, -1.60603997e-09], [0.186000004, 0.0123998998, -1.90189003e-08, 6.00152019e-09],
  [0.247999996, 0.0124001997, 7.10039032e-08, -2.24000001e-08], [0.310000002, 0.0123992004, -2.64996999e-07, 8.35986e-08],
  [0.372000009, 0.0124028996, 9.88982947e-07, -3.11994e-07], [0.433999985, 0.0123893004, -3.69093004e-06, -4.3562099e-07],
  [0.495799989, 0.0123198004, -1.02251997e-05, -3.45523006e-07], [0.557099998, 0.0121916002, -1.54081008e-05, -5.8228801e-07],
  [0.617600024, 0.0119938003, -2.41424004e-05, -5.25326982e-07], [0.676900029, 0.011713, -3.20223007e-05, -5.16405009e-07],
  [0.734600008, 0.0113541, -3.97684016e-05, -6.09051995e-07], [0.790300012, 0.0109107001, -4.89041995e-05, -1.04739001e-06],
  [0.843500018, 0.0103430999, -6.46150002e-05, -1.40373999e-09], [0.893599987, 0.00969685987, -6.46359986e-05, -8.54700011e-06],
  [0.939400017, 0.00840947032, -0.000192841006, -4.21059985e-06], [0.976100028, 0.00616527023, -0.000255999999, -4.21059985e-06]
];
const cubic = (c, z) => c[0] + z * (c[1] + z * (c[2] + z * c[3]));
export function robinsonRaw(l, p) {
  const d = Math.min(90, Math.abs(p) / D2R);
  const i = Math.min(17, Math.floor(d / 5)), z = d - 5 * i;
  return [0.8487 * l * cubic(ROB_X[i], z), Math.sign(p) * 1.3523 * cubic(ROB_Y[i], z)];
}

// Winkel tripel: the mean of Aitoff and the equirectangular with standard
// parallel lat_1, Winkel's own acos(2/pi) by default. PROJ's +proj=wintri
// defaults to lat_1=0, so the PROJ string below gives it explicitly.
export const WINKEL_LAT1 = 50.4597762;
export function winkelRaw(lat1 = WINKEL_LAT1) {
  const c1 = Math.cos(lat1 * D2R);
  return (l, p) => {
    const cp = Math.cos(p), a = Math.acos(cp * Math.cos(l / 2));
    const s = a ? a / Math.sin(a) : 1;
    return [(2 * cp * Math.sin(l / 2) * s + l * c1) / 2, (Math.sin(p) * s + p) / 2];
  };
}

// Van der Grinten (I), Snyder (1987) equations 29-1 to 29-9; +proj=vandg.
export function vanDerGrintenRaw(l, p) {
  const ap = Math.abs(p);
  if (ap < 1e-10) return [l, 0];
  const th = Math.asin(Math.min(1, (2 * ap) / Math.PI));
  if (Math.abs(l) < 1e-10 || ap > Math.PI / 2 - 1e-10) return [0, Math.sign(p) * Math.PI * Math.tan(th / 2)];
  const A = 0.5 * Math.abs(Math.PI / l - l / Math.PI);
  const G = Math.cos(th) / (Math.sin(th) + Math.cos(th) - 1);
  const P = G * (2 / Math.sin(th) - 1), Q = A * A + G;
  const P2 = P * P;
  const x = (Math.PI * (A * (G - P2) + Math.sqrt(A * A * (G - P2) * (G - P2) - (P2 + A * A) * (G * G - P2)))) / (P2 + A * A);
  const y = (Math.PI * Math.abs(P * Q - A * Math.sqrt((A * A + 1) * (P2 + A * A) - Q * Q))) / (P2 + A * A);
  return [Math.sign(l) * Math.abs(x), Math.sign(p) * y];
}

// The page's world projections by name, each a d3 projection (unscaled).
export function worldProjection(d3, name) {
  switch (name) {
    case "merc": return d3.geoMercator();
    case "eqc": return d3.geoEquirectangular();
    case "gallpeters": return d3.geoProjection(ceaRaw(45));
    case "hobodyer": return d3.geoProjection(ceaRaw(37.5));
    case "robin": return d3.geoProjection(robinsonRaw);
    case "wintri": return d3.geoProjection(winkelRaw());
    case "vandg": return d3.geoProjection(vanDerGrintenRaw);
    case "eqearth": return d3.geoEqualEarth();
    default: throw new Error("unknown projection " + name);
  }
}

// The PROJ string each one matches on the unit sphere (for the tests and
// the page's captions).
export const PROJ = {
  merc: "+proj=merc", eqc: "+proj=eqc", gallpeters: "+proj=cea +lat_ts=45",
  hobodyer: "+proj=cea +lat_ts=37.5", robin: "+proj=robin", wintri: "+proj=wintri +lat_1=50.4597762",
  vandg: "+proj=vandg", eqearth: "+proj=eqearth",
  aeqd: "+proj=aeqd +lat_0=90", laea: "+proj=laea +lat_0=90"
};

// North polar azimuthal, centred on the pole with the prime meridian
// pointing down the page, as in the UN emblem. `edge` is the southernmost
// latitude drawn.
export function polar(d3, kind, edge = -60) {
  const p = kind === "laea" ? d3.geoAzimuthalEqualArea() : d3.geoAzimuthalEquidistant();
  return p.rotate([0, -90]).clipAngle(Math.min(179.999, 90 - edge));
}

// A copy of a geometry slid along the meridian through lon0 by dlat
// degrees, then east by dlon: rotations of the sphere, so the shape and area
// are kept and only the map's view of them changes. Points are [lon, lat].
export function slide(d3, geometry, lon0, dlat, dlon = 0) {
  const r1 = d3.geoRotation([-lon0, 0]), r2 = d3.geoRotation([0, dlat]), r3 = d3.geoRotation([lon0 + dlon, 0]);
  const f = (pt) => r3(r2(r1(pt)));
  const map = (c, depth) => (depth ? c.map((x) => map(x, depth - 1)) : f(c));
  const depth = { Point: 0, LineString: 1, Polygon: 2, MultiPolygon: 3 }[geometry.type];
  return { type: geometry.type, coordinates: map(geometry.coordinates, depth) };
}

// ---------------------------------------------------------------- Dymaxion

// Fuller's icosahedron: the vertices as placed for the Dymaxion map (lon,
// lat), from Robert W. Gray's account of Fuller's projection. Six pairs of
// antipodes; every edge is 63.43 degrees.
export const FULLER_VERTICES = [
  [10.536199, 64.7], [-5.24539, 2.300882], [58.157706, 10.447378], [122.3, 39.1],
  [-143.47849, 50.103201], [-67.13233, 23.717925], [36.52151, -50.103201], [112.86767, -23.717925],
  [174.75461, -2.300882], [-121.842294, -10.447378], [-57.7, -39.1], [-169.463801, -64.7]
];

// The 20 faces (vertex triples) and 30 edges, found from the vertices.
export function icosahedron(d3, verts = FULLER_VERTICES) {
  const n = verts.length, edge = 2 * Math.atan(1 / ((1 + Math.sqrt(5)) / 2)) / D2R;  // 63.43
  const adj = (i, j) => Math.abs(d3.geoDistance(verts[i], verts[j]) / D2R - edge) < 0.01;
  const faces = [], edges = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (!adj(i, j)) continue;
      edges.push([i, j]);
      for (let k = j + 1; k < n; k++) if (adj(i, k) && adj(j, k)) faces.push([i, j, k]);
    }
  return { verts, faces, edges, edgeDeg: edge };
}

// Unfold the icosahedron into a flat net of equilateral triangles. Every
// net is a spanning tree of the faces; this keeps joined the edges that
// cross the most land (`landOn(a, b)` scores the edge from vertex a to b),
// so the cuts fall in the ocean, which is what Fuller arranged by hand.
// Returns, for each face, the net position (unit side) of each of its
// vertices, or null if this tree folds back over itself.
export function unfold(ico, landOn) {
  const { faces } = ico, nf = faces.length;
  const shared = (f, g) => faces[f].filter((v) => faces[g].includes(v));
  const dual = [];
  for (let f = 0; f < nf; f++)
    for (let g = f + 1; g < nf; g++) {
      const s = shared(f, g);
      if (s.length === 2) dual.push({ f, g, s, w: landOn(s[0], s[1]) });
    }
  dual.sort((a, b) => b.w - a.w || a.f - b.f || a.g - b.g);
  // Kruskal: maximum spanning tree on land
  const root = [...Array(nf).keys()], find = (x) => (root[x] === x ? x : (root[x] = find(root[x])));
  const tree = Array.from({ length: nf }, () => []);
  for (const e of dual) {
    const a = find(e.f), b = find(e.g);
    if (a === b) continue;
    root[a] = b; tree[e.f].push(e); tree[e.g].push(e);
  }
  // lay the faces out from the face with most land joined to it
  const start = tree.map((t, f) => [t.reduce((s, e) => s + e.w, 0), f]).sort((a, b) => b[0] - a[0])[0][1];
  const pos = new Array(nf).fill(null);
  const h = Math.sqrt(3) / 2;
  pos[start] = { [faces[start][0]]: [0, 0], [faces[start][1]]: [1, 0], [faces[start][2]]: [0.5, h] };
  const queue = [start];
  while (queue.length) {
    const f = queue.shift();
    for (const e of tree[f]) {
      const g = e.f === f ? e.g : e.f;
      if (pos[g]) continue;
      const [a, b] = e.s, c = faces[f].find((v) => v !== a && v !== b), d = faces[g].find((v) => v !== a && v !== b);
      const A = pos[f][a], B = pos[f][b], C = pos[f][c];
      // the new face is the old one reflected across the shared edge
      pos[g] = { [a]: A, [b]: B, [d]: [A[0] + B[0] - C[0], A[1] + B[1] - C[1]] };
      queue.push(g);
    }
  }
  // two faces on the same triangle of the lattice means the net overlaps
  const seen = new Set();
  for (let f = 0; f < nf; f++) {
    const c = Object.values(pos[f]).reduce((s, p) => [s[0] + p[0] / 3, s[1] + p[1] / 3], [0, 0]);
    const key = c.map((v) => Math.round(v * 1000)).join(",");
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return { pos, cut: dual.filter((e) => !tree[e.f].includes(e)) };
}

// ---------------------------------------------------------------- true size

// Mercator at scale s (pixels per unit sphere radius) and translate t, by
// hand, so longitudes can be unwrapped about a centre first.
export function mercator(s, t) {
  return ([lon, lat]) => {
    const p = Math.max(-85, Math.min(85, lat)) * D2R;
    return [t[0] + s * lon * D2R, t[1] - s * Math.log(Math.tan(Math.PI / 4 + p / 2))];
  };
}

// One polygon (rings of [lon, lat]) drawn at its true size: a Lambert
// azimuthal equal-area map about its own centroid, at the scale Mercator
// has on the equator, moved so the centroid sits where Mercator puts it.
// k blends from Mercator's shape (0) to the true one (1), vertex by vertex.
// The same construction in R: https://gist.github.com/mdsumner/045b19365f605492baed2fe85b15afd5
export function trueSize(d3, rings, s, t, k = 1) {
  const c = d3.geoCentroid({ type: "Polygon", coordinates: rings });
  const merc = mercator(s, t);
  const local = d3.geoAzimuthalEqualArea().rotate([-c[0], -c[1]]).scale(s).translate(merc(c));
  const unwrap = (lon) => c[0] + ((((lon - c[0]) % 360) + 540) % 360) - 180;
  return {
    centre: c,
    rings: rings.map((r) => r.map(([lon, lat]) => {
      const a = merc([unwrap(lon), lat]), b = local([lon, lat]);
      return [a[0] + k * (b[0] - a[0]), a[1] + k * (b[1] - a[1])];
    }))
  };
}
