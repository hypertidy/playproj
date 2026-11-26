// The Navigation page's station scene: the earth at its own size, in
// metres, in the frame of an Antarctic station (east, north and up from
// the ellipsoid under it), with REMA drawn in patches that get finer
// towards the station, from the whole continent at 8 km to a kilometre
// round the station at 2 m. REMA is read as GDAL would read its overview
// VRT: the VRT's XML, the tile VRTs and COGs it names, and the tiles a
// window needs, through geotiff.js. The geometry is src/core/station.js,
// the VRT's reading src/core/rema.js. BedMachine (the cavity scene's data)
// says where there is no ice, to colour the rock, and fills the ground
// where REMA has none, as round the South Pole.

import * as THREE from "three";
import * as R from "../src/core/rema.js";
import * as T from "../src/core/station.js";
import * as G from "../src/core/geoid.js";
import { BEDMACHINE } from "../src/core/cavity.js";
import { openGeoTiff } from "./basemap-load.js";

// ---------------------------------------------------------------- reading

// EGM2008 at whole degrees, for sea level where REMA has nothing
let geoidP = null;
function loadGeoid() {
  if (!geoidP) {
    geoidP = fetch(new URL("../data/geoid-egm2008-1deg.bin", import.meta.url)).then((r) => r.arrayBuffer()).then((b) => G.fromInt16(b));
    geoidP.catch(() => { geoidP = null; });
  }
  return geoidP;
}

const text = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.text();
};

// a VRT as a level: its grid, and a window of it read from the tiles under
// it, in the VRT's order, each over those before it where it has values
function vrtLevel(v, url) {
  const grid = R.gridOf(v.gt, v.width, v.height), nodata = v.nodata ?? R.REMA.nodata;
  return {
    dx: grid.dx, grid, url, files: v.sources.length,
    async read(win) {
      const parts = R.sourcesIn(v.sources, win);
      const blocks = await Promise.all(parts.map(async (p) => {
        const img = await (await openGeoTiff(p.url)).getImage(0);
        const sized = p.read[2] - p.read[0] === p.cols && p.read[3] - p.read[1] === p.rows ? {} : { width: p.cols, height: p.rows };
        return (await img.readRasters({ window: p.read, samples: [0], ...sized }))[0];
      }));
      const out = new Float32Array(win.w * win.h).fill(nodata);
      parts.forEach((p, k) => R.paste(out, win.w, blocks[k], { ...p, nodata: p.nodata ?? nodata }));
      return { z: out, nodata, files: parts.length };
    }
  };
}
// a COG as levels, one for it and one for each overview in it
async function cogLevels(url) {
  const tiff = await openGeoTiff(url), n = await tiff.getImageCount(), base = await tiff.getImage(0);
  const [ox, oy] = base.getOrigin(), [rx, ry] = base.getResolution(), W = base.getWidth(), H = base.getHeight();
  const nd = base.getGDALNoData(), nodata = nd === null || nd === undefined ? R.REMA.nodata : nd, out = [];
  for (let i = 0; i < n; i++) {
    const img = i ? await tiff.getImage(i) : base;
    if ((img.fileDirectory.NewSubfileType || 0) & 4) continue; // a mask, not heights
    const w = img.getWidth(), h = img.getHeight(), grid = { x0: ox, y0: oy, dx: (rx * W) / w, dy: (-ry * H) / h, w, h };
    out.push({
      dx: grid.dx, grid, url, ifd: i,
      async read(win) {
        const [r] = await img.readRasters({ window: [win.c0, win.r0, win.c0 + win.w, win.r0 + win.h], samples: [0] });
        return { z: Float32Array.from(r), nodata, files: 1 };
      }
    });
  }
  return out;
}

