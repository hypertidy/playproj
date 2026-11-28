// playproj: Insets
//
// A composite map is a main frame plus pieces, each a projection followed
// by an affine placement on the page (src/core/inset.js). A piece can sit
// in its true place on the main frame, in an inset (its own frame, scale
// and projection, with a box, a scale bar and a locator), or be moved on
// the page with no frame at all (sp::elide, the move-scale-rotate recipes).
// The steps go through the United States, then the same question in ten
// other places, then a layout of your own.

import * as I from "../src/core/inset.js";
import { readParams, hashWriter, oneOf } from "../src/scene/hash.js";
import { shareLinks } from "../src/scene/share.js";

const $ = (id) => document.getElementById(id);
const DEG = "\u00b0";
const COL = {
  bg: "#05070d", sea: "#081120", land: "#101a2c", piece: "#1c3152", pieceEdge: "#ffd34d", ctxEdge: "rgba(215,236,255,0.35)",
  box: "rgba(127,224,255,0.9)", outline: "rgba(255,122,184,0.85)", leader: "rgba(255,122,184,0.55)", grat: "rgba(140,196,255,0.16)",
  ink: "#dfe7f2", muted: "#8a97ab", pair: "#7fe0ff", sel: "#ffffff"
};

// ---------------------------------------------------------------- steps

