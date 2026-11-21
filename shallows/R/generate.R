## Synthetic terrain, matched number for number by playproj's
## src/core/terrain.js: the same shape, size and seed give the same bed in R
## and in the browser. Value noise on an integer lattice, hashed with
## Park-Miller steps (all products below 2^53, so doubles are exact), quintic
## smoothstep blending, octaves summed (fBm).

.M <- 2147483647

.hash01 <- function(i, j, seed) {
  h <- (i * 1619 + j * 31337 + seed * 6971) %% .M
  h <- (h * 48271) %% .M
  h <- (h * 48271 + 12345) %% .M
  h <- (h * 48271) %% .M
  h / .M
}

.noise2 <- function(x, y, seed) {
  i <- floor(x); j <- floor(y)
  fx <- x - i; fy <- y - j
  u <- fx * fx * fx * (fx * (fx * 6 - 15) + 10)
  v <- fy * fy * fy * (fy * (fy * 6 - 15) + 10)
  a <- .hash01(i, j, seed); b <- .hash01(i + 1, j, seed)
  c <- .hash01(i, j + 1, seed); d <- .hash01(i + 1, j + 1, seed)
  top <- a + (b - a) * u; bot <- c + (d - c) * u
  2 * (top + (bot - top) * v) - 1
}

#' Fractal noise
#'
#' Octaves of value noise (fBm), about -1 to 1. Matches playproj
#' `src/core/terrain.js` `fbm()`.
#' @param X,Y metres
#' @param scale largest wavelength (m)
#' @param octaves number of octaves
#' @param gain amplitude ratio between octaves
#' @param seed integer seed
#' @export
sw_fbm <- function(X, Y, scale = 200, octaves = 5, gain = 0.5, seed = 1) {
  amp <- 1; s <- 0; norm <- 0; f <- 1 / scale
  for (o in seq_len(octaves) - 1) {
    s <- s + amp * .noise2(X * f, Y * f, seed + o * 101)
    norm <- norm + amp; amp <- amp * gain; f <- f * 2
  }
  s / norm
}

.shapes <- list(
  plane = list(z0 = 0, slope_x = 0.01, slope_y = 0),
  valley = list(z0 = 0, slope = 0.01, side = 0.3, floor = 20),
  bowl = list(depth = 10, radius = 500),
  shelf = list(land_slope = 0.02, shelf_slope = 0.002, shelf_depth = 120, slope_slope = 0.05, abyss = 3000),
  island = list(height = 50, depth = 30, radius = 300),
  reservoir = list(z0 = 0, slope = 0.01, side = 0.3, floor = 20, dam_x = 0, dam_height = 15, dam_thick = 20, breach = 0)
)

.shape_z <- function(shape, X, Y, q) {
  switch(shape,
    plane = q$z0 - q$slope_x * X - q$slope_y * Y,
    valley = q$z0 - q$slope * X + q$side * pmax(abs(Y) - q$floor / 2, 0),
    bowl = q$depth * ((X * X + Y * Y) / (q$radius * q$radius) - 1),
    shelf = {
      xb <- q$shelf_depth / q$shelf_slope
      ifelse(X <= 0, -q$land_slope * X,
             ifelse(X <= xb, -q$shelf_slope * X, -pmin(q$abyss, q$shelf_depth + q$slope_slope * (X - xb))))
    },
    island = -q$depth + (q$height + q$depth) * exp(-(X * X + Y * Y) / (q$radius * q$radius)),
    reservoir = {
      v <- q$z0 - q$slope * X + q$side * pmax(abs(Y) - q$floor / 2, 0)
      wall <- abs(X - q$dam_x) <= q$dam_thick / 2 & abs(Y) >= q$breach / 2
      ifelse(wall, pmax(v, q$z0 - q$slope * q$dam_x + q$dam_height), v)
    },
    stop("unknown shape ", shape))
}

