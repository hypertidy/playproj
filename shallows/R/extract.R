#' Elevation sources known to [sw_extract()]
#'
#' A data frame of the sources, finest first: name, nominal cell size (m),
#' vertical datum, coverage test, and how to open the window. Sources are
#' read in place from cloud-optimised GeoTIFFs through GDAL `/vsicurl/`.
#' @export
sw_sources <- function() {
  data.frame(
    name = c("tas2m", "glo30", "gebco"),
    res_m = c(2, 30, 460),
    datum = c("AHD (Australian Height Datum)", "EGM2008 geoid", "mean sea level"),
    covers = c("Tasmania, land", "global land (no ocean depths)", "global, land and sea floor"),
    url = c("https://data.source.coop/alexgleith/tasmania-dem-2m/Tasmania_Statewide_2m_DEM_14-08-2021.tif",
            "https://copernicus-dem-30m.s3.amazonaws.com/ (1 degree tiles)",
            "https://data.source.coop/ausantarctic/gebco/GEBCO_2026.tif"),
    stringsAsFactors = FALSE)
}

#' A local metric CRS for a place
#'
#' UTM (WGS84) between 80 S and 84 N, polar stereographic beyond.
#' @param lon,lat centre in degrees
#' @export
sw_local_crs <- function(lon, lat) {
  if (lat < -80) return("EPSG:3031")
  if (lat > 84) return("EPSG:3413")
  zone <- floor((lon + 180) / 6) %% 60 + 1
  sprintf("EPSG:%d", (if (lat < 0) 32700 else 32600) + zone)
}

.glo30_tiles <- function(ll_ext) {
  lats <- seq(floor(ll_ext[3]), floor(ll_ext[4] - 1e-9))
  lons <- seq(floor(ll_ext[1]), floor(ll_ext[2] - 1e-9))
  g <- expand.grid(lat = lats, lon = lons)
  nm <- sprintf("Copernicus_DSM_COG_10_%s%02d_00_%s%03d_00_DEM",
                ifelse(g$lat < 0, "S", "N"), abs(g$lat), ifelse(g$lon < 0, "W", "E"), abs(g$lon))
  sprintf("/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/%s/%s.tif", nm, nm)
}

.open_source <- function(name, ll_ext) {
  if (name == "tas2m") {
    # Tasmania and its islands, roughly
    if (ll_ext[2] < 143.5 || ll_ext[1] > 148.6 || ll_ext[4] < -43.8 || ll_ext[3] > -39.4) return(NULL)
    return(terra::rast(paste0("/vsicurl/", sw_sources()$url[1])))
  }
  if (name == "glo30") {
    ok <- Filter(function(u) !inherits(try(suppressWarnings(terra::rast(u)), silent = TRUE), "try-error"),
                 .glo30_tiles(ll_ext))
    if (!length(ok)) return(NULL)  # open ocean: no tiles
    return(if (length(ok) == 1) terra::rast(ok) else terra::vrt(ok))
  }
  if (name == "gebco") return(terra::rast(paste0("/vsicurl/", sw_sources()$url[3])))
  stop("unknown source ", name)
}

#' Extract a bed for any place
#'
#' Builds a grid of `res` metre cells, `size` metres across, centred on
#' `lon`, `lat` in a local metric CRS, and fills it from the elevation
#' sources in order (finest first). Each source is cropped in its own CRS
#' and warped onto the grid (cell averages when the source is finer than the
#' grid, bilinear when it is coarser). Later sources fill only cells the
#' earlier ones left empty. Copernicus GLO-30 has no sea floor (sea cells
#' are near 0 m), so where GEBCO says sea and GLO-30 is within `sea_tol` of
#' zero, GEBCO's depth is used.
#'
#' The sources use different vertical datums (see [sw_sources()]); they
#' agree to about a metre around Tasmania, which matters for tides but not
#' for rain runoff.
#'
#' @param lon,lat centre (degrees)
#' @param size extent (m), one number for a square or c(width, height)
#' @param res cell size (m)
#' @param sources names from [sw_sources()], in the order to use them
#' @param crs target CRS; default [sw_local_crs()]
#' @param sea_tol GLO-30 values within this of 0 m count as sea where GEBCO
#'   is below 0
#' @return SpatRaster with layers `z` (m) and `source` (index into
#'   `sources`, 0 where nothing covered the cell)
#' @export
sw_extract <- function(lon, lat, size = 2000, res = 10,
                       sources = c("tas2m", "glo30", "gebco"),
                       crs = sw_local_crs(lon, lat), sea_tol = 0.5) {
  if (!requireNamespace("terra", quietly = TRUE)) stop("needs the terra package")
  size <- rep(size, length.out = 2)
  ctr <- terra::crds(terra::project(terra::vect(cbind(lon, lat), crs = "EPSG:4326"), crs))
  nx <- max(2L, round(size[1] / res)); ny <- max(2L, round(size[2] / res))
  tmpl <- terra::rast(nrows = ny, ncols = nx, crs = crs,
                      extent = terra::ext(ctr[1] - nx * res / 2, ctr[1] + nx * res / 2,
                                          ctr[2] - ny * res / 2, ctr[2] + ny * res / 2))
  ll <- as.vector(terra::ext(terra::project(terra::as.polygons(terra::ext(tmpl), crs = crs), "EPSG:4326")))
  z <- terra::init(tmpl, NA_real_); src <- terra::init(tmpl, 0L)
  gebco <- NULL
  for (k in seq_along(sources)) {
    r <- .open_source(sources[k], ll)
    if (is.null(r)) next
    # window in the source's CRS, with a margin of a few source cells
    w <- terra::ext(terra::project(terra::as.polygons(terra::ext(tmpl), crs = crs), terra::crs(r)))
    w <- terra::extend(w, 4 * max(terra::res(r)))
    if (is.null(terra::intersect(w, terra::ext(r)))) next
    finer <- max(terra::res(r)) * (if (terra::is.lonlat(r)) 111000 else 1) < res
    # GDALWarp reads the right overview level of a COG, so a coarse grid over
    # a fine source reads only what it needs
    rw <- terra::project(r, tmpl, method = if (finer) "average" else "bilinear", by_util = TRUE)
    names(rw) <- "z"
    if (sources[k] == "gebco") gebco <- rw
    fill <- is.na(z) & !is.na(rw)
    z <- terra::cover(z, rw)
    src <- terra::ifel(fill, k, src)
  }
  # GLO-30 sea cells: take GEBCO's depth
  kg <- match("glo30", sources)
  if (!is.na(kg) && !is.null(gebco)) {
    sea <- (src == kg) & (abs(z) <= sea_tol) & (gebco < 0)
    z <- terra::ifel(sea, gebco, z)
    src <- terra::ifel(sea, match("gebco", sources), src)
  }
  out <- c(z, src)
  names(out) <- c("z", "source")
  terra::metags(out) <- c(sources = paste(sources, collapse = ","), lon = lon, lat = lat)
  out
}
