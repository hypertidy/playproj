// playproj: Affine
//
// The six-number geotransform that takes an image's columns and rows to x
// and y, shown both ways: the image in its own pixels on the left, placed
// on a longitude and latitude map on the right. Set it by hand (offset,
// pixel size, rotation, shear) or fit it to ground control points clicked
// on the two views, on a sample atlas page, a crooked scan of it or an image
// of your own, then download the image as a GeoTIFF or its world file. The
// maths is src/core/affine.js.

import * as A from "../src/core/affine.js";
import { writeGeoTIFF } from "../src/core/geotiff-write.js";
import { crsGeoKeys } from "../src/core/cellexport.js";
import { saveBlob } from "./download.js";
import { readParams, hashWriter, oneOf } from "../src/scene/hash.js";
import { shareLinks, copyText } from "../src/scene/share.js";

const $ = (id) => document.getElementById(id);

const C = {
  bg: "#05070d", land: "#1c2a44", landLine: "rgba(127,224,255,0.75)", world: "rgba(215,236,255,0.6)",
  grat: "rgba(140,196,255,0.2)", gratImg: "rgba(0,170,200,0.85)", foot: "#ffd34d", colAx: "#ff7ab8", rowAx: "#7fe0ff",
  pt: "#ffd34d", pending: "#ffb347", resid: "#ff5a5a", hover: "#f2f6fb", pix: "rgba(5,7,13,0.35)", ink: "#dfe7f2", muted: "#8a97ab"
};

// ---------------------------------------------------------------- samples

// The atlas page: a plate carree world 1000 x 500 pixels, 0.36 degrees
// each, inside a margin, so its geotransform is known exactly.
const ATLAS = { w: 1100, h: 620, left: 50, top: 40, res: 0.36 };
const GT_ATLAS = [-180 - ATLAS.left * ATLAS.res, ATLAS.res, 0, 90 + ATLAS.top * ATLAS.res, 0, -ATLAS.res];
// The crooked scan: the atlas page drawn turned and leant on a bigger sheet,
// through a pixel-to-pixel affine (rows down on both sides).
const SCAN_M0 = A.fromParts({ x0: 0, y0: 0, w: 0.96, h: -0.96, rot: -5, shear: 4 });
const SCAN = (() => {
  const c = A.corners(SCAN_M0, ATLAS.w, ATLAS.h), xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
  const m = SCAN_M0.slice(); m[0] = 40 - Math.min(...xs); m[3] = 30 - Math.min(...ys);
  return { m, w: Math.ceil(Math.max(...xs) - Math.min(...xs) + 80), h: Math.ceil(Math.max(...ys) - Math.min(...ys) + 60) };
})();
const GT_SCAN = A.compose(GT_ATLAS, A.invert(SCAN.m));
const TRUTH = { atlas: GT_ATLAS, crooked: GT_SCAN };

// ---------------------------------------------------------------- state

const atlasParts = A.toParts(GT_ATLAS);
const r4 = (v) => +v.toFixed(4);
const defaults = {
  pic: "atlas", fit: "hand", x0: r4(atlasParts.x0), y0: r4(atlasParts.y0), w: r4(atlasParts.w), h: r4(atlasParts.h), rot: 0, shear: 0,
  gcp: "", op: 0.75, grat: 1, pix: 1
};
const state = { ...defaults };
let points = []; // { col, row, x, y }, any pair of which may be null while it waits for its other half
function readHash() {
  readParams(state, defaults, {
    pic: oneOf(["atlas", "crooked", "own"], "atlas"), fit: oneOf(["hand", "northup", "similarity", "affine"], "hand"), gcp: String
  });
  points = parseGcp(state.gcp);
}
const parseGcp = (s) => s.split(";").map((t) => t.split(",").map(Number)).filter((v) => v.length === 4 && v.every(isFinite))
  .map(([col, row, x, y]) => ({ col, row, x, y }));
const gcpString = () => points.filter(complete).map((p) => [p.col, p.row, p.x, p.y].map((v) => +v.toFixed(4)).join(",")).join(";");
const complete = (p) => p.col !== null && p.x !== null;
readHash();
const writeHash = hashWriter(state, defaults, { digits: 4 });

// the image: a canvas at its own size, its name and whether it is a sample
let pic = null, ownPic = null;

// ---------------------------------------------------------------- geotransform

const handGT = () => A.fromParts(state);
let fitted = null;
function currentGT() {
  if (state.fit === "hand") { fitted = null; return handGT(); }
  fitted = A.fit(points.filter(complete), state.fit);
  return fitted.error ? handGT() : fitted.gt;
}
let gt = handGT(), inv = A.invert(gt);

// ---------------------------------------------------------------- views

