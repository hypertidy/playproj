#' Get map coordinates
#'
#' @param na.rm remove missing values or not (they indicate path start/ends)
#'
#' @return matrix of longlat coordinates of global national boundaries and coastlines (approximately)
#' @export
#'
#' @examples
#' plot(get_map(), pch = ".")
#' lines(get_map(na.rm = FALSE))
get_map <- function(na.rm = TRUE) {
  ll <- do.call(cbind, maps::map(plot = FALSE)[1:2])
  if (na.rm) ll <- ll[!is.na(ll[,1]), ]
  ll
}
