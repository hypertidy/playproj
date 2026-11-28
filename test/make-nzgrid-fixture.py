# Reference values for test/check-nzgrid.mjs, made with PROJ (via pyproj):
#   python3 test/make-nzgrid-fixture.py > test/fixtures/nzgrid-proj.json
# NZTM2000 eastings, northings, point scale and convergence from NZGD2000
# longitude and latitude (EPSG:4167 to EPSG:2193), and the grid's 0,0.
import json, random, pyproj

rnd = random.Random(2193)
pts = [(174.7762, -41.2865), (172.6362, -43.5321), (174.7633, -36.8485), (170.1418, -43.5950), (166.5, -46.0), (178.55, -37.69)]
pts += [(rnd.uniform(166.3, 178.6), rnd.uniform(-47.3, -34.4)) for _ in range(80)]
p = pyproj.Proj(2193)
out = {"source": "PROJ " + pyproj.proj_version_str, "points": []}
for lon, lat in pts:
    e, n = p(lon, lat)
    f = p.get_factors(lon, lat)
    out["points"].append({"ll": [lon, lat], "e": e, "n": n, "k": f.meridional_scale, "conv": f.meridian_convergence})
t = pyproj.Transformer.from_crs(2193, 4167, always_xy=True)
out["falseOrigin"] = list(t.transform(0, 0))
print(json.dumps(out))