// each pane: its canvas, a view (centre and pixels per unit) and which way is up
const panes = {
  img: { canvas: $("img"), yDown: true, view: null },
  map: { canvas: $("map"), yDown: false, view: null }
};
const px = (pane, x, y) => {
  const v = pane.view;
  return [pane.w / 2 + (x - v.cx) * v.s, pane.h / 2 + (pane.yDown ? 1 : -1) * (y - v.cy) * v.s];
};
const un = (pane, X, Y) => {
  const v = pane.view;
  return [v.cx + (X - pane.w / 2) / v.s, v.cy + (pane.yDown ? 1 : -1) * (Y - pane.h / 2) / v.s];
};
function fitView(pane, [x0, x1, y0, y1]) {
  const s = 0.9 * Math.min(pane.w / (x1 - x0), pane.h / (y1 - y0));
  pane.view = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, s };
}
function resetViews() {
  sizePanes();
  if (pic) fitView(panes.img, [0, pic.width, 0, pic.height]);
  const e = pic ? A.extent(gt, pic.width, pic.height) : [-180, 180, -90, 90];
  const fin = e.every(isFinite) && Math.max(e[1] - e[0], e[3] - e[2]) < 1e5;
  fitView(panes.map, fin ? [Math.min(-180, e[0]), Math.max(180, e[1]), Math.min(-90, e[2]), Math.max(90, e[3])] : [-180, 180, -90, 90]);
}
function sizePanes() {
  for (const pane of Object.values(panes)) {
    const box = pane.canvas.getBoundingClientRect();
    pane.w = Math.max(10, box.width); pane.h = Math.max(10, box.height);
  }
}

// ---------------------------------------------------------------- drawing

let countries = [], hover = null; // hover: { col, row } under the pointer in either view

function ctxFor(pane) {
  const dpr = window.devicePixelRatio || 1, c = pane.canvas;
  c.width = Math.round(pane.w * dpr); c.height = Math.round(pane.h * dpr);
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, pane.w, pane.h);
  return { ctx, dpr };
}

// draw the image with col, row -> pane pixels given as a geotransform-like m
function drawPic(ctx, dpr, m, alpha) {
  if (!pic) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.setTransform(dpr * m[1], dpr * m[4], dpr * m[2], dpr * m[5], dpr * m[0], dpr * m[3]);
  // nearest neighbour once a pixel is big enough to see
  ctx.imageSmoothingEnabled = Math.sqrt(Math.abs(A.det(m))) < 3;
  ctx.drawImage(pic.canvas, 0, 0, pic.width, pic.height);
  ctx.restore();
}

// col, row -> pane pixels as a geotransform, for each pane
function imgM(pane) {
  const [ox, oy] = px(pane, 0, 0), s = pane.view.s;
  return [ox, s, 0, oy, 0, s];
}
function mapM(pane) {
  const v = pane.view, s = v.s;
  return [pane.w / 2 + s * (gt[0] - v.cx), s * gt[1], s * gt[2], pane.h / 2 - s * (gt[3] - v.cy), -s * gt[4], -s * gt[5]];
}

