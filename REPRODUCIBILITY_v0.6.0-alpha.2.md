# Reproducibility — OpenLiDARViewer v0.6.0-alpha.2

The version-agnostic toolchain, pinning, and method are in [REPRODUCIBILITY.md](REPRODUCIBILITY.md). This note fixes the figures reported for this alpha to the commands that produce them, so a reviewer can regenerate each rather than take it on trust.

## Toolchain

- Node.js ≥ 22 (CI uses 22); dependencies pinned by `package-lock.json`.
- Install from a clean clone with `npm ci` (not `npm install`).

## Regenerate each reported figure

| Reported figure | Command |
|---|---|
| Unit 2,791 (16 skipped) · export 596 · terrain 1,214 (18 skipped) · ui 429 · slow 508 — 5,538 passed / 34 skipped | `npm run test:unit` / `test:export` / `test:terrain` / `test:ui` / `test:slow` (the large buckets run sub-sharded — unit ×3, terrain ×2, slow ×2 — so a run prints per-shard totals that sum to the figures above) |
| Full gate `GATE EXIT: 0` | `npm run test:release` |
| Deterministic e2e 161 passed / 4 skipped (blocking project) | `npm run test:e2e` |
| GPU e2e 1 test (advisory project) | `npm run test:e2e:gpu` |
| Live entry 699 KiB (within the 720 KiB ceiling, above the 680 KiB warning line) | `npm run build:live && npm run check:bundle` |
| Coverage — lines 90.57 / statements 89.19 / functions 87.75 / branches 82.73 | `npm run coverage` |
| Mutation score 87.23 % over the numeric core | `npm run mutation` |
| Documentation build | `npm run docs:build` |
| SBOM (CycloneDX, root `0.6.0-alpha.2`, production scope, 59 components) | `npx @cyclonedx/cyclonedx-npm --omit dev --output-file sbom.json` |
| Production dependency audit — 0 vulnerabilities | `npm audit --omit dev` |

## Environment notes

- The `slow` bucket spins up the WASM LAZ decoder; the runner caps workers at 2 and raises the per-test timeout for it.
- Four e2e specs skip when the optional autzen COPC fixture is not on disk — that is a conditional skip, not a failure.
- The e2e suite is split into two Playwright projects. `deterministic` blocks; `gpu` (specs tagged `@gpu`) is advisory because its result depends on the WebGPU adapter a runner exposes. An untagged spec lands in the blocking project.
- `npm run coverage` excludes `tests/terrainRunnerDensityWiring.test.ts` — under v8 instrumentation each of its cases takes about 75 s. It still runs in the release buckets, so nothing goes unexercised; only the coverage measurement omits it.
- The coverage and mutation figures are produced locally and are **not** retained as CI artifacts in this release. Treat them as reproducible measurements, not preserved evidence.
- Browser-observable behaviour (streaming visuals, GPU paths) is exercised by the e2e suite; a green GitHub Actions run on the tagged commit is the gating browser evidence for publication.
