// AAT grid page: a mini aatgrid. One tile lattice in every UTM south zone
// (src/core/aatgrid.js), drawn on the globe for the chosen zone and
// resolution, with the picked point's 60 m tile and the finer tiles nested
// in it, the next zones' lattices, and the Sentinel-2 tiles over the point.

import * as THREE from "three";
import * as a from "../src/core/aatgrid.js";
import * as g from "../src/core/mgrs.js";
import { loadCoastline } from "./data.js";
import { basemapControl } from "./basemap-ui.js";
import { makeStage, readParams, hashWriter, shareLinks } from "../src/scene/index.js";

const DEG = "\u00b0";
const D2R = Math.PI / 180;

const COLORS = {
  bg: 0x05070d,
  own: 0x8cc4ff,
  past: 0x8cc4ff,
  nb: 0xb48cff,
  edge: 0xdfe7f2,
  pick: 0xffd34d,
  fine: 0xffb347,
  s2: 0x5fd3c6,
  aat: 0xff8a65,
  coast: 0xd7ecff
};

// station and island positions (degrees), as in the aatgrid explorer
const PLACES = [
  { name: "Heard Island", lon: 73.3868, lat: -53.0243 },
  { name: "Macquarie Island", lon: 158.87, lat: -54.62 },
  { name: "Mawson", lon: 62.8736, lat: -67.6028 },
  { name: "Davis", lon: 77.9675, lat: -68.5767 },
  { name: "Casey", lon: 110.5269, lat: -66.2821 },
  { name: "Amery Ice Shelf", lon: 70.5, lat: -70.3 }
];

// ---------------------------------------------------------------- state

const defaults = { zone: 43, res: 60, pt: "77.9675,-68.5767", past: 1, nb: 1, s2: 1, aat: 1, bm: "none", cam: null };
const state = { ...defaults };

const parsePt = (s) => {
  const p = String(s).split(",").map(Number);
  return p.length === 2 && p.every(isFinite) && p[1] < 0 && p[1] >= -90 ? [((p[0] + 540) % 360) - 180, p[1]] : null;
};

function readHash() {
  readParams(state, defaults, { bm: String, pt: (raw) => (raw === "" || parsePt(raw) ? raw : defaults.pt) });
  state.zone = Math.max(1, Math.min(60, Math.round(state.zone)));
  if (!a.RESOLUTIONS.includes(state.res)) state.res = defaults.res;
}
const writeHash = hashWriter(state, defaults);

// ---------------------------------------------------------------- scene

// lon/lat to the scene: north is +y, lon 0 towards +z, lon 90 E towards +x
function sph(lon, lat, r = 1, out = [0, 0, 0], i = 0) {
  const p = lat * D2R, l = lon * D2R, c = Math.cos(p);
  out[i] = r * c * Math.sin(l); out[i + 1] = r * Math.sin(p); out[i + 2] = r * c * Math.cos(l);
  return out;
}
const LIFT = 1 + 1.2e-4;

const stage = document.getElementById("three");
const { renderer, scene, camera, controls, setCamera, resize } = makeStage(stage, {
  bg: COLORS.bg, near: 0.0005, far: 50,
  onCamera: (c) => { state.cam = c; writeHash(); }
});
controls.minDistance = 0.002;
controls.zoomSpeed = 1.5;
const maxTex = Math.min(8192, renderer.capabilities.maxTextureSize);

function defaultCam() {
  const pt = parsePt(state.pt);
  const lon = pt ? pt[0] : a.zoneEdges(state.zone)[0] + 3;
  const d = sph(lon, -72, 2.6), T = sph(lon, -66, 0.35);
  return [...d.map((v, k) => v + T[k]), ...T];
}

// the globe: a plain sphere, or the basemap, with the south shaded
const globeCanvas = document.createElement("canvas");
globeCanvas.width = Math.min(4096, maxTex); globeCanvas.height = globeCanvas.width / 2;
const globeTex = new THREE.CanvasTexture(globeCanvas);
globeTex.colorSpace = THREE.SRGBColorSpace;
globeTex.anisotropy = 8;

