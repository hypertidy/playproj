# data/australia-10m.json: Australia, its external territories and the
# Australian Antarctic Territory, and the land around them, for
# australia.html. The mainland, the AAT and the other land are Natural
# Earth's 1:10m admin-0 map units (public domain); Tasmania and the islands
# are GSHHG 2.3.7 at full resolution (Wessel and Smith, LGPL), from its GMT
# binned file; the three station regions are OpenStreetMap land polygons
# (OpenStreetMap contributors, ODbL) as simonepri/geo-maps v0.6.0 builds
# them, because GSHHG's Antarctic ice front puts Davis 10 km and Casey 3 km
# out to sea while OpenStreetMap has all three within 300 m of its coast:
#   python3 test/make-australia-data.py ne_10m_admin_0_map_units.geojson binned_GSHHS_f.nc earth-coastlines-10m.geo.json > data/australia-10m.json
# Natural Earth from https://github.com/nvkelso/natural-earth-vector
# (geojson/); binned_GSHHS_f.nc from the conda-forge gshhg-gmt package or
# https://www.soest.hawaii.edu/pwessel/gshhg/. Needs shapely, numpy and
# netCDF4. earth-coastlines-10m.geo.json is a release asset of
# https://github.com/simonepri/geo-maps. Pieces are lists of flat [lon, lat, ...] rings, at 3 decimals
# from Natural Earth and 4 from GSHHG. "regions" holds the lon/lat box of
# each station region and "coast" its coastline without the box's edges,
# to stroke.
# The AAT is Antarctica between 45 E and 160 E less Adelie Land (136 11' E
# to 142 02' E), south of 60 S, as the Australian Antarctic Territory
# Act 1954 and the 1933 Order in Council have it.
import json, sys
import numpy as np
import netCDF4
from shapely.geometry import shape, box, Polygon, LineString
from shapely.ops import unary_union, polygonize, linemerge

# key: (Natural Earth units, boxes, source). "ne" pieces are Natural
# Earth polygons with a point in a box; "gshhg" pieces are GSHHG land in
# the boxes; "near" is GSHHG land within 0.35 degrees of the reefs in
# REEFS (a box for the Coral Sea Islands would take in the Great Barrier
# Reef);
# "region" is OpenStreetMap land cut to the box (the stations).
PIECES = {
    "mainland": (["AUS"], [[112, -39.2, 154, -9.5]], "ne"),
    "tasmania": (["AUS"], [[143.5, -44, 149, -39.4]], "gshhg"),
    "macquarie": (["AUS"], [[158.5, -55, 159.2, -54.3]], "gshhg"),
    "lordhowe": (["AUS"], [[158.9, -31.9, 159.4, -31.4]], "gshhg"),
    "norfolk": (["NFK"], [[167.8, -29.2, 168.1, -28.9]], "gshhg"),
    "christmas": (["CXR"], [[105.4, -10.7, 105.8, -10.3]], "gshhg"),
    "cocos": (["CCK"], [[96.7, -12.3, 97, -11.7]], "gshhg"),
    "ashmore": (["ATC"], [[122.8, -12.6, 123.7, -12]], "near"),
    "coralsea": (["CSI"], [[145, -24, 160, -10]], "near"),
    "heard": (["HMD"], [[72, -53.3, 74, -52.8]], "gshhg"),
    "mawson": (["ATA"], [[61.57, -68.05, 64.17, -67.15]], "region"),
    "davis": (["ATA"], [[76.67, -69.03, 79.27, -68.13]], "region"),
    "casey": (["ATA"], [[109.23, -66.73, 111.83, -65.83]], "region"),
}
REEFS = {
    "ashmore": [(123.0, -12.25), (123.55, -12.53)],
    "coralsea": [(146.6, -13.9), (147.1, -15.5), (147.9, -16.5), (149.96, -16.29), (150.3, -16.55),
                 (150.0, -16.95), (149.2, -16.95), (151.0, -17.45), (151.8, -17.3), (155.86, -17.4),
                 (152.3, -19.1), (152.0, -21.0), (153.6, -21.8), (155.8, -21.2), (155.85, -22.2),
                 (155.55, -23.25)],
}
AAT = [box(45, -90, 136.1833, -60), box(142.0333, -90, 160, -60)]