// Every level REMA's VRT offers, finest first: the 2 m mosaic itself, its
// 10 m and 32 m tile VRTs, and the COGs with their own overviews.
let levelsP = null;
export function remaLevels(status = () => {}) {
  if (!levelsP) {
    levelsP = (async () => {
      status("Reading REMA's overview VRT (3 MB of XML naming 5,805 tiles)...");
      const main = R.parseVrt(await text(R.REMA.vrt));
      status("Reading REMA's tile VRTs and COG headers...");
      const out = [vrtLevel(main, R.REMA.vrt)];
      for (const more of await Promise.all(main.overviews.map(async (url) =>
        (/\.vrt$/i.test(url) ? [vrtLevel(R.parseVrt(await text(url)), url)] : cogLevels(url))))) out.push(...more);
      return out.sort((a, b) => a.dx - b.dx);
    })();
    levelsP.catch(() => { levelsP = null; });
  }
  return levelsP;
}

// BedMachine round x, y: its mask (0 the sea, 1 ice-free land) and its
// surface (over the geoid), the whole of each at 8 km and 560 cells at
// 500 m round x, y. Gives noIce(x, y), 0 to 1, where there is no ice
// (bilinear, so the rock's edges are as soft as its cells); and fill(x, y,
// lon, lat), the ground where REMA has none: BedMachine's surface over the
// ellipsoid where its mask has ground, sea level where it has the sea.
async function bedmachineRound(x, y, geoid) {
  const H = BEDMACHINE.half, grids = [];
  const open = async (name) => {
    const tiff = await openGeoTiff(`${BEDMACHINE.base}${name}.tif`), n = await tiff.getImageCount(), out = [];
    for (let i = 0; i < n; i++) out.push(await tiff.getImage(i));
    return out;
  };
  const [masks, surfaces] = await Promise.all([open("mask"), open("surface")]);
  for (const [w, around] of [[833, false], [13333, true]]) {
    const d = (2 * H) / w, g = { x0: -H, y0: H, dx: d, dy: d, w, h: w };
    const win = around ? R.windowAt(g, x, y, 560) : { c0: 0, r0: 0, w, h: w }, box = [win.c0, win.r0, win.c0 + win.w, win.r0 + win.h];
    const mi = masks.find((m) => m.getWidth() === w), si = surfaces.find((m) => m.getWidth() === w);
    if (!mi || !si) continue;
    const [[m], [sf]] = await Promise.all([mi.readRasters({ window: box, samples: [0] }), si.readRasters({ window: box, samples: [0] })]);
    const bare = new Float32Array(m.length);
    for (let k = 0; k < m.length; k++) bare[k] = m[k] === 0 || m[k] === 1 ? 1 : 0;
    grids.unshift({ ax: T.patchAxes(g, win), mask: m, bare, surface: sf });
  }
  const noIce = (px, py) => {
    for (const g of grids) { const v = T.sampleGrid(g.ax, g.bare, px, py); if (v !== null) return v; }
    return 0;
  };
  const fill = (px, py, lon, lat) => {
    const N = G.undulation(geoid, lon, lat);
    for (const g of grids) {
      const { xs, ys, w, h } = g.ax, i = Math.round((px - xs[0]) / (xs[1] - xs[0])), j = Math.round((ys[0] - py) / (ys[0] - ys[1]));
      if (i < 0 || j < 0 || i >= w || j >= h) continue;
      if (g.mask[j * w + i] === 0) return { h: N, sea: true };
      const s = T.sampleValid(g.ax, g.surface, px, py, BEDMACHINE.nodata);
      return s === null ? { h: N, sea: true } : { h: s + N, sea: false };
    }
    return { h: N, sea: true };
  };
  return { noIce, fill };
}

// ---------------------------------------------------------------- drawing

