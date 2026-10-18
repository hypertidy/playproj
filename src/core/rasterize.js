// Polygon to raster, two ways, on one grid.
//
// Centre in: a cell is in when its centre is inside the polygon. This is the
// scanline fill of GDAL's rasterize (without ALL_TOUCHED) and of fasterize:
// for each row, intersect the polygon's edges with the line through the cell
// centres, sort the crossings and fill between pairs (even-odd).
//
// Exact coverage: the fraction of each cell's area that is inside the
// polygon, as exactextract computes it. Here it is the boundary integral
//
//   area of P left of x = k  =  integral over the boundary of min(x - k, 0) dy
//
// taken one row of cells at a time: every edge piece in a row adds its part
// to the cell it passes through and -dy to every cell to its right, so only
// cells the boundary touches need any geometry and the rest are a running
// sum. Horizontal edges add nothing (dy = 0), so the row's top and bottom
// never need to be clipped.
//
// Coordinates here are pixel coordinates: column = (x - x0) / dx and
// row = (y - y0) / dy, with row 0 at the top. A polygon is
// { outer, holes } with each ring a flat [x, y, x, y, ...] array; a closing
// point equal to the first is allowed.

// ---------------------------------------------------------------- grids

// Grid -> pixel coordinates for every ring of every polygon.
export function toPixel(polys, G) {
  const f = (r) => {
    const o = new Float64Array(r.length);
    for (let i = 0; i < r.length; i += 2) { o[i] = (r[i] - G.x0) / G.dx; o[i + 1] = (r[i + 1] - G.y0) / G.dy; }
    return o;
  };
  return polys.map((p) => ({ outer: f(p.outer), holes: p.holes.map(f) }));
}

