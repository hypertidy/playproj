# data/insets-10m.json: the pieces of the inset maps on insets.html, and
# the land around them, from Natural Earth's 1:10m admin-0 map units
# (public domain):
#   python3 test/make-insets-data.py ne_10m_admin_0_map_units.geojson > data/insets-10m.json
# from https://github.com/nvkelso/natural-earth-vector (geojson/). Needs
# shapely. Each piece is a list of rings, each ring a flat
# [lon, lat, lon, lat, ...] array at 3 decimals; a piece is the rings of
# some map units whose centre falls in one of its boxes. Context is the
# other land in each scene's boxes, simplified harder.
import json, sys
from shapely.geometry import shape, box, Polygon, MultiPolygon
from shapely.ops import unary_union

# key: (map units, boxes [lon0, lat0, lon1, lat1] for the ring centres)
PIECES = {
    "us48": (["USA"], [[-125.5, 24, -66, 50]]),
    "alaska": (["USA"], [[-180, 51, -129, 72], [170, 50, 180, 56]]),
    "hawaii": (["USA"], [[-179, 18, -154, 29.5]]),
    "puertorico": (["PRI"], [[-68, 17.5, -65, 19]]),
    "usvi": (["VIR"], [[-65.2, 17.5, -64.4, 18.6]]),
    "guam": (["GUM"], [[144, 13, 145.5, 14]]),
    "cnmi": (["MNP"], [[144.5, 14, 146.5, 21]]),
    "amsamoa": (["ASM"], [[-171, -14.4, -169.3, -14.1]]),
    "france": (["FXX"], [[-6, 41, 10, 52]]),
    "guadeloupe": (["GLP"], [[-62, 15.7, -60.9, 16.6]]),
    "martinique": (["MTQ"], [[-61.4, 14.3, -60.7, 15]]),
    "guyane": (["GUF"], [[-55, 2, -51, 6]]),
    "reunion": (["REU"], [[55, -21.5, 56, -20.8]]),
    "mayotte": (["MYT"], [[44.9, -13.1, 45.4, -12.5]]),
    "scotland": (["SCT"], [[-9, 54.5, 0, 59.6]]),
    "shetland": (["SCT"], [[-2.5, 59.7, 0, 61]]),
    "chile": (["CHL"], [[-76.5, -56.5, -66, -17]]),
    "easter": (["CHL"], [[-109.6, -27.3, -109.1, -27]]),
    "juanfernandez": (["CHL"], [[-81, -34, -78.7, -33.5]]),
    "chileantarctic": (["ATA"], [[-90, -90, -53, -60]]),
    "spain": (["ESP"], [[-10, 35, 5, 44]]),
    "canarias": (["ESP"], [[-18.5, 27.5, -13, 29.5]]),
    "portugal": (["PRX"], [[-10, 36.8, -6, 42.2]]),
    "azores": (["PAZ"], [[-32, 36.5, -24.5, 40]]),
    "madeira": (["PMD"], [[-17.5, 29.9, -15.8, 33.2]]),
    "norway": (["NOW"], [[4, 57.5, 32, 71.5]]),
    "svalbard": (["NSV"], [[9, 74, 35, 81]]),
    "janmayen": (["NJM"], [[-9.2, 70.7, -7.8, 71.2]]),
    "bouvet": (["BVT"], [[3, -54.7, 3.7, -54.2]]),
    "ecuador": (["ECU"], [[-82, -5.1, -75, 1.7]]),
    "galapagos": (["ECU"], [[-92.5, -1.6, -89, 0.8]]),
    "nz": (["NZL"], [[166, -47.5, 179, -34]]),
    "chathams": (["NZL"], [[-177, -44.5, -175.5, -43.5]]),
    "kermadec": (["NZL"], [[-179.5, -31.5, -177.5, -29]]),
    "nzsubantarctic": (["NZL"], [[165.5, -53, 179.5, -47.5]]),
    "denmark": (["DNK"], [[8, 54.5, 13, 58]]),
    "bornholm": (["DNK"], [[14.6, 54.9, 15.3, 55.4]]),
    "faroe": (["FRO"], [[-8, 61, -6, 63]]),
    "greenland": (["GRL"], [[-75, 59, -10, 84]]),
    "tasmania": (["AUS"], [[143.5, -44, 149, -39.4]]),
    "macquarie": (["AUS"], [[158.5, -55, 159.2, -54.3]]),
}
# scene: boxes for the land drawn around the pieces
CONTEXT = {
    "usa": [[-180, 5, -50, 75], [150, 45, 180, 75], [130, 5, 150, 25], [-175, -20, -165, -10]],
    "france": [[-12, 35, 20, 56], [-63, 13, -59, 17.5], [-60, 0, -48, 8], [54, -22.5, 57, -19.5], [43, -13.5, 46, -11]],
    "scotland": [[-12, 50, 10, 62]],
    "chile": [[-90, -90, -30, -10], [-112, -30, -105, -24]],
    "spain": [[-20, 26, 6, 45]],
    "portugal": [[-33, 29, 0, 44]],
    "norway": [[-15, 54, 40, 82], [0, -56, 6, -52]],
    "ecuador": [[-93, -8, -70, 4]],
    "nz": [[160, -55, 180, -28], [-180, -55, -175, -28]],
    "denmark": [[-75, 53, 20, 84]],
    "tasmania": [[140, -56, 160, -37]],
}

