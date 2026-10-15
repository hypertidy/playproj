library(raadtools)
library(geosphere)
library(maptools)
data(wrld_simpl)
library(rgeos)

library(rgdal)

## m/s
d <- readwind("2010-01-01", xylim = extent(-180, 180, -80, 0))

##d2 <- resample(d,  raster(extent(d), nrows = nrow(d)/8, ncols = ncol(d)/8), method = "ngb")
smp <- as.data.frame(randomCoordinates(600))
smp <- smp[smp[,2] < 0,]
coordinates(smp) <- 1:2
projection(smp) <- projection(d)

##tab <- as(d2, "SpatialPointsDataFrame")
## source points with U,V components
tab <- extract(d, smp, sp = TRUE)

## background data
wrld0 <- suppressWarnings(gIntersection(wrld_simpl, as(extent(-180, 180, -86.4, 0), "SpatialPolygons"), byid = TRUE))
wrld <- spTransform(wrld0, CRS(projection(d)))
xy <- coordinates(tab)

xy.ortho <- lapply(seq_len(nrow(xy)), 
                   function(x) gcIntermediate(xy[x,],
                                              cbind(xy[x, 1] + tab[[1]][x], xy[x, 2] + tab[[2]][x])))

xy.ortho <- lapply(seq_len(nrow(xy)), 
                   function(x) gcIntermediate(xy[x,],
                                              cbind(xy[x, 1] + tab[[1]][x], xy[x, 2] + tab[[2]][x])))

xy.merc <- coordinates(spTransform(tab, CRS("+proj=merc +datum=WGS84")))
merc.multi <- 1e5
xy.loxo <- lapply(seq_len(nrow(xy.merc)), 
                  function(x) project(do.call(cbind, approx(c(xy.merc[x,1], xy.merc[x, 1] + tab[[1]][x] * merc.multi), 
                                                            c(xy.merc[x,2], xy.merc[x, 2] + tab[[2]][x] * merc.multi))), "+proj=merc +datum=WGS84", inv = TRUE))

plot(wrld)
multi <- 1e0
arrows(xy[,1], xy[,2], xy[,1] + tab[[1]] * multi, xy[,2] + tab[[2]] * multi, length = 0.025, lty = 2)
lapply(xy.ortho, lines, col = "black")
lapply(xy.loxo, lines, col = "red")

pproj <- "+proj=stere +lat_0=-90 +lat_ts=-71"
ppxy <- project(xy, pproj)
xy2 <- xy
xy2[,1] <- xy2[,1] + (tab[[1]] * merc.multi)  / (1.852 * 60 * 1000)
xy2[,2] <- xy2[,2] + (tab[[2]] * merc.multi)/ (1.852 * 60 * 1000)
ppxy2 <- project(xy2, pproj)


plot(ppxy, asp = 1)
plot(spTransform(wrld, CRS(pproj)), add = TRUE, col = "grey")
lapply(xy.ortho, function(x) lines(project(x, pproj), col = "black"))
lapply(xy.loxo, function(x) lines(project(x, pproj), col = "red"))
points(ppxy2, pch = 16)
