test_that("lake at rest with dry islands stays at rest (well balanced)", {
  n <- 40; ij <- expand.grid(i = 1:n, j = 1:n)
  z <- matrix(0.8 * exp(-((ij$i - 15)^2 + (ij$j - 20)^2) / 30) + 0.3 * sin(ij$i / 3), n, n)
  for (o in 1:2) {
    r <- sw_run(sw_state(z, eta = 0.5), 20, order = o)
    wet <- r$h[[1]] > 0
    expect_true(any(!wet))
    expect_lt(max(abs(r$h[[1]][wet] + z[wet] - 0.5)), 1e-12)
    expect_lt(max(abs(c(r$hu[[1]], r$hv[[1]]))), 1e-12)
  }
})

test_that("dam breaks converge to the analytic solutions", {
  err <- function(case, nx, o) {
    dx <- 1000 / nx; x <- -500 + (seq_len(nx) - 0.5) * dx
    h0 <- ifelse(x < 0, 10, if (case == "stoker") 2 else 0)
    r <- sw_run(sw_state(matrix(0, 1, nx), h = matrix(h0, 1, nx), dx = dx), 20, order = o, bc = "open")
    ex <- if (case == "stoker") dambreak_stoker(x, 20, 10, 2) else dambreak_ritter(x, 20, 10)
    mean(abs(r$h[[1]][1, ] - ex$h))
  }
  for (case in c("stoker", "ritter")) {
    e1 <- err(case, 200, 2); e2 <- err(case, 400, 2)
    expect_lt(e1, 0.03)
    expect_lt(e2, 0.6 * e1)
    expect_lt(e2, err(case, 400, 1))
  }
})

test_that("Thacker bowl: moving shoreline tracked, depth non-negative", {
  P <- thacker_bowl(0, 0, 0)$period
  n <- 60; dx <- 4 / n; x <- -2 + (seq_len(n) - 0.5) * dx
  X <- matrix(x, n, n, byrow = TRUE); Y <- matrix(x, n, n)
  a0 <- thacker_bowl(X, Y, 0)
  r <- sw_run(sw_state(a0$z, h = a0$h, hu = a0$h * a0$u, hv = a0$h * a0$v, dx = dx), P, order = 2)
  e <- sum(abs(r$h[[1]] - thacker_bowl(X, Y, P)$h)) / sum(a0$h)
  expect_lt(e, 0.1)
  expect_gte(min(r$h[[1]]), 0)
  expect_equal(r$diag$clipped, 0)
})

test_that("mass budget closes with rain and open boundaries", {
  z <- outer(1:30, 1:40, function(i, j) 0.2 * j + 0.05 * (i - 15)^2 / 15)
  st <- sw_state(z, dx = 2, rain = 0.01, manning = 0.03)
  r <- sw_run(st, c(10, 30), order = 2, bc = c(west = "open", east = "wall", north = "wall", south = "wall"))
  expect_gt(r$diag$outflow[2], 0)
  expect_lt(max(abs(r$diag$rel_budget_error)), 1e-10)
})

test_that("C++ kernel matches the plain R reference (order 1)", {
  n <- 25; ij <- expand.grid(i = 1:n, j = 1:n)
  z <- matrix(0.3 * exp(-((ij$i - 10)^2 + (ij$j - 12)^2) / 20), n, n)
  s <- sw_state(z, eta = 0.4); s$h[5:8, 5:8] <- s$h[5:8, 5:8] + 0.2
  bc <- c(west = "open", east = "wall", north = "wall", south = "open")
  a <- sw_run(s, c(2, 4), order = 1, bc = bc)
  b <- sw_run_r(s, c(2, 4), bc = bc)
  expect_lt(max(abs(a$h[[2]] - b$h[[2]])), 1e-12)
  expect_lt(max(abs(a$hu[[2]] - b$hu[[2]])), 1e-12)
  expect_equal(a$diag$outflow, b$diag$outflow, tolerance = 1e-10)
})

test_that("x and y sweeps are symmetric", {
  z <- matrix(0, 4, 60); h <- matrix(rep(ifelse(1:60 < 30, 2, 0.5), each = 4), 4, 60)
  a <- sw_run(sw_state(z, h = h), 3)
  b <- sw_run(sw_state(t(z), h = t(h)), 3)
  expect_equal(a$h[[1]], t(b$h[[1]]))
})
