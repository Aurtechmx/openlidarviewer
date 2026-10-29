# Sphere absolute-accuracy study (SP2)

Real-data validation of OLV's distance measurement against a surveyed reference
network, per instrument.

## Source data

- **Dataset:** "LiDAR Scanners Comparison – Point Clouds", Zenodo DOI [10.5281/zenodo.15421291](https://doi.org/10.5281/zenodo.15421291). A Czech forest DBH plot in EPSG:5514 (S-JTSK / Krovák East-North).
- **Reference list:** `spheres-epsg5514.csv`: the 13 entries of the `ReferencePoints` sheet of the dataset's `GroundTruth.xlsx`, 12 "Koule" spheres plus the control point "Auto", as published EPSG:5514 easting, northing and height in metres, rounded to 6 decimals (largest difference from the workbook text 5.0e-7 m, checked by `npm run validate:zenodo-small`). The other sheet, `TreesPoints` (236 trees), is not used. The published decimals are not a statement of survey accuracy. The raw point clouds are not committed.

All distances are computed in **native EPSG:5514 metres** (Krovák is conformal at ~unit scale here), so no datum transform enters the measurement.

## Layer A: arithmetic and coordinate handling (gated)

`tests/sphereAccuracyLayerA.test.ts` computes all 78 inter-point distances of the
published list through OLV's own measurement path (`geometry.distance` plus the
unit engine) on positions recentred and narrowed to Float32, under the centroid
and the origins the LAS and COPC loaders pick for iPhone.laz, and compares them
with Float64 distances of the same coordinates; they agree to sub-millimetre.
This checks arithmetic and coordinate preservation at large negative Krovák
magnitudes. Both sides start from the same published numbers, so it says nothing
about the survey, about any scan, or about locating a sphere.

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

## Source integrity

- `spheres-epsg5514.csv` md5: `a32ec806f135ebf205af8fd28f3b0414` (12 Koule spheres + 1 control point, extracted from the dataset GroundTruth).
- The raw point clouds and the workbook are registered with size and SHA-256 as OLV-DS-052 to OLV-DS-056 in `validation/datasets/dataset-register.yaml`; `npm run validate:zenodo-small` checks iPhone.laz and GroundTruth.xlsx against those hashes before use (see `docs/validation/zenodo-small-study.md`).
