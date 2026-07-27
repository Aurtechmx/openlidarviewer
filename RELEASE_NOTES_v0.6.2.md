# OpenLiDARViewer v0.6.2

v0.6.2 is a validation-and-correction release. It adds twelve specialized validation suites and fixes eighteen defects: twelve exposed by the new suites and six found through code review. All eighteen were missed by the test suite as it stood at v0.6.1, which still exited successfully with 6,182 passing tests and 16 skipped.

Four defects affected output or documentation published with v0.6.1. Their impact and recovery steps are recorded in `docs/release/ERRATUM_v0.6.2.md`.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Corrected calculations and declarations

PDF reports for Y-up PLY, OBJ and glTF scans no longer swap Depth and Height or calculate density from a vertical cross-section.

Declared units that cannot be resolved no longer silently become metres. Vertical-unit conversion is now applied consistently through terrain derivatives, void filling, volume calculations, streaming density and export paths. LAS 1.4 files written by OLV also preserve their vertical datum and vertical unit when reopened.

Unmeasured or undefined quantities are no longer presented as plausible measurements. Zero-extent clouds do not receive a fabricated 1 m² footprint, vertical faces do not report a level grade, and non-finite values are not formatted as `NaN cm` or `Infinity km`.

Contour output now distinguishes the requested interval from the spacing actually emitted. Flat surfaces return an explicit reason when no contours exist, and RFC 7946 GeoJSON elevations are converted to metres or omitted when that conversion cannot be established.

The release also fixes prototype-key collisions in method and benchmark registries, verifies generated publication files in both directions, restores documentation required by the source archive and corrects the invalid `actions/upload-artifact@v7` workflow reference.

## Stronger scientific evidence

Aspect and hillshade join slope at evidence level E4. All three were compared with GDAL 3.13.1 and closed-form results on the frozen analytic DEM under preregistered tolerances.

This validates the tested algorithms on that fixture. It does not establish field accuracy, survey-grade output or validation of the complete point-cloud-to-terrain pipeline. Every other terrain product remains at E3 or below.

Cross-platform reproducibility is also tracked for one seeded fixture on darwin-arm64 and linux-x64. Fifteen science-scoped artifact hashes and eighteen scalar values were compared at zero tolerance, with no differences. Timing, host and build-identity fields remain platform-specific.

## Validation infrastructure

The release adds dedicated suites for:

- reproducibility;
- scaling;
- cross-platform portability;
- physical-unit integrity;
- CPU/GPU backend equivalence;
- failure recovery;
- provenance and derived-result verification;
- contour correctness;
- LAS round-trip fidelity;
- archive portability;
- seed sensitivity;
- clean-clone execution.

It also includes:

- a schema-validated registry for the eighteen corrected defects;
- version-paired defect replay;
- production-path reachability witnesses;
- twelve targeted defect-pattern mutations;
- quick and full benchmark-verification commands;
- archive portability in the release gate;
- a relocatable validation snapshot whose summaries are regenerated from raw records.

Three of the twelve registered mutations still survive the complete gate:

- the exact equality boundary of the contour saddle rule;
- removal of `summary.html` from the required benchmark artifacts;
- omission of a document that shipped Markdown files still reference.

These remain documented validation gaps rather than being reported as passes.

## Also in this release

- USGS Quality Levels are no longer inferred from point density.
- NVA/VVA-style values retain their internal hold-out basis.
- `ReportFindings` no longer states "Meets USGS QL1."
- Contour GeoJSON combines model and provenance warnings.
- LAS files carry OLV build identity in the generating-software field.
- One canonical not-survey-grade statement is used across writers.
- Seed-sensitive values are displayed only at supported precision.
- TypeScript moves to 7.0.2, Vite to 8.1.5 and Playwright to 1.62.0.
- `src/ui/panelChrome.ts` is extracted from the main application module.

## Known limitations

`KNOWN_LIMITATIONS_v0.6.2.md` contains the complete list.

Notable remaining limits include:

- in-memory LAS reconstruction is less precise than the source file at very large local extents: approximately 1.9 mm over 50 km and 0.123 m over 5,000 km in the measured cases;
- LAS 1.2 masks classification values above 31 according to its available classification field;
- contour geometry crossing the antimeridian is not split at ±180°;
- opening a remote streaming source replaces the one already open;
- multi-layer mounting remains disabled;
- cross-system reprojection is not provided.

## Compatibility

Compatibility is unchanged from v0.6.1. Modern Chromium browsers use WebGPU, with WebGL 2 fallback in Firefox and Safari. Existing sessions remain compatible.

Contour GeoJSON exported by v0.6.1 from a non-metre vertical CRS should be re-exported.

An LAS 1.4 file written by v0.6.1 is correct on disk, but measurements or terrain results produced by reopening it in v0.6.1 may have interpreted its vertical unit incorrectly and should be recomputed. The erratum distinguishes affected outputs from files that remain valid.

## Verifying this release

```bash
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-assets>
```

## Citing

Citation metadata is provided in `CITATION.cff` and `.zenodo.json`.

ORCID: [0009-0007-3147-323X](https://orcid.org/0009-0007-3147-323X)

- Version: 0.6.2
- Release date: 2026-07-27
- License: MIT

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)
Full changelog: [v0.6.1...v0.6.2](https://github.com/Aurtechmx/openlidarviewer/compare/v0.6.1...v0.6.2)
