v0.5.9 begins Contour Studio: a post-analysis workflow that turns a correctly analyzed LiDAR scan into an evidence-aware contour deliverable, kept out of the crowded analysis panel. This build lands the first foundation for that workflow together with a batch of scientific-correctness and honesty fixes that stand on their own.

v0.5.8 tied every output to the build, method, and unit assumptions that produced it. v0.5.9 carries that discipline into terrain deliverables and into the validation path behind them.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Contour Studio foundation

A pure, tested launch-state core now decides whether the deliverable launcher should be hidden, disabled, offered as exploratory, or offered as a full deliverable, using only facts the analysis already produced. Hard blockers (no terrain surface, no ground source, an area that is mostly unsupported) outrank soft caps (unknown vertical units, a geographic CRS, an incomplete stream, no recommended interval, sparse support). The core carries no UI or rendering dependencies, so it is testable without a browser and keeps the science layer clean.

This build ships the launcher and workspace, not just the core. After analysis, a Terrain Products surface leads the panel with the Contour Studio launcher; opening it reveals purpose presets, a unit-aware review, an evidence ladder, and a single premium export section that routes to the viewer's existing contour, DEM, and terrain-report exporters. Selecting a purpose is real: it regenerates the exported contour geometry (Survey Review = exact analytical isolines; the cartographic purposes = generalized) and stamps the geometry method + purpose into the file's provenance. The evidence resolver is now the enforced production caller for these exports: Contour Studio vector exports (GeoJSON, DXF, SVG) and the contour map-PDF are now minted through the central contour export permit and evidence resolver — a blocked permit refuses the export and the decision is stamped into provenance. The DEM raster package is routed through the same resolver (DTM claim). A "Complete (ZIP)" deliverable bundles the contours (GeoJSON), the DTM raster, a multipage Contour Studio PDF, provenance, a README, and a verifying SHA256SUMS. The terrain intelligence report still uses its own gate. What remains for a *complete* Contour Studio: the launcher still lives inside the analysis panel rather than a separate app-shell surface, and the DEM/report products are not yet folded under the single evidence resolver.

## Validation correctness

Hold-out RMSE can now re-run ground classification per fold with the held-out points excluded, which removes the classify-before-split optimism when a classifier is injected. The surface fit was already train-only; the remaining leak was the classification step, and it is now removable and provably removed under test. Shipped terrain products still run the full-cloud path until the analyser passes the hook, and that limitation stays disclosed.

Confidence calibration no longer reports its quality on the same samples it was fit on. Reported reliability and Brier score are computed by deterministic K-fold cross-fitting, so no sample is scored by a calibrator trained on it.

## Unit honesty

Picked-point elevation stops asserting metres it does not know. A foot vertical datum prints feet, a metre datum prints metres, and an unknown or local vertical scale prints no suffix rather than a fabricated metre value. Space reports no longer label unknown-scale data as "metres (assumed)".

## Evidence gate coverage

Measurements CSV, the integrity report, and the map-sheet PDF now route their claim status through the one central evidence gate instead of exporting ungated. Unvalidated products carry the exploratory status honestly; nothing is promoted to validated that the registry does not support.

## Registration

Change-detection alignment gains trimmed ICP with a median-based warm-start, so a gross blunder or scattered outliers no longer collapse the fit. Diagnostics report the inlier fraction over the whole cloud and the kept-set residual, without hiding rejected outliers.

## What this build does not claim

v0.5.9 is not a survey-certification release, and Contour Studio is not yet a complete, shipped feature.

> The Contour Studio launcher, workspace, and purpose-driven exports ship and work, and the central export permit / evidence resolver is now the enforced production caller for the vector exports (GeoJSON, DXF, SVG), the contour map-PDF, and the DEM raster package (DTM claim). What still does not ship: the dedicated multipage Contour Studio PDF and moving the launcher fully outside the analysis panel. The validation classify-in-fold fix is a mechanism the shipped analyser does not call yet. All of these are disclosed rather than presented as finished.

## Deploy

Static files. Host on GitHub Pages, Netlify, a static CDN, or any conventional web host.

## Citing this release

Cite OpenLiDARViewer with the metadata in `CITATION.cff`:

- Version: 0.5.9
- Release date: 2026-07-09
- License: MIT

When the tagged release is archived on Zenodo, cite the version DOI assigned to that snapshot.

Live demo: <https://lidar.aurtech.mx/>  
GitHub: <https://github.com/Aurtechmx/openlidarviewer>

Open Source • Open Data • Open Exploration
