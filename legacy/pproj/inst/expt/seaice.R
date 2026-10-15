library(raadtools)

## use "x" for data
##     "polar" for native polar projection
##     "ll" for longitude latitude CRS

xpolar <- readice("2013-10-14")
projpolar <- projection(xpolar)
projll  <- "+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs +towgs84=0,0,0"
xll <- projectRaster(xpolar, crs = prjll, res = c(0.43, 0.22))

extll <- extent(108, 150, -73, -50)

##projectExtent(crop(x, e), "+proj=longlat")

x <- crop(x, e)
plot(x)

px <- rasterToPolygons(x, n = 16)
llpx <- spTransform(px, CRS("+proj=longlat +datum=WGS84"))

plot(coordinates(llpx))

