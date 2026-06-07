# OpenLiDARViewer v0.4.1

Terrain analysis comes of age, plus a point-cloud format converter — all still
browser-native, local-first, nothing uploaded.

## Highlights

- **Terrain Assessment** — one top-level verdict (Good / Preview / Limited) at
  the top of the Analyse panel, with the 0–100 quality score folded into the
  headline (e.g. "Preview · 64/100"), a one-line reason, what the surface is
  best for, and a caution where relevant. It speaks to data quality and
  fitness-for-use — it does not claim survey-grade output.
- **DEM export (ZIP)** — one click downloads the elevation rasters: bare-earth
  DTM, top-surface DSM, and canopy height (CHM), each as both an Esri ASCII Grid
  (.asc) and a georeferenced Float32 GeoTIFF (.tif), with a .prj sidecar and a
  metadata README (CRS, vertical datum, cell size, RMSEz / NVA / VVA, USGS
  Quality Level, coverage). Drops straight into QGIS / ArcGIS / GDAL.
- **Surface models** — DSM, canopy height, slope, and a multi-directional
  hillshade with an adjustable sun (azimuth + altitude); re-lighting is instant.
- **Click-to-sample** — click any analysed raster to read the bare-earth
  elevation, slope, and above-ground height at that cell.
- **Point-cloud format converter** — batch-convert LAS / LAZ / XYZ / ASC from
  the start screen, plus an in-project Export panel, with a CRS assign/reproject
  step and vertical-datum detection.
- **Contours & map sheet** — evidence-graded contours (GeoJSON / SVG / DXF) and
  a printable, georeferenced map sheet with graticule, scale bar, north arrow,
  and an accuracy block.
- **Quality hardening** — composite 0–100 terrain quality score; outlier-rejection
  DTM; hold-out RMSE stratified by slope and surface zone; and an extrapolation
  guard that demotes one-sided (unbracketed) DTM fills toward dashed/gap instead
  of letting them read as trusted.

## Polish

- Cross-section profile chart: nice-number elevation axis (e.g. 120 · 125 · 130)
  with gridlines, and all numerals in JetBrains Mono with tabular figures via a
  positioned overlay so the axis text stays crisp at any chart height.
- Distance measurements report a compass bearing; bare-earth elevation
  histogram; resizable Measurements panel; classification-aware profiles.
- An "Analyse" tool-dock button so the panel always reopens; the bottom-centre
  navigation control stays clickable where the dock and nav meet.
- Typography refresh: Manrope (text) + JetBrains Mono (figures), self-hosted,
  with tabular figures across the data panels.

See [CHANGELOG.md](./CHANGELOG.md) for the full list.

## Deploy

Static files — host anywhere (GitHub Pages, Netlify, any CDN). The deploy zip
extracts with web-safe permissions (644 files / 755 directories) and carries
`index.html` plus `assets/` at the archive root.
