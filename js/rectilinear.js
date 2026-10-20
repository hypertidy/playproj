// playproj: rectilinear chunks
//
// An array cut into chunks (left, in 3D) and the cuts along its first axis
// or across a mosaic (right, in 2D), for a regular chunk grid and a
// rectilinear one: the last chunk of a regular grid, days in months, days
// in years of files, and mosaics of uneven, staggered or overlapping
// tiles. A selection shows which chunks a read touches. The grids are
// src/core/chunkgrid.js.

import * as THREE from "three";
import * as G from "../src/core/chunkgrid.js";
import { makeStage, readParams, hashWriter, shareLinks, oneOf } from "../src/scene/index.js";

const $ = (id) => document.getElementById(id);

const C = {
  bg: 0x05070d, a: 0x2b5487, b: 0x3d6ea8, hit: 0xffd34d, want: 0xffb347, pad: 0x8a97ab, file: 0xff7a59, lap: 0xe0566b, hole: 0x1a2236,
  aCss: "#2b5487", bCss: "#3d6ea8", hitCss: "#ffd34d", wantCss: "rgba(255,179,71,0.9)", padCss: "rgba(138,151,171,0.35)",
  fileCss: "#ff7a59", lapCss: "#e0566b", ink: "#dfe7f2", muted: "#8a97ab", line: "#1f2a40",
  tiles: ["#4f8fd6", "#6ab787", "#c98bd8", "#e0a458", "#5fc4c0", "#d6736b", "#9aa7ff", "#c2c96a"]
};

// ---------------------------------------------------------------- cases

// Time cases: an array of days x rows x columns, its time axis cut by a
// regular chunk size or by the calendar (or by the files it came from).
const SPACE = [60, 120], SPACE_CHUNK = [30, 60];
function timeCase({ y0, y1, by, label, regular }) {
  const cal = by === "month" ? G.months(y0, y1) : G.years(y0, y1);
  const n = cal.sizes.reduce((a, b) => a + b, 0);
  const filesLabel = by === "month" ? "Files, one a month" : "Files, one a year";
  return { kind: "time", label, y0, files: cal, filesLabel, n, rect: () => cal.sizes, regular, unit: "day" };
}
const CASES = {
  edge: { kind: "time", label: "The last chunk", n: 100, files: null, rect: (c) => G.regularAxis(100, c), regular: 30, unit: "step" },
  months: timeCase({ y0: 2023, y1: 2024, by: "month", label: "Days in months", regular: 30 }),
  years: timeCase({ y0: 2019, y1: 2024, by: "year", label: "Years of daily files", regular: 365 }),
  uneven: {
    kind: "mosaic", label: "Uneven tiles",
    rects: grid2([0, 100, 160, 240], [0, 50, 80])
  },
  brick: {
    kind: "mosaic", label: "Staggered tiles",
    rects: [[0, 100, 0, 40], [100, 200, 0, 40], [0, 50, 40, 80], [50, 150, 40, 80], [150, 200, 40, 80], [0, 100, 80, 120], [100, 200, 80, 120]].map(rc)
  },
  overlap: {
    kind: "mosaic", label: "Overlapping scenes",
    rects: [[0, 110, 0, 66], [96, 206, 0, 66], [0, 110, 58, 124], [96, 206, 58, 124]].map(rc)
  },
  custom: null
};
function rc([x0, x1, y0, y1]) { return { x0, x1, y0, y1 }; }
function grid2(xs, ys) {
  const out = [];
  for (let j = 0; j + 1 < ys.length; j++) for (let i = 0; i + 1 < xs.length; i++) out.push(rc([xs[i], xs[i + 1], ys[j], ys[j + 1]]));
  return out;
}
const CASE_KEYS = Object.keys(CASES);

// ---------------------------------------------------------------- state

const defaults = { case: "months", grid: "rect", c: 30, a: 396, w: 29, where: "map", ex: 0.35, cam: null };
const state = { ...defaults };
function readHash() {
  readParams(state, defaults, {
    case: oneOf(CASE_KEYS, "months"), grid: oneOf(["reg", "rect"], "rect"), where: oneOf(["map", "pixel"], "map")
  });
  if (state.case === "custom" && !CASES.custom) state.case = "months";
  state.ex = Math.max(0, Math.min(1, state.ex));
  clampSel();
}
const cur = () => CASES[state.case];
function clampSel() {
  const k = CASES[state.case];
  if (!k || k.kind !== "time") return;
  state.c = Math.round(Math.max(1, Math.min(k.n, state.c)));
  state.w = Math.round(Math.max(1, Math.min(k.n, state.w)));
  state.a = Math.round(Math.max(0, Math.min(k.n - state.w, state.a)));
}
readHash();
const writeHash = hashWriter(state, defaults, { digits: 3 });

