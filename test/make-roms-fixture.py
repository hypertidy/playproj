# Writes a small ROMS-style grid as Zarr v2 (zlib) and v3 (gzip) for
# test/check-roms.mjs, and depths of the s-coordinate from a NumPy port of
# ROMS set_scoord.F / set_depth.F, so the JavaScript is checked against an
# independent implementation.
#
#   python3 -m pip install zarr numpy numcodecs
#   python3 test/make-roms-fixture.py

import json, os, shutil
import numpy as np
import zarr
import numcodecs

OUT = os.path.join(os.path.dirname(__file__), "fixtures", "roms")
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT)

# ------------------------------------------------------------- set_scoord.F

def cs(s, Vstretching, theta_s, theta_b):
    s = np.asarray(s, dtype=float)
    if Vstretching == 1:
        if theta_s > 0:
            ptheta = np.sinh(theta_s * s) / np.sinh(theta_s)
            rtheta = np.tanh(theta_s * (s + 0.5)) / (2.0 * np.tanh(0.5 * theta_s)) - 0.5
            return (1.0 - theta_b) * ptheta + theta_b * rtheta
        return s
    if Vstretching == 2:
        Aweight, Bweight = 1.0, 1.0
        if theta_s > 0:
            Csur = (1.0 - np.cosh(theta_s * s)) / (np.cosh(theta_s) - 1.0)
            if theta_b > 0:
                Cbot = -1.0 + np.sinh(theta_b * (s + 1.0)) / np.sinh(theta_b)
                Cweight = (s + 1.0) ** Aweight * (1.0 + (Aweight / Bweight) * (1.0 - (s + 1.0) ** Bweight))
                return Cweight * Csur + (1.0 - Cweight) * Cbot
            return Csur
        return s
    if Vstretching == 4:
        if theta_s > 0:
            Csur = (1.0 - np.cosh(theta_s * s)) / (np.cosh(theta_s) - 1.0)
        else:
            Csur = -s ** 2
        if theta_b > 0:
            return (np.exp(theta_b * Csur) - 1.0) / (1.0 - np.exp(-theta_b))
        return Csur
    raise ValueError(Vstretching)

def z_w(h, N, Vtransform, Vstretching, theta_s, theta_b, hc, zeta=0.0):
    k = np.arange(N + 1)
    s = (k - N) / N
    C = cs(s, Vstretching, theta_s, theta_b)
    if Vtransform == 1:
        z0 = hc * s + (h - hc) * C
        return z0 + zeta * (1.0 + z0 / h)
    z0 = (hc * s + h * C) / (hc + h)
    return zeta + (zeta + h) * z0

cases = []
for vt, vs, ts, tb, hc in [(2, 4, 7.0, 2.0, 250.0), (2, 4, 0.0, 0.0, 10.0), (1, 1, 5.0, 0.4, 10.0),
                           (2, 2, 6.0, 1.5, 100.0), (1, 4, 3.0, 1.0, 5.0), (2, 1, 3.0, 0.0, 50.0)]:
    for h, zeta in [(12.0, 0.0), (150.0, 0.0), (1000.0, 0.5), (5300.0, -0.3)]:
        N = 20
        cases.append({"vt": vt, "vs": vs, "ts": ts, "tb": tb, "hc": hc, "N": N, "h": h, "zeta": zeta,
                      "z_w": z_w(h, N, vt, vs, ts, tb, hc, zeta).tolist()})

# ------------------------------------------------------------- a grid file

ny, nx = 17, 23
jj, ii = np.mgrid[0:ny, 0:nx]
lon = 140.0 + 0.5 * ii + 0.1 * jj
lat = -45.0 + 0.4 * jj - 0.05 * ii
h = 20.0 + 37.5 * ii + 11.0 * jj
mask = ((ii + jj) % 7 != 0).astype("f8")
vert = {"Vtransform": 2, "Vstretching": 4, "theta_s": 6.5, "theta_b": 1.5, "hc": 200.0}
N = 15

def write(path, fmt):
    g = zarr.open_group(path, mode="w", zarr_format=fmt)
    if fmt == 2:
        kw = dict(compressor=numcodecs.Zlib(level=5))
    else:
        kw = dict(compressors=[zarr.codecs.GzipCodec(level=5)])
    for name, arr in [("lon_rho", lon), ("lat_rho", lat), ("h", h), ("mask_rho", mask)]:
        a = g.create_array(name, shape=arr.shape, chunks=(8, 8), dtype="f8", **kw)
        a[:] = arr
    for name, val in vert.items():
        dt = "i4" if name.startswith("V") else "f8"
        a = g.create_array(name, shape=(), dtype=dt, **kw)
        a[...] = val
    a = g.create_array("s_rho", shape=(N,), chunks=(N,), dtype="f4", **kw)
    a[:] = ((np.arange(1, N + 1) - N - 0.5) / N).astype("f4")

write(os.path.join(OUT, "grid-v2.zarr"), 2)
write(os.path.join(OUT, "grid-v3.zarr"), 3)

samples = [[j, i, lon[j, i], lat[j, i], h[j, i], mask[j, i]] for j, i in [(0, 0), (0, 22), (16, 0), (16, 22), (8, 9), (9, 15)]]
with open(os.path.join(OUT, "manifest.json"), "w") as f:
    json.dump({"depth": cases, "grid": {"shape": [ny, nx], "N": N, "vertical": vert, "samples": samples}}, f, indent=1)
print("wrote", OUT)