// layouts: key -> { mode t|i|m|o, s, rot, ll [lon, lat] for the centre, or
// dkm [dx, dy] km from its true place }
const T = { mode: "t" };
const US_INSETS = {
  alaska: { mode: "i", s: 0.35, ll: [-114, 25.4] }, hawaii: { mode: "i", s: 1, ll: [-104.5, 25.2] },
  puertorico: { mode: "i", s: 1.6, ll: [-79, 24.6] }, usvi: T, guam: { mode: "o" }, cnmi: { mode: "o" }, amsamoa: { mode: "o" }
};
const US_TRUE = { alaska: T, hawaii: T, puertorico: T, usvi: T, guam: { mode: "o" }, cnmi: { mode: "o" }, amsamoa: { mode: "o" } };
const F0 = [-8.4, 46.6];
const STEPS = [
  {
    title: "Why is Alaska in a box?",
    text: "The map of the United States almost everyone has seen: d3's geoAlbersUsa, a composite of three Albers projections. The lower 48 are on the USGS Albers, Alaska on its own Albers drawn at 0.35 of the scale, Hawaii on its own at full scale, each moved into the space south-west of California. d3 draws no boxes; the dashed frames here are the clip boxes it uses. Tick Compare to see where they really are.",
    set: { scene: "usa", main: "d3", aks: 0.35, layout: {} }
  },
  {
    title: "Everything in its true place",
    text: "The same lower 48 Albers, with Alaska, Hawaii and Puerto Rico where they are. The sheet is now mostly sea, and the lower 48 get about half the width they had. Alaska is far from this projection's parallels and comes out sheared: angles bent by up to 39 degrees, areas still exact because Albers is equal-area everywhere.",
    set: { scene: "usa", main: "usgs", layout: US_TRUE }
  },
  {
    title: "One projection for all 50: Snyder's GS50",
    text: "John P. Snyder designed GS50 at the USGS in 1982: a stereographic bent by a tenth-order complex polynomial so that scale varies by under 2 percent over all 50 states, conformal throughout. It is in PROJ as +proj=gs50. It solves the distortion and nothing else: with Puerto Rico the sheet is 10 000 km wide and four fifths ocean. Puerto Rico, outside the states it was fitted to, is already 24 to 46 percent too large.",
    set: { scene: "usa", main: "gs50", layout: US_TRUE }
  },
  {
    title: "Or an equal-area one, centred on the 50",
    text: "A Lambert azimuthal on 123 W 47 N is the best centre for the 50 states: no area error at all, and angles bent by at most 7 degrees anywhere in them. That is a fine map for statistics. The frame problem is exactly the same as with GS50: the lower 48 get about half the page.",
    set: { scene: "usa", main: "laea50", layout: US_TRUE }
  },
  {
    title: "The price of the box: Alaska at 0.35",
    text: "Back to the composite, with Alaska's scale on a slider. At 0.35 (d3's choice, and much like the Census Bureau's) Alaska is drawn at 12 percent of its area against the lower 48, on a projection chosen to be equal-area. At 1 it fills the space below the West Coast and runs off the page. Every inset picks a point on that line.",
    set: { scene: "usa", main: "d3", aks: 0.35, layout: {} }
  },
  {
    title: "Moving the land itself (sp::elide)",
    text: "The same thing without a frame: shift, scale and rotate Alaska's and Hawaii's coordinates and keep them in one projection, as sp::elide did in R and as the SESYNC recipe does with sf (Alaska turned and shrunk by 2.3, Hawaii turned and moved). It looks tidy, but the coordinates are now wrong, and nothing on the page says so: measure Seattle to Anchorage on this map and you get a number, a wrong one.",
    set: { scene: "usa", main: "sesync", layout: { alaska: { mode: "m", s: 1 / 2.3, rot: 39, dkm: [1000, -5000] }, hawaii: { mode: "m", s: 1, rot: 35, dkm: [5200, -1400] }, puertorico: { mode: "o" }, usvi: { mode: "o" }, guam: { mode: "o" }, cnmi: { mode: "o" }, amsamoa: { mode: "o" } } }
  },
  {
    title: "All the territories",
    text: "Add Puerto Rico, the US Virgin Islands, Guam, the Northern Marianas and American Samoa (the set d3-composite-projections draws as geoAlbersUsaTerritories) and a true-place sheet runs across 150 degrees of longitude, from Guam at 145 E to the Virgin Islands at 65 W: 13 800 km wide, 10 percent land. In insets each is legible at a scale of its own, Guam at 4 times the main frame. Tick Compare to see the alternative.",
    set: { scene: "usa", main: "usgs", layout: {
      alaska: { mode: "i", s: 0.35, ll: [-114, 25.4] }, hawaii: { mode: "i", s: 1, ll: [-104.5, 25.2] }, cnmi: { mode: "i", s: 1, ll: [-98.2, 23.6] },
      guam: { mode: "i", s: 4, ll: [-94.6, 23.2] }, amsamoa: { mode: "i", s: 2.5, ll: [-90.2, 23.4] }, puertorico: { mode: "i", s: 1.6, ll: [-80.5, 23.6] },
      usvi: { mode: "i", s: 4, ll: [-75.5, 24.4] } } }
  },
  {
    title: "France: five islands, five equal boxes",
    text: "Insee's maps of France put the five overseas regions in a column of boxes of one size: Guadeloupe, Martinique, Guyane, La Reunion and Mayotte, each on its own UTM zone. Guyane is drawn at about a third of the scale of the islands, so a box of the same size holds it. Equal boxes say they are equal regions; the scale bars say the islands are tiny.",
    set: { scene: "france", main: "l93", layout: {
      guadeloupe: { mode: "i", s: 1.4, ll: F0, dkm: [0, 480], bw: 210 }, martinique: { mode: "i", s: 2.6, ll: F0, dkm: [0, 240], bw: 210 },
      guyane: { mode: "i", s: 0.45, ll: F0, bw: 210 }, reunion: { mode: "i", s: 2.6, ll: F0, dkm: [0, -240], bw: 210 },
      mayotte: { mode: "i", s: 4.5, ll: F0, dkm: [0, -480], bw: 210 } } }
  },
  {
    title: "Shetland, by law",
    text: "Shetland is 170 km north of mainland Scotland, and maps of Scotland have long put it in a box off the Moray Firth or in the corner. The Islands (Scotland) Act 2018, section 17, says Scottish public bodies must show it in a way that accurately and proportionately represents its location relative to the rest of Scotland, or explain why not. Tick Compare to put it back: the sheet goes from 545 to 689 km tall, and Shetland sits where it is, beyond Orkney.",
    set: { scene: "scotland", main: "bng", layout: { shetland: { mode: "i", s: 1, ll: [-0.6, 58.4] } } }
  },
  {
    title: "Chile on three continents",
    text: "The Instituto Geografico Militar's tricontinental map shows mainland Chile, Rapa Nui in Polynesia and the claimed Antarctic sector together. Here the claim is at the mainland's scale in a frame of its own (a Lambert azimuthal on the pole) and the islands are boxed. A 2025 proposal in the Chilean Senate asked for the official map to show Antarctica in its real, not reduced, size: the cost is a sheet in which the mainland gets a fifth of the width.",
    set: { scene: "chile", main: "tm71", layout: {
      easter: { mode: "i", s: 12, ll: [-80.5, -21] }, juanfernandez: { mode: "i", s: 3, ll: [-80.5, -29] }, chileantarctic: { mode: "i", s: 1, ll: [-55.5, -47.5] } } }
  },
  {
    title: "Spain: the Canaries box",
    text: "The Canary Islands are 1 000 km south-west of the peninsula, off Morocco; in true place the peninsula gets only half the sheet's width. Spanish maps, weather maps above all, move them into a box in the bottom left corner at the same scale, where Portugal's Atlantic and Morocco would be. Same scale, false place: the box is a confession that it is moved.",
    set: { scene: "spain", main: "utm30", layout: { canarias: { mode: "i", s: 1, ll: [-9.8, 36.3] } } }
  },
  {
    title: "Portugal: two archipelagos",
    text: "The Azores are 1 400 km west of Lisbon and Madeira 1 000 km south-west. Portuguese maps box them on the left, at the mainland's scale or a little larger. In their true place the mainland gets 13 percent of the sheet's width, a strip at the right edge of the Atlantic.",
    set: { scene: "portugal", main: "pttm", layout: { azores: { mode: "i", s: 1, ll: [-13.2, 41.2] }, madeira: { mode: "i", s: 1, ll: [-12.4, 37.4] } } }
  },
  {
    title: "Norway: Svalbard, Jan Mayen and Bouvet",
    text: "Svalbard and Jan Mayen are in the Arctic and Bouvet Island is in the far South Atlantic, 54 degrees south: a true-place map of Norway's land is a sheet 15 000 km tall in which the mainland gets a tenth of the height. Bouvet is in a box or left off; Svalbard often gets a box at the same scale up in the corner.",
    set: { scene: "norway", main: "utm33", layout: { svalbard: { mode: "i", s: 1, ll: [2, 69.6] }, janmayen: { mode: "i", s: 3, ll: [1.5, 64.3] }, bouvet: { mode: "i", s: 6, ll: [1.8, 61.6] } } }
  },
  {
    title: "Ecuador: the Galapagos",
    text: "The Galapagos are 1 000 km out in the Pacific, on UTM zone 15S where the mainland is on 17S. Ecuador's maps box them to the west, often a little larger than the mainland scale, which brings them close to the coast they do not touch.",
    set: { scene: "ecuador", main: "utm17", layout: { galapagos: { mode: "i", s: 1.2, ll: [-83.3, -2.2] } } }
  },
  {
    title: "New Zealand: Chathams, Kermadecs and the sub-Antarctic",
    text: "The Chatham Islands are 800 km east and have their own transverse Mercator (EPSG:3793), the Kermadecs 1 000 km north-east and the sub-Antarctic islands 600 km south. With all of them in place the sheet is 2 570 km tall instead of 1 500; the boxes keep NZTM2000 at a size you can read.",
    set: { scene: "nz", main: "nztm", layout: { chathams: { mode: "i", s: 2, ll: [178.4, -44.6] }, kermadec: { mode: "i", s: 6, ll: [178.2, -36.4] }, nzsubantarctic: { mode: "i", s: 0.8, ll: [168.6, -36.2] } } }
  },
  {
    title: "Denmark: the inset bigger than the country",
    text: "The realm's Greenland is 50 times the area of Denmark. Danish maps box Bornholm, out in the Baltic, near Copenhagen at full scale, and the Faroes and Greenland at much smaller scales: an inset that holds more land than the main frame. In true place Denmark gets 9 percent of the sheet's width, a speck at the edge of the North Atlantic.",
    set: { scene: "denmark", main: "utm32", layout: { bornholm: { mode: "i", s: 1, ll: [12.9, 57.4] }, faroe: { mode: "i", s: 0.7, ll: [8.95, 58.15] }, greenland: { mode: "i", s: 0.09, ll: [14.5, 56.4] } } }
  },
  {
    title: "Tasmania and Macquarie Island",
    text: "King and Flinders Islands are close enough to share Tasmania's frame at full scale. Macquarie Island, part of Tasmania, is 1 500 km south-south-east on MGA zone 57: in its true place it takes the frame from 520 km tall to 1 750, for an island 34 km long. And maps of Australia have left Tasmania itself off, on Olympic uniforms in 1956 and Australia Day caps in 2016: the cost of having no inset at all.",
    set: { scene: "tasmania", main: "mga55", layout: { macquarie: { mode: "i", s: 2, ll: [149.6, -43.9] } } }
  },
  {
    title: "Build your own",
    text: "Choose an example and a main frame, then put each piece in its true place, in an inset or moved without a frame, and drag it where you like. The table shows what each choice costs: the share of the sheet that is map, the scale each piece is drawn at, and what its area becomes. Copy the layout as PROJ strings and affines.",
    set: { scene: "usa", main: "usgs", layout: US_INSETS },
    build: true
  }
];

