# Reference points for test/check-eqearth.mjs, made with PROJ (via pyproj):
#   python3 test/make-eqearth-fixture.py > test/fixtures/eqearth-proj.json
# Equal Earth on the unit sphere and on ellipsoids (EPSG:8857 is WGS 84 at
# lon_0 = 0), forward over the whole map, near the poles and the edges.
import json, math, pyproj

pts = [(lon, lat) for lon in range(-180, 181, 15) for lat in range(-90, 91, 10)]
pts += [(lon, lat) for lon in (-179.9, -90.5, 0.25, 33.3, 179.9) for lat in (-89.99, -89.5, -45.5, -0.1, 0.1, 45.5, 89.5, 89.99)]
defs = [
    "+proj=eqearth +R=1",
    "+proj=eqearth +lon_0=150 +R=1",
    "+proj=eqearth +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
    "+proj=eqearth +lon_0=150 +x_0=1000 +y_0=-2000 +ellps=GRS80 +units=m +no_defs",
    "+proj=eqearth +lon_0=-70 +a=6378273 +b=6356889.449 +units=m +no_defs",
]
out = {"source": "PROJ " + pyproj.proj_version_str, "maps": []}
for s in defs:
    P = pyproj.Proj(s)
    nd = 12 if "+R=1" in s else 4
    rows = []
    for lon, lat in pts:
        x, y = P(lon, lat)
        if math.isfinite(x) and math.isfinite(y):
            rows.append([lon, lat, round(x, nd), round(y, nd)])
    out["maps"].append({"def": s, "pts": rows})

# EPSG:8857 itself, through its CRS rather than a PROJ string
t = pyproj.Transformer.from_crs(4326, 8857, always_xy=True)
out["epsg8857"] = [[lon, lat, *(round(v, 4) for v in t.transform(lon, lat))] for lon, lat in pts[::7]]
print(json.dumps(out))
