// playproj: for example.
//
// A storyboard after Mike Bostock's 2013 talk "For Example": adaptive
// resampling in d3-geo, what the original example showed, and why it
// matters. Each step is a caption, a drawing on one canvas, and at most one
// slider.

import { loadCoastline } from "./data.js";
import { coastRings, landPolygons } from "../src/core/landmesh.js";
import { naivePath, resampleArc } from "../src/core/mishaps.js";

const d3 = window.d3;
const D2R = Math.PI / 180;
const DEG = "\u00b0";

const C = {
  bg: "#05070d",
  sphere: "#0d2240",
  grat: "#4a6286",
  equator: "#ff4d4d",
  land: "#6ab787",
  landNaive: "#ff7a59",
  ink: "#dfe7f2",
  muted: "#8a97ab",
  mid: "#ffd34d"
};

// ---------------------------------------------------------------- geometry

// A parallel or meridian as a LineString with a vertex every `step` degrees.
function sampled(kind, value, step) {
  const pts = [];
  if (kind === "parallel") for (let x = -180; x <= 180; x += step) pts.push([x, value]);
  else for (let y = -90; y <= 90; y += step) pts.push([value, y]);
  return { type: "LineString", coordinates: pts };
}
function graticule(step) {
  const lines = [];
  for (let lon = -180; lon < 180; lon += 30) lines.push(sampled("meridian", lon, step).coordinates);
  for (let lat = -60; lat <= 60; lat += 30) if (lat) lines.push(sampled("parallel", lat, step).coordinates);
  return { type: "MultiLineString", coordinates: lines };
}

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
function dots(ctx, pts, r, color) {
  ctx.fillStyle = color;
  for (const p of pts) { ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 2 * Math.PI); ctx.fill(); }
}
function label(ctx, text, x, y, color = C.muted, align = "center") {
  ctx.fillStyle = color; ctx.font = "13px system-ui, sans-serif";
  ctx.textAlign = align; ctx.textBaseline = "top";
  ctx.fillText(text, x, y);
}

// The equirectangular projection rolled by gamma about its centre, with the
// page turned back by `turn` degrees: the transverse aspect (Cassini) when
// both are 90. The flawed example rolls a little short of 90 and turns the
// page the full 90, so the map stays upright and the equator bends.
function rolled(gamma, cx, cy, scale, turn = 90) {
  const p = d3.geoEquirectangular().rotate([0, 0, gamma]).scale(scale).translate([0, 0]);
  const c = Math.cos(-turn * D2R), s = Math.sin(-turn * D2R);
  return {
    p,
    proj: (ll) => { const q = p(ll); return [cx + c * q[0] - s * q[1], cy + s * q[0] + c * q[1]]; },
    withCanvas(ctx, fn) {
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(-turn * D2R);
      fn(d3.geoPath(p, ctx)); ctx.restore();
    }
  };
}

// ---------------------------------------------------------------- steps

let land = null;          // MultiPolygon, d3 winding
let landPolys = [];       // the same as single polygons, for the naive drawing
const GAMMA = 80;

