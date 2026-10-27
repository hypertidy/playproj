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
for f in (os.listdir(OUT) if os.path.isdir(OUT) else []):
    if os.environ.get("FIXTURES_FORCE") or not f.endswith(".icechunk"):
        p = os.path.join(OUT, f)
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
os.makedirs(OUT, exist_ok=True)

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

def write_icechunk(name, ds, encoding, group=None):
    path = os.path.join(OUT, name)
    # Icechunk writes new chunk and snapshot ids each time: keep what is
    # there unless asked (FIXTURES_FORCE=1)
    if os.path.exists(path) and not os.environ.get("FIXTURES_FORCE"):
        return
    repo = icechunk.Repository.create(icechunk.local_filesystem_storage(path))
    session = repo.writable_session("main")
    ds.to_zarr(session.store, group=group, mode="w", encoding=encoding, consolidated=False, zarr_format=3)
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
write_icechunk("era.icechunk", ds, {"2m_temperature": {"chunks": (1, 91, 180)}}, group="1x91x180")
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

# a Gaussian grid: 1D latitudes, not evenly spaced (CMIP6 T63-like, 96 x 192)
glat = np.degrees(np.arcsin(np.polynomial.legendre.leggauss(96)[0]))[::-1]
glon = np.arange(192) * 1.875
ds = xr.Dataset({"tas": (("time", "lat", "lon"), field(96, 192), {"units": "K"})},
                coords={"time": time, "lat": ("lat", glat, {"standard_name": "latitude", "units": "degrees_north"}),
                        "lon": ("lon", glon, {"standard_name": "longitude", "units": "degrees_east"})})
ds.to_zarr(os.path.join(OUT, "gaussian.zarr"), mode="w", encoding={"tas": {"chunks": (1, 48, 96)}}, consolidated=True, zarr_format=2)
stores.append({"name": "gaussian.zarr", "variable": "tas", "nx": 192, "ny": 96, "chunks": [1, 48, 96], "kind": "rectilinear", "lat": list(glat[:3]), "lon": list(glon[:3])})

# a curvilinear ocean grid as CMIP6 ships them: 1D x, y "projection"
# coordinates in degrees with no grid mapping, and 2D lat, lon per cell (here
# a rotated grid, so the true positions are known)
rot = pyproj.CRS.from_cf({"grid_mapping_name": "rotated_latitude_longitude", "grid_north_pole_longitude": 120.0, "grid_north_pole_latitude": 20.0})
cx = np.arange(-60, 60, 1.5) + 0.75; cy = np.arange(-40, 40, 1.5) + 0.75
RX, RY = np.meshgrid(cx, cy)
LON, LAT = pyproj.Transformer.from_crs(rot, "EPSG:4326", always_xy=True).transform(RX, RY)
ds = xr.Dataset({"tos": (("time", "y", "x"), field(len(cy), len(cx)), {"units": "degC", "coordinates": "lat lon"}),
                 "lat": (("y", "x"), LAT, {"standard_name": "latitude", "units": "degrees_north"}),
                 "lon": (("y", "x"), LON, {"standard_name": "longitude", "units": "degrees_east"})},
                coords={"time": time, "x": ("x", np.arange(len(cx)) * 1.0, {"standard_name": "projection_x_coordinate", "units": "degrees"}),
                        "y": ("y", np.arange(len(cy)) * 1.0, {"standard_name": "projection_y_coordinate", "units": "degrees"})})
ds.to_zarr(os.path.join(OUT, "curvilinear.zarr"), mode="w", encoding={"tos": {"chunks": (1, 27, 40)}}, consolidated=True, zarr_format=2)
# a cell corner, between four centres, and the centre of cell (3, 2)
corner = pyproj.Transformer.from_crs(rot, "EPSG:4326", always_xy=True).transform(cx[0] + 0.75, cy[0] + 0.75)
stores.append({"name": "curvilinear.zarr", "variable": "tos", "nx": len(cx), "ny": len(cy), "chunks": [1, 27, 40], "kind": "curvilinear",
               "centre32": [float(LON[2, 3]), float(LAT[2, 3])], "corner11": list(corner)})

# the same grid as NEMO names it: 2D gphit, glamt on (j, i), and no
# coordinates attribute to point at them
ds = xr.Dataset({"tos_con": (("time_counter", "j", "i"), field(len(cy), len(cx)), {"units": "degC"}),
                 "gphit": (("j", "i"), LAT.astype("float32"), {"units": "degrees_north"}),
                 "glamt": (("j", "i"), LON.astype("float32"), {"units": "degrees_east"})},
                coords={"j": ("j", np.arange(len(cy))), "i": ("i", np.arange(len(cx)))})
ds.to_zarr(os.path.join(OUT, "nemo.zarr"), mode="w", encoding={"tos_con": {"chunks": (1, 27, 40)}}, consolidated=True, zarr_format=2)
stores.append({"name": "nemo.zarr", "variable": "tos_con", "nx": len(cx), "ny": len(cy), "chunks": [1, 27, 40], "kind": "curvilinear", "tol": 1e-4,
               "centre32": [float(LON[2, 3]), float(LAT[2, 3])], "corner11": list(corner)})

# a GOES ABI fixed grid: scan angles in radians packed as int16 with
# scale_factor and add_offset, and a geostationary grid mapping
goes = {"grid_mapping_name": "geostationary", "perspective_point_height": 35786023.0, "semi_major_axis": 6378137.0,
        "semi_minor_axis": 6356752.31414, "longitude_of_projection_origin": -75.0, "latitude_of_projection_origin": 0.0,
        "sweep_angle_axis": "x"}
n, step = 60, 0.0025
ang = (np.arange(n) - (n - 1) / 2) * step
ds = xr.Dataset({"CMI": (("t", "y", "x"), field(n, n, 1), {"units": "K", "grid_mapping": "goes_imager_projection"}),
                 "goes_imager_projection": ((), np.int32(-2147483647), goes)},
                coords={"x": ("x", ang, {"units": "rad", "axis": "X", "standard_name": "projection_x_coordinate"}),
                        "y": ("y", ang[::-1].copy(), {"units": "rad", "axis": "Y", "standard_name": "projection_y_coordinate"})})
pack = lambda first, sign: {"dtype": "int16", "scale_factor": sign * step, "add_offset": first}
ds.to_zarr(os.path.join(OUT, "goes.zarr"), mode="w", consolidated=True, zarr_format=3,
           encoding={"CMI": {"chunks": (1, 30, 30)}, "x": pack(float(ang[0]), 1), "y": pack(float(ang[-1]), -1)})
gcrs = pyproj.CRS.from_cf(goes)
h = goes["perspective_point_height"]
stores.append({"name": "goes.zarr", "variable": "CMI", "nx": n, "ny": n, "chunks": [1, 30, 30],
               "x0": float((ang[0] - step / 2) * h), "dx": step * h, "y0": float((ang[-1] + step / 2) * h), "dy": -step * h,
               "corner": list(pyproj.Transformer.from_crs(gcrs, gcrs.geodetic_crs, always_xy=True).transform(ang[0] * h, ang[-1] * h))})

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
