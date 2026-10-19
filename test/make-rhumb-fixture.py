# Reference values for test/check-rhumb.mjs, made with PROJ (via pyproj):
#   python3 test/make-rhumb-fixture.py > test/fixtures/rhumb-proj.json
# Geodesics from PROJ's geod (Karney's algorithms). Rhumb lines with no
# rhumb formula at all: a rhumb line is straight on ellipsoidal Mercator,
# so its points are PROJ's merc inverse of evenly spaced points on the
# straight line, and its length is the geodesic length of that line cut
# into many short pieces.
import json, math, pyproj

WGS = pyproj.Geod(ellps="WGS84")
merc = pyproj.Transformer.from_crs("EPSG:4326", "+proj=merc +lon_0=0 +datum=WGS84 +units=m +no_defs", always_xy=True)

pairs = [
    ("Hobart", "Davis", 147.3272, -42.8821, 77.9674, -68.5766),
    ("Hobart", "Mawson", 147.3272, -42.8821, 62.8742, -67.6033),
    ("Hobart", "Casey", 147.3272, -42.8821, 110.5267, -66.2825),
    ("Hobart", "Macquarie Island", 147.3272, -42.8821, 158.9369, -54.4994),
    ("Casey", "Davis", 110.5267, -66.2825, 77.9674, -68.5766),
    ("Hobart", "Cape Town", 147.3272, -42.8821, 18.4241, -33.9249),
    ("Lyttelton", "Punta Arenas", 172.7194, -43.6033, -70.9171, -53.1638),
    ("along 60 S", "", 10.0, -60.0, 50.0, -60.0),
    ("along a meridian", "", 30.0, -10.0, 30.0, -70.0),
    ("along the equator", "", -20.0, 0.0, 40.0, 0.0),
    ("near the pole", "", 0.0, -88.0, 170.0, -87.5),
]

out = {"source": "PROJ " + pyproj.proj_version_str, "pairs": []}
for a, b, lon1, lat1, lon2, lat2 in pairs:
    az1, az2, s = WGS.inv(lon1, lat1, lon2, lat2)
    # the rhumb line on Mercator, taking the short way round in longitude
    dl = ((lon2 - lon1 + 180) % 360) - 180
    x1, y1 = merc.transform(lon1, lat1)
    x2, y2 = merc.transform(lon2, lat2)
    x2 = x1 + 6378137 * math.radians(dl)   # Mercator x is a lon, unwrapped
    n = 20000
    pts = [merc.transform(x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n, direction="INVERSE") for i in range(n + 1)]
    length = WGS.line_length([p[0] for p in pts], [p[1] for p in pts])
    mid = pts[n // 2]
    # the vertex: the latitude nearest a pole on a dense geodesic
    dense = WGS.npts(lon1, lat1, lon2, lat2, 4000)
    lats = [lat1] + [p[1] for p in dense] + [lat2]
    vert = max(lats, key=abs)
    out["pairs"].append({
        "name": f"{a} to {b}" if b else a, "p1": [lon1, lat1], "p2": [lon2, lat2],
        "geodesic": {"s": round(s, 4), "azi1": round(az1 % 360, 10), "azi2": round((az2 + 180) % 360, 10)},
        "rhumb": {"s": round(length, 3), "mid": [round(((mid[0] + 180) % 360) - 180, 10), round(mid[1], 10)]},
        "vertex": round(vert, 6),
    })

print(json.dumps(out))
