# OpenLiDARViewer v0.6.6

v0.6.6 is a focused evidence release. It promotes the DSM, DTM and CHM surface products to independent cross-implementation evidence, and adds one opt-in cartographic option that leaves every default output unchanged. The measured figures in this document come from the release-mode gate run at the tagged commit.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## DSM, DTM and CHM reach cross-implementation evidence

The DSM (top surface, max return per cell) and the DTM (bare-earth grid, min return per cell) move from E3 to `E4_CROSS_IMPLEMENTATION_VALIDATED`. Each grid is recomputed from its point cloud and compared against a committed reference produced by PDAL 2.10.2 `writers.gdal`, on three seeded synthetic clouds per product. The two implementations agree over 7,500 cells to a maximum difference under 4×10⁻⁶ m, within a 0.05 m tolerance registered in `REFERENCE_SLOTS` before the references were generated. The comparisons, their commands, tool versions and checksums are recorded in the study manifests `DSM-PDAL-WRITERS-GDAL-CELL-CENTRED` and `DTM-PDAL-WRITERS-GDAL-CELL-CENTRED`, and the recompute is guarded on every gate run by `tests/groundFilterPdalAgreement.test.ts` with flip and transpose symmetry checks.

The canopy height model (`CHM`) is promoted alongside them. CHM is DSM minus DTM, clamped at zero, and with both parents at E4 it was compared against the PDAL max grid minus the PDAL min grid on the same structure clouds, agreeing over 7,500 cells to a maximum difference under 8×10⁻⁶ m, within a 0.1 m registered tolerance (study `CHM-PDAL-WRITERS-GDAL-DIFFERENCE`, test `tests/chmCrossCheck.test.ts`).

Ten products are now at E4: `SLOPE-RASTER`, `ASPECT-RASTER`, `HILLSHADE`, `CONTOURS` and `MEAS-AREA` against GDAL, `DSM`, `DTM` and `CHM` against PDAL, and the terrain descriptors `TPI` (against gdaldem 3.13.1) and `VRM` (against SAGA 7.8.2), each also checked against the closed form on a controlled analytic fixture.

## What the DSM, DTM and CHM evidence covers, and what it does not

The cross-check isolates the cell gridding. The reference radius is 0.45 m, below half a cell, so each cell reduces to the returns at its centre and the two implementations take the maximum or minimum over the same point set. It therefore measures the gridding arithmetic, not a divergent neighbourhood search. The DTM clouds are bare-earth by construction, so it does not exercise ground classification. `GROUND-FILTER` stays at E3 in this release, because its agreement with PDAL's `filters.smrf` holds on low-relief terrain and falls on steep and complex terrain. Void interpolation on real terrain is not exercised, and the DTM's required bar for field validation stays at E5. None of this is survey-grade accuracy or a field campaign.

## Terrain-aware contour generalization, opt-in

Cartographic contour purposes simplify their geometry at a bounded tolerance, expressed as a fraction of the grid cell. That tolerance has always applied evenly to every line, which spends the same amount of give on a long confidently-measured contour and on a small summit ring whose shape a coarse tolerance would erase.

A terrain-aware mode is now offered beside the uniform one. It scales the tolerance per feature from the feature's own evidence: interpolated and low-confidence support, and small closed summits and depressions, are simplified less, while long strongly-measured lines are simplified at the full tolerance. The per-feature factor is clamped so that it can only ever make a line more faithful than the uniform pass, which keeps the chosen tolerance as the bound on every line in the set. The simplifier underneath is unchanged and still refuses to drop a vertex that sits on a gap or below the confidence floor, so neither mode can straighten an interpolated run into a confident-looking line.

Exports record which pass produced their geometry, `olv.contour.generalize.terrain-adaptive@1` or `olv.contour.generalize@1`, alongside the tolerance in effect. Uniform remains the default for every purpose, so contour geometry is byte-identical to v0.6.5 unless the mode is selected.

## Known limitations

The complete list is in `KNOWN_LIMITATIONS_v0.6.6.md`. It carries the v0.6.5 limits forward, with the evidence-ceiling section updated for the three newly promoted surface products and the scope those cross-checks reach. Terrain-aware generalization is a cartographic option and carries no evidence claim of its own: it changes how a line is drawn, never what the surface says. Multi-layer mounting stays enabled with its one outstanding precision refinement, the residual streaming flicker at the point-budget boundary is unchanged, and there is still no cross-CRS reprojection into a common viewer frame.

## Compatibility

Unchanged from v0.6.5. Modern Chromium browsers use WebGPU, with WebGL 2 fallback in Firefox and Safari, and existing sessions remain compatible. Session files are unaffected: a session saved before this release loads with generalization in its uniform default.

## Verifying this release

```bash
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-assets>
gh attestation verify <archive> --repo Aurtechmx/openlidarviewer
```

The verified asset set is listed in `release-manifest-v0.6.6.json`. The two GitHub-generated Source code archives are not part of it.

## Citing

Citation metadata is provided in `CITATION.cff`, `.zenodo.json` and `codemeta.json`.

ORCID: [0009-0007-3147-323X](https://orcid.org/0009-0007-3147-323X)

- Version: 0.6.6
- License: MIT

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)
Full changelog: [v0.6.5...v0.6.6](https://github.com/Aurtechmx/openlidarviewer/compare/v0.6.5...v0.6.6)
