# OpenLiDARViewer v0.6.0-alpha.3

A refinement and release-hardening cut. Open alpha.3 next to alpha.2 and the viewer looks and moves the same: no rendering or navigation behaviour changed in this cut. What changed is underneath. Two exports stopped stating things that were not true, more of the two largest files became testable, and the release process was rebuilt so the published source, evidence, manifest and packaged artifacts all point back to the same tagged revision.

This is still a pre-release for evaluation. Interfaces and internals may change before v0.6.0, so pin the exact tag if you depend on current behaviour.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Two exports were stating things that were not true

Running a real drone survey through the export paths turned up two claims a reader had no way to check.

A point-cloud export wrote whatever the viewer was holding. When a display-sample cap or a load stride has left the viewer holding part of the file, the written file looks exactly like a complete export of a smaller scan: same name, same shape, nothing in it to say otherwise. A 46.8-million-point scan came out as 5.8 million rows with no header at all. XYZ, PLY and OBJ now state how many of how many points were written and what caused the gap, through the comment channel each format already uses for dropped columns. A file that declares no count stays silent rather than guessing, and a cloud holding more than it declared is not treated as a subset. CSV stays pure data, as before.

The report row for classification answered a different question than it appeared to. It tested whether the classification channel exists, which is the right gate for offering a classification render, but printed as a bare "Yes" it reads as a statement that the scan carries classes. A file whose every code is 0 got that Yes while the Scan Report panel beside it read "Present, unclassified (0.0 % coverage)". The row now reports coverage. Streaming sources fall back to presence, because the loaded nodes are not the scan and any percentage would move as you navigate.

## Navigation: what shipped, and what is still open

Nothing in this cut changes navigation. The two fixes that made movement steadier landed in alpha.1 and ship here, and they are worth restating because the case that remains is easy to mistake for a regression.

Opening a COPC used to make every refining region pulse. The streaming cross-fade toggled transparency and depth-write per node, so two overlapping levels of detail fought over depth through the transition, and the alpha fade did nothing at all because the opacity node overrode it. It produced flicker and never a fade. That was replaced with an opaque per-point screen-door dissolve driven by a stable hash of the instance index, gated through the size graph exactly as the class and elevation masks are. No transparency, no depth sorting, and eye-dome lighting stays exact. Dragging the camera also ran a GPU pick every frame for the live probe readout; that is skipped while a drag is active.

Flicker at the streaming budget boundary is not fixed. An anti-thrash option that keeps resident nodes sticky exists in the budget selector and is unit-tested, but it is opt-in and not wired into the live scheduler. Enabling it has to reconcile with the scheduler's ancestor protection first, and the result has to be confirmed by eye in a browser. Some pulsing at the boundary may remain in this build.

The frame decision itself did become testable this cut. Whether the loop draws a given frame, which was a private method reading the clock directly, is now a module that takes the clock as an argument, with tests over the holdover-expiry boundary, the idle heartbeat and the priority order between the reasons to draw. Behaviour is preserved; the value is that the next change to it can be verified rather than eyeballed.

## More of the two monoliths is now testable

Six pieces of logic moved off the render class and the app entry into their own modules, each with Node tests it could not have while embedded in a class that needs a WebGL context or the DOM:

* the lasso-volume selection walk;
* the two-finger touch tracker;
* the render-frame decision;
* the streaming compatibility boundary;
* remote-source naming and error text;
* two measure helpers (volume-record shaping and horizontal span).

`Viewer.ts` went from 7,297 to 7,127 lines and `main.ts` from 7,636 to 7,521, but the line count is not the point. The exit condition is that every cluster with a real boundary and a test payoff is extracted; what remains is view-bound, and moving it would relocate glue without gaining a test.

Two shrink-only ratchets now run in the release gate. One holds the world-coordinate read surface, the other the two large files: both may fall, never grow. A decomposition step cannot be undone by accident, and no busywork extraction is forced to chase a number.

## Runtime validation

The suite is partitioned across 492 test files: 257 unit, 43 export, 107 terrain, 29 UI and 59 slow. The recorded gate run reports 5,891 passing and 16 skipped.

That is software-validation coverage, not scientific evidence. The two are kept apart on purpose. A passing runtime suite shows the implementation behaves as specified; it does not validate a scientific result.

## The release traces back to one tagged source

The release path was rebuilt around exact-tag provenance. A release run validates that the tag matches the package version, runs the complete release gate on that checkout, generates authoritative evidence for that same commit, packages the same source tree, stages the artifacts as one closed set, and verifies versions, commits, hashes and archive contents before creating a draft prerelease. The draft is never auto-published: a human reads the body and presses publish.

Development evidence stays committed in the repository for normal work, marked non-authoritative. Evidence is collected from a gate run, so a committed copy always describes the commit before the one it ships in. The authoritative record is generated by the tagged workflow, where it can name the exact commit that was tested and packaged. Cite the attached file.

Every published test count and the bundle size are read out of the gate log rather than typed. That check has already caught four separate drifts in this cycle, including one where three documents agreed with each other and all three were wrong.

## A release payload that can be checked independently

