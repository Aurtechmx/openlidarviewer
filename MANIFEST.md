# OpenLiDARViewer archive manifest

OpenLiDARViewer is a browser-native, local-first viewer for LiDAR and
point-cloud data. It measures scans, analyses terrain, and writes reports you
can reproduce. This file maps the deposit: what the archive holds, and where
its provenance lives.

The version, publication date, authors, and license are in `CITATION.cff`.
The `CHANGELOG.md` records the same date under the matching version heading.

## Provenance: how to tie this archive to a commit

The exact git commit, the tag, and a SHA-256 for every release artifact are
recorded in `release-manifest-v0.6.0.json`, which ships with the release
assets rather than inside this source tree, since a file cannot carry its own
commit hash. `SHA256SUMS` lists a digest for each file, and `npm run
release:verify` walks that chain from the tag to the commit to every artifact
hash.

The machine-generated test evidence for the tagged build is in
`test-evidence-v0.6.0.json` (also a release asset). The committed copy under
`docs/validation/test-evidence.json` is marked non-authoritative and describes
development runs.

## What to read first

- `RELEASE_NOTES_v0.6.0.md`: what changed in this release.
- `VALIDATION_REPORT_v0.6.0.md`: what was and was not tested, and the honest gaps.
- `KNOWN_LIMITATIONS_v0.6.0.md`: the documented limits.
- `REPRODUCIBILITY.md` and `REPRODUCIBILITY_v0.6.0.md`: how to rebuild, test,
  and regenerate the reported figures. The versioned file ties each figure to
  the command that produces it.
- `CLAIMS_AND_LIMITATIONS.md`: the canonical policy for what the project claims
  and the vocabulary it uses, including the E0 to E6 evidence ladder.
- `STABILITY_POLICY.md`: what this stable version freezes and how frozen things
  change.
- `ARTIFACT_EVALUATION.md`: a reviewer's quickstart.

## Dependencies and attribution

- `DEPENDENCIES.md`: the committed dependency baseline.
- `sbom.json`: a CycloneDX software bill of materials.
- `THIRD_PARTY_NOTICES.md`: third-party licenses.
- `AI_ASSISTANCE.md`: how generative AI tools were and were not used.

## Layout

- `src/`: application source.
- `tests/`: the test suite.
- `scripts/`: the build, lint, and release tooling.
- `docs/` and `docs-site/`: documentation and the validation site source.
- `benchmarks/`: the frozen benchmark protocol.
- `public/`: static assets served with the app.

## License

MIT. See `LICENSE`.