// ---------------------------------------------------------------- state

const SCENE_KEYS = Object.keys(I.SCENES);
const defaults = { s: 0, scene: "usa", main: "d3", aks: 0.35, L: "", tp: 0, outline: 0, leader: 1, ctx: 1, grat: 0, names: 1, edit: 0, v: "" };
const state = { ...defaults };
function readHash() {
  readParams(state, defaults, {
    scene: oneOf(SCENE_KEYS, "usa"), main: String, L: String, v: String,
    s: (r) => Math.max(0, Math.min(STEPS.length - 1, Math.round(+r) || 0))
  });
  if (state.main !== "d3" && !I.SCENES[state.scene].mains[state.main]) state.main = I.SCENES[state.scene].main;
  if (state.main === "d3" && state.scene !== "usa") state.main = I.SCENES[state.scene].main;
}
readHash();
const writeHash = hashWriter(state, defaults, { digits: 4 });

// layout string: key:mode,s,rot,xkm,ykm;...
const MODES = { t: "true", i: "inset", m: "moved", o: "off" };
const CODE = { true: "t", inset: "i", moved: "m", off: "o" };
function parseLayout(str) {
  const out = {};
  for (const part of (str || "").split(";")) {
    const [key, rest] = part.split(":");
    if (!key || !rest) continue;
    const [m, s, rot, x, y, bw] = rest.split(",");
    out[key] = { mode: MODES[m] || "true", s: +s || 1, rot: +rot || 0 };
    if (+bw > 0) out[key].bw = +bw;
    if (isFinite(+x) && isFinite(+y) && x !== "" && y !== "") out[key].at = [+x * 1000, +y * 1000];
  }
  return out;
}
function layoutString(L) {
  return Object.entries(L).map(([k, v]) => `${k}:${CODE[v.mode]},${+(+v.s).toFixed(4)},${+(+v.rot || 0).toFixed(1)}` +
    (v.at ? `,${Math.round(v.at[0] / 1000)},${Math.round(v.at[1] / 1000)}` : "") + (v.at && v.bw ? `,${v.bw}` : "")).join(";");
}

// ---------------------------------------------------------------- data

let data = null, centres = {}, grounds = {};
const scene = () => I.SCENES[state.scene];
let mainKey = "", mainCrs = null;
function currentMain() {
  const k = state.scene + "," + state.main;
  if (k !== mainKey) {
    mainKey = k;
    mainCrs = state.main === "d3" ? I.albersUsaPieces().us48.crs : I.crs(scene().mains[state.main].spec);
  }
  return mainCrs;
}

// a step's layout made concrete on the main frame: ll and dkm become page km
function resolveLayout(spec) {
  const g = currentMain(), out = {};
  for (const [key, v] of Object.entries(spec)) {
    const mode = MODES[v.mode] || v.mode;
    const o = { mode, s: v.s ?? 1, rot: v.rot || 0 };
    if (v.bw) o.bw = v.bw;
    if (v.ll) { o.at = g.forward(...v.ll); if (v.dkm) o.at = [o.at[0] + v.dkm[0] * 1000, o.at[1] + v.dkm[1] * 1000]; }
    else if (v.dkm && centres[key]) { const [x, y] = g.forward(...centres[key]); o.at = [x + v.dkm[0] * 1000, y + v.dkm[1] * 1000]; }
    out[key] = o;
  }
  return out;
}

