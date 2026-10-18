// playproj: homage.
//
// A storyboard of map projections that people have argued about in public,
// and a nod to those who taught the rest of us to look: the UN emblem,
// Greenland and Africa, Gall-Peters on The West Wing, Equal Earth, Fuller's
// Dymaxion, and xkcd 977. Same step framework as the For example page.

import { loadCoastline } from "./data.js";
import { coastRings, landPolygons } from "../src/core/landmesh.js";
import { worldProjection, polar, slide, PROJ, icosahedron, unfold, trueSize } from "../src/core/homage-geo.js";
import { shareLinks } from "../src/scene/index.js";

const d3 = window.d3;
const D2R = Math.PI / 180;
const DEG = "\u00b0";

const C = {
  bg: "#05070d",
  sphere: "#0d2240",
  grat: "#4a6286",
  land: "rgba(106,183,135,0.55)",
  landLine: "#6ab787",
  green: "#ffd34d",          // Greenland, and its copy
  greenFill: "rgba(255,211,77,0.55)",
  un: "#4b92db",
  ink: "#dfe7f2",
  muted: "#8a97ab",
  cut: "#ff7a59"
};

// ---------------------------------------------------------------- drawing helpers

function strokeGeo(ctx, path, geo, color, width, dash) {
  ctx.beginPath(); path(geo);
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.setLineDash(dash || []);
  ctx.stroke(); ctx.setLineDash([]);
}
function fillGeo(ctx, path, geo, color) {
  ctx.beginPath(); path(geo);
  ctx.fillStyle = color; ctx.fill();
}
function label(ctx, text, x, y, color = C.muted, align = "center", font = "13px system-ui, sans-serif") {
  ctx.fillStyle = color; ctx.font = font;
  ctx.textAlign = align; ctx.textBaseline = "top";
  ctx.fillText(text, x, y);
}
const parallel = (lat) => ({ type: "LineString", coordinates: d3.range(-180, 180.1, 2).map((x) => [x, lat]) });
const meridian = (lon, south = -90) => ({ type: "LineString", coordinates: d3.range(south, 90.1, 2).map((y) => [lon, y]) });

// A world map with land, graticule and outline, fitted to a box.
function world(ctx, p, box, opts = {}) {
  p.fitExtent(box, { type: "Sphere" });
  const path = d3.geoPath(p, ctx);
  fillGeo(ctx, path, { type: "Sphere" }, C.sphere);
  strokeGeo(ctx, path, d3.geoGraticule10(), "rgba(74,98,134,0.6)", 0.7);
  if (land) { fillGeo(ctx, path, land, C.land); strokeGeo(ctx, path, land, C.landLine, 0.6); }
  if (opts.greenland && greenland) {
    fillGeo(ctx, path, greenland, C.greenFill); strokeGeo(ctx, path, greenland, C.green, 1.2);
  }
  if (opts.copy) { fillGeo(ctx, path, opts.copy, C.greenFill); strokeGeo(ctx, path, opts.copy, C.green, 1.5); }
  strokeGeo(ctx, path, { type: "Sphere" }, C.muted, 1);
  return path;
}

// Greenland's trip to Africa: t = 0 at home, 1 sitting on the Congo basin.
const HOME = [-41, 74], AWAY = [20, 2];
function greenlandAt(t) {
  if (!greenland) return null;
  return slide(d3, greenland, HOME[0], t * (AWAY[1] - HOME[1]), t * (AWAY[0] - HOME[0]));
}
// how much bigger Mercator draws Greenland at home than at latitude lat
const mercInflation = (lat) => Math.pow(Math.cos(lat * D2R), -2);

// the box of a map with aspect ratio r (width / height), centred in w x h
function fitBox(w, h, r, pad = 30, below = 30) {
  const aw = w - 2 * pad, ah = h - 2 * pad - below;
  const mw = Math.min(aw, ah * r), mh = mw / r;
  const x0 = (w - mw) / 2, y0 = pad + (ah - mh) / 2;
  return [[x0, y0], [x0 + mw, y0 + mh]];
}

// ---------------------------------------------------------------- steps

let land = null;          // MultiPolygon, d3 winding
let greenland = null;     // Polygon
let countries = null;     // Natural Earth country parts, each rings of [lon, lat]
let dymax = null;         // the unfolded icosahedron

const XKCD = [
  ["merc", "Mercator"], ["vandg", "Van der Grinten"], ["robin", "Robinson"], ["wintri", "Winkel tripel"],
  ["hobodyer", "Hobo-Dyer"], ["eqc", "Plate carree"], ["gallpeters", "Gall-Peters"], ["dymaxion", "Dymaxion"]
];

