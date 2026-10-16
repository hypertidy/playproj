# Writes test/fixtures/rasterize.json for test/check-rasterize.mjs: polygons
# on grids, with what GDAL's rasterize (through rasterio) and exactextract
# make of them, so the page's own centre-in and coverage code is checked
# against both tools. Country shapes are densified and projected here with
# pyproj, and the projected vertices are stored so the JavaScript side
# rasterizes exactly the same coordinates.
#
#   python3 -m pip install rasterio exactextract pyproj shapely
#   python3 test/make-rasterize-fixture.py

import json, math, os, tempfile
import numpy as np
import rasterio
from rasterio.transform import Affine
from rasterio.features import rasterize
from exactextract import exact_extract
from pyproj import Transformer
from shapely.geometry import Polygon, Point, mapping

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "fixtures", "rasterize.json")
countries = json.load(open(os.path.join(HERE, "..", "data", "countries-110m.json")))

def pairs(r):
    return [(r[i], r[i + 1]) for i in range(0, len(r), 2)]

def flat(ps):
    return [v for p in ps for v in p]

def part_at(lon, lat):
    if lat < -80:
        # Antarctica runs -180 to 180 and is closed through the pole, as
        # js/landmesh.js closes it (the stored ring cuts straight back along
        # 84.71 S instead)
        r = next(c[0] for c in countries if min(c[0][1::2]) < -85)
        r = r[:-2] if r[:2] == r[-2:] else r
        return [r + [180.0, -90.0, -180.0, -90.0]]
    for rings in countries:
        poly = Polygon(pairs(rings[0]), [pairs(h) for h in rings[1:]])
        # parts past the antimeridian are not valid planar polygons
        if poly.is_valid and poly.contains(Point(lon, lat)):
            return rings
    raise SystemExit(f"no country part at {lon}, {lat}")

# the same densify as js/rasterize.js
def densify(r, step=0.25):
    n = len(r)
    closed = r[0] == r[n - 2] and r[1] == r[n - 1]
    m = n - 2 if closed else n
    out = []
    for i in range(0, m, 2):
        j = (i + 2) % m
        xa, ya, xb, yb = r[i], r[i + 1], r[j], r[j + 1]
        k = max(1, math.ceil(max(abs(xb - xa), abs(yb - ya)) / step))
        for s in range(k):
            out += [xa + (xb - xa) * s / k, ya + (yb - ya) * s / k]
    return out

# as js/rasterize.js unspike() does: repeated points go, and so does a point
# where the ring turns straight back on itself, until none is left, so an
# out-and-back run (a ring closed through the pole, seen from above it)
# folds away
def dedupe(ps, tol=1e-6):
    same = lambda a, b: abs(a[0] - b[0]) <= tol and abs(a[1] - b[1]) <= tol
    def back(a, p, b):
        ux, uy, vx, vy = p[0] - a[0], p[1] - a[1], b[0] - p[0], b[1] - p[1]
        lu, lv = math.hypot(ux, uy), math.hypot(vx, vy)
        return abs(ux * vy - uy * vx) <= 1e-9 * lu * lv and ux * vx + uy * vy < 0
    bad = lambda a, p, b: same(a, p) or same(p, b) or back(a, p, b)
    o = []
    for p in ps:
        if o and same(o[-1], p):
            continue
        while len(o) >= 2 and bad(o[-2], o[-1], p):
            o.pop()
        if not o or not same(o[-1], p):
            o.append(p)
    changed = True
    while changed and len(o) > 3:
        changed = False
        if same(o[0], o[-1]):
            o.pop(); changed = True; continue
        if bad(o[-2], o[-1], o[0]):
            o.pop(); changed = True; continue
        if bad(o[-1], o[0], o[1]):
            o.pop(0); changed = True
    return o

def project(rings, crs):
    if crs == "EPSG:4326":
        return [list(map(float, densify(r))) for r in rings]
    t = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    out = []
    for r in rings:
        d = densify(r)
        x, y = t.transform(d[0::2], d[1::2])
        # to the millimetre, to keep the file small
        out.append([round(v, 3) for v in flat(dedupe(list(zip(x, y))))])
    return out

