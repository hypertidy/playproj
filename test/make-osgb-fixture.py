# Reference values for test/check-osgb.mjs, made with PROJ (via pyproj):
#   PROJ_DATA=<dir holding uk_os_OSTN15_NTv2_OSGBtoETRS.tif> \
#     python3 test/make-osgb-fixture.py > test/fixtures/osgb-proj.json
# National Grid eastings, northings, point scale and convergence from
# OSGB36 longitude and latitude (EPSG:4277 to EPSG:27700), the Ordnance
# Survey Helmert shift from WGS84 as a PROJ pipeline, and the OSTN15 grid
# shift for the same points (to show how far the Helmert is from it).
# The OSTN15 grid is in PROJ-data (uk_os/), on raw.githubusercontent.com.
import json, os, random, pyproj

if os.environ.get("PROJ_DATA"):
    pyproj.datadir.append_data_dir(os.environ["PROJ_DATA"])

rnd = random.Random(27700)
pts = [(-0.0015, 51.4779), (-0.001475, 51.477811), (-3.1883, 55.9533), (-5.7155, 50.0663), (-1.2577, 60.3)]
pts += [(rnd.uniform(-7.5, 1.7), rnd.uniform(50.0, 60.8)) for _ in range(80)]
proj = pyproj.Proj(27700)
helmert = pyproj.Transformer.from_pipeline(
    "+proj=pipeline +step +proj=axisswap +order=2,1 +step +proj=unitconvert +xy_in=deg +xy_out=rad "
    "+step +proj=push +v_3 +step +proj=cart +ellps=WGS84 "
    "+step +proj=helmert +x=-446.448 +y=125.157 +z=-542.06 +rx=-0.1502 +ry=-0.247 +rz=-0.8421 +s=20.4894 +convention=position_vector "
    "+step +inv +proj=cart +ellps=airy +step +proj=pop +v_3 "
    "+step +proj=unitconvert +xy_in=rad +xy_out=deg +step +proj=axisswap +order=2,1")
ostn = pyproj.Transformer.from_pipeline(
    "+proj=pipeline +step +proj=axisswap +order=2,1 +step +proj=unitconvert +xy_in=deg +xy_out=rad "
    "+step +inv +proj=hgridshift +grids=uk_os_OSTN15_NTv2_OSGBtoETRS.tif "
    "+step +proj=unitconvert +xy_in=rad +xy_out=deg +step +proj=axisswap +order=2,1")
out = {"source": "PROJ " + pyproj.proj_version_str, "points": []}
for lon, lat in pts:
    e, n = proj(lon, lat)
    f = proj.get_factors(lon, lat)
    lat_h, lon_h = helmert.transform(lat, lon)
    lat_o, lon_o = ostn.transform(lat, lon)
    eo, no = proj(lon_o, lat_o)
    out["points"].append({"ll": [lon, lat], "e": e, "n": n, "k": f.meridional_scale, "conv": f.meridian_convergence,
                          "helmert": [lon_h, lat_h], "ostn": [eo, no]})
t = pyproj.Transformer.from_crs(27700, 4277, always_xy=True)
out["falseOrigin"] = list(t.transform(0, 0))
out["trueOrigin"] = list(t.transform(400000, -100000))
print(json.dumps(out))