// the ellipsoid, 600 m under itself so it never shows through REMA's sea
// (a degree's chord sags 250 m), with the coastlines north of Antarctica
function globeOf(frame) {
  const centre = T.toEnu(frame, 0, 0, 0), pos = [], idx = [], g = [0, 0, 0], q = [0, 0, 0];
  const at = (lon, lat, h) => { G.geocentric(lon, lat, h, undefined, g); T.toEnu(frame, g[0], g[1], g[2], q); return [q[0] - centre[0], q[1] - centre[1], q[2] - centre[2]]; };
  for (let lat = -90; lat <= 90; lat += 1) for (let lon = -180; lon <= 180; lon += 1) pos.push(...at(lon, lat, -600));
  const nx = 361;
  for (let j = 0; j < 180; j++)
    for (let i = 0; i < 360; i++) { const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1; idx.push(a, b, c, b, d, c); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // (in the sea's colour as REMA's patches have it: three.js takes vertex
  // colours as linear and a material's hex as sRGB, so the same numbers)
  const globe = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: new THREE.Color().setRGB(...T.SEA, THREE.LinearSRGBColorSpace) }));
  globe.position.set(...centre);
  const coast = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xf1f4f8, transparent: true, opacity: 0.8 }));
  coast.position.set(...centre);
  function setCoast(world) {
    const out = [];
    for (const l of world) {
      let south = true;
      for (let k = 1; k < l.length; k += 2) if (l[k] > -60) { south = false; break; }
      if (south) continue;
      for (let k = 2; k < l.length; k += 2) out.push(...at(l[k - 2], l[k - 1], 0), ...at(l[k], l[k + 1], 0));
    }
    coast.geometry.dispose();
    coast.geometry = new THREE.BufferGeometry();
    coast.geometry.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  }
  return { globe, coast, centre, setCoast };
}

// a marker that stays the same size on the screen, drawn over everything,
// its middle on the place
function marker(hex) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = hex; g.strokeStyle = "#0b1220"; g.lineWidth = 4;
  g.beginPath(); g.moveTo(32, 6); g.lineTo(58, 32); g.lineTo(32, 58); g.lineTo(6, 32); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = "#0b1220"; g.beginPath(); g.arc(32, 32, 6, 0, 2 * Math.PI); g.fill();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const m = new THREE.Points(geo, new THREE.PointsMaterial({ size: 28, sizeAttenuation: false, map: new THREE.CanvasTexture(c), transparent: true, depthTest: false, depthWrite: false }));
  m.renderOrder = 9; m.frustumCulled = false;
  return m;
}

// ---------------------------------------------------------------- the scene

