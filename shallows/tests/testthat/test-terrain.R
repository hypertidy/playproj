test_that("generated beds match the JS generator and are deterministic", {
  z <- sw_generate("island", nx = 40, ny = 30, dx = 10, noise = list(amp = 3, seed = 7), as = "matrix")
  ## references from playproj src/core/terrain.js (test/check-terrain.mjs)
  expect_equal(z[1, 1], 11.8909876344848, tolerance = 1e-10)
  expect_equal(z[15, 20], 49.558754836647, tolerance = 1e-10)
  expect_identical(z, sw_generate("island", nx = 40, ny = 30, dx = 10, noise = list(amp = 3, seed = 7), as = "matrix"))
  expect_false(identical(z, sw_generate("island", nx = 40, ny = 30, dx = 10, noise = list(amp = 3, seed = 8), as = "matrix")))
  for (s in names(sw_shapes())) expect_true(all(is.finite(sw_generate(s, nx = 20, ny = 10, dx = 50, as = "matrix"))))
  expect_error(sw_generate("plane", nx = 4, bogus = 1, as = "matrix"), "unknown parameter")
})

test_that("lake and sea fills", {
  r <- sw_generate("reservoir", nx = 60, ny = 20, dx = 5, as = "matrix")
  l <- sw_fill_lake(r, 10, 5, 14)
  expect_equal(sum(l > 0), 560)
  expect_true(all(l[, 40:60] == 0))  # nothing past the dam
  z <- sw_generate("island", nx = 100, ny = 80, dx = 10, noise = list(amp = 3, seed = 7), as = "matrix")
  h <- sw_fill_sea(z, 0)
  expect_equal(sum(h > 0), 5252)
  expect_equal(sum(h), 89693.8917294, tolerance = 1e-9)
})

test_that("inertial oscillation turns clockwise for f > 0, exactly", {
  n <- 8; f <- 1e-4
  s <- sw_state(matrix(0, n, n), dx = 1000, h = 10, hu = 1, f = f)
  run <- sw_run(s, times = pi / 2 / f, bc = "periodic")
  k <- length(run$h)
  expect_equal(run$hu[[k]][4, 4], 0, tolerance = 1e-9)
  expect_equal(-run$hv[[k]][4, 4], -1, tolerance = 1e-9)  # southward
  expect_equal(sw_coriolis(-45), -2 * 7.2921159e-5 * sin(pi / 4))
})

test_that("periodic edges must come in pairs", {
  s <- sw_state(matrix(0, 4, 4), dx = 1, h = 1)
  expect_error(sw_run(s, times = 1, bc = c("periodic", "wall", "wall", "wall")))
})

test_that("extraction gives a local metre grid (network)", {
  skip_on_cran()
  skip_if(Sys.getenv("SHALLOWS_NET") == "", "set SHALLOWS_NET=1 to run network tests")
  d <- sw_extract(147.3, -42.9, size = 2000, res = 50)
  expect_equal(names(d), c("z", "source"))
  expect_equal(terra::res(d), c(50, 50))
})
