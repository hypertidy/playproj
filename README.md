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
the way a paper cone opens.

"Axis tilt" turns the globe under the surface, so the cone or cylinder sits
on an axis away from the earth's (an oblique aspect; at 90 degrees, the
transverse aspect). The tilted conformal cylinder is the Oblique Mercator
(`+proj=omerc`), and at 90 degrees the Transverse Mercator; the others are
written with `+proj=ob_tran`, which proj4js lacks, so their maps are drawn
from the construction and checked against PROJ in the tests.

Hash keys: `prop` (`eqd`, `conf`, `area`), `lat1`, `lon`, `tilt` (-90 to
90), `t` (unroll, 0 to 1), `links`, plus the shared ones below.

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

## Globals and interrupteds

`globals.html` takes the whole-world formulas: Mollweide, Goode homolosine,
sinusoidal, Eckert IV, Equal Earth, Robinson, Natural Earth, Hammer and
Winkel tripel. Nothing physical makes them, so the surface is the map: a grid
over each lobe in longitude and latitude, every node with its place on the
globe and on the map. "Unfold" rolls the map out from the globe onto a
cylinder that flattens as it grows, so the seam opens at the back.

"Interruption" cuts the map into lobes: Goode's land lobes (PROJ's `igh` for
the homolosine, `imoll` for Mollweide), his ocean lobes (`igh_o`, `imoll_o`),
or any number of gores. Any base with a straight, evenly divided equator can
be interrupted (Hammer and Winkel tripel cannot: their lobes would not meet).
"Interrupt" slides every lobe's central meridian from the map's own to the
lobe's, so at 0 it is one unbroken map with the cuts drawn on it and at 1 the
interrupted map. Lobes are offset along x so they meet on the equator; for
Mollweide lobes this follows PROJ's anchoring on the first northern lobe, so
`imoll` and `imoll_o` match PROJ exactly.

The octahedral butterfly is Cahill's: the globe projected from its centre
onto the eight faces of a circumscribed octahedron (`+proj=gnom` from each
face centre), unfolded around the North Pole with each southern face hanging
from its northern twin. Its Unfold has two halves: the globe falls onto the
octahedron along rays from the centre, then the octahedron opens like a paper
model, northern faces turning about the pole and southern faces on their
equator hinges. The edge meridian defaults to 20 W, as in Cahill-Keyes.

