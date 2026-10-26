// The playproj core: projection families, grids and cells, distortion,
// raster and file structure, readers and writers. Pure ES modules with no
// DOM, canvas or three.js, so they run in Node or any page. proj4js, where
// a module uses it, is passed in by the caller.
//
// Each module is exported whole under its own name, since several share
// helper names (toXYZ, R, describe):
//
//   import { families, grids, tissot } from "./src/core/index.js";
//   families.conic.project(147, -42, families.conic.defaults);

export { families, REQUIRED } from "./families/index.js";
export * as perspective from "./families/perspective.js";
export * as azimuthal from "./families/azimuthal.js";
export * as conic from "./families/conic.js";
export * as spilhaus from "./families/spilhaus.js";
export * as globals from "./families/globals.js";

export * as tissot from "./tissot.js";
export * as distortion from "./distortion.js";

export * as grids from "./grids.js";
export * as roms from "./roms.js";
export * as regular from "./regular.js";
export * as s2 from "./s2.js";
export * as icosa from "./icosa.js";
export * as l3bin from "./l3bin.js";
export * as mgrs from "./mgrs.js";
export * as aatgrid from "./aatgrid.js";
export * as polarstere from "./polarstere.js";
export * as seaice from "./seaice.js";
export * as track from "./track.js";
export * as rhumb from "./rhumb.js";
export * as ellipsoid from "./ellipsoid.js";
export * as geoid from "./geoid.js";
export * as ortho from "./ortho.js";
export * as vicgrid from "./vicgrid.js";
export * as sight from "./sight.js";

export * as geo from "./geo.js";
export * as landmesh from "./landmesh.js";
export * as mishaps from "./mishaps.js";
export * as homageGeo from "./homage-geo.js";
export * as eratosthenes from "./eratosthenes.js";
export * as rasterize from "./rasterize.js";
export * as texmap from "./texmap.js";
export * as sphull from "./sphull.js";
export * as affine from "./affine.js";

export * as structure from "./structure.js";
export * as chunkgrid from "./chunkgrid.js";
export * as basemap from "./basemap.js";
export * as geotiff from "./geotiff-write.js";
export * as cellexport from "./cellexport.js";
export * as mosaic from "./mosaic.js";

export * as palette from "./palette.js";
export * as meshframe from "./meshframe.js";
