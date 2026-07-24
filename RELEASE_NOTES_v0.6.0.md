# OpenLiDARViewer v0.6.0

v0.6.0 is the stable release of the v0.6 line. Its spatial operations are now deterministic and non-destructive, its measurements and layers describe their own context, and the release process, claims, and limitations are governed by version-controlled policy. Rendering and navigation behavior are unchanged from alpha.3.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Source geometry is immutable

The in-place Float32 rebase, the one mechanism that could rewrite a loaded scan's positions, has been removed. Mounting a layer into the shared project frame is now a Float64 placement held beside the data. The mesh is rendered through it, picking transforms into the layer's own frame and back, and camera bounds are folded before merging. A mount and unmount return the original values, because the source is never re-quantised.

This is enforced rather than asserted. `tests/sourceGeometryImmutable.test.ts` pins the full `PointCloud` surface and confirms the position buffer is byte-identical after every call. A new method fails to compile until it is pinned, and then must pass the byte comparison.

Physical multi-layer mounting remains disabled. The placement architecture is the prerequisite; enabling it requires browser verification of two-layer placement, and that gate is recorded.

## Measurements and layers describe their own context

Every measurement carries a context line: verified, approximate, or unavailable, each with its reason. The wording is contract-tested, so no label the application produces can use accuracy language.

Every layer carries a health card reporting its CRS and source, units, vertical datum, frame offset, mount precision, and the consequence of its compatibility state, alongside a compatibility report for the loaded set. The card and the combined estimators come from the same pass, so the two cannot disagree about a layer.

## Point-cloud exports disclose their scope

A point-cloud export of a streaming scan writes the resident set, and the file now records this:

`SUBSET: <held> of <declared> points the source declared, streamed resident set at display resolution, not the whole scan`

Without that line, a capped local file, a strided load, and a streamed resident set are indistinguishable from a complete export of a smaller scan. It uses the same comment channel that already reported display caps and load strides.

## Corrupt COPC input returns a structured error

Truncated headers, malformed metadata, hierarchy ranges past end of file, out-of-range entry values, corrupted LAZ chunks, and empty input now fail with a structured, human-readable error rather than a stack trace, each pinned by a fixture test. Two were defects: a past-end-of-file hierarchy range silently clamped by the range source, and a corrupted chunk that let the decompressor's raw abort value cross the worker boundary unchanged.

One limitation is recorded in the tests. A chunk that decodes to plausible but incorrect data cannot be detected without a checksum, which LAZ does not carry; the finite-positions backstop rejects only the non-finite subset. A complete COPC guide is at `docs/copc.md`.

## Claims, stability, and language are governed by policy

`CLAIMS_AND_LIMITATIONS.md` is the canonical source for what the project claims: the vocabulary (validated, verified, agreement, the E0 to E6 evidence ladder), the terms never used as claims, and the rule that a claim changes only through a versioned change of evidence. `STABILITY_POLICY.md` defines what this version freezes and how a frozen element may change. `lint:claims-language` fails the build on marketing superlatives.

The scientific evidence is unchanged from alpha.3. One E4 claim is registered: SLOPE-RASTER agrees with GDAL 3.13.1 and the closed-form gradient within the preregistered 0.5° tolerance on the analytic fixture. Every other terrain product remains at internal self-consistency, with no field validation and no survey-grade claim.

## Runtime verification

The recorded release gate completed with 5,961 passing tests and 16 skipped, and the deterministic end-to-end suite with 161 passing checks and 4 skipped. The published totals are read from the attached evidence file, not entered by hand. A passing suite confirms the implementation meets its specifications; it does not validate scientific correctness.

Two verification items are open, and are stated here rather than implied: the physical-device browser matrix (Windows Chrome, macOS Chrome, Safari, Firefox, one mobile device) has not been recorded for this release, and the frozen benchmark protocol in `docs/benchmarks.md` has not had its first run.

## Known limitations

Physical multi-layer mounting remains disabled.
The project frame is a tested foundation, not a fully active cross-layer system.
Streaming flicker near the point-budget boundary remains unresolved.
OpenLiDARViewer does not reproject between coordinate reference systems.
Scientific validation is limited to the registered SLOPE-RASTER E4 claim.
This release does not claim field validation or survey-grade accuracy.

## Compatibility

Modern Chromium browsers (Chrome, Edge) with WebGPU, falling back to WebGL 2 in Firefox and Safari. It reads LAS, LAZ, E57, PLY, OBJ, GLB/GLTF, XYZ, PCD, PTX, and PTS, and streams COPC and EPT. Sessions from the v0.6 alphas open without a migration step.

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

* Version: 0.6.0
* Release date: 2026-07-24
* License: MIT

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)  
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)
