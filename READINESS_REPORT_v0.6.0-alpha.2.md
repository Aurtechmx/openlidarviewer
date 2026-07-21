# v0.6.0-alpha.2 publication-readiness report

A sober account of what is ready and what remains before this alpha is published on GitHub.

## Release identity

- Version `0.6.0-alpha.2` across `package.json`, lockfile, README, CHANGELOG, `RELEASE_NOTES_v0.6.0-alpha.2.md`, `CITATION.cff`, and the service-worker cache (`lint:release-sync` enforces this).
- This is a **pre-release / alpha** for evaluation; interfaces and internals may change before v0.6.0.

## Test and build gate

Run locally at the alpha head commit (**not yet a Git tag** — the published tag is cut from the merged commit). The figures below come from a run that reached a literal `GATE EXIT: 0`; see "The gate runner now reports why it failed" for how much that is worth:

- Static: `tsc --noEmit` clean; main-deferral, inline-imports, unsafe-html, layer-boundaries, claim-register, no-ignored-src, release-sync all pass.
- Unit 2,882 (16 skipped) · export 591 · terrain 1,218 (18 skipped) · ui 429 · slow 508.
- Build-contract 11; plain build and live/obfuscated build pass; bundle within the 720 KiB ceiling (699 KiB live entry, above the 680 KiB warning line).
- Full e2e (`npm run test:e2e`): 161 passed, 4 fixture-skipped (autzen COPC not on disk), 0 failed — **locally**. The gating browser evidence is the green GitHub Actions run required below, not this local run.
- Documentation build (`npm run docs:build`) passes.

## Dependency and license

- Production dependency audit: **0 vulnerabilities**. (Dev-only tooling may carry advisories in nested VitePress/Vite/esbuild that are not in the deployed runtime.)
- License: MIT (`LICENSE`, `package.json`). SBOM (`sbom.json`, CycloneDX) regenerated from the current lockfile at root component `openlidarviewer 0.6.0-alpha.2`.

## Authorship and citation

- `CITATION.cff` declares `0.6.0-alpha.2`. Its `date-released` must be set to the **actual GitHub publication date** immediately before tagging.
- `AI_ASSISTANCE.md` updated for the alpha and linked to this release's validation report.

## Claims and evidence

- Evidence package: [VALIDATION_REPORT_v0.6.0-alpha.2.md](VALIDATION_REPORT_v0.6.0-alpha.2.md), [KNOWN_LIMITATIONS_v0.6.0-alpha.2.md](KNOWN_LIMITATIONS_v0.6.0-alpha.2.md), and the alpha review response (`docs/_audit/v0.6-alpha-blocker-response.md`). Terrain/measurement claims inherited unchanged from v0.5.9.
- Claim register (`docs/validation/claim-register.yaml`) version stamp advanced to `0.6.0-alpha.2` with the inheritance noted; `lint:claim-register` passes.

## The gate runner now reports why it failed

`npm run test:release` previously exited 1 with no output on some runs, and was
terminated during the build on others. The cause was in the runner, not the
tests: `spawnSync` reports a signal-killed process as `status: null`, and
`status ?? 1` collapsed that into a bare failure indistinguishable from a red
suite. Signal deaths, spawn failures and a per-shard timeout are now reported
distinctly (137 / 2 / 124) with an explanation, and a wedged shard is killed
rather than left to hang the gate.

That makes the failure legible; it does not prove the underlying pool-shutdown
hang is gone. Treat a 124 or 137 from this gate as a runner fault to
investigate, never as a test result — and note that every figure in this report
comes from a run that reached a literal `GATE EXIT: 0`.

## Remaining items before publishing

These are publication-side steps this archive does not and cannot assert:

1. **Green GitHub Actions CI** on the exact tagged commit — plain and live/obfuscated startup, mobile layouts, lazy panels, screenshot composition, WebGL/WebGPU startup, stale-chunk recovery. The suite passes locally; the CI run is the gating proof.
2. **Package from a clean `main` checkout** so the release manifest carries the exact commit SHA, clean-tree status, and final checksums (local packaging already pins the commit; the published artifact must come from the merged commit).
3. **Set `CITATION.cff` `date-released`** to the publication day.
4. **Regenerate SBOM, manifest, and checksums** from the final tagged commit.

## Verdict

**Not ready to tag.** Application code and packaging hygiene are in place, every suite passes, and the gate now reports its own failures distinctly rather than collapsing them into a bare exit 1. Two things still stand between this and a tag: the project transform is applied by rewriting Float32 positions rather than held in Float64 beside source-local vertices (bounded and disclosed, but not the end state — coordinate-integrity roadmap P1 item 2), and the gating browser evidence must be a green GitHub Actions run on the tagged commit, not a local one. With those closed, publish as a GitHub **pre-release**.
