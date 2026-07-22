# Artifact evaluation

This guide lets a reviewer evaluate the OpenLiDARViewer software artifact without special hardware or private data. It complements `REVIEWER_QUICKSTART.md` (fast start) and `VALIDATION_REPORT_v0.6.0-alpha.3.md` (what is and is not validated for this alpha; terrain/measurement claims are inherited from `VALIDATION_REPORT_v0.5.9.md`).

## What the artifact is

A local-first, browser-native LiDAR and point-cloud viewer with terrain analysis, validation-aware exports, and (as of v0.5.9) a Contour Studio deliverable workflow. Files stay on the reviewer's device; no upload or account is required.

## Requirements

- Node.js 22 (see `.nvmrc` / `package.json` `engines`).
- A Chromium-based browser with WebGPU for the interactive and end-to-end portions (a WebGL2 fallback exists). The unit/integration suite and the reproduction pack need only Node.

## Reproduce (no device beyond Node)

```bash
nvm use
npm ci
npm run typecheck
npm run test:unit && npm run test:export && npm run test:terrain && npm run test:ui && npm run test:slow
npm run repro          # regenerates the analytic figures under benchmarks/out/
npm run build:live && npm run check:bundle
```

`npm run test:release` runs the whole gate in one command.

## Claims and their evidence

- Every scientific claim is registered in `docs/validation/claim-register.yaml` with its current evidence level, the level required to be called validated, the tests that support it, and the wording that is allowed or prohibited. `scripts/lint-claim-register.mjs` fails the build if the runtime registry drifts from that file or if prohibited wording appears.
- The evidence ladder (E0–E6) is defined in `docs/validation/EVIDENCE_MODEL.md`. One product is at E4: the slope raster was cross-implementation validated against GDAL 3.13.1 on the analytic fixture (see `tests/slopeCrossCheck.test.ts`). Every other product tops out at E3 (synthetic known-truth checks).
- `VALIDATION_REPORT_v0.6.0-alpha.3.md` lists exactly what was and was not tested for this alpha (inheriting the terrain/measurement evidence from `VALIDATION_REPORT_v0.5.9.md`); `docs/validation/THREATS_TO_VALIDITY.md` aggregates the limitations.

## Integrity

Release archives are produced by `npm run package`, which emits `SHA256SUMS` and a `release-manifest-vX.json` (version, commit, node, per-zip SHA256). A checksum verifies file integrity only; it does not prove authorship.

## Data availability

No proprietary dataset is required. Bundled fixtures are synthetic or explicitly licensed (`THIRD_PARTY_NOTICES.md`); external point clouds are user-supplied or streamed from third-party open-data hosts and are not redistributed here (`DATA_AVAILABILITY.md`).

## Scope of evaluation

Evaluable in this artifact: build, type safety, the full unit/integration suite, deterministic analytic reproduction, bundle budget, and the honesty lints. Not evaluable here without a device or external reference data: GPU performance figures, the full browser end-to-end suite, and cross-implementation / field accuracy comparisons.
