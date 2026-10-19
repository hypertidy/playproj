# Reference points for test/check-nuyina.mjs, made with PROJ (via pyproj):
#   python3 test/make-nuyina-fixture.py > test/fixtures/nuyina-proj.json
# Polar stereographic in the CRSs the Nuyina page reads: Antarctic
# (EPSG:3031), IBCSO (EPSG:9354), NSIDC sea ice south (EPSG:3412 on Hughes
# 1980, EPSG:3976 on WGS84) and north (EPSG:3413, EPSG:3411).
import json, pyproj

out = {"source": "PROJ " + pyproj.proj_version_str, "crs": {}}
south = [(lon, lat) for lon in range(-180, 180, 23) for lat in (-89.9, -85, -78.5, -71, -66.25, -60, -52.5, -45, -40)]
north = [(lon, -lat) for lon, lat in south]
for code in ("EPSG:3031", "EPSG:9354", "EPSG:3412", "EPSG:3976", "EPSG:3413", "EPSG:3411"):
    t = pyproj.Transformer.from_crs("EPSG:4326", code, always_xy=True)
    pts = north if code in ("EPSG:3413", "EPSG:3411") else south
    rows = []
    for lon, lat in pts:
        x, y = t.transform(lon, lat)
        f = pyproj.Proj(code).get_factors(lon, lat)
        rows.append([lon, lat, round(x, 4), round(y, 4), round(f.parallel_scale, 12)])
    out["crs"][code] = rows
# the NSIDC south grid's corners and the centre of cell (0, 0)
t = pyproj.Transformer.from_crs("EPSG:3412", "EPSG:4326", always_xy=True)
out["nsidc_south_corners"] = [[x, y, *[round(v, 9) for v in t.transform(x, y)]] for x, y in
    [(-3950000, 4350000), (3950000, 4350000), (3950000, -3950000), (-3950000, -3950000), (-3937500, 4337500)]]
# ship-centred azimuthals (the page's "follow the ship" maps), inverse
out["ship"] = []
for proj, lat0, lon0 in (("aeqd", -61.89612, 140.1), ("aeqd", -66.3, 110.5), ("laea", -66.3, 110.5), ("stere", -53.0, 73.4)):
    s = f"+proj={proj} +lat_0={lat0} +lon_0={lon0} +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs"
    t = pyproj.Transformer.from_crs(s, "EPSG:4326", always_xy=True)
    out["ship"].append({"proj": s, "pts": [[x, y, *[round(v, 10) for v in t.transform(x, y)]] for x in (-8e5, -1e5, 0, 3e5, 9e5) for y in (-7e5, 0, 2e5, 1e6)]})
print(json.dumps(out))
