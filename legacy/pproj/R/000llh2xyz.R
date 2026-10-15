##b <- 6370997
## function to produce xyz from longitude, latitude, height
## (spherical)
#' Projection longlat to geocentric (3D)
#'
#' @param lonlatheight lonlat values (matrix, 2columns)
#' @param rad radius of sphere to use
#' @param exag exageration of the height to use
#'
#' @return matrix of 3 columns (geocentric x,y,z)
#' @export
#'
#' @examples
#' llh2xyz(cbind(147, -42, 0))
llh2xyz <- function(lonlatheight, rad = 6370997, exag = 1) {
  d2r <- pi / 180.0
  cosLat = cos(lonlatheight[,2] * d2r)
  sinLat = sin(lonlatheight[,2] * d2r)
  cosLon = cos(lonlatheight[,1] * d2r)
  sinLon = sin(lonlatheight[,1] * d2r)
  x = rad * cosLat * sinLon
  y = rad * cosLat * cosLon
  z = (lonlatheight[,3] * exag) + rad * sinLat
  cbind(x, y,-z)
}
