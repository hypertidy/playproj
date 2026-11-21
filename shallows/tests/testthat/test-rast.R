test_that("frames come back as georeferenced rasters", {
  skip_if_not_installed("terra")
  dem <- terra::rast(matrix(outer(1:20, 1:30, function(i, j) 0.1 * j), 20, 30),
                     extent = terra::ext(500000, 500060, 5200000, 5200040), crs = "EPSG:28355")
  st <- sw_from_rast(dem, eta = 1.5)
  expect_equal(st$dx, 2)
  r <- sw_run(st, c(1, 2))
  h <- sw_rast(r, "h")
  expect_equal(terra::nlyr(h), 2)
  expect_true(terra::same.crs(h, dem))
  expect_equal(as.vector(terra::ext(h)), as.vector(terra::ext(dem)))
  expect_equal(unname(terra::values(h[[1]])[, 1]), as.vector(t(r$h[[1]])))
})
