# OpenLiDARViewer v0.6.2

v0.6.2 is a validation-and-correction release. Twelve validation suites were added, and eighteen defects were fixed. Twelve of those defects were exposed by one of the new suites and six came from code review, five of the six carried over from the vertical-unit audit recorded for v0.6.1. Four reached output that v0.6.1 published, and `docs/release/ERRATUM_v0.6.2.md` states for each what the software did, which files carry the error and what recovers a correct figure.

Every one of the eighteen was missed by the test suite as it stood at v0.6.1. That is measured rather than assumed: the v0.6.1 test tree was checked out and run against the defective code, and it exits 0 with 6,182 tests passing and 16 skipped. Per-defect records, including why each was not detected, are in `validation/defects/defect-registry.json`.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## What the new suites found

Ten of the eighteen fixes are unit, axis or declaration faults in code that ships. A foot-vertical scan came back about 3.28 times too steep from the asynchronous derivative path, the despike floor cut at about 9 cm where 30 cm was intended, and `geodesicFill` summed a horizontal step in source units against a rise in vertical ones. A PDF report from a PLY, OBJ or glTF scan printed the height as Depth and divided the point count by a vertical cross-section, while the on-screen Scan Report had the axes right the whole time. A foot-CRS tile graded sparse when streamed and moderate when loaded statically, because only the static path converted the header box to cubic metres first.

The rest sit in what the software says about its own output. A contour set declared the interval that was requested rather than the one it emitted, off by a factor of 15 on the measured fixture. A flat surface returned an empty contour set with no explanation. The RFC 7946 contour file wrote a source-unit height into an ordinate the format defines as metres. A LAS 1.4 file this application wrote lost its vertical datum and vertical unit on reload, because the reader treated the WKT record and the GeoKey record as alternatives while the writer used both.

Three quantities stopped being reported as measured when nothing had been measured. A cloud of coincident points came back with 1 m2 of floor and 40 points per m2 from a placeholder cell, a vertical face printed a level grade, and a non-finite length printed as `NaN cm`.

## Corrections to v0.6.1

Four entries in `docs/release/ERRATUM_v0.6.2.md` correct published v0.6.1 statements or output: the Y-up PDF report figures, results computed from a CRS declaring a linear unit the software could not resolve, results computed from a LAS 1.4 file this application wrote, and the scope statement `KNOWN_LIMITATIONS_v0.6.1.md` gave for the `geodesicFill` unit mixing. That last one said the defect affected a non-default mode. Geodesic is the fill that built every DTM surface the application produced, so the statement understated it. Which surfaces changed value is narrower than which used the path, and the erratum separates the two.

## Aspect and hillshade join slope at E4

Three terrain products have now been compared against an independent implementation. Aspect and hillshade were each checked against GDAL 3.13.1 and against the surface's closed-form gradient on the same frozen analytic DEM the slope reference already used, within tolerances registered before the references were generated. No algorithm changed; what changed is what the evidence supports.

The hillshade result carries a caveat the other two do not. The byte-encoding difference between the two implementations spends most of a one-level budget on its own, so the ours-against-GDAL leg is a weak instrument by itself and the claim rests on the closed-form leg and on an exact re-encoding identity. `docs/validation/cross-implementation.md` states it in full.

Every other terrain product tops out at E3. E5 is unreached, nothing here is field-validated, and the three E4 results validate algorithms on one analytic fixture rather than the point-cloud-to-DTM pipeline.

## The same arithmetic on a second architecture

Cross-platform reproducibility is established and tracked at `docs/validation/evidence/portability-v0.6.2/`. On darwin-arm64 and linux-x64, one seeded fixture produced identical science-scoped output: 15 artifact hashes and 18 scalars compared at a tolerance of exactly zero, with none differing. Host, timing and build-identity fields differ and are published per platform.

The scope is two little-endian platforms, one commit and a synthetic fixture. Windows, big-endian hosts and real scan data are outside it.

## What is runnable

Twelve validation suites ship with their own npm scripts, and each states what it does not cover: reproducibility, scaling, cross-platform portability, unit integrity, GPU-versus-CPU backend equivalence, failure recovery, provenance integrity, contour correctness, LAS round-trip fidelity, archive portability, seed sensitivity and clean-clone. Alongside them the release adds `validation/defects/defect-registry.json`, a reachability layer that witnesses which production calls the validation paths actually reach, and a targeted mutation campaign in `validation/mutations/`.

The development toolchain moves to TypeScript 7.0.2, Vite 8.1.5 and Playwright 1.62.0. All three are development-only, so the shipped runtime dependency set and the SBOM are unchanged.

## User guide

A user guide is published at [lidar.aurtech.mx/guide](https://lidar.aurtech.mx/guide). The application header links to it beside the GitHub link.

## What the gate still does not catch

The mutation campaign exists to answer that question with evidence rather than confidence, and four of its twelve targeted mutations survive the full gate. `validation/mutations/summary.md` carries the current state and the commands. As recorded there:

- A required unit conversion removed in `analyseContours.ts`, so a foot-CRS grid reads 3.28 times too steep.
- A changed saddle-ambiguity rule in `contoursAt.ts`, which no fixture reaches.
- A required-artifact check dropped in the benchmark verifier, so a result tree missing `summary.html` verifies clean.
- An archive include removed from `.gitattributes`, so a document the shipped markdown links to vanishes from the archive.

Each is a real hole rather than a rounding of one, and none is closed by this release.

## Known limitations

`KNOWN_LIMITATIONS_v0.6.2.md` carries the full list. The in-memory reconstruction remains less precise than the LAS file it came from: 1.9 mm over a 50 km extent where the file itself round-trips exactly, and 0.123 m over a 5000 km extent. Antimeridian-crossing contour geometry is not cut at 180 degrees. Opening a remote streaming source replaces the streaming source already open, which was previously undocumented.

The five vertical-unit gaps the v0.6.1 audit recorded are all closed here. Everything else disclosed for v0.6.1 still applies, including the two monoliths, multi-layer mounting remaining disabled, and the absence of cross-system reprojection.

## Compatibility

Unchanged from v0.6.1. Modern Chromium browsers with WebGPU, falling back to WebGL 2 in Firefox and Safari. Sessions from earlier releases are unaffected.

Files exported by v0.6.1 are a different matter. An RFC 7946 contour file from a foot vertical CRS carries a source-unit number in a metre field and should be re-exported. A LAS 1.4 file this application wrote is correct on disk, and figures derived from reopening it in v0.6.1 are not. The erratum says which is which.

## Verifying this release

```bash
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-assets>
```

The asset set and hash chain are documented in `docs/release/RELEASE_ASSETS.md`.

## Citing

Metadata is in `CITATION.cff` and `.zenodo.json`
(ORCID [0009-0007-3147-323X](https://orcid.org/0009-0007-3147-323X)). The author
declares no competing interests; development is self-funded by Aurtech.

* Version: 0.6.2
* Release date: 2026-07-27
* License: MIT

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)  
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)
