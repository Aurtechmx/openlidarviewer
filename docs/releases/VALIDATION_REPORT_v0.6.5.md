# Validation report: OpenLiDARViewer v0.6.5

This report states what v0.6.5 validates and what it does not. It is the human-readable companion to the machine-readable claim register (`docs/validation/claim-register.yaml`).

v0.6.5 is a process-architecture and evidence release on top of v0.6.4. It adds a Process Studio readiness panel, lands the feature-extraction and registration cores, hardens the remote-streaming path, and moves the terrain evidence from synthetic fixtures onto real airborne LiDAR. This report separates the one grade that moved from the grades that widened their basis without moving, so a reviewer does not have to infer the boundary.

## What moved, what widened, and what carried over

One grade moved: `CONTOURS` reaches `E4_CROSS_IMPLEMENTATION_VALIDATED`, joining `SLOPE-RASTER`, `ASPECT-RASTER` and `HILLSHADE`, so four terrain products are now cross-implemented against GDAL 3.13.1 and the rest stay at E3. The contour comparison runs on a frozen tilted-plane surface where linear interpolation is exact, agreeing with `gdal_contour` within 0.05 m (maximum 2.9×10⁻⁵ m), recorded in the study manifest `OLV-XS-002-CONTOURS-GDAL-PLANE` with a tolerance registered a month before the reference existed.

No other grade moved. What changed is the ground the existing grades rest on: slope's cross-check now also runs on real steep terrain, and two new kinds of real-data evidence were added below the grade line. The classification and terrain algorithms themselves are inherited from v0.6.4 unchanged, and their synthetic evidence (the building ground-support gate, the ground-trust surface calibration) carries over intact and is not restated here.

## New evidence: terrain validation on real airborne LiDAR

The terrain evidence this cycle is real airborne LiDAR from public, DOI- or program-cited surveys, run headless through the production terrain core with committed crops so it reproduces in CI without PDAL, GDAL or scipy present.

**Absolute accuracy against surveyed checkpoints (DTM).** OLV's DTM was compared to independent surveyed ground truth at two USGS sites. On the USGS Marsh Island / New Bedford UAS survey (public domain, 104 RTK check shots that are separate from the aerial control), 101 checkpoints agree at RMSE 2.8 cm, MAE 2.3 cm, median 1.8 cm; three were rejected for having no classified ground beneath them. On the USGS AZ Coconino B1 2019 airborne survey (public domain), the one checkpoint that falls inside the downloaded tile — a vegetated (VVA) point at 2567.66 m in forest — agrees at +3.9 cm, with the 3 m ground mean within 0.1 cm. Both the clouds and the checkpoints are NAVD88 orthometric, so there is no vertical-datum reconciliation. This is external checkpoint agreement on found public data, not a preregistered field campaign, and the forest result is one measurement, not a distribution. It does not move the DTM grade, which stays at E3.

**Slope cross-implementation on real steep terrain.** Slope stays at E4; its cross-check now also runs on a 150 m Coconino crop with 40 m of relief and local slopes to ~45°. OLV's Horn slope agrees with an independent NumPy Horn reference at 735 frozen cells to 3×10⁻⁸, and with `gdaldem` 3.13.1 slope to a maximum of 0.013° (mean 0.003°) over 19,834 cells. This widens the E4 basis from the analytic surface to real terrain; it does not, on its own, promote the grade.

**Ground-filter cross-check on real low-relief terrain.** OLV's SMRF-core ground filter and PDAL's full `filters.smrf` agree on 0.99985 of 95,005 returns over a balanced (40% ground) real boreal crop from the Estonian Land Board 2020 survey (CC BY 4.0). Agreement tracks terrain relief: flat ground coincides, steep and complex terrain diverges — the same tile at steep Coconino falls to 0.983, and the synthetic rolling and ridge scenes to 0.61 to 0.77. The gate this clears (0.99 over ≥50,000 returns) was frozen before the Estonian dataset was run. The result is scoped to low-relief terrain, and the formal register promotion of `GROUND-FILTER` to E4 is a follow-up; the claim stays at E3 in this release.

## What was tested for v0.6.5

Run with `npm run test:unit`, `test:export`, `test:terrain`, `test:ui`, `test:slow`, plus `npm run test:file <path>` for a single file. Whole-suite evidence for this release comes from the release-mode gate run at the tagged commit, with an exit marker per blocking stage in the shipped `gate.log`. The authoritative record is the release asset `test-evidence-v0.6.5.json`; its SHA-256 is in `SHA256SUMS`, and `release-manifest-v0.6.5.json` binds the tag to the full 40-character commit and to every artifact hash, which `npm run release:verify` walks. Published totals are read from `docs/validation/test-evidence.json` rather than entered by hand, and `npm run lint:evidence` checks the documents against it.

