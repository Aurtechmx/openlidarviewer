# R terra reference for the DTM median gridding study.
# Run from the repository root:  Rscript --vanilla scripts/dtm-median-reference-terra.R
# Protocol: validation/protocols/dtm-median-gridding-v1.md
# Writes validation/cross-implementation/dtm-median/terra/<fixture>__median.asc
# (row 0 is the north row, NODATA -9999) and terra/reference-run.json.
suppressPackageStartupMessages(library(terra))
fix <- "validation/cross-implementation/pdal-pipeline/fixtures/"
out <- "validation/cross-implementation/dtm-median/terra/"
names <- c("pc-01-plane-buildings", "pc-02-rolling-buildings", "pc-03-ridge-buildings",
           "pc-04-plane-lowblunders", "pc-05-plane-gap", "pc-06-bare-plane",
           "pc-07-bare-rolling", "pc-08-bare-ridge")
template <- rast(ext(0, 50, 0, 50), resolution = 1, crs = "local")
rows <- character(0)
for (nm in names) {
  a <- read.csv(paste0(fix, nm, ".csv"))
  truth <- as.integer(strsplit(trimws(readChar(paste0(fix, nm, ".truth"), 1e7)), "")[[1]])
  sel <- a[truth == 1, ]
  v <- vect(sel, geom = c("X", "Y"), crs = "local")
  v$z <- sel$Z
  r <- rasterize(v, template, field = "z", fun = median)
  m <- as.matrix(r, wide = TRUE)  # row 1 is the north row
  path <- paste0(out, nm, "__median.asc")
  con <- file(path, "w")
  writeLines(c("ncols 50", "nrows 50", "xllcorner 0", "yllcorner 0", "cellsize 1", "NODATA_value -9999"), con)
  for (i in 1:50) writeLines(paste(ifelse(is.na(m[i, ]), "-9999", sprintf("%.9f", m[i, ])), collapse = " "), con)
  close(con)
  h <- system2("shasum", c("-a", "256", path), stdout = TRUE)
  rows <- c(rows, sprintf('    {"fixture": "%s", "returns": %d, "path": "%s", "sha256": "%s"}',
                          nm, nrow(sel), path, sub(" .*", "", h)))
}
js <- c("{",
  '  "tool": "terra::rasterize",', '  "fun": "median",',
  sprintf('  "R": "%s",', paste(R.version$major, R.version$minor, sep = ".")),
  sprintf('  "terra": "%s",', as.character(packageVersion("terra"))),
  sprintf('  "gdal": "%s",', gdal()),
  sprintf('  "platform": "%s",', R.version$platform),
  '  "commandLine": "Rscript --vanilla scripts/dtm-median-reference-terra.R",',
  '  "outputs": [', paste(rows, collapse = ",\n"), "  ]", "}")
writeLines(js, paste0(out, "reference-run.json"))

# Protocol v2 (validation/protocols/dtm-median-gridding-v2.md): cell sizes
# 0.25, 0.5, 2 and 5 m, input shifted by (+0.37, +0.61) m, origin at the data
# minimum and extent from the rasterizeDtm rule. Writes
# terra/cell<s>/<fixture>__median.asc and terra/reference-run-v2.json.
rows2 <- character(0)
for (s in c(0.25, 0.5, 2, 5)) {
  dir <- paste0(out, "cell", s, "/")
  dir.create(dir, showWarnings = FALSE)
  for (nm in names) {
    a <- read.csv(paste0(fix, nm, ".csv"))
    truth <- as.integer(strsplit(trimws(readChar(paste0(fix, nm, ".truth"), 1e7)), "")[[1]])
    sel <- a[truth == 1, ]
    x <- sel$X + 0.37
    y <- sel$Y + 0.61
    ox <- min(x); oy <- min(y)
    nc <- floor((max(x) - ox) / s) + 1
    nr <- floor((max(y) - oy) / s) + 1
    tpl <- rast(ext(ox, ox + nc * s, oy, oy + nr * s), ncols = nc, nrows = nr, crs = "local")
    v <- vect(data.frame(x = x, y = y, z = sel$Z), geom = c("x", "y"), crs = "local")
    r <- rasterize(v, tpl, field = "z", fun = median)
    m <- as.matrix(r, wide = TRUE)
    path <- paste0(dir, nm, "__median.asc")
    con <- file(path, "w")
    writeLines(c(sprintf("ncols %d", nc), sprintf("nrows %d", nr), sprintf("xllcorner %.17g", ox),
                 sprintf("yllcorner %.17g", oy), sprintf("cellsize %.17g", s), "NODATA_value -9999"), con)
    for (i in 1:nr) writeLines(paste(ifelse(is.na(m[i, ]), "-9999", sprintf("%.9f", m[i, ])), collapse = " "), con)
    close(con)
    h <- system2("shasum", c("-a", "256", path), stdout = TRUE)
    rows2 <- c(rows2, sprintf('    {"fixture": "%s", "cellSize": %s, "returns": %d, "path": "%s", "sha256": "%s"}',
                              nm, s, nrow(sel), path, sub(" .*", "", h)))
  }
}
js2 <- c("{",
  '  "tool": "terra::rasterize",', '  "fun": "median",',
  '  "protocol": "validation/protocols/dtm-median-gridding-v2.md",',
  sprintf('  "R": "%s",', paste(R.version$major, R.version$minor, sep = ".")),
  sprintf('  "terra": "%s",', as.character(packageVersion("terra"))),
  sprintf('  "gdal": "%s",', gdal()),
  sprintf('  "platform": "%s",', R.version$platform),
  '  "commandLine": "Rscript --vanilla scripts/dtm-median-reference-terra.R",',
  '  "outputs": [', paste(rows2, collapse = ",\n"), "  ]", "}")
writeLines(js2, paste0(out, "reference-run-v2.json"))