function drawGlobe() {
  const W = globeCanvas.width, H = globeCanvas.height, ctx = globeCanvas.getContext("2d");
  ctx.fillStyle = "#1a2433"; ctx.fillRect(0, 0, W, H);
  const world = basemap.world;
  if (world) ctx.drawImage(world.canvas, 0, 0, W, H);
  // the zones' own ground, south of 45 S, alternating
  const py = (lat) => ((90 - lat) / 180) * H;
  for (let z = 1; z <= 60; z++) {
    const [w] = a.zoneEdges(z);
    ctx.fillStyle = z % 2 ? "rgba(40,62,96,0.55)" : "rgba(30,48,76,0.55)";
    if (world) ctx.globalAlpha = 0.45;
    ctx.fillRect(((w + 180) / 360) * W, py(-45), W / 60, H - py(-45));
    ctx.globalAlpha = 1;
  }
  globeTex.needsUpdate = true;
}

const globeGeom = (() => {
  const nx = 720, ny = 360, pos = [], uv = [], idx = [];
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      const lon = -180 + (360 * i) / nx, lat = 90 - (180 * j) / ny;
      pos.push(...sph(lon, lat)); uv.push(i / nx, 1 - j / ny);
    }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const p = j * (nx + 1) + i, q = p + nx + 1;
      idx.push(p, q, p + 1, p + 1, q, q + 1);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
})();
const globe = new THREE.Mesh(globeGeom, new THREE.MeshBasicMaterial({ map: globeTex, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
scene.add(globe);

const lineMat = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: false });

// lon/lat segments [lon0, lat0, lon1, lat1, ...] as lines on the globe
function segLines(segs, color, opacity, r = LIFT) {
  const pos = new Float32Array((segs.length / 2) * 3);
  for (let i = 0, j = 0; i < segs.length; i += 2, j += 3) sph(segs[i], segs[i + 1], r, pos, j);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return new THREE.LineSegments(geo, lineMat(color, opacity));
}
// polylines [[lon, lat], ...] as segments
function ringSegs(rings) {
  const s = [];
  for (const r of rings) for (let i = 1; i < r.length; i++) s.push(r[i - 1][0], r[i - 1][1], r[i][0], r[i][1]);
  return s;
}
function replace(group, ...objs) {
  for (const o of group.children) { o.geometry.dispose(); o.material.dispose(); }
  group.clear();
  for (const o of objs) if (o) group.add(o);
}

const coastGroup = new THREE.Group(), zoneGroup = new THREE.Group(), latticeGroup = new THREE.Group(),
  nbGroup = new THREE.Group(), pickGroup = new THREE.Group(), s2Group = new THREE.Group(), aatGroup = new THREE.Group();
scene.add(coastGroup, zoneGroup, latticeGroup, nbGroup, pickGroup, s2Group, aatGroup);
const marker = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: COLORS.pick }));
scene.add(marker);

// every zone's edges south of 45 S, faint
{
  const s = [];
  for (let z = 1; z <= 60; z++) {
    const [w] = a.zoneEdges(z);
    for (let lat = -45; lat > -90; lat -= 1) s.push(w, lat, w, Math.max(-90, lat - 1));
  }
  for (let lon = -180; lon < 180; lon += 1) s.push(lon, -45, lon + 1, -45);
  zoneGroup.add(segLines(s, COLORS.edge, 0.18));
}

// the AAT claim: south of 60 S, 45 E to 160 E less 136 E to 142 E
{
  const s = [];
  for (const [w, e] of [[45, 136], [142, 160]]) {
    for (const lon of [w, e]) for (let lat = -60; lat > -90; lat -= 1) s.push(lon, lat, lon, lat - 1);
    for (let lon = w; lon < e; lon += 0.5) s.push(lon, -60, Math.min(e, lon + 0.5), -60);
  }
  aatGroup.add(segLines(s, COLORS.aat, 0.8, LIFT * (1 + 2e-5)));
}

function buildCoast(lines) {
  const s = [];
  for (const l of lines)
    for (let i = 2; i < l.length; i += 2) {
      if (l[i + 1] > -40 && l[i - 1] > -40) continue;
      if (Math.abs(l[i] - l[i - 2]) > 180) continue;
      s.push(l[i - 2], l[i - 1], l[i], l[i + 1]);
    }
  replace(coastGroup, segLines(s, COLORS.coast, 0.85));
}

// ---------------------------------------------------------------- the lattice

