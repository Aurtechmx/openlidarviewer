# OpenLiDARViewer v0.6.2

v0.6.2 is a validation-and-correction release. It adds twelve specialized validation suites and fixes eighteen defects: twelve exposed by the new suites and six found through code review. All eighteen were missed by the test suite as it stood at v0.6.1, which still exited successfully with 6,182 passing tests and 16 skipped. Four of the eighteen affected output or documentation published with v0.6.1. Their impact and recovery steps are recorded in `docs/release/ERRATUM_v0.6.2.md`.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Corrected calculations and declarations

- PDF reports for Y-up PLY, OBJ and glTF scans no longer swap Depth and Height or calculate density from a vertical cross-section;
- declared units that cannot be resolved no longer silently become metres;
- vertical-unit conversion is applied consistently through terrain derivatives, void filling, volume calculations, streaming density and export paths;
- LAS 1.4 files written by OLV preserve their vertical datum and vertical unit when reopened;
- zero-extent clouds no longer receive a fabricated 1 m² footprint;
- vertical faces no longer report a level grade;
- non-finite values are no longer formatted as `NaN cm` or `Infinity km`;
- contour output distinguishes the requested interval from the spacing actually emitted;
- flat surfaces return an explicit reason when no contours exist;
- RFC 7946 GeoJSON elevations are converted to metres or omitted when that conversion cannot be established;
- prototype-key collisions in the method and benchmark registries are fixed;
- generated publication files are verified in both directions;
- documentation required by the source archive is restored;
- the invalid `actions/upload-artifact@v7` workflow reference is corrected.

## Stronger scientific evidence

Aspect and hillshade join slope at evidence level E4. All three were compared with GDAL 3.13.1 and closed-form results on the frozen analytic DEM under preregistered tolerances.

This validates the tested algorithms on that fixture. It does not establish field accuracy, survey-grade output, or validation of the complete point-cloud-to-terrain pipeline; every other terrain product remains at E3 or below.

Cross-platform reproducibility is tracked for one seeded fixture on darwin-arm64 and linux-x64, evaluated at the released commit. Fifteen science-scoped artifact hashes and eighteen scalar values were compared at zero tolerance, with no differences. Timing, host and build-identity fields remain platform-specific and are published per platform. The scope is two little-endian platforms, one commit and a synthetic fixture; Windows, big-endian hosts and real scan data are outside it.

## Validation infrastructure

Dedicated suites for:

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

Also included:

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

They are recorded as gaps, not passes.

## User guide

A user guide is published at [lidar.aurtech.mx/guide](https://lidar.aurtech.mx/guide), linked from the application header beside the GitHub link.

## Header controls

- a back-to-centre button returns the view to the loaded scan, using the same reset the navigation keybinding performs, and appears only once a scan is open;
- the full-screen button hides where the browser cannot honour it: iPhone Safari exposes the Fullscreen API for video only, while Android and iPadOS are unaffected, and an installed copy opens without browser chrome through the manifest's standalone display mode;
- header controls grow to 44 px on coarse pointers.

## Also in this release

- USGS Quality Levels are no longer inferred from point density;
- NVA/VVA-style values retain their internal hold-out basis;
- `ReportFindings` no longer states "Meets USGS QL1";
- contour GeoJSON combines model and provenance warnings;
- LAS files carry OLV build identity in the generating-software field;
- one canonical not-survey-grade statement is used across writers;
- seed-sensitive values are displayed only at supported precision;
- TypeScript moves to 7.0.2, Vite to 8.1.5 and Playwright to 1.62.0;
- `src/ui/panelChrome.ts` and `src/ui/headerControls.ts` are extracted from the main application module.

## Known limitations

The complete list is in `KNOWN_LIMITATIONS_v0.6.2.md`. Notable remaining limits:

- in-memory LAS reconstruction is less precise than the source file at very large local extents: approximately 1.9 mm over 50 km and 0.123 m over 5,000 km in the measured cases;
- LAS 1.2 masks classification values above 31 according to its available classification field;
- contour geometry crossing the antimeridian is not split at ±180°;
- opening a remote streaming source replaces the one already open;
- multi-layer mounting remains disabled;
- cross-system reprojection is not provided.

## Compatibility

Unchanged from v0.6.1. Modern Chromium browsers use WebGPU, with WebGL 2 fallback in Firefox and Safari, and existing sessions remain compatible.

- contour GeoJSON exported by v0.6.1 from a non-metre vertical CRS should be re-exported;
- an LAS 1.4 file written by v0.6.1 is correct on disk, but measurements or terrain results produced by reopening it in v0.6.1 may have interpreted its vertical unit incorrectly and should be recomputed.

The erratum distinguishes affected outputs from files that remain valid.

## Verifying this release

```bash
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-assets>
```

Nine assets form the verified set: the source and deploy archives, `sbom.json`, `test-evidence-v0.6.2.json`, `release-manifest-v0.6.2.json`, `gate.log`, `gate.log.sha256`, `RELEASE_NOTES_v0.6.2.md` and `SHA256SUMS`. The two GitHub-generated Source code archives are not part of that set.

## Citing

Citation metadata is provided in `CITATION.cff` and `.zenodo.json`.

ORCID: [0009-0007-3147-323X](https://orcid.org/0009-0007-3147-323X)

- Version: 0.6.2
- Release date: 2026-07-28
- License: MIT

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)
Full changelog: [v0.6.1...v0.6.2](https://github.com/Aurtechmx/openlidarviewer/compare/v0.6.1...v0.6.2)
