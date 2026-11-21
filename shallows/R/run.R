#' Set up a shallow water state on a grid
#'
#' Matrices are oriented like a raster: row 1 is the top (north) edge,
#' column 1 is the west edge. `hv` is momentum towards increasing row
#' number (southward on a north-up raster).
#'
#' @param z bed elevation matrix (m)
#' @param h initial depth (m), matrix or scalar; or give `eta`
#' @param eta optional initial water surface elevation; depth is
#'   `pmax(eta - z, 0)`
#' @param hu,hv initial momentum (m^2/s), matrix or scalar
#' @param dx,dy cell size (m)
#' @param manning Manning n (s m^-1/3), matrix or scalar, 0 for frictionless
#' @param rain rain rate (m/s), matrix or scalar
#' @param f Coriolis parameter (1/s), matrix or scalar; 0 for no rotation.
#'   Positive in the northern hemisphere, negative in the southern; see
#'   [sw_coriolis()]
#' @param g gravity (m/s^2)
#' @param extent,crs optional georeferencing carried through to output
#' @useDynLib shallows, .registration = TRUE
#' @importFrom Rcpp evalCpp
#' @export
sw_state <- function(z, h = 0, eta = NULL, hu = 0, hv = 0, dx = 1, dy = dx,
                     manning = 0, rain = 0, f = 0, g = 9.81,
                     extent = NULL, crs = NULL) {
  z <- as.matrix(z)
  storage.mode(z) <- "double"
  if (anyNA(z)) stop("bed 'z' has missing values; fill or mask them first")
  full <- function(x) {
    if (length(x) == 1L) x <- matrix(x, nrow(z), ncol(z))
    x <- as.matrix(x)
    if (!all(dim(x) == dim(z))) stop("all fields must match dim(z)")
    storage.mode(x) <- "double"
    x[is.na(x)] <- 0
    x
  }
  if (!is.null(eta)) h <- pmax(full(eta) - z, 0)
  structure(list(z = z, h = full(h), hu = full(hu), hv = full(hv),
                 manning = full(manning), rain = full(rain), f = full(f),
                 dx = dx, dy = dy, g = g, extent = extent, crs = crs),
            class = "sw_state")
}

#' Run the shallow water solver
#'
#' @param state from [sw_state()]
#' @param times output times (s), increasing; the run ends at the last one
#' @param order 1 (first order) or 2 (MUSCL + Heun)
#' @param cfl Courant number; 0.5 is safe for this unsplit scheme
#' @param bc boundary per edge, named `west`, `east`, `north`, `south`,
#'   each "wall", "open" or "periodic"; a single value applies to all.
#'   Periodic edges come in pairs (west with east, north with south)
#' @param hdry depth below which a cell's velocity is taken as zero
#' @param max_steps safety limit on time steps
#' @param dt_max largest time step (s); the CFL limit usually decides. A
#'   completely dry grid steps at 1 s (rain on dry ground)
#' @return list with `h`, `hu`, `hv` (lists of matrices, one per time),
#'   `diag` (data frame: volume, cumulative outflow and rain, budget error)
#'   and the input `state`
#' @export
sw_run <- function(state, times, order = 2L, cfl = 0.45, bc = "wall",
                   hdry = 1e-5, max_steps = 1e7, dt_max = Inf) {
  stopifnot(inherits(state, "sw_state"), all(diff(times) > 0), times[1] >= 0)
  bcv <- .bc(bc)
  s <- state
  res <- swe_run_cpp(s$h, s$hu, s$hv, s$z, s$manning, s$rain,
                     if (is.null(s$f)) 0 * s$z else s$f,
                     s$dx, s$dy, s$g, as.double(times), cfl, as.integer(order),
                     bcv, hdry, as.integer(max_steps), dt_max)
  v0 <- sum(s$h) * s$dx * s$dy
  d <- res$diag
  d$budget_error <- d$volume - (v0 + d$rain - d$outflow)
  d$rel_budget_error <- d$budget_error / max(v0 + d$rain[nrow(d)], .Machine$double.eps)
  res$diag <- d
  res$state <- state
  res$volume0 <- v0
  class(res) <- "sw_run"
  res
}

.bc <- function(bc) {
  sides <- c("west", "east", "north", "south")
  if (length(bc) == 1L) bc <- stats::setNames(rep(bc, 4), sides)
  if (is.null(names(bc))) names(bc) <- sides
  bc <- bc[sides]
  if (anyNA(bc) || !all(bc %in% c("wall", "open", "periodic"))) stop("bc must be 'wall', 'open' or 'periodic' for each side")
  if ((bc[1] == "periodic") != (bc[2] == "periodic") || (bc[3] == "periodic") != (bc[4] == "periodic"))
    stop("periodic edges come in pairs: west with east, north with south")
  unname(c(wall = 0L, open = 1L, periodic = 2L)[bc])
}

#' Water volume of a depth matrix
#' @param h depth matrix
#' @param dx,dy cell size
#' @export
sw_volume <- function(h, dx = 1, dy = dx) sum(h) * dx * dy

#' @export
#' @method print sw_run
print.sw_run <- function(x, ...) {
  d <- x$diag
  cat("shallows run:", nrow(x$state$z), "x", ncol(x$state$z), "cells,",
      length(x$h), "frames to t =", max(d$time), "s,", d$steps[nrow(d)], "steps\n")
  cat("max |mass budget error| (relative):", signif(max(abs(d$rel_budget_error)), 3), "\n")
  invisible(x)
}

#' Continue from the last frame of a run
#'
#' Returns a state holding the final depth and momentum of `run`, with any
#' of the forcing fields replaced (for example `rain = 0` to stop a storm).
#' Output times of the next [sw_run()] count from zero again.
#' @param run from [sw_run()]
#' @param ... fields of [sw_state()] to replace: manning, rain, f
#' @export
sw_continue <- function(run, ...) {
  s <- run$state
  k <- length(run$h)
  s$h <- run$h[[k]]; s$hu <- run$hu[[k]]; s$hv <- run$hv[[k]]
  a <- list(...)
  for (nm in names(a)) {
    if (!nm %in% c("manning", "rain", "f")) stop("can only replace 'manning', 'rain' or 'f'")
    v <- a[[nm]]
    if (length(v) == 1L) v <- matrix(v, nrow(s$z), ncol(s$z))
    s[[nm]] <- v
  }
  s
}

#' Coriolis parameter
#'
#' `2 * omega * sin(latitude)`: positive in the northern hemisphere and
#' negative in the southern. Give a SpatRaster to get one value per cell
#' (its cell centres are transformed to longitude and latitude), or a
#' numeric vector of latitudes in degrees.
#' @param x SpatRaster, or latitudes in degrees
#' @param omega Earth's rotation rate (rad/s)
#' @return matrix (for a raster, oriented like [sw_from_rast()]) or vector
#' @export
sw_coriolis <- function(x, omega = 7.2921159e-5) {
  if (inherits(x, "SpatRaster")) {
    if (!requireNamespace("terra", quietly = TRUE)) stop("needs the terra package")
    xy <- terra::xyFromCell(x, seq_len(terra::ncell(x)))
    ll <- if (terra::is.lonlat(x)) xy else
      terra::geom(terra::project(terra::vect(xy, crs = terra::crs(x)), "EPSG:4326"))[, c("x", "y")]
    return(matrix(2 * omega * sin(ll[, 2] * pi / 180), terra::nrow(x), terra::ncol(x), byrow = TRUE))
  }
  2 * omega * sin(x * pi / 180)
}
