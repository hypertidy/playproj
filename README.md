# playproj

Map projections drawn the way they are built: a point of light, a sphere and
a plane. Each map point is where a ray from the light, through a point on the
sphere, lands on the plane. Move the light, the plane or the camera and watch
the projection change.

This continues the 2016 post
[Three projections](https://mdsumner.github.io/2016/01/26/Three_Projections.html)
and the R package `pproj` that tried to generalise it (now in
[`legacy/pproj`](legacy/pproj)).

## What is here

The first page covers the azimuthal perspective family. One slider moves the
light along the axis through the sphere:

| Light                   | Projection              | PROJ                     |
|-------------------------|-------------------------|--------------------------|
| at the antipode         | stereographic           | `+proj=stere`            |
| at the centre           | gnomonic                | `+proj=gnom`             |
| above the tangent point | near-side perspective   | `+proj=nsper +h=...`     |
| infinitely far          | orthographic            | `+proj=ortho`            |

Positions in between are valid perspective constructions with no PROJ name,
and the page draws them anyway.

Two azimuthal projections need no light, and the page draws them as
constructions on the same sphere and plane:

- **Compass** (`+proj=laea`): set a compass on the tangent point, open it to
  a point on the sphere, and swing it down onto the plane. The chord is
  2 sin(c/2) for angular distance c, which is exactly the equal-area radius.
- **String** (`+proj=aeqd`): lay a string along the great circle from the
  tangent point to the point, then pull it flat onto the plane.

The 3D scene comes from the ray construction. The flat map is drawn by
[proj4js](https://github.com/proj4js/proj4js) from the PROJ string whenever
one exists, so each view checks the other, and the page reports how closely
they agree.

## Run it

It is a static site with no build step. Libraries (three.js, proj4js,
d3-geo) load from jsDelivr.

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

## Cones and cylinders

`cones.html` wraps a cone round the sphere, touching it along a standard
parallel, and unrolls it flat. The cone constant n = sin(standard parallel)
is the fraction of a circle the flat cone fills, so moving the standard
parallel to the equator turns the cone into a cylinder and moving it to a
pole turns it into a plane. Each property is one family across all three:

| Property    | Cylinder | Cone   | Plane   |
|-------------|----------|--------|---------|
| Equidistant | `eqc`    | `eqdc` | `aeqd`  |
| Conformal   | `merc`   | `lcc`  | `stere` |
| Equal-area  | `cea`    | `aea`  | `laea`  |

"Sweep cone" runs the standard parallel from pole to pole, morphing plane
to cone to cylinder and back. "Unroll" opens the cone with its apex fixed,
the way a paper cone opens. Hash keys: `prop` (`eqd`, `conf`, `area`),
`lat1`, `lon`, `t` (unroll, 0 to 1), `links`, plus the shared ones below.

## Spilhaus

`spilhaus.html` shows Spilhaus' world ocean map, an oblique Adams World in a
Square II. Nothing physical makes it, so the surface is the map: a grid over
the square carried back onto the sphere by the inverse projection. "Unfold"
moves every point in a straight line from the globe to the square, and the
square's own grid shows how a conformal net wraps the sphere, pinched at the
corners. The centre and azimuth can be changed for any oblique Adams square.

`js/families/spilhaus.js` is a port of PROJ's `spilhaus` and `adams_ws2`
(Evenden, Evers, Wilkinson, Jimenez Shaw), checked against PROJ itself. The
inverse is a Newton iteration, so the page solves it exactly on a grid and
interpolates between nodes (within 0.003 degrees) for the basemap. GeoTIFF
exports carry the PROJ string in an ESRI PE string's PROJ4 extension, which
GDAL reads. Hash keys: `t` (unfold, 0 to 1), `lat`, `lon`, `azi` (the
centre and azimuth), `net` (0 hides the square grid), `links`, plus the
shared ones below.

## Catastrophes

`catastrophes.html` lets the usual map catastrophes happen. The globe and the
flat map are one surface, cut along the map's seam (red) and opened through a
cylinder, so "Unwrap" shows where each part of the map comes from; the map's
poles (amber) are points on the globe and lines on the map. The same vertices
are drawn two ways:

- **Vertex by vertex**: project each vertex and join them with straight lines
  on the map, filling with the even-odd rule, as planar GIS code does.
- **On the sphere**: great-circle edges, cut at the seam and closed round the
  poles, with the winding order deciding which side is inside, as
  [d3-geo](https://github.com/d3/d3-geo) (and s2) do. d3 draws this side.

Six steps, each with a caption: a polygon crossing the antimeridian, a ring
round the pole, straight lines against great circles, a counterclockwise
(GeoJSON order) ring that d3 turns inside out, a circle bigger than a
hemisphere, and coastlines recentred on the Pacific. The map centre moves the
seam and the poles while the data stays put. Hash keys: `c` (step), `m`
(`naive` or `sphere`), `flip` (reverse winding), `ghost` (dashed outline of
the other way), `lon`, `lat` (map centre), `flat` (`eqc` or `merc`), `t`
(unwrap), `coast`, `grat`, `cam`.

## Basemaps and GeoTIFF export

The plane can carry a basemap, reprojected pixel by pixel by casting each
plane pixel's ray back onto the sphere:

- GEBCO 2026 elevation, read from the smallest overview of the
  [Source Cooperative COG](https://source.coop/ausantarctic/gebco) that is at
  least 2048 pixels wide, coloured with hypsometric tints and a hillshade.
- Esri World Imagery, one zoom level of Web Mercator tiles (so no data
  beyond 85 degrees).

The same image wraps the globe. "Download GeoTIFF" writes the projected
image as RGBA with its CRS: stereographic, gnomonic and orthographic as
GeoTIFF projection keys, near-side perspective as an ESRI PE string (the
form GDAL writes), and positions with no PROJ equivalent with no CRS.

## Share and embed

The view state lives in the URL hash, so a link reproduces what you see:

```
index.html#v=0.75&lat=-42&lon=147&w=2&rays=200&cam=4.6,2.6,6.2,0,0.5,0
```

| Key      | Meaning                                                        |
|----------|----------------------------------------------------------------|
| `az`     | construction: `light` (default), `laea` (compass) or `aeqd` (string) |
| `v`      | light position on the slider, -1 to 1 (-0.5 antipode, 0 centre, 1 infinity) |
| `lat`, `lon` | tangent point in degrees                                   |
| `ts`     | true scale (lat_ts), 0 to 90: 90 is the tangent plane, lower values drop it to cut the sphere (polar stere `+lat_ts`, oblique stere `+k_0`, gnom and nsper an affine step) |
| `w`      | plane half-width in sphere radii                               |
| `rays`   | number of rays drawn, up to 5000                               |
| `seed`   | which random points get rays                                   |
| `from`   | where rays start: `tri` land triangle centres (default), `vert` land mesh vertices, `coast` coastline vertices (area-weighted except `coast`), or `even`: an evenly spaced lattice on land, where `rays` (or `links`) sets the density |
| `detail` | coastline scale, `110m` or `50m`                               |
| `grat`, `globe` | 0 hides the graticule or the globe                      |
| `bm`     | basemap: `none` (default), `gebco` or `esri`                   |
| `relief` | GEBCO relief exaggeration, 0 (off) to 100, on every page; `wire` 1 draws it as wireframe |
| `spin`   | 1 slowly orbits the camera round the scene                     |
| `cam`    | camera position and target, six numbers                        |

Add `?embed=1` for a compact view to put in an iframe; the "Copy embed code"
button writes the snippet for the current view.

## Layout

```
index.html                  page
css/app.css                 styles
js/app.js                   scene, map and controls
js/geo.js                   coastline loading, graticule, scene frame
js/landmesh.js              land triangulated from the coastlines, and ray sampling
js/basemap.js               basemap sources and per-pixel reprojection
js/geotiff-write.js         GeoTIFF writer with user-defined CRS keys
js/families/perspective.js  azimuthal perspective family: rays, PROJ string, GeoTIFF keys
js/families/conic.js        cone family with cylinder and plane limits
cones.html, js/cones.js     cones and cylinders page
js/families/azimuthal.js    compass (laea) and string (aeqd) constructions
js/families/spilhaus.js     Spilhaus / Adams World in a Square II, from PROJ
spilhaus.html, js/spilhaus.js  Spilhaus page
catastrophes.html, js/catastrophes.js  map catastrophes page
js/mishaps.js               catastrophe steps, vertex-by-vertex and spherical drawing
test/fixtures/              reference points projected by PROJ
data/                       Natural Earth coastlines as [lon, lat, ...] polylines
test/check-proj.mjs         ray construction vs proj4js
test/check-secant.mjs       secant planes vs PROJ (fixture made with PROJ 9.8)
legacy/pproj/               the original R package and experiments
```

## Test

```sh
npm install
npm test
```

`test/check-proj.mjs` compares the ray construction with proj4js for every
light position that has a PROJ equivalent, at several tangent points.
`test/check-conic.mjs` does the same for the cone family (all three
properties, cylinder and plane limits, both hemispheres) and round-trips its
inverse. `test/check-azimuthal.mjs` checks the compass and string
constructions against proj4js. proj4js has no Spilhaus, so
`test/check-spilhaus.mjs` compares with points projected by PROJ itself, in
`test/fixtures/spilhaus-proj.json`. `test/check-mishaps.mjs` checks the catastrophes page's map
frames against d3-geo and the areas behind its captions. `test/check-inverse.mjs` round-trips project and inverse for every light
position. To check that GDAL reads the exported CRS (needs rasterio):

```sh
node test/write-tifs.mjs /tmp/tifs && python3 test/check-geotiff.py /tmp/tifs
```

## Plans

- A family module format so new projection families are one file each.
- Projections with no physical construction (Mollweide, Robinson and so on),
  shown through their distortion.

Contributions are welcome. Please note that this project is released with a
[Contributor Code of Conduct](CODE_OF_CONDUCT.md).

Coastlines are from [Natural Earth](https://www.naturalearthdata.com/) (public domain).
