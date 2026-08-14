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

## Layer B — instrument fidelity (feasibility characterised; blocked on detection method)

Goal: RANSAC sphere-centre detection per scanner, then OLV-measured inter-sphere
distances vs the surveyed network → a per-instrument accuracy table.

**Feasibility findings (laspy + scipy, on the real clouds):**

- The "Koule" targets are physical spheres of radius **≈217 mm** (from clean fits),
  present in the dense clouds but **occlusion-limited** — only ~5 of 12 spheres have
  usable returns in the LA03 mobile scan; the rest are occluded (0 points).
- **iPhone (2.2M pts) cannot recover the spheres** — near the surveyed centres it has
  only sparse, flat ground-like points (e.g. Koule08: 25 pts spanning 3 cm in Z,
  nearest 10 cm away). Recorded as a detection failure, not forced.
- **The forest confounds a fixed-radius fit:** tree trunks have ~the same radius as
  the spheres, so a robust fixed-R sphere fit locks onto nearby trunks. On LA03 this
  gave centre offsets of 5–21 cm from surveyed and a 36 mm-RMSE distance network —
  contaminated by trunk mis-detections, NOT a valid instrument-accuracy result. It is
  deliberately not reported as one.

**What a rigorous Layer B needs (next):** sphere-vs-cylinder discrimination (full 3D
curvature, not radius alone), and the survey-grade TLS cloud (345M pts, 4.5 GB) where
the sphere surface is dense enough to separate a ball from a trunk. That is a real
detection-method effort on a multi-GB cloud, staged as its own task. Until then Layer B
is characterised but not graded — no E-level claim is made from a confounded fit.
