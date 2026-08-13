# Threats to validity

This page aggregates, in one place, the limitations that qualify every scientific claim OpenLiDARViewer makes. Per-claim detail (assumptions, failure modes, prohibited wording) lives in `docs/validation/claim-register.yaml`; the evidence ladder that governs how strongly a claim may be stated lives in `docs/validation/EVIDENCE_MODEL.md`. This document is the human-readable summary a reviewer should read first.

## Evidence ceiling

Five products reached **E4**. The slope raster, the aspect raster and the hillshade were each cross-implemented against GDAL 3.13.1 on the same analytic fixture and agreed with GDAL and with the closed-form gradient within their preregistered tolerances (0.5 degree for slope and aspect, 1.0 level on the 0-255 scale for hillshade); the contour set was cross-implemented against GDAL `gdal_contour` on a frozen analytic tilted plane, where linear interpolation is exact, and agreed to a maximum vertex separation of 2.9×10⁻⁵ m under a tolerance registered before the reference was generated. That is cross-implementation independence for those three ALGORITHMS on this fixture — not field-grade validation (E5) and not the point-cloud-to-DTM pipeline. The aspect result carries two further limits of its own: it is a circular agreement, and it covers only cells whose closed-form slope exceeds 2 degrees, because aspect is undefined on level ground and the two implementations do not even represent it the same way there (GDAL writes NODATA, ours returns 0). The hillshade result carries a limit of a different kind, and it is the sharpest caveat of the three: OLV encodes the shading intensity as `255*h` and GDAL as `1 + 254*h`, a fixed offset of `(1 - h)` levels that is always below one level but that therefore consumes most of a one-level tolerance by itself — 0.900 of the 1.0 on this fixture. The ours-versus-GDAL tolerance test alone would consequently not detect a small shading error; what carries the hillshade claim is the closed-form leg (max separation 0.0000643 of a level over 11,564 cells) and the zero-tolerance identity that our intensity re-encoded in GDAL's own scale reproduces the committed reference exactly. The hillshade check also covers only the single-direction model, not `computeMultiHillshade`. The fifth E4 product is not terrain: polygon area (`MEAS-AREA`) was cross-implemented against GDAL/OGR `OGR_GEOM_AREA` on a committed planar-polygon fixture and agreed with it, and with each polygon's closed-form area, to machine precision under a tolerance registered before the reference was generated — cross-implementation agreement on exact synthetic polygons, not survey-grade area accuracy. Every other product tops out at E3 (self-consistency against a known analytic surface), and every reference slot other than `SLOPE-RASTER`, `ASPECT-RASTER`, `HILLSHADE`, `CONTOURS` and `MEAS-AREA` is still `pending`, awaiting external reference outputs that are not bundled.

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