// the placed pieces for the current state
function placed() {
  if (!data) return [];
  if (state.main === "d3" && !state.tp) {
    const P = I.albersUsaPieces(), B = I.albersUsaBoxes();
    return ["us48", "alaska", "hawaii"].map((key) => {
      const p = { ...P[key] };
      if (key === "alaska") p.s = state.aks;
      let box = key === "us48" ? null : B[key];
      if (key === "alaska" && state.aks !== 0.35) {
        // grow d3's Alaska clip box about its corner by the change of scale
        const k = state.aks / 0.35, [x0, y0, x1, y1] = box;
        box = [x0, y0, x0 + (x1 - x0) * k, y0 + (y1 - y0) * k];
      }
      return { key, mode: key === "us48" ? "true" : "inset", crs: p.crs, anchor: p.anchor, s: p.s, rot: 0, at: p.at, placer: I.placer(p), d3box: box };
    });
  }
  const L = state.main === "d3" ? { puertorico: { mode: "off" }, usvi: { mode: "off" }, guam: { mode: "off" }, cnmi: { mode: "off" }, amsamoa: { mode: "off" } } : parseLayout(state.L);
  return I.placeScene(state.scene, L, currentMain(), centres, { allTrue: !!state.tp });
}

// page geometry and frame statistics, cached on the state that makes them
let geomKey = "", geom = null;
function geometry() {
  const key = [state.scene, state.main, state.aks, state.L, state.tp, !!data].join("|");
  if (key === geomKey) return geom;
  geomKey = key;
  const items = placed().map((p) => {
    const page = I.pagePiece(p.placer, data.pieces[p.key]);
    let box = null;
    if (p.mode === "inset") {
      if (p.d3box) box = p.d3box;
      else if (p.bw) {
        // a box of a fixed size, centred on the piece (Insee's equal boxes)
        const [cx, cy] = p.at, r = (p.bw * 1000) / 2;
        box = [cx - r, cy - r, cx + r, cy + r];
      } else {
        const [x0, y0, x1, y1] = page.box, pad = Math.max(0.08 * Math.max(x1 - x0, y1 - y0), 12000);
        box = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
      }
    }
    return { ...p, page, box, ground: grounds[p.key] };
  });
  const stats = items.length ? I.frameStats(items) : null;
  geom = { items, stats };
  return geom;
}

// ---------------------------------------------------------------- view

const map = $("map");
let view = null, hover = null;

function makeView(w, h) {
  const { stats } = geometry();
  let cx = 0, cy = 0, s = 1e-4;
  const v = state.v.split(",").map(Number);
  if (v.length === 3 && v.every(isFinite) && v[2] > 1) {
    [cx, cy] = [v[0] * 1000, v[1] * 1000]; s = w / (v[2] * 1000);
  } else if (stats) {
    const [x0, y0, x1, y1] = stats.extent, pad = 1.06;
    cx = (x0 + x1) / 2; cy = (y0 + y1) / 2;
    s = Math.min(w / ((x1 - x0) * pad), (h - 40) / ((y1 - y0) * pad));
    cy -= 10 / s;
  }
  return {
    w, h, cx, cy, s,
    px: (X, Y) => [w / 2 + (X - cx) * s, h / 2 - (Y - cy) * s],
    pg: (x, y) => [cx + (x - w / 2) / s, cy - (y - h / 2) / s]
  };
}

// ---------------------------------------------------------------- drawing

function ringPath(ctx, xy) {
  ctx.beginPath();
  let pen = false, lx = 0;
  for (let i = 0; i < xy.length; i += 2) {
    const [x, y] = view.px(xy[i], xy[i + 1]);
    if (!isFinite(x) || !isFinite(y)) { pen = false; continue; }
    // a jump across the sheet is the antimeridian or the edge of a projection
    if (pen && Math.abs(x - lx) > view.w * 0.6) pen = false;
    pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    pen = true; lx = x;
  }
  ctx.closePath();
}
const projRing = (pl, r) => {
  const xy = new Float64Array(r.length);
  for (let i = 0; i < r.length; i += 2) { const [x, y] = pl.forward(r[i], r[i + 1]); xy[i] = x; xy[i + 1] = y; }
  return xy;
};
let ctxCache = new Map();
function contextRings(pl, cacheKey) {
  if (!state.ctx || !data) return [];
  if (ctxCache.has(cacheKey)) return ctxCache.get(cacheKey);
  const out = [];
  for (const u of data.context[scene().context] || []) for (const r of u.rings) {
    const xy = projRing(pl, r);
    let ok = true;
    for (let i = 0; i < xy.length; i++) if (!isFinite(xy[i]) || Math.abs(xy[i]) > 3e7) { ok = false; break; }
    if (ok) out.push(xy);
  }
  ctxCache.set(cacheKey, out);
  return out;
}

