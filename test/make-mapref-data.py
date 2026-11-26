# data/tas-mapref.json: the Tasmanian street atlas (SA) and map book (MB) page frames and the
# street atlas squares, from theLIST (Land Tasmania) SearchService layers 5, 6 and 1
# (https://services.thelist.tas.gov.au/arcgis/rest/services/Public/SearchService/MapServer),
# as tabulated in GDA94 / MGA zone 55 (EPSG:28355) by the list-dump workflow of mdsumner/lunamap
# (data-mapref branch): tas-mapref-pages.csv and tas-sa-squares.csv.
#   python3 test/make-mapref-data.py path/to/tas-mapref > data/tas-mapref.json
# Corners are rounded to whole metres (the service's Web Mercator round trip leaves 0.01 m on a few).
# Map book squares are not stored: they are a 24 x 36 lattice of 500 m in each page.
# Licence: Creative Commons Attribution 3.0 Australia, "the LIST (c) State of Tasmania".
import csv, json, sys, os

d = sys.argv[1]
r = lambda v: int(round(float(v)))
pages = [[p["book"], p["ref"], int(p["page"]), p["suffix"], r(p["xmin"]), r(p["ymin"]), r(p["xmax"]), r(p["ymax"])]
         for p in csv.DictReader(open(os.path.join(d, "tas-mapref-pages.csv")))]
sq = []
for s in csv.DictReader(open(os.path.join(d, "tas-sa-squares.csv"))):
    x0, y0, x1, y1 = r(s["xmin"]), r(s["ymin"]), r(s["xmax"]), r(s["ymax"])
    row = [int(s["page"]), s["col"], int(s["row"]), x0, y1]
    if x1 - x0 != 500 or y1 - y0 != 500:
        row += [x1 - x0, y1 - y0]
    sq.append(row)
out = {
    "source": "theLIST (Land Tasmania) SearchService layers 5, 6, 1; GDA94 / MGA zone 55 (EPSG:28355)",
    "licence": "CC BY 3.0 AU, the LIST (c) State of Tasmania",
    "pages": "book, ref, page, suffix, xmin, ymin, xmax, ymax",
    "squares": "page, col, row, xmin, ymax[, width, height] (500 m unless given)",
    "page": pages, "sa": sq
}
print(json.dumps(out, separators=(",", ":")))
