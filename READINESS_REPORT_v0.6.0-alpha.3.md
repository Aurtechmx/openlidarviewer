# v0.6.0-alpha.3 publication-readiness report

A sober account of what is ready and what remains before this alpha is published on GitHub.

## Release identity

- Version `0.6.0-alpha.3` across `package.json`, lockfile, README, CHANGELOG, `RELEASE_NOTES_v0.6.0-alpha.3.md`, `CITATION.cff`, and the service-worker cache (`lint:release-sync` enforces this).
- This is a **pre-release / alpha** for evaluation; interfaces and internals may change before v0.6.0.

## Test and build gate

Run locally at the alpha head commit (**not yet a Git tag** — the published tag is cut from the merged commit). The figures below come from a run that reached a literal `GATE EXIT: 0`; see "The gate runner terminates, verified" for the evidence behind that:

- Static: `tsc --noEmit` clean; main-deferral, inline-imports, unsafe-html, layer-boundaries, claim-register, no-ignored-src, release-sync all pass.
- unit 3,086 (16 skipped) · export 616 · terrain 1,240 · ui 429 · slow 517.
- Build-contract 11; plain build and live/obfuscated build pass. Live entry 713 KiB against the 720 KiB hard ceiling, above the 680 KiB warning line, reproduced byte-identically across two clean builds. The margin is 7 KiB: treat the ceiling as effectively reached and shed weight before adding any, rather than raising it.
- Full e2e (`npm run test:e2e`): 161 passed, 4 fixture-skipped (autzen COPC not on disk), 0 failed — **locally**. The gating browser evidence is the green GitHub Actions run required below, not this local run.
- Documentation build (`npm run docs:build`) passes.

## Dependency and license

- Production dependency audit: **0 vulnerabilities**. (Dev-only tooling may carry advisories in nested VitePress/Vite/esbuild that are not in the deployed runtime.)
- License: MIT (`LICENSE`, `package.json`). SBOM (`sbom.json`, CycloneDX) regenerated from the current lockfile at root component `openlidarviewer 0.6.0-alpha.3`.

## Authorship and citation

- `CITATION.cff` declares `0.6.0-alpha.3`. Its `date-released` must be set to the **actual GitHub publication date** immediately before tagging.
- `AI_ASSISTANCE.md` updated for the alpha and linked to this release's validation report.

## Where the figures come from

Every test count and the bundle size in this document are read out of a passing
gate run into `docs/validation/test-evidence.json` and checked against it by
`lint:evidence`. They are not transcribed. The gate log they were read from is
kept as `release/gate.log` with its SHA-256 recorded in the evidence, so the
figures can be recomputed rather than trusted.

That check exists because a previous candidate published unit, export and
terrain counts that were all wrong while its total was right — the total came
from a script, the components were typed in — and `lint:release-sync` could not
see it, because it only checks that the documents agree with each other. Three
documents copying one wrong number agree perfectly. An external reviewer found
it by adding them up.

## Claims and evidence

- Evidence package: [VALIDATION_REPORT_v0.6.0-alpha.3.md](VALIDATION_REPORT_v0.6.0-alpha.3.md), [KNOWN_LIMITATIONS_v0.6.0-alpha.3.md](KNOWN_LIMITATIONS_v0.6.0-alpha.3.md), and the alpha review response (`docs/_audit/v0.6-alpha-blocker-response.md`). Terrain/measurement claims inherited unchanged from v0.5.9.
- Claim register (`docs/validation/claim-register.yaml`) version stamp advanced to `0.6.0-alpha.3` with the inheritance noted; `lint:claim-register` passes.

## The gate runner terminates, verified

`npm run test:release` used to run past eleven minutes without returning while
every assertion passed. Two causes, both in how shards were launched: going
through `npx` put a wrapper process in front of vitest, so a kill landed on the
wrapper while the real process and its worker pool survived; and `spawnSync`'s
timeout only ever signals its direct child, so orphaned workers held the
inherited stdio pipe open and the parent waited on a pipe nobody would close.

Shards now run the local vitest binary directly, spawned detached as
process-group leaders, and a timeout kills the whole group. Evidence, not
assertion:

- After a deliberately forced timeout, `pgrep -fl vitest` returns nothing —
  no surviving workers.
- A forced timeout exits **124** with an explanation, promptly.
- **Two consecutive full runs both reached a literal `GATE EXIT: 0`**, in
  2 m 40 s and 2 m 42 s.

Signal deaths, spawn failures and timeouts remain distinctly reported
(137 / 2 / 124) rather than collapsing into a bare exit 1. Treat any of those
three as a runner fault to investigate, never as a test result.

## Remaining items before publishing

These are publication-side steps this archive does not and cannot assert:

1. **Green GitHub Actions CI** on the exact tagged commit — plain and live/obfuscated startup, mobile layouts, lazy panels, screenshot composition, WebGL/WebGPU startup, stale-chunk recovery. The suite passes locally; the CI run is the gating proof.
2. **Package from a clean `main` checkout** so the release manifest carries the exact commit SHA, clean-tree status, and final checksums (local packaging already pins the commit; the published artifact must come from the merged commit).
3. **Confirm `CITATION.cff` `date-released`** is the actual publication day. It now reads the real date, and `lint:release-sync` fails when it predates the newest commit — but only publication day itself makes it true.
4. **Regenerate SBOM, manifest, and checksums** from the final tagged commit.

## Verdict

**Not ready to tag — but the remaining reasons are no longer correctness reasons reachable in ordinary use.** Every suite passes, the gate terminates and has now gone green twice in a row, and the release date is enforced rather than trusted.

**Physical multi-layer mounting is disabled** (`MULTI_LAYER_MOUNT_ENABLED = false`),
and a stream is never merged with a static cloud, because their local
coordinates are recentred about independent origins. Single-layer work — the
overwhelming majority of use — is unaffected.

Two things stand between this and a tag:

1. **The project transform still rewrites Float32 positions** rather than being held in Float64 beside source-local vertices. The gates around it are now unit-correct per axis and refuse past a millimetre, so the loss is bounded, measured and disclosed — but bounded is not absent, and this is the one open correctness item. Scope is measured in the coordinate-integrity roadmap, P1 item 2: 154 direct reads across 42 files, and it must land in all of them together.
2. **Browser evidence must come from a green GitHub Actions run on the tagged commit.** The local e2e suite passes; that is not the same claim.

When those are closed, publish as a GitHub **pre-release**, with multi-layer placement and advanced datum handling marked experimental. This is not a candidate for stable v0.6.0 or for a definitive Zenodo deposit.
