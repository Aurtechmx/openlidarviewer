# OpenLiDARViewer v0.6.4

v0.6.4 is a reliability and data-integrity release. It hardens how remote scans stream and how they cancel and time out, makes session and export writes snapshot-consistent, and turns a large class of "unknown coordinate unit" cases from a silent number into a refusal or a disclosed caveat. It also lifts several blocks out of the two monoliths, splits the stylesheet into ordered sections, and adds opt-in classification with export improvements. The measured figures in this document come from the release-mode gate run at the tagged commit.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Reliability and data integrity

- an EPT manifest that stalls now surfaces as a timeout the user can see, rather than a silent cancellation that leaves the load looking finished;
- EPT and COPC share one cancel-versus-timeout-versus-transport-error convention, so a user cancel stays silent, an internal deadline reads as a timeout, and a network or HTTP fault stays a visible error on both paths;
- opening a second remote COPC scan is transactional: the scan on screen survives until its replacement is ready;
- streaming eviction gained hysteresis at the point budget boundary, so regions near the limit stop pulsing in and out on consecutive frames;
- a `.olvsession` export captures one coherent snapshot of scan and viewer state before its first `await`, verifies the same scan is still active, and refuses the write rather than combine state from two scans;
- report and map-sheet exports capture their inputs before the first `await` and re-check them before writing;
- E57 page checksums are verified instead of discarded, so a corrupted page is caught rather than decoded;
- session restore and the embed bridge validate untrusted input before acting on it;
- the workflow recorder's download handler no longer races a teardown.

## Coordinate units, honest by default

A projected coordinate system whose linear unit cannot be confirmed used to flow into figures as if it were metres. Across the report, measurement, export and scorecard surfaces, an unconfirmed unit now fails closed: the figure is withheld or marked rather than stated wrong.

- footprint area, scan-report extents, epoch cut and fill, epoch alignment residual and shift, the fitness scorecard, the full-cloud grade and the stockpile volume each refuse or disclose when the unit is unknown;
- four report and UI surfaces fail closed on an unknown CRS unit rather than assume one;
- the linear-unit-known gate is single-sourced, and a missing CRS in epoch compare fails closed instead of reading as a known unit;
- metric and coordinate consumers route through one spatial context, so a value derived twice is derived the same way;
- wide-area Float32 quantization is measured, disclosed, graded and refused past the point where it would corrupt a figure, and a Float64 project frame is available as a non-mutating on-ramp;
- every direct position read is classified by coordinate frame, counted through one shared module, and the height vertical-reference is threaded through the measure gate and the scan report;
- a truncated COPC or EPT hierarchy is never graded as exact;
- a session that redefines a scan's CRS, axis or unit on restore is refused;
- reprojection results carry their transform provenance, and WKT fields are read with an AST parser rather than a regular expression.

## Classification

- a standalone Auto-classify button in the Edit-classes panel, styled as an accent action;
- automatic classification is return-number aware, so a multi-return point reads as vegetation;
- an opt-in low-vegetation-by-greenness mode assigns ASPRS class 3;
- building classification is gated on firmer ground support;
- auto-classify keeps the scan's natural colour rather than forcing the class palette;
- full-resolution classified export is refused while unsaved class edits are present, and the drop is disclosed where it applies.

## Exports

- exported KML polygons carry an explicit style, so Google Earth stops filling scan-area and annotation polygons opaque white;
- a scan-area KML that wraps the antimeridian or is measured Y-up is refused rather than drawn wrong;
- the map sheet includes annotations by default when the scan has them, with numbered markers and a table, and threads the Contour Studio purpose into the PDF;
- the approximate-datum caveat is carried into the exported file, not shown only in the UI;
- PDF accessibility metadata is present on all emitters.

## Viewer and platform

- WebGPU falls back to WebGL 2 when no adapter is present, fixing an iOS WebKit crash on scan open;
- the contour readiness card renders its value inline rather than as a vertical column;
- mobile landscape layout and controls are refined, and the mobile interface matches the hero console;
- a colour mode is recommended on scan load;
- navigation preferences can invert orbit X and Y with presets;
- profile-station dots couple to chart and table hover.

## Architecture

The two monoliths continue to shrink. Streaming session assembly moved behind a `StreamingHost`, and report, scan-open, streaming-open, render-loop, session-import and snapshot paths moved behind structural dependency objects. The Measurements panel mounts lazily, which returned the index chunk from 720 to 673 KiB. `style.css` is split into ordered section files under `src/styles/`, kept byte-for-byte against a golden fixture. Unwired dead code (3D-tiles decode, SSAO, photoreal, context view) is removed. Architecture documents are machine-checked against the tree, so a stale line count or claim fails the gate.

## Scientific evidence

- the derived classifier is frozen against an evaluation corpus, and the ground-recall collapse is diagnosed rather than hidden;
- cross-implementation CRS reference fixtures (PROJ and pyproj) are on file, and a synthetic evaluation covers the building ground-support gate;
- the non-redistributable E57 fixture is replaced with a generated synthetic one;
- an acquired dataset's recorded hash is checkable.

## Security and supply chain

- SonarCloud analysis is scoped to shipping code. Its real defects are fixed and integer truncation is guarded;
- the embed bridge is hardened against untrusted input;
- a signed-URL secret scan runs in CI. A vulnerable transitive image-size dependency is pruned behind a texture-compressor stub, and build-tooling dependencies are updated.

## Known limitations

The complete list is in `KNOWN_LIMITATIONS_v0.6.4.md`. Carried forward and unchanged by this release:

- in-memory LAS reconstruction is less precise than the source file at very large local extents;
- LAS 1.2 masks classification values above 31;
- contour geometry crossing the antimeridian is not split at ±180°;
- opening a remote streaming source replaces the one already open;
- multi-layer mounting remains disabled, pending per-layer frame fixes, with the flag guarded;
- mixed-CRS layers are not automatically reprojected into a common viewer frame; supported exports can be explicitly reprojected through the converter.

New in this release:

- the Windows and High Contrast work from v0.6.3 is still verified against a forced browser configuration, not on Windows or in a real High Contrast session;
- queue-metered streaming commits remain implemented and tested but disabled, and carry no performance claim;
- the ground-classification recall figure is measured against PDAL on synthetic scenes only.

## Compatibility

Unchanged from v0.6.3. Modern Chromium browsers use WebGPU, with WebGL 2 fallback in Firefox and Safari, and existing sessions remain compatible. A preset selected in an earlier version applies the same visual settings, and session files are unaffected.

## Verifying this release

```bash
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-assets>
gh attestation verify <archive> --repo Aurtechmx/openlidarviewer
```

The verified asset set is listed in `release-manifest-v0.6.4.json`. The two GitHub-generated Source code archives are not part of it.

## Citing

Citation metadata is provided in `CITATION.cff`, `.zenodo.json` and `codemeta.json`.

ORCID: [0009-0007-3147-323X](https://orcid.org/0009-0007-3147-323X)

- Version: 0.6.4
- License: MIT

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)
Full changelog: [v0.6.3...v0.6.4](https://github.com/Aurtechmx/openlidarviewer/compare/v0.6.3...v0.6.4)
