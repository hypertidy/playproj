// Australia, faceted: one country in well sized panels with an overview,
// instead of insets.
//
// Australia's land runs from Cocos (96.8 E) to Norfolk (168 E) and from
// Ashmore Reef (12 S) to Heard Island (53 S) and, with the Australian
// Antarctic Territory, to the South Pole. A single frame for all of it is
// mostly ocean. Here each panel is a full map in its own CRS (the official
// one where there is one), fitted to its land, and one overview panel holds
// the true geography and the footprint of every other panel: the job a
// locator inset does, made the main thing.
//
// The three station panels (Mawson, Davis, Casey) are views: their land is
// part of the AAT, so they never count towards one frame's land. Heard
// Island and the stations can carry the aatgrid tile lattice of their UTM
// zone (src/core/aatgrid.js).
//
// Projections and areas come from inset.js. Checked in test/check-facets.mjs.

import { crs, centreOf, groundArea, pagePiece, wrap } from "./inset.js";
import * as AG from "./aatgrid.js";

const UTMS = (zone) => ({ proj: "tmerc", lon0: zone * 6 - 183, k0: 0.9996 });

// pieces of data/australia-10m.json: a name, the CRS a panel of it alone is
// drawn in, and its EPSG code (GDA2020 where there is one)
export const PIECES = {
  mainland: { name: "Mainland", spec: { proj: "aea", lat0: 0, lon0: 132, lat1: -18, lat2: -36 }, epsg: "EPSG:9473", crsName: "GDA2020 / Australian Albers" },
  tasmania: { name: "Tasmania, King and Flinders Islands", spec: UTMS(55), epsg: "EPSG:7855", crsName: "GDA2020 / MGA zone 55" },
  macquarie: { name: "Macquarie Island", spec: UTMS(57), epsg: "EPSG:7857", crsName: "GDA2020 / MGA zone 57" },
  lordhowe: { name: "Lord Howe Island", spec: UTMS(57), epsg: "EPSG:7857", crsName: "GDA2020 / MGA zone 57" },
  norfolk: { name: "Norfolk Island", spec: UTMS(58), epsg: "EPSG:7858", crsName: "GDA2020 / MGA zone 58" },
  christmas: { name: "Christmas Island", spec: UTMS(48), epsg: "EPSG:7848", crsName: "GDA2020 / MGA zone 48" },
  cocos: { name: "Cocos (Keeling) Islands", spec: UTMS(47), epsg: "EPSG:7847", crsName: "GDA2020 / MGA zone 47" },
  ashmore: { name: "Ashmore and Cartier Islands", spec: UTMS(51), epsg: "EPSG:7851", crsName: "GDA2020 / MGA zone 51" },
  coralsea: { name: "Coral Sea Islands", spec: UTMS(55), epsg: "EPSG:7855", crsName: "GDA2020 / MGA zone 55" },
  heard: { name: "Heard and McDonald Islands", spec: UTMS(43), epsg: "EPSG:7843", crsName: "GDA2020 / MGA zone 43" },
  aat: { name: "Australian Antarctic Territory", spec: { proj: "stere" }, epsg: "EPSG:3031", crsName: "WGS 84 / Antarctic Polar Stereographic" },
  mawson: { name: "Mawson and the Framnes Mountains", spec: UTMS(41), epsg: "EPSG:32741", crsName: "WGS 84 / UTM zone 41S", within: "aat" },
  davis: { name: "Davis and the Vestfold Hills", spec: UTMS(43), epsg: "EPSG:32743", crsName: "WGS 84 / UTM zone 43S", within: "aat" },
  casey: { name: "Casey and the Windmill Islands", spec: UTMS(49), epsg: "EPSG:32749", crsName: "WGS 84 / UTM zone 49S", within: "aat" }
};

// the pieces that are land of their own (not views into another piece)
export const OWN = Object.keys(PIECES).filter((k) => !PIECES[k].within);

// the stations, from the Australian Antarctic Division's station pages
export const STATIONS = {
  mawson: { name: "Mawson", lon: 62.8742, lat: -67.6026 },
  davis: { name: "Davis", lon: 77.9675, lat: -68.5767 },
  casey: { name: "Casey", lon: 110.5267, lat: -66.2825 }
};

// pieces that carry the aatgrid lattice, and their UTM south zone
export const TILED = { heard: 43, mawson: 41, davis: 43, casey: 49 };

