# Validation report: OpenLiDARViewer v0.6.3

This report states, soberly, what v0.6.3 validates and what it does not. It is the human-readable companion to the machine-readable claim register (`docs/validation/claim-register.yaml`).

v0.6.3 is a validation-and-correction release on top of v0.6.1. It adds twelve runnable validation suites, fixes eighteen defects, and corrects four v0.6.1 statements or outputs in `docs/release/ERRATUM_v0.6.3.md`. The terrain and contour algorithms are still the ones inherited from v0.5.9 and recorded in [VALIDATION_REPORT_v0.5.9.md](docs/releases/VALIDATION_REPORT_v0.5.9.md); the reasoning behind the v0.6.0 evidence state remains in [VALIDATION_REPORT_v0.6.0.md](docs/releases/VALIDATION_REPORT_v0.6.0.md), and the v0.6.1 defect fixes in [VALIDATION_REPORT_v0.6.1.md](docs/releases/VALIDATION_REPORT_v0.6.1.md). This report covers what v0.6.3 itself adds to the record.

## Evidence ceiling

Three products are at E4. Slope, aspect and hillshade each agreed with GDAL 3.13.1 and with the surface's closed-form gradient on one frozen analytic DEM, within tolerances registered before the references were generated. `SLOPE-RASTER`, `ASPECT-RASTER` and `HILLSHADE` carry E4 on that basis, up from one product at v0.6.1.

The hillshade tolerance is weaker than the other two. Both sides implement the same illumination model over a Horn gradient and differ in byte encoding, and that offset spends most of a one-level budget by itself, so the ours-against-GDAL leg is a weak instrument alone. The claim rests on the closed-form leg and on re-encoding this project's intensity in GDAL's scale, which reproduces the reference exactly at every cell. `docs/validation/cross-implementation.md` and `docs/validation/THREATS_TO_VALIDITY.md` state the limit.

E4 here means the algorithm agrees with an independent implementation on one analytic fixture. It is not the point-cloud-to-DTM pipeline, not field accuracy and not survey-grade. Every other terrain product tops out at E3, which is synthetic known-truth against this project's own implementation. E5 is unreached and nothing in this release is field-validated.

## What eighteen defects say about the suite that missed them

Every one of the eighteen defects fixed here was present at v0.6.1 and passed by the suite as it stood there. That is a measurement, not an inference: the `tests/` tree at tag v0.6.1 was checked out into a worktree with the working tree's `node_modules` and run under vitest with no environment gating. It exits 0, with 507 test files passing and 2 skipped, and 6,182 tests passing and 16 skipped, while the defective code is present. A green run is not evidence that any test in it exercised a defect.

One record qualifies that. `benchmarks/runner/verify.ts`, which carries two of the verifier blind spots in `OLV-DEF-015`, did not exist at v0.6.1, so the v0.6.1 suite cannot be evaluated against it; the file carrying the sibling `toHashable` fault did exist and did pass. That record is marked `mixed` rather than `green` for exactly this reason. The other seventeen are `green` without qualification.

The composition, derived from `validation/defects/defect-registry.json` rather than restated by hand:

- Twelve were exposed by one of the new validation suites; six came from code review. Five of the six were already recorded as open gaps by the v0.6.1 vertical-unit audit, and one was found while threading the vertical-unit factor through the fill and slope stages.
- Nine are severity high, seven medium, two low.
- Four reached output that v0.6.1 published. Each is stated in `docs/release/ERRATUM_v0.6.3.md` with who is affected and what recovers a correct figure.
- Six have `detectingMechanism: none`, meaning no suite in this release would have found them either. They came from reading the code.

Each record carries its own `whyNotDetected` field, and the answers repeat: a test pinned the defective behaviour as expected, or two paths were each checked against their own assumptions and never against each other, or the fixture used the unit in which the fault is invisible. The cross-path comparisons the new suites run are aimed at that shape.

