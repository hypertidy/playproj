# Reference values for test/check-penguin.mjs, from PROJ (via pyproj):
#   python3 test/make-penguin-fixture.py > test/fixtures/penguin-proj.json
# The penguin decree's coordinates are earth directions rotated so that
# Mawson Peak, Heard Island (73.513 E, 53.106 S) is at penguin lon 0,
# lat 0 and the meridian north from it runs up to the penguin's crown
# (36.894 N 73.513 E). PROJ writes that as ob_tran on a sphere; this
# records PROJ's rotation of random points, and the PROJJSON PROJ makes
# for the string, so the page's own rotation and PROJJSON can be checked.
import json, random
import pyproj

R = 6371000.79
S = f"+proj=ob_tran +o_proj=longlat +o_lon_p=180 +o_lat_p=36.894 +lon_0=-106.487 +R={R} +no_defs"
src = pyproj.CRS(f"+proj=longlat +R={R} +no_defs")
dst = pyproj.CRS(S)
t = pyproj.Transformer.from_crs(src, dst, always_xy=True)
random.seed(42)
pts = [[73.513, -53.106], [0, 0], [147.3, -42.9], [-106.487, 36.894], [73.513, 36.894]]
for _ in range(200):
    pts.append([round(random.uniform(-180, 180), 4), round(random.uniform(-89.5, 89.5), 4)])
out = []
for lon, lat in pts:
    x, y = t.transform(lon, lat)
    out.append([lon, lat, round(x, 9), round(y, 9)])
pj = json.loads(dst.to_json())
print(json.dumps({
    "proj": pyproj.proj_version_str, "string": S,
    "parameters": pj["conversion"]["parameters"], "method": pj["conversion"]["method"]["name"], "type": pj["type"],
    "points": out
}))