Before a draft release is created, the verifier checks:

* one source archive and one deploy archive;
* one SBOM;
* one authoritative evidence file;
* one release manifest;
* one gate log and its checksum;
* one release-notes file;
* one complete `SHA256SUMS`;
* version and commit agreement across all of them;
* required source documentation;
* source and deploy archive structure;
* prohibited development artifacts and unsafe paths.

The source archive uses normalized ordering, timestamps and archive metadata, so it can be reproduced from the same source revision and toolchain. The deploy archive is not claimed to be byte-for-byte reproducible.

## Scientific validation: one bounded E4 claim

This release adds the project's first cross-implementation validation claim. SLOPE-RASTER is now registered at E4, cross-checked against GDAL 3.13.1 on a frozen analytic DEM. OpenLiDARViewer, GDAL and the closed-form gradient agreed over 11,564 interior cells, with a maximum OpenLiDARViewer-to-GDAL difference of about 0.000037 degree, inside the preregistered 0.5 degree tolerance.

The scope is deliberately narrow. Nothing changed in slope calculations, terrain analysis, measurement algorithms, coordinate handling, interpolation, or any registered tolerance. No other analytical output has been promoted to E4. This validates one implementation path against one independent reference on one fixture. It does not claim field validation, survey-grade accuracy, classification accuracy, DTM accuracy, or E5 evidence.

## The open precision item, measured

The one coordinate-integrity item left is that the project transform rewrites Float32 positions in place. This cut measures what that costs. A mount and unmount moves a point about 0.06 mm at 1 km of separation and 3.9 mm at 100 km, and repeated cycles do not add to it: the error saturates after the first. The defect is exact reversibility, not runaway drift, which is a smaller problem than the roadmap assumed and is what the Float64 transform will close.

## Release infrastructure

This alpha adds or strengthens the exact-tag release workflow, authoritative release evidence, release-truth linting, SBOM identity and dependency checks, deterministic source packaging, staged asset verification, manifest generation, provenance checks, release-specific regression tests, and reproducibility documentation for reviewers.

Most of it is invisible once the viewer loads. Its value is that a published release can be checked without trusting a handwritten summary.

## Fixes

* Point-cloud text exports disclose when the written file is a sample of the source rather than the whole scan.
* The classification report row states coverage instead of channel presence, so an unclassified file no longer reads as classified.
* Release-mode evidence is written outside the tracked tree, so packaging no longer fails because the gate modified a committed evidence file.
* Strict packaging requires authoritative evidence whose version, tag and commit match `HEAD`.
* Release artifacts are handed between CI jobs through one flat payload instead of mixed directory layouts.
* All mandatory release stages are recorded in the canonical gate output, so a green exit can no longer mean that only the static gate ran.
* Dependency documentation distinguishes committed development provenance from final exact-tag release provenance.
* Version-specific release notes, known limitations, validation and reproducibility documents are required inside the source package.
* The final release manifest has a single generator and a single role.
* Source packaging is deterministic under a fixed source revision and `SOURCE_DATE_EPOCH`.

## Known limitations

Stated in full in `KNOWN_LIMITATIONS_v0.6.0-alpha.3.md`. In brief:

* The two largest application files remain large: `main.ts` is 7,521 lines and `Viewer.ts` is 7,127. Decomposition is underway and this release does not complete it.
* Physical multi-layer mounting remains disabled in alpha.3.
* The project frame is a tested foundation rather than a fully active cross-layer system, so some comparison, clipping and measurement workflows remain experimental.
* Streaming flicker at the budget boundary is not fixed, and the anti-thrash option that addresses it is opt-in and unwired.
* Refinement behaviour can still depend on the GPU, browser and dataset even where the deterministic scheduling tests pass.
* The viewer does not reproject between coordinate systems. Equal-CRS scans can be compared directly; mixed-CRS scans stay in their own frames.
* Scientific evidence includes one E4 claim only. Other analytical outputs remain below independent cross-implementation validation.
* This alpha does not claim survey-grade accuracy, standards certification, field validation, or E5 evidence.

## Compatibility and scope

Runs in a modern Chromium-based browser with WebGPU. Firefox and Safari fall back to WebGL 2.

Imports LAS, LAZ, E57, PLY, OBJ, GLB/GLTF, XYZ, PCD, PTX and PTS, and streams COPC and EPT.

Existing v0.6 alpha workflows remain compatible. No migration step is required.

## Verify this release

From the tagged source:

```bash
nvm use
npm ci
npm run gate
```

To verify a downloaded release payload:

```bash
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-release-assets>
```

The payload includes the source archive, deploy archive, SBOM, authoritative evidence, gate log and checksum, manifest, release notes and `SHA256SUMS`. The asset set and how the hash chain closes are in `docs/release/RELEASE_ASSETS.md`.

## Deploy

Static files. Host on GitHub Pages, Netlify, a static CDN, or any conventional web host.

## Citing this release

Cite OpenLiDARViewer with the metadata in `CITATION.cff`:

* Version: 0.6.0-alpha.3
* Release date: 2026-07-23
* License: MIT

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)  
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)

Open Source • Open Data • Open Exploration