// The scene for a station: the globe at once, and REMA's levels as they
// are read, coarse to fine, each holed for the next. status(s) says what
// is being read; changed() is called as each level is drawn.
export function stationScene(key, { status = () => {}, changed = () => {} } = {}) {
  const st = T.STATIONS[key], frame = T.enuFrame(st.lon, st.lat), [sx, sy] = T.PS.forward(st.lon, st.lat);
  const group = new THREE.Group(), earth = globeOf(frame), pin = marker("#ffd166");
  group.add(earth.globe, earth.coast, pin);
  const patches = [], meshes = [earth.globe], reading = new Set();
  let ground = 0, geoid = null, bm = { noIce: () => 0, fill: (x, y, lon, lat) => ({ h: G.undulation(geoid, lon, lat), sea: true }) };

  function addPatch(level, win, got) {
    const ax = T.patchAxes(level.grid, win), z = got.z;
    const filled = T.fillHeights(z, ax, got.nodata, bm.fill);
    const enu = T.enuPositions(ax, z, frame);
    const p = { ...ax, z, enu, filled, d: level.grid.dx, level, win, hole: null, files: got.files };
    const parent = patches[patches.length - 1];
    if (parent) {
      const hole = T.holeIn(parent, p);
      if (hole) {
        T.pinEdges(p, parent, hole);
        parent.hole = hole;
        parent.mesh.geometry.setIndex(new THREE.BufferAttribute(T.gridIndex(parent.w, parent.h, hole), 1));
      }
    }
    // (the sea level under each vertex, and whether there is ice, for its colour)
    const sea = new Float32Array(ax.w * ax.h), bare = new Float32Array(ax.w * ax.h);
    for (let j = 0, k = 0; j < ax.h; j++) for (let i = 0; i < ax.w; i++, k++) {
      const [lon, lat] = T.PS.inverse(ax.xs[i], ax.ys[j]);
      sea[k] = G.undulation(geoid, lon, lat);
      bare[k] = bm.noIce(ax.xs[i], ax.ys[j]);
    }
    // each patch's vertices relative to its own middle, so the GPU's 32-bit
    // floats hold centimetres a kilometre from the station and ten
    // thousand kilometres from the earth's centre alike
    const mid = 3 * ((ax.h >> 1) * ax.w + (ax.w >> 1)), c = [enu[mid], enu[mid + 1], enu[mid + 2]];
    const pos = new Float32Array(enu.length);
    for (let k = 0; k < enu.length; k += 3) { pos[k] = enu[k] - c[0]; pos[k + 1] = enu[k + 1] - c[1]; pos[k + 2] = enu[k + 2] - c[2]; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(T.tints(z, filled, ax, level.grid.dx, level.grid.dy, sea, bare), 3));
    geo.setIndex(new THREE.BufferAttribute(T.gridIndex(ax.w, ax.h), 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    p.mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    p.mesh.position.set(...c);
    p.tiles = T.tileBoxes(enu, ax.w, ax.h, 32);
    patches.push(p);
    meshes.push(p.mesh);
    group.add(p.mesh);
    const h = T.sampleGrid(p, z, sx, sy);
    if (h !== null) ground = h;
    pin.position.set(0, 0, ground);
  }

  const ready = (async () => {
    geoid = await loadGeoid();
    const bmP = bedmachineRound(sx, sy, geoid).catch(() => null);
    const levels = await remaLevels(status);
    const plan = T.LADDER.map((d, k) => {
      const level = R.pickLevel(levels, d), g = level.grid;
      return { level, win: k === 0 ? { c0: 0, r0: 0, w: g.w, h: g.h } : R.windowAt(g, sx, sy, T.ACROSS) };
    }).filter((p) => p.win);
    // read at once, drawn in turn: each needs the one before it to hole
    const reads = plan.map(({ level, win }) => {
      reading.add(level.grid.dx);
      return level.read(win).finally(() => reading.delete(level.grid.dx));
    });
    bm = (await bmP) || bm;
    for (let k = 0; k < plan.length; k++) {
      status(`Reading REMA at ${R.cellWords(plan[k].level.grid.dx)} round ${st.name} (${plan.length - k} of ${plan.length} levels to come)...`);
      addPatch(plan[k].level, plan[k].win, await reads[k]);
      changed();
    }
    status("");
  })();
  ready.catch((e) => status(`REMA not read: ${e.message}`));

  // where a ray (in the frame) first meets the ground, or the globe beyond
  // REMA: { point, patch } or null
  function hit(o, d) {
    let best = Infinity, at = null;
    for (const p of patches) {
      const h = T.rayHit(p, o, d);
      if (h && h.t < best) { best = h.t; at = p; }
    }
    const t = T.rayEllipsoid(frame, o, d, -600);
    if (t !== null && t < best) { best = t; at = null; }
    if (best === Infinity) return null;
    return { point: [o[0] + best * d[0], o[1] + best * d[1], o[2] + best * d[2]], patch: at };
  }
  // a place in the frame: lon, lat, height over the ellipsoid, the ground
  // there (from the finest patch over it) and the patch's cells
  function placeOf(x, y, z) {
    const [lon, lat, h] = T.enuGeodetic(frame, x, y, z), [px, py] = T.PS.forward(lon, lat);
    for (let k = patches.length - 1; k >= 0; k--) {
      const g = T.sampleGrid(patches[k], patches[k].z, px, py);
      if (g !== null) return { lon, lat, h, ground: g, d: patches[k].d };
    }
    return { lon, lat, h, ground: null, d: null };
  }
  // the opening view: from 22,000 km over the station, 20 degrees off
  // straight down, looking at it
  function defaultCam() {
    const D = 2.2e7, e = (20 * Math.PI) / 180;
    return [0, -D * Math.sin(e), ground + D * Math.cos(e), 0, 0, ground];
  }

  return {
    group, meshes, frame, station: st, key, patches, ready, reading, hit, placeOf, defaultCam,
    earthCentre: earth.centre, setCoast: earth.setCoast, ground: () => ground, what: "earth"
  };
}
