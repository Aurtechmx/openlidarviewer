# Validation report: OpenLiDARViewer v0.6.8

## No product changed evidence level

The register holds 34 claims: 2 at E1, 6 at E2, 9 at E3 and 17 at E4. Nothing
reached E5. No claim changed level. One claim was ADDED at E2:
CONTOURS-CARTOGRAPHIC separates the generalized contour line from the analytical
one, which had been carrying the analytical geometry's E4 cross-check even though
generalization deliberately moves vertices off the line that study measured. That
is a correction to what was claimed, not a new result. This release promotes no
claim, so there is no new cross-implementation or field result to report, and the
scientific invariance gate confirms the terrain products are unchanged. Ten
commits in this cycle carry an `e5` prefix, and every one of them prepares the
Rogue holdout rather than reporting it: the tiles are registered, the split is
deterministic and exposure-honest, and the manifests recompute their invariants.
Preparation is not a result.

## What the engineering work is, and how it is covered

The out-of-core cache, the streaming readiness and refinement changes, the
provenance artifacts and the scan-output corrections are engineering. They are
covered by the deterministic gate rather than by a study, because none of them
changes a terrain number.

The invariance gate is the load-bearing check here.

The DTM method digests and the 255-file validation fingerprint are unchanged.
That is what establishes that a release touching 568 files and 190 commits moved
no surface, no contour and no derived raster. A gate that only ran the tests
would not have shown it.

## What was tested for v0.6.8

The full release gate ran to completion on the release commit: typecheck, 44
lint scripts, the unit, terrain, export, user-interface and slow buckets, the
build, the bundle budget, the dataset and validation verifiers, the freeze and
snapshot verifiers, archive portability, and the smoke suites. The reachability
summary records 9 witnessed checks, 0 unreached and 1 unwitnessed.

Cross-browser runs on Chromium, Firefox, WebKit and Windows were green when the
release was cut, and Firefox and WebKit are advisory rather than blocking, so
their green is a fact about this commit and not a guarantee the gate enforces.

## What was NOT tested, and is not claimed

- No field accuracy result. No product is at E5, and the Rogue holdout has not
  been run.
- Touch gestures were not exercised on WebKit or Firefox. See the known
  limitations.
- The registration stack and the stockpile area-grid estimator have unit tests
  and no user path, so nothing here validates them as features.
- Three measurement figures have a documented basis problem that this release
  did not correct, listed in `KNOWN_LIMITATIONS_v0.6.8.md`. They are labelled in
  the interface with the population they describe.
- Mutation testing runs on its own schedule and is not part of this gate. The
  record cites its last result and the commit it was measured at.