export function bbox(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const r of [p.outer, ...p.holes]) for (let i = 0; i < r.length; i += 2) {
    const x = r[i], y = r[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

const rings = (polys) => polys.flatMap((p) => [p.outer, ...p.holes]);

// Twice the signed area of a flat ring (shoelace).
export function ringArea2(r) {
  let s = 0;
  const n = r.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    s += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return s;
}

// Area in grid units (pixel units when the polygons are in pixels).
export function polygonArea(polys) {
  let a = 0;
  for (const p of polys) a += Math.abs(ringArea2(p.outer)) / 2 - p.holes.reduce((s, h) => s + Math.abs(ringArea2(h)) / 2, 0);
  return a;
}

// ---------------------------------------------------------------- centre in

// Crossings of the edges with the horizontal line y (pixel rows), sorted.
// An edge counts when y0 <= y < y1 for its lower and upper ends, as in
// GDAL's GDALdllImageFilledPolygon, so a vertex on the line is counted once.
export function crossings(polys, y) {
  const xs = [];
  for (const r of rings(polys)) {
    const n = r.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n;
      let xa = r[i], ya = r[i + 1], xb = r[j], yb = r[j + 1];
      if (ya === yb) continue;
      if (ya > yb) { [xa, xb] = [xb, xa]; [ya, yb] = [yb, ya]; }
      if (y >= ya && y < yb) xs.push(xa + ((y - ya) * (xb - xa)) / (yb - ya));
    }
  }
  return xs.sort((a, b) => a - b);
}

// Uint8Array mask, 1 where the cell centre is inside (even-odd over all rings).
export function centreIn(polys, W, H) {
  const out = new Uint8Array(W * H);
  const rows = Array.from({ length: H }, () => []);
  for (const r of rings(polys)) {
    const n = r.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n;
      let xa = r[i], ya = r[i + 1], xb = r[j], yb = r[j + 1];
      if (ya === yb) continue;
      if (ya > yb) { [xa, xb] = [xb, xa]; [ya, yb] = [yb, ya]; }
      // rows whose centre line r + 0.5 is in [ya, yb)
      const r0 = Math.max(0, Math.ceil(ya - 0.5)), r1 = Math.min(H - 1, Math.ceil(yb - 0.5) - 1);
      for (let row = r0; row <= r1; row++) {
        const yc = row + 0.5;
        rows[row].push(xa + ((yc - ya) * (xb - xa)) / (yb - ya));
      }
    }
  }
  for (let row = 0; row < H; row++) {
    const xs = rows[row].sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // cells whose centre c + 0.5 lies in [xs[k], xs[k+1]), as GDAL rounds them
      const c0 = Math.max(0, Math.floor(xs[k] + 0.5)), c1 = Math.min(W, Math.floor(xs[k + 1] + 0.5));
      for (let c = c0; c < c1; c++) out[row * W + c] = 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------- exact coverage

// Float64Array of coverage fractions in [0, 1].
export function coverage(polys, W, H) {
  const out = new Float64Array(W * H);
  const diff = new Float64Array(W + 1);
  // each ring's sign: outer rings add, holes subtract, whatever their winding
  const list = [];
  for (const p of polys) {
    list.push([p.outer, 1]);
    for (const h of p.holes) list.push([h, -1]);
  }
  const pieces = Array.from({ length: H }, () => []);
  for (const [r, role] of list) {
    const a2 = ringArea2(r);
    if (a2 === 0) continue;
    // the integral of x dy round a ring is half its shoelace sum, so a ring
    // of negative shoelace area is turned round
    const s = role * Math.sign(a2);
    const n = r.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n;
      const xa = r[i], ya = r[i + 1], xb = r[j], yb = r[j + 1];
      if (ya === yb) continue;
      const lo = Math.min(ya, yb), hi = Math.max(ya, yb);
      const r0 = Math.max(0, Math.floor(lo)), r1 = Math.min(H - 1, Math.ceil(hi) - 1);
      for (let row = r0; row <= r1; row++) {
        // the edge's piece within this row, kept in the edge's direction
        const ta = Math.max(0, Math.min(1, (row - ya) / (yb - ya))), tb = Math.max(0, Math.min(1, (row + 1 - ya) / (yb - ya)));
        const t0 = Math.min(ta, tb), t1 = Math.max(ta, tb);
        if (t1 <= t0) continue;
        pieces[row].push(xa + t0 * (xb - xa), ya + t0 * (yb - ya), xa + t1 * (xb - xa), ya + t1 * (yb - ya), s);
      }
    }
  }
  for (let row = 0; row < H; row++) {
    const P = pieces[row];
    if (!P.length) continue;
    diff.fill(0);
    const base = row * W;
    for (let k = 0; k < P.length; k += 5) addPiece(P[k], P[k + 1], P[k + 2], P[k + 3], P[k + 4], out, base, diff, W);
    let acc = 0;
    for (let c = 0; c < W; c++) {
      acc += diff[c];
      let v = out[base + c] + acc;
      if (v < 1e-12) v = 0; else if (v > 1 - 1e-12) v = 1;
      out[base + c] = v;
    }
  }
  return out;
}

// One edge piece, split where it crosses whole columns. In column m a
// sub-piece adds (mean x - m - 1) dy to that cell and -dy to every cell right
// of it (through the difference array).
function addPiece(xa, ya, xb, yb, s, out, base, diff, W) {
  const sub = (x0, y0, x1, y1, m) => {
    const dy = (y1 - y0) * s;
    if (m >= W) return;
    if (m >= 0) out[base + m] += ((x0 + x1) / 2 - m - 1) * dy;
    diff[Math.max(0, m + 1)] -= dy;
  };
  if (xa === xb) { sub(xa, ya, xb, yb, Math.floor(xa)); return; }
  const dir = xb > xa ? 1 : -1;
  let x = xa, y = ya, m = dir > 0 ? Math.floor(xa) : Math.ceil(xa) - 1;
  const mEnd = dir > 0 ? Math.ceil(xb) - 1 : Math.floor(xb);
  while (true) {
    if (m === mEnd) { sub(x, y, xb, yb, m); return; }
    const xe = dir > 0 ? m + 1 : m;
    const ye = ya + ((xe - xa) * (yb - ya)) / (xb - xa);
    sub(x, y, xe, ye, m);
    x = xe; y = ye; m += dir;
  }
}

// The polygon clipped to a rectangle (Sutherland-Hodgman per ring).
export function clipRect(polys, x0, y0, x1, y1) {
  const clip = (r, inside, cut) => {
    const o = [];
    const n = r.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n;
      const a = [r[i], r[i + 1]], b = [r[j], r[j + 1]];
      const ia = inside(a), ib = inside(b);
      if (ia) o.push(a[0], a[1]);
      if (ia !== ib) o.push(...cut(a, b));
    }
    return o;
  };
  const atX = (k) => (a, b) => { const t = (k - a[0]) / (b[0] - a[0]); return [k, a[1] + t * (b[1] - a[1])]; };
  const atY = (k) => (a, b) => { const t = (k - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), k]; };
  const one = (r) => {
    let o = clip(r, (p) => p[0] >= x0, atX(x0));
    o = clip(o, (p) => p[0] <= x1, atX(x1));
    o = clip(o, (p) => p[1] >= y0, atY(y0));
    return clip(o, (p) => p[1] <= y1, atY(y1));
  };
  return polys.map((p) => ({ outer: one(p.outer), holes: p.holes.map(one).filter((h) => h.length >= 6) })).filter((p) => p.outer.length >= 6);
}

