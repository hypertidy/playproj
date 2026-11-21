## Validation against analytic solutions. Writes validation.png and
## validation.csv to the output directory.
## Usage: Rscript validation.R [outdir]
suppressMessages(library(shallows))
args <- commandArgs(TRUE)
out <- if (length(args) >= 1) args[1] else "validation"
dir.create(out, showWarnings = FALSE, recursive = TRUE)
rows <- list()

## 1. dam breaks along x, domain [-500, 500] m, t = 20 s
dam <- function(case, nx, order) {
  dx <- 1000 / nx; x <- -500 + (seq_len(nx) - 0.5) * dx
  h0 <- ifelse(x < 0, 10, if (case == "stoker") 2 else 0)
  r <- sw_run(sw_state(matrix(0, 1, nx), h = matrix(h0, 1, nx), dx = dx), 20, order = order, bc = "open")
  ex <- if (case == "stoker") dambreak_stoker(x, 20, 10, 2) else dambreak_ritter(x, 20, 10)
  list(x = x, h = r$h[[1]][1, ], ex = ex,
       row = data.frame(case = case, n = nx, order = order, L1_h = mean(abs(r$h[[1]][1, ] - ex$h)),
                        rel_budget_error = max(abs(r$diag$rel_budget_error))))
}
prof <- list()
for (case in c("stoker", "ritter")) for (nx in c(100, 200, 400, 800)) for (o in 1:2) {
  a <- dam(case, nx, o); rows[[length(rows) + 1]] <- a$row
  if (nx == 200) prof[[paste(case, o)]] <- a
}

## 2. lake at rest with emergent islands (well balancing)
n <- 100; ij <- expand.grid(i = 1:n, j = 1:n); set.seed(1)
z <- matrix(0.6 * exp(-((ij$i - 30)^2 + (ij$j - 40)^2) / 80) +
            0.8 * exp(-((ij$i - 70)^2 + (ij$j - 65)^2) / 200) + 0.05 * runif(n * n), n, n)
for (o in 1:2) {
  r <- sw_run(sw_state(z, eta = 0.5), 100, order = o)
  wet <- r$h[[1]] > 0
  rows[[length(rows) + 1]] <- data.frame(case = "lake_at_rest", n = n, order = o,
    L1_h = max(abs(r$h[[1]][wet] + z[wet] - 0.5)), rel_budget_error = max(abs(r$diag$rel_budget_error)))
}

## 3. Thacker planar surface in a paraboloid (moving shoreline), 3 periods
P <- thacker_bowl(0, 0, 0)$period
thk <- list()
for (n in c(50, 100, 200)) for (o in 1:2) {
  dx <- 4 / n; x <- -2 + (seq_len(n) - 0.5) * dx
  X <- matrix(x, n, n, byrow = TRUE); Y <- matrix(x, n, n)
  a0 <- thacker_bowl(X, Y, 0)
  r <- sw_run(sw_state(a0$z, h = a0$h, hu = a0$h * a0$u, hv = a0$h * a0$v, dx = dx),
              times = P * c(0.25, 0.5, 3), order = o)
  e <- sum(abs(r$h[[3]] - thacker_bowl(X, Y, 3 * P)$h)) * dx^2 / sum(a0$h * dx^2)
  rows[[length(rows) + 1]] <- data.frame(case = "thacker_3_periods", n = n, order = o, L1_h = e,
                                         rel_budget_error = max(abs(r$diag$rel_budget_error)))
  if (n == 100 && o == 2) thk <- list(x = x, r = r, X = X, Y = Y, z = a0$z)
}
tab <- do.call(rbind, rows)
write.csv(tab, file.path(out, "validation.csv"), row.names = FALSE)
print(tab, digits = 3)

png(file.path(out, "validation.png"), width = 1800, height = 1200, res = 150)
par(mfrow = c(2, 2), mar = c(4.5, 4.5, 3, 1))
for (case in c("stoker", "ritter")) {
  a1 <- prof[[paste(case, 1)]]; a2 <- prof[[paste(case, 2)]]
  plot(a1$ex$x, a1$ex$h, type = "l", lwd = 2, xlab = "x (m)", ylab = "depth (m)",
       main = sprintf("%s dam break, t = 20 s, 200 cells", if (case == "stoker") "Stoker (wet)" else "Ritter (dry)"))
  lines(a1$x, a1$h, col = "darkorange", lwd = 1.5)
  lines(a2$x, a2$h, col = "steelblue", lwd = 1.5, lty = 2)
  legend("topright", c("analytic", "order 1", "order 2"), col = c("black", "darkorange", "steelblue"),
         lty = c(1, 1, 2), lwd = 2, bty = "n")
}
## Thacker: section along x through the centre at 1/4, 1/2 and 3 periods
k0 <- which.min(abs(thk$x))
plot(thk$x, thk$z[k0, ], type = "l", col = "grey40", lwd = 2, ylim = c(-0.1, 0.06),
     xlab = "x (m)", ylab = "elevation (m)", main = "Thacker bowl, section y = 0, 100 x 100, order 2")
cols <- c("darkorange", "steelblue", "firebrick")
for (k in 1:3) {
  tk <- thk$r$diag$time[k]
  ex <- thacker_bowl(thk$x, thk$x[k0], tk)
  wet <- ex$h > 0
  lines(thk$x[wet], (ex$h + ex$z)[wet], col = cols[k], lwd = 2)
  h <- thk$r$h[[k]][k0, ]; w <- h > 1e-4
  points(thk$x[w], (h + thk$z[k0, ])[w], col = cols[k], pch = 20, cex = 0.5)
}
legend("top", c("T/4", "T/2", "3T", "lines analytic, dots model"), col = c(cols, NA),
       lwd = c(2, 2, 2, NA), bty = "n", ncol = 2, cex = 0.8)
## convergence
sub <- tab[tab$case != "lake_at_rest", ]
plot(NA, xlim = range(sub$n), ylim = range(sub$L1_h), log = "xy", xlab = "cells across",
     ylab = "L1 depth error (dam: m, Thacker: relative)", main = "convergence")
k <- 0
for (case in unique(sub$case)) for (o in 1:2) {
  k <- k + 1; s <- sub[sub$case == case & sub$order == o, ]
  lines(s$n, s$L1_h, type = "b", pch = o, col = c("darkorange", "steelblue", "firebrick")[(k + 1) %/% 2], lty = o)
}
legend("bottomleft", c("stoker", "ritter", "thacker", "order 1", "order 2"),
       col = c("darkorange", "steelblue", "firebrick", 1, 1), lty = c(1, 1, 1, 1, 2), pch = c(NA, NA, NA, 1, 2), bty = "n", cex = 0.8)
dev.off()
