# accuracy-stats.R — recompute the accuracy statistics outside TypeScript.
#
# The point of this leg is that the second implementation is not the first one
# in a different file. R has its own numerics, its own quantile machinery and
# its own accumulation order, so agreement here says something a second
# TypeScript function could not.
#
# Base R only, deliberately. Every function used below ships with R itself, so
# the result does not depend on which CRAN mirror was reachable on the day, and
# a reader can audit the whole dependency surface by reading this file.
#
# Definitions, stated here because a statistic named in prose is not a
# specification:
#
#   bias    mean of the signed residuals
#   rmse    sqrt(mean(residual^2)), the raw second moment, NOT sd()
#           sd() divides by n-1 and subtracts the mean; neither belongs in an
#           accuracy figure, and using it is the classic way this number comes
#           out slightly wrong and looks right
#   nmad    1.4826 * median(|r - median(r)|)
#   p95     quantile(|r|, 0.95, type = 7), R's default, interpolated
#   p95nr   the nearest-rank alternative, reported alongside so a convention
#           difference is visible rather than mistaken for an error
#   nva95   1.96 * rmse, the ASPRS normal-theory figure
#
# Usage:  Rscript accuracy-stats.R <residuals.csv> <out.json>

args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 2L) stop("usage: accuracy-stats.R <residuals.csv> <out.json>")

input <- args[[1]]
output <- args[[2]]

d <- read.csv(input, stringsAsFactors = FALSE)
if (!all(c("case_id", "residual") %in% names(d))) {
  stop("input must have columns case_id and residual")
}

# A JSON writer, so the script needs no package to emit its result.
num <- function(x) {
  if (!is.finite(x)) return("null")
  formatC(x, digits = 17, format = "g")
}

stats_for <- function(r) {
  n <- length(r)
  bias <- mean(r)
  rmse <- sqrt(mean(r^2))
  med <- median(r)
  nmad <- 1.4826 * median(abs(r - med))
  a <- abs(r)
  p95 <- unname(quantile(a, 0.95, type = 7))
  # Nearest rank: the smallest value at or above the 95th position, ceiling-indexed.
  p95nr <- sort(a)[max(1L, ceiling(0.95 * n))]
  p90 <- unname(quantile(a, 0.90, type = 7))
  list(
    n = n,
    bias = bias,
    rmse = rmse,
    medianResidual = med,
    nmad = nmad,
    p95AbsResidual = p95,
    p95AbsResidualNearestRank = p95nr,
    p90AbsResidual = p90,
    maxAbsResidual = max(a),
    nva95 = 1.96 * rmse
  )
}

ids <- unique(d$case_id)
parts <- character(0)

for (id in ids) {
  r <- d$residual[d$case_id == id]
  s <- stats_for(r)
  body <- paste0(
    '{"caseId":"', id, '"',
    ',"n":', s$n,
    ',"bias":', num(s$bias),
    ',"rmse":', num(s$rmse),
    ',"medianResidual":', num(s$medianResidual),
    ',"nmad":', num(s$nmad),
    ',"p95AbsResidual":', num(s$p95AbsResidual),
    ',"p95AbsResidualNearestRank":', num(s$p95AbsResidualNearestRank),
    ',"p90AbsResidual":', num(s$p90AbsResidual),
    ',"maxAbsResidual":', num(s$maxAbsResidual),
    ',"nva95":', num(s$nva95),
    '}'
  )
  parts <- c(parts, body)
}

json <- paste0(
  '{\n',
  '  "schemaVersion": 1,\n',
  '  "generatedBy": "validation/external-oracles/statistics/r/accuracy-stats.R",\n',
  '  "oracleId": "r-4.6.1",\n',
  '  "rVersion": "', R.version.string, '",\n',
  '  "quantileType": 7,\n',
  '  "nva95Multiplier": 1.96,\n',
  '  "note": "Base R only. rmse is sqrt(mean(r^2)), not sd(): sd divides by n-1 and removes the mean, and neither belongs in an accuracy figure.",\n',
  '  "results": [\n    ', paste(parts, collapse = ",\n    "), '\n  ]\n',
  '}\n'
)

writeLines(json, output)
cat("accuracy-stats.R: wrote", length(ids), "case(s) to", output, "\n")
