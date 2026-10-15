    vertices <- c( 
          -1.0, -1.0, 0, 1.0,
           1.0, -1.0, 0.5, 1.0,
           1.0,  1.0, 0.5, 1.0,
          -1.0,  1.0, 0, 1.0
       )
       indices <- c( 1, 2, 3, 4 )
       
       open3d()  
       wire3d( qmesh3d(vertices, indices) )
       

library(raster)
library(raadtools)
#x <- readsst()
x <- raster("C:/temp/file.grd")
##for (i in seq(nrow(x))) x[i,] <- zoo::na.approx(x[i,])
r <- crop(x, extent(-180, 180, -90, 0), snap = "out")


m <- coordinates(r)
m0 <- NULL
for (i in c(-1, 1)) {
 for (j in c(-1, 1)) {
 	m1 <-  m + matrix(rep(res(r) * c(j, i), nrow(m))/2, ncol = 2, byrow = TRUE)
 	m1 <- cbind(m1, extract(r, m1, method = "bilinear"), 1)
	m0 <- cbind(m0,m1)
}
}

m0 <- m0[, c(1, 2, 3, 4, 9, 10, 11, 12,  13, 14, 15, 16, 5, 6, 7, 8)]
m0[,1:2] <- project(m0[,1:2], "+proj=laea +lat_0=-90")
m0[,5:6] <- project(m0[,5:6], "+proj=laea +lat_0=-90")
m0[,9:10] <- project(m0[,9:10], "+proj=laea +lat_0=-90")
m0[,13:14] <- project(m0[,13:14], "+proj=laea +lat_0=-90")

scl <- function(x) (x - min(x, na.rm = TRUE))/diff(range(x, na.rm = TRUE))

m <- t(m0)
i <- 1:(length(m)/4)
 open3d()  

cols <- sst.pal(rep(values(r), each = 4))
cols[is.na(cols)] <- "#FFFFFFFF"
      shade3d( qmesh3d(as.vector(m), i), col = cols)
       