function draw() {
  const box = map.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, box.width), h = Math.max(10, box.height);
  map.width = Math.round(w * dpr); map.height = Math.round(h * dpr);
  const ctx = map.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, w, h);
  if (!data) return;
  view = makeView(w, h);
  const { items, stats } = geometry();
  const main = items[0];

  // the sheet
  const [sx0, sy0, sx1, sy1] = stats.extent, [ax, ay] = view.px(sx0, sy1), [bx, by] = view.px(sx1, sy0);
  ctx.fillStyle = COL.sea; ctx.fillRect(ax, ay, bx - ax, by - ay);
  ctx.strokeStyle = "rgba(223,231,242,0.25)"; ctx.lineWidth = 1; ctx.setLineDash([2, 4]); ctx.strokeRect(ax, ay, bx - ax, by - ay); ctx.setLineDash([]);

  // main frame: context land, graticule
  const mk = `${mainKey}|main`;
  ctx.fillStyle = COL.land; ctx.strokeStyle = COL.ctxEdge; ctx.lineWidth = 0.8;
  for (const xy of contextRings(main.placer, mk)) { ringPath(ctx, xy); ctx.fill(); ctx.stroke(); }
  if (state.grat) graticule(ctx, main.placer, null);

  // pieces in the main frame (true place and moved)
  for (const it of items) if (!it.box) drawPiece(ctx, it);

  // ghosts of moved and boxed pieces in their true place
  if (state.outline) {
    ctx.strokeStyle = COL.outline; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
    const truePl = (it) => I.placer({ crs: main.crs, anchor: it.anchor, at: main.crs.forward(...it.anchor), s: 1 });
    for (const it of items) if (it.mode !== "true") for (const r of data.pieces[it.key]) { ringPath(ctx, projRing(truePl(it), r)); ctx.stroke(); }
    ctx.setLineDash([]);
  }

  // insets: a box of sea with its own context, the piece, and a scale bar
  for (const it of items) if (it.box) {
    const [x0, y0, x1, y1] = it.box, [p, q] = view.px(x0, y1), [r, t] = view.px(x1, y0);
    ctx.save();
    ctx.beginPath(); ctx.rect(p, q, r - p, t - q); ctx.fillStyle = COL.sea; ctx.fill(); ctx.clip();
    ctx.fillStyle = COL.land; ctx.strokeStyle = COL.ctxEdge; ctx.lineWidth = 0.8;
    for (const xy of contextRings(it.placer, `${mainKey}|${it.key}|${it.s}|${it.at}`)) { ringPath(ctx, xy); ctx.fill(); ctx.stroke(); }
    if (state.grat) graticule(ctx, it.placer, it);
    drawPiece(ctx, it);
    ctx.restore();
    ctx.strokeStyle = it.key === dragKey ? COL.sel : COL.box; ctx.lineWidth = 1.4;
    if (it.d3box) ctx.setLineDash([5, 4]);
    ctx.strokeRect(p, q, r - p, t - q); ctx.setLineDash([]);
    insetBar(ctx, it, p, q, r, t);
  }

  // locator lines from each box or moved piece to its true place
  if (state.leader) {
    ctx.strokeStyle = COL.leader; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
    for (const it of items) if (it.mode !== "true") {
      const [tx, ty] = view.px(...main.crs.forward(...it.anchor));
      const b = it.box || it.page.box, cx = Math.max(b[0], Math.min(b[2], main.crs.forward(...it.anchor)[0]));
      const cy = Math.max(b[1], Math.min(b[3], main.crs.forward(...it.anchor)[1]));
      const [fx, fy] = view.px(cx, cy);
      if (Math.hypot(tx - fx, ty - fy) < 8) continue;
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.beginPath(); ctx.arc(tx, ty, 3, 0, 2 * Math.PI); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // the two places the distance readout measures
  const pr = pairPoints(items);
  if (pr) {
    ctx.strokeStyle = COL.pair; ctx.fillStyle = COL.pair; ctx.lineWidth = 1.5;
    const [p1, p2] = [view.px(...pr.a), view.px(...pr.b)];
    if (!pr.split) { ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(...p1); ctx.lineTo(...p2); ctx.stroke(); ctx.setLineDash([]); }
    ctx.font = "11px system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    for (const [p, n] of [[p1, pr.na], [p2, pr.nb]]) { ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, 2 * Math.PI); ctx.fill(); halo(ctx, n, p[0] + 5, p[1]); }
  }

  if (state.names) {
    ctx.font = "12px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    for (const it of items) {
      const b = it.box || it.page.box, [x, y] = view.px((b[0] + b[2]) / 2, b[3]);
      if (it.box) halo(ctx, scene().pieces[it.key].name, x, y - 3, COL.box);
    }
  }
  mainBar(ctx);
  $("map-label").textContent = state.main === "d3" ? (state.tp ? "The lower 48's spherical Albers from geoAlbersUsa, everything in its true place" : "d3 geoAlbersUsa: three spherical Albers, Alaska at " + state.aks.toFixed(2))
    : `${scene().mains[state.main].label}: ${scene().name}${state.tp ? ", everything in its true place" : ""}`;
}

function halo(ctx, text, x, y, colour = COL.ink) {
  ctx.strokeStyle = "rgba(5,7,13,0.85)"; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.strokeText(text, x, y);
  ctx.fillStyle = colour; ctx.fillText(text, x, y);
}

function drawPiece(ctx, it) {
  const g = geometry().items.find((x) => x.key === it.key);
  ctx.fillStyle = COL.piece; ctx.strokeStyle = it.key === dragKey ? COL.sel : COL.pieceEdge; ctx.lineWidth = 1;
  for (const xy of g.page.rings) { ringPath(ctx, xy); ctx.fill("evenodd"); ctx.stroke(); }
}

function graticule(ctx, pl, it) {
  const b = it ? it.box : null;
  ctx.strokeStyle = COL.grat; ctx.lineWidth = 1;
  const step = it ? (it.s > 3 ? 1 : 5) : 10;
  const [lo0, la0, lo1, la1] = it ? lonlatBox(it) : [-180, -85, 180, 85];
  for (let lon = Math.ceil(lo0 / step) * step; lon <= lo1; lon += step) {
    const xy = []; for (let lat = la0; lat <= la1; lat += (la1 - la0) / 60) xy.push(...pl.forward(lon, lat)); openPath(ctx, xy);
  }
  for (let lat = Math.ceil(la0 / step) * step; lat <= la1; lat += step) {
    const xy = []; for (let lon = lo0; lon <= lo1; lon += (lo1 - lo0) / 90) xy.push(...pl.forward(lon, lat)); openPath(ctx, xy);
  }
  void b;
}
function lonlatBox(it) {
  const [lon, lat] = it.anchor, span = it.s > 3 ? 4 : it.s > 0.8 ? 15 : 40;
  return [lon - span, Math.max(-89, lat - span), lon + span, Math.min(89, lat + span)];
}
function openPath(ctx, xy) {
  ctx.beginPath();
  let pen = false, lx = 0;
  for (let i = 0; i < xy.length; i += 2) {
    const [x, y] = view.px(xy[i], xy[i + 1]);
    if (!isFinite(x) || !isFinite(y) || (pen && Math.abs(x - lx) > view.w * 0.6)) { pen = false; continue; }
    pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true; lx = x;
  }
  ctx.stroke();
}

