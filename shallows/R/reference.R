#' Plain R reference solver (first order)
#'
#' The same first-order scheme as [sw_run()] with `order = 1`, written as
#' vectorised R over whole matrices. It exists to show the method in
#' readable form and to cross-check the C++ kernel; it is roughly 10 to 50
#' times slower.
#'
#' @inheritParams sw_run
#' @export
sw_run_r <- function(state, times, cfl = 0.45, bc = "wall", hdry = 1e-5, dt_max = 1) {
  s <- state
  g <- s$g; dx <- s$dx; dy <- s$dy
  bcv <- .bc(bc)  # 0 wall, 1 open: west, east, north, south
  h <- s$h; hu <- s$hu; hv <- s$hv; z <- s$z
  ny <- nrow(z); nx <- ncol(z)
  # desingularised velocity (Kurganov and Petrova 2007)
  vel <- function(h, q) ifelse(h > 0, sqrt(2) * h * q / sqrt(h^4 + pmax(h^4, hdry^4)), 0)

  # pad with one ghost cell on every side
  pad <- function(a, sign_x = 1, sign_y = 1) {
    w <- if (bcv[1] == 1) a[, 1] else a[, 1] * sign_x
    e <- if (bcv[2] == 1) a[, nx] else a[, nx] * sign_x
    a <- cbind(w, a, e)
    n <- if (bcv[3] == 1) a[1, ] else a[1, ] * sign_y
    so <- if (bcv[4] == 1) a[ny, ] else a[ny, ] * sign_y
    unname(rbind(n, a, so))
  }
  hll <- function(hl, ul, vl, hr, ur, vr) {
    cl <- sqrt(g * hl); cr <- sqrt(g * hr)
    sl <- pmin(ul - cl, ur - cr); sr <- pmax(ul + cl, ur + cr)
    fl <- list(hl * ul, hl * ul^2 + 0.5 * g * hl^2, hl * ul * vl)
    fr <- list(hr * ur, hr * ur^2 + 0.5 * g * hr^2, hr * ur * vr)
    ql <- list(hl, hl * ul, hl * vl); qr <- list(hr, hr * ur, hr * vr)
    den <- sr - sl
    den[den == 0] <- 1
    lapply(1:3, function(k) {
      f <- (sr * fl[[k]] - sl * fr[[k]] + sl * sr * (qr[[k]] - ql[[k]])) / den
      f <- ifelse(sl >= 0, fl[[k]], ifelse(sr <= 0, fr[[k]], f))
      f[hl <= 0 & hr <= 0] <- 0
      f
    })
  }
  # interface between arrays a (left) and b (right) of states
  iface <- function(hL, uL, vL, zL, hR, uR, vR, zR) {
    zs <- pmax(zL, zR)
    hl <- pmax(0, hL + zL - zs); hr <- pmax(0, hR + zR - zs)
    f <- hll(hl, uL, vL, hr, uR, vR)
    list(f = f, cl = 0.5 * g * (hL^2 - hl^2), cr = 0.5 * g * (hR^2 - hr^2))
  }

  zp <- pad(z)
  # bed acceleration term for the time step (see sw_run)
  zg <- function(a, b) abs(a - b)
  sx <- pmax(zg(zp[2:(ny + 1), 3:(nx + 2)], z), zg(z, zp[2:(ny + 1), 1:nx])) / dx
  sy <- pmax(zg(zp[3:(ny + 2), 2:(nx + 1)], z), zg(z, zp[1:ny, 2:(nx + 1)])) / dy
  acc <- g * (sx / dx + sy / dy)
  ix <- 2:(ny + 1); jx <- 2:(nx + 1)
  out <- list(h = vector("list", length(times)), hu = vector("list", length(times)),
              hv = vector("list", length(times)))
  t <- 0; steps <- 0L; outflow <- 0
  vols <- outs <- numeric(length(times))
  for (k in seq_along(times)) {
    while (t < times[k] - 1e-12) {
      u <- vel(h, hu); v <- vel(h, hv); cw <- sqrt(g * h)
      B <- ((abs(u) + cw) / dx + (abs(v) + cw) / dy)[h > 0]
      A <- acc[h > 0]
      dts <- ifelse(A > 0, 2 * cfl / (B + sqrt(B^2 + 4 * A * cfl)), cfl / B)
      dt <- min(c(dts, dt_max, times[k] - t))
      H <- pad(h); U <- pad(u, -1, 1); V <- pad(v, 1, -1)
      # x interfaces: nx + 1 of them per row
      L <- seq_len(nx + 1); R <- L + 1
      fx <- iface(H[ix, L], U[ix, L], V[ix, L], zp[ix, L],
                  H[ix, R], U[ix, R], V[ix, R], zp[ix, R])
      # y interfaces: ny + 1 per column; normal velocity is v
      Ly <- seq_len(ny + 1); Ry <- Ly + 1
      fy <- iface(H[Ly, jx], V[Ly, jx], U[Ly, jx], zp[Ly, jx],
                  H[Ry, jx], V[Ry, jx], U[Ry, jx], zp[Ry, jx])
      e <- 2:(nx + 1); w <- 1:nx  # east and west face of each cell
      so <- 2:(ny + 1); no <- 1:ny
      dh <- -(fx$f[[1]][, e] - fx$f[[1]][, w]) / dx - (fy$f[[1]][so, ] - fy$f[[1]][no, ]) / dy
      dhu <- -((fx$f[[2]][, e] + fx$cl[, e]) - (fx$f[[2]][, w] + fx$cr[, w])) / dx -
        (fy$f[[3]][so, ] - fy$f[[3]][no, ]) / dy
      dhv <- -(fx$f[[3]][, e] - fx$f[[3]][, w]) / dx -
        ((fy$f[[2]][so, ] + fy$cl[so, ]) - (fy$f[[2]][no, ] + fy$cr[no, ])) / dy
      out_rate <- (sum(fx$f[[1]][, nx + 1]) - sum(fx$f[[1]][, 1])) * dy +
        (sum(fy$f[[1]][ny + 1, ]) - sum(fy$f[[1]][1, ])) * dx
      h <- h + dt * dh; hu <- hu + dt * dhu; hv <- hv + dt * dhv
      h[h < 0] <- 0
      dry <- h < 1e-12
      hu[dry] <- 0; hv[dry] <- 0
      thin <- !dry & h < hdry
      hu[thin] <- h[thin] * vel(h[thin], hu[thin])
      hv[thin] <- h[thin] * vel(h[thin], hv[thin])
      outflow <- outflow + dt * out_rate
      t <- t + dt; steps <- steps + 1L
    }
    out$h[[k]] <- h; out$hu[[k]] <- hu; out$hv[[k]] <- hv
    vols[k] <- sum(h) * dx * dy; outs[k] <- outflow
  }
  out$diag <- data.frame(time = times, volume = vols, outflow = outs)
  out$steps <- steps
  out
}
