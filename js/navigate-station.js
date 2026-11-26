// The Navigation page's station scene: the earth at its own size, in
// metres, in the frame of an Antarctic station (east, north and up from
// the ellipsoid under it), with REMA drawn in patches that get finer
// towards the station, from the whole continent at 8 km to a kilometre
// round the station at 2 m. REMA is read as GDAL would read its overview
// VRT: the VRT's XML, the tile VRTs and COGs it names, and the tiles a
// window needs, through geotiff.js. The geometry is src/core/station.js,
// the VRT's reading src/core/rema.js. BedMachine (the cavity scene's data)
// says where there is no ice, to colour the rock, and fills the ground
// where REMA has none, as round the South Pole. Sentinel-2's true-colour
// image of one clear summer pass is draped over the patches finer than
// the continent's (src/core/drape.js), over the tints where it has none.

import * as THREE from "three";
import * as R from "../src/core/rema.js";
import * as T from "../src/core/station.js";
import * as G from "../src/core/geoid.js";
import * as D from "../src/core/drape.js";
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

// ---------------------------------------------------------------- imagery

const json = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.json();
};

// A tile as the drape needs it: its UTM zone, its true-colour COG, and the
// outline of where it has pixels (its STAC geometry), in its UTM.
function s2Tile(f) {
  const P = f.properties || {}, code = P["proj:epsg"] ?? Number(String(P["proj:code"] || "").replace(/^EPSG:/, ""));
  const u = D.utmOf(code), href = f.assets?.[D.S2.asset]?.href, g = f.geometry || {};
  if (!u || !href) return null;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  const rings = polys.map((p) => p[0].map(([lon, lat]) => D.utmForward(lon, lat, u)).filter(Boolean));
  return { id: f.id, u, href, rings, nodata: P["s2:nodata_pixel_percentage"] ?? 0 };
}

// The pass that took the chosen tile (its datatake, within ten minutes of
// it): the tile first, then the others in the lon, lat box, fullest first.
async function s2Pass(id, box) {
  const S = D.S2, item = await json(`${S.stac}/collections/${S.collection}/items/${id}`);
  const t = Date.parse(item.properties.datetime), iso = (ms) => new Date(ms).toISOString();
  const q = new URLSearchParams({ collections: S.collection, bbox: box.map((v) => v.toFixed(4)).join(","), datetime: `${iso(t - 6e5)}/${iso(t + 6e5)}`, limit: "100" });
  const take = D.s2Name(id).take;
  const others = ((await json(`${S.stac}/search?${q}`)).features || []).filter((f) => f.id !== id && D.s2Name(f.id)?.take === take);
  others.sort((a, b) => (a.properties["s2:nodata_pixel_percentage"] ?? 0) - (b.properties["s2:nodata_pixel_percentage"] ?? 0));
  return { item, tiles: [item, ...others].map(s2Tile).filter(Boolean) };
}

// A tile's COG opened once: its corner and its levels (the image and its
// overviews) by their pixels' size.
const opened = new Map();
function openTile(href) {
  if (!opened.has(href)) {
    const p = (async () => {
      const tiff = await openGeoTiff(href), n = await tiff.getImageCount(), base = await tiff.getImage(0);
      const [ox, oy] = base.getOrigin(), [rx] = base.getResolution(), W = base.getWidth(), levels = [];
      for (let i = 0; i < n; i++) {
        const img = i ? await tiff.getImage(i) : base;
        levels.push({ img, res: (rx * W) / img.getWidth(), w: img.getWidth(), h: img.getHeight() });
      }
      return { ox, oy, levels };
    })();
    p.catch(() => opened.delete(href));
    opened.set(href, p);
  }
  return opened.get(href);
}

