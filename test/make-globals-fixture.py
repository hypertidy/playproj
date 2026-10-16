# Reference points for test/check-globals.mjs, made with PROJ (via pyproj):
#   python3 test/make-globals-fixture.py > test/fixtures/globals-proj.json
# Whole-sphere maps and PROJ's interrupted ones, at two central meridians,
# and the gnomonic faces of the octahedral butterfly.
import json, math, pyproj

R = 6370997
pts = [(lon, lat) for lon in range(-175, 180, 35) for lat in range(-85, 90, 17)]
# extra points either side of the lobe cuts and the homolosine join
pts += [(lon + d, lat) for lon in (-100, -40, -20, 80, -90, 60, -60, 90) for d in (-0.5, 0.5) for lat in (-60, -30, 30, 60)]
pts += [(lon, lat) for lon in (-150, 10, 120) for lat in (40.5, 41, -40.5, -41, 89.9, -89.9)]
out = {"source": "PROJ " + pyproj.proj_version_str, "maps": [], "faces": []}

for name in ["moll", "goode", "sinu", "eck4", "eqearth", "robin", "natearth", "hammer", "wintri",
             "igh", "igh_o", "imoll", "imoll_o"]:
    for lon_0 in (0, 150):
        extra = " +lat_1=50.4597762521898" if name == "wintri" else ""
        s = f"+proj={name}{f' +lon_0={lon_0}' if lon_0 else ''}{extra} +R={R}"
        P = pyproj.Proj(s)
        rows = []
        for lon, lat in pts:
            x, y = P(lon, lat)
            if math.isfinite(x) and math.isfinite(y):
                rows.append([lon, lat, round(x, 4), round(y, 4)])
        out["maps"].append({"proj": name, "lon0": lon_0, "def": s, "pts": rows})

# butterfly faces: centres at +-35.26 latitude, 45 degrees east of each edge
lat_c = math.degrees(math.atan(1 / math.sqrt(2)))
for edge in (-20, 0):
    for lat_0 in (lat_c, -lat_c):
        for k in range(4):
            lon_0 = edge + 45 + 90 * k
            lon_0 = (lon_0 + 180) % 360 - 180
            s = f"+proj=gnom +lat_0={lat_0!r} +lon_0={lon_0} +x_0=0 +y_0=0 +R=1"
            P = pyproj.Proj(s)
            rows = []
            for i in range(9):
                for j in range(9):
                    lon = edge + 90 * k + 1 + 88 * i / 8
                    lat = (1 + 88 * j / 8) * (1 if lat_0 > 0 else -1)
                    lon = (lon + 180) % 360 - 180
                    x, y = P(lon, lat)
                    rows.append([lon, lat, round(x, 10), round(y, 10)])
            out["faces"].append({"edge": edge, "k": k, "north": lat_0 > 0, "def": s, "pts": rows})

print(json.dumps(out))