function drawImg() {
  const pane = panes.img, { ctx, dpr } = ctxFor(pane);
  if (!pic || !pane.view) return;
  const m = imgM(pane);
  drawPic(ctx, dpr, m, 1);
  const s = pane.view.s;
  // pixel edges and centres once they are far enough apart
  if (state.pix && s >= 6) {
    const [c0, r0] = un(pane, 0, 0), [c1, r1] = un(pane, pane.w, pane.h);
    const ca = Math.max(0, Math.floor(c0)), cb = Math.min(pic.width, Math.ceil(c1)), ra = Math.max(0, Math.floor(r0)), rb = Math.min(pic.height, Math.ceil(r1));
    ctx.strokeStyle = C.pix; ctx.lineWidth = 1; ctx.beginPath();
    for (let c = ca; c <= cb; c++) { const [x, y0] = px(pane, c, ra), [, y1] = px(pane, c, rb); ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (let r = ra; r <= rb; r++) { const [x0, y] = px(pane, ca, r), [x1] = px(pane, cb, r); ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
    if (s >= 16) {
      ctx.fillStyle = C.pix;
      for (let c = ca; c < cb; c++) for (let r = ra; r < rb; r++) { const [x, y] = px(pane, c + 0.5, r + 0.5); ctx.fillRect(x - 1.5, y - 1.5, 3, 3); }
    }
  }
  // the map's graticule taken back into the image by the inverse
  if (state.grat && inv) {
    const pxPerDeg = s / Math.sqrt(Math.abs(A.det(inv))), step = gratStep(pxPerDeg), labels = step * pxPerDeg > 40;
    ctx.strokeStyle = C.gratImg; ctx.lineWidth = 1; ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = C.gratImg;
    const seg = (x0, y0, x1, y1, label) => {
      const a = px(pane, ...A.apply(inv, x0, y0)), b = px(pane, ...A.apply(inv, x1, y1));
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
      if (label && labels) ctx.fillText(label, a[0] + 3, a[1] - 3);
    };
    for (let lon = -180; lon <= 180; lon += step) seg(lon, 90, lon, -90, lonLabel(lon));
    for (let lat = -90; lat <= 90; lat += step) seg(-180, lat, 180, lat, latLabel(lat));
  }
  axes(ctx, (c, r) => px(pane, c, r));
  drawPoints(ctx, "img");
  if (hover) cross(ctx, px(pane, hover.col, hover.row));
}

function drawMap() {
  const pane = panes.map, { ctx, dpr } = ctxFor(pane);
  if (!pane.view) return;
  const P = (lon, lat) => px(pane, lon, lat);
  // countries under the image, their borders over it, so a misfit shows
  const rings = (paint) => {
    for (const country of countries) for (const ring of country) {
      ctx.beginPath();
      for (let i = 0; i < ring.length; i += 2) { const [x, y] = P(ring[i], ring[i + 1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.closePath(); paint();
    }
  };
  ctx.fillStyle = C.land; rings(() => ctx.fill());
  if (pic) drawPic(ctx, dpr, mapM(pane), state.op);
  ctx.strokeStyle = C.landLine; ctx.lineWidth = 0.8; rings(() => ctx.stroke());
  const step = gratStep(pane.view.s);
  ctx.strokeStyle = C.grat; ctx.lineWidth = 1; ctx.beginPath();
  for (let lon = -180; lon <= 180; lon += step) { ctx.moveTo(...P(lon, -90)); ctx.lineTo(...P(lon, 90)); }
  for (let lat = -90; lat <= 90; lat += step) { ctx.moveTo(...P(-180, lat)); ctx.lineTo(...P(180, lat)); }
  ctx.stroke();
  ctx.strokeStyle = C.world; ctx.strokeRect(...P(-180, 90), 360 * pane.view.s, 180 * pane.view.s);
  if (pic) {
    // the image's outline and its first row and column
    const c = A.corners(gt, pic.width, pic.height).map((q) => P(...q));
    ctx.strokeStyle = C.foot; ctx.lineWidth = 1.5; ctx.beginPath(); c.forEach((q, i) => (i ? ctx.lineTo(...q) : ctx.moveTo(...q))); ctx.closePath(); ctx.stroke();
    axes(ctx, (col, row) => P(...A.apply(gt, col, row)));
  }
  drawPoints(ctx, "map");
  if (hover) cross(ctx, P(...A.apply(gt, hover.col, hover.row)));
}

const gratStep = (pxPerDeg) => [1, 2, 5, 10, 15, 30].find((d) => d * pxPerDeg > 60) || 30;
const lonLabel = (lon) => `${Math.abs(lon)}${lon < 0 ? "W" : lon > 0 ? "E" : ""}`;
const latLabel = (lat) => `${Math.abs(lat)}${lat < 0 ? "S" : lat > 0 ? "N" : ""}`;

// arrows along the first row (columns increasing) and down the first column
// (rows increasing), from the corner at col 0, row 0
function axes(ctx, P) {
  if (!pic) return;
  const L = Math.min(pic.width, pic.height) * 0.3, o = P(0, 0);
  ctx.font = "bold 12px system-ui, sans-serif"; ctx.lineWidth = 2.5;
  for (const [end, colour, label] of [[P(L, 0), C.colAx, "col"], [P(0, L), C.rowAx, "row"]]) {
    arrow(ctx, o, end, colour);
    ctx.fillStyle = colour; ctx.fillText(label, end[0] + 4, end[1] + 4);
  }
  ctx.fillStyle = C.foot; ctx.beginPath(); ctx.arc(...o, 4, 0, 2 * Math.PI); ctx.fill();
  ctx.fillText("0, 0", o[0] + 6, o[1] - 6);
}
function arrow(ctx, a, b, colour) {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / d, uy = (b[1] - a[1]) / d;
  ctx.strokeStyle = colour; ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b);
  ctx.moveTo(b[0] - 9 * ux + 5 * uy, b[1] - 9 * uy - 5 * ux); ctx.lineTo(...b); ctx.lineTo(b[0] - 9 * ux - 5 * uy, b[1] - 9 * uy + 5 * ux);
  ctx.stroke();
}
function cross(ctx, [x, y]) {
  ctx.strokeStyle = C.hover; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x - 12, y); ctx.lineTo(x - 3, y); ctx.moveTo(x + 3, y); ctx.lineTo(x + 12, y);
  ctx.moveTo(x, y - 12); ctx.lineTo(x, y - 3); ctx.moveTo(x, y + 3); ctx.lineTo(x, y + 12); ctx.stroke();
}

// the points where each view has them, numbered, with the miss of the fit
function pointPx(p, which) {
  if (which === "img") return p.col === null ? null : px(panes.img, p.col, p.row);
  return p.x === null ? null : px(panes.map, p.x, p.y);
}
function drawPoints(ctx, which) {
  const pane = panes[which];
  points.forEach((p, i) => {
    const q = pointPx(p, which);
    if (!q) return;
    // the fit's miss: where the other half of the point lands in this view
    if (complete(p) && state.fit !== "hand" && fitted && !fitted.error) {
      const r = which === "img" ? (inv ? px(pane, ...A.apply(inv, p.x, p.y)) : null) : px(pane, ...A.apply(gt, p.col, p.row));
      if (r && Math.hypot(r[0] - q[0], r[1] - q[1]) > 1) {
        ctx.strokeStyle = C.resid; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(...q); ctx.lineTo(...r); ctx.stroke();
      }
    }
    ctx.strokeStyle = complete(p) ? C.pt : C.pending; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(...q, 7, 0, 2 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(q[0] - 3, q[1]); ctx.lineTo(q[0] + 3, q[1]); ctx.moveTo(q[0], q[1] - 3); ctx.lineTo(q[0], q[1] + 3); ctx.stroke();
    ctx.font = "bold 12px system-ui, sans-serif"; ctx.fillStyle = complete(p) ? C.pt : C.pending;
    ctx.fillText(String(i + 1), q[0] + 9, q[1] - 8);
  });
}

function draw() { drawImg(); drawMap(); }

// ---------------------------------------------------------------- readout

const f = (v, d = 10) => A.fmt(v, d);
const DEG = (v, d = 6) => `${f(v, d)} deg`;

function readout() {
  const rows = [];
  if (hover) {
    const [x, y] = A.apply(gt, hover.col, hover.row);
    rows.push(["Under the pointer", `col ${hover.col.toFixed(2)}, row ${hover.row.toFixed(2)}<br>x ${x.toFixed(4)}, y ${y.toFixed(4)}`]);
    rows.push(["", `<span class="hint">pixel ${Math.floor(hover.col)}, ${Math.floor(hover.row)}${inside(hover) ? "" : " (outside the image)"}</span>`]);
  }
  rows.push(["Geotransform", gt.map((v, i) => `gt${i} ${f(v)}`).join("<br>")]);
  const parts = A.toParts(gt);
  rows.push(["In parts", `pixel ${f(parts.w, 6)} x ${f(parts.h, 6)}<br>rotation ${f(parts.rot, 5)}, shear ${f(parts.shear, 5)} deg`]);
  if (pic) {
    const e = A.extent(gt, pic.width, pic.height);
    rows.push([A.isNorthUp(gt) ? "Extent" : "Box round it", `x ${f(e[0], 8)} to ${f(e[1], 8)}<br>y ${f(e[2], 8)} to ${f(e[3], 8)}<br><span class="hint">${pic.width} columns, ${pic.height} rows</span>`]);
  }
  rows.push(["Inverse, x, y to col, row", inv ? inv.map((v, i) => `${f(v, 8)}`).join(", ") : "none: the pixels have no area"]);
  rows.push(["World file", `<code>${A.worldFile(gt).map((v) => f(v, 12)).join("<br>")}</code>`]);
  if (state.fit !== "hand") {
    if (fitted?.error) rows.push(["Fit", `<span class="hint">${fitted.error} Until then the geotransform is the one set by hand.</span>`]);
    else if (fitted) {
      const pxSize = Math.sqrt(Math.abs(A.det(gt)));
      const miss = fitted.rmse < 1e-9 * pxSize ? "none: just enough points, so they fit exactly" : `${DEG(fitted.rmse, 3)}, ${(fitted.rmse / pxSize).toFixed(2)} px`;
      rows.push(["Fit", `${A.FITS[state.fit].label}, ${points.filter(complete).length} points<br>rms miss ${miss}`]);
    }
  }
  const truth = TRUTH[state.pic];
  if (truth && pic) {
    const ti = A.invert(truth);
    const err = Math.max(...A.corners(gt, pic.width, pic.height).map((q, i) => {
      const [c, r] = A.apply(ti, ...q), k = [[0, 0], [pic.width, 0], [pic.width, pic.height], [0, pic.height]][i];
      return Math.hypot(c - k[0], r - k[1]);
    }));
    rows.push(["Against the truth", `corners up to ${err < 0.005 ? "0" : err.toFixed(2)} px from where they belong`]);
  }
  $("out").innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("");
  gdalText();
}
const inside = (h) => pic && h.col >= 0 && h.row >= 0 && h.col < pic.width && h.row < pic.height;

function gcpTable() {
  const box = $("fit-box");
  box.hidden = state.fit === "hand";
  $("hand-box").hidden = state.fit !== "hand";
  if (state.fit === "hand") return;
  const need = A.FITS[state.fit].min, n = points.filter(complete).length;
  const pending = points.find((p) => !complete(p));
  $("fit-hint").textContent = pending
    ? `Now click point ${points.indexOf(pending) + 1} on the ${pending.col === null ? "image" : "map"}.`
    : n < need ? `Click a place on the image, then the same place on the map (${need - n} more point${need - n > 1 ? "s" : ""} to go).`
      : `Fitted. Add points to check it, drag one to move it, or type a longitude and latitude.`;
  const resid = fitted && !fitted.error ? fitted.residuals : [];
  let k = 0;
  $("gcps").innerHTML = `<tr><th>#</th><th>col</th><th>row</th><th>lon</th><th>lat</th><th>miss</th><th></th></tr>` + points.map((p, i) => {
    const r = complete(p) ? resid[k++] : null;
    const num = (v) => (v === null ? "" : v.toFixed(2));
    return `<tr><td>${i + 1}</td><td>${num(p.col)}</td><td>${num(p.row)}</td>` +
      `<td><input data-i="${i}" data-k="x" type="number" step="any" value="${p.x === null ? "" : +p.x.toFixed(4)}"></td>` +
      `<td><input data-i="${i}" data-k="y" type="number" step="any" value="${p.y === null ? "" : +p.y.toFixed(4)}"></td>` +
      `<td>${r ? r.d.toFixed(3) : ""}</td><td><button class="small" data-del="${i}" type="button" aria-label="Remove point ${i + 1}">x</button></td></tr>`;
  }).join("");
}
$("gcps").addEventListener("change", (e) => {
  const i = +e.target.dataset.i, k = e.target.dataset.k, v = parseFloat(e.target.value);
  if (!points[i] || !k) return;
  if (isFinite(v)) {
    points[i][k] = v;
    if (points[i][k === "x" ? "y" : "x"] === null) points[i][k === "x" ? "y" : "x"] = 0;
  }
  update();
});
$("gcps").addEventListener("click", (e) => {
  const i = e.target.dataset.del;
  if (i === undefined) return;
  points.splice(+i, 1); update();
});

// the GDAL command that does the same
function gdalText() {
  const name = pic?.name || "image.png", out = name.replace(/\.[^.]*$/, "") + "_4326.tif";
  const pts = points.filter(complete);
  let s;
  if (state.fit !== "hand" && pts.length) {
    s = `gdal_translate -a_srs EPSG:4326 \\\n` + pts.map((p) => `  -gcp ${+p.col.toFixed(3)} ${+p.row.toFixed(3)} ${+p.x.toFixed(6)} ${+p.y.toFixed(6)} \\\n`).join("") +
      `  ${name} gcps.vrt\ngdalwarp -order 1 gcps.vrt ${out}`;
    if (A.isNorthUp(gt) && pic) s = ullr(name, out) + "\n\n# or, from the points (a full affine, then warped north up):\n" + s;
  } else s = A.isNorthUp(gt) && pic ? ullr(name, out)
    : `# not north up: write the world file beside the image, then\ngdal_translate -a_srs EPSG:4326 ${name} ${out}`;
  $("gdal").textContent = s;
}
const ullr = (name, out) => {
  const e = A.extent(gt, pic.width, pic.height);
  return `gdal_translate -a_srs EPSG:4326 -a_ullr ${f(e[0], 10)} ${f(e[3], 10)} ${f(e[1], 10)} ${f(e[2], 10)} ${name} ${out}`;
};

// ---------------------------------------------------------------- update

function update({ views = false } = {}) {
  gt = currentGT(); inv = A.invert(gt);
  state.gcp = gcpString();
  if (views) resetViews();
  syncUI(); draw(); readout(); gcpTable(); writeHash();
}

const HAND = ["x0", "y0", "w", "h", "rot", "shear"];
const DIGITS = { x0: 2, y0: 2, w: 4, h: 4, rot: 1, shear: 1 };
function syncUI() {
  $("pic").value = state.pic; $("fit").value = state.fit;
  for (const k of HAND) { $(k).value = state[k]; $(`${k}-out`).textContent = (+state[k]).toFixed(DIGITS[k]) + (k === "rot" || k === "shear" ? " deg" : ""); }
  if (document.activeElement !== $("gt-text")) $("gt-text").value = handGT().map((v) => f(v, 10)).join(", ");
  $("op").value = state.op; $("op-out").textContent = `${Math.round(state.op * 100)}%`;
  $("grat").checked = !!state.grat; $("pix").checked = !!state.pix;
  $("img-label").textContent = `${pic ? pic.label : "The image"}: column and row`;
}

// keep the hand settings at the fitted geotransform when going back to them
function handFrom(g) {
  const p = A.toParts(g);
  for (const k of HAND) state[k] = +p[k].toFixed(k === "x0" || k === "y0" ? 6 : 8);
}

// ---------------------------------------------------------------- images

function drawAtlas() {
  const c = document.createElement("canvas"); c.width = ATLAS.w; c.height = ATLAS.h;
  const ctx = c.getContext("2d"), r = ATLAS.res;
  const P = (lon, lat) => [ATLAS.left + (lon + 180) / r, ATLAS.top + (90 - lat) / r];
  ctx.fillStyle = "#efe6cf"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#bcd3d6"; ctx.fillRect(ATLAS.left, ATLAS.top, 360 / r, 180 / r);
  ctx.fillStyle = "#e3cf98"; ctx.strokeStyle = "#7a6a4a"; ctx.lineWidth = 0.8;
  for (const country of countries) for (const ring of country) {
    ctx.beginPath();
    for (let i = 0; i < ring.length; i += 2) { const [x, y] = P(ring[i], ring[i + 1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.strokeStyle = "rgba(60,80,100,0.55)"; ctx.lineWidth = 1; ctx.beginPath();
  for (let lon = -150; lon <= 150; lon += 30) { ctx.moveTo(...P(lon, -90)); ctx.lineTo(...P(lon, 90)); }
  for (let lat = -60; lat <= 60; lat += 30) { ctx.moveTo(...P(-180, lat)); ctx.lineTo(...P(180, lat)); }
  ctx.stroke();
  ctx.strokeStyle = "#2b2b2b"; ctx.lineWidth = 2; ctx.strokeRect(ATLAS.left, ATLAS.top, 360 / r, 180 / r);
  ctx.fillStyle = "#3a3226"; ctx.font = "13px Georgia, serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let lon = -180; lon <= 180; lon += 30) { const [x] = P(lon, 0); ctx.fillText(lonLabel(lon), x, ATLAS.top - 14); ctx.fillText(lonLabel(lon), x, ATLAS.top + 180 / r + 14); }
  for (let lat = -90; lat <= 90; lat += 30) { const [, y] = P(0, lat); ctx.fillText(latLabel(lat), ATLAS.left - 22, y); ctx.fillText(latLabel(lat), ATLAS.left + 360 / r + 22, y); }
  ctx.font = "italic 26px Georgia, serif"; ctx.fillText("The World", c.width / 2, ATLAS.top + 180 / r + 50);
  return c;
}

function makeSample(id) {
  const atlas = drawAtlas();
  if (id === "atlas") return { canvas: atlas, width: atlas.width, height: atlas.height, name: "atlas.png", label: "Atlas page" };
  const c = document.createElement("canvas"); c.width = SCAN.w; c.height = SCAN.h;
  const ctx = c.getContext("2d"), m = SCAN.m;
  ctx.fillStyle = "#f7f5ef"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(m[1], m[4], m[2], m[5], m[0], m[3]);
  ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = 12;
  ctx.drawImage(atlas, 0, 0);
  return { canvas: c, width: c.width, height: c.height, name: "crooked.png", label: "Crooked scan" };
}

function setPic(id, { keepPoints = false } = {}) {
  $("pic-status").textContent = "";
  if (id === "own") {
    if (!ownPic) { $("own-file").click(); syncUI(); return; }
    pic = ownPic;
  } else pic = makeSample(id);
  state.pic = id;
  if (!keepPoints) points = [];
  update({ views: true });
}

async function loadOwn(file) {
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    ownPic = { canvas: c, width: c.width, height: c.height, name: file.name.replace(/[^\w.-]/g, "_"), label: file.name, type: file.type };
    // a first guess: the whole world, north up
    Object.assign(state, { fit: "northup" });
    handFrom(A.fromExtent([-180, 180, -90, 90], c.width, c.height));
    setPic("own");
    $("pic-status").textContent = `${file.name}: ${c.width} x ${c.height}. Click a place on it, then the same place on the map.`;
  } catch (e) {
    $("pic-status").textContent = `That file did not open as an image (${e.message}).`;
    syncUI();
  }
}

// ---------------------------------------------------------------- interaction

function hitPoint(which, X, Y) {
  let best = -1, bd = 10;
  points.forEach((p, i) => {
    const q = pointPx(p, which);
    if (q && Math.hypot(q[0] - X, q[1] - Y) < bd) { bd = Math.hypot(q[0] - X, q[1] - Y); best = i; }
  });
  return best;
}
function place(which, u, v) {
  if (state.fit === "hand") return;
  const key = which === "img" ? ["col", "row"] : ["x", "y"];
  let p = points.find((q) => !complete(q) && q[key[0]] === null);
  if (!p) { p = { col: null, row: null, x: null, y: null }; points.push(p); }
  p[key[0]] = u; p[key[1]] = v;
  update();
}

for (const which of ["img", "map"]) {
  const pane = panes[which], cv = pane.canvas;
  let drag = null;
  const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener("pointerdown", (e) => {
    const [X, Y] = local(e), i = state.fit === "hand" ? -1 : hitPoint(which, X, Y);
    drag = { X, Y, moved: false, point: i, view: { ...pane.view } };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener("pointermove", (e) => {
    const [X, Y] = local(e);
    if (drag) {
      if (Math.hypot(X - drag.X, Y - drag.Y) > 3) drag.moved = true;
      if (!drag.moved) return;
      if (drag.point >= 0) {
        const [u, v] = un(pane, X, Y), p = points[drag.point];
        if (which === "img") { p.col = u; p.row = v; } else { p.x = u; p.y = v; }
        update();
      } else {
        const s = drag.view.s;
        pane.view.cx = drag.view.cx - (X - drag.X) / s;
        pane.view.cy = drag.view.cy + (pane.yDown ? -1 : 1) * (Y - drag.Y) / s;
        draw();
      }
      return;
    }
    const [u, v] = un(pane, X, Y);
    if (which === "img") hover = { col: u, row: v };
    else if (inv) { const [c, r] = A.apply(inv, u, v); hover = { col: c, row: r }; }
    draw(); readout();
  });
  cv.addEventListener("pointerup", (e) => {
    if (drag && !drag.moved && drag.point < 0) place(which, ...un(pane, ...local(e)));
    drag = null;
  });
  cv.addEventListener("pointerleave", () => { if (!drag) { hover = null; draw(); readout(); } });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const [X, Y] = local(e), [u, v] = un(pane, X, Y);
    const k = Math.exp(-e.deltaY * 0.0015), s = Math.max(1e-6, Math.min(400, pane.view.s * k));
    pane.view.s = s;
    // keep the point under the pointer still
    const [u2, v2] = un(pane, X, Y);
    pane.view.cx += u - u2; pane.view.cy += v - v2;
    draw();
  }, { passive: false });
  // drop an image on either view
  cv.addEventListener("dragover", (e) => e.preventDefault());
  cv.addEventListener("drop", (e) => { e.preventDefault(); loadOwn(e.dataTransfer.files[0]); });
}

// ---------------------------------------------------------------- UI

const twoPoints = "550.3,289.8,0,0;883.5,123.1,120,60";
// the crooked scan's points, a little off as if clicked by hand
function scanPoints(list) {
  const ti = A.invert(GT_SCAN);
  return list.map(([lon, lat, dc, dr]) => { const [c, r] = A.apply(ti, lon, lat); return [c + dc, r + dr, lon, lat].map((v) => +v.toFixed(2)).join(","); }).join(";");
}
const SCAN_PTS = scanPoints([[0, 0, 0.4, -0.3], [120, 60, -0.3, 0.5], [-120, -30, 0.2, 0.4], [150, -30, -0.5, -0.2], [-90, 60, 0.3, 0.1]]);
const nu = A.toParts(GT_ATLAS);
const hand = (o) => ({ fit: "hand", x0: r4(nu.x0), y0: r4(nu.y0), w: r4(nu.w), h: r4(nu.h), rot: 0, shear: 0, ...o });
const fitTo = (fit, pic, gcp) => ({ ...hand(), fit, pic, gcp });
const PRESETS = [
  ["No coordinates", { pic: "atlas", ...hand({ x0: 0, y0: 0, w: 1, h: -1 }) }],
  ["North up", { pic: "atlas", ...hand() }],
  ["Rotated", { pic: "atlas", ...hand({ rot: 20 }) }],
  ["Sheared", { pic: "atlas", ...hand({ shear: 25 }) }],
  ["Two points", fitTo("northup", "atlas", twoPoints)],
  ["Crooked, north up", fitTo("northup", "crooked", SCAN_PTS)],
  ["Crooked, rotate and scale", fitTo("similarity", "crooked", SCAN_PTS)],
  ["Crooked, full affine", fitTo("affine", "crooked", SCAN_PTS)]
];
for (const [name, p] of PRESETS) {
  const bt = document.createElement("button");
  bt.type = "button"; bt.textContent = name;
  bt.addEventListener("click", () => {
    const { gcp = "", ...q } = p;
    Object.assign(state, q);
    points = parseGcp(gcp);
    setPic(q.pic, { keepPoints: true });
  });
  $("presets").appendChild(bt);
}
const own = document.createElement("button");
own.type = "button"; own.textContent = "Your own image";
own.addEventListener("click", () => $("own-file").click());
$("presets").appendChild(own);

$("pic").addEventListener("change", (e) => setPic(e.target.value));
$("own-file").addEventListener("change", (e) => loadOwn(e.target.files[0]));
$("fit").addEventListener("change", (e) => {
  if (e.target.value === "hand") handFrom(gt);
  state.fit = e.target.value; update();
});
for (const k of HAND) $(k).addEventListener("input", (e) => { state[k] = +e.target.value; update(); });
$("gt-text").addEventListener("change", (e) => {
  const v = e.target.value.replace(/[(),;]/g, " ").trim().split(/\s+/).map(Number);
  if (v.length !== 6 || !v.every(isFinite)) { $("pic-status").textContent = "That is not six numbers."; return; }
  // GDAL order has the pixel sizes second and sixth; a world file has them first and fourth
  const g = Math.abs(v[0]) < Math.abs(v[4]) && Math.abs(v[3]) < Math.abs(v[5]) ? A.fromWorldFile(v) : v;
  if (!A.invert(g)) { $("pic-status").textContent = "Those numbers give pixels with no area."; return; }
  $("pic-status").textContent = g === v ? "Read as a GDAL geotransform." : "Read as a world file (pixel sizes first, then the top-left pixel centre).";
  handFrom(g); e.target.blur(); update({ views: true });
});
$("op").addEventListener("input", (e) => { state.op = +e.target.value; update(); });
for (const k of ["grat", "pix"]) $(k).addEventListener("change", (e) => { state[k] = e.target.checked ? 1 : 0; update(); });
$("reset-view").addEventListener("click", () => { resetViews(); draw(); });
$("clear").addEventListener("click", () => { points = []; update(); });
$("undo").addEventListener("click", () => { points.pop(); update(); });

const base = () => (pic?.name || "image.png").replace(/\.[^.]*$/, "");
$("dl-tif").addEventListener("click", async (e) => {
  if (!pic) return;
  const bt = e.target, t = bt.textContent;
  bt.textContent = "Writing ..."; bt.disabled = true;
  try {
    const rgba = pic.canvas.getContext("2d").getImageData(0, 0, pic.width, pic.height).data;
    const geo = { width: pic.width, height: pic.height, rgba, geoKeys: crsGeoKeys({ geographic: true }) };
    if (A.isNorthUp(gt)) Object.assign(geo, { origin: [gt[0], gt[3]], pixelSize: [gt[1], -gt[5]] });
    else geo.gt = gt;
    saveBlob(await writeGeoTIFF(geo), `${base()}_4326.tif`);
  } catch (err) {
    $("pic-status").textContent = `The GeoTIFF was not written (${err.message}).`;
  }
  bt.textContent = t; bt.disabled = false;
});
$("dl-wld").addEventListener("click", () => {
  const n = pic?.name || "", ext = /\.png$/i.test(n) ? "pgw" : /\.jpe?g$/i.test(n) ? "jgw" : "wld";
  saveBlob(new Blob([A.worldFileText(gt)], { type: "text/plain" }), `${base()}.${ext}`);
});
$("copy-gdal").addEventListener("click", (e) => copyText($("gdal").textContent, e.target));

window.addEventListener("hashchange", () => {
  const was = state.pic;
  readHash();
  if (state.pic !== was || !pic) setPic(state.pic === "own" && !ownPic ? "atlas" : state.pic, { keepPoints: true });
  else update();
});
new ResizeObserver(() => { const had = panes.img.w; sizePanes(); if (!had || !panes.img.view) resetViews(); draw(); }).observe($("stage"));
shareLinks("playproj: Affine", { height: 560 });

fetch(new URL("../data/countries-110m.json", import.meta.url))
  .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
  .catch((e) => { $("pic-status").textContent = `The countries did not load (${e.message}).`; return []; })
  .then((d) => {
    countries = d;
    if (state.pic === "own") { state.pic = "atlas"; $("pic-status").textContent = "Your own image is not kept in the link; pick it again to see the points on it."; }
    const msg = $("pic-status").textContent;
    setPic(state.pic, { keepPoints: true });
    $("pic-status").textContent = msg;
  });
