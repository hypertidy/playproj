#' Ritter dam break onto a dry bed (analytic)
#'
#' Flat frictionless bed, depth `h0` for `x < x0`, dry for `x > x0`.
#' @param x positions (m)
#' @param t time (s), > 0
#' @param h0 upstream depth (m)
#' @param x0 dam position
#' @param g gravity
#' @return data frame of x, h, u
#' @export
dambreak_ritter <- function(x, t, h0, x0 = 0, g = 9.81) {
  c0 <- sqrt(g * h0)
  xi <- (x - x0) / t
  h <- ifelse(xi <= -c0, h0, ifelse(xi >= 2 * c0, 0, (2 * c0 - xi)^2 / (9 * g)))
  u <- ifelse(xi <= -c0, 0, ifelse(xi >= 2 * c0, 0, 2 / 3 * (c0 + xi)))
  data.frame(x = x, h = h, u = u)
}

#' Stoker dam break onto a wet bed (analytic)
#'
#' Depth `hl` upstream, `hr` (> 0) downstream: rarefaction, constant
#' state, then a shock moving downstream.
#' @inheritParams dambreak_ritter
#' @param hl,hr upstream and downstream depths
#' @export
dambreak_stoker <- function(x, t, hl, hr, x0 = 0, g = 9.81) {
  stopifnot(hr > 0, hl > hr)
  cl <- sqrt(g * hl); cr <- sqrt(g * hr)
  # middle state hm from the shock / rarefaction matching condition
  fn <- function(hm) {
    cm <- sqrt(g * hm)
    um_raref <- 2 * (cl - cm)
    um_shock <- (hm - hr) * sqrt(0.5 * g * (hm + hr) / (hm * hr))
    um_raref - um_shock
  }
  hm <- stats::uniroot(fn, c(hr, hl), tol = 1e-14)$root
  cm <- sqrt(g * hm)
  um <- 2 * (cl - cm)
  s <- hm * um / (hm - hr)  # shock speed
  xi <- (x - x0) / t
  h <- u <- numeric(length(x))
  a <- xi <= -cl
  b <- xi > -cl & xi <= um - cm
  m <- xi > um - cm & xi <= s
  r <- xi > s
  h[a] <- hl; u[a] <- 0
  h[b] <- (2 * cl - xi[b])^2 / (9 * g); u[b] <- 2 / 3 * (cl + xi[b])
  h[m] <- hm; u[m] <- um
  h[r] <- hr; u[r] <- 0
  data.frame(x = x, h = h, u = u)
}

#' Thacker planar oscillation in a paraboloid bowl (analytic)
#'
#' Bed `z = D0 * (r^2 / L^2 - 1)` centred at the origin. The water
#' surface stays a plane that tilts and circles around the bowl with
#' period `2 pi / omega`, `omega = sqrt(2 g D0) / L`, and the shoreline
#' moves: a standard wetting and drying benchmark (Thacker 1981, J. Fluid
#' Mech. 107, 499-508).
#' @param x,y positions (m), recycled to common length
#' @param t time (s)
#' @param D0 depth at the centre at rest (m)
#' @param L radius of the rest shoreline (m)
#' @param eta0 displacement of the shoreline circle's centre (m); the
#'   defaults are the SWASHES benchmark (a = 1, h0 = 0.1, eta = 0.5)
#' @param g gravity
#' @return list with bed `z`, depth `h`, velocities `u`, `v`, and `period`
#' @export
thacker_bowl <- function(x, y, t, D0 = 0.1, L = 1, eta0 = 0.5, g = 9.81) {
  omega <- sqrt(2 * g * D0) / L
  z <- D0 * ((x^2 + y^2) / L^2 - 1)
  eta <- (eta0 * D0 / L^2) * (2 * x * cos(omega * t) + 2 * y * sin(omega * t) - eta0)
  h <- pmax(eta - z, 0)
  wet <- h > 0
  u <- ifelse(wet, -eta0 * omega * sin(omega * t), 0)
  v <- ifelse(wet, eta0 * omega * cos(omega * t), 0)
  list(z = z, h = h, u = u, v = v, period = 2 * pi / omega)
}