// The polygon clipped to one cell, in pixel coordinates.
export const cellPiece = (polys, col, row) => clipRect(polys, col, row, col + 1, row + 1);

// ---------------------------------------------------------------- storage

// Runs of consecutive cells along rows: [row, first, last] triples.
export function runs(test, W, H) {
  const out = [];
  for (let r = 0; r < H; r++) {
    let start = -1;
    for (let c = 0; c <= W; c++) {
      const on = c < W && test(r * W + c);
      if (on && start < 0) start = c;
      if (!on && start >= 0) { out.push(r, start, c - 1); start = -1; }
    }
  }
  return out;
}

// Tiles holding at least one cell that passes the test, as a Set of tile
// indices. T gives the tiling: tw x th cells a tile, tilesX tiles across,
// and the window's offset (ox, oy) in cells when the grid is a window on a
// larger tiled raster.
export function tilesTouched(test, W, H, T) {
  const { tw, th = tw, ox = 0, oy = 0, tilesX = Math.ceil((W + ox) / tw) } = T;
  const out = new Set();
  for (let r = 0; r < H; r++) {
    const tr = Math.floor((r + oy) / th) * tilesX;
    for (let c = 0; c < W; c++) if (test(r * W + c)) out.add(tr + Math.floor((c + ox) / tw));
  }
  return out;
}

// What the two answers count and how many bytes each way of storing them
// takes. Dense layouts are 1 byte a cell for the mask and 4 (float32) for
// coverage; cell numbers and run ends are int32.
export function summarise(mask, cov, W, H, T) {
  const n = W * H;
  const { tw, th = tw, ox = 0, oy = 0 } = T;
  let nIn = 0, nAny = 0, nFull = 0, nEdge = 0, sum = 0;
  let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
  for (let i = 0; i < n; i++) {
    if (mask[i]) nIn++;
    const f = cov[i];
    if (f > 0) {
      nAny++; sum += f;
      if (f >= 1) nFull++; else nEdge++;
      const r = Math.floor(i / W), c = i - r * W;
      if (c < bx0) bx0 = c; if (c > bx1) bx1 = c; if (r < by0) by0 = r; if (r > by1) by1 = r;
    }
  }
  const runsIn = runs((i) => mask[i], W, H).length / 3;
  const runsFull = runs((i) => cov[i] >= 1, W, H).length / 3;
  const tIn = tilesTouched((i) => mask[i], W, H, T), tAny = tilesTouched((i) => cov[i] > 0, W, H, T);
  const tilesAll = (Math.floor((W - 1 + ox) / tw) - Math.floor(ox / tw) + 1) * (Math.floor((H - 1 + oy) / th) - Math.floor(oy / th) + 1);
  const bboxCells = bx1 >= 0 ? (bx1 - bx0 + 1) * (by1 - by0 + 1) : 0;
  return {
    cells: n, nIn, nAny, nFull, nEdge, sum, runsIn, runsFull,
    tilesIn: tIn, tilesAny: tAny, tilesAll,
    bboxCells, bbox: [bx0, by0, bx1, by1],
    bytes: {
      denseMask: n, denseCov: 4 * n,
      tilesMask: tIn.size * tw * th, tilesCov: tAny.size * tw * th * 4,
      runsMask: 12 * runsIn, indexMask: 4 * nIn,
      bboxCov: 4 * bboxCells, listCov: 8 * nAny, runsEdges: 12 * runsFull + 8 * nEdge
    }
  };
}

