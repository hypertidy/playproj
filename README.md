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

It is a static site with no build step. Libraries (three.js, earcut, proj4js,
d3-geo) load from jsDelivr.

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

## Guide

`guide.html` is a reading path through the other pages: twelve short
chapters (the body; a light and a plane; cones and cylinders; distortion;
great circles and rhumbs; the central projection beyond maps; poles and the
antimeridian; the whole world; grids of cells; the array is the map; datums;
things that go wrong), each linking the pages that make its argument, with
their state set in the link. It is plain HTML with no scripts.

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

## Sight and shade

`sight.html` asks what a light can see over a synthetic landscape. With the
eye on the spot it is a viewshed: the terrain is projected through the eye
into four gnomonic wedges (north, east, south, west), where 3D straight lines
stay straight, and triangles are added nearest first while a horizon (the
upper envelope of their projected edges) is kept; a vertex is visible when
it rises above it. Drag the distance and the eye moves away from the spot
towards an azimuth and elevation; at infinity it is the sun, the view is
orthographic, and the visible ground is the lit ground. The lower half draws
what the light sees, far to near, with the horizon left at the end (the
skyline). `src/core/sight.js` has the terrain, the projections and the
horizon method, and `test/check-sight.mjs` checks it against marching every
line of sight (better than 99.8% of vertices agree; the rest graze), and an
eye 100 000 km away against the sun.

Hash keys: `x`, `y` (the spot, metres), `h` (eye height), `az`, `el`, `t`
(distance, 0 on the spot to 1 at infinity), `rays`, `sky`, `cam`.

## Spilhaus

`spilhaus.html` shows Spilhaus' world ocean map, an oblique Adams World in a
Square II. Nothing physical makes it, so the surface is the map: a grid over
the square carried back onto the sphere by the inverse projection. "Unfold"
moves every point in a straight line from the globe to the square, and the
square's own grid shows how a conformal net wraps the sphere, pinched at the
corners. The centre and azimuth can be changed for any oblique Adams square.

`src/core/families/spilhaus.js` is a port of PROJ's `spilhaus` and `adams_ws2`
(Evenden, Evers, Wilkinson, Jimenez Shaw), checked against PROJ itself. The
inverse is a Newton iteration, so the page solves it exactly on a grid and
interpolates between nodes (within 0.003 degrees) for the basemap. GeoTIFF
exports carry the PROJ string in an ESRI PE string's PROJ4 extension, which
GDAL reads. Hash keys: `t` (unfold, 0 to 1), `lat`, `lon`, `azi` (the
centre and azimuth), `net` (0 hides the square grid), `links`, plus the
shared ones below.

## Distortion (Tissot's indicatrix)

`tissot.html` puts equal small circles on a globe and shows what a projection
makes of them. Each becomes (in the limit) an ellipse whose semi-axes a and b
are the largest and smallest scale at that point: circles everywhere means
conformal, equal areas everywhere means equal-area. Pick a projection or type
any PROJ string proj4js can read, and click a point for its scale factors
(the picked indicatrix is also drawn enlarged, with its unit circle and
axes). "Projected circles" draws the true image of each circle next to the
linearised ellipse.