// groupings: pieces drawn together in one panel, in a Lambert azimuthal on
// the middle of them, when the panels are grouped
export const GROUPS = {
  australia: { name: "Australia", pieces: ["mainland", "tasmania"], spec: PIECES.mainland.spec, epsg: "EPSG:9473", crsName: PIECES.mainland.crsName },
  tasman: { name: "The Tasman Sea: Lord Howe and Norfolk", pieces: ["lordhowe", "norfolk"] },
  indian: { name: "Indian Ocean Territories", pieces: ["christmas", "cocos"] },
  shelf: { name: "Reefs: Ashmore, Cartier and the Coral Sea", pieces: ["ashmore", "coralsea"] },
  subantarctic: { name: "Sub-Antarctic: Macquarie, Heard and McDonald", pieces: ["macquarie", "heard"] },
  aat: { name: "Australian Antarctic Territory", pieces: ["aat"], spec: PIECES.aat.spec, epsg: "EPSG:3031", crsName: PIECES.aat.crsName },
  mawson: { name: PIECES.mawson.name, pieces: ["mawson"] },
  davis: { name: PIECES.davis.name, pieces: ["davis"] },
  casey: { name: PIECES.casey.name, pieces: ["casey"] }
};

const r6 = (v) => +(+v).toFixed(4);

// The panels for a selection: `on` lists pieces shown, `split` gives each
// piece a panel of its own, otherwise pieces share their group's panel.
// Each panel is { key, name, pieces, crs, epsg, crsName }.
export function panels(data, on, split) {
  const out = [];
  if (split) {
    for (const k of Object.keys(PIECES)) if (on.includes(k)) {
      const P = PIECES[k];
      out.push({ key: k, name: P.name, pieces: [k], crs: crs(P.spec), epsg: P.epsg, crsName: P.crsName });
    }
    return out;
  }
  for (const [gk, G] of Object.entries(GROUPS)) {
    const ps = G.pieces.filter((k) => on.includes(k));
    if (!ps.length) continue;
    if (ps.length === 1 && !G.spec) {
      const P = PIECES[ps[0]];
      out.push({ key: ps[0], name: P.name, pieces: ps, crs: crs(P.spec), epsg: P.epsg, crsName: P.crsName });
      continue;
    }
    let g, epsg = G.epsg || null, crsName = G.crsName;
    if (G.spec) g = crs(G.spec);
    else {
      const [lon0, lat0] = centreOf(ps.flatMap((k) => data.pieces[k]));
      g = crs({ proj: "laea", lon0: r6(lon0), lat0: r6(lat0) });
      crsName = `Lambert azimuthal on ${Math.abs(r6(lon0)).toFixed(1)} ${lon0 < 0 ? "W" : "E"} ${Math.abs(r6(lat0)).toFixed(1)} S`;
    }
    out.push({ key: gk, name: G.name, pieces: ps, crs: g, epsg, crsName });
  }
  return out;
}

const identity = (g) => ({ forward: g.forward, inverse: g.inverse });

// The land of a panel in its own metres: rings, extent, map area, and its
// ground area in square metres.
export function panelGeometry(data, panel) {
  const rings = panel.pieces.flatMap((k) => data.pieces[k]);
  const page = pagePiece(identity(panel.crs), rings);
  const ground = panel.pieces.reduce((a, k) => a + groundArea(data.pieces[k]), 0);
  return { ...page, ground };
}

// One frame for all the pieces: a Lambert azimuthal on their middle (or
// `spec`), its extent and the share of it that is land. Views count only
// when `views` is set (for an overview that has to hold them) or when
// nothing else is on.
export function oneFrame(data, on, spec = null, views = false) {
  const own = on.filter((k) => !PIECES[k].within);
  if (!views && own.length) on = own;
  if (!on.length) return null;
  const rings = on.flatMap((k) => data.pieces[k]);
  const [lon0, lat0] = centreOf(rings);
  const g = crs(spec || { proj: "laea", lon0: r6(lon0), lat0: r6(Math.max(-89.9999, lat0)) });
  const page = pagePiece(identity(g), rings);
  const [x0, y0, x1, y1] = page.box;
  const ground = on.reduce((a, k) => a + groundArea(data.pieces[k]), 0);
  return { crs: g, box: page.box, width: x1 - x0, height: y1 - y0, ground, fill: ground / ((x1 - x0) * (y1 - y0)) };
}