The new surfaces this cycle are covered by their own tests. Process Studio's capability resolver and live-signal mapping are unit-tested for the fail-closed contract (an unknown fact yields the conservative state), and a Playwright spec drives the panel in a browser: hidden in the empty state, revealed and populated on scan load, with the terrain products blocked on a cloud that cannot support them. The terrain field-validation legs — the two checkpoint comparisons, the real-terrain slope cross-check and the Estonian ground-filter cross-check — run headless in the unit suite against committed crops and independent references, and `npm run validate:terrain` rolls them into one verdict. The feature-extraction and registration cores are pure and unit-tested; their interactive surfaces are staged, not shipped, and are not claimed here.

## What was NOT tested (and is staged, not claimed)

- Physical multi-layer mounting is enabled in v0.6.5. What is validated: per-boundary world-coordinate invariance under a non-identity mount (`tests/frameWorldCoords.test.ts`, 138 frame-suite assertions), and the browser mount of two georeferenced tiles via `tests/e2e/twoScanMount.spec.ts` (real 2 km separation, source geometry untouched, and a layer that does not move when a sibling is added or removed). Two things are not yet a dedicated test. First, a single browser assertion that picks and measures a point on a mounted non-anchor tile: that coordinate is proven at the data-model level and exercised through the full application e2e, but not yet asserted in one named browser test. Second, the renderer's far-apart-mount render-origin fold, a bounded precision refinement that the mount-precision gate refuses past 1 mm (geographic frames outright). Incompatible layers carry no placement and are not merged into one estimator. See [KNOWN_LIMITATIONS_v0.6.5.md](KNOWN_LIMITATIONS_v0.6.5.md).
- The building ground-support gate is measured on synthetic scenes only. Real airborne and photogrammetric clouds, mixed support values, and a real building at a coverage edge are outside the evaluation.
- The iOS WebKit WebGL 2 fallback is verified against a browser forced onto WebGL 2, not against a real iOS device or every affected version.
- Windows is not a reproducibility leg. The tracked two-platform result covers darwin-arm64 and linux-x64, both little-endian, at one commit on one synthetic seeded fixture.
- GPU-computed derivatives beyond the engine probe surfaces. Node has no adapter, so the engine falls back to CPU and a check there would test the CPU path twice. GPU-versus-CPU agreement rests on the engine's own equivalence probe, which runs in a browser.
- LAZ output. `CONVERT_FORMATS.laz.available` is false: there is no LAZ encoder, so there is no file of the application's own to read back.
- Render-space lengths, the measurement HUD and rasterised report composition need a WebGL or canvas context. Only the pure label and figure builders behind them are checked.
- Browser behaviour on GitHub CI is not part of this archive's evidence. The e2e suite passed locally. The publication order is fixed: push the `v0.6.5` tag, confirm the CI gate is green on that commit, then deposit the archive and assets.

## Reproducing

```bash
npm ci
npm run test:release     # typecheck, lints, live build, all buckets, smoke
npm run test:e2e         # full Playwright suite
```

Per-figure commands are in [REPRODUCIBILITY_v0.6.5.md](REPRODUCIBILITY_v0.6.5.md).

## Verdict

v0.6.5 moves one evidence grade, widens the basis of others onto real terrain, adds a readiness panel, and hardens the remote path; the terrain and measurement algorithms carry forward from v0.6.4 unchanged. Contours reach E4, so four products are cross-implemented against GDAL 3.13.1 and the rest stay at E3. Below the grade line, the DTM was compared to independent surveyed checkpoints at two USGS sites (Marsh Island 101 checks at 2.8 cm; one Coconino forest checkpoint at 3.9 cm), slope's cross-check was extended to real steep terrain, and the ground filter was cross-checked against PDAL SMRF on real low-relief terrain at 0.99985. None of those moved a grade: the checkpoint results are external agreement on found public data rather than a preregistered field campaign, the ground-filter result is scoped to low-relief terrain, and the register promotion of `GROUND-FILTER` is a follow-up. Process Studio surfaces the capability model to the user, fail-closed, and the feature-extraction and registration cores land pure and tested with their interactive surfaces staged. The correct reading of v0.6.5 is that contours gained independent cross-implementation evidence, the terrain evidence gained its first footing on real airborne LiDAR, the remote-streaming path was hardened against credential leaks, unbounded reads and mid-load object swaps, and a single honest verdict on what each scan can produce is now visible in the app.
