# Writes the fixtures test/check-storecrs.mjs reads:
#
#  store-proj.json   CF grid_mapping attributes, and where PROJ (pyproj's
#                    CRS.from_cf) puts sample points in each, and the ground
#                    area of some lon/lat cells from pyproj's Geod
#  store/*.icechunk  small Icechunk repositories written by xarray, with the
#                    CRS described the ways real stores do
#  store/*.zarr      a plain Zarr v3 store with a GeoTransform
#
#   python3 -m pip install pyproj xarray zarr icechunk
#   python3 test/make-store-fixtures.py

import json, os, shutil
import numpy as np
import pyproj
import xarray as xr
import zarr
import icechunk

HERE = os.path.dirname(__file__)
FIX = os.path.join(HERE, "fixtures")
OUT = os.path.join(FIX, "store")
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT)

# ---------------------------------------------------------------- CF mappings

CF = [
    {"grid_mapping_name": "lambert_conformal_conic", "standard_parallel": 38.5, "longitude_of_central_meridian": 262.5,
     "latitude_of_projection_origin": 38.5, "earth_radius": 6371229.0},
    {"grid_mapping_name": "lambert_conformal_conic", "standard_parallel": [33.0, 45.0], "longitude_of_central_meridian": -97.0,
     "latitude_of_projection_origin": 40.0, "false_easting": 1000000.0, "false_northing": 500000.0,
     "semi_major_axis": 6378137.0, "inverse_flattening": 298.257223563},
    {"grid_mapping_name": "polar_stereographic", "straight_vertical_longitude_from_pole": 0.0, "latitude_of_projection_origin": -90.0,
     "standard_parallel": -71.0, "semi_major_axis": 6378137.0, "inverse_flattening": 298.257223563},
    {"grid_mapping_name": "polar_stereographic", "straight_vertical_longitude_from_pole": -45.0, "latitude_of_projection_origin": 90.0,
     "scale_factor_at_projection_origin": 0.97276901289, "semi_major_axis": 6378273.0, "semi_minor_axis": 6356889.449},
    {"grid_mapping_name": "albers_conical_equal_area", "standard_parallel": [-18.0, -36.0], "longitude_of_central_meridian": 132.0,
     "latitude_of_projection_origin": 0.0, "semi_major_axis": 6378137.0, "inverse_flattening": 298.257222101},
    {"grid_mapping_name": "lambert_azimuthal_equal_area", "longitude_of_projection_origin": 10.0, "latitude_of_projection_origin": 52.0,
     "false_easting": 4321000.0, "false_northing": 3210000.0, "semi_major_axis": 6378137.0, "inverse_flattening": 298.257222101},
    {"grid_mapping_name": "transverse_mercator", "scale_factor_at_central_meridian": 0.9996, "longitude_of_central_meridian": 147.0,
     "latitude_of_projection_origin": 0.0, "false_easting": 500000.0, "false_northing": 10000000.0,
     "semi_major_axis": 6378137.0, "inverse_flattening": 298.257222101},
    {"grid_mapping_name": "mercator", "longitude_of_projection_origin": 0.0, "standard_parallel": 20.0,
     "semi_major_axis": 6378137.0, "inverse_flattening": 298.257223563},
    {"grid_mapping_name": "lambert_cylindrical_equal_area", "longitude_of_central_meridian": 0.0, "standard_parallel": 30.0,
     "semi_major_axis": 6378137.0, "inverse_flattening": 298.257223563},
    {"grid_mapping_name": "sinusoidal", "longitude_of_central_meridian": 0.0, "earth_radius": 6371007.181},
    {"grid_mapping_name": "stereographic", "longitude_of_projection_origin": 147.0, "latitude_of_projection_origin": -42.0,
     "scale_factor_at_projection_origin": 1.0, "earth_radius": 6371000.0},
    {"grid_mapping_name": "azimuthal_equidistant", "longitude_of_projection_origin": 78.0, "latitude_of_projection_origin": -68.6,
     "semi_major_axis": 6378137.0, "inverse_flattening": 298.257223563},
    {"grid_mapping_name": "orthographic", "longitude_of_projection_origin": 147.0, "latitude_of_projection_origin": -42.0, "earth_radius": 6371000.0},
    {"grid_mapping_name": "geostationary", "perspective_point_height": 35786023.0, "longitude_of_projection_origin": -75.0,
     "sweep_angle_axis": "x", "semi_major_axis": 6378137.0, "semi_minor_axis": 6356752.31414},
]

def points_near(cf):
    lon0 = cf.get("longitude_of_central_meridian", cf.get("longitude_of_projection_origin", cf.get("straight_vertical_longitude_from_pole", 0)))
    lat0 = cf.get("latitude_of_projection_origin", 0)
    if cf["grid_mapping_name"] == "polar_stereographic":
        lat0 = 75 * np.sign(lat0)
    if cf["grid_mapping_name"] == "lambert_cylindrical_equal_area" or cf["grid_mapping_name"] in ("mercator", "sinusoidal"):
        lat0 = 10
    out = []
    for dl in (-12, 0, 9):
        for dp in (-8, 0, 6):
            out.append([((lon0 + dl + 540) % 360) - 180, float(np.clip(lat0 + dp, -89, 89))])
    return out

