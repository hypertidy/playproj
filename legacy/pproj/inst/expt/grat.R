	limfun <- function(x, lim, nd = 60, meridian = TRUE) {
            ind <- 1:2
            if (!meridian) ind <- 2:1
		cbind(x, seq(lim[1], lim[2], length = nd))[, ind]
        }

easts <- c(100, 150, 220)
norths <- c(-70, -50, -30)

	
gtcl <- function(easts, norths) {
        ylim <- range(norths)
        xlim <- range(easts)
	xlines <- lapply(easts, limfun, lim = ylim, meridian = TRUE)
	ylines <- lapply(norths, limfun, lim = xlim, meridian = FALSE)
	xs <- do.call("rbind", lapply(seq_along(xlines), function(xx) {
            res <- data.frame(xlines[[xx]], rep(xx, nrow(xlines[[xx]])), Sys.time() + seq( nrow(xlines[[xx]])))
            names(res) <- c("x", "y", "id", "time")
            res
        }))
        ys <- do.call("rbind", lapply(seq_along(ylines), function(xx) {
            res <- data.frame(ylines[[xx]], rep(xx, nrow(ylines[[xx]])) + max(xs$id), Sys.time() + seq( nrow(ylines[[xx]])))
            names(res) <- c("x", "y", "id", "time")
            res
        }))
        d <- rbind(xs, ys)
        coordinates(d) <- ~x+y
        proj4string(d) <- CRS("+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs +towgs84=0,0,0")
         as(trip(d, c("time", "id")), "SpatialLinesDataFrame")
               
}

 gtcl(easts, norths)