const LAT0 = -84, LAT1 = -45, PAST = 1.5;
const latticeCache = new Map();
function lattice(zone, res, past) {
  const k = `${zone}/${res}/${past}`;
  if (!latticeCache.has(k)) {
    if (latticeCache.size > 12) latticeCache.clear();
    latticeCache.set(k, a.latticeSegments(zone, res, { lat0: LAT0, lat1: LAT1, past, step: Math.min(a.tileSize(res), 14400) }));
  }
  return latticeCache.get(k);
}

let builtLattice = "";
function buildLattice() {
  const key = `${state.zone}/${state.res}/${state.past}/${state.nb}`;
  if (key === builtLattice) return;
  builtLattice = key;
  const L = lattice(state.zone, state.res, state.past ? PAST : 0);
  replace(latticeGroup,
    segLines(L.inside, COLORS.own, state.res === 10 ? 0.55 : 0.75),
    state.past ? segLines(L.outside, COLORS.past, 0.3) : null);
  const nb = [];
  if (state.nb)
    for (const z of [state.zone - 1, state.zone + 1]) {
      const zz = ((z + 59) % 60) + 1;
      nb.push(segLines(lattice(zz, state.res, 0).inside, COLORS.nb, 0.45, LIFT * (1 - 1e-5)));
    }
  replace(nbGroup, ...nb);
}

// the picked point's 60 m tile, the finer tiles in it, and its tile at the
// chosen resolution filled
const fillMat = new THREE.MeshBasicMaterial({ color: COLORS.pick, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false });
function tileFill(t, n = 12) {
  const pos = [], idx = [];
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const [lon, lat] = a.fromZone(t.zone, t.xmin + ((t.xmax - t.xmin) * i) / n, t.ymin + ((t.ymax - t.ymin) * j) / n);
      pos.push(...sph(lon, lat, LIFT * (1 + 1e-5)));
    }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const p = j * (n + 1) + i, q = p + n + 1;
      idx.push(p, p + 1, q, p + 1, q + 1, q);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return new THREE.Mesh(geo, fillMat.clone());
}

function pickTiles() {
  const pt = parsePt(state.pt);
  if (!pt) return null;
  // the chosen zone while the point is in it or the next one, else its own
  const dl = Math.abs(((pt[0] - g.centralMeridian(state.zone) + 540) % 360) - 180);
  const zone = dl <= 9 ? state.zone : a.zoneOf(pt[0]);
  const at = (res) => a.tileAt(pt[0], pt[1], res, zone);
  return { pt, zone, own: at(state.res), p60: at(60), t20: at(20), t10: at(10) };
}

let builtPick = "";
function buildPick(P) {
  const key = P ? `${P.own.id}` : "";
  if (key === builtPick) return;
  builtPick = key;
  if (!P) return replace(pickGroup);
  const r = LIFT * (1 + 3e-5);
  replace(pickGroup,
    tileFill(P.own),
    segLines(ringSegs(a.childrenOf(P.p60, 10).map((t) => a.tileRing(t, 2))), COLORS.fine, 0.3, r),
    segLines(ringSegs(a.childrenOf(P.p60, 20).map((t) => a.tileRing(t, 4))), COLORS.fine, 0.9, r),
    segLines(ringSegs([a.tileRing(P.p60, 16)]), COLORS.pick, 1, r * (1 + 1e-5)));
}

// Sentinel-2 tiles over the point, from the tiling grid
let s2grid = null, builtS2 = "";
function s2Tiles(pt) { return pt && s2grid ? g.tilesAt(pt[0], pt[1], s2grid.has) : []; }
function buildS2(pt) {
  const tiles = state.s2 ? s2Tiles(pt) : [];
  const key = tiles.map((t) => t.name).join();
  if (key === builtS2) return;
  builtS2 = key;
  replace(s2Group, tiles.length ? segLines(ringSegs(tiles.map((t) => g.tileRing(t, 24))), COLORS.s2, 0.9, LIFT * (1 + 2e-5)) : null);
}

function rebuildScene() {
  buildLattice();
  const P = pickTiles();
  buildPick(P);
  buildS2(P && P.pt);
  aatGroup.visible = !!state.aat;
  marker.visible = !!P;
  if (P) marker.position.set(...sph(P.pt[0], P.pt[1], LIFT));
  if (!state.cam) setCamera(defaultCam());
}

// ---------------------------------------------------------------- panel

