// A section and a block diagram through Antarctic ice: where a line runs,
// the ice surface, the ice base, the bed and the sea, from Bedmap3 (ice
// thickness, bed and surface elevation, and the grounding mask), with REMA's
// surface and GEBCO's elevation beside it. Everything here is pure: the
// sources, the geometry of the line and the block in EPSG:3031 metres, the
// choice of pyramid level, and the layering of each sample into ice, water
// and rock. js/cutaway-page.js reads the COGs and draws.

import { chooseLevel, windowOf, sample } from "./mosaic.js";

export { sample };

const BEDMAP = "https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/ausantarctic/bedmap/bedmap3/cog/";
const REMA = "https://media.githubusercontent.com/media/mdsumner/rema-ovr/main/";

// Where each source lives, named once. Bedmap3 is one COG per array on one
// 500 m grid (EPSG:3031, int16, nodata -9999); REMA is three mosaics at
// 100 m, 500 m and 1 km (EPSG:3031, ellipsoidal heights); GEBCO 2026 is
// one global COG in longitude and latitude with its own overviews.
export const SOURCES = {
  bedmap: {
    label: "Bedmap3",
    arrays: ["surface_topography", "ice_thickness", "bed_topography", "mask", "bed_uncertainty"],
    url: (a) => `${BEDMAP}${a}.tif`,
    nodata: -9999,
    credit: "Bedmap3: Pritchard et al. (2025), UK Polar Data Centre, CC BY 4.0, a cloud-optimised copy on source.coop"
  },
  rema: {
    label: "REMA v2",
    // finest first; each file is one level
    files: ["rema_mosaic_100m_v2.0_filled_cop30_dem_int16.tif", "rema_mosaic_500m_v2.0_filled_cop30_dem.tif", "rema_mosaic_1km_v2.0_filled_cop30_dem.tif"].map((f) => REMA + f),
    nodata: -9999,
    credit: "REMA v2 (Howat et al. 2022, PGC), mosaics from the rema-ovr repository"
  },
  gebco: {
    label: "GEBCO 2026",
    url: "https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/ausantarctic/gebco/GEBCO_2026.tif",
    nodata: -32767,
    credit: "GEBCO Compilation Group (2026) GEBCO 2026 Grid, on source.coop"
  }
};

// Lines worth a look, as two longitude, latitude ends, sea end first; a
// line may also bring its own block width (km), side (1 left, -1 right, 0
// both, with the ice taken off the right) and shape (flat or earth).
export const PRESETS = [
  { key: "amery", label: "Amery Ice Shelf to the Lambert Glacier", a: [73, -67.5], b: [68.5, -73.5] },
  { key: "totten", label: "Totten Glacier", a: [115.6, -65.9], b: [117.2, -68.6] },
  { key: "thwaites", label: "Thwaites Glacier", a: [-105.6, -74.0], b: [-108.6, -76.6] },
  { key: "ross", label: "Ross Ice Shelf to the Siple Coast", a: [178, -77.6], b: [-150, -83.6] },
  { key: "pig", label: "Pine Island Glacier", a: [-101.8, -74.6], b: [-97.5, -75.6] },
  { key: "dome", label: "Prydz Bay to Dome A", a: [76, -68.6], b: [77.4, -80.4] },
  { key: "dcn", label: "Through Dome C North towards Dome C", a: [117.29, -76.64], b: [126.86, -73.94], w: 200, site: "dcn" },
  { key: "continent", label: "Across the continent, ice off one side", a: [-174, -54], b: [53, -56], w: 2800, side: 0, curve: "earth", site: "dcn" }
];

// Places to drill: a vertical line from the bed to the surface, with the
// ice there read at Bedmap3's full resolution.
export const SITES = [
  { key: "dcn", label: "Dome C North (million year ice core)", ll: [122.5206, -75.3413] },
  { key: "ldc", label: "Little Dome C (Beyond EPICA), as drawn in capvis", ll: [122.59185, -75.28015] },
  { key: "domec", label: "Dome C (EPICA, Concordia)", ll: [123.35, -75.1] },
  { key: "domea", label: "Dome A (Kunlun)", ll: [77.37, -80.37] },
  { key: "dss", label: "Law Dome (DSS)", ll: [112.8, -66.77] }
];

// A point's place in the line's frame: s metres along from a, t metres off
// to the left.
export function frameOf(f, p) {
  const dx = p[0] - f.a[0], dy = p[1] - f.a[1];
  return { s: dx * f.ux + dy * f.uy, t: dx * f.nx + dy * f.ny };
}

// The Earth's mean radius (m), for the curved block.
export const R = 6371008.8;