const steps = [
  {
    title: "The UN emblem",
    caption: "The emblem of the United Nations, adopted in 1946, is a map of the world centred on the North Pole, " +
      "cut off at 60 degrees south and held in olive branches. Its projection is the azimuthal equidistant: every " +
      "distance from the pole is true, so the circles of latitude are evenly spaced. Switch to the Lambert azimuthal " +
      "equal-area and the same map keeps areas true instead, and the circles crowd towards the rim. Drawn here from " +
      "the coastlines; the real emblem is the UN's own artwork.",
    param: { label: "Projection", min: 0, max: 1, value: 0, steps: 1, fmt: (v) => (v ? "equal-area (laea)" : "equidistant (aeqd)") },
    draw(ctx, w, h, v) {
      const kind = v ? "laea" : "aeqd";
      const r = Math.min(w, h - 40) / 2 - 24, cx = w / 2, cy = (h - 40) / 2 + 4;
      const p = polar(d3, kind, -60).fitExtent([[cx - r, cy - r], [cx + r, cy + r]], { type: "Sphere" });
      const path = d3.geoPath(p, ctx);
      fillGeo(ctx, path, { type: "Sphere" }, C.un);
      if (land) fillGeo(ctx, path, land, "rgba(255,255,255,0.92)");
      for (const lat of [60, 30, 0, -30]) strokeGeo(ctx, path, parallel(lat), "rgba(255,255,255,0.8)", 1.2);
      for (let lon = 0; lon < 360; lon += 45) strokeGeo(ctx, path, meridian(lon, -59.5), "rgba(255,255,255,0.8)", 1.2);
      strokeGeo(ctx, path, { type: "Sphere" }, "#ffffff", 2);
      label(ctx, PROJ[kind] + " +lon_0=0, to 60" + DEG + "S", w / 2, h - 30);
    }
  },
  {
    title: "Down to the antipode",
    caption: "Why stop at 60 south? Carry either map on towards the South Pole and the last ring stretches round the " +
      "whole rim: in the equidistant map the South Pole is the outer circle, and Antarctica becomes a band around the " +
      "world. Left is the emblem's projection, right the equal-area one; the circles are the same parallels in both.",
    param: { label: "Down to", min: -60, max: -90, value: -60, fmt: (v) => Math.abs(v).toFixed(0) + DEG + "S" },
    draw(ctx, w, h, edge) {
      const pw = w / 2, r = Math.min(pw - 30, h - 80) / 2;
      ["aeqd", "laea"].forEach((kind, k) => {
        const cx = pw * (k + 0.5), cy = (h - 40) / 2 + 4;
        const p = polar(d3, kind, edge).fitExtent([[cx - r, cy - r], [cx + r, cy + r]], { type: "Sphere" });
        const path = d3.geoPath(p, ctx);
        fillGeo(ctx, path, { type: "Sphere" }, C.sphere);
        if (land) { fillGeo(ctx, path, land, C.land); strokeGeo(ctx, path, land, C.landLine, 0.6); }
        for (const lat of [60, 30, 0, -30, -60]) strokeGeo(ctx, path, parallel(lat), C.grat, 1);
        for (let lon = 0; lon < 360; lon += 45) strokeGeo(ctx, path, meridian(lon), C.grat, 1);
        strokeGeo(ctx, path, { type: "Sphere" }, C.muted, 1);
        label(ctx, PROJ[kind], cx, cy + r + 12);
      });
    }
  },
  {
    title: "Greenland and Africa",
    caption: "The Mercator projection keeps angles and small shapes, which is what a navigator needs, and pays for " +
      "it in area: a region is drawn bigger by the square of the secant of its latitude. Greenland looks about the size " +
      "of Africa; Africa is fourteen times bigger. Slide a copy of Greenland, the same shape and the same area, down to " +
      "the equator and watch it shrink.",
    param: { label: "Greenland", min: 0, max: 1, value: 0, fmt: (t) => (t < 0.01 ? "at home" : t > 0.99 ? "on the Congo" : "travelling") },
    draw(ctx, w, h, t) {
      const box = fitBox(w, h, 1);
      world(ctx, d3.geoMercator().clipExtent(null), box, { greenland: true, copy: t > 0.005 ? greenlandAt(t) : null });
      const lat = HOME[1] + t * (AWAY[1] - HOME[1]);
      label(ctx, `+proj=merc: at home Greenland is drawn ${(mercInflation(HOME[1]) / mercInflation(lat)).toFixed(1)} times the area of the copy`,
        w / 2, box[1][1] + 10);
    }
  },
  {
    title: "Every country at its true size",
    caption: "Do it for every country at once. Each one is drawn in a Lambert azimuthal equal-area projection about " +
      "its own centre, at the scale Mercator has on the equator, and set down where Mercator puts that centre. The " +
      "grey map behind is Mercator; the outlines are the countries as they are. Near the equator the two agree, and " +
      "towards the poles the true shapes shrink inside their Mercator selves. The slider blends each shape from " +
      "Mercator's to its true one.",
    param: { label: "Shape", min: 0, max: 1, value: 1, fmt: (k) => (k < 0.01 ? "Mercator" : k > 0.99 ? "true size" : "blending") },
    draw(ctx, w, h, k) {
      const box = fitBox(w, h, 1);
      const p = d3.geoMercator().fitExtent(box, { type: "Sphere" });
      const path = d3.geoPath(p, ctx);
      fillGeo(ctx, path, { type: "Sphere" }, C.sphere);
      strokeGeo(ctx, path, d3.geoGraticule10(), "rgba(74,98,134,0.6)", 0.7);
      if (!countries) return;
      for (const rings of countries) fillGeo(ctx, path, { type: "Polygon", coordinates: rings }, "rgba(138,151,171,0.35)");
      ctx.save();
      ctx.beginPath(); ctx.rect(box[0][0], box[0][1], box[1][0] - box[0][0], box[1][1] - box[0][1]); ctx.clip();
      for (const rings of countries) {
        const ts = trueSize(d3, rings, p.scale(), p.translate(), k);
        if (Math.abs(ts.centre[1]) > 80) continue;     // Antarctica has no Mercator centre
        ctx.beginPath();
        for (const r of ts.rings) r.forEach((q, i) => (i ? ctx.lineTo(...q) : ctx.moveTo(...q)));
        ctx.fillStyle = "rgba(106,183,135,0.45)"; ctx.fill("evenodd");
        ctx.strokeStyle = C.cut; ctx.lineWidth = 0.8; ctx.stroke();
      }
      ctx.restore();
      strokeGeo(ctx, path, { type: "Sphere" }, C.muted, 1);
      label(ctx, "+proj=laea +lon_0 +lat_0 at each centroid, placed by +proj=merc", w / 2, box[1][1] + 10);
    }
  },
  {
    title: "Cartographers for Social Equality",
    caption: "A nod to The West Wing, season 2, episode 16 (2001). A delegation from the fictional Cartographers for " +
      "Social Equality asks the White House to back a law putting the Gall-Peters projection in every public school " +
      "in place of Mercator, because Mercator makes the rich north look large and the south look small. Then they " +
      "turn the map upside down, since nothing on a sphere says north is up, and that is the part the staff cannot " +
      "get over. The yellow copy of Greenland sits on Africa at its true size.",
    param: { label: "Map", min: 0, max: 2, value: 0, steps: 1, fmt: (v) => ["Mercator", "Gall-Peters", "Gall-Peters, south up"][v] },
    draw(ctx, w, h, v) {
      const name = v ? "gallpeters" : "merc";
      const box = fitBox(w, h, v ? Math.PI / 2 : 1);
      ctx.save();
      if (v === 2) { ctx.translate(w / 2, (box[0][1] + box[1][1]) / 2); ctx.rotate(Math.PI); ctx.translate(-w / 2, -(box[0][1] + box[1][1]) / 2); }
      world(ctx, worldProjection(d3, name), box, { greenland: true, copy: greenlandAt(1) });
      ctx.restore();
      label(ctx, PROJ[name] + (v === 2 ? ", turned over" : ""), w / 2, box[1][1] + 10);
    }
  },
  {
    title: "Equal Earth",
    caption: "In 2017 Boston's public schools switched their wall maps to Gall-Peters. Bojan Savric, Bernhard Jenny " +
      "and Tom Patterson answered with Equal Earth (2018): equal-area like Gall-Peters, but with curved sides and " +
      "shapes that look like the continents people know. In 2025 the African Union backed the Correct The Map " +
      "campaign, which asks governments, schools and newsrooms to use it in place of Mercator. Slide Greenland and " +
      "it keeps its size wherever it goes.",
    param: { label: "Greenland", min: 0, max: 1, value: 1, fmt: (t) => (t < 0.01 ? "at home" : t > 0.99 ? "on the Congo" : "travelling") },
    draw(ctx, w, h, t) {
      const box = fitBox(w, h, 2.05);
      world(ctx, worldProjection(d3, "eqearth"), box, { greenland: true, copy: t > 0.005 ? greenlandAt(t) : null });
      label(ctx, PROJ.eqearth + " (Savric, Jenny and Patterson 2018)", w / 2, box[1][1] + 10);
    }
  },
  {
    title: "Dymaxion",
    caption: "Buckminster Fuller's Dymaxion map (1943, this icosahedral form 1954) puts the world on an icosahedron " +
      "and unfolds it flat, with no up and no centre. Each face here is a gnomonic projection from its centre (Fuller " +
      "used his own face projection, which differs a little), on Fuller's placement of the icosahedron. The net is " +
      "found, not copied: of the many ways to unfold the 20 faces, it keeps joined the edges that cross the most land, " +
      "so the cuts (in orange) fall in the sea, as Fuller arranged.",
    param: { label: "Face edges", min: 0, max: 1, value: 1, steps: 1, fmt: (v) => (v ? "shown" : "hidden") },
    draw(ctx, w, h, v) { drawDymaxion(ctx, [[20, 20], [w - 20, h - 40]], v); }
  },
  {
    title: "What your favourite says about you",
    caption: "xkcd 977 (Randall Munroe, 2011) reads your character from your favourite map projection. Several of " +
      "the projections it names are here, each matched to PROJ; step through them and draw your own conclusions, " +
      "then read the comic.",
    param: { label: "Projection", min: 0, max: XKCD.length - 1, value: 0, steps: 1, fmt: (v) => XKCD[v][1] },
    draw(ctx, w, h, v) {
      const [name, title] = XKCD[v];
      if (name === "dymaxion") {
        drawDymaxion(ctx, [[20, 20], [w - 20, h - 40]], 1);
        label(ctx, "Dymaxion: not in PROJ", w / 2, h - 30);
        return;
      }
      const p = worldProjection(d3, name);
      const b = d3.geoPath(p.scale(1).translate([0, 0])).bounds({ type: "Sphere" });
      const box = fitBox(w, h, Math.min(3, (b[1][0] - b[0][0]) / (b[1][1] - b[0][1])));
      world(ctx, p, box);
      label(ctx, `${title}: ${PROJ[name]}`, w / 2, box[1][1] + 10);
    }
  },
  {
    title: "Champions",
    caption: "Each circle is the same size on the Earth, ten degrees across. In an equal-area map they keep their " +
      "area and change their shape, which is the trade every projection makes in one form or another. The people " +
      "who taught the rest of us to see that trade are listed below.",
    draw(ctx, w, h) {
      const box = fitBox(w, h, 2.05);
      const path = world(ctx, worldProjection(d3, "eqearth"), box);
      for (let lon = -150; lon <= 180; lon += 30)
        for (let lat = -60; lat <= 60; lat += 30)
          fillGeo(ctx, path, d3.geoCircle().center([lon, lat]).radius(5)(), "rgba(255,211,77,0.7)");
      label(ctx, PROJ.eqearth, w / 2, box[1][1] + 10);
    }
  }
];

