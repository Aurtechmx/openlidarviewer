# Validation report: OpenLiDARViewer v0.6.7

This report states what v0.6.7 validates and what it does not. It is the human-readable companion to the machine-readable claim register (`docs/validation/claim-register.yaml`).

v0.6.7 introduces no new evidence claim. It is a licensing and engineering release: the license moves to AGPL-3.0-only, the read paths are hardened against malformed and oversized input, and two ingest paths are added (out-of-core streaming for heavy local files, and 3D Tiles implicit tiling). None of that promotes a product, adds a cross-implementation study or runs a field campaign. Every evidence grade is the one recorded for v0.6.6 and is not restated here beyond the summary below; the authoritative statement of each grade and its boundary is `VALIDATION_REPORT_v0.6.6.md`.

## No grade moved

No `currentEvidence` grade changes in this release. The twelve products at `E4_CROSS_IMPLEMENTATION_VALIDATED` are the same twelve validated in v0.6.6: `SLOPE-RASTER`, `ASPECT-RASTER`, `HILLSHADE`, `CONTOURS` and `MEAS-AREA` against GDAL; `DSM`, `DTM` and `CHM` against PDAL 2.10.2 `writers.gdal`; the terrain descriptors `TPI` (against gdaldem 3.13.1) and `VRM` (against SAGA 7.8.2), each also against the closed form on a controlled analytic fixture; `MEAS-PROFILE` against a reference assembled from OGR/SpatiaLite 5.1.0 and R 4.4.1; and `E57-INGEST` against PDAL `readers.e57`. The boundaries of each of those grades are stated in `VALIDATION_REPORT_v0.6.6.md` and hold without change here. `GROUND-FILTER` stays partial, every other terrain product tops out at E3, and no registered product reaches E5.

## What the engineering work is, and how it is covered

The memory-safety hardening and the two new ingest paths change how the viewer behaves on a hostile, truncated or oversized file, and how it loads a large one. They do not change what it computes on a valid file, so they carry no evidence grade of their own. They are covered by the test suite rather than by a scientific claim:

- The shared decoded-byte budget and the fail-closed refusals are exercised by unit tests over malformed and over-ceiling inputs, which assert the read is refused before allocation rather than after.
- The out-of-core store lifecycle is exercised by tests that drive each cancel and attach path and assert the store is either committed or deleted, including the short-write and abandoned-store cases.
- The out-of-core streaming and 3D Tiles implicit-tiling paths are exercised by ingest tests over their respective fixtures.
- The corrected behaviours below are each pinned by a test: the profile PDF max-grade sign, the Inspector vertical-unit rows, the panel-rail observer disposal, the degenerate-profile coverage report, and the profile-workbench close restoring the Analyse panel.

None of these is a validated accuracy figure, because none of them produces a number to validate against a reference.

## The licensing change carries no evidence implication

The move to AGPL-3.0-only is a license change over this project's own source. It does not alter the license of any bundled dependency or of any test or validation dataset, and it does not touch the claim register, the reference slots or any study manifest. No evidence claim depends on it.

## What was tested for v0.6.7

Whole-suite evidence for this release comes from the release-mode gate run at the tagged commit, with an exit marker per blocking stage in the shipped `gate.log`. The authoritative record is the release asset `test-evidence-v0.6.7.json`; its SHA-256 is in `SHA256SUMS`, and `release-manifest-v0.6.7.json` binds the tag to the full 40-character commit and to every artifact hash, which `npm run release:verify` walks. Published totals are read from `docs/validation/test-evidence.json` rather than entered by hand, and `npm run lint:evidence` checks the documents against it. The reference-slot honesty tests (`tests/crossCheck.test.ts`, `tests/crossImplementationManifest.test.ts`) and the study verifier (`npm run validation:study:verify`) confirm the supplied slots are unchanged from v0.6.6 and the rest stay pending.

## What was NOT tested (and is not claimed)

Real-terrain DSM and DTM accuracy, ground-classification accuracy, void interpolation, mixed-unit gridding, and any field-grade or survey-grade figure. Nothing in the memory-safety wave or the new ingest paths is a claim about accuracy; each is a claim about refusal and lifecycle behaviour on a bad or large input, bounded by the tests named above. The external DTM checkpoint results reported below the grade line in earlier releases remain external agreement on found public data, not a preregistered field campaign, and do not move a grade here.
