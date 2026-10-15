
lacentroids <- function(x, cxy) {
    proj <- sprintf("+proj=laea +lon_0=%f +lat_0=%f", cxy[1], cxy[2])
    xy <- coordinates(spTransform(x, CRS(proj)))

    coordinates(spTransform(SpatialPoints(xy, CRS(proj)), CRS(proj4string(x))))
}

library(rworldmap)
data(countriesLow)
wm <- disaggregate(countriesLow)

hemivis <- function(x, cxy = c(0, 0), vis = 0.5) {
    vis <- rep(vis, length = 2)
    lax <- lacentroids(x, cxy)
    cos((lax[,1] - lc[1]) * pi / 180) > vis[1] & cos((lax[,2] - lc[2]) * pi / 180) > vis[2]
}

wm[hemivis(wm, cxy = c(150, -60)), ]