// ---------------------------------------------------------------- Dymaxion drawing

// Each face: a gnomonic projection about its centre, carried by the affine
// map that puts the face's three vertices on its triangle of the net.
function buildDymaxion() {
  const ico = icosahedron(d3);
  const onLand = (pt) => d3.geoContains(land, pt);
  const landOn = (a, b) => {
    const f = d3.geoInterpolate(ico.verts[a], ico.verts[b]);
    let n = 0;
    for (let k = 1; k < 24; k++) n += onLand(f(k / 24)) ? 1 : 0;
    return n;
  };
  const net = unfold(ico, landOn);
  if (!net) return null;
  // turn the net so it lies widest across the page
  let best = null;
  for (let a = 0; a < 180; a += 30) {
    const c = Math.cos(a * D2R), s = Math.sin(a * D2R);
    const pts = net.pos.flatMap((p) => Object.values(p)).map(([x, y]) => [c * x - s * y, s * x + c * y]);
    const bx = d3.extent(pts, (p) => p[0]), by = d3.extent(pts, (p) => p[1]);
    const r = (bx[1] - bx[0]) / (by[1] - by[0]);
    if (!best || r > best.r) best = { r, a, bx, by };
  }
  const c = Math.cos(best.a * D2R), s = Math.sin(best.a * D2R);
  const faces = ico.faces.map((f, k) => {
    const centre = d3.geoCentroid({ type: "MultiPoint", coordinates: f.map((v) => ico.verts[v]) });
    const g = d3.geoGnomonic().rotate([-centre[0], -centre[1]]).scale(1).translate([0, 0]).clipAngle(60);
    return {
      verts: f, g,
      src: f.map((v) => g(ico.verts[v])),
      dst: f.map((v) => { const [x, y] = net.pos[k][v]; return [c * x - s * y, -(s * x + c * y)]; })
    };
  });
  const xs = faces.flatMap((f) => f.dst.map((p) => p[0])), ys = faces.flatMap((f) => f.dst.map((p) => p[1]));
  return { ico, net, faces, ext: [[d3.min(xs), d3.min(ys)], [d3.max(xs), d3.max(ys)]] };
}

