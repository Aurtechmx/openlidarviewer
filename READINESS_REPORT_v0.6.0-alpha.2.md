# v0.6.0-alpha.2 publication-readiness report

A sober account of what is ready and what remains before this alpha is published on GitHub.

## Release identity

- Version `0.6.0-alpha.2` across `package.json`, lockfile, README, CHANGELOG, `RELEASE_NOTES_v0.6.0-alpha.2.md`, `CITATION.cff`, and the service-worker cache (`lint:release-sync` enforces this).
- This is a **pre-release / alpha** for evaluation; interfaces and internals may change before v0.6.0.

## Test and build gate

Run locally at the alpha head commit (**not yet a Git tag** — the published tag is cut from the merged commit). The figures below come from a run that reached a literal `GATE EXIT: 0`; see "The gate command is not reliably green" for why that is not the whole story:

- Static: `tsc --noEmit` clean; main-deferral, inline-imports, unsafe-html, layer-boundaries, claim-register, no-ignored-src, release-sync all pass.
- Unit 2,853 (16 skipped) · export 590 · terrain 1,218 (18 skipped) · ui 429 · slow 508.
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

## The gate command is not reliably green

`npm run test:release` passed with a literal `GATE EXIT: 0` twice in four
consecutive runs at this commit. The other two died with no test failure and no
diagnostic: one was terminated during the plain build (exit 143), one exited 1
on entering the `ui` bucket having printed nothing. The `ui` bucket run on its
own passed three times out of three, so the instability is in the wrapper's
long chain rather than in any test — an external review reported the same
symptom independently as `Worker exited unexpectedly`.

Every figure quoted in this report comes from a run that reached `GATE EXIT: 0`.
That is not the same as the command being dependable, and a release command
that fails half the time cannot gate a tag. **Treat this as a release blocker
in its own right**: the runner needs to either succeed or say why it did not.

## Remaining items before publishing

These are publication-side steps this archive does not and cannot assert:

1. **Green GitHub Actions CI** on the exact tagged commit — plain and live/obfuscated startup, mobile layouts, lazy panels, screenshot composition, WebGL/WebGPU startup, stale-chunk recovery. The suite passes locally; the CI run is the gating proof.
2. **Package from a clean `main` checkout** so the release manifest carries the exact commit SHA, clean-tree status, and final checksums (local packaging already pins the commit; the published artifact must come from the merged commit).
3. **Set `CITATION.cff` `date-released`** to the publication day.
4. **Regenerate SBOM, manifest, and checksums** from the final tagged commit.

## Verdict

**Not ready to tag.** Application code and packaging hygiene are in place and every suite passes on a completing run, but the release gate itself only completes about half the time, and that has to be fixed before its result can gate anything. Publication additionally needs a green CI run on the tagged commit and the tag-time metadata steps above. When those are closed, publish as a GitHub **pre-release**.
