# shallows

Prototype two-dimensional shallow water (Saint-Venant) solver for R, on
regular grids read from GDAL rasters. The question behind it: how much real
physical simulation can we do from R? Answer so far: a validated,
well-balanced, mass-conserving finite volume solver with wetting and drying
is about 400 lines of C++ behind an Rcpp interface, and it runs a
40 minute storm over 90,000 cells of real terrain in about three minutes on
four cores.

This lives in a playproj branch while it is a prototype; it is a
self-contained R package (`R CMD INSTALL shallows`).

## What it solves

    h_t + (hu)_x + (hv)_y = R
    (hu)_t + (hu^2 + g h^2 / 2)_x + (huv)_y = -g h z_x - g n^2 u |u| / h^(1/3)
    (hv)_t + (huv)_x + (hv^2 + g h^2 / 2)_y = -g h z_y - g n^2 v |u| / h^(1/3)

depth `h`, velocity `(u, v)`, bed `z`, rain `R`, Manning `n`.

* Finite volume on the raster grid; HLL approximate Riemann solver.
* Hydrostatic reconstruction (Audusse, Bouchut, Bristeau, Klein and
  Perthame 2004): a lake at rest stays at rest to round-off, including
  around dry islands, and depth stays non-negative, so cells wet and dry
  without special cases. This is the scheme family used by FullSWOF.
* `order = 1`: piecewise constant, forward Euler. `order = 2`: MUSCL with
  minmod on `h`, `u`, `v` and `h + z`, the centred bed source term, Heun
  (SSP-RK2) in time.
* Kurganov-Petrova velocity desingularisation for very thin films.
* Time step from the CFL condition plus a bed-slope acceleration term, so
  thin films on steep slopes cannot overshoot (without it the depth clipping
  diagnostic shows mass being created on real terrain).
* Semi-implicit Manning friction; rain as a source; each edge "wall" or
  "open".
* Bookkeeping: every run reports volume, cumulative rain, cumulative flux
  through the edges, the mass budget error and any depth clipping. On the
  real DEM the budget closes to about 1e-12 relative and clipping is zero.
* OpenMP across rows and columns of the flux sweeps.
* `sw_run_r()` is the same first-order scheme in plain vectorised R, as
  readable documentation and a cross-check (the C++ kernel matches it to
  1e-16).

## Validation

`inst/examples/validation.R` writes `validation.png` and `validation.csv`.

| test | what it checks | result |
|---|---|---|
| Stoker dam break (wet bed) | shock speed and middle state | L1 depth error 0.0067 m at 800 cells (order 2); about first order convergence, as expected with a shock |
| Ritter dam break (dry bed) | wet/dry front on a flat bed | 0.0064 m at 800 cells (order 2) |
| Lake at rest with islands | well balancing | surface and momentum stay at 1e-16 |
| Thacker planar surface in a paraboloid (moving shoreline, 3 periods) | wetting and drying over time | relative L1 depth error 0.13, 0.036, 0.011 at 50, 100, 200 cells (order 2, rate about 1.8); first order is much worse (0.33 at 200) |
| x vs y sweep | transposed problem gives transposed answer | exact |
| mass budget | all of the above, plus rain with open edges | relative error below 1e-11 everywhere |

`tests/testthat` runs reduced versions of these.

## Real terrain: rain on McRobies Gully

`inst/examples/mcrobies-storm.R` reads a 1.2 km square of the Tasmania 2 m
DEM (source.coop COG, EPSG:28355) through GDAL `/vsicurl/`, aggregates it to
4 m, rains 60 mm/h on it for 30 minutes, then lets it drain for 10. It
writes the depth at every minute as a multi-layer GeoTIFF with the DEM's CRS
and extent, the maximum depth, speeds, and the water budget.

For illustration only: not survey, engineering or planning data. The bed is
bare terrain with uniform roughness, no infiltration, no drains or culverts,
so water ponds behind road fill that in reality has pipes through it.

## Survey: shallow water from R

* **In R**: `rivr` (CRAN) does 1D gradually varied and unsteady open
  channel flow (MacCormack and method of characteristics) for prismatic
  channels. A search found no CRAN package for 2D shallow water over
  terrain; hydrodynamics in R usually means writing inputs for an external
  engine and reading its rasters back.
* **External engines R can drive** (write inputs, run, read outputs):
  LISFLOOD-FP (C++, local inertial approximation, widely used for flood
  inundation), FullSWOF (C++, same hydrostatic reconstruction family as
  here), ANUGA (Python, unstructured triangles, reachable through
  reticulate), Clawpack/GeoClaw (Fortran/Python, adaptive refinement,
  tsunamis and storm surge), Basilisk (C, adaptive quadtrees), TELEMAC-2D,
  HEC-RAS 2D (closed source), and GPU codes such as TRITON and SERGHEI.
  Python's landlab has an overland flow component (de Almeida inertial
  scheme).
* **What this adds**: no external binary, grids straight from terra/GDAL
  with CRS kept, results back as rasters, a budget on every run, and code
  small enough to read and extend.

## Limits and next steps

* Cartesian grid in a projected CRS only. Ocean scales (tsunami, tide,
  seiches in a basin on GEBCO) need Coriolis and spherical metric terms; both
  are small additions to this scheme.
* Explicit time stepping: steps are set by the fastest, deepest water, so a
  2 m grid costs about eight times a 4 m grid per simulated minute.
* No infiltration (Green-Ampt would be next), no land-cover roughness map
  (the solver already takes a Manning matrix), no inflow hydrograph boundary.
* Outputs are matrices and SpatRasters; writing them as meshcore surfaces or
  streaming frames to the browser viewer are natural next steps.

## References

* Audusse, E., Bouchut, F., Bristeau, M.-O., Klein, R. and Perthame, B.
  (2004). A fast and stable well-balanced scheme with hydrostatic
  reconstruction for shallow water flows. SIAM J. Sci. Comput. 25,
  2050-2065.
* Kurganov, A. and Petrova, G. (2007). A second-order well-balanced
  positivity preserving central-upwind scheme for the Saint-Venant system.
  Commun. Math. Sci. 5, 133-160.
* Thacker, W. C. (1981). Some exact solutions to the nonlinear shallow-water
  wave equations. J. Fluid Mech. 107, 499-508.
* Delestre, O. et al. (2013). SWASHES: a compilation of shallow water
  analytic solutions for hydraulic and environmental studies. Int. J.
  Numer. Meth. Fluids 72, 269-300.
* Delestre, O., Darboux, F., James, F., Lucas, C., Laguerre, C. and
  Cordier, S. (2017). FullSWOF: full shallow-water equations for overland
  flow. J. Open Source Softw. 2(20), 448.

## Browser viewer

`../shallows.html` (with `../src/core/shallows.js`) runs the same scheme in the
browser, ported line for line from `src/swe.cpp`, with depth, speed, water
budget, probe and section views, on McRobies Gully terrain and the analytic
benchmarks. `../test/check-shallows.mjs` checks the port.
