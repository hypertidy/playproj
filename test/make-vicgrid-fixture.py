# Reference values for test/check-vicgrid.mjs, made with PROJ (via pyproj):
#   python3 test/make-vicgrid-fixture.py > test/fixtures/vicgrid-proj.json
# Points in GDA2020 over south-east Australia, taken to each grid by the
# EPSG CRS (through GDA94 with EPSG:8048, and on to AGD66 with PROJ's
# "AGD66 to GDA94 (4)" for New South Wales and Victoria), with PROJ's scale
# factors, and the datum shifts on their own.
import json, random, pyproj
from pyproj.transformer import TransformerGroup

def op(src, dst, name):
    g = TransformerGroup(src, dst, always_xy=True)
    for t in g.transformers:
        if t.description.startswith(name):
            return t
    raise SystemExit(f"no {name} from {src} to {dst}")

g94_20 = op("EPSG:4283", "EPSG:7844", "GDA94 to GDA2020 (1)")
a66_94 = op("EPSG:4202", "EPSG:4283", "AGD66 to GDA94 (4)")
GRIDS = {"vicgrid": 7899, "vicgrid94": 3111, "vicgrid66": 3110, "mga54": 7854, "mga55": 7855, "nsw": 8058, "sa": 8059, "albers": 3577}
DATUM = {7899: "GDA2020", 3111: "GDA94", 3110: "AGD66", 7854: "GDA2020", 7855: "GDA2020", 8058: "GDA2020", 8059: "GDA2020", 3577: "GDA94"}

rnd = random.Random(3111)
pts = [(rnd.uniform(134, 153), rnd.uniform(-44, -28)) for _ in range(200)]
pts += [(144.9631, -37.8136), (145, -37), (141, -34), (150, -37.5), (143.85, -37.56), (144.28, -36.76)]
out = {"source": "PROJ " + pyproj.proj_version_str, "points": []}
for lon, lat in pts:
    lon94, lat94 = g94_20.transform(lon, lat, direction="INVERSE")
    lon66, lat66 = a66_94.transform(lon94, lat94, direction="INVERSE")
    on = {"GDA2020": (lon, lat), "GDA94": (lon94, lat94), "AGD66": (lon66, lat66)}
    rec = {"ll": [lon, lat], "gda94": [round(lon94, 12), round(lat94, 12)], "agd66": [round(lon66, 12), round(lat66, 12)], "grids": {}}
    for k, code in GRIDS.items():
        crs = pyproj.CRS.from_epsg(code)
        p = pyproj.Proj(crs)
        a, b = on[DATUM[code]]
        x, y = p(a, b)
        f = p.get_factors(a, b)
        rec["grids"][k] = [round(x, 5), round(y, 5), round(f.parallel_scale, 10)]
    out["points"].append(rec)
print(json.dumps(out))