const NICE = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
function bar(ctx, x, y, pxPerKm, max, label) {
  const km = [...NICE].reverse().find((k) => k * pxPerKm <= max) || 1, L = km * pxPerKm;
  ctx.strokeStyle = COL.ink; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + L, y); ctx.lineTo(x + L, y - 4); ctx.stroke();
  ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
  halo(ctx, `${km.toLocaleString("en")} km${label ? " " + label : ""}`, x, y - 4);
}
function mainBar(ctx) {
  const pxPerKm = 1000 * view.s;
  bar(ctx, view.w - 170, view.h - 20, pxPerKm, 150, "main frame");
}
function insetBar(ctx, it, p, q, r, t) {
  const pxPerKm = 1000 * view.s * it.s;
  if (r - p < 40) return;
  bar(ctx, p + 6, t - 6, pxPerKm, Math.min(90, (r - p) * 0.5), it.s !== 1 ? `(x${fmtS(it.s)})` : "");
}
const fmtS = (s) => (s >= 1 ? s.toFixed(s >= 10 ? 0 : 1) : s.toFixed(2));

// ---------------------------------------------------------------- readouts

const km = (m) => Math.round(m / 1000).toLocaleString("en");
const pct = (v) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;

function pairPoints(items) {
  const pr = scene().pair;
  if (!pr) return null;
  const A = items.find((x) => x.key === pr.a[3]), B = items.find((x) => x.key === pr.b[3]);
  if (!A || !B) return null;
  return {
    a: A.placer.forward(pr.a[1], pr.a[2]), b: B.placer.forward(pr.b[1], pr.b[2]), na: pr.a[0], nb: pr.b[0],
    split: !!(A.box || B.box) && A !== B, moved: A.mode === "moved" || B.mode === "moved", A, B, pr
  };
}

// the largest angular distortion over a piece, in the projection it is drawn in
let omegaCache = new Map();
function omegaMax(it) {
  const key = `${it.key}|${it.crs.proj}`;
  if (omegaCache.has(key)) return omegaCache.get(key);
  let w = 0;
  const rings = data.pieces[it.key], n = rings.reduce((a, r) => a + r.length / 2, 0), step = Math.max(1, Math.floor(n / 400)) * 2;
  for (const r of rings) for (let i = 0; i < r.length; i += step) {
    const f = I.scaleAt(it.crs, r[i], r[i + 1]);
    if (f) w = Math.max(w, f.omega);
  }
  omegaCache.set(key, w);
  return w;
}

function readouts() {
  if (!data) return;
  const { items, stats } = geometry();
  const rows = [
    ["Sheet", `${km(stats.width)} x ${km(stats.height)} km`],
    ["Share of the sheet that is map", pct(stats.fill)],
    [`${scene().pieces[items[0].key].name} gets`, `${pct(stats.mainShare)} of the sheet's ${stats.width / stats.height > (items[0].page.box[2] - items[0].page.box[0]) / (items[0].page.box[3] - items[0].page.box[1]) ? "width" : "height"}`]
  ];
  const pp = pairPoints(items);
  if (pp) {
    const truth = I.greatCircle(pp.pr.a[1], pp.pr.a[2], pp.pr.b[1], pp.pr.b[2]);
    const onMap = Math.hypot(pp.a[0] - pp.b[0], pp.a[1] - pp.b[1]);
    rows.push([`${pp.na} to ${pp.nb}`, pp.split ? `not on one scale (across a box)<br><span class="hint">${km(truth)} km in fact</span>`
      : `${km(onMap)} km on the map${pp.moved ? " (moved: wrong)" : ""}<br><span class="hint">${km(truth)} km in fact</span>`]);
  }
  $("stats").innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("");

  const head = `<tr><td><b>Piece</b></td><td><b>Drawn</b></td><td><b>Scale</b></td><td><b>Area as drawn</b></td><td><b>Shape</b></td></tr>`;
  const body = items.map((it, k) => {
    const p = stats.pieces[k], w = omegaMax(it);
    return `<tr><td>${scene().pieces[it.key].name}</td><td>${it.mode === "true" ? "true place" : it.mode}</td><td>x${fmtS(p.linear)}</td><td>${pct(p.areal)}</td><td>${w < 1e-3 ? "conformal" : w.toFixed(1) + DEG}</td></tr>`;
  }).join("");
  $("pieces").innerHTML = head + body;
  $("pieces-note").textContent = "Scale and area are against the main frame; shape is the largest angle bent anywhere in the piece, in the projection it is drawn in.";
  if (STEPS[state.s].build || state.edit) exportText(items);
}

function exportText(items) {
  const lines = [`# ${scene().name}: main frame ${state.main === "d3" ? "d3 geoAlbersUsa" : scene().mains[state.main].label}`,
    `# page metres are the main frame's own; X = a x + b y + c, Y = d x + e y + f from each piece's projected x, y`];
  for (const it of items) {
    const A = I.affineOf(it).map((v) => +v.toPrecision(10));
    const ep = it.crs.spec && it.crs.spec.epsg ? `${String(it.crs.spec.epsg).includes(":") ? "" : "EPSG:"}${it.crs.spec.epsg} geometry\t` : "";
    lines.push(`${it.key}\t${it.mode}\t${ep}${it.crs.proj}\t[${A.join(", ")}]`);
  }
  $("export").value = lines.join("\n");
}

