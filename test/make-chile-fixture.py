# Reference values for test/check-chile.mjs, made with PROJ (via pyproj):
#   python3 test/make-chile-fixture.py > test/fixtures/chile-proj.json
# Points over mainland Chile taken to each grid in src/core/chile.js by its
# PROJ string (or EPSG code), with PROJ's scale factors.
import json, random, pyproj

GRIDS = {
    "utm19": ("EPSG:20049", {}),
    "utm18": ("EPSG:20048", {}),
    "faja1": ("+proj=tmerc +lat_0=-90 +lon_0=-72 +k=1 +x_0=1500000 +y_0=0 +ellps=GRS80", {}),
    "tm": ("+proj=tmerc +lat_0=0 +lon_0=-71 +k=0.9998 +x_0=500000 +y_0=10000000 +ellps=GRS80", {"lon0": -71, "kppm": -200}),
    "aea": ("+proj=aea +lat_0=-73 +lon_0=-73 +lat_1=-56 +lat_2=-17 +ellps=GRS80", {"lon0": -73, "lat0": -73, "lat1": -56, "lat2": -17}),
    "aea6": ("+proj=aea +lat_0=-37 +lon_0=-71 +lat_1=-24 +lat_2=-50 +ellps=GRS80", {"lon0": -71, "lat0": -37, "lat1": -24, "lat2": -50}),
    "laea": ("+proj=laea +lat_0=-37 +lon_0=-71 +ellps=GRS80", {"lon0": -71, "lat0": -37}),
    "lcc": ("+proj=lcc +lat_0=-37 +lon_0=-71 +lat_1=-24 +lat_2=-50 +ellps=GRS80", {"lon0": -71, "lat0": -37, "lat1": -24, "lat2": -50}),
    "lonlat": ("+proj=eqc +ellps=GRS80", {}),
}
rnd = random.Random(20049)
pts = [(round(rnd.uniform(-76, -66.4), 6), round(rnd.uniform(-56, -17.5), 6)) for _ in range(150)]
pts += [(-70.6693, -33.4489), (-70.3126, -18.4783), (-70.9171, -53.1638), (-67.6, -54.93), (-75.5, -48)]
out = {"source": "PROJ " + pyproj.proj_version_str, "grids": {}}
for key, (crs, params) in GRIDS.items():
    p = pyproj.Proj(crs)
    rows = []
    for lon, lat in pts:
        x, y = p(lon, lat)
        f = p.get_factors(lon, lat)
        rows.append([lon, lat, round(x, 5), round(y, 5), round(f.meridional_scale, 10),
                     round(f.parallel_scale, 10), round(f.areal_scale, 10), round(f.angular_distortion, 8)])
    out["grids"][key] = {"crs": crs, "params": params, "rows": rows}
print(json.dumps(out))
