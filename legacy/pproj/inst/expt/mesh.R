library(rgl)
xyz <- cbind(runif(680, 1, nrow(volcano)), runif(680, 1, ncol(volcano)))
xyz <- cbind(xyz, volcano[xyz])
ind <-  t(geometry::delaunayn(xyz[,1:2]))
f <- 1/5
clear3d()
triangles3d(xyz[ind, 1], xyz[ind, 2], xyz[ind, 3] * f, col = "white")
rglwidget()