// ---------------------------------------------------------------- editor

function buildEditor() {
  const box = $("editor");
  const show = !!(STEPS[state.s].build || state.edit);
  $("build").hidden = !show;
  if (!show || !data) return;
  const items = geometry().items, L = currentLayoutObject();
  const keys = Object.keys(scene().pieces).filter((k) => !scene().pieces[k].main);
  const d3 = state.main === "d3";
  box.innerHTML = keys.map((key) => {
    const v = L[key] || { mode: "true", s: 1, rot: 0 };
    const it = items.find((x) => x.key === key);
    const mode = it ? it.mode : "off";
    return `<div class="piece-row" data-key="${key}">
      <label class="row"><span>${scene().pieces[key].name}</span>
        <select data-k="mode" ${d3 ? "disabled" : ""}>${["true", "inset", "moved", "off"].map((m) => `<option value="${m}" ${m === mode ? "selected" : ""}>${m === "true" ? "true place" : m}</option>`).join("")}</select></label>
      <label class="row"><span>Scale</span><output>x${fmtS(v.s ?? 1)}</output></label>
      <input data-k="s" type="range" min="-3" max="2" step="0.01" value="${Math.log(v.s ?? 1).toFixed(3)}" ${mode === "true" || mode === "off" || (d3 && key !== "alaska") ? "disabled" : ""} aria-label="Scale of ${scene().pieces[key].name}">
      ${mode === "moved" ? `<label class="row"><span>Rotation</span><output>${(v.rot || 0).toFixed(0)}${DEG}</output></label><input data-k="rot" type="range" min="-180" max="180" step="1" value="${v.rot || 0}" aria-label="Rotation of ${scene().pieces[key].name}">` : ""}
    </div>`;
  }).join("");
  for (const row of box.querySelectorAll(".piece-row")) {
    const key = row.dataset.key;
    for (const el of row.querySelectorAll("[data-k]")) {
      el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
        if (state.main === "d3") { if (el.dataset.k === "s") state.aks = Math.exp(+el.value); sync(el.tagName === "SELECT"); return; }
        const L2 = currentLayoutObject(), v = L2[key] || { mode: "true", s: 1, rot: 0 };
        if (el.dataset.k === "mode") {
          v.mode = el.value;
          if ((v.mode === "inset" || v.mode === "moved") && !v.at) {
            // start where it is: its true place, nudged so the box is visible
            v.at = currentMain().forward(...centres[key]);
          }
        } else if (el.dataset.k === "s") v.s = Math.exp(+el.value);
        else v.rot = +el.value;
        L2[key] = v;
        state.L = layoutString(L2);
        sync(el.tagName === "SELECT");
      });
    }
  }
}
function currentLayoutObject() { return parseLayout(state.L); }

// ---------------------------------------------------------------- pointer

let drag = null, dragKey = null;
const pagePoint = (e) => { const r = map.getBoundingClientRect(); return view.pg(e.clientX - r.left, e.clientY - r.top); };
function pieceAt(X, Y) {
  const items = geometry().items;
  for (let k = items.length - 1; k > 0; k--) {
    const it = items[k], b = it.box || it.page.box;
    if (it.mode !== "true" && X >= b[0] && X <= b[2] && Y >= b[1] && Y <= b[3]) return it;
  }
  return null;
}
const editable = () => (STEPS[state.s].build || state.edit) && state.main !== "d3";
map.addEventListener("pointerdown", (e) => {
  if (!view) return;
  const [X, Y] = pagePoint(e), it = editable() ? pieceAt(X, Y) : null;
  drag = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, w: view.w / view.s, piece: it ? it.key : null, at: it ? [...it.at] : null, moved: false };
  dragKey = drag.piece;
  map.setPointerCapture(e.pointerId);
});
map.addEventListener("pointermove", (e) => {
  if (!drag) {
    if (view && editable()) map.style.cursor = pieceAt(...pagePoint(e)) ? "move" : "grab";
    return;
  }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.hypot(dx, dy) > 3) drag.moved = true;
  if (!drag.moved) return;
  if (drag.piece) {
    const L = currentLayoutObject(), v = L[drag.piece];
    v.at = [drag.at[0] + dx / view.s, drag.at[1] - dy / view.s];
    state.L = layoutString(L);
    if (!state.v) state.v = `${(view.cx / 1000).toFixed(1)},${(view.cy / 1000).toFixed(1)},${(view.w / view.s / 1000).toFixed(0)}`;
  } else {
    state.v = `${((drag.cx - dx / view.s) / 1000).toFixed(1)},${((drag.cy + dy / view.s) / 1000).toFixed(1)},${(drag.w / 1000).toFixed(0)}`;
  }
  draw();
});
map.addEventListener("pointerup", () => { if (drag && drag.moved) sync(); drag = null; dragKey = null; draw(); });
map.addEventListener("wheel", (e) => {
  if (!view) return;
  e.preventDefault();
  const r = map.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const f = Math.exp(e.deltaY * 0.0015), [X, Y] = view.pg(mx, my), s = view.s / f;
  const cx = X - (mx - view.w / 2) / s, cy = Y + (my - view.h / 2) / s;
  state.v = `${(cx / 1000).toFixed(1)},${(cy / 1000).toFixed(1)},${(view.w / s / 1000).toFixed(0)}`;
  sync();
}, { passive: false });

// ---------------------------------------------------------------- UI

