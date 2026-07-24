# Validation report — OpenLiDARViewer v0.6.0

This report states, soberly, what v0.6.0 validates and what it does not. It is the human-readable companion to the machine-readable claim register (`docs/validation/claim-register.yaml`).

The v0.6 cycle's changes are in streaming decode, session import, measurement-unit honesty, the non-destructive Float64 placement architecture, and the self-explaining measurement/layer surfaces. The terrain and contour **algorithms** are inherited from v0.5.9 — the v0.6 cycle did not touch them. The Horn slope raster's independent cross-implementation validation (`SLOPE-RASTER` at E4) was first introduced during alpha.3 and ships unchanged in v0.6.0. Other terrain and contour claims retain their previous evidence levels, as recorded in [VALIDATION_REPORT_v0.5.9.md](VALIDATION_REPORT_v0.5.9.md). This report covers the release-specific surface on top of that.

## Evidence ceiling

One product is at E4. The slope raster is cross-implementation validated: OpenLiDARViewer's Horn slope agreed with GDAL 3.13.1 and with the closed-form gradient over 11,564 interior cells on the analytic fixture, within the preregistered 0.5 degree tolerance (max difference under 0.001 degree). This is E4 for the slope algorithm on this fixture only — not the point-cloud-to-DTM pipeline, not field accuracy, not survey-grade. Every other terrain product tops out at E3 (synthetic known-truth against our own implementation); no product is field-validated (E5). The release's correctness guards are validated at E2–E3 against constructed inputs.

## What was tested for v0.6.0

Run with `npm run test:unit`, `test:export`, `test:terrain`, `test:ui`, `test:slow`, plus `npm run test:file <path>` for a single file.

- **Streaming non-finite refusal.** `tests/streamingFiniteGuard.test.ts` verifies COPC/EPT decoders refuse a node whose transform is non-finite, whose finite-but-extreme transform overflows a coordinate to Infinity, or whose EPT-binary float source carries a NaN — with a structured malformed-file error, never NaN to the GPU.
- **Session scan-identity guard.** `tests/sessionScanIdentity.test.ts` verifies `matchSessionToScan` returns strong / partial / conflict on extents (primary), point count (corroborating, reduction-tolerant), and name/CRS (disclosure), including the rename and device-reduced edge cases.
- **Stockpile density-unit honesty.** `tests/stockpileVolume.test.ts` / `tests/stockpilePresenter.test.ts` verify HIGH confidence is withheld when the horizontal unit is unknown and the density row is labelled `pts/unit² (unit unknown)` rather than claiming m².
- **Project-frame transform math.** `tests/projectSpatialFrame.test.ts` verifies the source↔project↔world round-trip and the Float32 sub-mm residual bound.
- **Frame gates stated as properties.** `tests/frameGateProperties.test.ts` checks invariants over generated inputs rather than chosen cases: totality, determinism, order-independence, undeclared never verifying, the verified set being vertically unanimous on IDENTITY (not spelling), the permission helpers forming a ladder, streaming clearing the same bar as static, world position surviving a rebase within the quantum the mount reports, and source-origin immutability across any sequence of moves. Seeded generator, no new dependency; a failure prints its seed. It found a live order-dependence in the horizontal reference on its first run.
- **Change-detection preflight.** `tests/alignEpochs.test.ts` verifies the frame check runs before any sampling or fit, that a refused pair reports an infinite residual rather than zero, and that two undeclared scans still compare — matching the rule `compareDtms` applies downstream.
- **Project-frame reversibility.** `tests/pointCloud.test.ts` and `tests/LayerService.test.ts` verify that a cloud keeps the origin its file declared, returns to it when it leaves the frame (including the CRS-override case), and that the frame seeds its anchor from file origins rather than from origins it has itself written.
- **Rebase precision is quantified, not assumed.** `PointCloud.rebaseQuantum` reports the Float32 step a mount would land on. Measured: a lone georeferenced scan anchors on its own origin and loses nothing (~1e-8 m); the cost scales with inter-layer separation, reaching 1 mm at 100 km apart. Positions remain Float32, so widely-separated layers trade residual precision for correct relative placement — see Known Limitations.
- **Progressive EPT attach.** `tests/eptStreaming.test.ts` verifies first-paint-then-continue parity with the full walk and that a persistently-failing fetch terminates (no allocation loop).

Whole-suite evidence for this release comes from the release-mode gate run at the tagged commit — seven blocking stages (static gate, deterministic e2e, docs build, production audit, fixture checksums, coverage, mutation), each with its exit marker in the shipped `gate.log`: unit 3,140 passed / 16 skipped, export 618, terrain 1,240, ui 429, slow 531 — 5,958 passed / 16 skipped; deterministic e2e 161 passed / 4 fixture-skipped / 0 failed; production dependency audit 0 vulnerabilities. The authoritative record is the release asset `test-evidence-v0.6.0.json` (its SHA-256 is in `SHA256SUMS`, and `release-manifest-v0.6.0.json` binds the tag to the full 40-character commit and to every artifact hash — `npm run release:verify` walks the chain). A green GitHub Actions run on the pushed tag reproduces the same gate in CI; it comes into existence when the tag is published and is not asserted here.

## What was NOT tested (and is staged, not claimed)

- **Physical multi-layer mounting is DISABLED in v0.6.0.** The shared project frame and the compatibility model are present and tested; layers are not co-registered and are not merged into one estimator. Multi-layer placement is therefore unverified in a browser by construction — nothing places them. Compare Studio, cross-layer measurement and elevation ramps do not read frame offsets. See [KNOWN_LIMITATIONS_v0.6.0.md](KNOWN_LIMITATIONS_v0.6.0.md).
- **The anti-thrash streaming-selection option is opt-in and unwired.** Its logic is unit-tested; its visual effect on flicker is unverified because it needs a browser and is not enabled in this build.
- **Browser behaviour on GitHub CI is not part of this archive's evidence.** The e2e suite passed locally; a green GitHub Actions run on the exact tagged commit is required before publication and is not asserted here. The publication order is fixed: push the `v0.6.0` tag, confirm the CI gate is green on that commit, then deposit the archive and assets to Zenodo — the Zenodo record should name the tagged commit that CI verified.

## Reproducing

```bash
npm ci
npm run test:release     # typecheck, lints, live build, all buckets, smoke
npm run test:e2e         # full Playwright suite
```

## Verdict

The release's correctness guards are validated at the internal-evidence ceiling; the inherited terrain/measurement claims stand as in v0.5.9. The project-frame runtime integration and the browser-verified items are explicitly out of scope for this archive's evidence and are documented as staged.