#' Generate a synthetic bed
#'
#' Shapes you can reason about, with optional fractal roughness on top.
#' Local coordinates are metres from the grid centre, X east and Y north;
#' row 1 is the north edge, as in a raster.
#'
#' * `plane`: `z0 - slope_x X - slope_y Y`.
#' * `valley`: drains east, floor falling `slope`, sides rising `side` beyond a
#'   flat floor `floor` wide.
#' * `bowl`: paraboloid, `depth` below rim level at the centre, rim at `radius`.
#' * `shelf`: north-south coast at X = 0, land west rising `land_slope`, shelf
#'   east falling `shelf_slope` to `shelf_depth`, then `slope_slope` to `abyss`.
#' * `island`: gaussian `height` above sea level on a floor `depth` deep.
#' * `reservoir`: a valley with a dam at `dam_x`, `dam_height` above the floor
#'   there, `dam_thick` thick, breached over `breach` metres (0 = intact).
#'
#' @param shape one of the names above
#' @param nx,ny cells across and down
#' @param dx,dy cell size (m)
#' @param ... shape parameters, replacing the defaults (see `sw_shapes()`)
#' @param noise NULL, or a list with `amp` (m) and optionally `scale`,
#'   `octaves`, `gain`, `seed` for [sw_fbm()]
#' @param as "rast" for a SpatRaster (extent in local metres, no CRS) or
#'   "matrix"
#' @export
sw_generate <- function(shape = names(.shapes), nx = 200, ny = nx, dx = 5, dy = dx, ...,
                        noise = NULL, as = c("rast", "matrix")) {
  shape <- match.arg(shape); as <- match.arg(as)
  q <- utils::modifyList(.shapes[[shape]], list(...))
  if (!all(names(list(...)) %in% names(.shapes[[shape]])))
    stop("unknown parameter for ", shape, ": ", paste(setdiff(names(list(...)), names(.shapes[[shape]])), collapse = ", "))
  X <- matrix((seq_len(nx) - 0.5 - nx / 2) * dx, ny, nx, byrow = TRUE)
  Y <- matrix((ny / 2 - seq_len(ny) + 0.5) * dy, ny, nx)
  z <- .shape_z(shape, X, Y, q)
  if (!is.null(noise) && isTRUE(noise$amp != 0)) {
    nz <- utils::modifyList(list(scale = 200, octaves = 5, gain = 0.5, seed = 1), noise)
    z <- z + nz$amp * sw_fbm(X, Y, nz$scale, nz$octaves, nz$gain, nz$seed)
  }
  z <- matrix(z, ny, nx)
  if (as == "matrix") return(structure(z, dx = dx, dy = dy))
  if (!requireNamespace("terra", quietly = TRUE)) stop("needs the terra package, or use as = 'matrix'")
  terra::rast(z, extent = terra::ext(-nx * dx / 2, nx * dx / 2, -ny * dy / 2, ny * dy / 2), crs = "")
}

#' Default parameters of the generator shapes
#' @export
sw_shapes <- function() .shapes

#' Fill a lake
#'
#' Depth of water standing at `level` in the cells connected (4-neighbour) to
#' cell (`i0`, `j0`) that lie below it: a reservoir, crater or hollow full to
#' a level, on any bed. Matches `fillLake()` in playproj
#' `src/core/terrain.js`.
#' @param z bed matrix
#' @param i0,j0 row and column of a cell in the lake (1-based)
#' @param level water level (m)
#' @export
sw_fill_lake <- function(z, i0, j0, level) {
  z <- as.matrix(z); ny <- nrow(z); nx <- ncol(z)
  h <- matrix(0, ny, nx)
  if (!(z[i0, j0] < level)) return(h)
  seen <- matrix(FALSE, ny, nx); seen[i0, j0] <- TRUE
  front <- cbind(i0, j0)
  while (nrow(front)) {
    h[front] <- level - z[front]
    nb <- rbind(cbind(front[, 1] - 1, front[, 2]), cbind(front[, 1] + 1, front[, 2]),
                cbind(front[, 1], front[, 2] - 1), cbind(front[, 1], front[, 2] + 1))
    nb <- nb[nb[, 1] >= 1 & nb[, 1] <= ny & nb[, 2] >= 1 & nb[, 2] <= nx, , drop = FALSE]
    nb <- unique(nb[!seen[nb] & z[nb] < level, , drop = FALSE])
    seen[nb] <- TRUE
    front <- nb
  }
  h
}

#' Fill the sea
#'
#' Depth of water standing at `level` in cells below it that connect
#' (4-neighbour) to the edge of the grid; inland hollows stay dry. Matches
#' `fillSea()` in playproj `src/core/terrain.js`.
#' @param z bed matrix
#' @param level sea level (m)
#' @export
sw_fill_sea <- function(z, level = 0) {
  z <- as.matrix(z); ny <- nrow(z); nx <- ncol(z)
  h <- matrix(0, ny, nx); seen <- matrix(FALSE, ny, nx)
  edge <- rbind(cbind(1, seq_len(nx)), cbind(ny, seq_len(nx)), cbind(seq_len(ny), 1), cbind(seq_len(ny), nx))
  front <- unique(edge[z[edge] < level, , drop = FALSE])
  seen[front] <- TRUE
  while (nrow(front)) {
    h[front] <- level - z[front]
    nb <- rbind(cbind(front[, 1] - 1, front[, 2]), cbind(front[, 1] + 1, front[, 2]),
                cbind(front[, 1], front[, 2] - 1), cbind(front[, 1], front[, 2] + 1))
    nb <- nb[nb[, 1] >= 1 & nb[, 1] <= ny & nb[, 2] >= 1 & nb[, 2] <= nx, , drop = FALSE]
    nb <- unique(nb[!seen[nb] & z[nb] < level, , drop = FALSE])
    seen[nb] <- TRUE
    front <- nb
  }
  h
}
