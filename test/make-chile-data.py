# data/chile-50m.json: Chile and its neighbours from Natural Earth's 1:50m
# admin-0 countries (public domain), for chile.html:
#   python3 test/make-chile-data.py ne_50m_admin_0_countries.geojson > data/chile-50m.json
# from https://github.com/nvkelso/natural-earth-vector (geojson/). Each
# country is { name, abbr, rings }, each ring a flat [lon, lat, lon, lat, ...]
# array at 3 decimals (about 100 m), the format of data/aus-states-10m.json.
# Only rings east of 82 W are kept: mainland Chile and the islands near it,
# not Easter Island (on its own UTM zone 12S) or Sala y Gomez.
import json, sys

KEEP = {"CHL": "Chile", "ARG": "Argentina", "BOL": "Bolivia", "PER": "Peru", "FLK": "Falkland Islands"}
d = json.load(open(sys.argv[1]))
out = []
for f in d["features"]:
    p = f["properties"]
    a3 = p.get("ADM0_A3")
    if a3 not in KEEP:
        continue
    g = f["geometry"]
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    rings = []
    for poly in polys:
        for ring in poly:
            if max(lon for lon, lat in ring) < -82:
                continue
            flat = []
            for lon, lat in ring:
                flat += [round(lon, 3), round(lat, 3)]
            rings.append(flat)
    out.append({"name": KEEP[a3], "abbr": a3, "rings": rings})
out.sort(key=lambda s: s["abbr"] != "CHL")
print(json.dumps(out, separators=(",", ":")))