## What was tested for v0.6.3

Run with `npm run test:unit`, `test:export`, `test:terrain`, `test:ui`, `test:slow`, plus `npm run test:file <path>` for a single file. Every regression test named in the defect registry runs in the default vitest suite.

Twelve validation suites are runnable on their own, and each states what it does not cover:

- Reproducibility (`benchmark:repro`): one documented seed, 250k points, ten recorded runs, passing only when every science-scoped hash and scalar is identical across all ten at zero tolerance.
- Scaling (`benchmark:scaling`): 50k through 1M, five runs a tier, each tier in its own process. No complexity class is claimed.
- Cross-platform portability (`benchmark:repro:portable`, `benchmark:compare-platforms`): a per-platform leg and a comparator that checks the source-cloud hash first, then every science-scoped hash and scalar at zero tolerance.
- Unit integrity (`benchmark:units`): one physical scene through a metre CRS, a foot CRS, a compound frame and a Y-up axis order, comparing what each path reports.
- Backend equivalence (`benchmark:backends`): GPU against CPU, recorded as backend-unavailable when a requested backend fell back, so a Node run cannot report the CPU agreeing with itself.
- Failure recovery (`benchmark:failures`): truncated bodies, corrupt headers, degenerate geometry, missing and unresolvable CRS, aborted reads, each with a healthy control off the same fixture.
- Provenance integrity (`benchmark:provenance`): whether every exported artifact names its source, its method chain with bound parameters, its build and its limitation, and whether an edit stays detectable once the attacker refreshes the digests.
- Contour correctness (`benchmark:contours`): generated contours against plane, cone, paraboloid and saddle, the topological invariants of a level set, and the declared-against-actual properties, with a negative control on every predicate.
- LAS round-trip fidelity (`benchmark:roundtrip`): both writers read back twice, once by an independent spec-offset decoder in float64 and once by the application's own loader, with tolerances derived from the scale factor the file declares.
- Archive portability (`benchmark:archive-portability`): the released source archive checked from an extract in a temp directory outside the repository, refusing an archive directory inside the repo or carrying a `.git` so there is no working-tree fallback to pass by accident.
- Seed sensitivity (`benchmark:seeds`): the same analysis across seeds, with scalars printed at the precision the sweep supports rather than at full float width.
- Clean clone (`benchmark:clean-clone`): what a fresh clone can run. Inside an archive with no repository around it the check records itself as unrun rather than failed.

Three records support them. `validation/defects/defect-registry.json` holds one machine-readable record per fixed defect. `validation/reachability/claims.json` witnesses which production call sites the validation paths actually reach, so a suite that exercises only a convenience wrapper is visible as such. `validation/mutations/` holds a targeted mutation campaign over the defect patterns.

Whole-suite evidence for this release comes from the release-mode gate run at the tagged commit, with an exit marker per blocking stage in the shipped `gate.log`. The authoritative record is the release asset `test-evidence-v0.6.3.json`; its SHA-256 is in `SHA256SUMS`, and `release-manifest-v0.6.3.json` binds the tag to the full 40-character commit and to every artifact hash, which `npm run release:verify` walks. Published totals are read from that file rather than entered by hand, and `npm run lint:evidence` checks the documents against it. A green GitHub Actions run on the pushed tag reproduces the same gate in CI; it comes into existence when the tag is published and is not asserted here.

## What the gate does not catch, measured

A suite cannot report the holes it does not have. The targeted mutation campaign in `validation/mutations/` measures them: twelve mutations drawn from the defect patterns above, each run against the conventional suite as it stood at v0.6.1, against a specialized suite, and against the full gate. Four survive all three. From `validation/mutations/summary.md`:

