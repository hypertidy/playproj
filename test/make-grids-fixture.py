# Reference points for test/check-grids.mjs, made with PROJ (via pyproj):
#   python3 test/make-grids-fixture.py > test/fixtures/grids-proj.json
# Rotated pole grids are ob_tran; the tripolar cap is a stereographic
# projection out of the second sphere and back in at a different scale.
import json, math, pyproj

def tr(src, dst):
    return pyproj.Transformer.from_crs(pyproj.CRS(src), pyproj.CRS(dst), always_xy=True)

LL = "+proj=longlat +R=1"
pts = [(lon, lat) for lon in range(-175, 180, 35) for lat in range(-85, 90, 17)]
out = {"source": "PROJ " + pyproj.proj_version_str, "obtran": [], "cap": []}

# CF poles: EURO-CORDEX, an Antarctic CORDEX-like pole, an arbitrary one, and Yang
for o_lat_p, o_lon_p, lon_0 in [(39.25, 0, 18), (-1.0, 0, 160), (60, 0, -45), (0, 90, -90)]:
    s = f"+proj=ob_tran +o_proj=longlat +o_lat_p={o_lat_p} +o_lon_p={o_lon_p} +lon_0={lon_0} +R=1"
    t = tr(LL, s)
    out["obtran"].append({"oLatP": o_lat_p, "oLonP": o_lon_p, "lon0": lon_0, "proj": s,
        "pts": [[lon, lat, *[round(v, 10) for v in t.transform(lon, lat)]] for lon, lat in pts]})

for join in (65, 50):
    R = math.tan(math.radians(90 - join) / 2)
    out_ = tr(LL, "+proj=stere +lat_0=90 +lon_0=0 +k_0=1 +R=1")
    back = tr("+proj=stere +lat_0=90 +lon_0=0 +k_0=%r +R=1" % (1 / R), LL)
    rows = []
    for lon, lat in pts:
        if lat < 0: continue
        x, y = out_.transform(lon, lat)
        rows.append([lon, lat, *[round(v, 10) for v in back.transform(x, y)]])
    out["cap"].append({"join": join, "pts": rows})

print(json.dumps(out))
