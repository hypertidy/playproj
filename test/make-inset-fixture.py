# test/fixtures/inset-proj.json: PROJ's eastings, northings and scale
# factors for the projections of insets.html (src/core/inset.js), at points
# over the 50 states, Puerto Rico and the other examples:
#   python3 test/make-inset-fixture.py > test/fixtures/inset-proj.json
import json
from pyproj import Proj

US = [(-124, 48), (-117, 33), (-97, 26), (-80, 25.5), (-67, 45), (-100, 38), (-150, 61), (-165, 65), (-141, 60),
      (-156, 71), (-168, 54), (-176, 52), (173, 53), (-155.5, 19.5), (-160, 22), (-66.5, 18.2)]
SPECS = {
    "gs50": ({"proj": "gs50"}, "+proj=gs50 +ellps=clrk66", US),
    "gs50s": ({"proj": "gs50", "sphere": True}, "+proj=gs50 +R=6370997", US),
    "alsk": ({"proj": "alsk"}, "+proj=alsk +ellps=clrk66", US[6:13]),
    "alsks": ({"proj": "alsk", "sphere": True}, "+proj=alsk +R=6370997", US[6:13]),
    "aea": ({"proj": "aea", "lat0": 23, "lon0": -96, "lat1": 29.5, "lat2": 45.5}, "+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +ellps=GRS80", US),
    "laea": ({"proj": "laea", "lat0": 46, "lon0": -128}, "+proj=laea +lat_0=46 +lon_0=-128 +ellps=GRS80", US),
    "lcc": ({"proj": "lcc", "lat0": 46.5, "lon0": 3, "lat1": 44, "lat2": 49}, "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=44 +lat_2=49 +ellps=GRS80",
            [(2.35, 48.85), (-4.5, 48.4), (7.5, 43.7), (9.2, 42.2), (-61.5, 16.2)]),
    "tmerc": ({"proj": "tmerc", "lon0": -2, "k0": 0.9996}, "+proj=tmerc +lat_0=0 +lon_0=-2 +k=0.9996 +ellps=WGS84",
              [(-4.25, 55.86), (-1.15, 60.15), (-3.0, 58.9), (-7.3, 57.5)]),
}
out = {}
for key, (spec, s, pts) in SPECS.items():
    p = Proj(s)
    rows = []
    for lon, lat in pts:
        x, y = p(lon, lat)
        f = p.get_factors(lon, lat)
        rows.append([lon, lat, x, y, f.meridional_scale, f.parallel_scale, f.areal_scale, f.angular_distortion])
    out[key] = {"spec": spec, "proj": s, "rows": rows}
print(json.dumps(out, indent=0))
