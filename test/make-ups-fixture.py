"""UPS reference points for test/check-mgrs.mjs: random points in the polar
caps (north of 84 N, south of 80 S) with UPS coordinates from PROJ (EPSG
32661 and 32761) and MGRS references from GeoTrans (the mgrs package).

  python3 test/make-ups-fixture.py
"""
import json, math, os, random
import pyproj, mgrs

here = os.path.dirname(os.path.abspath(__file__))
tn = pyproj.Transformer.from_crs(4326, 32661, always_xy=True)
ts = pyproj.Transformer.from_crs(4326, 32761, always_xy=True)
M = mgrs.MGRS()
rng = random.Random(7)
rows = []
for k in range(1200):
    north = k % 2 == 0
    lat = rng.uniform(84, 89.999) if north else rng.uniform(-89.999, -80.001)
    lon = rng.uniform(-180, 180)
    lon, lat = round(lon, 6), round(lat, 6)
    e, n = (tn if north else ts).transform(lon, lat)
    ref = M.toMGRS(lat, lon, MGRSPrecision=5)
    if isinstance(ref, bytes): ref = ref.decode()
    rows.append([lon, lat, round(e, 4), round(n, 4), ref])
with open(os.path.join(here, "fixtures", "ups-points.json"), "w") as f:
    json.dump({"source": f"pyproj {pyproj.__version__} (PROJ {pyproj.proj_version_str}), mgrs (GeoTrans)",
               "fields": ["lon", "lat", "easting", "northing", "mgrs"], "points": rows}, f, separators=(",", ":"))
print(len(rows), "points", rows[:2])
