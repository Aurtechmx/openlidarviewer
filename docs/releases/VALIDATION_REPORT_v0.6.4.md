# Validation report: OpenLiDARViewer v0.6.4

This report states what v0.6.4 validates and what it does not. It is the human-readable companion to the machine-readable claim register (`docs/validation/claim-register.yaml`).

v0.6.4 is a classification, report-hardening and interface release on top of v0.6.3. It changes one algorithm's behaviour, adds one new piece of synthetic evidence, and otherwise inherits the terrain and contour algorithms unchanged. This report separates what changed from what carried over, so a reviewer does not have to infer the boundary.

## What changed this cycle, and what carried over

The terrain and contour ALGORITHMS are the ones inherited from v0.5.9 and recorded in [VALIDATION_REPORT_v0.5.9.md](VALIDATION_REPORT_v0.5.9.md), and their evidence state is unchanged: `SLOPE-RASTER`, `ASPECT-RASTER` and `HILLSHADE` remain at E4 on the basis established in [VALIDATION_REPORT_v0.6.3.md](VALIDATION_REPORT_v0.6.3.md), and every other terrain product remains at E3. No terrain claim moved in this release.

The CLASSIFICATION heuristic did change. v0.6.4 adds a building ground-support gate (`buildingMinSupport`, default 0.66) in `src/render/class/deriveClassification.ts`, and makes automatic classification return-number aware. These are new behaviour, not inherited, and they carry new evidence rather than resting on the terrain record. So the terrain evidence is inherited unchanged, the classification behaviour is not, and the two are stated apart here rather than folded into one claim.

## New evidence: the building ground-support gate

`docs/validation/building-support-gate-eval.md` records a synthetic evaluation of the gate. It builds one labelled synthetic corpus and runs `deriveClassification` twice on the same points, changing only `buildingMinSupport` between a disabled run (0) and the default (0.66). Every point carries a ground-truth building label across four categories: real buildings on fully measured ground, scan-edge artifact roofs over void, vegetation controls, and ground controls.

On that corpus the gate flips 480 of 528 artifact roof points out of the building class while keeping every real-building point, so building precision rises to 1.000 and building recall holds at 1.000. The mechanism is visible in the numbers: the gate removes low-support roofs, whose ground support reads exactly 0.5 at a one-cell scan-edge void, while keeping high-support roofs, whose ground is fully measured.

This is a synthetic corpus with hand-placed geometry, not a field survey. It demonstrates the precision-and-recall behaviour on controlled scan-edge voids. It does not measure behaviour on real airborne or photogrammetric point clouds, on mixed support values, or on a real building at a genuine coverage edge whose ground support is itself 0.5. That last case would lose real-building recall and is not covered. Reproduce with `npx tsx scripts/eval-building-gate.ts`.

## What was tested for v0.6.4

Run with `npm run test:unit`, `test:export`, `test:terrain`, `test:ui`, `test:slow`, plus `npm run test:file <path>` for a single file. Whole-suite evidence for this release comes from the release-mode gate run at the tagged commit, with an exit marker per blocking stage in the shipped `gate.log`. The authoritative record is the release asset `test-evidence-v0.6.4.json`; its SHA-256 is in `SHA256SUMS`, and `release-manifest-v0.6.4.json` binds the tag to the full 40-character commit and to every artifact hash, which `npm run release:verify` walks. Published totals are read from `docs/validation/test-evidence.json` rather than entered by hand, and `npm run lint:evidence` checks the documents against it.

The report and export surfaces gained unit-safety checks this cycle: four report and UI surfaces fail closed on an unknown CRS linear unit rather than presenting a length in an unstated unit, and annotation `worldPosition` is populated with the report frame labelled. Remote COPC streaming replacement is transactional, so a failed swap does not leave the previous session partly torn down. These are exercised by the unit and export buckets and, for the browser-visible paths, by the e2e suite.

## What was NOT tested (and is staged, not claimed)

- Physical multi-layer mounting is off in v0.6.4 (`MULTI_LAYER_MOUNT_ENABLED = false`), and the flag is guarded. The shared project frame and the compatibility model are present and tested, and the app owns a live project frame; layers are not co-registered and are not merged into one estimator. Two-layer placement is unverified in a browser by construction, because nothing places two layers into one mounted frame. See [KNOWN_LIMITATIONS_v0.6.4.md](KNOWN_LIMITATIONS_v0.6.4.md).
- The building ground-support gate is measured on synthetic scenes only. Real airborne and photogrammetric clouds, mixed support values, and a real building at a coverage edge are outside the evaluation.
- The iOS WebKit WebGL 2 fallback is verified against a browser forced onto WebGL 2, not against a real iOS device or every affected version.
- Windows is not a reproducibility leg. The tracked two-platform result covers darwin-arm64 and linux-x64, both little-endian, at one commit on one synthetic seeded fixture.
- GPU-computed derivatives beyond the engine probe surfaces. Node has no adapter, so the engine falls back to CPU and a check there would test the CPU path twice. GPU-versus-CPU agreement rests on the engine's own equivalence probe, which runs in a browser.
- LAZ output. `CONVERT_FORMATS.laz.available` is false: there is no LAZ encoder, so there is no file of the application's own to read back.
- Render-space lengths, the measurement HUD and rasterised report composition need a WebGL or canvas context. Only the pure label and figure builders behind them are checked.
- Browser behaviour on GitHub CI is not part of this archive's evidence. The e2e suite passed locally. The publication order is fixed: push the `v0.6.4` tag, confirm the CI gate is green on that commit, then deposit the archive and assets.

## Reproducing

```bash
npm ci
npm run test:release     # typecheck, lints, live build, all buckets, smoke
npm run test:e2e         # full Playwright suite
```

Per-figure commands are in [REPRODUCIBILITY_v0.6.4.md](REPRODUCIBILITY_v0.6.4.md).

## Verdict

One algorithm changed and one piece of evidence was added. Building classification now gates on ground support, and a synthetic evaluation shows it removing scan-edge void artifacts without dropping real buildings on fully measured ground. The terrain and contour evidence state did not move: three products remain cross-implemented at E4 and the rest at E3. Nothing here is field validation. The correct reading of v0.6.4 is that classification precision improved on a targeted synthetic failure mode, the report and export surfaces refuse unknown units instead of guessing, and the terrain record is carried forward as it stood.