// The two grids of a time case: regular c along time, the case's own
// sizes for rectilinear, and the same spatial chunks for both.
function timeGrids(k) {
  const sp = k.space || SPACE, spc = k.spaceChunk || SPACE_CHUNK;
  const shape = [k.n, ...sp];
  const spaceAxes = k.spaceAxes || sp.map((n, d) => G.regularAxis(n, spc[d]));
  return {
    reg: G.grid(shape, [G.regularAxis(k.n, state.c), ...spaceAxes]),
    rect: G.grid(shape, [k.rect(state.c), ...spaceAxes])
  };
}
let grids = null, report = null;
function solve() {
  const k = cur();
  if (k.kind === "time") { grids = timeGrids(k); report = null; }
  else { grids = null; report = G.mosaicReport(k.rects); }
}

// ---------------------------------------------------------------- 3D

const stage = $("three");
const { renderer, scene, camera, controls, setCamera, resize } = makeStage(stage, {
  bg: C.bg, fov: 34, far: 200,
  onCamera: (c) => { state.cam = c; writeHash(); }
});
controls.minDistance = 2;
controls.maxDistance = 60;
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(1, 2, 1.5);
camera.add(sun);
scene.add(camera);

const group = new THREE.Group();
scene.add(group);
const BOX = new THREE.BoxGeometry(1, 1, 1);
const EDGES = new THREE.EdgesGeometry(BOX);
const mats = new Map();
function mat(color, opacity = 1) {
  const key = `${color}/${opacity}`;
  if (!mats.has(key)) mats.set(key, new THREE.MeshLambertMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }));
  return mats.get(key);
}
const lineMats = new Map();
function lineMat(color, opacity = 1) {
  const key = `${color}/${opacity}`;
  if (!lineMats.has(key)) lineMats.set(key, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
  return lineMats.get(key);
}
function box(x0, x1, y0, y1, z0, z1, m, edge) {
  const mesh = new THREE.Mesh(BOX, m);
  mesh.scale.set(Math.max(1e-4, x1 - x0), Math.max(1e-4, y1 - y0), Math.max(1e-4, z1 - z0));
  mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  group.add(mesh);
  if (edge) {
    const l = new THREE.LineSegments(EDGES, edge);
    l.scale.copy(mesh.scale); l.position.copy(mesh.position);
    group.add(l);
  }
  return mesh;
}
function clearGroup() {
  for (const o of [...group.children]) group.remove(o);
}

// world size of the drawing: time along x, rows up (y), columns along z
let world = { X: 9, Y: 2.2, Z: 4.4 };
const MAX_BOXES = 6000;

// position of index i along axis d of grid g, with a gap between chunks
function place(g, d, i, len, gap) {
  const off = g.off[d], n = off[off.length - 1];
  let k = G.locate(off, Math.min(i, n - 1));
  if (i >= n) k = off.length - 2;
  return (i / n) * len + k * gap;
}

function buildTime() {
  const k = cur(), g = state.grid === "reg" ? grids.reg : grids.rect;
  const L = [world.X, world.Y, world.Z];
  const gap = state.ex * 0.25;
  const n = g.shape;
  const span = (d) => L[d] + (g.axes[d].length - 1) * gap;
  const ox = -span(0) / 2, oy = 0, oz = -span(2) / 2;
  const sel = selection(g);
  const cost = G.readCost(g, sel);
  const count = G.chunkCount(g);
  const pos = (d, i) => place(g, d, i, L[d], gap);
  const regC = state.grid === "reg" ? state.c : null;

  if (count > MAX_BOXES) {
    $("note3d").textContent = `${count} chunks: too many to draw one by one, so only the outline is shown.`;
    box(ox, ox + span(0), oy, oy + span(1), oz, oz + span(2), mat(C.a, 0.4), lineMat(0x8a97ab));
    return;
  }
  $("note3d").textContent = "";
  const offs = g.off;
  for (let i = 0; i < g.axes[0].length; i++) for (let j = 0; j < g.axes[1].length; j++) for (let l = 0; l < g.axes[2].length; l++) {
    const x0 = ox + pos(0, offs[0][i]), x1 = x0 + (g.axes[0][i] / n[0]) * L[0];
    const y0 = oy + pos(1, offs[1][j]), y1 = y0 + (g.axes[1][j] / n[1]) * L[1];
    const z0 = oz + pos(2, offs[2][l]), z1 = z0 + (g.axes[2][l] / n[2]) * L[2];
    const hit = cost.spans && i >= cost.spans[0][0] && i <= cost.spans[0][1] && j >= cost.spans[1][0] && j <= cost.spans[1][1] && l >= cost.spans[2][0] && l <= cost.spans[2][1];
    const base = (i + j + l) % 2 ? C.b : C.a;
    box(x0, x1, y0, y1, z0, z1, hit ? mat(C.hit, 0.55) : mat(base, 0.92), lineMat(hit ? C.hit : 0x05070d, hit ? 1 : 0.6));
    // the padding a regular edge chunk is stored with, past the end of the array
    if (regC && i === g.axes[0].length - 1 && g.axes[0][i] < regC) {
      const xp = x1 + ((regC - g.axes[0][i]) / n[0]) * L[0];
      box(x1, xp, y0, y1, z0, z1, mat(C.pad, 0.12), lineMat(C.pad, 0.5));
    }
  }
  // the part of the touched chunks the read wants
  if (cost.spans) {
    const [a, b] = sel[0], [ya, yb] = sel[1], [za, zb] = sel[2];
    for (let i = cost.spans[0][0]; i <= cost.spans[0][1]; i++) for (let j = cost.spans[1][0]; j <= cost.spans[1][1]; j++) for (let l = cost.spans[2][0]; l <= cost.spans[2][1]; l++) {
      const lo = (d, v, kk) => Math.max(v, offs[d][kk]), hi = (d, v, kk) => Math.min(v, offs[d][kk + 1]);
      const seg = (d, va, vb, kk, o) => {
        const s = lo(d, va, kk), e = hi(d, vb, kk);
        const p0 = o + pos(d, offs[d][kk]) + ((s - offs[d][kk]) / n[d]) * L[d];
        return [p0, p0 + ((e - s) / n[d]) * L[d]];
      };
      const [x0, x1] = seg(0, a, b, i, ox), [y0, y1] = seg(1, ya, yb, j, oy), [z0, z1] = seg(2, za, zb, l, oz);
      const e = 0.004;
      box(x0 - e, x1 + e, y0 - e, y1 + e, z0 - e, z1 + e, mat(C.want, 1), null);
    }
  }
  // file boundaries, where the case has files
  if (k.files) {
    const fo = G.offsets(k.files.sizes);
    const pts = [];
    for (const f of fo) {
      let x = ox + pos(0, Math.min(f, n[0]));
      const kk = G.locate(offs[0], f);
      if (f > 0 && kk >= 0 && offs[0][kk] === f) x -= gap / 2;
      if (f >= n[0]) x = ox + span(0);
      const y0 = oy - 0.02, y1 = oy + span(1) + 0.02, z0 = oz - 0.02, z1 = oz + span(2) + 0.02;
      pts.push(x, y0, z0, x, y1, z0, x, y1, z0, x, y1, z1, x, y1, z1, x, y0, z1, x, y0, z1, x, y0, z0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    group.add(new THREE.LineSegments(geo, lineMat(C.file, 0.9)));
  }
}

function buildMosaic() {
  const k = cur(), m = report.grid;
  const W = m.xs[m.xs.length - 1] - m.xs[0], H = m.ys[m.ys.length - 1] - m.ys[0];
  const s = 8 / Math.max(W, H);
  const gap = state.ex * 0.25;
  const ncol = m.cols.length, nrow = m.rows.length;
  const ox = -(W * s + (ncol - 1) * gap) / 2, oz = -(H * s + (nrow - 1) * gap) / 2;
  const xAt = (x) => { const i = Math.max(0, m.xs.indexOf(x)); return ox + (x - m.xs[0]) * s + Math.min(i, ncol) * gap - (i > 0 && i <= ncol - 1 ? gap / 2 : 0) - (i === ncol ? gap : 0); };
  const zAt = (y) => { const j = Math.max(0, m.ys.indexOf(y)); return oz + (y - m.ys[0]) * s + Math.min(j, nrow) * gap - (j > 0 && j <= nrow - 1 ? gap / 2 : 0) - (j === nrow ? gap : 0); };
  const tileColor = (t) => new THREE.Color(C.tiles[t % C.tiles.length]).getHex();
  if (state.grid === "rect") {
    // the rectilinear grid of every edge: one box per chunk, coloured by the tile that fills it
    for (let j = 0; j < nrow; j++) for (let i = 0; i < ncol; i++) {
      const own = report.owners[j * ncol + i];
      const x0 = ox + (m.xs[i] - m.xs[0]) * s + i * gap, x1 = x0 + m.cols[i] * s;
      const z0 = oz + (m.ys[j] - m.ys[0]) * s + j * gap, z1 = z0 + m.rows[j] * s;
      const h = own.length > 1 ? 0.5 : own.length ? 0.25 : 0.04;
      const col = own.length > 1 ? C.lap : own.length ? tileColor(own[0]) : C.hole;
      box(x0, x1, 0, h, z0, z1, mat(col, own.length ? 0.95 : 0.5), lineMat(0x05070d, 0.7));
    }
  } else {
    // the files: each tile a slab, later ones stacked on earlier where they overlap
    k.rects.forEach((r, t) => {
      const y0 = t * 0.08 * (report.overlapCells ? 1 : 0), y1 = y0 + 0.25;
      box(xAt(r.x0), xAt(r.x1), y0, y1, zAt(r.y0), zAt(r.y1), mat(tileColor(t), 0.85), lineMat(0xdfe7f2, 0.8));
    });
  }
}

// a half-open selection on each axis of a time grid
function selection(g) {
  const sel = [[state.a, state.a + state.w]];
  for (let d = 1; d < g.shape.length; d++) {
    if (state.where === "map") sel.push([0, g.shape[d]]);
    else { const p = Math.floor(g.shape[d] * 0.62); sel.push([p, p + 1]); }
  }
  return sel;
}

function build() {
  clearGroup();
  if (cur().kind === "time") buildTime(); else { $("note3d").textContent = ""; buildMosaic(); }
}

function defaultCam() {
  // far enough back to see the whole drawing, from above and to one side
  const b = new THREE.Box3().setFromObject(group), c = b.getCenter(new THREE.Vector3());
  const R = 0.5 * b.getSize(new THREE.Vector3()).length() || 5;
  const vf = (camera.fov * Math.PI) / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
  const d = R / Math.sin(Math.min(vf, hf) / 2) * 1.12;
  const v = cur().kind === "time" ? new THREE.Vector3(0.35, 0.55, 0.76) : new THREE.Vector3(0.12, 0.85, 0.52);
  v.normalize().multiplyScalar(d).add(c);
  return [v.x, v.y, v.z, c.x, c.y, c.z];
}

// ---------------------------------------------------------------- 2D

const cv = $("axis");
let frame = null;
function sizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2), r = cv.getBoundingClientRect();
  const w = Math.max(10, r.width), h = Math.max(10, r.height);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  return { w, h, dpr };
}

function draw2d() {
  const f = sizeCanvas(), g = cv.getContext("2d");
  g.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
  g.fillStyle = "#05070d"; g.fillRect(0, 0, f.w, f.h);
  g.font = "12px system-ui, sans-serif"; g.textBaseline = "middle";
  if (cur().kind === "time") drawAxes(g, f); else drawMosaic(g, f);
}

// three bands along time: the files or calendar, the regular cuts and the rectilinear ones
function drawAxes(g, f) {
  const k = cur(), n = k.n;
  const regOver = Math.ceil(n / state.c) * state.c;
  const left = 16, right = f.w - 16;
  const sx = (right - left) / Math.max(n, regOver);
  const X = (i) => left + i * sx;
  const bandH = Math.min(46, (f.h - 120) / 3.6);
  const top = Math.max(40, f.h / 2 - bandH * 2.2);
  const rows = [
    { y: top, label: k.filesLabel || `The array, ${n} ${k.unit}s` },
    { y: top + bandH * 1.5, label: `Regular, every ${state.c} ${k.unit}s`, grid: grids.reg, reg: true },
    { y: top + bandH * 3, label: k === CASES.edge ? "Rectilinear, the same cuts" : "Rectilinear, the case's own sizes", grid: grids.rect }
  ];
  frame = { X, sx, left, n, rows, bandH, kind: "time" };
  // selection
  const sa = X(state.a), sb = X(state.a + state.w);
  g.fillStyle = "rgba(255,211,77,0.08)"; g.fillRect(sa, top - 22, sb - sa, bandH * 4.3);
  g.strokeStyle = "rgba(255,211,77,0.6)"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(sa + 0.5, top - 22); g.lineTo(sa + 0.5, top + bandH * 4.1); g.moveTo(sb - 0.5, top - 22); g.lineTo(sb - 0.5, top + bandH * 4.1); g.stroke();
  g.fillStyle = C.hitCss; g.textAlign = "center";
  g.fillText(`read ${selLabel()}`, Math.min(right - 70, Math.max(left + 70, (sa + sb) / 2)), top - 30);

  for (const r of rows) {
    g.fillStyle = C.muted; g.textAlign = "left";
    g.fillText(r.label, left, r.y - 9);
    if (!r.grid) {
      const sizes = k.files ? k.files.sizes : [n], labels = k.files ? k.files.labels : [""];
      const off = G.offsets(sizes);
      sizes.forEach((s, i) => {
        g.fillStyle = i % 2 ? "#1d2a44" : "#16203a";
        g.fillRect(X(off[i]), r.y, s * sx, bandH);
        g.strokeStyle = C.fileCss; g.lineWidth = 1;
        g.beginPath(); g.moveTo(Math.round(X(off[i])) + 0.5, r.y); g.lineTo(Math.round(X(off[i])) + 0.5, r.y + bandH); g.stroke();
        const lab = sizes.length > 12 ? `${labels[i].slice(0, 1)}` : labels[i];
        const t = sizes.length > 12 ? String(s) : `${lab} ${s}`;
        if (s * sx > g.measureText(t).width + 4) { g.fillStyle = C.ink; g.textAlign = "center"; g.fillText(t, X(off[i] + s / 2), r.y + bandH / 2); }
        else if (s * sx > 12) { g.fillStyle = C.ink; g.textAlign = "center"; g.fillText(String(s), X(off[i] + s / 2), r.y + bandH / 2); }
      });
      g.strokeStyle = C.fileCss; g.beginPath(); g.moveTo(Math.round(X(n)) - 0.5, r.y); g.lineTo(Math.round(X(n)) - 0.5, r.y + bandH); g.stroke();
      continue;
    }
    const a = r.grid.axes[0], off = r.grid.off[0];
    const sp = G.span(off, state.a, state.a + state.w);
    const fileOff = k.files ? new Set(G.offsets(k.files.sizes)) : null;
    a.forEach((s, i) => {
      const hit = sp && i >= sp[0] && i <= sp[1];
      const x0 = X(off[i]), w = s * sx;
      g.fillStyle = hit ? "rgba(255,211,77,0.55)" : i % 2 ? C.bCss : C.aCss;
      g.fillRect(x0 + (w > 3 ? 0.5 : 0), r.y, Math.max(0.5, w - (w > 3 ? 1 : 0)), bandH);
      // a chunk that straddles a file boundary would need bytes from two files
      if (fileOff) {
        let straddle = false;
        for (const fo of fileOff) if (fo > off[i] && fo < off[i + 1]) { straddle = true; break; }
        if (straddle) { g.fillStyle = C.lapCss; g.fillRect(x0, r.y + bandH - 4, w, 4); }
      }
      const t = String(s);
      if (w > g.measureText(t).width + 2) { g.fillStyle = hit ? "#05070d" : C.ink; g.textAlign = "center"; g.fillText(t, x0 + w / 2, r.y + bandH / 2); }
    });
    // the regular grid's last chunk, stored at full size past the end of the array
    if (r.reg && regOver > n) {
      g.fillStyle = C.padCss; g.fillRect(X(n), r.y, (regOver - n) * sx, bandH);
      g.strokeStyle = C.muted; g.setLineDash([3, 3]); g.strokeRect(X(n) + 0.5, r.y + 0.5, (regOver - n) * sx - 1, bandH - 1); g.setLineDash([]);
      if ((regOver - n) * sx > 40) { g.fillStyle = C.ink; g.textAlign = "center"; g.fillText("fill", X(n + (regOver - n) / 2), r.y + bandH / 2); }
    }
  }
  // the end of the array
  g.strokeStyle = C.ink; g.setLineDash([2, 4]);
  g.beginPath(); g.moveTo(Math.round(X(n)) + 0.5, top - 22); g.lineTo(Math.round(X(n)) + 0.5, top + bandH * 4.1); g.stroke(); g.setLineDash([]);
  g.fillStyle = C.muted; g.textAlign = "right";
  g.fillText(`shape ${n}`, Math.min(right, X(n) - 4), top + bandH * 4.1 + 10);
  // pointer
  if (pick != null) {
    g.strokeStyle = "rgba(223,231,242,0.8)";
    g.beginPath(); g.moveTo(X(pick + 0.5), top - 14); g.lineTo(X(pick + 0.5), top + bandH * 4.1); g.stroke();
  }
}

function drawMosaic(g, f) {
  const k = cur(), m = report.grid;
  const W = m.xs[m.xs.length - 1] - m.xs[0], H = m.ys[m.ys.length - 1] - m.ys[0];
  const pad = 36, s = Math.min((f.w - 2 * pad) / W, (f.h - 2 * pad - 30) / H);
  const ox = (f.w - W * s) / 2, oy = (f.h - H * s) / 2 + 10;
  const X = (x) => ox + (x - m.xs[0]) * s, Y = (y) => oy + (y - m.ys[0]) * s;
  frame = { kind: "mosaic", X, Y, s, ox, oy };
  const ncol = m.cols.length;
  // the cells of the grid of all edges
  for (let j = 0; j < m.rows.length; j++) for (let i = 0; i < ncol; i++) {
    const own = report.owners[j * ncol + i];
    if (own.length > 1) { g.fillStyle = "rgba(224,86,107,0.45)"; g.fillRect(X(m.xs[i]), Y(m.ys[j]), m.cols[i] * s, m.rows[j] * s); }
    else if (!own.length) { g.fillStyle = "#101727"; g.fillRect(X(m.xs[i]), Y(m.ys[j]), m.cols[i] * s, m.rows[j] * s); }
  }
  // tiles
  k.rects.forEach((r, t) => {
    const col = C.tiles[t % C.tiles.length];
    g.fillStyle = col + "33"; g.fillRect(X(r.x0), Y(r.y0), (r.x1 - r.x0) * s, (r.y1 - r.y0) * s);
    g.strokeStyle = col; g.lineWidth = 2; g.strokeRect(X(r.x0) + 1, Y(r.y0) + 1, (r.x1 - r.x0) * s - 2, (r.y1 - r.y0) * s - 2);
    const p = report.per[t];
    g.fillStyle = C.ink; g.textAlign = "center";
    g.fillText(`${r.x1 - r.x0} x ${r.y1 - r.y0}`, X((r.x0 + r.x1) / 2), Y((r.y0 + r.y1) / 2) - 7);
    g.fillStyle = p.cells > 1 ? C.lapCss : C.muted;
    g.fillText(p.cells > 1 ? `${p.cells} chunks` : "1 chunk", X((r.x0 + r.x1) / 2), Y((r.y0 + r.y1) / 2) + 9);
  });
  // the cuts, every one running the whole way across
  if (state.grid === "rect") {
    g.strokeStyle = "rgba(255,211,77,0.85)"; g.lineWidth = 1; g.setLineDash([5, 4]);
    g.beginPath();
    for (const x of m.xs) { g.moveTo(Math.round(X(x)) + 0.5, Y(m.ys[0]) - 8); g.lineTo(Math.round(X(x)) + 0.5, Y(m.ys[m.ys.length - 1]) + 8); }
    for (const y of m.ys) { g.moveTo(X(m.xs[0]) - 8, Math.round(Y(y)) + 0.5); g.lineTo(X(m.xs[m.xs.length - 1]) + 8, Math.round(Y(y)) + 0.5); }
    g.stroke(); g.setLineDash([]);
    g.fillStyle = C.hitCss;
    m.cols.forEach((c, i) => { if (c * s > 18) { g.textAlign = "center"; g.fillText(String(c), X(m.xs[i] + c / 2), Y(m.ys[0]) - 14); } });
    m.rows.forEach((r, j) => { if (r * s > 12) { g.textAlign = "right"; g.fillText(String(r), X(m.xs[0]) - 10, Y(m.ys[j] + r / 2)); } });
  }
}

// ---------------------------------------------------------------- readout

function selLabel() {
  const k = cur();
  if (k.files && k.y0) {
    const d0 = dateOf(state.a), d1 = dateOf(state.a + state.w - 1);
    return state.w === 1 ? d0 : `${d0} to ${d1} (${state.w} days)`;
  }
  return `${state.a} to ${state.a + state.w - 1} (${state.w})`;
}
function dateOf(i) {
  const k = cur();
  let y = k.y0;
  while (i >= (G.isLeap(y) ? 366 : 365)) { i -= G.isLeap(y) ? 366 : 365; y++; }
  let m = 0;
  while (i >= G.daysInMonth(y, m)) { i -= G.daysInMonth(y, m); m++; }
  return `${i + 1} ${G.MONTH_NAMES[m]} ${y}`;
}
const fmt = (v) => v.toLocaleString("en-US");

// JSON with objects indented and lists of numbers on one line
function compactJson(v, ind = "") {
  const flat = (x) => !(x && typeof x === "object") || (Array.isArray(x) && x.every(flat));
  if (flat(v)) return JSON.stringify(v).replace(/,/g, ", ");
  const pad = ind + "  ";
  if (Array.isArray(v)) return "[\n" + v.map((x) => pad + compactJson(x, pad)).join(",\n") + "\n" + ind + "]";
  return "{\n" + Object.entries(v).map(([k, x]) => `${pad}${JSON.stringify(k)}: ${compactJson(x, pad)}`).join(",\n") + "\n" + ind + "}";
}

function readout() {
  const k = cur(), rows = [];
  const pre = $("json");
  if (k.kind === "time") {
    rows.push(["Shape", grids.reg.shape.join(" x ")]);
    for (const [name, g, stored] of [["Regular", grids.reg, G.regularStored(grids.reg)], ["Rectilinear", grids.rect, null]]) {
      const c = G.readCost(g, selection(g), { stored: stored || undefined });
      const amp = c.want ? c.read / c.want : 0;
      rows.push([`<b>${name}</b>`, `${fmt(G.chunkCount(g))} chunks`]);
      rows.push(["Chunks read", fmt(c.chunks)]);
      rows.push(["Values read / wanted", `${fmt(c.read)} / ${fmt(c.want)} (${amp.toFixed(2)}x)`]);
      if (k.files) {
        const fo = G.offsets(k.files.sizes);
        const off = g.off[0];
        let straddle = 0;
        for (let i = 0; i + 1 < off.length; i++) if (fo.some((f) => f > off[i] && f < off[i + 1])) straddle++;
        rows.push(["Chunks across a file edge", straddle ? `<span class="warn">${straddle}</span>` : "none"]);
      }
      if (name === "Regular" && g.axes[0][g.axes[0].length - 1] < state.c) {
        rows.push(["Last chunk", `${g.axes[0][g.axes[0].length - 1]} of ${state.c} filled`]);
      }
    }
    const g = state.grid === "reg" ? grids.reg : grids.rect;
    pre.textContent = compactJson({ shape: g.shape, chunk_grid: G.chunkGridJson(g) });
  } else {
    const m = report.grid;
    const shape = [m.ys[m.ys.length - 1] - m.ys[0], m.xs[m.xs.length - 1] - m.xs[0]];
    const max = Math.max(...report.per.map((p) => p.cells));
    rows.push(["Tiles", k.rects.length], ["Shape (rows x columns)", shape.join(" x ")],
      ["Grid of every edge", `${m.rows.length} x ${m.cols.length} = ${m.rows.length * m.cols.length} chunks`],
      ["Tiles that are one chunk", `${report.per.filter((p) => p.cells === 1).length} of ${k.rects.length}`],
      ["Most chunks in one tile", max],
      ["Chunks two tiles claim", report.overlapCells ? `<span class="warn">${report.overlapCells}</span>` : "none"],
      ["Chunks no tile fills", report.holes || "none"]);
    const g = G.grid(shape, [m.rows, m.cols]);
    pre.textContent = compactJson({ shape, chunk_grid: G.chunkGridJson(g, { force: "rectilinear" }) });
  }
  $("out").innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("");
  $("pick-info").innerHTML = pickText();
}

// where the pointer is on the time axis: one division for the regular grid, a search for the rectilinear one
let pick = null;
function pickText() {
  const k = cur();
  if (k.kind !== "time" || pick == null) return k.kind === "time" ? "Point at the bands for the chunk that holds a step." : "";
  const i = pick;
  const kr = G.locateRegular(state.c, i), kc = G.locate(grids.rect.off[0], i);
  const when = k.y0 ? dateOf(i) : `step ${i}`;
  return `${when} (index ${i}): regular chunk floor(${i} / ${state.c}) = ${kr}, key <code>${G.chunkKey([kr, 0, 0])}</code>; ` +
    `rectilinear chunk ${kc} by search of ${grids.rect.off[0].length} offsets, key <code>${G.chunkKey([kc, 0, 0])}</code>, which starts at ${grids.rect.off[0][kc]}.`;
}

// ---------------------------------------------------------------- controls

const PRESETS = [
  ["The last chunk", { case: "edge", grid: "reg", c: 30, a: 90, w: 10, where: "map" }],
  ["Days in months", { case: "months", grid: "rect", c: 30, a: G.dayOf(2023, 2024, 1), w: 29, where: "map" }],
  ["Years of daily files", { case: "years", grid: "reg", c: 365, a: G.dayOf(2019, 2020), w: 366, where: "map" }],
  ["A time series", { case: "months", grid: "rect", c: 30, a: 0, w: 731, where: "pixel" }],
  ["Uneven tiles", { case: "uneven", grid: "rect" }],
  ["Staggered tiles", { case: "brick", grid: "rect" }],
  ["Overlapping scenes", { case: "overlap", grid: "reg" }]
];
for (const [name, p] of PRESETS) {
  const bt = document.createElement("button");
  bt.type = "button"; bt.textContent = name;
  bt.addEventListener("click", () => {
    Object.assign(state, { ex: defaults.ex }, p);
    if (CASES[state.case].kind === "time" && p.c == null) state.c = CASES[state.case].regular;
    clampSel(); pick = null;
    reset();
  });
  $("presets").appendChild(bt);
}

$("grid-reg").addEventListener("click", () => { state.grid = "reg"; update(); });
$("grid-rect").addEventListener("click", () => { state.grid = "rect"; update(); });
$("c").addEventListener("input", () => { state.c = +$("c").value; clampSel(); solve(); update(); });
$("a").addEventListener("input", () => { state.a = +$("a").value; clampSel(); update(); });
$("w").addEventListener("input", () => { state.w = +$("w").value; clampSel(); update(); });
$("where").addEventListener("change", () => { state.where = $("where").value; update(); });
$("ex").addEventListener("input", () => { state.ex = +$("ex").value; build(); sync(); writeHash(); });
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(defaultCam()); writeHash(); });

