sinbin <- function(nrows = 12) {
  library(roc)
  library(sp)
  ##library(rgdal)
  library(geosphere)


  ibin <- initbin(nrows)
  xl <- bin2bounds(seq_len(ibin$totbins), nrows)
  
  densifymindist <- function(x, mindist, longlat = longlat) {
    if (missing(mindist)) {
      warning("No minimum distance specified, no densifying done")
      return(x)
    }
    
    dist <- spDistsN1(x[1L,,drop=FALSE], x[2L,,drop=FALSE], longlat = TRUE)
    if (dist >= mindist) {
      n <- dist %/% mindist
      x <- gcIntermediate(x[1L,], x[2L,], n = n, addStartEnd = TRUE)
    }
    x
    
  }
  bounds2poly <- function(x, bins) {
    x <- do.call(cbind, x)
    v <- vector("list", nrow(x))
    for (i in seq_len(nrow(x))) {
      m <- as.matrix(expand.grid(x[i,c(1, 3)], x[i,c(2, 4)]))[c(1, 3, 4, 2, 1), ]
      ##ml <- vector("list", nrow(m) - 1)
      ##for (j in seq_along(ml)) ml[[j]] <- densifymindist(m[j:(j+1), ], 100, longlat = TRUE)
      ##lapply(ml, lines)
      ##v[[i]] <- Polygons(list(Polygon(do.call(rbind, ml))), as.character(i))
      v[[i]] <- Polygons(list(Polygon(m)), as.character(i))
    }
    
    SpatialPolygonsDataFrame(SpatialPolygons(v, proj4string = CRS("+proj=longlat +ellps=WGS84")), data = data.frame(bin = bins))
  }

  px <- bounds2poly(xl, seq_len(ibin$totbins))
  px
  
}
  ##x <- spTransform(px, CRS("+proj=sinu"))

##plot(x)
