# data/australia-10m.json: Australia, its external territories and the
# Australian Antarctic Territory, and the land around them, for
# australia.html, from Natural Earth's 1:10m admin-0 map units (public
# domain):
#   python3 test/make-australia-data.py ne_10m_admin_0_map_units.geojson > data/australia-10m.json
# from https://github.com/nvkelso/natural-earth-vector (geojson/). Needs
# shapely. Pieces are lists of flat [lon, lat, ...] rings at 3 decimals.
# The AAT is Antarctica between 45 E and 160 E less Adelie Land (136 11' E
# to 142 02' E), south of 60 S, as the Australian Antarctic Territory
# Act 1954 and the 1933 Order in Council have it.
import json, sys
from shapely.geometry import shape, box, Polygon
from shapely.ops import unary_union

PIECES = {
    "mainland": (["AUS"], [[112, -39.2, 154, -9.5]]),
    "tasmania": (["AUS"], [[143.5, -44, 149, -39.4]]),
    "macquarie": (["AUS"], [[158.5, -55, 159.2, -54.3]]),
    "lordhowe": (["AUS"], [[158.9, -31.9, 159.4, -31.4]]),
    "norfolk": (["NFK"], [[167.8, -29.2, 168.1, -28.9]]),
    "christmas": (["CXR"], [[105.4, -10.7, 105.8, -10.3]]),
    "cocos": (["CCK"], [[96.7, -12.3, 97, -11.8]]),
    "ashmore": (["ATC"], [[122.8, -12.6, 123.7, -12]]),
    "coralsea": (["CSI"], [[145, -24, 160, -10]]),
    "heard": (["HMD"], [[72, -53.3, 74, -52.8]]),
}
AAT = [box(45, -90, 136.1833, -60), box(142.0333, -90, 160, -60)]

src = json.load(open(sys.argv[1]))
units = {}
for f in src["features"]:
    units.setdefault(f["properties"]["GU_A3"], []).append(shape(f["geometry"]))

def polys(g):
    return list(g.geoms) if hasattr(g, "geoms") else [g]

def flat(poly, tol):
    out = []
    for p in polys(poly.simplify(tol, preserve_topology=True)):
        if p.is_empty or not isinstance(p, Polygon):
            continue
        for ring in [p.exterior] + list(p.interiors):
            xy = []
            for lon, lat in list(ring.coords)[:-1]:
                xy += [round(lon, 3), round(lat, 3)]
            if len(xy) >= 6:
                out.append(xy)
    return out

def inside(pt, boxes):
    return any(b[0] <= pt.x <= b[2] and b[1] <= pt.y <= b[3] for b in boxes)

pieces = {}
for key, (us, boxes) in PIECES.items():
    sel = [p for u in us for g in units[u] for p in polys(g) if inside(p.representative_point(), boxes)]
    if not sel:
        sys.exit(f"no land for {key}")
    x0 = min(p.bounds[0] for p in sel); x1 = max(p.bounds[2] for p in sel)
    y0 = min(p.bounds[1] for p in sel); y1 = max(p.bounds[3] for p in sel)
    tol = max(0.001, min(0.02, max(x1 - x0, y1 - y0) / 1500))
    rings = []
    for p in sel:
        if p.area > (3 * tol) ** 2 or len(sel) < 40:
            rings += flat(p, tol)
    pieces[key] = rings

ata = unary_union(units["ATA"])
aat = ata.intersection(unary_union(AAT))
pieces["aat"] = [r for p in polys(aat) if p.area > 0.05 for r in flat(p, 0.02)]

clip = box(30, -90, 180, 10)
OWN = {"AUS", "NFK", "CXR", "CCK", "ATC", "CSI", "HMD"}
context = []
for u, gs in units.items():
    if u in OWN:
        continue
    g = unary_union(gs).intersection(clip)
    if g.is_empty:
        continue
    r = [x for p in polys(g) if isinstance(p, Polygon) and p.area > 0.02 for x in flat(p, 0.04)]
    if r:
        context.append({"unit": u, "rings": r})

print(json.dumps({"pieces": pieces, "context": context}, separators=(",", ":")))
