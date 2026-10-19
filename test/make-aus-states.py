# data/aus-states-10m.json: Australia's states and territories from Natural
# Earth's 1:10m admin-1 boundaries (public domain), for vicgrid.html:
#   python3 test/make-aus-states.py ne_10m_admin_1_states_provinces.geojson > data/aus-states-10m.json
# from https://github.com/nvkelso/natural-earth-vector (geojson/). Each
# state is { name, abbr, rings }, each ring a flat [lon, lat, lon, lat, ...]
# array at 3 decimals (about 100 m), the format data.js's coastlines use.
import json, sys

ABBR = {"Victoria": "VIC", "New South Wales": "NSW", "South Australia": "SA", "Tasmania": "TAS", "Queensland": "QLD",
        "Western Australia": "WA", "Northern Territory": "NT", "Australian Capital Territory": "ACT", "Jervis Bay Territory": "JBT"}
d = json.load(open(sys.argv[1]))
out = []
for f in d["features"]:
    p = f["properties"]
    if p.get("adm0_a3") != "AUS" or p["name"] not in ABBR:
        continue
    g = f["geometry"]
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    rings = []
    for poly in polys:
        for ring in poly:
            flat = []
            for lon, lat in ring:
                flat += [round(lon, 3), round(lat, 3)]
            rings.append(flat)
    out.append({"name": p["name"], "abbr": ABBR[p["name"]], "rings": rings})
out.sort(key=lambda s: s["name"])
print(json.dumps(out, separators=(",", ":")))
