source("sinbin.R")
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


## http://www.cmu.edu/biolphys/deserno/pdf/sphere_equi.pdf

x <- coordinates(as(as(sinbin(6), "SpatialLines"), "SpatialPoints"))
xyz <- llh2xyz(cbind(x, 0)[x[,2] < 0, ])
ch <- convhulln(xyz)
ts.surf <- t(ch)
rgl.triangles(xyz[ts.surf, 1], xyz[ts.surf, 2], xyz[ts.surf, 3], 
              col = pal(ncol(ts.surf)), alpha = 0.8)

# 
# library(geosphere)
# library(rgl)
# library(geometry)
# x <- regularCoordinates(2)
# 
# 
# xyz <- llh2xyz(cbind(x, 0))
# 
# ch <- convhulln(xyz)
# 
# ts.surf <- t(ch)
# rgl.triangles(xyz[ts.surf, 1], xyz[ts.surf, 2], xyz[ts.surf, 3], 
# col = "blue", alpha = 0.8)
# ##for (i in seq(0, 360, length = 80)) rgl.viewpoint(i/8)
# 