- M01, a removed unit conversion in `src/terrain/contour/analyseContours.ts`: slope is computed from a native-unit rise against a metre run, so a foot-CRS grid reads 3.28 times too steep.
- M04, a changed saddle-ambiguity rule in `src/terrain/contour/contoursAt.ts`: a saddle exactly at the level takes the other pairing, relinking contour topology at that cell. No fixture reaches it.
- M07, a skipped artifact check in `benchmarks/runner/verify.ts`: a result tree missing `summary.html` verifies clean. Its conventional cell is not-applicable, since the file did not exist at v0.6.1.
- M09, a removed include in `.gitattributes`: a document the shipped markdown links to is dropped from the archive.

Four more survived the conventional set and were killed by a specialized suite, which is what those suites were added for. The scope is the listed mutations over the listed modules, and nothing here measures mutation coverage of the rest of the repository. The conventional reconstruction is not green on its own, so detection is scored on new failures against its own baseline rather than on a run being red.

## What was NOT tested (and is staged, not claimed)

- Physical multi-layer mounting is DISABLED in v0.6.3. The shared project frame and the compatibility model are present and tested, and the app now owns a live project frame; layers are not co-registered and are not merged into one estimator. Multi-layer placement is unverified in a browser by construction, because nothing places them. See [KNOWN_LIMITATIONS_v0.6.3.md](KNOWN_LIMITATIONS_v0.6.3.md).
- Windows is not a reproducibility leg. The tracked two-platform result covers darwin-arm64 and linux-x64, both little-endian, at one commit on one synthetic seeded fixture. Untested platforms, other runtime versions, big-endian hosts and real scan data are outside it. A local run on one machine reports `single-platform` with `claimEstablished: false`, which is the correct verdict for one leg.
- GPU-computed derivatives beyond the engine probe surfaces. The WebGPU backend takes the same cell-metres and vertical-factor arguments as the CPU one, but Node has no adapter, so the engine falls back to CPU and a check there would test the CPU path twice. GPU-versus-CPU agreement rests on the engine's own equivalence probe, which runs in a browser and covers the probe surfaces only.
- LAZ output. `CONVERT_FORMATS.laz.available` is false. There is no LAZ encoder, so there is no file of the application's own to read back, and the compression leg is untested.
- Third-party writer conformance. The round-trip suite reads every file back with two readers over one writer. Whether PDAL, lastools or a commercial writer produces files this reader handles, and whether they accept these files, is not measured.
- `npm ci` and a build from a clean extract. The archive-portability suite runs the archive's node-only verification inside an extract with no repository around it. A tool that cannot start without `node_modules` is recorded as needing dependencies, and one that needs a build is recorded as needing a build, rather than counted as a pass. Neither the install nor the build is performed there.
- Render-space lengths, the measurement HUD and rasterised report composition. These need a WebGL or canvas context. Only the pure label and figure builders behind them are checked.
- The anti-thrash streaming-selection option is opt-in and unwired. Its logic is unit-tested; its visual effect on flicker needs a browser and is not enabled in this build.
- Browser behaviour on GitHub CI is not part of this archive's evidence. The e2e suite passed locally. The publication order is fixed: push the `v0.6.3` tag, confirm the CI gate is green on that commit, then deposit the archive and assets.

## Reproducing

```bash
npm ci
npm run test:release     # typecheck, lints, live build, all buckets, smoke
npm run test:e2e         # full Playwright suite
```

Per-figure commands are in [REPRODUCIBILITY_v0.6.3.md](REPRODUCIBILITY_v0.6.3.md).

## Verdict

Two things moved. The evidence ceiling went from one cross-implemented terrain product to three, and cross-platform output identity went from untested to established on two little-endian platforms. Neither is field validation, and neither raises any other product above E3.

Against that, eighteen defects were present at v0.6.1 and the suite of the day passed on all of them. Four had already reached published output. What the twelve new suites and the mutation campaign establish is a measured account of where the checks reach and where they do not, including four gate-surviving mutations that this release does not close. The correct reading of v0.6.3 is that specific figures are corrected and specific coverage is now measured, not that the software is now validated.
