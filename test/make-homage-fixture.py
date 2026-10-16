# Reference points for test/check-homage.mjs, made with PROJ (via pyproj):
#   python3 test/make-homage-fixture.py > test/fixtures/homage-proj.json
# Unit sphere throughout, so the d3 raw projections compare directly.
import json, pyproj

LL = pyproj.CRS("+proj=longlat +R=1")
PROJ = {
    "merc": "+proj=merc", "eqc": "+proj=eqc", "gallpeters": "+proj=cea +lat_ts=45",
    "hobodyer": "+proj=cea +lat_ts=37.5", "robin": "+proj=robin", "wintri": "+proj=wintri +lat_1=50.4597762",
    "vandg": "+proj=vandg", "eqearth": "+proj=eqearth",
    "aeqd": "+proj=aeqd +lat_0=90", "laea": "+proj=laea +lat_0=90",
}
pts = [(lon, lat) for lon in range(-175, 180, 25) for lat in range(-85, 90, 10)]
pts += [(lon, lat) for lon in (-180, 0, 30, 180) for lat in range(-90, 91, 5)]
pts += [(lon, lat) for lon in (-160, 45, 120) for lat in (-87.3, -41.7, -12.3, 2.5, 33.3, 62.1, 88.8)]
out = {"source": "PROJ " + pyproj.proj_version_str, "proj": {}}
for k, s in PROJ.items():
    t = pyproj.Transformer.from_crs(LL, pyproj.CRS(s + " +R=1"), always_xy=True)
    rows = []
    for lon, lat in pts:
        if k == "merc" and abs(lat) > 85: continue
        x, y = t.transform(lon, lat)
        if x == x and abs(x) < 1e30: rows.append([lon, lat, round(x, 10), round(y, 10)])
    out["proj"][k] = {"proj": s, "pts": rows}
print(json.dumps(out))
