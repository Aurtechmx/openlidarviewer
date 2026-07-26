# v0.6.1 publication-readiness report

A sober account of what is ready and what remains before this patch release is published on GitHub.

## Release identity

- Version `0.6.1` across `package.json`, lockfile, README, CHANGELOG, `RELEASE_NOTES_v0.6.1.md`, `CITATION.cff`, and the service-worker cache (`lint:release-sync` enforces this).
- This is a patch release on the stable v0.6 line. It fixes three defects an audit of the v0.6.0 archive found and adds nothing a user can invoke, so the stability policy that v0.6.0 set applies unchanged.

## Test and build gate

Run by the release-mode gate at the tagged v0.6.1 commit — a literal `GATE EXIT: 0` with all seven stage markers in the shipped `gate.log`; the authoritative record is the release asset `test-evidence-v0.6.1.json`, hash-bound by `SHA256SUMS` and the release manifest:

- Static: `tsc --noEmit` clean; main-deferral, inline-imports, unsafe-html, layer-boundaries, claim-register, no-ignored-src, release-sync all pass.
- unit 3,357 (16 skipped) · export 618 · terrain 1,245 · ui 429 · slow 533.
- Build-contract 11; plain build and live/obfuscated build pass. Live entry 718 KiB against the 720 KiB hard ceiling, above the 680 KiB warning line, reproduced byte-identically across two clean builds. The margin is 2 KiB: treat the ceiling as effectively reached and shed weight before adding any, rather than raising it.
- Full e2e (`npm run test:e2e`): 161 passed, 4 fixture-skipped (autzen COPC not on disk), 0 failed — **locally**. The gating browser evidence is the green GitHub Actions run required below, not this local run.
- Documentation build (`npm run docs:build`) passes.

## Dependency and license

- Production dependency audit: **0 vulnerabilities**. (Dev-only tooling may carry advisories in nested VitePress/Vite/esbuild that are not in the deployed runtime.)
- License: MIT (`LICENSE`, `package.json`). SBOM (`sbom.json`, CycloneDX) regenerated from the current lockfile at root component `openlidarviewer 0.6.1`.

## Authorship and citation

- `CITATION.cff` declares `0.6.1`, dated 2026-07-25, and carries the Zenodo DOIs. The v0.6.0 version DOI it lists identifies the v0.6.0 archive; a v0.6.1 version DOI comes into existence only at deposit. Its `date-released` must be set to the **actual GitHub publication date** immediately before tagging.
- `AI_ASSISTANCE.md` covers v0.5.9 through v0.6.1 and links to this release's validation report.

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

- Evidence package: [VALIDATION_REPORT_v0.6.1.md](VALIDATION_REPORT_v0.6.1.md), [KNOWN_LIMITATIONS_v0.6.1.md](KNOWN_LIMITATIONS_v0.6.1.md). Terrain and measurement claims are inherited unchanged from v0.5.9: no algorithm changed in this release.
- Claim register (`docs/validation/claim-register.yaml`) version stamp advanced to `0.6.1` with the inheritance noted; `lint:claim-register` passes.

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

**Not ready to tag, and the remaining reasons are publication-side, not correctness.** Every suite passes, the gate terminates and reaches a literal `GATE EXIT: 0`, and the release date is enforced rather than trusted.

What this release changes is small and stated: three defects that made an exported figure readable in the wrong unit, or let a malformed input reach the renderer as a blank cloud, and the e57 parse-worker hang that came before them. Each carries a test that fails on the v0.6.0 code. The benchmark framework in `benchmarks/` is scaffolding with tests and no entry point; it is not a capability and no figure comes from it.

**Physical multi-layer mounting is still disabled** (`MULTI_LAYER_MOUNT_ENABLED = false`), and a stream is never merged with a static cloud, because their local coordinates are recentred about independent origins. Single-layer work, which is the overwhelming majority of use, is unaffected.

The five vertical-unit gaps this release's audit found and did not close are recorded in [KNOWN_LIMITATIONS_v0.6.1.md](KNOWN_LIMITATIONS_v0.6.1.md) with what would make each reachable. None is reachable through the shipped pipeline today; that is the reason they are documented rather than patched here, and it is not a reason to leave them open indefinitely.

One thing stands between this and a tag: **browser evidence must come from a green GitHub Actions run on the tagged commit.** The local e2e suite passes, which is not the same claim.