const sceneSel = $("scene"), mainSel = $("main");
for (const k of SCENE_KEYS) sceneSel.add(new Option(I.SCENES[k].name, k));
function fillMains() {
  mainSel.innerHTML = "";
  if (state.scene === "usa") mainSel.add(new Option("d3 geoAlbersUsa (composite)", "d3"));
  for (const [k, m] of Object.entries(scene().mains)) mainSel.add(new Option(m.label, k));
  mainSel.value = state.main;
}
sceneSel.addEventListener("change", () => {
  state.scene = sceneSel.value; state.main = scene().main; state.v = "";
  // the first step that shows this scene gives its layout
  const st = STEPS.find((x) => x.set.scene === state.scene && x.set.main !== "d3");
  state.L = st ? layoutString(resolveLayout(st.set.layout)) : "";
  state.edit = 1;
  sync(true);
});
mainSel.addEventListener("change", () => {
  const was = currentMain(), L = currentLayoutObject();
  // keep each inset where it is on the page: its centre's lon/lat goes with it
  const lls = Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.at && state.main !== "d3" ? was.inverse(...v.at) : null]));
  state.main = mainSel.value; state.v = "";
  if (state.main !== "d3") {
    const g = currentMain();
    for (const [k, v] of Object.entries(L)) if (lls[k]) v.at = g.forward(...lls[k]);
    if (!state.L) state.L = layoutString(resolveLayout(US_INSETS));
    else state.L = layoutString(L);
  }
  state.edit = 1;
  sync(true);
});
for (const k of ["tp", "outline", "leader", "ctx", "grat", "names"]) $(k).addEventListener("change", (e) => { state[k] = e.target.checked ? 1 : 0; sync(); });
$("reset-view").addEventListener("click", () => { state.v = ""; sync(); });
$("copy-export").addEventListener("click", (e) => {
  navigator.clipboard?.writeText($("export").value).then(() => { e.target.textContent = "Copied"; setTimeout(() => { e.target.textContent = "Copy layout"; }, 1200); });
});

STEPS.forEach((st, k) => {
  const li = document.createElement("li");
  li.textContent = st.title;
  li.addEventListener("click", () => goStep(k));
  $("steps").appendChild(li);
});
function goStep(k) {
  state.s = Math.max(0, Math.min(STEPS.length - 1, k));
  const st = STEPS[state.s].set;
  state.scene = st.scene; state.main = st.main; state.aks = st.aks ?? 0.35; state.v = ""; state.edit = 0; state.tp = 0;
  state.outline = st.outline ?? 0;
  state.L = st.main === "d3" ? "" : layoutString(resolveLayout(st.layout));
  sync(true);
}
$("prev").addEventListener("click", () => goStep(state.s - 1));
$("next").addEventListener("click", () => goStep(state.s + 1));
function syncStep() {
  const st = STEPS[state.s];
  $("step-title").textContent = st.title;
  $("caption").textContent = st.text;
  $("count").textContent = `${state.s + 1} of ${STEPS.length}`;
  $("prev").disabled = state.s === 0;
  $("next").disabled = state.s === STEPS.length - 1;
  [...$("steps").children].forEach((li, k) => li.classList.toggle("active", k === state.s));
  $("aks-row").hidden = state.main !== "d3";
  $("aks").value = Math.log(state.aks).toFixed(3);
  $("aks-out").textContent = `x${state.aks.toFixed(2)} (${(state.aks * state.aks * 100).toFixed(0)}% of its area)`;
}
$("aks").addEventListener("input", (e) => { state.aks = Math.exp(+e.target.value); sync(); });

function sync(rebuild = false) {
  sceneSel.value = state.scene; fillMains();
  for (const k of ["tp", "outline", "leader", "ctx", "grat", "names"]) $(k).checked = !!state[k];
  syncStep();
  draw(); readouts();
  if (rebuild || !$("editor").children.length) buildEditor();
  else updateEditorOutputs();
  writeHash();
}
function updateEditorOutputs() {
  if ($("build").hidden) return;
  const L = currentLayoutObject();
  for (const row of $("editor").querySelectorAll(".piece-row")) {
    const v = state.main === "d3" ? { s: row.dataset.key === "alaska" ? state.aks : 1 } : L[row.dataset.key] || { s: 1 };
    const outs = row.querySelectorAll("output");
    if (outs[0]) outs[0].textContent = `x${fmtS(v.s ?? 1)}`;
    if (outs[1]) outs[1].textContent = `${(v.rot || 0).toFixed(0)}${DEG}`;
  }
}

// a link with only a step (or nothing) starts on that step's settings
function bareStep() {
  const h0 = new URLSearchParams(location.hash.replace(/^#/, ""));
  if (h0.has("scene") || h0.has("main")) return;
  const st = STEPS[state.s].set;
  Object.assign(state, { scene: st.scene, main: st.main, aks: st.aks ?? 0.35, outline: st.outline ?? state.outline });
  if (data && st.main !== "d3") state.L = layoutString(resolveLayout(st.layout));
}
bareStep();
window.addEventListener("hashchange", () => { readHash(); bareStep(); sync(true); });
new ResizeObserver(() => { if (view) draw(); }).observe(map.parentElement);
shareLinks("playproj: Insets", { height: 620 });

sync(true);
fetch(new URL("../data/insets-10m.json", import.meta.url))
  .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
  .then((d) => {
    data = d;
    for (const [k, rings] of Object.entries(d.pieces)) { centres[k] = I.centreOf(rings); grounds[k] = I.groundArea(rings, centres[k]); }
    geomKey = "";
    // a link with a step but no layout takes the step's
    if (!state.L && state.main !== "d3") state.L = layoutString(resolveLayout(STEPS[state.s].set.layout));
    sync(true);
  })
  .catch((e) => { $("stats").innerHTML = `<tr><td>The coastlines did not load (${e.message}).</td></tr>`; });