// move the selection along the bands: press to start it, drag to size it
let dragFrom = null;
cv.addEventListener("pointerdown", (e) => {
  if (!frame || frame.kind !== "time") return;
  const i = indexAt(e);
  if (i == null) return;
  dragFrom = i; state.a = i; state.w = 1; clampSel(); update();
  cv.setPointerCapture(e.pointerId);
});
cv.addEventListener("pointermove", (e) => {
  if (!frame || frame.kind !== "time") return;
  const i = indexAt(e);
  pick = i;
  if (dragFrom != null && i != null) { state.a = Math.min(dragFrom, i); state.w = Math.abs(i - dragFrom) + 1; clampSel(); update(); }
  else { draw2d(); $("pick-info").innerHTML = pickText(); }
});
cv.addEventListener("pointerup", () => { dragFrom = null; });
cv.addEventListener("pointerleave", () => { if (dragFrom == null) { pick = null; draw2d(); $("pick-info").innerHTML = pickText(); } });
function indexAt(e) {
  const r = cv.getBoundingClientRect();
  const i = Math.floor((e.clientX - r.left - frame.left) / frame.sx);
  return i >= 0 && i < frame.n ? i : null;
}

// a chunk_grid of your own: paste zarr.json, or read one from a URL
function useMeta(meta, where) {
  const p = G.parseChunkGrid(meta, meta.shape);
  const g = p.grid;
  if (g.shape.length < 1) throw new Error("a scalar has no chunks");
  // time along the first axis, the next two across; missing ones are 1
  const sp = [g.shape[1] || 1, g.shape[2] || 1], spAxes = [g.axes[1] || [1], g.axes[2] || [1]];
  const first = g.axes[0];
  CASES.custom = {
    kind: "time", label: where, n: g.shape[0], files: null, unit: "step",
    rect: () => first, regular: Math.max(...first),
    space: sp, spaceAxes: spAxes
  };
  state.case = "custom"; state.grid = p.kind === "rectilinear" ? "rect" : "reg";
  state.c = G.regularSize(first) || CASES.custom.regular; state.a = 0; state.w = Math.min(g.shape[0], first[0]);
  clampSel();
  $("custom-note").textContent = `${where}: ${p.kind}, shape ${g.shape.join(" x ")}, ${fmt(G.chunkCount(g))} chunks` +
    (g.shape.length > 3 ? ` (the first three axes are drawn)` : "") + ". The regular grid beside it cuts the first axis by the slider.";
  reset();
}
$("draw-json").addEventListener("click", () => {
  try { useMeta(JSON.parse($("paste").value), "Pasted"); }
  catch (e) { $("custom-note").textContent = `Could not use that: ${e.message}`; }
});
$("read-url").addEventListener("click", async () => {
  let u = $("url").value.trim();
  if (!u) return;
  if (!/zarr\.json$|\.zarray$/.test(u)) u = u.replace(/\/$/, "") + "/zarr.json";
  $("custom-note").textContent = `Reading ${u}`;
  try {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.node_type === "group") throw new Error("that is a group; give the URL of one array in it");
    useMeta(j, u.split("/").slice(-2, -1)[0] || "From the URL");
  } catch (e) { $("custom-note").textContent = `Could not read ${u}: ${e.message}`; }
});

