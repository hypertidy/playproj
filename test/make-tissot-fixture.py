# Reference distortion factors for test/check-tissot.mjs, from PROJ's own
# proj_factors() (via pyproj):
#   python3 test/make-tissot-fixture.py > test/fixtures/tissot-proj.json
# Spheres for the projections the Tissot page offers, and a few ellipsoids.
import json, pyproj

SPHERE = "+R=6371008.8"
CASES = [
    "+proj=merc", "+proj=eqc", "+proj=cea", "+proj=cea +lat_ts=45", "+proj=mill",
    "+proj=sinu", "+proj=moll", "+proj=robin", "+proj=eqearth",
    "+proj=stere +lat_0=90", "+proj=stere +lat_0=-40 +lon_0=140",
    "+proj=laea +lat_0=30 +lon_0=-60", "+proj=aeqd +lat_0=-90",
    "+proj=gnom +lat_0=20 +lon_0=10", "+proj=ortho +lat_0=45 +lon_0=0",
    "+proj=lcc +lat_1=30 +lat_2=60 +lon_0=10", "+proj=aea +lat_1=20 +lat_2=50 +lon_0=-100",
    "+proj=eqdc +lat_1=20 +lat_2=60", "+proj=tmerc +lon_0=147", "+proj=vandg", "+proj=bonne +lat_1=45",
]
ELLPS = [
    "+proj=merc +ellps=WGS84", "+proj=tmerc +lon_0=147 +k_0=0.9996 +ellps=GRS80",
    "+proj=lcc +lat_1=-36 +lat_2=-38 +lat_0=-37 +lon_0=145 +ellps=GRS80",
    "+proj=aea +lat_1=-18 +lat_2=-36 +lon_0=132 +ellps=GRS80",
    "+proj=laea +lat_0=52 +lon_0=10 +ellps=GRS80",
    "+proj=stere +lat_0=-90 +lat_ts=-71 +ellps=WGS84",
]
KEYS = ["meridional_scale", "parallel_scale", "areal_scale", "angular_distortion",
        "meridian_parallel_angle", "meridian_convergence", "tissot_semimajor", "tissot_semiminor",
        "dx_dlam", "dx_dphi", "dy_dlam", "dy_dphi"]

pts = [(lon, lat) for lon in range(-170, 180, 50) for lat in range(-85, 90, 17)] + [(0, 0), (35, 89.9)]
out = {"source": "PROJ " + pyproj.proj_version_str, "keys": KEYS, "cases": []}
for s, ell in [(c + " " + SPHERE, False) for c in CASES] + [(c, True) for c in ELLPS]:
    p = pyproj.Proj(s)
    rows = []
    for lon, lat in pts:
        f = p.get_factors(lon, lat, errcheck=False)
        v = [getattr(f, k) for k in KEYS]
        if all(x == x and abs(x) < 1e6 for x in v):
            # derivatives at full precision: part 1 of the check rebuilds the rest
            rows.append([lon, lat] + [round(x, 10) for x in v[:8]] + v[8:])
    out["cases"].append({"proj": s, "pts": rows})
print(json.dumps(out, separators=(",", ":")))