`js/families/globals.js` follows PROJ's code for every formula (including
Robinson's single-precision table) and `test/check-globals.mjs` compares it
with PROJ 9.8 itself (`test/fixtures/globals-proj.json`, made by
`test/make-globals-fixture.py`). The basemap image and GeoTIFF export are the
surface laid flat and drawn by the GPU, so no inverse is needed; exports are
offered when PROJ has a name for the map. Winkel tripel's string spells out
`+lat_1=50.4597762521898`: PROJ's own default, but a PROJ string read as a
CRS (as GDAL reads it) otherwise gets `lat_1=0`. Hash keys: `base`, `lobes`
(`none`, `land`, `ocean`, `gores`), `gores`, `s` (interrupt, 0 to 1), `lon0`
(central meridian, or the butterfly's edge meridian), `t` (unfold), `cuts`,
plus the shared ones below.

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

## s2 cells

`cells.html` builds [S2](https://s2geometry.io/) cells the way the library
does. Put a light at the centre of the globe and a cube round it: every point
casts onto one of six faces (the gnomonic projection, six times). Each face is
stretched by a quadratic so its cells are closer to equal area, then cut into
a grid that splits in four at every level, and the cells are numbered along a
Hilbert curve that runs unbroken from face 0 to face 5. "Unfold" swells the
globe to the cube and opens the cube into the staircase net the curve
follows; "Without the stretch" overlays the plain gnomonic grid.

Click a cell for its token, level, centre and area, or paste a token. Parent
and Child step through levels (0 to 30), and GeoJSON copies the cell as a
polygon. `js/s2.js` is a port of the parts of s2geometry needed for this,
checked against s2sphere in `test/fixtures/s2-cells.json`. Hash keys: `lvl`
(0 to 12), `t` (unfold, 0 globe, 0.5 cube, 1 net), `cell` (a token),
`curve`, `grid`, `coast`, `uvgrid`, `cam`.

## MGRS and Sentinel-2

`sentinel.html` shows UTM as one transverse Mercator cylinder laid on its
side round the globe and turned 6 degrees at a time to make the 60 zones.
"Unroll" lifts the current zone off the globe onto its cylinder and opens it
flat; "Turn the cylinder" steps it round all 60 zones. The cylinder is scaled
by 0.9996, so it cuts the globe along two lines (amber) about 180 km either
side of the central meridian, where the scale is exactly 1.

The zone carries the MGRS grid in its own UTM coordinates: 8-degree latitude
bands (grid zones such as 32V), 100 km squares and their two-letter names,
and the two exceptions (32V widened over Norway, and 31X, 33X, 35X, 37X
widened over Svalbard so that 32X, 34X and 36X do not exist). Over it are the
Sentinel-2 tiles of that zone and of the zones either side. A tile is an
MGRS 100 km square 109.8 km wide, so tiles overlap by 9.8 km east and south;
drawn translucent, the overlaps glow brighter. Tiles at a zone's edge run on
past it, so near the edge the same ground is in tiles from two zones, in two
coordinate systems.

"UPS north" and "UPS south" show the polar caps, where MGRS switches to
Universal Polar Stereographic (north of 84 N, south of 80 S): a light at one
pole casts the other cap down its rays onto a plane, lowered to scale 0.994 so
it cuts the globe near 81.1 degrees. The caps are split at Greenwich into grid
zones A and B (south) and Y and Z (north), with their own 100 km square
letters. Sentinel-2 has no UPS tiles; its UTM tiles in band C run on to about
84 S, and they are carried onto the plane too.

Click the globe or the zone, or paste a lon, lat, an MGRS reference or a
tile name, for the point's UTM coordinates and EPSG code, its MGRS reference,
and every tile containing it; GeoJSON copies the point and those tiles.

`js/mgrs.js` has UTM (Krueger's series to sixth order, as in PROJ), UPS,
MGRS references both ways (polar ones too), and the tiling rules, which reproduce all 56,686 tiles
of ESA's tiling grid: the tile's top left corner is its square's, moved onto a
60 m grid from easting 0 and the equator, and its band letter is the band of
the square's centre. Which squares are tiles (ESA leaves out edge squares
that are mostly outside their zone) is in `data/s2-tiles.json`, a bitmask per
grid zone. `test/check-mgrs.mjs` checks UTM against PROJ, references against
GeoTrans and tile lookups against the footprints in ESA's grid, using
`test/fixtures/mgrs-points.json` from `test/make-mgrs-fixtures.py`, and UPS
against PROJ and GeoTrans with `test/fixtures/ups-points.json` from
`test/make-ups-fixture.py`. Hash
keys: `mode` (`utm`, `upsn` or `upss`), `zone` (1 to 60), `t` (0 globe, 0.5 cylinder, 1 flat), `pt` (lon,lat),
`tile`, `s2`, `nb` (next zones' tiles), `sq` (100 km squares), `coast`,
`cyl`, `cam`.

## Model grids

`grids.html` shows the curvilinear grids that climate and ocean models compute
on. A model works on arrays, so its grid is one or more rectangles of cells
bent round the sphere; "Unfold" moves every point in a straight line from the
globe to the array, where the grid is straight and the world bends instead.
Every single grid on a sphere has singular points (amber), and each design
puts them somewhere different:

| Grid          | Built from                                              | Singular points               |
|---------------|---------------------------------------------------------|-------------------------------|
| Rotated pole  | lon/lat with the pole moved, PROJ `ob_tran` (CF `rotated_latitude_longitude`) | the two rotated poles |
| Tripolar      | Mercator-spaced lon/lat joined to Murray's (1996) bipolar cap, as in GFDL MOM | the South Pole and two poles on land on the join latitude |
| Cubed sphere  | six gnomonic faces (`+proj=gnom`), equiangular as in FV3 or plain | the eight cube corners |
| Yin-Yang      | two overlapping low-latitude lon/lat patches (Kageyama and Sato 2004) | none |

The rotated pole page draws the EURO-CORDEX domain, a rectangle in rotated
coordinates. The tripolar cap is a lon/lat grid on a second sphere whose poles
sit on its equator, carried onto the cap by stereographic projection, so the
grid stays orthogonal; its top row is the fold, where the array meets itself
reversed. Click a cell for its index, centre, area and the angle its grid
lines meet at. `js/grids.js` holds the grids; `test/check-grids.mjs` checks
`ob_tran` and the tripolar cap against PROJ (`test/fixtures/grids-proj.json`,
made by `test/make-grids-fixture.py`), the cube faces against proj4js `gnom`,
and that each grid round-trips and the tripolar grid is orthogonal and folds.
Hash keys: `g` (`rot`, `tri`, `cube`, `yy`), `t` (unfold), `step` (spacing in
degrees), `plat`, `plon` (rotated pole, CF grid north pole), `join`, `tlon`
(tripolar join latitude and pole longitude), `eq` (0 for plain gnomonic cube
faces), `cell` (patch, i, j), `coast`, `grat`, `cam`.

## L3 bins

`bins.html` shows the level-3 bin grid of SeaWiFS, MODIS and their
successors (NASA Technical Memorandum 104566 vol. 32, Campbell, Blaisdell
and Darzi 1995): rows of equal height, each holding a whole number of bins
as wide as those at the equator, so every bin has nearly the same area.
"Unwrap" swells the globe to a cylinder, opens it with each row shrunk to
its bin count (the integerized sinusoidal, stepped where the count changes),
then slides the rows left into the ragged array the bins are stored in,
numbered from 1 in the south-west, west to east, south to north. A coarse
grid is drawn (6 to 180 rows); the lookup works on 2160 (SeaWiFS, 9.28 km),
4320 (MODIS, 4.64 km), 8640 or 17280 rows: click the globe, or type a bin
number or a lon, lat, for the bin's row, column, bounds and area, and copy it
as GeoJSON. `js/l3bin.js` holds the grid; `test/check-l3bin.mjs` checks the
published bin totals (5,940,422 and 23,761,676) and round trips. Hash keys:
`rows` (index of the drawn grid), `t` (unwrap), `grid` (rows for the
lookup), `bin`, `lines`, `coast`, `cam`.

## For example

`example.html` is a storyboard: eight short steps retelling the first part of
Mike Bostock's 2013 Eyeo talk
[For Example](https://bost.ocks.org/mike/example/) (text archived at
[mdsumner/flawedexample](https://github.com/mdsumner/flawedexample)), whose
live examples no longer run. It starts from his "flawed example" of adaptive
resampling in d3-geo, explains what it shows (graticule, plate carree, the
transverse aspect, the midpoint test and its dependence on scale), then why
it matters: Antarctica turning inside out in Albers without resampling, and
any land crossing the seam once the globe is rotated. Back and Next (or the
arrow keys) step through it; each step has at most one slider, and some can
be dragged. Hash keys: `s` (step, from 0), `p` (the step's slider), `rot`.
The midpoint test is redrawn by `resampleArc` in `js/mishaps.js`, which
`test/check-mishaps.mjs` checks keeps the same points as d3-geo.

## Homage

`homage.html` is a storyboard of map projections that have been argued about
in public, as a small homage to the people who kept explaining them: the UN
emblem (a north polar azimuthal equidistant map to 60 S, beside the Lambert
azimuthal equal-area), both carried on to the antipode; Greenland slid down to
the Congo in Mercator; every country at its true size in place on Mercator
(each in laea about its own centroid, as in this
[laea-vs-mercator gist](https://gist.github.com/mdsumner/045b19365f605492baed2fe85b15afd5),
countries from `data/countries-110m.json`, Natural Earth 110m via
world-atlas); Gall-Peters and south-up, after the Cartographers for Social
Equality in The West Wing (season 2, episode 16); Equal Earth (Savric,
Jenny and Patterson 2018); Fuller's Dymaxion; and the projections named in
[xkcd 977](https://xkcd.com/977/). The credits are in the page's About panel.
Robinson, Winkel tripel, Van der Grinten and cylindrical equal-area (Gall-Peters,
Hobo-Dyer) are written as d3 raw projections in `js/homage-geo.js`;
`test/check-homage.mjs` checks them and the rest against PROJ 9.8
(`test/fixtures/homage-proj.json`, from `test/make-homage-fixture.py`).
PROJ's `+proj=wintri` defaults to `lat_1=0`, so Winkel's own
`lat_1=acos(2/pi)` is given explicitly. The Dymaxion faces are gnomonic about
each face centre on Fuller's icosahedron (Fuller's own face transform differs a
little), and the net is found rather than copied: a maximum spanning tree of the
faces weighted by the land each edge crosses, so the cuts fall in the sea. Hash
keys: `s` (step, from 0), `p` (the step's slider).

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
js/families/globals.js      whole-world formulas, their lobes, and the octahedral butterfly, from PROJ
globals.html, js/globals.js globals and interrupteds page
catastrophes.html, js/catastrophes.js  map catastrophes page
js/mishaps.js               catastrophe steps, vertex-by-vertex and spherical drawing
cells.html, js/cells.js     s2 cells page
js/s2.js                    S2 faces, cell ids and tokens, from s2geometry
grids.html, js/grids-page.js  model grids page
js/grids.js                 rotated pole, tripolar, cubed sphere and Yin-Yang grids
example.html, js/example.js For example storyboard
homage.html, js/homage.js   homage storyboard: UN emblem, Gall-Peters, Equal Earth, Dymaxion, xkcd 977
js/homage-geo.js            Robinson, Winkel tripel, Van der Grinten, cea; Dymaxion icosahedron and net
sentinel.html, js/sentinel.js  MGRS and Sentinel-2 page
js/mgrs.js                  UTM, MGRS references and Sentinel-2 tiles
data/countries-110m.json    Natural Earth 110m country parts as flat [lon, lat] rings
data/s2-tiles.json          which MGRS squares are Sentinel-2 tiles (ESA tiling grid)
bins.html, js/bins.js       L3 bins page
js/l3bin.js                 SeaWiFS / MODIS level-3 bin grid
test/fixtures/              reference points projected by PROJ
data/                       Natural Earth coastlines as [lon, lat, ...] polylines
test/check-proj.mjs         ray construction vs proj4js
test/check-secant.mjs       secant planes vs PROJ (fixture made with PROJ 9.8)
test/check-oblique.mjs      tilted cones and cylinders (omerc, ob_tran) vs PROJ 9.8
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
`test/fixtures/spilhaus-proj.json`; `test/check-globals.mjs` does the same for the
globals, their interruptions and the butterfly's faces. `test/check-mishaps.mjs` checks the catastrophes page's map
frames against d3-geo and the areas behind its captions. `test/check-s2.mjs` checks
cell tokens and corners against `test/fixtures/s2-cells.json`, made with
s2sphere. `test/check-grids.mjs` checks the model grids against PROJ and proj4js.
`test/check-mgrs.mjs` checks UTM against PROJ, MGRS references against
GeoTrans, and Sentinel-2 tile lookups against ESA's tiling grid. `test/check-inverse.mjs` round-trips project and inverse for every light
position. To check that GDAL reads the exported CRS (needs rasterio):

```sh
node test/write-tifs.mjs /tmp/tifs && python3 test/check-geotiff.py /tmp/tifs
```

## Plans

- A family module format so new projection families are one file each.
- Projections with no physical construction (Mollweide, Robinson and so on),
  shown through their distortion (the globals page shows them unrolled, not
  yet their distortion).

Contributions are welcome. Please note that this project is released with a
[Contributor Code of Conduct](CODE_OF_CONDUCT.md).

Coastlines are from [Natural Earth](https://www.naturalearthdata.com/) (public domain).
The Sentinel-2 tiling grid is ESA's (Copernicus Sentinel data), read from the
shapefile conversion at
[justinelliotmeyers/Sentinel-2-Shapefile-Index](https://github.com/justinelliotmeyers/Sentinel-2-Shapefile-Index).
