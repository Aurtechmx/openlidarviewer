# Validation report — OpenLiDARViewer v0.6.0-alpha.2

This report states, soberly, what v0.6.0-alpha.2 validates and what it does not. It is the human-readable companion to the machine-readable claim register (`docs/validation/claim-register.yaml`) and the alpha review response (`docs/_audit/v0.6-alpha-blocker-response.md`).

The v0.6 cycle's changes are in streaming decode, session import, measurement-unit honesty, and a shared project-frame foundation. The terrain and contour correctness claims are **inherited unchanged from v0.5.9** — the alpha wave did not touch those algorithms — so their evidence remains as recorded in [VALIDATION_REPORT_v0.5.9.md](VALIDATION_REPORT_v0.5.9.md). This report covers the alpha-specific surface on top of that.

## Evidence ceiling

Unchanged from v0.5.9: no product is validated above internal evidence. On the E0–E6 ladder nothing is at or above E4 (cross-implementation independence); synthetic known-truth checks reach E3. The alpha's new correctness guards are validated at E2–E3 (unit tests against constructed inputs), not against an independent reference implementation.

## What was tested (alpha wave)

Run with `npm run test:unit`, `test:export`, `test:terrain`, `test:ui`, `test:slow`, plus `npm run test:file <path>` for a single file.

- **Streaming non-finite refusal.** `tests/streamingFiniteGuard.test.ts` verifies COPC/EPT decoders refuse a node whose transform is non-finite, whose finite-but-extreme transform overflows a coordinate to Infinity, or whose EPT-binary float source carries a NaN — with a structured malformed-file error, never NaN to the GPU.
- **Session scan-identity guard.** `tests/sessionScanIdentity.test.ts` verifies `matchSessionToScan` returns strong / partial / conflict on extents (primary), point count (corroborating, reduction-tolerant), and name/CRS (disclosure), including the rename and device-reduced edge cases.
- **Stockpile density-unit honesty.** `tests/stockpileVolume.test.ts` / `tests/stockpilePresenter.test.ts` verify HIGH confidence is withheld when the horizontal unit is unknown and the density row is labelled `pts/unit² (unit unknown)` rather than claiming m².
- **Project-frame transform math.** `tests/projectSpatialFrame.test.ts` verifies the source↔project↔world round-trip and the Float32 sub-mm residual bound.
- **Progressive EPT attach.** `tests/eptStreaming.test.ts` verifies first-paint-then-continue parity with the full walk and that a persistently-failing fetch terminates (no allocation loop).

Whole-suite evidence, run locally at the alpha head commit (not yet a Git tag): unit 2,797 passed / 16 skipped, export 586, terrain 1,210 / 18 skipped, ui 429, slow 508 — 5,530 passed / 34 skipped; build-contract 11; live/obfuscated build passed; production dependency audit 0 vulnerabilities. The full e2e suite passed **locally** here (161 passed / 5 fixture-skipped / 0 failed) — the *gating* browser evidence is a green GitHub Actions run on the tagged commit, which is pending (see "What was NOT tested").

## What was NOT tested (and is staged, not claimed)

- **The shared project frame is a foundation only.** `ProjectSpatialFrame` is imported by tests and documentation, not by the running viewer. Multi-dataset overlay, Compare Studio, and cross-layer picking do **not** yet mount layers through it. See [KNOWN_LIMITATIONS_v0.6.0-alpha.2.md](KNOWN_LIMITATIONS_v0.6.0-alpha.2.md).
- **The anti-thrash streaming-selection option is opt-in and unwired.** Its logic is unit-tested; its visual effect on flicker is unverified because it needs a browser and is not enabled in this build.
- **Browser behaviour on GitHub CI is not part of this archive's evidence.** The e2e suite passed locally; a green GitHub Actions run on the exact tagged commit is required before publication and is not asserted here.

## Reproducing

```bash
npm ci
npm run test:release     # typecheck, lints, live build, all buckets, smoke
npm run test:e2e         # full Playwright suite
```

## Verdict

The alpha's new correctness guards are validated at the internal-evidence ceiling; the inherited terrain/measurement claims stand as in v0.5.9. The project-frame runtime integration and the browser-verified items are explicitly out of scope for this archive's evidence and are documented as staged.
