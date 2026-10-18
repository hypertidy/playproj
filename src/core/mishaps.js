// Map catastrophes: the same rings and lines drawn two ways.
//
// "Vertex by vertex" is what a planar GIS does: project each vertex, join
// them with straight lines on the map and fill with the even-odd rule.
// "On the sphere" is what d3-geo (and s2) do: edges are great circles, the
// ring is cut at the map's seam and closed round its poles, and the winding
// order says which side of the ring is inside.
//
// Needs d3-geo, passed in as `d3` (the browser loads it as a global).

const D2R = Math.PI / 180;

// Flat maps of the rotated sphere: x is longitude, y a function of latitude.
// ymax is the top of the map in the same units (radians on the unit sphere).
export const flats = {
  eqc: { name: "Plate Carree", ymax: Math.PI / 2, phimax: 90, y: (p) => p },
  merc: {
    name: "Mercator",
    ymax: Math.PI,
    phimax: (2 * Math.atan(Math.exp(Math.PI)) - Math.PI / 2) / D2R,
    y: (p) => Math.log(Math.tan(Math.PI / 4 + p / 2))
  }
};

// d3 rotation that puts (lon0, lat0) at the centre of the map
export const rotation = (lon0, lat0) => [-lon0, -lat0, 0];

const ring = (pts) => [...pts, pts[0]];
const circleRing = (lat, step, east) => {
  const pts = [];
  for (let lon = -180 + step / 2; lon < 180; lon += step) pts.push([lon, lat]);
  return ring(east ? pts : pts.reverse());
};

// Each catastrophe is a step in a short story: some features, a map centre
// that makes it happen, the lon/lat to turn towards the camera on the globe,
// and a caption. Rings are stored as data usually arrives,
// with longitudes in -180..180.
export function catastrophes(d3) {
  const big = d3.geoCircle().center([-40, 25]).radius(115).precision(10)().coordinates[0];
  return [
    {
      id: "seam",
      name: "Crossing the seam",
      view: { lon: 0, lat: 0 },
      look: [180, -20],
      features: [{ type: "Polygon", coordinates: [ring([[160, -8], [-160, -8], [-160, -30], [160, -30]])] }],
      caption: "A box round Fiji, 40 degrees wide, with corners either side of 180. Joined vertex by vertex, " +
        "the edge from 160E to 160W runs 320 degrees the wrong way, the fill spans the whole map, and on the " +
        "globe it wraps round the far side of the world. On the sphere the edge is short and the box is cut in " +
        "two at the seam. Move the map centre to 180 and the naive map is fine again: the catastrophe belongs " +
        "to the seam, not to the data."
    },
    {
      id: "pole",
      name: "Round the pole",
      view: { lon: 0, lat: 0 },
      look: [20, -60],
      features: [{ type: "Polygon", coordinates: [circleRing(-62, 20, true)] }],
      caption: "A ring along 62S, everything south of it inside. Vertex by vertex it is a line across the map " +
        "that closes on itself, so it has no area at all. On the sphere the ring is a small cap round the pole, " +
        "and the map has to add an edge along the bottom, because the pole is a point on the globe and a whole " +
        "line on the map. Tilt the map centre and the pole comes in off the edge."
    },
    {
      id: "gc",
      name: "Straight or great circle",
      view: { lon: 0, lat: 0 },
      look: [-170, -40],
      features: [
        { type: "LineString", coordinates: [[147.33, -42.88], [-70.67, -33.45]] },
        { type: "LineString", coordinates: [[-0.45, 51.47], [-118.41, 33.94]] }
      ],
      caption: "Hobart to Santiago, and London to Los Angeles: two vertices each. A straight line on the map " +
        "sends the first across Africa the wrong way round; on the sphere it is a great circle over the " +
        "Southern Ocean that crosses the seam. London to LA is straight on the map but the great circle goes " +
        "over Greenland. Which line looks straight depends on the projection; only the great circle is shortest."
    },
    {
      id: "inside",
      name: "Inside out",
      view: { lon: 140, lat: 0 },
      look: [147, -42],
      features: [{ type: "Polygon", coordinates: [ring([[144, -40], [144, -44], [149, -44], [149, -40]])] }],
      caption: "A box round Tasmania, its vertices counterclockwise as GeoJSON (RFC 7946) and s2 expect. d3 " +
        "wants clockwise, so on the sphere this ring is the whole world except Tasmania. Planar code never " +
        "notices, because on a plane only one side of a ring is finite. On a sphere both sides are, and the " +
        "winding order is the only thing that says which one you meant. Try Reverse winding."
    },
    {
      id: "big",
      name: "Bigger than half",
      view: { lon: 0, lat: 0 },
      look: [-40, 25],
      features: [{ type: "Polygon", coordinates: [big] }],
      caption: "A circle of radius 115 degrees: more than a hemisphere, so it holds the north pole and crosses " +
        "the seam twice. Vertex by vertex the fill is nonsense. On the sphere it is the larger piece of the " +
        "globe, and nothing about the vertices alone says so: only their order does. Reverse winding gives " +
        "the small cap instead."
    },
    {
      id: "coast",
      name: "Recentred coastlines",
      view: { lon: 150, lat: 0 },
      look: [-30, 30],
      features: [],
      coast: 1,
      caption: "The coastlines centred on the Pacific. Every coastline that crosses the new seam at 30W is " +
        "joined vertex by vertex across the whole map: Greenland, Antarctica, the Atlantic islands. On the " +
        "sphere they are cut at the seam. Drag the centre and watch the streaks follow the seam."
    }
  ];
}

