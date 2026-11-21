## Rain on grid: a 30 minute, 60 mm/h storm on a 1.2 km tile of the
## Tasmania 2 m DEM around McRobies Gully (Hobart), then 10 minutes of
## drainage. Open boundaries on all four edges. Manning n = 0.05 everywhere
## (no land cover, no infiltration, no drains): this is a test of the
## solver on real terrain, for illustration only, not survey, engineering
## or planning data.
##
## Usage: Rscript mcrobies-storm.R [outdir] [aggregate_factor]
suppressMessages({library(shallows); library(terra)})
args <- commandArgs(TRUE)
out <- if (length(args) >= 1) args[1] else "mcrobies-storm"
fact <- if (length(args) >= 2) as.integer(args[2]) else 2L
dir.create(out, showWarnings = FALSE, recursive = TRUE)

dsn <- "/vsicurl/https://data.source.coop/alexgleith/tasmania-dem-2m/Tasmania_Statewide_2m_DEM_14-08-2021.tif"
centre <- c(523427, 5251627)  # EPSG:28355, McRobies Gully tip floor (147.2869 E, 42.8876 S)
dem <- crop(rast(dsn), ext(centre[1] + c(-600, 600), centre[2] + c(-600, 600)))
if (fact > 1) dem <- aggregate(dem, fact)
writeRaster(dem, file.path(out, "bed.tif"), overwrite = TRUE)

rain <- 60 / 1000 / 3600  # 60 mm/h in m/s
st <- sw_state_from <- sw_from_rast(dem, h = 0, manning = 0.05, rain = rain)
t1 <- system.time(r1 <- sw_run(st, times = seq(60, 1800, by = 60), order = 2, bc = "open"))
st2 <- sw_continue(r1, rain = 0)
t2 <- system.time(r2 <- sw_run(st2, times = seq(60, 600, by = 60), order = 2, bc = "open"))

## depth frames with CRS, one layer per minute
h1 <- sw_rast(r1, "h"); h2 <- sw_rast(r2, "h")
terra::time(h2) <- terra::time(h2) + 1800
names(h2) <- sprintf("h_t%gs", 1800 + r2$diag$time)
h <- c(h1, h2)
writeRaster(h, file.path(out, "depth.tif"), overwrite = TRUE)
hmax <- max(h)
writeRaster(hmax, file.path(out, "depth_max.tif"), overwrite = TRUE)
writeRaster(c(sw_rast(r1, "speed")[[30]], sw_rast(r2, "speed")[[10]]),
            file.path(out, "speed_30_40min.tif"), overwrite = TRUE)

d <- rbind(transform(r1$diag, phase = "rain"),
           transform(r2$diag, phase = "drain", time = time + 1800,
                     outflow = outflow + r1$diag$outflow[30], rain = rain + r1$diag$rain[30]))
write.csv(d, file.path(out, "budget.csv"), row.names = FALSE)
cat(sprintf("cells %d x %d at %g m; steps %d + %d; wall time %.0f + %.0f s\n",
            nrow(dem), ncol(dem), res(dem)[1], max(r1$diag$steps), max(r2$diag$steps), t1[3], t2[3]))
cat(sprintf("rain in %.0f m3, out through edges %.0f m3, stored %.0f m3, max relative budget error %.1e\n",
            max(d$rain), max(d$outflow), d$volume[nrow(d)],
            max(abs(c(r1$diag$rel_budget_error, r2$diag$rel_budget_error)))))

## figure
caveat <- "For illustration only: not survey, engineering or planning data. Bed: Tasmania 2 m DEM (2021). Uniform n = 0.05, no infiltration or drains."
png(file.path(out, "mcrobies-storm.png"), width = 1800, height = 1100, res = 150)
layout(matrix(c(1, 2, 3, 4, 4, 4), 2, byrow = TRUE), heights = c(2.3, 1.5))
par(mar = c(2, 2, 3, 5))
sl <- terrain(dem, "slope", unit = "radians"); as <- terrain(dem, "aspect", unit = "radians")
hs <- shade(sl, as, 40, 300)
pal <- hcl.colors(50, "Blues 3", rev = TRUE)
show <- function(x, main) {
  plot(hs, col = grey(0:100 / 100), legend = FALSE, axes = FALSE, main = main, mar = c(1, 1, 3, 5))
  x[x < 0.01] <- NA
  plot(x, col = pal, add = TRUE, alpha = 0.85, range = c(0.01, 1), plg = list(title = "depth m"))
}
show(h1[[10]], "depth at 10 min")
show(h1[[30]], "depth at 30 min (rain stops)")
show(hmax, "maximum depth, 0 to 40 min")
par(mar = c(7, 5, 2, 5))
tt <- c(0, d$time) / 60
plot(tt, c(0, d$rain), type = "l", lty = 2, xlab = "minutes", ylab = "m3",
     main = "water budget of the tile", ylim = c(0, max(d$rain)))
lines(tt, c(0, d$volume), col = "steelblue", lwd = 2)
lines(tt, c(0, d$outflow), col = "firebrick", lwd = 2)
legend("topleft", c("rain in (cumulative)", "stored on the tile", "out through edges (cumulative)"),
       lty = c(2, 1, 1), col = c("black", "steelblue", "firebrick"), lwd = c(1, 2, 2), bty = "n")
mtext(caveat, side = 1, line = 5.2, cex = 0.75)
dev.off()