cases = []
for cf in CF:
    crs = pyproj.CRS.from_cf(cf)
    tr = pyproj.Transformer.from_crs(crs.geodetic_crs, crs, always_xy=True)
    pts = points_near(cf)
    xy = [list(tr.transform(lon, lat)) for lon, lat in pts]
    cases.append({"cf": cf, "lonlat": pts, "xy": xy, "proj4": crs.to_proj4()})

geod = pyproj.Geod(ellps="WGS84")
areas = []
for lon, lat, dlon, dlat in [(0, 0, 0.25, 0.25), (10, 60, 1, 1), (100, 89.75, 0.25, 0.25), (-50, -45, 2, 3)]:
    # edges along the parallels, not geodesics: densify them
    t = np.linspace(0, 1, 2001)
    lons = np.concatenate([lon + dlon * t, lon + dlon * t[::-1]])
    lats = np.concatenate([np.full_like(t, lat), np.full_like(t, lat + dlat)])
    a, _ = geod.polygon_area_perimeter(lons, lats)
    areas.append({"lon": lon, "lat": lat, "dlon": dlon, "dlat": dlat, "area": abs(a)})

json.dump({"cases": cases, "areas": areas, "a": 6378137.0, "es": geod.es, "pyproj": pyproj.__version__, "proj": pyproj.proj_version_str},
          open(os.path.join(FIX, "store-proj.json"), "w"), indent=1)

# ---------------------------------------------------------------- stores

rng = np.random.default_rng(1)

def field(ny, nx, nt=2):
    j, i = np.meshgrid(np.linspace(0, 1, ny), np.linspace(0, 1, nx), indexing="ij")
    return np.stack([np.sin(6 * i + t) * np.cos(4 * j) * 10 + 280 for t in range(nt)]).astype("float32")

def write_icechunk(name, ds, encoding):
    path = os.path.join(OUT, name)
    repo = icechunk.Repository.create(icechunk.local_filesystem_storage(path))
    session = repo.writable_session("main")
    ds.to_zarr(session.store, mode="w", encoding=encoding, consolidated=False, zarr_format=3)
    session.commit("fixture")

time = np.array(["2026-01-01", "2026-01-02"], dtype="datetime64[ns]")
stores = []

# a HRRR-like Lambert conformal grid: projected x, y in metres and a CF grid_mapping
lcc = CF[0]
crs = pyproj.CRS.from_cf(lcc)
tr = pyproj.Transformer.from_crs(crs.geodetic_crs, crs, always_xy=True)
x0, y0 = tr.transform(-122.719528, 21.138123)
nx, ny, d = 60, 36, 3000.0 * 30
x = x0 + d * np.arange(nx); y = y0 + d * np.arange(ny)
ds = xr.Dataset({"t2m": (("time", "y", "x"), field(ny, nx), {"units": "K", "grid_mapping": "spatial_ref"}),
                 "spatial_ref": ((), 0, {**lcc, "crs_wkt": crs.to_wkt()})},
                coords={"time": time, "x": ("x", x, {"standard_name": "projection_x_coordinate", "units": "m"}),
                        "y": ("y", y, {"standard_name": "projection_y_coordinate", "units": "m"})})
write_icechunk("lcc.icechunk", ds, {"t2m": {"chunks": (1, 16, 16)}})
stores.append({"name": "lcc.icechunk", "variable": "t2m", "nx": nx, "ny": ny, "chunks": [1, 16, 16], "x0": float(x[0] - d / 2), "dx": d, "y0": float(y[0] - d / 2), "dy": d,
               "corner": list(pyproj.Transformer.from_crs(crs, crs.geodetic_crs, always_xy=True).transform(x[0], y[0]))})

# a sea-ice-like south polar stereographic grid in kilometres
ps = CF[2]
crs = pyproj.CRS.from_cf(ps)
nx, ny, d = 79, 83, 100.0
x = -3950 + d / 2 + d * np.arange(nx); y = 4350 - d / 2 - d * np.arange(ny)
ds = xr.Dataset({"ice": (("time", "y", "x"), field(ny, nx), {"grid_mapping": "crs"}),
                 "crs": ((), 0, ps)},
                coords={"time": time, "x": ("x", x, {"standard_name": "projection_x_coordinate", "units": "km"}),
                        "y": ("y", y, {"standard_name": "projection_y_coordinate", "units": "km"})})