const steps = [
  {
    title: "The flawed example",
    caption: "Three drawings of the same graticule, with the equator in red, in a map projection that bends it. " +
      "Left: a vertex every 90 degrees, joined with straight lines. Middle: a vertex every 4 degrees, better, but still " +
      "kinked where the bending is strongest and wasteful where it is not. Right: a vertex every 90 degrees again, but " +
      "d3 adds points only where the projected line curves. It is a good example of a clever trick, and almost " +
      "nobody who sees it knows what they are looking at.",
    draw(ctx, w, h) {
      const pw = w / 3, sc = Math.min((pw - 20) / Math.PI, (h - 80) / (2 * Math.PI));
      const cases = [[90, 0, "every 90" + DEG], [4, 0, "every 4" + DEG], [90, 0.5, "adaptive"]];
      cases.forEach(([step, prec, name], k) => {
        const r = rolled(GAMMA, pw * (k + 0.5), h / 2, sc);
        r.p.precision(prec);
        r.withCanvas(ctx, (path) => {
          strokeGeo(ctx, path, graticule(step), C.grat, 1);
          strokeGeo(ctx, path, sampled("parallel", 0, step), C.equator, 2.5);
          strokeGeo(ctx, path, { type: "Sphere" }, C.muted, 1);
        });
        label(ctx, name, pw * (k + 0.5), h / 2 + sc * Math.PI + 10);
      });
    }
  },
  {
    title: "What are we looking at?",
    caption: "Lines of constant latitude and longitude, the parallels and meridians, form a grid on the sphere called " +
      "a graticule. The red parallel is the equator. Drag to turn the globe.",
    drag: true,
    draw(ctx, w, h, _t, rot) {
      const p = d3.geoOrthographic().fitExtent([[40, 40], [w - 40, h - 40]], { type: "Sphere" }).rotate(rot);
      const path = d3.geoPath(p, ctx);
      fillGeo(ctx, path, { type: "Sphere" }, C.sphere);
      if (land) fillGeo(ctx, path, land, "rgba(106,183,135,0.35)");
      strokeGeo(ctx, path, d3.geoGraticule10(), C.grat, 1);
      strokeGeo(ctx, path, sampled("parallel", 0, 2), C.equator, 2.5);
    }
  },
  {
    title: "Flattened",
    caption: "Flatten the sphere with the simplest map projection there is, the equirectangular or plate carree: " +
      "longitude along x, latitude along y. In this normal aspect the equator is a straight line, and so is every " +
      "other parallel and meridian.",
    draw(ctx, w, h) {
      const p = d3.geoEquirectangular().fitExtent([[30, 30], [w - 30, h - 30]], { type: "Sphere" });
      const path = d3.geoPath(p, ctx);
      fillGeo(ctx, path, { type: "Sphere" }, C.sphere);
      if (land) fillGeo(ctx, path, land, "rgba(106,183,135,0.35)");
      strokeGeo(ctx, path, d3.geoGraticule10(), C.grat, 1);
      strokeGeo(ctx, path, sampled("parallel", 0, 2), C.equator, 2.5);
    }
  },
  {
    title: "Turned on its side",
    caption: "Now roll the sphere about the centre of the map, turning the page with it. At 90 degrees this is the " +
      "transverse aspect, the Cassini projection: the poles sit at the middle of the top and bottom, and the equator " +
      "is straight once more. Just short of 90 the equator is bent hard, and that is the view in the flawed example.",
    param: { label: "Roll", min: 0, max: 90, value: GAMMA, fmt: (v) => Math.round(v) + DEG },
    draw(ctx, w, h, g) {
      // turn the page with the roll
      const sc = Math.min((w - 40) / (2 * Math.PI), (h - 40) / (2 * Math.PI));
      const r = rolled(g, w / 2, h / 2, sc, g);
      r.withCanvas(ctx, (path) => {
        fillGeo(ctx, path, { type: "Sphere" }, C.sphere);
        if (land) fillGeo(ctx, path, land, "rgba(106,183,135,0.35)");
        strokeGeo(ctx, path, d3.geoGraticule10(), C.grat, 1);
        strokeGeo(ctx, path, sampled("parallel", 0, 2), C.equator, 2.5);
      });
    }
  },
  {
    title: "How it works",
    caption: "Each pair of vertices is a great-arc edge. d3 projects the arc's midpoint (the dots) and measures how far " +
      "it lands from the straight chord between the projected ends (the short lines). Too far, and the edge is split " +
      "there and both halves are tested again; close enough, and the chord stands. Points go only where the line " +
      "curves. The slider is the tolerance in pixels (d3's projection.precision).",
    param: { label: "Tolerance", min: 0.3, max: 40, value: 6, log: true, fmt: (v) => v.toFixed(1) + " px" },
    draw(ctx, w, h, tol) {
      const sc = Math.min((w - 40) / Math.PI, (h - 40) / (2 * Math.PI));
      const r = rolled(GAMMA, w / 2, h / 2, sc);
      r.withCanvas(ctx, (path) => {
        fillGeo(ctx, path, { type: "Sphere" }, C.sphere);
        strokeGeo(ctx, path, d3.geoGraticule10(), "rgba(74,98,134,0.5)", 1);
      });
      drawResample(ctx, r.proj, [-90, 0], [0, 0], tol);
      drawResample(ctx, r.proj, [0, 0], [90, 0], tol);
    }
  },
  {
    title: "Zoom in",
    caption: "The test is in pixels, so the answer depends on scale. Zoom in and the same edge needs more points; " +
      "zoom out and it needs fewer. It is Douglas-Peucker line simplification run backwards: instead of removing " +
      "detail that will not show, it adds the detail the projection would otherwise lose.",
    param: { label: "Zoom", min: 0.25, max: 4, value: 1, log: true, fmt: (v) => v.toFixed(2) + "x" },
    draw(ctx, w, h, z) {
      const sc = Math.min((w - 40) / Math.PI, (h - 40) / (2 * Math.PI)) * z;
      const r = rolled(GAMMA, w / 2, h / 2, sc);
      r.withCanvas(ctx, (path) => {
        fillGeo(ctx, path, { type: "Sphere" }, C.sphere);
        strokeGeo(ctx, path, d3.geoGraticule10(), "rgba(74,98,134,0.5)", 1);
      });
      drawResample(ctx, r.proj, [-90, 0], [0, 0], 6);
      drawResample(ctx, r.proj, [0, 0], [90, 0], 6);
    }
  },
  {
    title: "Why it matters",
    caption: "The example showed what the trick does, but not why anyone needs it. Here is why: Antarctica in the " +
      "Albers equal-area conic, a projection used all the time. Natural Earth cuts Antarctica along the antimeridian " +
      "and runs the cut down to the pole and back. Without resampling those edges project as straight lines, they " +
      "cross the continent, and the fill turns inside out. With resampling they follow the arc they should.",
    param: { label: "Resampling", min: 0, max: 1, value: 0, steps: 1, fmt: (v) => (v ? "on" : "off") },
    draw(ctx, w, h, on) {
      const p = d3.geoConicEqualArea().parallels([29.5, 45.5]).rotate([96, 0])
        .fitExtent([[30, 30], [w - 30, h - 30]], { type: "Sphere" }).precision(on ? 0.5 : 0);
      const path = d3.geoPath(p, ctx);
      fillGeo(ctx, path, { type: "Sphere" }, C.sphere);
      strokeGeo(ctx, path, d3.geoGraticule10(), C.grat, 1);
      if (land) {
        ctx.beginPath(); path(land);
        ctx.fillStyle = on ? "rgba(106,183,135,0.6)" : "rgba(255,122,89,0.6)";
        ctx.fill("evenodd");
        ctx.strokeStyle = on ? C.land : C.landNaive; ctx.lineWidth = 1; ctx.stroke();
      }
      strokeGeo(ctx, path, { type: "Sphere" }, C.muted, 1);
    }
  },
  {
    title: "Any land can be Antarctica",
    caption: "Is Antarctica just a special case? It crosses the antimeridian and holds a pole, but only in the normal " +
      "aspect. Turn the globe and any land can cross the new seam. Top: the vertices rotated and joined straight, the " +
      "way a plane would. Bottom: d3 cuts the polygons at the seam after rotating, so they never cross it. Drag " +
      "either map to turn the world.",
    drag: true,
    draw(ctx, w, h, _t, rot) {
      const mw = Math.min(w - 40, (h - 70) * 1), mh = mw / 2;
      const x0 = (w - mw) / 2, y1 = 20, y2 = y1 + mh + 30;
      if (!land) return;
      // top: vertex by vertex
      ctx.save(); ctx.translate(x0, y1);
      ctx.fillStyle = C.sphere; ctx.fillRect(0, 0, mw, mh);
      ctx.beginPath(); naivePath(ctx, d3, landPolys, "eqc", mw, rot);
      ctx.fillStyle = "rgba(255,122,89,0.6)"; ctx.fill("evenodd");
      ctx.strokeStyle = C.landNaive; ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();
      label(ctx, "vertex by vertex", x0, y1 + mh + 4, C.muted, "left");
      // bottom: d3
      const p = d3.geoEquirectangular().rotate(rot).fitExtent([[x0, y2], [x0 + mw, y2 + mh]], { type: "Sphere" });
      const path = d3.geoPath(p, ctx);
      fillGeo(ctx, path, { type: "Sphere" }, C.sphere);
      fillGeo(ctx, path, land, "rgba(106,183,135,0.6)");
      strokeGeo(ctx, path, land, C.land, 1);
      label(ctx, "cut at the seam after rotating (d3)", x0, y2 + mh + 4, C.muted, "left");
    }
  }
];

