#' Build a state from a terra DEM
#'
#' Reads the bed from a single-layer SpatRaster, keeping its extent and
#' CRS so outputs can be written back as georeferenced rasters. Missing
#' bed cells are filled with the maximum elevation plus 100 m (a high wall).
#' @param dem SpatRaster in metres: projected CRS, or none for a generated
#'   bed ([sw_generate()]); a `z` layer is used if there are several
#'   ([sw_extract()])
#' @param ... passed to [sw_state()] (h, eta, manning, rain, ...)
#' @export
sw_from_rast <- function(dem, ...) {
  if (!requireNamespace("terra", quietly = TRUE)) stop("needs the terra package")
  if (terra::nlyr(dem) > 1) dem <- dem[[if ("z" %in% names(dem)) "z" else 1]]
  if (nzchar(terra::crs(dem)) && isTRUE(terra::is.lonlat(dem)))
    stop("DEM must be in a projected CRS with metre units (see sw_extract())")
  z <- terra::as.matrix(dem, wide = TRUE)
  if (anyNA(z)) z[is.na(z)] <- max(z, na.rm = TRUE) + 100
  r <- terra::res(dem)
  sw_state(z, dx = r[1], dy = r[2], extent = as.vector(terra::ext(dem)),
           crs = terra::crs(dem), ...)
}

#' Frames of a run as a georeferenced SpatRaster
#'
#' @param run from [sw_run()]
#' @param what "h" (depth), "eta" (surface elevation, NA where dry),
#'   "speed" (m/s), "hu", "hv"
#' @param dry depth below which a cell counts as dry for "eta" and "speed"
#' @return SpatRaster with one layer per output time, layer `time` set
#' @export
sw_rast <- function(run, what = c("h", "eta", "speed", "hu", "hv"), dry = 1e-3) {
  if (!requireNamespace("terra", quietly = TRUE)) stop("needs the terra package")
  what <- match.arg(what)
  s <- run$state
  ext <- s$extent
  if (is.null(ext)) ext <- c(0, ncol(s$z) * s$dx, 0, nrow(s$z) * s$dy)
  layer <- function(k) {
    h <- run$h[[k]]
    m <- switch(what,
      h = h,
      eta = ifelse(h > dry, h + s$z, NA_real_),
      speed = ifelse(h > dry, sqrt(run$hu[[k]]^2 + run$hv[[k]]^2) / h, NA_real_),
      hu = run$hu[[k]], hv = run$hv[[k]])
    terra::rast(m, extent = terra::ext(ext), crs = if (is.null(s$crs)) "" else s$crs)
  }
  out <- terra::rast(lapply(seq_along(run$h), layer))
  names(out) <- sprintf("%s_t%gs", what, run$diag$time)
  terra::time(out) <- run$diag$time
  terra::units(out) <- switch(what, h = "m", eta = "m", speed = "m/s", "m2/s")
  out
}