The indicatrices sit on the graticule (every 10 to 30 degrees) or on a square
grid over the part of the map in view, and their size is either a fixed
ground radius or fitted so they fill a share of the gap to their neighbours.
"Shape only" draws every one with the same area. The same factors are also
worked out at every pixel (`src/core/distortion.js`): any one of them (s, omega, h,
k, a, b, a/b, the departure of theta' from 90 degrees, convergence) can be
shown as an image, as contours at round values, or as the colour of each
ellipse, and "Factors GeoTIFF" saves all eight `proj_factors()` fields over
the view as float32 bands in the map's CRS.

The numbers are those of [PROJ](https://proj.org/)'s `proj_factors()`: h, k,
s, a, b, omega, theta' and convergence. `src/core/tissot.js` computes them from
nothing but a forward function, so it works on PROJ strings and on the ray
constructions alike: it differences the projection at the same four points
round the target that PROJ does and applies the same formulas (Snyder 1987),
as in Bill Huber's [GIS Stack Exchange answer](https://gis.stackexchange.com/a/5075). The perspective and
cones pages have a "Tissot indicatrix" toggle that draws them on their maps
from the constructions. Hash keys: `proj` (preset, or `custom` with `def`),
`lon`, `lat`, `grid` (`g10`, `g15`, `g20`, `g30` on the graticule, `m8` to
`m24` across the map), `auto` (1 fits the spacing, 0 fixed), `fit` (share of
the spacing), `size` (fixed radius, degrees), `norm` (shape only), `field`
(`s`, `omega`, `h`, `k`, `a`, `b`, `ab`, `orth`, `conv`), `img`, `iso`,
`efill`, `inset`, `pt` (picked lon,lat), `ell`, `circ`, `unit`, `axes`,
`grat`; older links with `step` and `color` still work; `tissot=1` on the
perspective and cones pages.

## Ellipsoid

`ellipsoid.html` draws the earth's ellipsoid (WGS84 by default, or any of
eight other PROJ `ellps`) on a globe and in the plane of one meridian, with a
slider that multiplies the flattening. At 1x it is the true shape, which no
screen can tell from the sphere of radius a; exaggerated, the three
latitudes of one point come apart: geodetic (the normal, which misses the
centre and meets the axis after a length N), geocentric (the line to the
centre, as in Earth-centred x, y, z) and parametric (the point straight out
on the circle of radius a). The circle of radius M that fits the meridian
can be drawn too. A table gives every number for the true shape and the
drawn one, so the picture never stands in for the values.

`src/core/ellipsoid.js` has the formulas (Snyder 1987), checked against PROJ
by `test/check-ellipsoid.mjs`: a and b of each `ellps`, x, y, z against
`+proj=cart`, the inverse, and meridian lengths, on the true shapes and on
WGS84 with its flattening times 100. Hash keys: `ell`, `x` (exaggeration),
`lat`, `lon`, `sph`, `par`, `osc`, `coast`, `cam`.

## Geoid

`geoid.html` draws the geoid over the WGS84 ellipsoid with its undulation N
exaggerated (ten thousand times by default, so the 107 m low south of Sri
Lanka is a 1000 km dent), and under it a profile between two places with the
three heights a point has: on the ellipsoid (h = 0), on the geoid (h = N) and,
with GEBCO, on the terrain (h = H + N, H being height above the geoid, "above
sea level"). The flattening can be exaggerated too, the profile hangs on the
globe as a wall from the ellipsoid to the geoid, and the readout gives N, H, h
and the deflection of the vertical from the geoid's slope. The geoid is EGM2008
at whole degrees (`data/geoid-egm2008-1deg.bin`, 128 KB of int16 centimetres:
every 24th node of PROJ's `us_nga_egm08_25.tif`, written by
`test/make-geoid-fixture.py`), read bilinear the way PROJ's `vgridshift` reads
grids; `src/core/geoid.js` matches PROJ on that grid to float rounding, and is
within about 5 m of the full 2.5 minute model. Hash keys: `alon`, `alat`,
`blon`, `blat`, `nx` (exaggeration as a power of ten), `fx`, `ell`, `coast`,
`grat`, `wall`, `bm`, `fit`.

## Orthorectification

`ortho.html` puts a frame camera (an aerial photo) or a pushbroom scanner (a
satellite line) over a synthetic terrain and shows four images of a 10 km
square: the map itself, the raw image the sensor records (one ray traced per
pixel), that image rectified onto a flat datum, and the same image
orthorectified with a DEM (true, smoothed, or a level plane at the mean
height). Relief displacement, (h - z) tan(theta) away from the nadir (across
the track for a pushbroom), shows as arrows and as bent roads; a true ortho
masks the ground the sensor could not see. One picked point is followed from
the ground through the lens to the image and on down to the datum, in the
scene and in all four images. The sensor models (collinearity equations for
the frame camera, a line camera per row for the pushbroom), ray tracing,
visibility and the rectification loop are `src/core/ortho.js`, checked in
`test/check-ortho.mjs`. Hash keys: `s`, `alt`, `tilt`, `az`, `fov`, `terr`,
`rel`, `dem`, `occ`, `arr`, `ov`, `img`, `px`, `py`, `cam`.

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

`src/core/families/globals.js` follows PROJ's code for every formula (including
Robinson's single-precision table) and `test/check-globals.mjs` compares it
with PROJ 9.8 itself (`test/fixtures/globals-proj.json`, made by
`test/make-globals-fixture.py`). The basemap image and GeoTIFF export are the
surface laid flat and drawn by the GPU, so no inverse is needed; exports are
offered when PROJ has a name for the map. Winkel tripel's string spells out
`+lat_1=50.4597762521898`: PROJ's own default, but a PROJ string read as a
CRS (as GDAL reads it) otherwise gets `lat_1=0`. Hash keys: `base`, `lobes`
(`none`, `land`, `ocean`, `gores`), `gores`, `s` (interrupt, 0 to 1), `lon0`
(central meridian, or the butterfly's edge meridian), `t` (unfold), `cuts`, `lobe` (the picked lobe or face, from 0),
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

## Texture mapping

`texture.html` shows how a renderer drapes an image on a mesh. A small mesh of
numbered vertices sits beside its UV layout: the texture image with the same
triangles drawn at their texture coordinates (u, v), which can be dragged.
Hovering either view finds the triangle and the point's barycentric weights,
and shows the blended u, v the GPU reads there. The same equirectangular image
(a lettered test card, or GEBCO) then goes on a lon/lat globe, an icosphere
and a lon/lat mesh laid out in a projection (plate carree, Mercator, south
polar stereographic, Mollweide), to show where per-vertex lookup goes wrong:
shared vertices at the antimeridian smear the whole image across one strip,
one vertex at a pole shears the polar triangles, and coarse triangles bend
the image at their edges wherever lon/lat is not linear across them (the
readout gives the miss in km). "Per pixel" interpolates the position instead
and inverts it in the shader, which is exact at any mesh size. "Affine" turns
off perspective-correct interpolation. The projections are in
`src/core/texmap.js` and checked against proj4js in `test/check-texmap.mjs`.
A photo (Caravaggio's *Basket of Fruit*) or any image of the viewer's own,
read in the browser, shows the same mapping on a picture that is not a map.
Hash keys: `mesh` (`small`, `globe`, `ico`, `plane`), `n`, `bend`, `proj`,
`seam`, `pole`, `look` (`vertex` or `pixel`), `edges`, `aff`, `bm` (`none`, `photo`,
`gebco`, `esri`), `uv`,
`cam`.

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
polygon. `src/core/s2.js` is a port of the parts of s2geometry needed for this,
checked against s2sphere in `test/fixtures/s2-cells.json`. Hash keys: `lvl`
(0 to 12), `t` (unfold, 0 globe, 0.5 cube, 1 net), `cell` (a token),
`curve`, `grid`, `coast`, `uvgrid`, `cam`.

## H3 hexagons

`h3.html` puts [H3](https://h3geo.org/), Uber's hexagonal grid, on the
icosahedron it is built on. A light at the centre of the globe casts every
point onto one of twenty faces (the gnomonic projection, twenty times), and
on each face's plane H3's hexagons are exactly regular. "Unfold" swells the
globe to the icosahedron (placed as Fuller placed it for the Dymaxion map,
every corner in the ocean) and opens it into the strip net. The twelve
pentagons, one at each corner, are outlined at every resolution; "Children"
shows the seven children of the picked cell spilling over its edge, and the
19.1 degree turn between Class II and Class III resolutions.

Click a cell for its index, resolution, base cell, faces and area, or paste
an index. Parent and Child step through resolutions 0 to 15; GeoJSON copies
the cell. The cells come from [h3-js](https://github.com/uber/h3-js) 4.4.0
(from jsDelivr); `src/core/icosa.js` builds the icosahedron from H3's twelve
pentagons, its gnomonic face frames and the hinges of the net, checked
against h3-js in `test/check-icosa.mjs`. Hash keys: `res` (0 to 3), `t`
(unfold, 0 globe, 0.5 icosahedron, 1 net), `cell` (an H3 index), `grid`,
`kids`, `coast`, `col` (`base`, `digit`, `none`), `bm`, `cam`.

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

`src/core/mgrs.js` has UTM (Krueger's series to sixth order, as in PROJ), UPS,
MGRS references both ways (polar ones too), and the tiling rules, which reproduce all 56,686 tiles
of ESA's tiling grid: the tile's top left corner is its square's, moved onto a
60 m grid from easting 0 and the equator, and its band letter is the band of
the square's centre. Which squares are tiles (ESA leaves out edge squares
that are mostly outside their zone) is in `data/s2-tiles.json`, a bitmask per
grid zone. `test/check-structure.mjs` checks the tile and overview readers against
GDAL, tifffile and zarr-python. `test/check-storecrs.mjs` checks CF grid mappings against PROJ, cell areas
against pyproj's Geod, and reading Icechunk and Zarr stores written by xarray and icechunk. `test/check-mgrs.mjs` checks UTM against PROJ, references against
GeoTrans and tile lookups against the footprints in ESA's grid, using
`test/fixtures/mgrs-points.json` from `test/make-mgrs-fixtures.py`, and UPS
against PROJ and GeoTrans with `test/fixtures/ups-points.json` from
`test/make-ups-fixture.py`. Hash
keys: `mode` (`utm`, `upsn` or `upss`), `zone` (1 to 60), `t` (0 globe, 0.5 cylinder, 1 flat), `pt` (lon,lat),
`tile`, `s2`, `nb` (next zones' tiles), `sq` (100 km squares), `coast`,
`cyl`, `cam`.

## AAT grid

`aatgrid.html` is a mini version of [aatgrid](https://github.com/mdsumner/aatgrid),
an R package with a tile scheme for the Australian Antarctic Territory (and a
fuller [explorer](https://mdsumner.github.io/aatgrid/explorer/)). The scheme
is three numbers: an origin at easting 140 000, northing 20 000 shared by every
UTM south zone, 720 pixels on a tile's edge, and the resolution, so tiles are
7.2 km at 10 m, 14.4 km at 20 m and 43.2 km at 60 m, and nest 3 x 3 and 6 x 6
inside a 60 m tile. Ids read `43S_R0060_0005_0094` (zone, resolution, column,
row); the older `L1` and `L2` names for 60 m and 10 m parse too.

The page draws the chosen zone's lattice at the chosen resolution on the globe
south of 45 S, carried past the zone's edge if asked, with the next zones' own
lattices crossing it; the AAT claim (south of 60 S, 45 E to 160 E less Adelie
Land); and, for a picked point, its 60 m tile with the 20 m and 10 m tiles in
it, its tile at the chosen resolution, the extent and GDAL geotransform, the
same ground's id in the next zone, and the Sentinel-2 tiles over it. 10 m and
20 m pixels are Sentinel-2's own; 60 m ones sit 20 m off in each direction,
since Sentinel-2's southern northings are 40 (mod 60) from the 10 000 000 m
false northing. `src/core/aatgrid.js` has the arithmetic on top of the UTM in
`src/core/mgrs.js`. Hash keys: `zone`, `res` (10, 20 or 60), `pt` (lon,lat),
`past` (lattice past the zone edge), `nb` (next zones' lattices), `s2`, `aat`,
`bm`, `cam`.

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
lines meet at. `src/core/grids.js` holds the grids; `test/check-grids.mjs` checks
`ob_tran` and the tripolar cap against PROJ (`test/fixtures/grids-proj.json`,
made by `test/make-grids-fixture.py`), the cube faces against proj4js `gnom`,
and that each grid round-trips and the tripolar grid is orthogonal and folds.
Hash keys: `g` (`rot`, `tri`, `cube`, `yy`), `t` (unfold), `step` (spacing in
degrees), `plat`, `plon` (rotated pole, CF grid north pole), `join`, `tlon`
(tripolar join latitude and pole longitude), `eq` (0 for plain gnomonic cube
faces), `cell` (patch, i, j), `coast`, `grat`, `cam`.

## Index space

`indexspace.html` shows an ocean model grid as the model sees it and as the
ocean has it. A ROMS-style grid is curvilinear in the horizontal (an array of
(i, j) vertices that each carry a longitude and latitude) and
terrain-following in the vertical (N layers in every column, spaced by the
s-coordinate), so each cell (i, j, k) is a cube in index space and a bent,
squashed box in the ocean. Two sliders move every vertex between the two:
Horizontal from the index box to the sphere, Vertical from the even k layers
to depth. The colours (synthetic temperature with a seasonal mixed layer and
drifting eddies, depth, or layer thickness) belong to the index and ride along.

Two conformal synthetic grids: a Mercator ring round Antarctica that wraps in
i, and a log-polar fan off New South Wales, finest at the coast. Bathymetry is
the GEBCO 2026 overview (or an idealized sea floor), masked on land and
smoothed to rx0 <= 0.2 by the minimal positive method of Sikiric et al.
(2009); the page reports rx0 and Haney's rx1. The vertical grid is ROMS's
Vtransform 1 or 2 with Vstretching 1, 2 or 4, shown as ocean.in lines, with a
plot of the layer interfaces against water depth. A ROMS grid in Zarr (v2 or
v3, uncompressed, zlib or gzip; `lon_rho`, `lat_rho`, `h`, and optionally
`mask_rho`, `s_rho` and the vertical settings) can be loaded instead.
`src/core/roms.js` holds the s-coordinate, grids, smoothing, synthetic data and Zarr
reader; `test/check-roms.mjs` checks the depths against a NumPy port of ROMS
`set_scoord`/`set_depth` and the reader against stores written by zarr-python
(`test/make-roms-fixture.py`). Hash keys: `g` (`so`, `fan`, `file`), `wh`,
`wv` (warps), `day`, `f` (`temp`, `z`, `hz`), `si`, `sj` (sections), `top`,
`bot`, `walls`, `sec`, `coast`, `N`, `vt`, `vs`, `ts`, `tb`, `hc`, `n` (cells
along i), `dz` (depth scale), `bathy` (`gebco`, `ideal`), `sm`, `zu` (Zarr
URL), `cell` (i, j, k), `cam`.

## Tiles and overviews

`structure.html` shows how a raster is stored: its pixel grid, the tiles (or
strips, or chunks) the pixels are cut into, and the overviews, each half the
resolution of the one before. Give it a URL or a local file:

| Source                     | What is read                                                |
|----------------------------|-------------------------------------------------------------|
| GeoTIFF or COG             | TIFF tags and geokeys, with HTTP range requests (classic and BigTIFF) |
| Zarr v2 or v3              | `zarr.json` or `.zarray`/`.zattrs`/`.zmetadata`; multiscales as OME-NGFF datasets, a GeoZarr `layout` or a `tile_matrix_set`; shards and their inner chunks |
| WMTS                       | the capabilities document: a layer's tile matrix set        |
| ArcGIS MapServer or ImageServer | the service JSON (`?f=json`): the tile cache's levels, as a window on each |
| XYZ template               | nothing: `{z}/{x}/{y}` means Web Mercator, 256 pixel tiles  |
| OGC TileMatrixSet JSON     | the tile matrices                                           |

Or type a grid spec: CRS, extent (xmin, xmax, ymin, ymax), dimension, tile
size and number of levels (blank halves until a level fits in one tile, as
GDAL's COG driver does). No pixel data is read. "Unfold" takes the grid from
the globe to its own CRS, "Stack the levels" pulls the pyramid apart, and a
click gives the pixel and tile under the pointer at every level, with the
tile's byte range in a GeoTIFF (a COG puts every IFD before the data and the
smallest overview first; the bar under the levels shows it), its chunk key in
Zarr and its URL in a tile service. GEBCO 2026 is the default example.

The CRS comes from an EPSG code (a table of common ones, then
spatialreference.org or epsg.io), from the PROJ parameters in the geokeys of a
user-defined GeoTIFF CRS, from `proj:code`, `crs_wkt` or `spatial_ref` in Zarr
attributes, or from what is typed. `src/core/structure.js` holds the readers;
`test/check-structure.mjs` checks them against GeoTIFFs written by GDAL's COG
driver and described by rasterio and tifffile, and Zarr stores written by
zarr-python (`test/fixtures/structure`, made by
`test/make-structure-fixtures.py`). Hash keys: `src`, `kind` (`tiff`, `zarr`,
`wmts`, `arcgis`, `xyz`, `tmsjson`), `var` (Zarr variable), `layer`, `tms`
(WMTS), `zmax` (deepest XYZ zoom), `spec=1` with `crs`, `ext`, `dim`, `tile`,
`lev`, then `lvl`, `t` (unfold), `ex` (stack), `pick` (x,y in the CRS),
`tiles`, `pix`, `coast`, `grat`, `cam`.

## Rectilinear chunks

`rectilinear.html` compares a regular Zarr chunk grid with a rectilinear one
(the `rectilinear` chunk grid of zarr-extensions, after ZEP0003): one list of
chunk lengths per axis, cut across the whole array. Cases: the overhanging last
chunk of a regular grid, days in months and years, years of files each chunked
inside (a short last chunk per file, exact only if the file did not pad it),
and mosaics of uneven, staggered and overlapping tiles (a grid is a partition,
so overlap cannot be expressed). A read along time shows the chunks it touches
and the values decoded against those wanted, for both grids. Paste a zarr.json
or read one from a URL to draw its grid. `src/core/chunkgrid.js`, checked in
`test/check-chunkgrid.mjs`. Hash keys: `case`, `grid` (`reg`, `rect`), `c`,
`a`, `w`, `where` (`map`, `pixel`), `ex`, `cam`.

## Icechunk and Zarr

`store.html` opens an Icechunk repository (with
[icechunk-js](https://github.com/EarthyScience/icechunk-js)) or a Zarr store
(with [zarrita.js](https://github.com/manzt/zarrita.js)), finds where a
variable's cells are and in which CRS, and draws its cells and chunks on the
globe, unfolding into a chosen projection or the store's own CRS. The CRS comes
from a CF `grid_mapping` (its parameters, as CF appendix F names them, or the
EPSG code in its `crs_wkt`), GeoZarr attributes, or 1D latitude and longitude
coordinates; the cells from a GeoTransform, `spatial:transform` or 1D
coordinates (in km where their units say so; uneven 1D coordinates, as on a
Gaussian grid, keep their spacing). A curvilinear grid (2D latitude and longitude
per cell, as CMIP6 ocean grids ship) is drawn from those, with no CRS. Colour the cells by the data
(chunks read on demand: the whole slice when it is small, a spread of chunks or
the one clicked when it is not), by each cell's area on the earth, or by the
angular distortion of the store's CRS. The hash is
[gridlook](https://github.com/d70-t/gridlook)'s,
`#<store>::varname=..::projection=..::lat=..::lon=..::dimIndices_<dim>=..`,
plus `t`, `colour` (`data`, `area`, `omega`, `none`), `chunks`, `cells`,
`coast`, `grat`, `pick` (column,row) and `cam`, so a link opens in gridlook
too. `src/core/storecrs.js` and `js/store-read.js`, checked in
`test/check-storecrs.mjs` against PROJ (pyproj's `CRS.from_cf`) and small
stores written by xarray, zarr-python and icechunk
(`test/make-store-fixtures.py`). A store on another site must allow
cross-origin reads (CORS); "Local folder" opens a Zarr store on the viewer's
computer without uploading it.

## Rasterize

`rasterize.html` puts one polygon on one grid two ways, side by side. On the
left, **centre in**: a cell is in when its centre is inside, found by walking
each row along the line through the cell centres and filling between pairs of
edge crossings. That is GDAL's rasterize (and rasterio's) and the R package
[fasterize](https://github.com/ecohealthalliance/fasterize). On the right,
**exact coverage**: the fraction of each cell inside the polygon, as
[exactextract](https://isciences.github.io/exactextract/) computes it. Point at
a cell for its scanline and crossings, or for its piece of the polygon and
its fraction. "Shift the grid" moves the grid by part of a cell, and "Drift"
keeps it moving: the centre-in count jumps, the coverage sum does not. The
left panel can also show GDAL's ALL_TOUCHED (every cell with any coverage) or
a warp: the polygon rasterized on a global longitude-latitude grid and then
resampled, nearest neighbour, onto this one. The storage panel's "runs plus
edge fractions" is the sparse form
[controlledburn](https://github.com/hypertidy/controlledburn) returns (R and
Python; [controlledburn-rs](https://github.com/hypertidy/controlledburn-rs) in
Rust).

The grid is built round the shape in a CRS picked here (longitude and
latitude, a local Lambert azimuthal equal-area, Web Mercator, polar
stereographic, the UTM zone, or a typed PROJ string), with a cell count and a
tile size, or it is a window on a real raster: a GeoTIFF or COG read by
`src/core/structure.js` (GEBCO 2026 is the example) or a typed spec
(`CRS; xmin,xmax,ymin,ymax; cols,rows; tile`). For a raster the level is the
finest at which the shape spans at most 300 cells, and the tiles are the
file's own; for a GeoTIFF the panel sums the byte ranges of the tiles each
answer touches, from the TIFF's tile offsets. Edges are straight in longitude
and latitude, so they are densified to a quarter of a degree before they are
projected. Areas are true areas on the WGS84 ellipsoid, each cell measured
through an equal-area projection centred on the shape, so the error of each
answer shows; "nominal" is the cell count times the cell size squared.

The storage table compares ways to keep the answer: a dense mask, the touched
tiles, runs along rows (row, first, last), cell numbers, dense float coverage,
exactextract's float matrix over the polygon's bounding box, cell number and
fraction pairs, and runs of whole cells plus a list of edge fractions.

Shapes are Natural Earth 110m country parts or 50m land polygons (from the
coastlines via `src/core/landmesh.js`); click the globe to pick another. A ring
that runs all the way round in longitude (Antarctica) is closed through the
pole, and the out-and-back run that makes along the seam is folded away once
projected. `src/core/rasterize.js` holds both algorithms (coverage as a boundary
integral: each edge piece adds its part to the cell it crosses and takes its
height from every cell to its right, a running sum along the row);
`test/check-rasterize.mjs` checks them cell for cell against GDAL's
rasterize (centre in and ALL_TOUCHED, through rasterio) and against
exactextract's coverage fractions, on a star with a hole and on Tasmania,
Iceland and Antarctica in two CRSs each (`test/fixtures/rasterize.json`,
made by `test/make-rasterize-fixture.py`, which also checks the densify and
projection against pyproj). Hash keys: `at` (`tas`, `ice`, `mad`, `gb`,
`ant`, `star`, or lon,lat of a picked shape), `detail` (`110m`, `50m`),
`crs` (`ll`, `laea`, `merc`, `polar`, `utm`, `file`, `custom` with `def`),
`n` (cells across), `sx`, `sy` (shift, in cells), `tile`, `left`
(`centre`, `touched`, `warp`), `src` and `lvl` (raster and level).

## Regular in what?

`regular.html` is a storyline in eight steps. The first four are the
geostationary view in 3D, with the light at the satellite as on the
Perspective page: the cap a satellite sees from any height; why its pixels are
equal steps of scan angle (`+proj=geos`, x and y in radians times h) and not
of a flat image (`+proj=nsper`), 21 GOES pixels apart at the edge of the disc
and far more from low orbit; the two gimbal orders PROJ calls `sweep=x` (GOES)
and `sweep=y` (Meteosat, Himawari), up to 15 pixels apart, magnified; and the
disc unfolded into the regular scan-angle grid the data are stored on.

The last four are about the 2D longitude and latitude arrays many datasets
ship for grids that are regular in some CRS: the two arrays as stored, the
grid lines and coast moved from lon/lat back to the CRS they came from (where
every cell is the same), and a test that finds that CRS from the arrays alone.
`src/core/regular.js` projects the samples with each candidate (lon/lat, Mercator,
cylindrical equal-area, sinusoidal, transverse Mercator, polar and oblique
stereographic and Lambert azimuthal, Lambert conformal conic, geostationary in
both sweeps, rotated pole; sphere and ellipsoid), fits an affine transform of
column and row, and reports what the fit misses in cells. Only parameters that
bend the grid are searched (Nelder-Mead): the cone constant, a satellite's
longitude and height, a pole. lon_0 is then turned to make the grid north-up,
and the cell size is checked against common radii and lat_ts values for a
round number. From float32 lon/lat alone it gets back, for example,
`+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +a=6378273 +b=6356889.449` with
geotransform `-3850000, 25000, 0, 5850000, 0, -25000` for the NSIDC arrays,
GOES-East's 56 microradians from 35786023 m, and HRRR's 3000 m on the 6371229 m
sphere. Ten examples are built in (with their cell centres checked against PROJ
in `test/check-regular.mjs`); the last step takes pasted `i j lon lat` rows,
`lon lat` rows with a row length, or JSON `{"lon": [[...]], "lat": [[...]]}`.
An example is a few lines in `EXAMPLES` in `src/core/regular.js`: a CRS, the centre
of the first cell, the steps and the size. Hash keys: `s` (step), `sat`, `h`,
`h2`, `mag`, `t`, `m`, `ex`, `pick`.

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
as GeoJSON. `src/core/l3bin.js` holds the grid; `test/check-l3bin.mjs` checks the
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
The midpoint test is redrawn by `resampleArc` in `src/core/mishaps.js`, which
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
[xkcd 977](https://xkcd.com/977/); and Eratosthenes' measurement of the
Earth, in three steps: a 3D globe (drag to turn it) with the well at Syene, a
gnomon at Alexandria, parallel sun rays and the equal angles at the stick and
at the centre; the same with the sun off overhead, where the difference of two
shadow angles does the job; and the real map, with Alexandria about 3 degrees
west of Syene, Syene north of the Tropic of Cancer as it was in 240 BC
(Laskar 1986 obliquity), and a slider for the unknown length of the stadion.
The geometry is in `src/core/eratosthenes.js`. The credits are in the page's
About panel.
Robinson, Winkel tripel, Van der Grinten and cylindrical equal-area (Gall-Peters,
Hobo-Dyer) are written as d3 raw projections in `src/core/homage-geo.js`;
`test/check-homage.mjs` checks them and the rest against PROJ 9.8
(`test/fixtures/homage-proj.json`, from `test/make-homage-fixture.py`).
PROJ's `+proj=wintri` defaults to `lat_1=0`, so Winkel's own
`lat_1=acos(2/pi)` is given explicitly. The Dymaxion faces are gnomonic about
each face centre on Fuller's icosahedron (Fuller's own face transform differs a
little), and the net is found rather than copied: a maximum spanning tree of the
faces weighted by the land each edge crosses, so the cuts fall in the sea. Hash
keys: `s` (step, from 0), `p` (the step's slider).

## VicGrid

`vicgrid.html` draws south-east Australia in one grid's own eastings and
northings: GDA2020 / Vicgrid (EPSG:7899), GDA94 / Vicgrid (3111), AGD66 /
Vicgrid66 (3110), MGA zones 54 and 55 (7854, 7855), NSW Lambert (8058), SA
Lambert (8059) or Australian Albers (3577). VicGrid is one Lambert conformal
conic for the whole of Victoria (standard parallels 36 and 38 S), where the
national UTM grid splits the state at 144 E; the page overlays the MGA zone
edges and another grid's 100 km lines, shades the scale error, and gives the
point under the pointer in every grid through its datum (GDA2020 to GDA94 by
EPSG:8048, GDA94 to AGD66 by PROJ's "AGD66 to GDA94 (4)" for NSW and
Victoria). `src/core/vicgrid.js` has the conics (Snyder 1987), MGA from
`mgrs.js` and the Helmert shifts, checked against PROJ by
`test/check-vicgrid.mjs` (`test/fixtures/vicgrid-proj.json`, from
`test/make-vicgrid-fixture.py`). State borders are Natural Earth 1:10m admin-1
(`data/aus-states-10m.json`, from `test/make-aus-states.py`). Hash keys: `crs`,
`over`, `shade`, `zones`, `grat`, `towns`, `v`, `pt`.

## Nuyina

`nuyina.html` follows RSV Nuyina, Australia's icebreaker, along a voyage. The
track is the ship's underway data (a fix a minute) from the Australian
Antarctic Data Centre's feature service (`underway:nuyina_underway`, one voyage
per `set_code`); the time slider puts the ship on the map, and Play runs it.
The map is either the Antarctic polar stereographic (EPSG:3031) or an
azimuthal centred on the ship (laea, aeqd or stere, optionally heading up),
rebuilt as the ship moves. A map centred on the ship is a map of what is near
it: range rings are circles of true distance drawn as geodesics (round in
aeqd, ovals in EPSG:3031), and the readout gives the nearest place and the
nearest sea ice edge as distance and bearing.

The seafloor comes from two overlapping mosaics, IBCSO v2 (500 m, EPSG:9354)
and GEBCO 2026 (15 arc seconds, lon/lat). Which one a pixel is read from is a
plan kept apart from either grid, after the wxylib design note
[m10: overlapping COG mosaics](https://github.com/wxylib/design/blob/150b4d3bb078bdd1f12ec0a3ced2fde9bc191985/docs/m10-overlapping-mosaics.md):
IBCSO first, a cut at a latitude, either alone, or IBCSO minus GEBCO.
"Cells at the ship" draws each source's own cells (and the 25 km sea ice
cells) round the ship. Sea ice is the NSIDC Sea Ice Index (G02135 v4) daily
GeoTIFF for the day at the slider. Source addresses come from the R package
[sds](https://github.com/hypertidy/sds) (its registry and `nsidc_seaice()`);
IBCSO is read from the LFS host of its COG copy, since the GitHub redirect sds
lists has no CORS headers.

Every source is sampled in its own CRS: map pixel to lon/lat (exactly on a
lattice every 8 pixels, interpolated between), to EPSG:3031, then by a scale
to EPSG:9354 or through lon/lat to EPSG:3412. `src/core/polarstere.js` is
ellipsoidal polar stereographic (Snyder 1987) for 3031, 9354, 3412, 3976, 3413
and 3411, checked against PROJ 9.8 (`test/fixtures/nuyina-proj.json`, from
`test/make-nuyina-fixture.py`). proj4js 2.12.1's ellipsoidal aeqd inverse
returns latitude + 180 in the southern hemisphere; the page folds it back and
the test checks the result against PROJ. If the AADC service or NSIDC does not
allow this page to read it, the page says so: the track falls back to the
ports of call joined by great circles (labelled as not the track), and a
downloaded track CSV can be loaded. Hash keys: `v` (voyage code), `t`, `view`
(`ship`, `polar`), `proj`, `up`, `span` (log10 km across), `cx`, `cy`
(polar pan, km), `plan`, `cut`, `src`, `ice`, `cells`, `coast`, `rings`,
`by` (an underway column to colour the track), `to` (where the crow lines go),
`from` (`wfs`, `pq`) and `pq` (the parquet copy's address).

Crow lines run from the ship to a place as both the great circle and the
rhumb line, with their lengths and courses, and the readout compares the
distance run with the great circle from the voyage's start (after the
[nuyina-proximal](https://github.com/mdsumner/nuyina-proximal) tracker).

The track can also come from a parquet copy of the whole underway record
([nuyina-underway](https://github.com/mdsumner/nuyina-underway), GeoParquet
sorted by time in row groups of 65536 minutes). The page reads its footer,
then only the row groups a voyage's dates fall in and only the columns it
draws, with [hyparquet](https://github.com/hyparam/hyparquet) and
[fzstd](https://github.com/101arrowz/fzstd): about 3 MB in five range requests
for a seven week voyage. GitHub's release downloads send no CORS header, so a
page on another site cannot read the release copy; a downloaded copy can be
loaded from disk, and a copy on a host that allows it can be given as `pq=`.

## Rhumb lines

`rhumb.html` draws the rhumb line (one compass course, a loxodrome) and the
great circle (the shortest way, an orthodrome) between two places on four maps
at once: a globe, Mercator (where the rhumb line is straight), gnomonic (where
the great circle is) and either an azimuthal equidistant map on the start or a
south polar stereographic, where the rhumb line spirals round the pole. The
whole loxodrome can be carried on pole to pole, and "keep north of a latitude"
is composite great circle sailing, the navigator's way round ice: from Hobart
to Cape Town the rhumb line is 12 percent longer than the great circle, and
keeping north of 55 degrees S costs under 1 percent. Lengths and courses are on
WGS84 (`src/core/rhumb.js`: Vincenty for the geodesic, the meridian distance and
isometric latitude for the rhumb line), checked against PROJ
(`test/fixtures/rhumb-proj.json`, from `test/make-rhumb-fixture.py`, where the
rhumb line is PROJ's Mercator inverse of a straight line measured with PROJ's
geodesics); lines are drawn with d3-geo on the sphere. Hash keys: `alon`,
`alat`, `blon`, `blat`, `four` (`aeqd`, `polar`), `lox`, `comp`, `lim`.

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

### Cells, tiles and lobes

The cells pages (s2 cells, L3 bins, Model grids, MGRS and Sentinel-2) carry
the same basemaps, warped into each page's own texture frame (a cube face's
(s, t), a grid's index space, a UTM zone). Their "Download GeoTIFF" writes
the picked cell, bin or tile in its own CRS, and Globals and interrupteds
adds "Download lobe" (or face) for a lobe clicked on its flat map:

| Page                    | What is written | CRS |
|-------------------------|-----------------|-----|
| Globals and interrupteds | a lobe, gore or butterfly face | the base projection about the lobe's own central meridian (Goode's lobes as PROJ's `goode`), or the face's `gnom` |
| s2 cells                | a cell          | `gnom` about its cube face's centre, R = 6371010 m |
| L3 bins                 | a bin           | WGS84 lon/lat (EPSG:4326) |
| Model grids             | a cell          | rotated pole and Yang: `ob_tran` (degrees); Yin and tripolar south of the join: lon/lat; cubed sphere: the face's `gnom` |
| MGRS and Sentinel-2     | a Sentinel-2 tile | its UTM zone's EPSG code, on the tile's own 109.8 km box (1098 px is 100 m) |

The basemap for these is read for the cell's own lon/lat window at about
the detail its pixels need (`readWindow` in `js/basemap-load.js`): the GEBCO
overview just finer than a pixel (down to the full 15 arc second grid), or
Esri tiles at a deeper zoom (up to 17, at most 64 tiles), so a small cell is
not a blur of the global image. Pixels outside the cell stay transparent.
PROJ strings with no GeoTIFF keys travel as an ESRI PE string with a PROJ4
extension, which GDAL reads.

Not written, and why: a tripolar cap cell has no CRS of its own (the cap is
a scaled stereographic of a second sphere), so it is written in north polar
stereographic, masked to the cell's outline. An interrupted map as a whole
has no single PROJ string unless PROJ names it (`igh`, `igh_o`, `imoll`,
`imoll_o`), so for the others the lobe is the unit; the butterfly as a whole
likewise. The Dymaxion net on the Homage page and the Index space grid
(curvilinear ROMS cells with no CRS) have no export.

## Frame

`frame.html` draws any [scenespec](https://github.com/allboa/scenespec)
scene (0.7 or later) with a mesh layer, and puts a map's frame round it.
The page knows nothing about the data: it reads the view CRS, extent and
local origin from the scene, the tables from Arrow IPC, and adds what a
reader needs to place it: a locator globe, the graticule, a CRS readout,
and the distortion of the CRS at every vertex from PROJ's factors (as on
the Distortion page).

Every vertex has two homes. On the map it is where the CRS puts it, east
and north of the local origin. On the Earth it is at its own longitude,
latitude and height on the WGS84 ellipsoid, Earth-centred (ECEF) and then
turned into east, up and north at the origin, so the two agree there.
Unfold moves each vertex between them. Over the 212 m Juneau window they
differ by up to 1.28 m, nearly all of it the 0.49 degree turn between UTM
grid north and true north (the scale factor adds 4 cm, the curve of the
Earth 2 mm), and the page says so; "Exaggerate the difference" multiplies
it so its shape shows. Over the 3000 km polar mesh they part by kilometres.

A click picks the triangle under the pointer: its row in the face table,
its vertices, its centre in the CRS and in longitude and latitude, and the
face columns the scene's popup names. That is the way back from the
picture to the data.

The default scene is a 212 m window of USGS 3DEP lidar near Juneau, Alaska
(`AK_Juneau_2012`, public domain, EPSG:32608), meshed and summarised per
triangle in R and written with meshcore `write_scene()`:

```r
m <- meshcore::read_mesh_arrow("juneau/mesh")   # triangle form + face_stats
mesh <- structure(m[c("vertices", "triangles")], meshspec = attr(m, "meshspec"),
                  class = "meshcore_tri")
fs <- m$face_stats                                 # pointcore::face_stats(), one row per face
meshcore::write_scene(mesh, "data/frame/juneau",
  faces = fs[c("face", "n", "z", "slope", "dz_max", "intensity")],
  fill_by = "n", label = "3DEP Juneau window")
```

Open another scene by URL (`#scene=` in the hash, scene-relative table
URLs), or choose a `scene.json` and its `.arrows` files together; files
stay in the browser. `src/load` reads the scene and tables (apache-arrow,
passed in), `src/core/meshframe.js` holds the homes and graticule, and
`src/scene/meshlayer.js` draws the layer; `test/check-load.mjs` reads the
scenespec conformance mesh and checks the Earth home against proj4js and
the ellipsoid. Hash keys: `scene`, `t` (unfold), `gx` (the difference
exaggerated by 10^gx), `dz` (height by 10^dz on top of the scene's
`z_scale`), `col` (`scene`, `k`, `h`, `s`, `omega`, `conv`), `grat`,
`globe`, `pick` (triangle), `cam`.

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
| `bm`     | basemap: `none` (default), `gebco` or `esri` (also on the cells pages) |
| `relief` | GEBCO relief exaggeration, 0 (off) to 100, on every page; `wire` 1 draws it as wireframe |
| `spin`   | 1 slowly orbits the camera round the scene                     |
| `cam`    | camera position and target, six numbers                        |

Add `?embed=1` for a compact view to put in an iframe; the "Copy embed code"
button writes the snippet for the current view.

## Affine

`affine.html` is the six-number geotransform that puts an image's columns and
rows on the map, `x = gt0 + col gt1 + row gt2`, `y = gt3 + col gt4 + row gt5`,
with the image in its own pixels on the left and placed on a longitude and
latitude map on the right. Set it by hand (top-left corner, pixel width and
height, rotation, shear, or six pasted numbers in GDAL or world file order) and
see corners and centres, north up and its extent, the inverse, and the world
file, whose last two lines are the centre of the top-left pixel, half a pixel in
from the geotransform's corner. Or register the image: click a place on it and
the same place on the map, twice, and the geotransform is fitted north up (four
unknowns, two points), rotate and scale (also four) or full affine (six, three
points), by least squares with residuals when there are more points. The samples
are an atlas page drawn here and a crooked scan of it (turned and sheared), whose
true geotransforms are known; your own PNG or JPEG stays in the browser. The
result downloads as a GeoTIFF (EPSG:4326, a ModelTransformation tag when not
north up) or a world file, with the equivalent GDAL command.
`src/core/affine.js` holds the maths, checked in `test/check-affine.mjs`. Hash
keys: `pic` (`atlas`, `crooked`), `fit` (`hand`, `northup`, `similarity`,
`affine`), `x0`, `y0`, `w`, `h`, `rot`, `shear`, `gcp` (col,row,x,y;...),
`op`, `grat`, `pix`.

## Peeling the orange

`peel.html` peels the globe like an orange, in gores from pole to pole or in
one spiral strip, and lays the peel flat beside the 3D peeling. Each gore is
flattened on its own central meridian as PROJ's `sinu`, `cass` or `tmerc` on
the sphere (checked against PROJ 9.8 in `test/check-peel.mjs`, fixture from
`test/make-peel-fixture.py`), laid out joined at the south pole (as peeled)
or at the equator (the interrupted map), with each one's distortion in a
table: the sinusoidal keeps area but its shear falls only with the gore's
width, Cassini and transverse Mercator stretch by the square of it. The spiral
strip's flat centre line turns at tan(latitude) and tends to an Euler spiral
(Bartholdi and Henriques 2012, Orange peels and Fresnel integrals). Geometry
in `src/core/peel.js`. Hash keys: `cut`, `n`, `method`, `lay`, `turns`, `p`,
`lon0`, `skin`, `euler`, `fruit`, `spin`, `cam`.

## Layout

```
index.html                             page
css/app.css                            styles
js/app.js                              scene, map and controls
guide.html                             Guide: a reading path through the pages
cones.html, js/cones.js                cones and cylinders page
sight.html, js/sight.js                Sight and shade: a viewshed in gnomonic wedges, out to the sun
spilhaus.html, js/spilhaus.js          Spilhaus page
globals.html, js/globals.js            globals and interrupteds page
peel.html, js/peel.js                  peeling the orange: gores and the spiral peel
catastrophes.html, js/catastrophes.js  map catastrophes page
cells.html, js/cells.js                s2 cells page
h3.html, js/h3.js                      H3 hexagons on the icosahedron
grids.html, js/grids-page.js           model grids page
indexspace.html, js/indexspace.js      index space page
structure.html, js/structure-page.js   tiles and overviews page
rectilinear.html, js/rectilinear.js    rectilinear chunks: regular and rectilinear Zarr chunk grids, calendars, files, mosaics
store.html, js/store-page.js           Icechunk and Zarr: a store's grid and chunks on the globe and in other projections
js/store-read.js                       opening Icechunk and Zarr stores, describing a variable's grid and CRS
regular.html, js/regular-page.js       regular in what? storyline: geostationary, lon/lat arrays
rasterize.html, js/rasterize-page.js   rasterize page
affine.html, js/affine.js              Affine: the geotransform, world file, registering an image by two points
example.html, js/example.js            For example storyboard
homage.html, js/homage.js              homage storyboard: UN emblem, Gall-Peters, Equal Earth, Dymaxion, xkcd 977, Eratosthenes
vicgrid.html, js/vicgrid.js            VicGrid: Victoria's one-zone grid against MGA, NSW/SA Lambert, Albers
sentinel.html, js/sentinel.js          MGRS and Sentinel-2 page
aatgrid.html, js/aatgrid.js            AAT grid: a mini aatgrid, one tile lattice in every UTM south zone
bins.html, js/bins.js                  L3 bins page
tissot.html, js/tissot-page.js         Distortion page (Tissot's indicatrix and factor fields)
ellipsoid.html, js/ellipsoid-page.js   Ellipsoid: exaggerated flattening, the three latitudes, M and N
geoid.html, js/geoid.js                Geoid: EGM2008 exaggerated over the ellipsoid, h = H + N profile
ortho.html, js/ortho.js                Orthorectification: frame camera or pushbroom over terrain, raw image, datum and DEM rectification
nuyina.html, js/nuyina.js              Nuyina: voyage track, sea ice, two bathymetry mosaics, near-ship maps
rhumb.html, js/rhumb.js                Rhumb lines: rhumb line and great circle on four maps, composite sailing
frame.html, js/frame.js                Frame: any scenespec mesh in its CRS, distortion, graticule, unfolded onto the ellipsoid

js/data.js          loads the coastlines in data/
js/basemap-load.js  fetches the basemaps in the browser and makes their canvases
js/download.js      hands a file to the browser as a download
js/basemap-ui.js    basemap picker and cell GeoTIFF button for the cells pages
js/tissot-draw.js   indicatrices, the enlarged one and contours drawn on a 2D canvas

src/scene/index.js   the scene layer in one import: three.js and the browser, on top of the core
src/scene/stage.js   renderer, scene, camera and orbit controls sized to a page element
src/scene/hash.js    page state in the URL hash, written only where it differs from the defaults
src/scene/share.js   copy link, copy embed and open full buttons; embedded mode
src/scene/homes.js   two homes for every vertex (index space and the world) and the warp between them
src/scene/relief.js  relief on any surface, pushed along its normals by elevation
src/scene/meshlayer.js  a scenespec mesh layer as a three.js mesh, flat face colours, face-index picking
src/scene/locator.js    locator globe on a 2D canvas; CSS ramps for legends

src/load/index.js    the loading layer: like the core no DOM or three.js, but it fetches (fetch and Arrow are passed in)
src/load/scene.js    a scenespec scene and the Arrow tables of its mesh layers, as typed arrays, colours and popups

src/core/index.js                 the whole core in one import; src/core/ needs no browser
src/core/families/index.js        the families, and the interface each one has
src/core/families/perspective.js  azimuthal perspective family: rays, PROJ string, GeoTIFF keys
src/core/families/conic.js        cone family with cylinder and plane limits
src/core/families/azimuthal.js    compass (laea) and string (aeqd) constructions
src/core/families/spilhaus.js     Spilhaus / Adams World in a Square II, from PROJ
src/core/families/globals.js      whole-world formulas, their lobes, and the octahedral butterfly, from PROJ
src/core/geo.js                   graticule, seeded randomness, scene frame
src/core/landmesh.js              land triangulated from the coastlines (earcut), and ray sampling
src/core/basemap.js               basemap sources, GEBCO and Esri reading, per-pixel reprojection
src/core/geotiff-write.js         GeoTIFF writer with user-defined CRS keys
src/core/cellexport.js            GeoTIFF of one cell, tile or lobe in its own CRS
src/core/mishaps.js               catastrophe steps, vertex-by-vertex and spherical drawing
src/core/s2.js                    S2 faces, cell ids and tokens, from s2geometry
src/core/icosa.js                 icosahedron from 12 vertices, gnomonic face frames, strip net hinges
src/core/roms.js                  ROMS s-coordinate, synthetic grids and data, Zarr grid reader
src/core/regular.js               which CRS makes a lon/lat array regular; example grids; geos scan angles
src/core/structure.js             grid, tile and file structure of COG, Zarr, WMTS, ArcGIS, XYZ and specs
src/core/chunkgrid.js             regular and rectilinear chunk grids: lookup, read cost, zarr.json chunk_grid, calendars, mosaics
src/core/storecrs.js              CF grid mappings to PROJ, coordinate axes, cell areas, gridlook's URL hash
src/core/rasterize.js             centre-in scanline fill, exact coverage fractions, runs, tiles and bytes
src/core/grids.js                 rotated pole, tripolar, cubed sphere and Yin-Yang grids
src/core/homage-geo.js            Robinson, Winkel tripel, Van der Grinten, cea; Dymaxion icosahedron and net
src/core/eratosthenes.js          Eratosthenes' well, gnomon and sun rays in 3D; obliquity of the ecliptic
src/core/mgrs.js                  UTM, MGRS references and Sentinel-2 tiles
src/core/aatgrid.js               the aatgrid tile lattice: ids, nesting, extents, Sentinel-2 shift
src/core/tissot.js                distortion factors (h, k, s, omega, ...) from any forward function
src/core/distortion.js            factor grids, colour scales, contours and auto-sized lattices
src/core/l3bin.js                 SeaWiFS / MODIS level-3 bin grid
src/core/polarstere.js            ellipsoidal polar stereographic (EPSG:3031, 9354, 3412, 3976, 3413, 3411)
src/core/seaice.js                NSIDC Sea Ice Index grid, values and daily file addresses
src/core/track.js                 ship tracks from underway CSV or parquet rows; Nuyina voyages; place, heading, distance run
src/core/rhumb.js                 rhumb lines, geodesics and great circles, the whole loxodrome, composite sailing
src/core/ellipsoid.js             ellipsoid radii, the three latitudes, M and N, meridian length, exaggeration
src/core/geoid.js                 geoid grid (EGM2008), undulation, geocentric positions, deflection, profiles
src/core/ortho.js                 synthetic DEMs, frame and pushbroom sensor models, ray tracing, relief displacement, orthorectification
src/core/vicgrid.js               VicGrid, MGA, NSW/SA Lambert, Australian Albers; AGD66/GDA94/GDA2020 shifts
src/core/sight.js                 terrain visibility: gnomonic wedges or the sun, a horizon kept front to back
src/core/peel.js                  gores (sinu, cass, tmerc), the peel from orange to flower, the spiral peel and its Euler spiral
src/core/affine.js                geotransform: apply, invert, parts, extent, world file, fit to control points
src/core/mosaic.js                overlapping sources: the per-pixel plan, level and window choice, sampling, shading
src/core/palette.js               named palettes for scene layers (scenespec palette names)
src/core/meshframe.js             a mesh's two homes, the map and the ellipsoid (ECEF turned to east, up, north); graticule lines

data/countries-110m.json   Natural Earth 110m country parts as flat [lon, lat] rings
data/frame/                scenes for the Frame page: a USGS 3DEP lidar window (juneau/) and the scenespec polar mesh
data/s2-tiles.json         which MGRS squares are Sentinel-2 tiles (ESA tiling grid)
test/fixtures/             reference points projected by PROJ
data/                      Natural Earth coastlines as [lon, lat, ...] polylines
test/check-pure.mjs        the core modules load in Node with no DOM, canvas or three.js
test/check-scene.mjs       the scene modules import only three.js and the core, and load in Node
test/check-load.mjs        a scenespec mesh scene reads, colours, pops up and unfolds onto the ellipsoid
test/check-interfaces.mjs  every family and grid has the shared Family and Grid shape
test/check-proj.mjs        ray construction vs proj4js
test/check-secant.mjs      secant planes vs PROJ (fixture made with PROJ 9.8)
test/check-oblique.mjs     tilted cones and cylinders (omerc, ob_tran) vs PROJ 9.8
test/check-ortho.mjs       orthorectification: sensor models invert their rays, h tan(theta), true DEM reproduces the map
legacy/pproj/              the original R package and experiments
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
`test/check-roms.mjs` checks the s-coordinate against ROMS and the Zarr grid reader against zarr-python.
`test/check-nuyina.mjs` checks polar stereographic and the ship-centred maps against PROJ, the sea ice
grid, the overlap plan and level choice, and reading tracks from GeoServer CSV and parquet rows.
`test/check-sight.mjs` checks the viewshed and the cast shadow against marching every line of sight.
`test/check-peel.mjs` checks the gore flattenings against PROJ, what each keeps, and the spiral peel against its curvature and the Euler spiral.
`test/check-rhumb.mjs` checks rhumb line and geodesic lengths and courses against PROJ, and composite sailing.
`test/check-structure.mjs` checks the tile and overview readers against
GDAL, tifffile and zarr-python. `test/check-storecrs.mjs` checks CF grid mappings against PROJ, cell areas
against pyproj's Geod, and reading Icechunk and Zarr stores written by xarray and icechunk. `test/check-mgrs.mjs` checks UTM against PROJ, MGRS references against
GeoTrans, and Sentinel-2 tile lookups against ESA's tiling grid.
`test/check-aatgrid.mjs` checks the AAT grid lattice against the aatgrid R package's own tests
(the Heard Island anchors and the Atlas Cove seam), ids, nesting and the Sentinel-2 pixel shift.
`test/check-tissot.mjs` checks the distortion factors against PROJ's own
`proj_factors()` for 27 projections, spheres and ellipsoids
(`test/fixtures/tissot-proj.json`, from `test/make-tissot-fixture.py`): the
formulas from PROJ's derivatives to rounding, and the whole path through
proj4js to about 1e-8 per unit scale. `test/check-distortion.mjs` checks
the sampled grids, contours, auto sizing and the float GeoTIFF writer.
`test/check-inverse.mjs` round-trips project and inverse for every light
position. `test/check-pure.mjs` keeps everything in `src/core` (the
families, the grids and cells, Tissot, the readers and writers) free of the
DOM, canvases and three.js, and reachable from `src/core/index.js`, so the
core runs in Node or any page as one import. `test/check-scene.mjs` keeps
`src/scene` (the stage, hash state, share buttons, two homes and relief
that the pages share) on three.js and the core alone, and checks the hash
reader and writer and the two-homes warp. `test/check-interfaces.mjs`
checks that every projection family has the shape `src/core/families/index.js`
describes, and every grid (model grids, ROMS grids, s2 cells) the patch
shape `src/core/grids.js` describes. To check that GDAL reads the
exported CRS (needs rasterio):

```sh
node test/write-tifs.mjs /tmp/tifs && python3 test/check-geotiff.py /tmp/tifs
```

## Plans

- A family module format so new projection families are one file each.
- Projections with no physical construction (Mollweide, Robinson and so on),
  shown through their distortion: started with the Distortion page (the
  globals page shows them unrolled).

Contributions are welcome. Please note that this project is released with a
[Contributor Code of Conduct](CODE_OF_CONDUCT.md).

Coastlines are from [Natural Earth](https://www.naturalearthdata.com/) (public domain).
The Sentinel-2 tiling grid is ESA's (Copernicus Sentinel data), read from the
shapefile conversion at
[justinelliotmeyers/Sentinel-2-Shapefile-Index](https://github.com/justinelliotmeyers/Sentinel-2-Shapefile-Index).