// the affine map taking three points a onto three points b
function affine(a, b) {
  const [[x0, y0], [x1, y1], [x2, y2]] = a;
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  const solve = (u0, u1, u2) => {
    const p = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / det;
    const q = ((x1 - x0) * (u2 - u0) - (x2 - x0) * (u1 - u0)) / det;
    return [p, q, u0 - p * x0 - q * y0];
  };
  const X = solve(b[0][0], b[1][0], b[2][0]), Y = solve(b[0][1], b[1][1], b[2][1]);
  return (x, y) => [X[0] * x + X[1] * y + X[2], Y[0] * x + Y[1] * y + Y[2]];
}

function drawDymaxion(ctx, box, edges) {
  if (!land) return;
  if (!dymax) dymax = buildDymaxion();
  if (!dymax) { label(ctx, "this net folds over itself", (box[0][0] + box[1][0]) / 2, box[0][1] + 20); return; }
  const [[ex0, ey0], [ex1, ey1]] = dymax.ext;
  const k = Math.min((box[1][0] - box[0][0]) / (ex1 - ex0), (box[1][1] - box[0][1]) / (ey1 - ey0));
  const ox = (box[0][0] + box[1][0]) / 2 - (k * (ex0 + ex1)) / 2, oy = (box[0][1] + box[1][1]) / 2 - (k * (ey0 + ey1)) / 2;
  const screen = (p) => [ox + k * p[0], oy + k * p[1]];
  for (const f of dymax.faces) {
    const tri = f.dst.map(screen);
    const m = affine(f.src, tri);
    const stream = (s) => f.g.stream(d3.geoTransform({ point(x, y) { const q = m(x, y); this.stream.point(q[0], q[1]); } }).stream(s));
    f.g.precision(0.5 / k);
    const path = d3.geoPath({ stream }, ctx);
    ctx.save();
    ctx.beginPath(); tri.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath();
    ctx.fillStyle = C.sphere; ctx.fill();
    ctx.clip();
    strokeGeo(ctx, path, d3.geoGraticule10(), "rgba(74,98,134,0.6)", 0.7);
    fillGeo(ctx, path, land, C.land); strokeGeo(ctx, path, land, C.landLine, 0.6);
    ctx.restore();
    if (edges) {
      ctx.beginPath(); tri.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath();
      ctx.strokeStyle = "rgba(138,151,171,0.6)"; ctx.lineWidth = 0.8; ctx.stroke();
    }
  }
  // the outline of the net is where the cuts are
  if (edges) {
    const cuts = new Set(dymax.net.cut.map((e) => e.s.slice().sort((a, b) => a - b).join("-")));
    ctx.strokeStyle = C.cut; ctx.lineWidth = 1.6;
    for (const f of dymax.faces)
      for (let i = 0; i < 3; i++) {
        const a = f.verts[i], b = f.verts[(i + 1) % 3];
        if (!cuts.has([a, b].sort((x, y) => x - y).join("-"))) continue;
        ctx.beginPath(); ctx.moveTo(...screen(f.dst[i])); ctx.lineTo(...screen(f.dst[(i + 1) % 3])); ctx.stroke();
      }
  }
}