// The texture for a patch (axes ax) from a pass: which tiles it needs
// (each where its outline holds texels the ones before it do not), read at
// the level nearest the texels' size, in parallel, then warped in onto
// the patch's grid in turn and faded in from where there is nothing (and
// from the edges, for the outermost patch, rim). { rgba, n, tiles (the
// names of those it took texels from), res (their finest pixels) }.
async function drapeTexture(pass, ax, { rim = false } = {}) {
  const ext = D.cellExtent(ax), across = ext.right - ext.left, n = D.textureSize(across), texel = across / n, step = 16;
  const claimed = new Uint8Array((Math.ceil((n - 1) / step) + 1) ** 2), wanted = [];
  for (const t of pass.tiles) {
    // (the lattice in UTM metres, northings negated, to find the tile's share)
    const L = D.utmLattice(ext, n, step, { u: t.u, ox: 0, oy: 0, res: 1 });
    let mine = 0;
    for (let k = 0; k < claimed.length; k++) {
      const x = L.at[2 * k], y = -L.at[2 * k + 1];
      if (claimed[k] || !(x === x) || !t.rings.some((r) => D.inRing(r, x, y))) continue;
      claimed[k] = 1; mine++;
    }
    if (mine) wanted.push(t);
  }
  const reads = await Promise.all(wanted.map(async (t) => {
    const { ox, oy, levels } = await openTile(t.href), lv = D.pickOverview(levels, texel);
    const L = D.utmLattice(ext, n, step, { u: t.u, ox, oy, res: lv.res });
    const inside = (x, y) => t.rings.some((r) => D.inRing(r, ox + x * lv.res, oy - y * lv.res));
    const win = D.latticeWindow(L, lv.w, lv.h, 2, inside);
    if (!win) return null;
    const data = await lv.img.readRasters({ window: [win.c0, win.r0, win.c0 + win.w, win.r0 + win.h], samples: [0, 1, 2], interleave: true });
    // (the outline in the window's pixels, so the darkest water, 0, 0, 0 as
    // the swath's outside is, still counts)
    const mask = D.fillRings(t.rings.map((r) => r.map(([E, N]) => [(E - ox) / lv.res - win.c0, (oy - N) / lv.res - win.r0])), win.w, win.h);
    return { id: t.id, L, src: { data, w: win.w, h: win.h, c0: win.c0, r0: win.r0, mask }, res: lv.res };
  }));
  const rgba = new Uint8Array(4 * n * n);
  const used = [];
  let res = Infinity;
  for (const r of reads) {
    if (!r) continue;
    if (D.warpInto(rgba, r.L, r.src)) { used.push(r.id); res = Math.min(res, r.res); }
  }
  D.feather(rgba, n, rim ? n / 10 : Math.min(n / 8, Math.max(2, 1000 / texel)), rim);
  return { rgba, n, tiles: used, res };
}

// 1 the imagery over the tints, 0 the tints alone: one number for every
// patch's material, so the page turns it on and off at once.
export const drape = { mix: { value: 1 } };

