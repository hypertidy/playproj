// The data files playproj ships, fetched relative to this module. The
// geometry modules take the data itself, so a caller elsewhere can load
// them from wherever it keeps them.

const cache = new Map();

// Coastlines are stored as an array of polylines, each a flat
// [lon, lat, lon, lat, ...] array (Natural Earth, public domain).
export function loadCoastline(detail = "110m") {
  if (!cache.has(detail)) {
    const url = new URL(`../data/coastline-${detail}.json`, import.meta.url);
    cache.set(detail, fetch(url).then((r) => {
      if (!r.ok) throw new Error(`could not load ${url}`);
      return r.json();
    }));
  }
  return cache.get(detail);
}

// The EGM2008 geoid at whole degrees, as int16 centimetres (layout in
// src/core/geoid.js); an ArrayBuffer.
export function loadGeoid() {
  if (!cache.has("geoid")) {
    const url = new URL("../data/geoid-egm2008-1deg.bin", import.meta.url);
    cache.set("geoid", fetch(url).then((r) => {
      if (!r.ok) throw new Error(`could not load ${url}`);
      return r.arrayBuffer();
    }));
  }
  return cache.get("geoid");
}
