library(raster)
library(rgl)
library(geometry)
r <- raster(volcano)

extent(r) <- extent(0, ncol(r), 0, nrow(r))
xy <- cbind(runif(2560, xmin(r), xmax(r)), runif(2560, ymin(r), ymax(r)))
z <- extract(r, xy)
del <- delaunayn(xy)
xyz <- cbind(xy, z/5)
rgl.triangles(xyz[as.vector(t(del)), ])

scl <- function(x) (x - min(x))/diff(range(x))

tc <- xyz
tc[,1] <- scl(tc[,1]) * 50 - 5
tc[,2] <- scl(tc[,2]) * 37 - 5

bad <- tc[,1] < -1 | tc[,1] > 1 | tc[,2] < -1 | tc[,2] > 1
tc[bad, ] <- NA_real_

rgl.triangles(xyz[as.vector(t(del)), ], texcoords = tc, texture = "C:/temp/texture/texNeusch.png")
