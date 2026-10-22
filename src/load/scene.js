// Scenes: a scenespec document and the Arrow tables it names, read into
// typed arrays a page can draw. Nothing here touches the DOM or three.js;
// fetch and an Arrow reader (apache-arrow's tableFromIPC) are passed in, so
// the same code runs in a page and in Node.
//
// Data references are resolved against the scene's own URL, as scenespec
// says. A URL ending .b64.txt is read as base64 text, for hosts that serve
// only text.

// A scene-relative URL made absolute.
export const resolve = (url, base) => new URL(url, base).href;

function base64Bytes(text) {
  const bin = atob(text.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The bytes at url (fetch is the caller's).
export async function fetchBytes(url, fetchFn = globalThis.fetch) {
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`could not read ${url} (${r.status})`);
  if (url.endsWith(".b64.txt")) return base64Bytes(await r.text());
  return new Uint8Array(await r.arrayBuffer());
}

// Read the scene at url and every Arrow table its mesh layers name.
// Returns { scene, url, tables } with tables a Map of data id -> Arrow
// table. Other data (vector tables, COGs, chunks) is left for the layer
// kinds that draw it.
export async function loadScene(url, { tableFromIPC, fetch: fetchFn = globalThis.fetch } = {}) {
  if (!tableFromIPC) throw new Error("loadScene needs tableFromIPC");
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`could not read ${url} (${r.status})`);
  const scene = await r.json();
  if (!scene.version || !scene.view || !scene.data || !scene.layers) throw new Error(`${url} is not a scenespec scene`);
  const ids = new Set();
  for (const L of scene.layers) {
    if (L.kind !== "mesh") continue;
    for (const k of ["vertices", "indices", "faces"]) if (L.mesh[k] !== undefined) ids.add(L.mesh[k]);
  }
  const tables = new Map();
  await Promise.all([...ids].map(async (id) => {
    const ref = scene.data[id];
    if (!ref) throw new Error(`data id ${id} is not in the scene`);
    if (!ref.url) throw new Error(`data ${id} is a blob; only URL data is read here`);
    tables.set(id, tableFromIPC(await fetchBytes(resolve(ref.url, url), fetchFn)));
  }));
  return { scene, url, tables };
}

// A number column as a Float64Array (NaN for nulls), or null.
export function numbers(table, name) {
  const c = table && table.getChild(name);
  if (!c) return null;
  const out = new Float64Array(c.length);
  for (let i = 0; i < c.length; i++) {
    const v = c.get(i);
    out[i] = v === null || v === undefined ? NaN : Number(v);
  }
  return out;
}

// One mesh layer's tables as arrays: position (Float32Array, `size` per
// vertex, origin subtracted when the data says so), index (Uint32Array),
// and the vertex and face tables for colouring and popups.
export function meshArrays(loaded, layer) {
  const { scene, tables } = loaded;
  const m = layer.mesh;
  const vt = tables.get(m.vertices), it = tables.get(m.indices), ft = m.faces === undefined ? null : tables.get(m.faces);
  const pc = vt.getChild(m.position_column || "position");
  if (!pc) throw new Error(`no position column in ${m.vertices}`);
  const size = pc.type.listSize;
  const position = new Float32Array(pc.length * size);
  for (let i = 0; i < pc.length; i++) position.set(pc.get(i).toArray(), i * size);
  const ic = it.getChild(m.index_column || "index");
  if (!ic) throw new Error(`no index column in ${m.indices}`);
  const index = Uint32Array.from(ic.toArray(), Number);
  const view = scene.view || {};
  const subtracted = scene.data[m.vertices].origin_subtracted === true;
  return {
    position, size, index,
    nv: pc.length, ntri: index.length / 3,
    vertices: vt, faces: ft,
    // the CRS point the positions are relative to
    origin: subtracted ? view.local_origin.slice(0, 2) : [0, 0],
    crs: view.crs
  };
}

// The x, y extent of positions (relative to the origin): [x0, x1, y0, y1].
export function extentOf(position, size) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < position.length; i += size) {
    const x = position[i], y = position[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, x1, y0, y1];
}

// Per-vertex RGB (0..1, three per vertex) from a layer's fill or fill_by:
// a face column gives each triangle one colour, so the mesh is unindexed
// (three vertices per triangle) and `flat` is true. colourOf(palette) ->
// v -> [r, g, b] 0..255 or null is the caller's palette table.
export function meshColours(mesh, layer, colourOf) {
  const fb = layer.fill_by;
  const NONE = [92, 84, 102];
  if (!fb) {
    const c = layer.fill || [180, 170, 150, 255];
    const out = new Float32Array(mesh.nv * 3);
    for (let i = 0; i < out.length; i += 3) { out[i] = c[0] / 255; out[i + 1] = c[1] / 255; out[i + 2] = c[2] / 255; }
    return { colour: out, flat: false };
  }
  const pal = colourOf(fb.palette);
  if (!pal) throw new Error(`unknown palette ${fb.palette.name}`);
  if (fb.table === "vertices") {
    const v = numbers(mesh.vertices, fb.column);
    if (!v) throw new Error(`no vertex column ${fb.column}`);
    const out = new Float32Array(mesh.nv * 3);
    for (let i = 0; i < mesh.nv; i++) {
      const c = pal(v[i]) || NONE;
      out[3 * i] = c[0] / 255; out[3 * i + 1] = c[1] / 255; out[3 * i + 2] = c[2] / 255;
    }
    return { colour: out, flat: false };
  }
  const f = numbers(mesh.faces, fb.column);
  if (!f) throw new Error(`no face column ${fb.column}`);
  const out = new Float32Array(mesh.ntri * 9);
  for (let t = 0; t < mesh.ntri; t++) {
    const c = pal(f[t]) || NONE;
    for (let k = 0; k < 3; k++) {
      const o = 9 * t + 3 * k;
      out[o] = c[0] / 255; out[o + 1] = c[1] / 255; out[o + 2] = c[2] / 255;
    }
  }
  return { colour: out, flat: true };
}

// The popup for triangle t: [[column, value], ...] from the face table.
export function facePopup(mesh, layer, t) {
  const cols = (layer.popup && layer.popup.columns) || [];
  return cols.map((name) => {
    const c = mesh.faces && mesh.faces.getChild(name);
    const v = c ? c.get(t) : undefined;
    return [name, v === null || v === undefined ? null : typeof v === "bigint" ? Number(v) : v];
  });
}
