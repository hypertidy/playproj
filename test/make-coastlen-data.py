# Build data/coast-south-10m.json for coastlen.html from Natural Earth 10m
# (public domain): the mainland coast of Australia, and two coasts of
# Antarctica, the grounding line (Natural Earth's coastline, where land or
# grounded ice meets the sea or floating ice) and the ice front (the seaward
# edge of land plus ice shelves).
#
#   python3 test/make-coastlen-data.py NE_DIR data/coast-south-10m.json
#
# NE_DIR holds ne_10m_coastline.geojson and
# ne_10m_antarctic_ice_shelves_polys.geojson from
# https://github.com/nvkelso/natural-earth-vector/tree/master/geojson
import json, math, sys, warnings
warnings.simplefilter("ignore", DeprecationWarning)
from pyproj import Transformer
from shapely.geometry import Polygon, shape
from shapely.ops import unary_union, transform

ne, out = sys.argv[1], sys.argv[2]

def lines(g):
    return [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]

def chain(pieces):
    # join open pieces end to start into one closed ring
    pieces = [list(p) for p in pieces]
    ring = pieces.pop(0)
    while pieces:
        end = ring[-1]
        k = next(i for i, p in enumerate(pieces) if math.hypot(p[0][0] - end[0], p[0][1] - end[1]) < 1e-6 or
                 (abs(abs(p[0][0]) - 180) < 1e-9 and abs(end[0]) == 180 and abs(p[0][1] - end[1]) < 1e-6))
        ring += pieces.pop(k)[1:]
    return ring

coast = json.load(open(f"{ne}/ne_10m_coastline.geojson"))
ant, aus = [], []
for f in coast["features"]:
    for l in lines(f["geometry"]):
        la = [p[1] for p in l]; lo = [p[0] for p in l]
        if max(la) < -60 and l[0] != l[-1]:
            ant.append(l)
        elif 112 < min(lo) and max(lo) < 154.5 and -44 < min(la) and max(la) < -10 and l[0] != l[-1]:
            aus.append(l)
assert len(ant) == 3 and len(aus) == 2, (len(ant), len(aus))
ground = chain(ant)
mainland = chain(aus)

# the ice front: union of the grounded ring and the shelves in polar
# stereographic; the 50 m mitred buffer closes slivers where a shelf edge
# and the grounding line do not quite meet, and the 20 m simplify drops the
# collinear points the buffer leaves
fwd = Transformer.from_crs("EPSG:4326", "EPSG:3031", always_xy=True).transform
inv = Transformer.from_crs("EPSG:3031", "EPSG:4326", always_xy=True).transform
land = Polygon([fwd(x, y) for x, y in ground]).buffer(0)
polys = json.load(open(f"{ne}/ne_10m_antarctic_ice_shelves_polys.geojson"))
shelves = [transform(fwd, shape(f["geometry"])).buffer(0) for f in polys["features"]]
u = unary_union([land.buffer(50, join_style=2)] + [s.buffer(50, join_style=2) for s in shelves]).buffer(-50, join_style=2).simplify(20)
if u.geom_type == "MultiPolygon":
    u = max(u.geoms, key=lambda g: g.area)
front = [list(inv(x, y)) for x, y in u.exterior.coords]
# start where the grounding line does, at the same orientation
if Polygon([fwd(x, y) for x, y in ground]).exterior.is_ccw != u.exterior.is_ccw:
    front.reverse()

def flat(ring):
    o = []
    for x, y in ring:
        o += [round(x, 4), round(y, 4)]
    return o

res = {
    "source": "Natural Earth 10m (public domain): ne_10m_coastline, ne_10m_antarctic_ice_shelves_polys",
    "australia": flat(mainland),
    "grounding": flat(ground),
    "front": flat(front),
}
json.dump(res, open(out, "w"), separators=(",", ":"))
for k in ("australia", "grounding", "front"):
    print(k, len(res[k]) // 2)