write_icechunk("polar.icechunk", ds, {"ice": {"chunks": (1, 40, 40)}})
stores.append({"name": "polar.icechunk", "variable": "ice", "nx": nx, "ny": ny, "chunks": [1, 40, 40], "x0": -3950e3, "dx": 1e5, "y0": 4350e3, "dy": -1e5,
               "corner": list(pyproj.Transformer.from_crs(crs, crs.geodetic_crs, always_xy=True).transform(x[0] * 1000, y[0] * 1000))})

# an ERA5-like global lon/lat grid with no CRS at all, in a group
lat = np.linspace(90, -90, 91); lon = np.arange(0, 360, 2.0)
ds = xr.Dataset({"2m_temperature": (("time", "latitude", "longitude"), field(91, 180), {"units": "K"})},
                coords={"time": time, "latitude": ("latitude", lat, {"units": "degrees_north"}), "longitude": ("longitude", lon, {"units": "degrees_east"})})
path = os.path.join(OUT, "era.icechunk")
repo = icechunk.Repository.create(icechunk.local_filesystem_storage(path))
session = repo.writable_session("main")
ds.to_zarr(session.store, group="1x91x180", mode="w", encoding={"2m_temperature": {"chunks": (1, 91, 180)}}, consolidated=False, zarr_format=3)
session.commit("fixture")
stores.append({"name": "era.icechunk", "variable": "1x91x180/2m_temperature", "nx": 180, "ny": 91, "chunks": [1, 91, 180], "x0": -1.0, "dx": 2.0, "y0": 91.0, "dy": -2.0})

# a EURO-CORDEX-like rotated pole grid
rp = {"grid_mapping_name": "rotated_latitude_longitude", "grid_north_pole_longitude": -162.0, "grid_north_pole_latitude": 39.25}
rlon = -28.375 + 0.44 * np.arange(106); rlat = -23.375 + 0.44 * np.arange(103)
ds = xr.Dataset({"tas": (("time", "rlat", "rlon"), field(103, 106), {"grid_mapping": "rotated_pole"}),
                 "rotated_pole": ((), 0, rp)},
                coords={"time": time, "rlon": ("rlon", rlon, {"standard_name": "grid_longitude", "units": "degrees"}),
                        "rlat": ("rlat", rlat, {"standard_name": "grid_latitude", "units": "degrees"})})
write_icechunk("rotated.icechunk", ds, {"tas": {"chunks": (1, 52, 53)}})
stores.append({"name": "rotated.icechunk", "variable": "tas", "nx": 106, "ny": 103, "chunks": [1, 52, 53], "x0": -28.375 - 0.22, "dx": 0.44, "y0": -23.375 - 0.22, "dy": 0.44})

# a GLAD-like plain Zarr v3 store: GeoTransform on spatial_ref, x/y without values needed
nx, ny = 240, 100
g = zarr.open_group(os.path.join(OUT, "glad.zarr"), mode="w", zarr_format=3)
a = g.create_array("lclu", shape=(2, ny, nx), chunks=(1, 50, 60), dtype="uint8", fill_value=255,
                   dimension_names=["year", "y", "x"], attributes={"grid_mapping": "spatial_ref"})
a[:] = rng.integers(0, 200, size=(2, ny, nx), dtype="uint8")
s = g.create_array("spatial_ref", shape=(), dtype="int64", attributes={
    "crs_wkt": pyproj.CRS.from_epsg(4326).to_wkt("WKT1_GDAL"), "grid_mapping_name": "latitude_longitude",
    "GeoTransform": "-180.0 1.5 0.0 80.0 0.0 -1.5"})
zarr.consolidate_metadata(os.path.join(OUT, "glad.zarr"))
stores.append({"name": "glad.zarr", "variable": "lclu", "nx": nx, "ny": ny, "chunks": [1, 50, 60], "x0": -180.0, "dx": 1.5, "y0": 80.0, "dy": -1.5})

# the real GLAD store's shape, metadata only: every chunk reads as the fill value
g = zarr.open_group(os.path.join(OUT, "huge.zarr"), mode="w", zarr_format=3)
g.create_array("lclu", shape=(5, 560000, 1440000), chunks=(1, 1000, 1000), dtype="uint8", fill_value=255,
               dimension_names=["year", "y", "x"], attributes={"grid_mapping": "spatial_ref"})
g.create_array("spatial_ref", shape=(), dtype="int64", attributes={
    "crs_wkt": pyproj.CRS.from_epsg(4326).to_wkt("WKT1_GDAL"), "grid_mapping_name": "latitude_longitude",
    "GeoTransform": "-180.0 0.00025 0.0 80.0 0.0 -0.00025"})
zarr.consolidate_metadata(os.path.join(OUT, "huge.zarr"))
stores.append({"name": "huge.zarr", "variable": "lclu", "nx": 1440000, "ny": 560000, "chunks": [1, 1000, 1000], "x0": -180.0, "dx": 0.00025, "y0": 80.0, "dy": -0.00025})

json.dump({"stores": stores}, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
print("wrote", len(cases), "CF cases and", len(stores), "stores")
