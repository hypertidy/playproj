# Reference values for test/check-gridref.mjs, made with PROJ (via pyproj):
#   python3 test/make-gridref-fixture.py > test/fixtures/gridref-proj.json
# UTM (WGS84) eastings, northings, point scale and meridian convergence for
# points in many zones, and each zone's false origin (0, 0) taken back to
# longitude and latitude.
import json, random, pyproj

rnd = random.Random(55)
pts = [(147.2625, -42.9216), (147.3272, -42.8821), (-0.0015, 51.4779), (142.6, 0.5), (12.5, 79.0), (-70.0, -79.5)]
pts += [(rnd.uniform(-180, 180), rnd.uniform(-79.9, 83.9)) for _ in range(150)]
out = {"source": "PROJ " + pyproj.proj_version_str, "points": [], "origins": []}
for lon, lat in pts:
    zone = int((lon + 180) // 6) % 60 + 1
    south = lat < 0
    code = (32700 if south else 32600) + zone
    p = pyproj.Proj(code)
    e, n = p(lon, lat)
    f = p.get_factors(lon, lat)
    out["points"].append({"ll": [lon, lat], "zone": zone, "e": e, "n": n, "k": f.meridional_scale, "conv": f.meridian_convergence})
for zone in (1, 30, 55, 60):
    for south in (False, True):
        t = pyproj.Transformer.from_crs((32700 if south else 32600) + zone, 4326, always_xy=True)
        lon, lat = t.transform(0, 0)
        out["origins"].append({"zone": zone, "south": south, "ll": [lon, lat]})
print(json.dumps(out))
