# Reference points for test/check-regular.mjs, made with PROJ (via pyproj):
#   python3 test/make-regular-fixture.py > test/fixtures/regular-proj.json
# The cell centres of each example grid in js/regular.js (what its 2D lon/lat
# arrays hold), and geostationary scan angles on the unit sphere.
import json, math, pyproj

GOES_H, HIMA_H = 35786023, 35785863
HSTEP = (65536 / 20466275) * math.pi / 180
T = 1111950.5197665
MCELL = T / 2400
grids = [
    ("goes", f"+proj=geos +sweep=x +lon_0=-75 +h={GOES_H} +ellps=GRS80", 5424, 5424, -0.151844 * GOES_H, 56e-6 * GOES_H, 0.151844 * GOES_H, -56e-6 * GOES_H),
    ("himawari", f"+proj=geos +sweep=y +lon_0=140.7 +h={HIMA_H} +ellps=WGS84", 5500, 5500, -2749.5 * HSTEP * HIMA_H, HSTEP * HIMA_H, 2749.5 * HSTEP * HIMA_H, -HSTEP * HIMA_H),
    ("nsidc", "+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +a=6378273 +b=6356889.449", 304, 448, -3837500, 25000, 5837500, -25000),
    ("ease", "+proj=laea +lat_0=90 +lon_0=0 +ellps=WGS84", 720, 720, -8987500, 25000, 8987500, -25000),
    ("hrrr", "+proj=lcc +lat_1=38.5 +lat_2=38.5 +lat_0=38.5 +lon_0=-97.5 +R=6371229", 1799, 1059, None, 3000, None, 3000),
    ("cordex", "+proj=ob_tran +o_proj=longlat +o_lat_p=39.25 +o_lon_p=0 +lon_0=18 +R=1", 424, 412, -28.375, 0.11, -23.375, 0.11),
    ("modis", "+proj=sinu +lon_0=0 +R=6371007.181", 2400, 2400, -20015109.354 + 29 * T + MCELL / 2, MCELL, 10007554.677 - 12 * T - MCELL / 2, -MCELL),
]
out = {"source": "PROJ " + pyproj.proj_version_str, "grids": [], "geos": []}
for key, crs, ni, nj, x0, dx, y0, dy in grids:
    angular = "ob_tran" in crs
    src = pyproj.CRS(crs)
    ll = pyproj.CRS("+proj=longlat +R=1") if angular else src.geodetic_crs
    inv = pyproj.Transformer.from_crs(src, ll, always_xy=True)
    if x0 is None:
        x0, y0 = pyproj.Transformer.from_crs(ll, src, always_xy=True).transform(237.280472 - 360, 21.138123)
    pts = []
    for j in [0, nj // 7, nj // 3, nj // 2, (2 * nj) // 3, nj - 1]:
        for i in [0, ni // 5, ni // 2, (4 * ni) // 5, ni - 1]:
            lon, lat = inv.transform(x0 + i * dx, y0 + j * dy)
            if math.isfinite(lon) and math.isfinite(lat) and abs(lon) < 1e30:
                pts.append([i, j, round(lon, 10), round(lat, 10)])
    out["grids"].append({"key": key, "crs": crs, "pts": pts})

# scan angles to lon/lat on the unit sphere, both sweeps, as PROJ's geos does it
for sweep in ("x", "y"):
    rg = 6.6107
    t = pyproj.Transformer.from_crs(pyproj.CRS(f"+proj=geos +sweep={sweep} +h={rg - 1} +R=1 +lon_0=0"), pyproj.CRS("+proj=longlat +R=1"), always_xy=True)
    pts = []
    for ax in (-0.14, -0.08, 0, 0.05, 0.12):
        for ay in (-0.13, -0.02, 0.07, 0.1):
            lon, lat = t.transform(ax * (rg - 1), ay * (rg - 1))
            if math.isfinite(lon) and abs(lon) < 1e30:
                pts.append([ax, ay, round(lon, 10), round(lat, 10)])
    out["geos"].append({"sweep": sweep, "rg": rg, "pts": pts})
print(json.dumps(out))
