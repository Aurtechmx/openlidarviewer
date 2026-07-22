# Threats to validity

This page aggregates, in one place, the limitations that qualify every scientific claim OpenLiDARViewer makes. Per-claim detail (assumptions, failure modes, prohibited wording) lives in `docs/validation/claim-register.yaml`; the evidence ladder that governs how strongly a claim may be stated lives in `docs/validation/EVIDENCE_MODEL.md`. This document is the human-readable summary a reviewer should read first.

## Evidence ceiling

One product reached **E4**: the slope raster was cross-implemented against GDAL 3.13.1 on the analytic fixture and agreed with GDAL and the closed-form gradient within the preregistered 0.5 degree tolerance. That is cross-implementation independence for the slope ALGORITHM on this fixture — not field-grade validation (E5) and not the point-cloud-to-DTM pipeline. Every other product tops out at E3 (self-consistency against a known analytic surface), and every reference slot other than `SLOPE-RASTER` is still `pending`, awaiting external reference outputs that are not bundled.

## Construct threats (are we measuring the right thing?)

- **Hold-out RMSE is internal, not field accuracy.** The spatially-blocked hold-out estimates how well the surface predicts withheld points from the *same* scan. It is a diagnostic of internal consistency, not an independent checkpoint assessment. Ground classification, when not re-run per fold, is fit on the full cloud, which is mildly optimistic (disclosed in the warning).
- **NVA/VVA-style figures are style-of, not standard-conformant.** They are computed on hold-out residuals, not on independent survey checkpoints, and are labelled "(hold-out)" wherever shown. They must not be read as an ASPRS checkpoint assessment.
- **Confidence calibration reliability is reported out-of-fold**, so it is not self-scored, but it is still derived from the scan's own hold-out, not external truth.

## Internal threats (could the pipeline bias the result?)

- **Interpolated surface.** Contours and DTM cells over interpolated or unsupported areas are model, not measurement. Support state propagates to exports; validated analytical output requires bounded support.
- **Unknown units / datum.** When the vertical unit or datum is unknown, metric contour support is not claimed and the output is capped to exploratory / cartographic-only. A geographic CRS is treated as non-linear (degrees), never as metres.
- **Cartographic vs analytical geometry.** Smoothed/generalized contours are for presentation; they are recorded as such and must not be labelled exact. GIS exports carry the analytical geometry.

## External threats (does it generalize?)

- **Sensor / capture diversity.** Results are demonstrated on the bundled synthetic fixtures and a limited set of open datasets; behavior on other sensors, densities, and terrain types is not independently characterized.
- **No independent datasets bundled.** External datasets referenced by the viewer are user-supplied or streamed from third-party open-data hosts (see `DATA_AVAILABILITY.md`); this repository redistributes none of them and has not run validation against certified reference data.

## What would raise the ceiling

Running the cross-implementation harness against independent reference outputs (E4), and a field validation against surveyed checkpoints (E5+). Both are mechanisms that exist or are documented; neither has been executed, so no claim currently depends on them.
