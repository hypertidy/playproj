// A projected elevation COG read in place: the full grid and its overviews
// opened once, then for each block only the window, at the level, that
// its columns need (planWindow in src/core/voxels.js). The CRS comes from
// the file's GeoKeys and must be one zoneForward knows (UTM or MGA).

import { loadScript } from "./basemap-load.js";
import { planWindow, zoneForward } from "../src/core/voxels.js";

const GEOTIFF_JS = "https://cdn.jsdelivr.net/npm/geotiff@3.0.5/dist-browser/geotiff.js";

const opened = new Map();

// { images, src: { nx, ny, x0, dx, y0, dy, levels }, fwd, epsg, nodata }
export function openDem(url, status = () => {}) {
  if (!opened.has(url)) {
    const p = (async () => {
      if (typeof GeoTIFF === "undefined") await loadScript(GEOTIFF_JS);
      status("Opening the regional DEM...");
      const tiff = await GeoTIFF.fromUrl(url);
      const base = await tiff.getImage(0), count = await tiff.getImageCount();
      const images = [base];
      for (let i = 1; i < count; i++) {
        const im = await tiff.getImage(i);
        // skip mask images, keep the reduced-resolution ones
        if ((im.fileDirectory.NewSubfileType || 0) & 4) continue;
        images.push(im);
      }
      const keys = base.getGeoKeys() || {};
      const epsg = keys.ProjectedCSTypeGeoKey || 0;
      const fwd = zoneForward(epsg);
      if (!fwd) throw new Error(`its CRS (EPSG:${epsg || "unknown"}) is not one this page reads`);
      const [x0, y0] = base.getOrigin(), [dx, dy] = base.getResolution();
      const nx = base.getWidth(), ny = base.getHeight();
      const levels = images.map((im) => nx / im.getWidth());
      const nd = base.getGDALNoData();
      return { images, src: { nx, ny, x0, dx, y0, dy, levels }, fwd, epsg, nodata: nd === null ? null : Math.fround(nd) };
    })();
    p.catch(() => opened.delete(url));
    opened.set(url, p);
  }
  return opened.get(url);
}

// The DEM window over pts (lon/lat round the block) for columns cellM
// metres across, as gridSampler takes it, or null where the block misses
// the DEM. Each level's pixel size is the full grid's times its factor.
export async function readDemWindow(dem, pts, cellM, lat0, status = () => {}, max = 2048) {
  const plan = planWindow(dem.src, dem.fwd, pts, cellM, lat0, max);
  if (!plan || plan.width < 2 || plan.height < 2) return null;
  const im = dem.images[plan.level], f = dem.src.levels[plan.level];
  status(`Reading the regional DEM at ${+(Math.abs(dem.src.dx) * f * plan.step).toFixed(1)} m...`);
  const ras = await im.readRasters({
    window: [plan.i0, plan.j0, plan.i1, plan.j1], width: plan.width, height: plan.height,
    samples: [0], interleave: true, resampleMethod: "nearest"
  });
  const elev = ras instanceof Float32Array ? ras : Float32Array.from(ras);
  // the read spreads the window over width x height, so its cells are the
  // window's span over those counts
  const dx = ((plan.i1 - plan.i0) * f * dem.src.dx) / plan.width;
  const dy = ((plan.j1 - plan.j0) * f * dem.src.dy) / plan.height;
  return {
    elev, width: plan.width, height: plan.height, x0: plan.x0, y0: plan.y0, dx, dy,
    nodata: dem.nodata, cellM: Math.min(Math.abs(dx), Math.abs(dy)), level: plan.level
  };
}
