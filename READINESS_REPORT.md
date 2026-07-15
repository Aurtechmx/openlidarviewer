# v0.5.9 publication-readiness report

Recorded 2026-07-15. This is a point-in-time record of what was checked and what
remains. It complements [VALIDATION_REPORT_v0.5.9.md](VALIDATION_REPORT_v0.5.9.md)
(scientific evidence ceiling) and [DEPENDENCIES.md](DEPENDENCIES.md) (audit + SBOM).

## Release identity

- Version: 0.5.9 (consistent across package.json, lockfile, UI, service-worker
  cache name, manifest, docs, changelog, release notes, CITATION.cff — enforced by
  `lint:release-sync`).
- The release is tagged `v0.5.9`; the tag points at the final commit on `main`,
  which the release commands below (re)create and verify.
- Toolchain of record: Node v26.0.0, npm 11.12.1. `package.json` pins
  `npm@10.9.2` via `packageManager`; either resolves the same lockfile.
- Checksums are generated from the final archives by `npm run package`
  (`release/SHA256SUMS`); regenerate after the last commit.

## Test and build gate

Full `npm run test:release` was green on the code-complete commit. Counts:

| Stage | Result |
|---|---|
| typecheck + 8 lints | pass |
| test:build (chunk isolation, orbit smoke) | 11 pass |
| build:live + check:bundle | pass — index 791 / 800 KiB (99%) |
| unit / export / terrain / ui / slow buckets | 2495 / 539 / 1149 / 428 / 451 pass (34 skipped by design) |
| e2e smoke / smoke:live / smoke:mobile (320, 375) | 4 / 4 / 8 pass |

The final commits change documentation and code comments only. Re-run the full
gate on the tagged commit before publishing (the commands below do this); a
browser gate is only valid on the exact commit being published.

## Dependency and license

- Production `npm audit`: **0 vulnerabilities**.
- Full `npm audit` (with dev tooling): 3 advisories (2 moderate, 1 high), all in
  the vite / esbuild / vitepress dev server, which never ships. Recorded in
  [DEPENDENCIES.md](DEPENDENCIES.md) with remediation status.
- SBOM: [sbom.json](sbom.json), CycloneDX 1.6, 61 production components.
- License: MIT (LICENSE, package.json, CITATION.cff agree). Third-party
  attributions in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Authorship and citation

- Author: A. Urias (Aurtech) — from git history and CITATION.cff; no inferred
  people, ORCID, or DOI. [AUTHORS.md](AUTHORS.md), [CONTRIBUTORS.md](CONTRIBUTORS.md).
- CITATION.cff parses; required fields present; version 0.5.9, dated 2026-07-15.
  No preferred-citation DOI is asserted (none has been minted).

## Claims audit

Public claims were checked against source and tests. The docs are heavily hedged
and test-backed; four overstatements were found and three corrected in this pass:

- Fixed: "fully tested WebGL 2 fallback" → "automatic WebGL 2 fallback" (the
  fallback is three.js-provided and not exercised by a forced-off unit test).
- Fixed: headline export list now names the LAS (1.2 / 1.4) writer that ships.
- Fixed: "18+ … probed at release time" → "14 hand-vetted" (the catalog holds 14
  entries and there is no automated probe artifact).
- **Open (maintainer):** the E57 docs say the reader was "tested against Trimble
  exports". No Trimble fixture is committed. If this was a manual development
  check, keep it but word it as such; if aspirational, soften to "expected to
  work" (as the Leica/FARO line already is).

## Reference audit

All external references resolve and support their claims — 17 method citations
(SMRF, Horn, VRM, TPI, ASPRS, ICP, Wilson, spatial-block CV, and others), library
and standard attributions, the EPT spec link, and the live-demo URL. No dead
links, no fabricated DOIs. Three minor notes: the Münzinger "≥4 pts/m²" figure is
behind a paywall (citation verified, exact figure not independently re-read); one
LaRue reference points to a software/data archive rather than a paper; Du Preez is
2014-online / 2015-print. None blocking.

## Archive hygiene

The source archive (`git archive HEAD`, honouring `.gitattributes` export-ignore)
was extracted and scanned: no `node_modules`, `.git`, `.env`, source maps,
`.DS_Store`, transcripts, or absolute local paths; no keys/tokens/credentials.
The only "secret" string matches are honest documentation ("*not* a secret-keyed
signature") and the SSRF guard that strips URL credentials.

## Remaining items before publishing

1. Re-run `npm run test:release` on the final commit and confirm green.
2. Decide the Trimble E57 wording (above).
3. Push with a token that has `workflow` scope (`.github/workflows/*` changed).

## Verdict

Software gates are green and no correctness defects are open; metadata,
licensing, SBOM, and references are complete and honest. The one substantive open
item is the maintainer's call on the Trimble E57 wording — a text decision, not a
defect. Subject to the gate re-running green on the final commit:

**Readiness: 9 / 10.** Ready to publish once the final-commit gate is green and the
Trimble line is confirmed.