def grid_around(rings, n):
    xs = [v for r in rings for v in r[0::2]]
    ys = [v for r in rings for v in r[1::2]]
    d = max(max(xs) - min(xs), max(ys) - min(ys)) / n
    gx0 = (math.floor(min(xs) / d) - 1) * d
    gx1 = (math.ceil(max(xs) / d) + 1) * d
    gy0 = (math.floor(min(ys) / d) - 1) * d
    gy1 = (math.ceil(max(ys) / d) + 1) * d
    return dict(x0=gx0, y0=gy1, dx=d, dy=-d, width=round((gx1 - gx0) / d), height=round((gy1 - gy0) / d))

def run(name, rings, G, lonlat=None, crs=None):
    W, H = G["width"], G["height"]
    tr = Affine(G["dx"], 0, G["x0"], 0, G["dy"], G["y0"])
    geom = Polygon(pairs(rings[0]), [pairs(h) for h in rings[1:]])
    centre = rasterize([(geom, 1)], out_shape=(H, W), transform=tr, fill=0, dtype="uint8", all_touched=False)
    touched = rasterize([(geom, 1)], out_shape=(H, W), transform=tr, fill=0, dtype="uint8", all_touched=True)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "g.tif")
        with rasterio.open(path, "w", driver="GTiff", width=W, height=H, count=1, dtype="uint8", transform=tr) as ds:
            ds.write(np.zeros((1, H, W), dtype="uint8"))
        feat = {"type": "Feature", "properties": {"id": 1}, "geometry": mapping(geom)}
        res = exact_extract(path, [feat], ["cell_id", "coverage"], output="geojson")
    props = res[0]["properties"]
    cov = {int(c): float(f) for c, f in zip(props["cell_id"], props["coverage"]) if f > 0}
    case = {
        "name": name, "grid": G, "rings": rings,
        "centre": [int(i) for i in np.flatnonzero(centre.ravel())],
        "touched": [int(i) for i in np.flatnonzero(touched.ravel())],
        "coverage": [[k, round(v, 7)] for k, v in sorted(cov.items())],
        "area": geom.area
    }
    if lonlat is not None:
        case["lonlat"] = lonlat
        case["crs"] = crs
    print(name, W, H, len(case["centre"]), len(case["touched"]), len(cov))
    return case

cases = []

# a star with a hole, on a grid with awkward numbers
star = []
for k in range(14):
    a = math.pi * 2 * k / 14 + 0.13
    rr = 13.7 if k % 2 == 0 else 6.3
    star += [20.31 + rr * math.cos(a), 15.17 + rr * math.sin(a)]
hole = []
for k in range(9):
    a = -math.pi * 2 * k / 9
    hole += [19.6 + 2.9 * math.cos(a), 15.9 + 2.2 * math.sin(a)]
cases.append(run("star", [star, hole], dict(x0=0.0, y0=30.0, dx=1.0, dy=-1.0, width=41, height=30)))

# country parts, each in two CRSs
for name, lon, lat, crss, n in [
    ("tasmania", 146.5, -42.0, ["EPSG:4326", "+proj=laea +lat_0=-42 +lon_0=146.5 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs"], 24),
    ("iceland", -19.0, 65.0, ["EPSG:4326", "EPSG:3857"], 30),
    ("antarctica", 0.0, -85.0, ["EPSG:4326", "EPSG:3031"], 40),
]:
    part = part_at(lon, lat)
    for crs in crss:
        rings = project(part, crs)
        G = grid_around(rings, n)
        tag = crs.split(" ")[0].replace("+proj=", "")
        cases.append(run(f"{name} {tag}", rings, G, lonlat=part, crs=crs))

json.dump({"source": "GDAL rasterize via rasterio " + rasterio.__version__ + " (GDAL " + rasterio.__gdal_version__ +
           "), exactextract python 0.3.0", "cases": cases}, open(OUT, "w"), separators=(",", ":"))
print("wrote", OUT, os.path.getsize(OUT))
