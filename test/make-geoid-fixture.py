# The geoid grid playproj ships and the reference values for
# test/check-geoid.mjs, made from PROJ's EGM2008 grid with PROJ (via pyproj):
#   python3 test/make-geoid-fixture.py path/to/us_nga_egm08_25.tif > test/fixtures/geoid-proj.json
# The grid is us_nga_egm08_25.tif from https://cdn.proj.org/ (also in
# https://github.com/OSGeo/PROJ-data, us_nga/): EGM2008 geoid heights above
# WGS84 every 2.5 minutes, nodes from -180 lon and 90 lat.
#
# data/geoid-egm2008-1deg.bin is every 24th node of it (whole degrees,
# exact model values, not block means): 361 columns from -180 to 180 (the
# last repeats the first), 181 rows from 90 down to -90, int16
# little-endian in centimetres.
#
# The fixture holds: PROJ's vgridshift on that 1 degree grid (written as a
# GeoTIFF) at random points, so the page's bilinear read can be checked to
# the centimetre rounding; PROJ on the full 2.5 minute grid at the same
# points, to say how far 1 degree is from the model; and geocentric
# positions of points on the geoid (ellipsoidal height N) from PROJ's
# geodetic to geocentric conversion.
import json, os, random, sys, tempfile
import numpy as np, pyproj, rasterio
from rasterio.transform import from_origin

full = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
src = rasterio.open(full)
assert src.width == 8640 and src.height == 4321, (src.width, src.height)
g = src.read(1)
step = 24
one = g[::step, ::step]                       # 181 x 360
one = np.concatenate([one, one[:, :1]], axis=1)  # 181 x 361
cm = np.round(one * 100).astype("<i2")
cm.tofile(os.path.join(here, "..", "data", "geoid-egm2008-1deg.bin"))

tmp = tempfile.mkdtemp()
onetif = os.path.join(tmp, "egm2008_1deg.tif")
with rasterio.open(onetif, "w", driver="GTiff", width=361, height=181, count=1, dtype="float32",
                   crs="EPSG:4326", transform=from_origin(-180.5, 90.5, 1, 1)) as dst:
    dst.write((cm.astype("float64") / 100).astype("float32"), 1)
    dst.update_tags(AREA_OR_POINT="Point", TYPE="VERTICAL_OFFSET_GEOGRAPHIC_TO_VERTICAL")

def vgrid(grid):
    # PROJ applies the grid forward as z + N, so from 0 it gives N
    return pyproj.Transformer.from_pipeline(f"+proj=vgridshift +grids={grid} +multiplier=1")

t1, tf = vgrid(onetif), vgrid(full)
rnd = random.Random(2190)
pts = [(rnd.uniform(-180, 180), rnd.uniform(-89.5, 89.5)) for _ in range(400)]
pts += [(78.0, 5.0), (147.3272, -42.8821), (145.0, -5.0), (-180.0, 0.0), (180.0, 0.0), (179.6, 10.2), (0, 90), (0, -90)]
samples = []
for lon, lat in pts:
    _, _, z1 = t1.transform(lon, lat, 0.0)
    _, _, zf = tf.transform(lon, lat, 0.0)
    samples.append([lon, lat, round(z1, 4), round(zf, 4)])

ecef = pyproj.Transformer.from_crs("EPSG:4979", "EPSG:4978", always_xy=True)
geo = []
for lon, lat, n1, nf in samples[:60]:
    x, y, z = ecef.transform(lon, lat, nf)
    geo.append([lon, lat, nf, round(x, 4), round(y, 4), round(z, 4)])

lo = np.unravel_index(np.argmin(g), g.shape)
hi = np.unravel_index(np.argmax(g), g.shape)
node = lambda ij: [round(-180 + ij[1] * 2.5 / 60, 6), round(90 - ij[0] * 2.5 / 60, 6), round(float(g[ij]), 3)]

print(json.dumps({
    "source": "PROJ " + pyproj.proj_version_str + ", us_nga_egm08_25.tif",
    "grid": {"nx": 361, "ny": 181, "min": int(cm.min()), "max": int(cm.max()), "sum": int(cm.astype("int64").sum())},
    "full": {"min": node(lo), "max": node(hi)},
    "samples": samples,
    "geocentric": geo,
}))
