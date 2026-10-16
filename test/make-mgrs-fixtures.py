"""Reference data for the MGRS and Sentinel-2 page.

Needs pyproj, mgrs (GeoTrans) and pyshp, and the Sentinel-2 tiling grid as a
shapefile (ESA's tiling KML, converted in
https://github.com/justinelliotmeyers/Sentinel-2-Shapefile-Index):

  python3 test/make-mgrs-fixtures.py path/to/sentinel_2_index_shapefile

Writes data/s2-tiles.json (which of the MGRS 100 km squares have a
Sentinel-2 tile) and test/fixtures/mgrs-points.json (random points with
their UTM coordinates from PROJ, MGRS reference from GeoTrans, and the
Sentinel-2 tiles whose footprints contain them).
"""
import json, math, random, sys, os
import numpy as np
import shapefile, pyproj, mgrs

here = os.path.dirname(os.path.abspath(__file__))
COLS = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"]
ROWS = "ABCDEFGHJKLMNPQRSTUV"

r = shapefile.Reader(sys.argv[1])
pts = {}
for rec, shp in zip(r.records(), r.shapes()):
    pts.setdefault(rec[0], []).extend(shp.points)

tf = {}
def utm(z, south):
    k = (z, south)
    if k not in tf:
        tf[k] = pyproj.Transformer.from_crs(4326, (32700 if south else 32600) + z, always_xy=True)
    return tf[k]

# -------------------------------------------------------------- tile bitmap
bits = {}
tiles = {}
for name, p in pts.items():
    z, band, c, rw = int(name[:2]), name[2], name[3], name[4]
    i = COLS[(z - 1) % 3].index(c) * 20 + ROWS.index(rw)
    key = name[:3]
    bits[key] = bits.get(key, 0) | (1 << i)
    south = band < "N"
    xy = [utm(z, south).transform(lon, lat) for lon, lat in p]
    # the footprint's convex hull in its own UTM zone (the shapefile splits
    # tiles at the antimeridian; the cut points lie on the edges)
    tiles[name] = (z, south, xy)

def hull(points):
    points = sorted(set(points))
    if len(points) <= 2:
        return points
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for q in points:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], q) <= 0: lo.pop()
        lo.append(q)
    for q in reversed(points):
        while len(up) >= 2 and cross(up[-2], up[-1], q) <= 0: up.pop()
        up.append(q)
    return lo[:-1] + up[:-1]

for name, (z, south, xy) in list(tiles.items()):
    tiles[name] = (z, south, hull([(round(x, 3), round(y, 3)) for x, y in xy]))

out = {
    "source": "ESA Sentinel-2 tiling grid (S2A_OPER_GIP_TILPAR), via github.com/justinelliotmeyers/Sentinel-2-Shapefile-Index",
    "count": len(pts),
    "layout": "key: zone and band (e.g. 55G); value: 160-bit mask as hex, most significant first; bit = column letter index (0-7 in the zone's set) * 20 + row letter index (ABCDEFGHJKLMNPQRSTUV)",
    "tiles": {k: format(v, "040x") for k, v in sorted(bits.items())},
}
with open(os.path.join(here, "..", "data", "s2-tiles.json"), "w") as f:
    json.dump(out, f, separators=(",", ":"))

# -------------------------------------------------------------- points
def xyz(lon, lat):
    a, b = math.radians(lon), math.radians(lat)
    return (math.cos(b) * math.cos(a), math.cos(b) * math.sin(a), math.sin(b))

names = list(pts)
cent = np.array([np.mean([xyz(lon, lat) for lon, lat in pts[k]], axis=0) for k in names])
cent /= np.linalg.norm(cent, axis=1)[:, None]

def inside(poly, x, y):
    n = len(poly)
    for i in range(n):
        (x0, y0), (x1, y1) = poly[i], poly[(i + 1) % n]
        if (x1 - x0) * (y - y0) - (y1 - y0) * (x - x0) < 0:
            return False
    return True

def zone_of(lon, lat):
    z = int((lon + 180) // 6) % 60 + 1
    if 56 <= lat < 64 and 3 <= lon < 12: z = 32
    if lat >= 72 and 0 <= lon < 42: z = 31 if lon < 9 else 33 if lon < 21 else 35 if lon < 33 else 37
    return z

rng = random.Random(42)
def uniform():
    while True:
        lat = math.degrees(math.asin(rng.uniform(-1, 1)))
        if -80 <= lat < 84: return rng.uniform(-180, 180), lat

P = [uniform() for _ in range(2500)]
P += [((6 * rng.randrange(60) - 180 + rng.uniform(-0.15, 0.15) + 180) % 360 - 180, rng.uniform(-80, 84)) for _ in range(1200)]
P += [(rng.uniform(-180, 180), max(-80, min(83.99, -80 + 8 * rng.randrange(20) + rng.uniform(-0.1, 0.1)))) for _ in range(500)]
P += [(rng.uniform(-1, 43), rng.uniform(54, 84)) for _ in range(800)]
P += [(rng.uniform(-180, 180), rng.uniform(-0.2, 0.2)) for _ in range(200)]

M = mgrs.MGRS()
rows = []
for lon, lat in P:
    lon, lat = round(lon, 6), round(lat, 6)
    z = zone_of(lon, lat)
    e, n = utm(z, lat < 0).transform(lon, lat)
    ref = M.toMGRS(lat, lon, MGRSPrecision=5)
    if isinstance(ref, bytes): ref = ref.decode()
    v = xyz(lon, lat)
    hits = []
    for k in np.nonzero(cent @ np.array(v) > math.cos(0.03))[0]:
        name = names[k]
        tz, south, poly = tiles[name]
        x, y = utm(tz, south).transform(lon, lat)
        if inside(poly, x, y): hits.append(name)
    rows.append([lon, lat, z, round(e, 4), round(n, 4), ref, sorted(hits)])

with open(os.path.join(here, "fixtures", "mgrs-points.json"), "w") as f:
    json.dump({"source": f"pyproj {pyproj.__version__} (PROJ {pyproj.proj_version_str}), mgrs (GeoTrans), ESA tiling grid",
               "fields": ["lon", "lat", "zone", "easting", "northing", "mgrs", "s2tiles"], "points": rows}, f, separators=(",", ":"))
print(len(pts), "tiles,", len(rows), "points")