const $ = (id) => document.getElementById(id);
const ui = {
  zone: $("zone"), zoneOut: $("zone-out"), res: [...document.querySelectorAll("#res button")],
  lookup: $("lookup"), ptOut: $("pt-out"), chips: $("tile-chips"), info: $("tile-info"), s2info: $("s2-info"),
  past: $("past"), nb: $("nb"), s2: $("s2"), aat: $("aat"), bm: $("basemap")
};

const basemap = basemapControl({
  select: ui.bm, status: $("bm-status"), credit: $("credit"),
  onWorld: () => { drawGlobe(); sync(); }
});

const fmtM = (v) => Math.round(v).toLocaleString("en") + " m";
const fmtKm = (v) => (v / 1000).toLocaleString("en", { maximumFractionDigits: 1 }) + " km";
const fmtLon = (lon) => `${Math.abs(lon)}${DEG} ${lon < 0 ? "W" : lon > 0 ? "E" : ""}`.trim();
const fmtLL = (lon, lat) => `${Math.abs(lat).toFixed(4)}${DEG} S, ${Math.abs(lon).toFixed(4)}${DEG} ${lon < 0 ? "W" : "E"}`;

for (const p of PLACES) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = p.name;
  b.addEventListener("click", () => { setPoint(p.lon, p.lat); state.cam = null; sync(); });
  $("places").append(b);
}

function updatePanel() {
  for (const b of ui.res) b.classList.toggle("active", +b.dataset.res === state.res);
  $("res-out").textContent = `Tiles ${a.PIXELS} pixels of ${state.res} m, ${fmtKm(a.tileSize(state.res))} on a side.`;
  ui.zone.value = state.zone;
  ui.zoneOut.textContent = `${a.zoneId(state.zone)}, EPSG:${a.epsg(state.zone)}, ${fmtLon(a.zoneEdges(state.zone)[0])} to ${fmtLon(a.zoneEdges(state.zone)[1])}`;
  for (const k of ["past", "nb", "s2", "aat"]) ui[k].checked = !!state[k];
  ui.lookup.classList.remove("bad");
  ui.chips.replaceChildren();

  const P = pickTiles();
  $("zoom").disabled = !P;
  if (!P) {
    ui.ptOut.textContent = "";
    ui.info.textContent = "Click the globe, pick a place, or paste a point or a tile id.";
    ui.s2info.textContent = "";
    return;
  }
  const { pt, own, zone } = P;
  ui.ptOut.textContent = fmtLL(pt[0], pt[1]);
  if (document.activeElement !== ui.lookup) ui.lookup.value = `${+pt[0].toFixed(6)}, ${+pt[1].toFixed(6)}`;
  for (const t of [P.t10, P.t20, P.p60]) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "small" + (t.res === state.res ? " active" : "");
    b.textContent = t.id;
    b.title = `${t.res} m, ${fmtKm(a.tileSize(t.res))} tiles`;
    b.addEventListener("click", () => { state.res = t.res; sync(); });
    ui.chips.append(b);
  }
  const [e, n] = a.toZone(pt[0], pt[1], zone);
  const home = a.zoneOf(pt[0]);
  let msg = `Easting ${fmtM(e)}, northing ${fmtM(n)} in ${a.zoneId(zone)}. ` +
    `${own.id}: x ${own.xmin} to ${own.xmax}, y ${own.ymin} to ${own.ymax}, ${a.PIXELS} x ${a.PIXELS} pixels; ` +
    `geotransform ${own.gt.join(", ")}.`;
  if (home !== zone) msg += ` The point's own zone is ${a.zoneId(home)}, where it is ${a.tileAt(pt[0], pt[1], state.res, home).id}: the same ground in another lattice.`;
  else {
    const [w, ee] = a.zoneEdges(home), near = pt[0] - w < 1 ? home - 1 : ee - pt[0] < 1 ? home + 1 : 0;
    if (near) {
      const z = ((near + 59) % 60) + 1;
      msg += ` Near the zone's edge, so zone ${a.zoneId(z)}'s lattice covers it too, as ${a.tileAt(pt[0], pt[1], state.res, z).id}.`;
    }
  }
  ui.info.textContent = msg;

  const [dx, dy] = a.s2Shift(state.res);
  const shift = dx || dy ? `At ${state.res} m these pixels sit ${Math.abs(dx)} m ${dx > 0 ? "east" : "west"} and ${Math.abs(dy)} m ${dy > 0 ? "north" : "south"} of Sentinel-2's.` :
    `At ${state.res} m these pixels are Sentinel-2's own.`;
  const tiles = s2Tiles(pt);
  ui.s2info.textContent = (!s2grid ? "Loading the Sentinel-2 grid. " : tiles.length ? `Sentinel-2 tiles here: ${tiles.map((t) => "T" + t.name).join(", ")}. ` : "No Sentinel-2 tile here. ") + shift;
}