// Panel rectangles in a w by h canvas: the overview on the left (or the top
// when the canvas is tall) with share `ov` of it, and the rest in a grid
// whose cell shape best fits the panels' own shapes. Returns { overview,
// cells } as [x, y, w, h].
export function layout(n, w, h, ov = 0.42, gap = 6) {
  const wide = w >= h * 0.9;
  const overview = wide ? [0, 0, Math.round(w * ov), h] : [0, 0, w, Math.round(h * ov)];
  const rx = wide ? overview[2] + gap : 0, ry = wide ? 0 : overview[3] + gap;
  const rw = w - rx, rh = h - ry;
  if (n === 0) return { overview: [0, 0, w, h], cells: [] };
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols), cw = (rw - gap * (cols - 1)) / cols, ch = (rh - gap * (rows - 1)) / rows;
    const score = Math.min(cw, ch * 1.2);
    if (!best || score > best.score) best = { cols, rows, cw, ch, score };
  }
  const cells = [];
  for (let i = 0; i < n; i++) {
    const c = i % best.cols, r = Math.floor(i / best.cols);
    cells.push([rx + c * (best.cw + gap), ry + r * (best.ch + gap), best.cw, best.ch]);
  }
  return { overview, cells };
}

// The scale (pixels per metre) that fits extent box into a cell, with room
// for a title and a scale bar.
export function fitScale(box, cell, pad = 0.1, head = 22) {
  const [x0, y0, x1, y1] = box, [, , cw, ch] = cell;
  const bw = Math.max(x1 - x0, 1000), bh = Math.max(y1 - y0, 1000);
  return Math.min((cw * (1 - pad)) / bw, ((ch - head - 18) * (1 - pad)) / bh);
}

// The outline of what a panel shows, as lon/lat: the panel rectangle's
// edges taken back through its CRS. `rect` is [x0, y0, x1, y1] metres.
export function footprint(panel, rect, n = 24) {
  const [x0, y0, x1, y1] = rect, out = [];
  const edge = (ax, ay, bx, by) => { for (let i = 0; i < n; i++) out.push(panel.crs.inverse(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n)); };
  edge(x0, y0, x1, y0); edge(x1, y0, x1, y1); edge(x1, y1, x0, y1); edge(x0, y1, x0, y0);
  return out.map(([lon, lat]) => [wrap(lon), lat]);
}

// The aatgrid lattice in a zone over a lon/lat box, padded by `pad` tiles:
// the tile edges as polylines of [lon, lat], and the column and row ranges.
// Edges are sampled so that they bend as they should in another CRS.
export function tileLattice(zone, res, [lon0, lat0, lon1, lat1], pad = 1, per = 8) {
  let e0 = Infinity, e1 = -Infinity, n0 = Infinity, n1 = -Infinity;
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
    const [e, n] = AG.toZone(lon0 + ((lon1 - lon0) * i) / 8, lat0 + ((lat1 - lat0) * j) / 8, zone);
    e0 = Math.min(e0, e); e1 = Math.max(e1, e); n0 = Math.min(n0, n); n1 = Math.max(n1, n);
  }
  const [c0, r0] = AG.tileIndex(e0, n0, res), [c1, r1] = AG.tileIndex(e1, n1, res);
  const cols = [c0 - pad, c1 + pad], rows = [r0 - pad, r1 + pad], ts = AG.tileSize(res);
  const x = (c) => AG.ORIGIN[0] + c * ts, y = (r) => AG.ORIGIN[1] + r * ts;
  const line = (ax, ay, bx, by, n) => {
    const out = [];
    for (let i = 0; i <= n; i++) out.push(AG.fromZone(zone, ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n));
    return out;
  };
  const nc = cols[1] - cols[0] + 1, nr = rows[1] - rows[0] + 1, lines = [];
  for (let c = cols[0]; c <= cols[1] + 1; c++) lines.push(line(x(c), y(rows[0]), x(c), y(rows[1] + 1), nr * per));
  for (let r = rows[0]; r <= rows[1] + 1; r++) lines.push(line(x(cols[0]), y(r), x(cols[1] + 1), y(r), nc * per));
  return { zone, res, cols, rows, lines };
}

// lon/lat bounds of rings of flat [lon, lat, ...]
export function bounds(rings) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const r of rings) for (let i = 0; i < r.length; i += 2) {
    x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]);
  }
  return [x0, y0, x1, y1];
}
