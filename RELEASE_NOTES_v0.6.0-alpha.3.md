Open alpha.3 next to alpha.2 and the viewer looks and moves the same. What changed is underneath: more of the two big files is testable, two exports stopped saying things that were not true, and the release itself can now be checked by someone who does not trust me.

Pre-release for evaluation, so pin the commit if you depend on current behaviour. Browser-native and local-first as always: files stay on your device, no account.

## More of the two monoliths is now testable

Six pieces of logic moved off the render class and the app entry into their own modules, each with Node tests it could not have while embedded in a class that needs a WebGL context or the DOM:

- the lasso-volume selection walk,
- the two-finger touch tracker,
- the render-frame decision,
- the streaming compatibility boundary,
- remote-source naming and error text,
- two measure helpers (volume-record shaping and horizontal span).

`Viewer.ts` went from 7,297 to 7,127 lines and `main.ts` from 7,636 to 7,521, but the line count is not the point. The exit condition is that every cluster with a real boundary and a test payoff is extracted; what remains is genuinely view-bound, and moving it would relocate glue without gaining a test.

## Guards so it cannot slip back

Two shrink-only ratchets now run in the release gate. One holds the world-coordinate read surface, the other the two large files: both may fall, never grow. A decomposition step cannot be undone by accident, and no busywork extraction is forced to chase a number.

## Two exports were saying things that were not true

Running a real drone scan through the export paths turned up two statements no reader could have checked.

A point-cloud export wrote whatever the viewer was holding. When a display-sample cap or a load stride has left the viewer holding part of the file, the written file looks exactly like a complete export of a smaller scan: same name, same shape, nothing to contradict it. A 46.8-million-point scan came out as 5.8 million rows with no header at all. XYZ, PLY and OBJ now state how many of how many points were written and what caused the gap, through the comment channel each format already uses for dropped columns. A file that declares no count stays silent rather than guessing, and a cloud holding more than it declared is not a subset. CSV stays pure data, as before.

The report row for classification answered a different question than it appeared to. It tested whether the channel exists, which is right for deciding whether a classification render can be offered, but printed as a bare "Yes" it says the scan carries classes. A file whose every code is 0 got that Yes while the Scan Report panel beside it read "Present, unclassified (0.0 % coverage)". The row now reports coverage, and falls back to presence only for streaming sources, where the loaded nodes are not the scan and any share would be a moving number.

## Navigation smoothness, and the flicker still in the build

Nothing here is new since alpha.2. Both fixes below landed in alpha.1 and ship in this build, and they are worth restating because the residual case is easy to mistake for a regression.

Opening a COPC used to make every refining region pulse. The streaming cross-fade toggled transparency and depth-write per node, so two overlapping levels of detail z-fought their way through the transition, and the alpha fade did nothing at all because the opacity node overrode it. It only ever produced flicker, never a fade. That was replaced with an opaque per-point screen-door dissolve: a stable hash of the instance index gates each sprite through the size graph, the same mechanism the class and elevation masks use. No transparency, no depth sorting, and eye-dome lighting stays exact.

Dragging the camera also used to run a GPU pick every frame for the live probe readout. That work is skipped while a drag is active, which is the difference between a probe value that updates during a movement nobody is reading it during, and a smoother drag.

What is not fixed is flicker at the streaming budget boundary. An anti-thrash option that keeps resident nodes sticky exists in the budget selector and is unit-tested, but it is opt-in and not wired into the live scheduler. Enabling it has to reconcile with the scheduler's ancestor protection first, and that has to be confirmed by eye in a browser. Some pulsing at the boundary may remain in this build.

## The release is now verifiable end to end

Most of this cycle's commits went here, and none of it changes the viewer.

The old story was that I ran the gate and typed the result. The gate now prints its own exit status, writes its log, and derives every published test count and the bundle size from that log, so a stale figure fails a lint instead of shipping. That check has already caught four separate drifts during this cycle, including one where three documents agreed with each other and all three were wrong.

A release now carries a manifest that binds the tag to the commit to the hash of every attached file, and `npm run release:verify` walks the chain in both directions. Packaging refuses to run unless the tree is clean, HEAD is tagged, and the evidence names that exact commit. The source archive is built with a fixed timestamp so the same commit produces the same bytes. Both the deploy and source zips, the evidence, the gate log, the SBOM and the dependency audit are attached and hash-checked together.

The evidence attached to the release is the authoritative one. The copy committed in the repository is marked as a development run, because evidence is collected from a gate run and committing it always describes the commit before the one it ships in. Cite the attached file.

## The open precision item, measured

The one coordinate-integrity item left is that the project transform rewrites Float32 positions in place. This cut measures exactly what that costs. A mount and unmount moves a point about 0.06 mm at 1 km of separation and 3.9 mm at 100 km, and repeated cycles do not add to it: the error saturates after the first. The defect is exact reversibility, not runaway drift, which is a smaller problem than the roadmap assumed and is what the Float64 transform will close.

Slope reached E4. OpenLiDARViewer's Horn slope was independently cross-implemented against GDAL 3.13.1 on a frozen analytic DEM; OpenLiDARViewer, GDAL and the closed-form gradient agreed over 11,564 interior cells, with an OpenLiDARViewer-to-GDAL maximum difference of about 0.000037 degree, inside the preregistered 0.5 degree tolerance. This is E4 evidence for the slope-raster algorithm on this fixture only. Every other independent-reference slot remains pending, and it does not validate the point-cloud-to-DTM pipeline, other terrain products, field accuracy or survey-grade use.

## Known limitations

Unchanged from alpha.2, and stated in full in `KNOWN_LIMITATIONS_v0.6.0-alpha.3.md`. In brief: multi-layer mounting is disabled, the project transform still rewrites Float32 positions, budget-boundary streaming flicker is not fixed, and there is no cross-CRS reprojection. Slope is cross-implementation validated (E4) against GDAL on the analytic fixture; every other terrain product tops out at internal self-consistency (E3), with no field validation and no survey-grade claim.

## Compatibility

Chromium-based browsers (Chrome, Edge) with WebGPU; Firefox and Safari fall back to WebGL 2. Reads LAS, LAZ, E57, PLY, OBJ, GLB/GLTF, XYZ, PCD, PTX, PTS, and streams COPC and EPT. Everything from alpha.2 remains and behaves the same way.

## Deploy

Static files. GitHub Pages, Netlify, any CDN or conventional host.

## Verifying this release

```
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-assets>
```

The asset set and how the hash chain closes are in `docs/release/RELEASE_ASSETS.md`.

## Citing

Metadata in `CITATION.cff`.

* Version: 0.6.0-alpha.3
* Release date: 2026-07-22
* License: MIT

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)  
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)

Open Source • Open Data • Open Exploration
