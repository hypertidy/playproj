// The projection families, each one module with the same shape.
//
// A family is a set of projections chosen by a parameter object p. Every
// family module exports:
//
//   R              the sphere radius its PROJ strings and GeoTIFFs use, metres
//   defaults       a complete parameter object
//   project(lon, lat, p)   lon/lat in degrees -> [x, y] on the plane in
//                  sphere radii (multiply by R for metres), or null where
//                  the point does not map; extra entries after x, y are
//                  allowed (globals adds the piece a point fell in)
//   inverse(x, y, p)       [lon, lat] in degrees, or null; optional (globals
//                  has none)
//   projString(p)  the PROJ string, with +R, or null where PROJ has no
//                  single projection for p
//   geoKeys(p)     GeoTIFF keys for geotiff-write.js, or null
//   describe(p)    one or two sentences on what p is
//
// and may add its own helpers (proj4String, the construction's geometry,
// the lobes of an interrupted map). A family takes p whole: callers start
// from defaults and change what they need.

import * as perspective from "./perspective.js";
import * as azimuthal from "./azimuthal.js";
import * as conic from "./conic.js";
import * as spilhaus from "./spilhaus.js";
import * as globals from "./globals.js";

export const families = { perspective, azimuthal, conic, spilhaus, globals };

// The functions every family has, for checking a new one.
export const REQUIRED = ["project", "projString", "geoKeys", "describe"];
