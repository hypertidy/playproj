# Writes the fixture test/check-heldrefs.mjs reads: a small virtual Icechunk
# repository shaped like an ocean model's output (time, depth, y, x), whose
# chunks of temp are byte ranges into one file beside it.
#
#  held/ocean.bin       the encoded chunks, one after another
#  held/ocean.icechunk  the repository: coordinates held, temp virtual
#  held/ocean.json      where each chunk is, and the values to expect
#
# The refs name the file at LOCATION, an address that does not exist: the
# test maps it to its own server, as a page would map it to where the file is.
#
#   python3 -m pip install xarray zarr icechunk
#   python3 test/make-held-fixture.py

import json, os, shutil, tempfile
import numpy as np
import xarray as xr
import icechunk

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "fixtures", "held")
LOCATION = "https://held.invalid/ocean.bin"
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT)

nt, nz, ny, nx = 6, 4, 8, 12
chunks = (1, 2, 4, 6)
t, z, j, i = np.meshgrid(np.arange(nt), np.arange(nz), np.arange(ny), np.arange(nx), indexing="ij")
temp = (20 - 4 * z + 0.5 * t + np.sin(i / 2.0) + np.cos(j / 3.0)).astype("float32")
# land: the deepest levels have no value toward one side
temp[:, 2:, :, :3] = np.nan
temp[:, 3:, :, :6] = np.nan
ds = xr.Dataset(
    {"temp": (("time", "st_ocean", "yt_ocean", "xt_ocean"), temp, {"units": "degrees C", "long_name": "Potential temperature"})},
    coords={
        "time": ("time", np.arange(nt, dtype="float64") * 30 + 15, {"units": "days since 2000-01-01", "calendar": "noleap"}),
        "st_ocean": ("st_ocean", np.array([5.0, 50.0, 500.0, 3000.0]), {"units": "meters", "positive": "down", "axis": "Z"}),
        "yt_ocean": ("yt_ocean", -70.0 + 10 * np.arange(ny), {"units": "degrees_north", "axis": "Y"}),
        "xt_ocean": ("xt_ocean", -55.0 + 10 * np.arange(nx), {"units": "degrees_east", "axis": "X"}),
    })
encoding = {"temp": {"chunks": chunks}}

# the chunks as plain Zarr writes them, joined into one file
tmp = tempfile.mkdtemp()
ds.to_zarr(tmp, mode="w", consolidated=False, zarr_format=3, encoding=encoding)
refs, blob = [], b""
root = os.path.join(tmp, "temp", "c")
for dirpath, _, files in sorted(os.walk(root)):
    for f in sorted(files):
        p = os.path.join(dirpath, f)
        key = os.path.relpath(p, root).replace(os.sep, "/")
        data = open(p, "rb").read()
        # a gap before each chunk, as a real file has between its chunks
        blob += b"\0" * 7
        refs.append({"key": key, "offset": len(blob), "size": len(data)})
        blob += data
open(os.path.join(OUT, "ocean.bin"), "wb").write(blob)
shutil.rmtree(tmp)

config = icechunk.RepositoryConfig.default()
config.set_virtual_chunk_container(icechunk.VirtualChunkContainer("https://held.invalid/", icechunk.http_store()))
repo = icechunk.Repository.create(icechunk.local_filesystem_storage(os.path.join(OUT, "ocean.icechunk")), config=config)
session = repo.writable_session("main")
ds.to_zarr(session.store, mode="w", consolidated=False, zarr_format=3, encoding=encoding)
for r in refs:
    session.store.set_virtual_ref("temp/c/" + r["key"], LOCATION, offset=r["offset"], length=r["size"], validate_container=False)
session.commit("fixture: temp as byte ranges into ocean.bin")

json.dump({"location": LOCATION, "variable": "temp", "shape": [nt, nz, ny, nx], "chunks": list(chunks), "refs": refs,
           "values": [[None if np.isnan(v) else float(v) for v in temp[t_, :, 3, 7]] for t_ in range(nt)],
           "column": [3, 7]}, open(os.path.join(OUT, "ocean.json"), "w"), indent=1)
print("wrote", len(refs), "refs into", len(blob), "bytes")