export function reverseFeature(f) {
  if (f.type !== "Polygon") return { ...f, coordinates: [...f.coordinates].reverse() };
  return { ...f, coordinates: f.coordinates.map((r) => [...r].reverse()) };
}

// Map pixel geometry for a flat map on a w-pixel-wide canvas.
export function frame(flatId, w) {
  const f = flats[flatId];
  const h = Math.round((w * f.ymax) / Math.PI);
  const k = w / (2 * Math.PI);
  return {
    w, h, k, flat: f,
    // rotated lon/lat in degrees to pixels, with latitude clamped to the map
    px: (lam, phi) => {
      const p = Math.max(-f.phimax, Math.min(f.phimax, phi)) * D2R;
      return [w / 2 + lam * D2R * k, h / 2 - f.y(p) * k];
    }
  };
}

// d3 projection for the spherical drawing, matched to frame()
export function sphereProjection(d3, flatId, w, rot) {
  const fr = frame(flatId, w);
  const p = flatId === "merc" ? d3.geoMercator() : d3.geoEquirectangular();
  p.rotate(rot).scale(fr.k).translate([fr.w / 2, fr.h / 2]).precision(0.2);
  if (flatId === "merc") p.clipExtent([[0, 0], [fr.w, fr.h]]);
  return p;
}

// Trace features vertex by vertex onto a canvas path: rotate each vertex,
// project it, and join with straight lines.
export function naivePath(ctx, d3, features, flatId, w, rot) {
  const fr = frame(flatId, w);
  const r = d3.geoRotation(rot);
  const trace = (pts, close) => {
    pts.forEach((ll, i) => {
      const [x, y] = fr.px(...r(ll));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    if (close) ctx.closePath();
  };
  for (const f of features) {
    if (f.type === "Polygon") f.coordinates.forEach((rg) => trace(rg, true));
    else if (f.type === "LineString") trace(f.coordinates, false);
    else if (f.type === "MultiLineString") f.coordinates.forEach((l) => trace(l, false));
  }
}

// The edges that the vertex-by-vertex map draws across the seam: consecutive
// vertices whose rotated longitudes are more than 180 degrees apart.
export function seamJumps(ctx, d3, lines, flatId, w, rot) {
  const fr = frame(flatId, w);
  const r = d3.geoRotation(rot);
  for (const pts of lines) {
    let prev = null;
    for (const ll of pts) {
      const q = r(ll);
      if (prev && Math.abs(q[0] - prev[0]) > 180) {
        ctx.moveTo(...fr.px(...prev));
        ctx.lineTo(...fr.px(...q));
      }
      prev = q;
    }
  }
}

// Areas as a fraction of the whole: d3's spherical area over 4 pi, and the
// planar shoelace area of the rotated lon/lat ring over 360 x 180.
export function areas(d3, f, rot) {
  if (f.type !== "Polygon") return null;
  const r = d3.geoRotation(rot);
  let planar = 0;
  for (const rg of f.coordinates) {
    const q = rg.map((ll) => r(ll));
    let a = 0;
    for (let i = 0; i < q.length - 1; i++) a += q[i][0] * q[i + 1][1] - q[i + 1][0] * q[i][1];
    planar += a / 2;
  }
  return { sphere: d3.geoArea(f) / (4 * Math.PI), planar: Math.abs(planar) / (360 * 180) };
}

// d3-geo's adaptive resampling (resample.js), recording what it does: each
// projected great-arc midpoint, the chord it was measured from, and whether
// it was kept. delta is the tolerance in pixels.
export function resampleArc(project, a, b, delta, maxDepth = 16) {
  const delta2 = delta * delta, cosMin = Math.cos(30 * D2R);
  const cart = ([lon, lat]) => {
    const c = Math.cos(lat * D2R);
    return [c * Math.cos(lon * D2R), c * Math.sin(lon * D2R), Math.sin(lat * D2R)];
  };
  const tests = [], points = [];
  const rec = (p0, c0, p1, c1, depth) => {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], d2 = dx * dx + dy * dy;
    if (!(d2 > 4 * delta2 && depth--)) return;
    let a2 = c0[0] + c1[0], b2 = c0[1] + c1[1], cc = c0[2] + c1[2];
    const m = Math.hypot(a2, b2, cc);
    a2 /= m; b2 /= m; cc /= m;
    const ll = [Math.atan2(b2, a2) / D2R, Math.asin(cc) / D2R];
    const p2 = project(ll);
    const dx2 = p2[0] - p0[0], dy2 = p2[1] - p0[1], dz = dy * dx2 - dx * dy2;
    const along = (dx * dx2 + dy * dy2) / d2;
    const foot = [p0[0] + dx * along, p0[1] + dy * along];
    const split = dz * dz / d2 > delta2 || Math.abs(along - 0.5) > 0.3 || c0[0] * c1[0] + c0[1] * c1[1] + c0[2] * c1[2] < cosMin;
    tests.push({ p: p2, foot, split, depth: maxDepth - depth - 1 });
    if (split) {
      const c2 = [a2, b2, cc];
      rec(p0, c0, p2, c2, depth);
      points.push(p2);
      rec(p2, c2, p1, c1, depth);
    }
  };
  const pa = project(a), pb = project(b);
  points.push(pa);
  rec(pa, cart(a), pb, cart(b), maxDepth);
  points.push(pb);
  return { tests, points };
}
