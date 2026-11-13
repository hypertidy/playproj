# Reference lengths for test/check-coastlen.mjs from PROJ (pyproj): each
# coast in data/coast-south-10m.json measured as geodesics on the sphere of
# mean radius and on WGS84, and drawn on spherical Mercator.
#
#   python3 test/make-coastlen-fixture.py > test/fixtures/coastlen-proj.json
import json, math, sys, os
from pyproj import Geod, Transformer

here = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(here, "..", "data", "coast-south-10m.json")))
R = 6371008.8
sphere, wgs = Geod(a=R, b=R), Geod(ellps="WGS84")
merc = Transformer.from_crs("EPSG:4326", f"+proj=merc +R={R} +type=crs", always_xy=True)
out = {}
for k in ("australia", "grounding", "front"):
    f = d[k]
    lon, lat = f[0::2], f[1::2]
    x, y = merc.transform(lon, lat)
    m = 0.0
    for i in range(1, len(x)):
        dx = x[i] - x[i - 1]
        # a step across the antimeridian
        if abs(dx) > math.pi * R:
            dx -= math.copysign(2 * math.pi * R, dx)
        m += math.hypot(dx, y[i] - y[i - 1])
    out[k] = {
        "sphere_km": sphere.line_length(lon, lat) / 1000,
        "wgs84_km": wgs.line_length(lon, lat) / 1000,
        "mercator_km": m / 1000,
    }
json.dump(out, sys.stdout, indent=1)
print()