# units already drawn as pieces in each scene, left out of its context
OWN = {
    "usa": ["USA", "PRI", "VIR", "GUM", "MNP", "ASM"], "france": ["FXX", "GLP", "MTQ", "GUF", "REU", "MYT"],
    "scotland": ["SCT"], "chile": ["CHL"], "spain": ["ESP"], "portugal": ["PRX", "PAZ", "PMD"],
    "norway": ["NOW", "NSV", "NJM", "BVT"], "ecuador": ["ECU"], "nz": ["NZL"], "denmark": ["DNK", "FRO", "GRL"],
}

src = json.load(open(sys.argv[1]))
units = {}
for f in src["features"]:
    units.setdefault(f["properties"]["GU_A3"], []).append(shape(f["geometry"]))

def polys(g):
    return list(g.geoms) if hasattr(g, "geoms") else [g]

def flat(poly, tol):
    p = poly.simplify(tol, preserve_topology=True)
    out = []
    for p in polys(p):
        if p.is_empty or p.area < tol * tol:
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

pieces, used = {}, {}
for key, (us, boxes) in PIECES.items():
    sel = [p for u in us for g in units[u] for p in polys(g) if inside(p.representative_point(), boxes)]
    # simplify in proportion to the size of the piece, about 1/1500 of its span,
    # and drop islets under a few tolerances across
    x0 = min(p.bounds[0] for p in sel); x1 = max(p.bounds[2] for p in sel)
    y0 = min(p.bounds[1] for p in sel); y1 = max(p.bounds[3] for p in sel)
    tol = max(0.002, min(0.03, max(x1 - x0, y1 - y0) / 1500))
    rings = []
    for p in sel:
        if p.area > (3 * tol) ** 2 or len(sel) < 30:
            rings += flat(p, tol)
    if not rings:
        sys.exit(f"no land for {key}")
    pieces[key] = rings

context = {}
for scene, boxes in CONTEXT.items():
    out = []
    clip = unary_union([box(*b) for b in boxes])
    for u, gs in units.items():
        if u in OWN.get(scene, ()):
            continue
        g = unary_union(gs).intersection(clip)
        if g.is_empty:
            continue
        r = []
        for p in polys(g):
            if isinstance(p, Polygon):
                r += flat(p, 0.04) if p.area > 0.02 else []
        if r:
            out.append({"unit": u, "rings": r})
    context[scene] = out

print(json.dumps({"pieces": pieces, "context": context}, separators=(",", ":")))