// ---------------------------------------------------------------- geography

// Insert points so no segment is longer than `step` degrees, so an edge that
// is straight in longitude and latitude stays that way once projected.
export function densify(r, step = 0.25) {
  const out = [];
  const n = r.length;
  const closed = r[0] === r[n - 2] && r[1] === r[n - 1];
  const m = closed ? n - 2 : n;
  for (let i = 0; i < m; i += 2) {
    const j = (i + 2) % m;
    const xa = r[i], ya = r[i + 1], xb = r[j], yb = r[j + 1];
    const k = Math.max(1, Math.ceil(Math.max(Math.abs(xb - xa), Math.abs(yb - ya)) / step));
    for (let s = 0; s < k; s++) out.push(xa + ((xb - xa) * s) / k, ya + ((yb - ya) * s) / k);
  }
  return out;
}

// Each ring through a forward function (lon, lat) -> [x, y]; rings with
// points that do not project are dropped. Points that land on the one before
// (along a pole) are merged, and a run out and back along the same line (a
// ring closed through the pole, seen from above it) is taken out.
export function projectPolys(polys, fwd, step = 0.25) {
  const f = (r) => {
    const d = densify(r, step), pts = [];
    for (let i = 0; i < d.length; i += 2) {
      const p = fwd(d[i], d[i + 1]);
      if (!p || !isFinite(p[0]) || !isFinite(p[1])) return null;
      pts.push([p[0], p[1]]);
    }
    const o = unspike(pts);
    return o.length >= 3 ? Float64Array.from(o.flat()) : null;
  };
  const out = [];
  for (const p of polys) {
    const outer = f(p.outer);
    if (outer) out.push({ outer, holes: p.holes.map(f).filter(Boolean) });
  }
  return out;
}

// A closed ring of [x, y] points without repeated points and without
// spikes: a point where the ring turns straight back on itself goes, again
// and again, so an out-and-back run of any length folds away.
export function unspike(pts, tol = 1e-6) {
  const same = (a, b) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
  const back = (a, p, b) => {
    const ux = p[0] - a[0], uy = p[1] - a[1], vx = b[0] - p[0], vy = b[1] - p[1];
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    return Math.abs(ux * vy - uy * vx) <= 1e-9 * lu * lv && ux * vx + uy * vy < 0;
  };
  const bad = (a, p, b) => same(a, p) || same(p, b) || back(a, p, b);
  const o = [];
  for (const p of pts) {
    if (o.length && same(o[o.length - 1], p)) continue;
    while (o.length >= 2 && bad(o[o.length - 2], o[o.length - 1], p)) o.pop();
    if (!o.length || !same(o[o.length - 1], p)) o.push(p);
  }
  // round the closing point, from both ends
  let changed = true;
  while (changed && o.length > 3) {
    changed = false;
    const n = o.length;
    if (same(o[0], o[n - 1])) { o.pop(); changed = true; continue; }
    if (bad(o[n - 2], o[n - 1], o[0])) { o.pop(); changed = true; continue; }
    if (bad(o[n - 1], o[0], o[1])) { o.shift(); changed = true; }
  }
  return o;
}

// Area on the sphere of radius R between two parallels and meridians
// (degrees), the exact area of a longitude-latitude cell.
export function lonlatCellArea(lon0, lon1, lat0, lat1, R = 6371007.2) {
  const D = Math.PI / 180;
  return R * R * Math.abs((lon1 - lon0) * D) * Math.abs(Math.sin(lat1 * D) - Math.sin(lat0 * D));
}

// A grid round a bounding box: `n` cells along the longer side, square
// cells, the origin on a multiple of the cell size, padded by one cell.
export function gridAround([x0, y0, x1, y1], n) {
  const d = Math.max(x1 - x0, y1 - y0) / Math.max(1, n);
  const gx0 = (Math.floor(x0 / d) - 1) * d, gx1 = (Math.ceil(x1 / d) + 1) * d;
  const gy0 = (Math.floor(y0 / d) - 1) * d, gy1 = (Math.ceil(y1 / d) + 1) * d;
  const W = Math.round((gx1 - gx0) / d), H = Math.round((gy1 - gy0) / d);
  return { x0: gx0, y0: gy1, dx: d, dy: -d, width: W, height: H };
}