let rafPending = false;
function sync() {
  writeHash();
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    rebuildScene();
    updatePanel();
  });
}

function setPoint(lon, lat, zone = true) {
  state.pt = `${+lon.toFixed(6)},${+lat.toFixed(6)}`;
  if (zone) state.zone = a.zoneOf(lon);
}

ui.zone.addEventListener("input", () => { state.zone = +ui.zone.value; sync(); });
for (const b of ui.res) b.addEventListener("click", () => { state.res = +b.dataset.res; sync(); });
for (const k of ["past", "nb", "s2", "aat"]) ui[k].addEventListener("change", () => { state[k] = ui[k].checked ? 1 : 0; sync(); });

ui.lookup.addEventListener("change", () => {
  const raw = ui.lookup.value.trim();
  if (!raw) { state.pt = ""; return sync(); }
  const id = a.parseTileId(raw);
  if (id) {
    const t = a.tile(id.zone, id.res, id.col, id.row);
    const [lon, lat] = a.fromZone(t.zone, (t.xmin + t.xmax) / 2, (t.ymin + t.ymax) / 2);
    if (lat < 0) {
      setPoint(lon, lat, false);
      state.zone = t.zone;
      if (a.RESOLUTIONS.includes(t.res)) state.res = t.res;
      state.cam = null;
      return sync();
    }
  }
  const ll = raw.split(/[\s,;]+/).filter(Boolean).map(Number);
  if (ll.length === 2 && ll.every(isFinite) && ll[1] < 0 && ll[1] >= -90) { setPoint(ll[0], ll[1]); return sync(); }
  ui.lookup.classList.add("bad");
});

// the camera over the picked 60 m tile, a few tiles up, north at the top
$("zoom").addEventListener("click", () => {
  const P = pickTiles();
  if (!P) return;
  const t = P.p60;
  const [lon, lat] = a.fromZone(t.zone, (t.xmin + t.xmax) / 2, (t.ymin + t.ymax) / 2);
  const T = sph(lon, lat), d = 3.2 * a.tileSize(60) / g.A;
  const up = sph(lon, lat + 25);
  const C = [0, 1, 2].map((k) => T[k] * (1 + d) - (up[k] - T[k]) * d * 0.4);
  state.cam = [...C, ...T];
  setCamera(state.cam);
  writeHash();
});
$("reset-view").addEventListener("click", () => { state.cam = null; setCamera(defaultCam()); writeHash(); });

// click (not drag) on the globe picks a point and moves to its zone
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObject(globe)[0];
  if (!hit) return;
  const p = hit.point.clone().normalize(), lat = Math.asin(p.y) / D2R;
  if (lat >= 0) return;
  setPoint(Math.atan2(p.x, p.z) / D2R, lat, !e.shiftKey);
  sync();
});

shareLinks("AAT grid");

// ---------------------------------------------------------------- loop

function tick() {
  controls.update();
  controls.rotateSpeed = Math.min(1, camera.position.length() - 1 + 0.05);
  marker.scale.setScalar(0.006 * Math.min(1, camera.position.distanceTo(marker.position) / 2.5));
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

ui.bm.addEventListener("change", () => { state.bm = ui.bm.value; writeHash(); basemap.set(state.bm); });
window.addEventListener("hashchange", () => { readHash(); if (state.cam) setCamera(state.cam); basemap.set(state.bm); sync(); });

readHash();
setCamera(state.cam || defaultCam());
resize();
drawGlobe();
sync();
basemap.set(state.bm);
requestAnimationFrame(tick);

loadCoastline("110m").then((lines) => { if (!coastGroup.children.length) buildCoast(lines); });
loadCoastline("50m").then(buildCoast).catch(() => {});
fetch(new URL("../data/s2-tiles.json", import.meta.url)).then((r) => r.json()).then((json) => {
  s2grid = g.tileSet(json);
  builtS2 = "-";
  sync();
  document.body.classList.add("ready");
});
