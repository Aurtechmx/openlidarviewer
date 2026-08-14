# Sphere absolute-accuracy study (SP2)

Real-data validation of OLV's distance measurement against a surveyed reference
network, per instrument. Design: `docs/superpowers/specs/2026-08-14-sphere-accuracy-study-design.md`.

## Source data

- **Dataset:** "LiDAR Scanners Comparison – Point Clouds", Zenodo DOI [10.5281/zenodo.15421291](https://doi.org/10.5281/zenodo.15421291). A Czech forest DBH plot in EPSG:5514 (S-JTSK / Krovák East-North).
- **Reference network:** `spheres-epsg5514.csv` — 12 surveyed "Koule" reference spheres plus one control point ("Auto"), extracted from the dataset's `GroundTruth.xlsx` (`ReferencePoints` sheet). Coordinates are the surveyed EPSG:5514 easting/northing/height, in metres. These are the ground truth; the raw point clouds are NOT committed (4.5 GB TLS).

All distances are computed in **native EPSG:5514 metres** (Krovák is conformal at ~unit scale here), so no datum transform enters the measurement.

## Layer A — engine correctness (DONE, gated)

`tests/sphereAccuracyLayerA.test.ts` reproduces the surveyed inter-sphere distance
network through OLV's own measurement path (`geometry.distance` + the unit engine),
in an origin-subtracted Float32 local frame that mirrors the renderer. This confirms
OLV measures the large-magnitude negative Krovák coordinates without precision loss,
matching the surveyed network to sub-millimetre. Reproducible, no cloud processing.

## Layer B — instrument fidelity (PENDING)

Per scanner (iPhone, LA03, then ZEB, TLS): RANSAC sphere-centre detection from the
actual points (reference tool — PDAL/Python), OLV-measured inter-sphere distances
between detected centres, compared to the surveyed network → a per-instrument
accuracy table. Detection commands, tool versions, detected centres + residuals,
and md5s will be recorded here. Staged small-cloud-first.
