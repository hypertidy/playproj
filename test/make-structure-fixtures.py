# Writes the small GeoTIFF/COG and Zarr fixtures that test/check-structure.mjs
# reads, and records what GDAL (rasterio) and tifffile say about each, so the
# JavaScript readers are checked against independent ones. Pixel data are
# zeros: only the structure matters.
#
#   python3 -m pip install rasterio tifffile zarr
#   python3 test/make-structure-fixtures.py

import json, os, shutil
import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.crs import CRS
import tifffile
import zarr

OUT = os.path.join(os.path.dirname(__file__), "fixtures", "structure")
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT)

def write_tif(name, width, height, bounds, crs, dtype, profile):
    path = os.path.join(OUT, name)
    data = np.zeros((1, height, width), dtype=dtype)
    with rasterio.open(path, "w", width=width, height=height, count=1, dtype=dtype,
                       crs=crs, transform=from_bounds(*bounds, width, height), **profile) as ds:
        ds.write(data)
    return path

cases = [
    ("world-4326.tif", 4320, 2160, (-180, -90, 180, 90), CRS.from_epsg(4326), "int16",
     dict(driver="COG", blocksize=256, compress="DEFLATE")),
    ("polar-3031-bigtiff.tif", 1000, 1000, (-3e6, -3e6, 3e6, 3e6), CRS.from_epsg(3031), "float32",
     dict(driver="COG", blocksize=128, compress="ZSTD", BIGTIFF="YES")),
    ("strips-utm55s.tif", 300, 200, (499980, 5190220, 502980, 5192220), CRS.from_epsg(32755), "uint8",
     dict(driver="GTiff")),
    ("custom-laea.tif", 512, 384, (-2e6, -1.5e6, 2e6, 1.5e6),
     CRS.from_proj4("+proj=laea +lat_0=-42 +lon_0=147 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs"), "uint16",
     dict(driver="COG", blocksize=128, compress="LZW")),
]

manifest = {"tiff": [], "zarr": []}
for name, w, h, b, crs, dt, prof in cases:
    path = write_tif(name, w, h, b, crs, dt, prof)
    with rasterio.open(path) as ds:
        t = ds.transform
        rec = {"file": name, "width": ds.width, "height": ds.height, "block": list(ds.block_shapes[0]),
               "overviews": ds.overviews(1), "transform": [t.a, t.b, t.c, t.d, t.e, t.f],
               "epsg": ds.crs.to_epsg(), "dtype": ds.dtypes[0], "compress": str(ds.compression.value if ds.compression else "none")}
    with tifffile.TiffFile(path) as tf:
        rec["bigtiff"] = tf.is_bigtiff
        rec["levels"] = []
        for p in tf.pages:
            offs = p.dataoffsets
            cnts = p.databytecounts
            rec["levels"].append({"width": p.imagewidth, "height": p.imagelength,
                                  "tile": [p.tilewidth or p.imagewidth, p.tilelength or p.rowsperstrip],
                                  "ntiles": len(offs), "first": [int(offs[0]), int(cnts[0])],
                                  "last": [int(offs[-1]), int(cnts[-1])]})
    if name.startswith("custom"):
        # points in the custom CRS, to check the PROJ string built from geokeys
        from rasterio.warp import transform
        xs, ys = transform("EPSG:4326", crs, [147, 150, 140, 160], [-42, -30, -50, -38])
        rec["points"] = [[lon, lat, x, y] for lon, lat, x, y in zip([147, 150, 140, 160], [-42, -30, -50, -38], xs, ys)]
    manifest["tiff"].append(rec)

# Zarr v3: a GeoZarr-style multiscale group, each level a group holding one
# sharded array, consolidated so the levels' arrays are listed
z3 = os.path.join(OUT, "polar-v3.zarr")
g = zarr.open_group(z3, mode="w", zarr_format=3)
size, cell = 4096, 1500.0
layout = []
for k in range(4):
    n = size >> k
    lv = g.create_group(str(k))
    lv.attrs["spatial:transform"] = [cell * 2 ** k, 0.0, -3072000.0, 0.0, -cell * 2 ** k, 3072000.0]
    lv.attrs["spatial:shape"] = [n, n]
    lv.create_array("elevation", shape=(n, n), chunks=(256, 256), shards=(min(n, 1024), min(n, 1024)),
                    dtype="int16", dimension_names=["y", "x"], fill_value=0)
    layout.append({"asset": str(k)} if k == 0 else {"asset": str(k), "derived_from": str(k - 1), "transform": {"scale": [2.0, 2.0]}})
g.attrs["multiscales"] = {"layout": layout, "resampling_method": "average"}
g.attrs["proj:code"] = "EPSG:3031"
g.attrs["spatial:dimensions"] = ["y", "x"]
zarr.consolidate_metadata(z3)
manifest["zarr"].append({"store": "polar-v3.zarr", "epsg": 3031, "levels": [[size >> k, size >> k] for k in range(4)],
                         "chunk": [1024, 1024], "inner": [256, 256], "x0": -3072000.0, "y0": 3072000.0, "dx": cell})

# Zarr v2 as xarray and rioxarray write it: dims (time, lat, lon), a
# spatial_ref variable carrying crs_wkt and a GDAL GeoTransform
z2 = os.path.join(OUT, "sst-v2.zarr")
g = zarr.open_group(z2, mode="w", zarr_format=2)
a = g.create_array("sst", shape=(12, 720, 1440), chunks=(1, 360, 360), dtype="float32", fill_value=np.nan)
a.attrs["_ARRAY_DIMENSIONS"] = ["time", "lat", "lon"]
a.attrs["grid_mapping"] = "spatial_ref"
r = g.create_array("spatial_ref", shape=(), dtype="int64", fill_value=0)
r.attrs["_ARRAY_DIMENSIONS"] = []
r.attrs["crs_wkt"] = CRS.from_epsg(4326).to_wkt()
r.attrs["GeoTransform"] = "-180.0 0.25 0.0 90.0 0.0 -0.25"
for nm, n in (("lat", 720), ("lon", 1440), ("time", 12)):
    c = g.create_array(nm, shape=(n,), chunks=(n,), dtype="float64", fill_value=0)
    c.attrs["_ARRAY_DIMENSIONS"] = [nm]
zarr.consolidate_metadata(z2)
manifest["zarr"].append({"store": "sst-v2.zarr", "epsg": 4326, "levels": [[1440, 720]], "chunk": [360, 360],
                         "x0": -180.0, "y0": 90.0, "dx": 0.25, "extra": [["time", 12, 1]]})

with open(os.path.join(OUT, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=1)
print(json.dumps(manifest, indent=1)[:3000])
