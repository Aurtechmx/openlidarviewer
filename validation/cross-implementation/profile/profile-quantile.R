#!/usr/bin/env Rscript
# profile-quantile.R — the statistical half of the MEAS-PROFILE reference.
#
# Reads the corridor table produced by OGR / SpatiaLite (one row per point that
# survived the corridor and classification gates, carrying the bin it fell in and
# its elevation VERBATIM from the fixture) and reduces each bin with R's type-7
# quantile. Type 7 is R's default and the definition the sampler names; using the
# implementation the definition comes from is the point of this stage.
#
# A station with no rows is written NA. Nothing is interpolated across it.
#
# usage: Rscript profile-quantile.R <corridor.csv> <out.csv> <stations> <p1,p2,...>

args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 4L) {
  stop("usage: profile-quantile.R <corridor.csv> <out.csv> <stations> <percentiles>")
}

corridor <- read.csv(args[1], colClasses = c(bin = "integer", z = "numeric"))
outPath <- args[2]
stations <- as.integer(args[3])
ps <- as.numeric(strsplit(args[4], ",")[[1]])

groups <- split(corridor$z, factor(corridor$bin, levels = seq_len(stations) - 1L))

fmt <- function(i) {
  v <- groups[[i]]
  q <- if (length(v) == 0L) rep(NA_real_, length(ps)) else quantile(v, ps / 100, type = 7, names = FALSE)
  paste(c(
    format(i - 1L),
    format(length(v)),
    ifelse(is.na(q), "NA", sprintf("%.17g", q))
  ), collapse = ",")
}

writeLines(
  c(paste(c("station", "count", sprintf("p%g", ps)), collapse = ","),
    vapply(seq_along(groups), fmt, character(1))),
  outPath
)
