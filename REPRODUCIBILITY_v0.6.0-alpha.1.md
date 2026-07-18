# Reproducibility — OpenLiDARViewer v0.6.0-alpha.1

The version-agnostic toolchain, pinning, and method are in [REPRODUCIBILITY.md](REPRODUCIBILITY.md). This note fixes the figures reported for this alpha to the commands that produce them, so a reviewer can regenerate each rather than take it on trust.

## Toolchain

- Node.js ≥ 22 (CI uses 22); dependencies pinned by `package-lock.json`.
- Install from a clean clone with `npm ci` (not `npm install`).

## Regenerate each reported figure

| Reported figure | Command |
|---|---|
| Unit 2,651 · export 550 · terrain 1,181 · ui 429 · slow 505 | `npm run test:unit` / `test:export` / `test:terrain` / `test:ui` / `test:slow` (CI runs the large buckets sub-sharded, e.g. `npm run test:unit -- --shard=1/3`) |
| Full gate `GATE EXIT: 0` | `npm run test:release` |
| Full e2e 161 passed / 5 fixture-skipped / 0 failed | `npm run test:e2e` |
| Live entry 692 KiB (within the 720 KiB ceiling) | `npm run build:live && npm run check:bundle` |
| Documentation build | `npm run docs:build` |
| SBOM (CycloneDX, root `0.6.0-alpha.1`, production scope) | `npx @cyclonedx/cyclonedx-npm --omit dev --output-file sbom.json` |
| Production dependency audit — 0 vulnerabilities | `npm audit --omit dev` |

## Environment notes

- The `slow` bucket spins up the WASM LAZ decoder; the runner caps workers at 2 and raises the per-test timeout for it.
- Five e2e specs skip when the optional autzen COPC fixture is not on disk — that is a conditional skip, not a failure.
- Browser-observable behaviour (streaming visuals, GPU paths) is exercised by the e2e suite; a green GitHub Actions run on the tagged commit is the gating browser evidence for publication.