function drawResample(ctx, proj, a, b, tol) {
  const { tests, points } = resampleArc(proj, a, b, tol);
  // the true curve, finely sampled, underneath
  ctx.beginPath();
  for (let k = 0; k <= 200; k++) {
    const q = proj([a[0] + ((b[0] - a[0]) * k) / 200, 0]);
    if (k) ctx.lineTo(...q); else ctx.moveTo(...q);
  }
  ctx.strokeStyle = "rgba(255,77,77,0.35)"; ctx.lineWidth = 6; ctx.stroke();
  // the resampled line
  ctx.beginPath(); points.forEach((p, k) => (k ? ctx.lineTo(...p) : ctx.moveTo(...p)));
  ctx.strokeStyle = C.equator; ctx.lineWidth = 2; ctx.stroke();
  // each test: the midpoint and its distance to the chord
  ctx.lineWidth = 1.5;
  for (const t of tests) {
    ctx.strokeStyle = t.split ? C.mid : C.muted;
    ctx.beginPath(); ctx.moveTo(...t.foot); ctx.lineTo(...t.p); ctx.stroke();
  }
  dots(ctx, tests.filter((t) => !t.split).map((t) => t.p), 2, C.muted);
  dots(ctx, points, 3.5, C.mid);
  stats += points.length;
}
let stats = 0;   // points kept by the resampling drawn in this frame