// A patch's material: lit, its vertices' tints under its texture as far as
// the texture's alpha goes (and drape.mix). The texture is in sRGB, so
// three.js reads it as linear, as it takes the vertices' colours.
const EMPTY = new THREE.DataTexture(new Uint8Array(4), 1, 1);
EMPTY.needsUpdate = true;
function drapeMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, map: EMPTY });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.drapeMix = drape.mix;
    sh.fragmentShader = "uniform float drapeMix;\n" + sh.fragmentShader
      .replace("#include <map_fragment>", "")
      .replace("#include <color_fragment>", "#include <color_fragment>\n\tvec4 drapeTexel = texture2D( map, vMapUv );\n\tdiffuseColor.rgb = mix( diffuseColor.rgb, drapeTexel.rgb, drapeTexel.a * drapeMix );");
  };
  m.customProgramCacheKey = () => "station-drape";
  return m;
}
function drapeTex({ rgba, n }, anisotropy) {
  const t = new THREE.DataTexture(rgba, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
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
// is being read; changed() is called as each level is drawn, and as each
// patch's imagery comes (once startImagery() is called). anisotropy is
// the textures' (the renderer's most).
export function stationScene(key, { status = () => {}, changed = () => {}, anisotropy = 1 } = {}) {
  const st = T.STATIONS[key], frame = T.enuFrame(st.lon, st.lat), [sx, sy] = T.PS.forward(st.lon, st.lat);
  const group = new THREE.Group(), earth = globeOf(frame), pin = marker("#ffd166");
  group.add(earth.globe, earth.coast, pin);
  const patches = [], meshes = [earth.globe], reading = new Set(), textures = [];
  let planned = null;
  const planP = new Promise((resolve) => { planned = resolve; });
  let ground = 0, geoid = null, bm = { noIce: () => 0, fill: (x, y, lon, lat) => ({ h: G.undulation(geoid, lon, lat), sea: true }) };

  function addPatch(level, win, got) {
    const ax = T.patchAxes(level.grid, win), z = got.z;
    const filled = T.fillHeights(z, ax, got.nodata, bm.fill);
    const enu = T.enuPositions(ax, z, frame);
    const p = { ...ax, z, enu, filled, d: level.grid.dx, level, win, hole: null, files: got.files };
    const parent = patches[patches.length - 1];
    let rim = null;
    if (parent) {
      const hole = T.holeIn(parent, p);
      if (hole) {
        T.pinEdges(p, parent, hole);
        rim = D.rimBox(parent, hole);
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
    // (where the vertices are drawn in the patch's texture, the rim's held
    // to the coarser patch's hole as pinEdges put them)
    geo.setAttribute("uv", new THREE.BufferAttribute(D.patchUv(ax, D.cellExtent(ax), rim), 2));
    geo.setIndex(new THREE.BufferAttribute(T.gridIndex(ax.w, ax.h), 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    p.mesh = new THREE.Mesh(geo, drapeMaterial());
    p.mesh.position.set(...c);
    p.tiles = T.tileBoxes(enu, ax.w, ax.h, 32);
    patches.push(p);
    meshes.push(p.mesh);
    group.add(p.mesh);
    dress(patches.length - 1);
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
    planned(plan);
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
  ready.catch((e) => { planned(null); status(`REMA not read: ${e.message}`); });

  // Sentinel-2 over every patch but the continent's: the chosen pass's
  // tiles in the 500 m patch's lon, lat box, and a texture a patch, put on
  // as it and its patch are both there. Read only once asked for.
  const imagery = { state: "off", id: D.S2_SCENES[key] || null, item: null, pass: 0, used: new Set(), patches: 0, res: Infinity, why: "" };
  let imageryP = null;
  function dress(k) {
    const p = patches[k], d = textures[k];
    if (!p || !d || p.tex) return;
    p.tex = drapeTex(d, anisotropy);
    p.mesh.material.map = p.tex;
    p.mesh.material.needsUpdate = true;
    changed();
  }
  function startImagery() {
    if (imageryP) return imageryP;
    if (!imagery.id) { imagery.state = "none"; return (imageryP = Promise.resolve()); }
    imagery.state = "reading";
    imageryP = (async () => {
      const plan = await planP;
      if (!plan || plan.length < 2) throw new Error("REMA's patches were not read");
      const axes = plan.map((pl) => T.patchAxes(pl.level.grid, pl.win));
      const pass = await s2Pass(imagery.id, D.lonLatBox(D.cellExtent(axes[1])));
      imagery.item = pass.item;
      imagery.pass = pass.tiles.length;
      changed();
      await Promise.all(axes.map(async (ax, k) => {
        if (k === 0) return;
        const d = await drapeTexture(pass, ax, { rim: k === 1 });
        textures[k] = d;
        imagery.patches++;
        for (const id of d.tiles) imagery.used.add(id);
        if (d.tiles.length) imagery.res = Math.min(imagery.res, d.res);
        dress(k);
      }));
      imagery.state = "done";
    })().catch((e) => { imagery.state = "error"; imagery.why = e.message; }).finally(changed);
    return imageryP;
  }

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
    group, meshes, frame, station: st, key, patches, ready, reading, hit, placeOf, defaultCam, imagery, startImagery,
    earthCentre: earth.centre, setCoast: earth.setCoast, ground: () => ground, what: "earth"
  };
}
