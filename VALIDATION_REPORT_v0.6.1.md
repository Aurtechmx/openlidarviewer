# Validation report — OpenLiDARViewer v0.6.1

This report states, soberly, what v0.6.1 validates and what it does not. It is the human-readable companion to the machine-readable claim register (`docs/validation/claim-register.yaml`).

v0.6.1 is a defect-fix release on top of v0.6.0. It corrects three defects an audit of the v0.6.0 archive found, each with a regression test that fails on the v0.6.0 code, and adds nothing a user can invoke. The evidence state of every registered claim is therefore unchanged: the fixes are at the export and decode boundary, not in an algorithm. Everything v0.6.0 validated it still validates, and the reasoning behind that evidence remains in [VALIDATION_REPORT_v0.6.0.md](VALIDATION_REPORT_v0.6.0.md), with the terrain and contour algorithms inherited from v0.5.9 as recorded in [VALIDATION_REPORT_v0.5.9.md](VALIDATION_REPORT_v0.5.9.md). This report covers what v0.6.1 itself adds to the record.

## Evidence ceiling

One product is at E4. The slope raster is cross-implementation validated: OpenLiDARViewer's Horn slope agreed with GDAL 3.13.1 and with the closed-form gradient over 11,564 interior cells on the analytic fixture, within the preregistered 0.5 degree tolerance (max difference under 0.001 degree). This is E4 for the slope algorithm on this fixture only — not the point-cloud-to-DTM pipeline, not field accuracy, not survey-grade. Every other terrain product tops out at E3 (synthetic known-truth against our own implementation); no product is field-validated (E5). The release's correctness guards are validated at E2–E3 against constructed inputs.

## What was tested for v0.6.1

Run with `npm run test:unit`, `test:export`, `test:terrain`, `test:ui`, `test:slow`, plus `npm run test:file <path>` for a single file.

Four defect fixes, each with a test that fails on the v0.6.0 code:

- **LAS 1.4 keeps the vertical datum and unit.** `tests/writeLas14.test.ts` verifies that a compound source (NAVD88 height in US survey feet over a projected horizontal CRS) produces both records: the WKT for the horizontal CRS and a GeoKey record carrying the vertical datum key (4096) and the vertical unit key (4099). It also verifies that no GeoKey record is written when there is no vertical to record, so the fix does not add an empty record to every file.
- **Contour elevations state their own unit.** `tests/contourDownload.test.ts` verifies that a foot vertical factor labels the contour `elevationUnit` as feet rather than metre, and that an unresolved factor reads unknown instead of defaulting to metre.
- **EPT laszip tiles refuse non-finite positions.** `tests/eptLaszipDecode.test.ts` verifies that a header whose scale is extreme but valid, and which overflows a coordinate to a non-finite value, is refused with the same structured error the COPC chunk and EPT binary decoders raise, rather than reaching the renderer as a blank cloud.
- **A truncated `.e57` terminates.** `tests/e57XmlUnterminated.test.ts` verifies that each unterminated XML construct throws a structured invalid-XML error, so the shared parse worker releases its gate and later file loads in the same session are unaffected.

The v0.6.0 test surface is unchanged and is listed in [VALIDATION_REPORT_v0.6.0.md](VALIDATION_REPORT_v0.6.0.md); every one of those tests still runs in this release's buckets.

Whole-suite evidence for this release comes from the release-mode gate run at the tagged commit — seven blocking stages (static gate, deterministic e2e, docs build, production audit, fixture checksums, coverage, mutation), each with its exit marker in the shipped `gate.log`: unit 3,140 passed / 16 skipped, export 618, terrain 1,240, ui 429, slow 531 — 5,958 passed / 16 skipped; deterministic e2e 161 passed / 4 fixture-skipped / 0 failed; production dependency audit 0 vulnerabilities. The authoritative record is the release asset `test-evidence-v0.6.1.json` (its SHA-256 is in `SHA256SUMS`, and `release-manifest-v0.6.1.json` binds the tag to the full 40-character commit and to every artifact hash — `npm run release:verify` walks the chain). A green GitHub Actions run on the pushed tag reproduces the same gate in CI; it comes into existence when the tag is published and is not asserted here.

## What was NOT tested (and is staged, not claimed)

- **Physical multi-layer mounting is DISABLED in v0.6.1.** The shared project frame and the compatibility model are present and tested; layers are not co-registered and are not merged into one estimator. Multi-layer placement is therefore unverified in a browser by construction — nothing places them. Compare Studio, cross-layer measurement and elevation ramps do not read frame offsets. See [KNOWN_LIMITATIONS_v0.6.1.md](KNOWN_LIMITATIONS_v0.6.1.md).
- **The benchmark framework under `benchmarks/` is scaffolding, and no figure comes from it.** It has its own tests, which run in the suite, but no runnable entry point, no npm script and no benchmark suite. Nothing in the application reads it, and this release publishes no benchmark result produced by it. The performance figures on record remain the ones in `docs/benchmarks.md`, measured before it existed.
- **Five vertical-unit gaps this release's audit found are open, not fixed.** The contour deliverable's GeoTIFF omits the vertical-unit GeoKey, the async/GPU derivative path takes no vertical-unit factor, `geodesicFill` mixes horizontal and vertical units in its step cost, the convenience hillshade wrappers assume isotropic cells and no vertical scaling, and `toGeoJSONWgs84` can write a source-unit height into an ordinate RFC 7946 requires in metres. Each is stated with its reachability in [KNOWN_LIMITATIONS_v0.6.1.md](KNOWN_LIMITATIONS_v0.6.1.md).
- **The anti-thrash streaming-selection option is opt-in and unwired.** Its logic is unit-tested; its visual effect on flicker is unverified because it needs a browser and is not enabled in this build.
- **Browser behaviour on GitHub CI is not part of this archive's evidence.** The e2e suite passed locally; a green GitHub Actions run on the exact tagged commit is required before publication and is not asserted here. The publication order is fixed: push the `v0.6.1` tag, confirm the CI gate is green on that commit, then deposit the archive and assets to Zenodo — the Zenodo record should name the tagged commit that CI verified.

## Reproducing

```bash
npm ci
npm run test:release     # typecheck, lints, live build, all buckets, smoke
npm run test:e2e         # full Playwright suite
```

## Verdict

The release's correctness guards are validated at the internal-evidence ceiling; the inherited terrain/measurement claims stand as in v0.5.9. Three exported figures that could be read in the wrong unit now state the right one, and one decoder refuses input the others already refused. No claim moved up the ladder, because no algorithm changed. The project-frame runtime integration and the browser-verified items are explicitly out of scope for this archive's evidence and are documented as staged.