function sync() {
  const k = cur(), time = k.kind === "time";
  $("grid-reg").classList.toggle("active", state.grid === "reg");
  $("grid-rect").classList.toggle("active", state.grid === "rect");
  $("grid-reg").textContent = time ? "Regular" : "The files";
  $("grid-rect").textContent = time ? "Rectilinear" : "Rectilinear grid";
  $("time-ctl").hidden = !time;
  if (time) {
    $("c").max = k.n; $("c").value = state.c; $("c-out").textContent = `${state.c} ${k.unit}s`;
    $("a").max = k.n - 1; $("a").value = state.a; $("a-out").textContent = k.y0 ? dateOf(state.a) : state.a;
    $("w").max = k.n; $("w").value = state.w; $("w-out").textContent = `${state.w} ${k.unit}s`;
    $("where").value = state.where;
  }
  $("ex").value = state.ex; $("ex-out").textContent = state.ex.toFixed(2);
  $("case-label").textContent = k.label;
  $("axis-label").textContent = time ? "Cuts along the first axis; drag to choose what to read" : "The tiles, and the grid every edge makes";
  for (const [name, el] of [["edge", "about-edge"], ["months", "about-cal"], ["years", "about-cal"], ["uneven", "about-mosaic"], ["brick", "about-mosaic"], ["overlap", "about-mosaic"]]) {
    if (name === state.case) for (const d of document.querySelectorAll(".about details")) if (d.id === el) d.open = true;
  }
}

function update() {
  build(); draw2d(); readout(); sync(); writeHash();
}
function reset({ keepCam = false } = {}) {
  solve(); update();
  if (!keepCam) { state.cam = null; setCamera(defaultCam()); }
  writeHash();
}

window.addEventListener("hashchange", () => {
  readHash();
  reset({ keepCam: true });
  if (state.cam) setCamera(state.cam);
});

const main = $("stage");
new ResizeObserver(() => { main.classList.toggle("stacked", main.clientHeight > main.clientWidth); draw2d(); }).observe(main);
shareLinks("playproj: rectilinear chunks", { height: 520 });

// ---------------------------------------------------------------- go

solve(); build(); sync(); readout();
resize();
setCamera(state.cam || defaultCam());
draw2d();
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
// for tests
window.__chunks = () => ({ state: { ...state }, grids, report });