// ---------------------------------------------------------------- state and panel

const $ = (id) => document.getElementById(id);
const canvas = $("view");
const ui = {
  title: $("step-title"), caption: $("caption"), param: $("param"), paramRow: $("param-row"),
  paramLabel: $("param-label"), paramOut: $("param-out"), steps: $("steps"), count: $("count")
};
const state = { s: 0, p: null };

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  state.s = Math.max(0, Math.min(steps.length - 1, Math.round(+h.get("s") || 0)));
  state.p = h.has("p") && isFinite(+h.get("p")) ? +h.get("p") : null;
}
let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const h = new URLSearchParams();
    if (state.s) h.set("s", state.s);
    if (state.p !== null) h.set("p", +state.p.toFixed(3));
    const s = h.toString();
    history.replaceState(null, "", s ? "#" + s : location.pathname + location.search);
  }, 200);
}

steps.forEach((st, k) => {
  const li = document.createElement("li");
  li.textContent = st.title;
  li.addEventListener("click", () => go(k));
  ui.steps.appendChild(li);
});

function paramValue() {
  const pr = steps[state.s].param;
  if (!pr) return null;
  const v = state.p === null ? pr.value : state.p;
  const lo = Math.min(pr.min, pr.max), hi = Math.max(pr.min, pr.max);
  return Math.max(lo, Math.min(hi, pr.steps ? Math.round(v) : v));
}
const toSlider = (pr, v) => (v - pr.min) / (pr.max - pr.min);
const fromSlider = (pr, x) => pr.min + x * (pr.max - pr.min);

