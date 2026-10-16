// The basemap picker and the cell GeoTIFF button, as the cells pages use
// them: a select of basemaps (loaded once, shared with every page through
// basemap.js) and a button that writes the picked cell, tile or bin.

import { sources, loadWorld } from "./basemap.js";
import { renderCell, saveBlob } from "./cellexport.js";

// select, status, credit: elements. onWorld(world or null) after each change.
export function basemapControl({ select, status, credit, onWorld }) {
  for (const [id, src] of Object.entries(sources)) select.add(new Option(src.label, id));
  let want = "none", world = null;
  async function set(id) {
    id = id in sources ? id : "none";
    if (id === want && (world || id === "none")) return;
    want = id;
    select.value = id;
    credit.innerHTML = sources[id].credit || "";
    if (id === "none") { world = null; status.textContent = ""; onWorld(null); return; }
    try {
      const w = await loadWorld(id, (msg) => { if (want === id) status.textContent = msg; });
      if (want !== id) return;
      world = w;
      status.textContent = "";
    } catch (e) {
      if (want !== id) return;
      world = null;
      status.textContent = `${sources[id].label} did not load (${e.message}). Check the connection and try again.`;
    }
    onWorld(world);
  }
  return { set, get id() { return want; }, get world() { return world; } };
}

// button, size (a select of pixel counts), status: elements. bm(): the
// basemap id. job(): the cell to write, as renderCell's arguments plus a
// file name stem, or null.
export function exportControl({ button, size, status, bm, job }) {
  let busy = false;
  button.addEventListener("click", async () => {
    const j = job();
    if (!j || busy) return;
    busy = true;
    const label = button.textContent;
    button.textContent = "Rendering...";
    button.disabled = true;
    try {
      const r = await renderCell({ ...j, bm: bm(), size: +size.value, status: (msg) => (status.textContent = msg) });
      saveBlob(r.blob, `${j.name}-${bm()}-${r.width}x${r.height}.tif`);
      status.textContent = `Written, ${r.width} x ${r.height} pixels` + (r.note ? `; ${r.note}.` : ".");
    } catch (e) {
      status.textContent = `The GeoTIFF could not be written (${e.message}).`;
    } finally {
      busy = false;
      button.textContent = label;
      button.disabled = false;
    }
  });
  return { get busy() { return busy; } };
}