# GSHHG's GMT binned file: the world in 1 degree bins (for full
# resolution), each with coastline segments cut at its edges, points as
# 16 bit offsets from the bin's south-west corner. Segment info packs
# npts << 9 | level << 6 | exit << 3 | entry; entry 4 means the segment is
# a whole polygon inside the bin. Level 1 is land (for Antarctica, the ice
# front); 6 is the Antarctic grounding line, left out here, as are lakes.
G = netCDF4.Dataset(sys.argv[2])
G.set_auto_mask(False)  # else offsets equal to the short fill value come back masked
GV = {k: G.variables[k][:] for k in ["Id_of_first_segment_in_a_bin", "N_segments_in_a_bin",
      "Embedded_npts_levels_exit_entry_for_a_segment", "Id_of_first_point_in_a_segment"]}
BS = int(G.variables["Bin_size_in_minutes"][0]) / 60.0
NX = int(G.variables["N_bins_in_360_longitude_range"][0])
RX = G.variables["Relative_longitude_from_SW_corner_of_bin"][:].astype(np.int32) & 0xFFFF
RY = G.variables["Relative_latitude_from_SW_corner_of_bin"][:].astype(np.int32) & 0xFFFF

def bin_segments(lon, lat):
    b = int(np.floor((90 - lat) / BS)) * NX + int(np.floor((lon % 360) / BS))
    x0 = (b % NX) * BS; y0 = 90 - (b // NX + 1) * BS
    s0 = int(GV["Id_of_first_segment_in_a_bin"][b]); out = []
    for s in range(s0, s0 + int(GV["N_segments_in_a_bin"][b])):
        info = int(GV["Embedded_npts_levels_exit_entry_for_a_segment"][s])
        n, level, entry = info >> 9, (info >> 6) & 7, info & 7
        p = int(GV["Id_of_first_point_in_a_segment"][s])
        xy = np.c_[x0 + RX[p:p + n] * BS / 65535.0, y0 + RY[p:p + n] * BS / 65535.0]
        if x0 > 180:
            xy[:, 0] -= 360
        out.append((level, entry == 4, xy))
    return box(*(x0 - 360 if x0 > 180 else x0, y0, (x0 - 360 if x0 > 180 else x0) + BS, y0 + BS)), out

# GSHHG land in a lon/lat box: segments and bin edges polygonized into
# faces; a face inside a whole polygon is land, and a face that meets a bin
# edge is land when most of it is land in `ref` (Natural Earth), which only
# has to tell land from sea a bin at a time.
def gshhg_land(b, ref):
    x0, y0, x1, y1 = b
    lines, closed = [], []
    for la in np.arange(np.floor(y0), np.ceil(y1), BS):
        for lo in np.arange(np.floor(x0), np.ceil(x1), BS):
            edge, segs = bin_segments(lo + BS / 2, la + BS / 2)
            lines.append(edge.exterior)
            for level, whole, xy in segs:
                if level != 1 or len(xy) < 2:
                    continue
                if whole and len(xy) >= 4:
                    closed.append(Polygon(xy))
                lines.append(LineString(xy))
    keep = []
    for f in polygonize(unary_union(lines)):
        rp = f.representative_point()
        if any(c.contains(rp) for c in closed) or f.intersection(ref).area > 0.5 * f.area:
            keep.append(f)
    return unary_union(keep).intersection(box(*b))

# OpenStreetMap land in a lon/lat box (some polygons need buffer(0))
osm = [shape(g) for g in json.load(open(sys.argv[3]))["geometries"]]
def osm_land(b):
    bb, parts = box(*b), []
    for g in osm:
        if not g.intersects(bb):
            continue
        for p in (g.geoms if hasattr(g, "geoms") else [g]):
            if p.intersects(bb):
                parts.append(p.buffer(0).intersection(bb))
    return unary_union(parts)

src = json.load(open(sys.argv[1]))
units = {}
for f in src["features"]:
    units.setdefault(f["properties"]["GU_A3"], []).append(shape(f["geometry"]))

def polys(g):
    return list(g.geoms) if hasattr(g, "geoms") else [g]

def flat(poly, tol, dp=3):
    out = []
    for p in polys(poly.simplify(tol, preserve_topology=True)):
        if p.is_empty or not isinstance(p, Polygon):
            continue
        for ring in [p.exterior] + list(p.interiors):
            xy = []
            for lon, lat in list(ring.coords)[:-1]:
                xy += [round(lon, dp), round(lat, dp)]
            if len(xy) >= 6:
                out.append(xy)
    return out

def flat_line(line, dp=4):
    out = []
    for l in (line.geoms if hasattr(line, "geoms") else [line]):
        if l.geom_type != "LineString" or len(l.coords) < 2:
            continue
        xy = []
        for lon, lat in l.coords:
            xy += [round(lon, dp), round(lat, dp)]
        out.append(xy)
    return out

def inside(pt, boxes):
    return any(b[0] <= pt.x <= b[2] and b[1] <= pt.y <= b[3] for b in boxes)

pieces, coast, regions = {}, {}, {}
for key, (us, boxes, how) in PIECES.items():
    ne = [p for u in us for g in units[u] for p in polys(g) if inside(p.representative_point(), boxes)]
    ref = unary_union([g for u in us for g in units[u]]).buffer(0)
    dp = 3
    if how == "ne":
        sel = ne
    elif how == "near":
        dp = 4
        sel = []
        for lon, lat in REEFS[key]:
            r = 0.35
            land = gshhg_land((lon - r, lat - r, lon + r, lat + r), ref)
            sel += [q for q in polys(land) if isinstance(q, Polygon)]
        sel = polys(unary_union(sel)) if sel else []
    elif how == "region":
        dp = 4
        sel = [q for b in boxes for q in polys(osm_land(b)) if isinstance(q, Polygon)]
    else:
        dp = 4
        sel = [q for b in boxes for q in polys(gshhg_land(b, ref)) if isinstance(q, Polygon)]
        if how == "gshhg":
            sel = [q for q in sel if inside(q.representative_point(), boxes)]
    if not sel:
        sys.exit(f"no land for {key}")
    x0 = min(p.bounds[0] for p in sel); x1 = max(p.bounds[2] for p in sel)
    y0 = min(p.bounds[1] for p in sel); y1 = max(p.bounds[3] for p in sel)
    span = max(x1 - x0, y1 - y0)
    tol = max(0.001, min(0.02, span / 1500)) if how == "ne" else max(0.0001, span / 4000)
    rings = []
    for p in sel:
        if p.area > (3 * tol) ** 2 or len(sel) < 40:
            rings += flat(p, tol, dp)
    pieces[key] = rings
    if how == "region":
        # the coastline alone: the land's edge less the box's edges
        u = unary_union([p.simplify(tol, preserve_topology=True) for p in sel])
        edge = box(*boxes[0]).exterior.buffer(1e-6)
        coast[key] = flat_line(linemerge(u.boundary.difference(edge)))
        regions[key] = boxes[0]

ata = unary_union(units["ATA"])
aat = ata.intersection(unary_union(AAT))
pieces["aat"] = [r for p in polys(aat) if p.area > 0.05 for r in flat(p, 0.02)]

clip = box(30, -90, 180, 10)
OWN = {"AUS", "NFK", "CXR", "CCK", "ATC", "CSI", "HMD"}
context = []
for u, gs in units.items():
    if u in OWN:
        continue
    g = unary_union(gs).intersection(clip)
    if g.is_empty:
        continue
    r = [x for p in polys(g) if isinstance(p, Polygon) and p.area > 0.02 for x in flat(p, 0.04)]
    if r:
        context.append({"unit": u, "rings": r})

print(json.dumps({"pieces": pieces, "coast": coast, "regions": regions, "context": context}, separators=(",", ":")))
