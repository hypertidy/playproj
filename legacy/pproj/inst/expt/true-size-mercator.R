## mercator
## https://twitter.com/neilrkaye/status/1050722881657864192


library(sf)
map <- st_geometry(rnaturalearth::ne_countries(returnclass = "sf"))
## just crop slightly in longitude to avoid the wrap
## but crop a lot to avoid the infinity at the south pole
map <- st_cast(st_cast(st_crop(map, st_bbox(map) + c(-1/1e6, 1.5, -1/1e6, 0))), "POLYGON")
## (and break up multipolygons so each gets moved by its own centre)
merc <- st_transform(map, "+proj=merc +datum=WGS84")
merc_cent <- st_centroid(merc)
mercmat <- st_coordinates(merc_cent)
ll_cent <- st_transform(merc_cent, "+init=epsg:4326")
llmat <- st_coordinates(ll_cent)

lp <- lapply(seq_along(map), function(i) 
  st_transform(map[i], sprintf("+proj=laea +lon_0=%f +lat_0=%f", llmat[i, 1], llmat[i, 2]))[[1]])

new_cent <- do.call(rbind, lapply(lp, function(cc) st_coordinates(st_centroid(cc))))

poly_on_merc <- st_sfc(lapply(seq_along(lp), function(i) lp[[i]] + (  mercmat[i, 1:2] - new_cent[i,1:2] )))

par(mar = rep(0, 4))
plot(merc, reset = TRUE, col = "grey")
plot(poly_on_merc, add = T, col = rgb(0, 0, 0.5, alpha = 0.6))