// ---------------------------------------------------------------- state and panel

const $ = (id) => document.getElementById(id);
const canvas = $("view");
const ui = {
  title: $("step-title"), caption: $("caption"), param: $("param"), paramRow: $("param-row"),
  paramLabel: $("param-label"), paramOut: $("param-out"), steps: $("steps"), count: $("count")
};
const embed = new URLSearchParams(location.search).has("embed");
const state = { s: 0, p: null, rot: [-10, -20, 0] };

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  state.s = Math.max(0, Math.min(steps.length - 1, Math.round(+h.get("s") || 0)));
  state.p = h.has("p") && isFinite(+h.get("p")) ? +h.get("p") : null;
  const r = (h.get("rot") || "").split(",").map(Number);
  state.rot = r.length === 2 && r.every(isFinite) ? [r[0], r[1], 0] : [-10, -20, 0];
}
let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const h = new URLSearchParams();
    if (state.s) h.set("s", state.s);
    if (state.p !== null) h.set("p", +state.p.toFixed(3));
    const st = steps[state.s];
    if (st.drag) h.set("rot", state.rot.slice(0, 2).map((x) => Math.round(x)).join(","));
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
  return pr ? (state.p === null ? pr.value : state.p) : null;
}

// sliders run 0..1; log parameters map exponentially
function toSlider(pr, v) { return pr.log ? Math.log(v / pr.min) / Math.log(pr.max / pr.min) : (v - pr.min) / (pr.max - pr.min); }
function fromSlider(pr, x) {
  const v = pr.log ? pr.min * Math.pow(pr.max / pr.min, x) : pr.min + x * (pr.max - pr.min);
  return pr.steps ? Math.round(v) : v;
}

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
    ui.param.step = pr.steps ? 1 : 0.001;
    ui.param.value = pr.steps ? v : toSlider(pr, v);
    ui.paramOut.textContent = pr.fmt(v) + (stats ? `, ${stats} points` : "");
  }
  canvas.style.cursor = st.drag ? "grab" : "default";
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
  stats = 0;
  steps[state.s].draw(ctx, w, h, paramValue(), state.rot);
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

// drag to turn the globe on the steps that allow it
let dragFrom = null;
canvas.addEventListener("pointerdown", (e) => {
  if (!steps[state.s].drag) return;
  dragFrom = { x: e.clientX, y: e.clientY, rot: state.rot.slice() };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragFrom) return;
  const k = 0.4;
  state.rot = [dragFrom.rot[0] + (e.clientX - dragFrom.x) * k,
    Math.max(-90, Math.min(90, dragFrom.rot[1] - (e.clientY - dragFrom.y) * k)), 0];
  sync();
});
canvas.addEventListener("pointerup", () => { dragFrom = null; });

function copy(text, btn) {
  const done = () => { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1200); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {});
}
const pageUrl = () => location.origin + location.pathname;
$("copy-link").addEventListener("click", (e) => copy(pageUrl() + location.hash, e.target));
$("copy-embed").addEventListener("click", (e) => copy(
  `<iframe src="${pageUrl()}?embed=1${location.hash}" width="100%" height="520" style="border:0" loading="lazy" title="For example"></iframe>`,
  e.target));
$("open-full").href = pageUrl() + location.hash;

new ResizeObserver(sync).observe(canvas);
window.addEventListener("hashchange", () => { readHash(); sync(); });

if (embed) {
  document.body.classList.add("embed");
  $("open-full").hidden = false;
}

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
  // naive drawing wants longitudes as data arrives, in -180..180
  const wrap = (x) => ((x + 540) % 360) - 180;
  landPolys = polys.map((rings) => ({ type: "Polygon", coordinates: rings.map((r) => r.map(([x, y]) => [wrap(x), y])) }));
}

readHash();
sync();
loadLand().then(() => { sync(); document.body.classList.add("ready"); });
