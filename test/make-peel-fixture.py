# Reference points for test/check-peel.mjs, made with PROJ (via pyproj):
#   python3 test/make-peel-fixture.py > test/fixtures/peel-proj.json
# Each gore flattening is PROJ's sinu, cass or tmerc on the unit sphere,
# centred on the gore's own central meridian: points across 4, 12 and 24
# gores, from pole to pole.
import json, math, pyproj

out = {"source": "PROJ " + pyproj.proj_version_str, "gores": []}
for n in (4, 12, 24):
    half = 180.0 / n
    lon_0 = -180 + half + 3 * (360.0 / n) if n > 4 else -180 + half
    for name in ("sinu", "cass", "tmerc"):
        s = f"+proj={name} +lon_0={lon_0:.12g} +R=1"
        P = pyproj.Proj(s)
        rows = []
        for f in (-1, -0.7, -0.3, 0, 0.4, 0.8, 1):
            for lat in (-89.5, -75, -50, -20, 0, 10, 35, 60, 85, 89.5):
                lon = lon_0 + f * half
                x, y = P(lon, lat)
                rows.append([round(lon, 12), lat, round(x, 12), round(y, 12)])
        out["gores"].append({"n": n, "proj": name, "lon0": lon_0, "def": s, "pts": rows})
print(json.dumps(out))
