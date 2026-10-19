# Reference values for test/check-ellipsoid.mjs, made with PROJ (via pyproj):
#   python3 test/make-ellipsoid-fixture.py > test/fixtures/ellipsoid-proj.json
# Each ellipsoid's a and b from PROJ's ellps table; geodetic to Earth-centred
# x, y, z by +proj=cart; the meridian length from the equator by PROJ's
# geodesics (a meridian is a geodesic). The same for an exaggerated WGS84
# (f times 100), given to PROJ as +a and +rf; PROJ's geodesic series are
# good to about 1e-7 there, so its meridian length is instead the arc of the
# ellipse in the parametric latitude, summed finely.
import json, math, pyproj

def ellipse_arc(a, b, lat, n=200000):
    beta = math.atan((b / a) * math.tan(math.radians(lat))) if abs(lat) < 90 else math.copysign(math.pi / 2, lat)
    h = beta / n
    g = lambda t: math.hypot(a * math.sin(t), b * math.cos(t))
    s = g(0) + g(beta) + sum((4 if i % 2 else 2) * g(i * h) for i in range(1, n))
    return s * h / 3

ELLPS = ["WGS84", "GRS80", "intl", "aust_SA", "krass", "clrk66", "clrk80", "bessel", "airy"]
LATS = [-90, -67.6, -42.88, -10, 0, 1e-3, 30, 45, 60, 89.9, 90]
LON = 147.3

def entry(name, defn, exact=False):
    cart = pyproj.Transformer.from_crs({"proj": "longlat", **defn}, {"proj": "cart", **defn}, always_xy=True)
    geod = pyproj.Geod(**defn)
    pts = []
    for lat in LATS:
        x, y, z = cart.transform(LON, lat, 0.0)
        s = geod.inv(LON, 0.0, LON, lat)[2] if lat != 0 else 0.0
        arc = ellipse_arc(geod.a, geod.b, lat) if exact else (s if lat >= 0 else -s)
        pts.append({"lat": lat, "xyz": [x, y, z], "arc": arc})
    return {"name": name, "a": geod.a, "b": geod.b, "f": geod.f, "points": pts}

out = {"source": "PROJ " + pyproj.proj_version_str, "lon": LON, "ellipsoids": []}
for e in ELLPS:
    out["ellipsoids"].append(entry(e, {"ellps": e}))
f = 100 / 298.257223563
out["ellipsoids"].append(entry("WGS84x100", {"a": 6378137.0, "rf": 1 / f}, exact=True))
print(json.dumps(out, indent=1))