// A point of the block (s, t metres in the line's frame, h exaggerated
// metres up) in the scene, in km: x along the line, y up, z off it (the
// left side towards -z). Flat, or bent over a sphere about the block's
// centre (cs, ct): the plane distance from the centre is laid out as an arc
// (azimuthal equidistant about the centre, read backwards), so a block the
// size of the continent shows the Earth's curve as well as its relief.
export function place(s, t, h, { curve = false, cs = 0, ct = 0 } = {}) {
  if (!curve) return [s / 1000, h / 1000, -t / 1000];
  const u = s - cs, v = t - ct, d = Math.hypot(u, v), th = d / R, r = R + h;
  const k = d > 0 ? (r * Math.sin(th)) / d : 1;
  return [(cs + u * k) / 1000, (r * Math.cos(th) - R) / 1000, -(ct + v * k) / 1000];
}

// The line from a to b (EPSG:3031 metres): its length, the unit vector
// along it and the unit normal to its left.
export function lineFrame(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L;
  return { a, b, L, ux, uy, nx: -uy, ny: ux };
}

// A point of the block in the line's own frame: s metres along the line
// from a, t metres off it (positive to the left).
export const at = (f, s, t) => [f.a[0] + f.ux * s + f.nx * t, f.a[1] + f.uy * s + f.ny * t];

// The block: the line, and width metres to one side of it (side 1 is the
// left of a to b, -1 the right, 0 both sides). Corners in order, the
// bounding box [xmin, ymin, xmax, ymax], and t0, t1, its span off the line.
export function blockOf(f, width, side = 1) {
  const t0 = side === 0 ? -width : 0, t1 = side === 0 ? width : width * side;
  const c = [at(f, 0, t0), at(f, f.L, t0), at(f, f.L, t1), at(f, 0, t1)];
  const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
  return { corners: c, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], width, side, t0, t1 };
}

// n + 1 points evenly from a to b, with their distance along the line.
export function samplesAlong(f, n) {
  const out = [];
  for (let i = 0; i <= n; i++) { const s = (f.L * i) / n; out.push({ s, p: at(f, s, 0) }); }
  return out;
}

// The pyramid of a COG (or of several files, one level each), finest
// first, as { x0, y0, res, width, height }, from the full grid's origin,
// pixel size and shape and each level's shape.
export function levelsOf(x0, y0, res, shapes) {
  const W = shapes[0][0];
  return shapes.map(([width, height]) => ({ x0, y0, res: (res * W) / width, width, height }));
}

// Which level to read for pixels px across over a box, and the window of
// it: no finer than px, and no more than max pixels on a side.
export function plan(levels, box, px, max = 1600) {
  const k = chooseLevel(levels, px, box[2] - box[0], box[3] - box[1], max);
  return { k, level: levels[k], win: windowOf(levels[k], box, 3) };
}

// A read window as the sampler wants it.
export function windowGrid(level, win, data, nodata) {
  return { data, width: win[2] - win[0], height: win[3] - win[1], x0: level.x0 + win[0] * level.res, y0: level.y0 - win[1] * level.res, dx: level.res, dy: level.res, nodata };
}

// The longitude, latitude boxes [w, s, e, n] that hold a set of points: one,
// or two either side of the antimeridian when the points cross it (the
// smaller of the two ways round). A line near the pole may still need most
// of the longitudes.
export function lonBoxes(lons, lats) {
  const s = Math.min(...lats), n = Math.max(...lats);
  const w = Math.min(...lons), e = Math.max(...lons);
  const shifted = lons.map((x) => (x < 0 ? x + 360 : x));
  const w2 = Math.min(...shifted), e2 = Math.max(...shifted);
  if (e - w <= e2 - w2) return [[w, s, e, n]];
  return [[w2, s, 180, n], [-180, s, e2 - 360, n]].filter((b) => b[2] > b[0]);
}

// Bedmap3's mask codes.
export const MASK = { 1: "grounded ice", 2: "transiently grounded ice shelf", 3: "floating ice shelf", 4: "rock" };

