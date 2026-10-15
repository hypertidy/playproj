"""Read the GeoTIFFs from test/write-tifs.mjs with GDAL (via rasterio) and
check the CRS reproduces the projection. Usage: python3 test/check-geotiff.py OUTDIR"""
import json, sys
import rasterio
from rasterio.warp import transform

out = sys.argv[1]
fails = 0
for case in json.load(open(f"{out}/manifest.json")):
    with rasterio.open(case["file"]) as src:
        crs = src.crs
        line = f"{case['proj'] or '(none)':55s} -> {crs.to_proj4() if crs else None}"
        if case["proj"] is None:
            print("ok  ", line)
            continue
        if crs is None:
            fails += 1; print("FAIL", line); continue
        lon = [q["lon"] for q in case["pts"]]; lat = [q["lat"] for q in case["pts"]]
        xs, ys = transform("+proj=longlat +R=6370997", crs, lon, lat)
        d = max(abs(x - q["x"]) + abs(y - q["y"]) for x, y, q in zip(xs, ys, case["pts"]))
        ok = d < 1e-3
        fails += not ok
        print("ok  " if ok else "FAIL", line, f"maxdiff {d:.2e} m", src.transform.c, src.transform.a)
sys.exit(1 if fails else 0)