function updatePanel() {
  const st = steps[state.s];
  ui.title.textContent = `${state.s + 1}. ${st.title}`;
  ui.caption.textContent = st.caption;
  ui.count.textContent = `${state.s + 1} of ${steps.length}`;
  $("prev").disabled = state.s === 0;
  $("next").disabled = state.s === steps.length - 1;
  [...ui.steps.children].forEach((li, k) => li.classList.toggle("active", k === state.s));
  const pr = st.param;
  ui.paramRow.style.display = ui.param.style.display = pr ? "" : "none";
  if (pr) {
    const v = paramValue();
    ui.paramLabel.textContent = pr.label;
    if (pr.steps) { ui.param.min = pr.min; ui.param.max = pr.max; ui.param.step = 1; ui.param.value = v; }
    else { ui.param.min = 0; ui.param.max = 1; ui.param.step = 0.001; ui.param.value = toSlider(pr, v); }
    ui.paramOut.textContent = pr.fmt(v);
  }
}

function draw() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  steps[state.s].draw(ctx, w, h, paramValue());
  updatePanel();
}

let rafPending = false;
function sync() {
  writeHash();
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; draw(); });
}

function go(k) {
  state.s = Math.max(0, Math.min(steps.length - 1, k));
  state.p = null;
  sync();
}
$("prev").addEventListener("click", () => go(state.s - 1));
$("next").addEventListener("click", () => go(state.s + 1));
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" && e.target.type !== "range") return;
  if (e.key === "ArrowRight") go(state.s + 1);
  if (e.key === "ArrowLeft") go(state.s - 1);
});
ui.param.addEventListener("input", () => {
  const pr = steps[state.s].param;
  state.p = pr.steps ? +ui.param.value : fromSlider(pr, +ui.param.value);
  sync();
});
canvas.style.cursor = "default";

shareLinks("Homage", { height: 520 });

new ResizeObserver(sync).observe(canvas);
window.addEventListener("hashchange", () => { readHash(); sync(); });

// land polygons from the coastlines, wound the way d3 wants
async function loadLand() {
  const coast = await loadCoastline("110m");
  const pairs = (r) => {
    const o = [];
    for (let i = 0; i < r.length; i += 2) o.push([r[i], r[i + 1]]);
    o.push(o[0]);
    return o;
  };
  const wind = (r, outer) => {
    const big = d3.geoArea({ type: "Polygon", coordinates: [r] }) > 2 * Math.PI;
    return big === outer ? r.reverse() : r;
  };
  const polys = landPolygons(coastRings(coast)).map((p) => [wind(pairs(p.outer), true), ...p.holes.map((h) => wind(pairs(h), false))]);
  land = { type: "MultiPolygon", coordinates: polys };
  const g = polys.find((rings) => d3.geoContains({ type: "Polygon", coordinates: rings }, HOME));
  greenland = g ? { type: "Polygon", coordinates: g } : null;
  // country parts (Natural Earth 110m via world-atlas), flat rings
  const parts = await fetch(new URL("../data/countries-110m.json", import.meta.url)).then((r) => r.json());
  countries = parts.map((rings) => rings.map((r) => {
    const o = [];
    for (let i = 0; i < r.length; i += 2) o.push([r[i], r[i + 1]]);
    return o;
  }));
}

readHash();
sync();
loadLand().then(() => { sync(); document.body.classList.add("ready"); });