// One sample as layers (metres above the geoid, as Bedmap3 gives them):
// surface (the top: the ice or rock surface, or 0 over the open sea), base
// (the ice base; equal to surface where there is no ice), bed, and the
// water between waterTop and bed (null where there is none). s, h, b are
// surface, thickness and bed (NaN for nodata), m the mask (NaN off it).
// Over the open sea Bedmap3 has no surface, thickness or mask, only bed.
export function layer(s, h, b, m) {
  const ice = h === h && h > 0 ? h : 0;
  let kind;
  if (m === 4) kind = "rock";
  else if (m === 1) kind = "grounded";
  else if (m === 2 || m === 3) kind = "floating";
  else if (ice > 0) kind = s - ice > b + 1 ? "floating" : "grounded";
  else if (s === s && s > 0) kind = "rock";
  else kind = b === b ? (b < 0 ? "sea" : "land") : "none";
  const top = s === s ? s : kind === "sea" ? 0 : NaN;
  let base = top - ice;
  // grounded ice sits on its bed; the grids disagree by metres here and there
  if (kind === "grounded" && b === b) base = b;
  if (kind === "rock" || kind === "land") base = top;
  let water = null;
  if (b === b && b < 0) {
    if (kind === "sea") water = [0, b];
    else if (kind === "floating" && base > b) water = [base, b];
  }
  return { kind, top, base, bed: b, ice, water };
}

// A height in the block for drawing: metres to the scene's units (km) with
// the vertical exaggeration.
export const zOf = (m, ve) => (m * ve) / 1000;

// A sample with its ice taken off, as on the bare side of a block: the bed
// stands bare where the ice was (no sea floods it and the bed does not
// rebound), the open sea stays as it is.
export function bare(l) {
  if (l.kind === "sea" || l.bed !== l.bed) return l;
  const top = l.ice > 0 ? l.bed : l.top;
  return { kind: "bare", top, base: top, bed: l.bed, ice: 0, water: null, wasIce: l.ice > 0 };
}

// The heights of the three bands at one sample, bottom up, for drawing:
// rock from the floor to the bed, water from the bed to the water's top
// (the ice base or the sea surface; the bed itself where there is none),
// ice from its base to its top (both at the water's top where there is
// none). Bands of no thickness keep a run of samples unbroken across a
// grounding line or a calving front. null where the bed is unknown.
export function stack(l, floor) {
  if (l.bed !== l.bed) return null;
  const wtop = l.water ? l.water[0] : l.bed;
  const ice = l.ice > 0 && l.top === l.top ? [l.base, l.top] : [Math.max(wtop, l.top === l.top ? l.top : wtop), Math.max(wtop, l.top === l.top ? l.top : wtop)];
  // rock above the sea with no ice on it rises to its surface
  const rockTop = l.ice > 0 || l.water || l.top !== l.top ? l.bed : Math.max(l.bed, l.top);
  return { rock: [floor, rockTop], water: [rockTop, Math.max(rockTop, wtop)], ice };
}

// The nearest cell's value (for a categorical grid such as the mask), or
// NaN off the window or at nodata.
export function nearest(win, x, y) {
  if (!win) return NaN;
  const { data, width: W, height: H, x0, y0, dx, dy, nodata } = win;
  const i = Math.floor((x - x0) / dx), j = Math.floor((y0 - y) / dy);
  if (i < 0 || j < 0 || i >= W || j >= H) return NaN;
  const v = data[j * W + i];
  return v === nodata || !Number.isFinite(v) ? NaN : v;
}

// The lowest bed along a set of layers, less a margin, for the floor of the
// block and of the section (a round number of hundreds of metres).
export function floorOf(ls, margin = 300) {
  let lo = 0;
  for (const l of ls) if (l.bed === l.bed && l.bed < lo) lo = l.bed;
  return Math.floor((lo - margin) / 100) * 100;
}

// Summary of a section: lengths of floating and grounded ice along it, its
// thickest ice, deepest bed and thickest cavity, and where the grounding
// line crossings fall (distances where floating turns grounded or back).
export function summary(rows) {
  const out = { floating: 0, grounded: 0, sea: 0, maxIce: 0, minBed: Infinity, maxCavity: 0, grounding: [] };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], l = r.l, ds = i ? r.s - rows[i - 1].s : 0;
    if (l.kind === "floating") out.floating += ds; else if (l.kind === "grounded") out.grounded += ds; else if (l.kind === "sea") out.sea += ds;
    if (l.ice > out.maxIce) out.maxIce = l.ice;
    if (l.bed < out.minBed) out.minBed = l.bed;
    if (l.kind === "floating" && l.water) out.maxCavity = Math.max(out.maxCavity, l.water[0] - l.water[1]);
    if (i && (rows[i - 1].l.kind === "floating") !== (l.kind === "floating") && (l.kind === "grounded" || rows[i - 1].l.kind === "grounded")) out.grounding.push((r.s + rows[i - 1].s) / 2);
  }
  return out;
}

// A good vertical exaggeration for a line L metres long over a relief of
// dz metres: the relief about a sixth of the length, as a round number.
export function autoExaggeration(L, dz) {
  const v = L / 6 / Math.max(dz, 100);
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
  let best = steps[0];
  for (const s of steps) if (s <= v * 1.2) best = s;
  return best;
}
