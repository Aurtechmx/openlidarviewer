# OpenLiDARViewer v0.6.6

v0.6.6 is a feature and evidence release with a substantial correctness pass underneath. Twelve registered claims now carry E4 cross-implementation evidence, against v0.6.5's five. The seven added are `E57-INGEST`, `MEAS-PROFILE`, `DSM`, `DTM`, `CHM`, `TPI` and `VRM`. On the public E57 validation scan, cartesian coordinates, surface normals and colour are checked point for point against PDAL; intensity is outside that comparison. Around that, the workspace gained a Work mode for the scene-work tools and an Output panel that consolidates exports. Layer groups arrived in the Layers panel, annotations gained an inspection issue workflow, and one Speed to Quality control now covers display and streaming. A long run of unit-correctness fixes runs underneath all of it, and those are listed first because several of them changed reported numbers.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Corrected calculations and behaviour

- the USGS 3DEP Quality Level table read a QL3 density floor of 0.25 pts/m² where the published floor is 0.5, so a survey between the two was awarded QL3 at half the required density; the other three levels were already correct, and datasets in that band now read below-QL3;
- WKT2 `LENGTHUNIT` is parsed for linear and vertical units;
- the measurement chain scales vertical and volume quantities by the vertical unit;
- SMRF ground tolerances and classifier parameters are physical, converted to source units at the boundary;
- camera flatness and project-card sizes read height off the up axis rather than assuming Z;
- a two-epoch change volume with no error budget in it is no longer reported as certain: a level of detection of 0 with no co-registration RMSE collapsed the band to plus or minus zero, which cleared every threshold and graded the least supported result available as detectable at 0% relative error and high confidence; an empty budget now reports as unquantified;
- a surface ICP fit with too little overlap is refused rather than reported, and a net volume is qualified with an uncertainty band;
- classification reads review rather than ready when the source unit is unknown, and a resident-only surface reads review rather than blocked;
- hiding the navigation legend no longer takes the view controls with it; the standard views and the orthographic toggle exist nowhere else in the app and the dismissal is persisted, so the old behaviour removed them permanently and across sessions;
- an E57 the preflight had already judged too large for the device was still read whole into memory, because the only refusal lived in the decode worker; the refusal now runs before the read;
- the decode worker planned again instead of using the main thread's plan; `matchMedia` does not exist in a worker, so the mobile flag read false and the memory fraction moved from 0.4 to 0.6, letting the worker accept a file the main thread had refused and apply a stride other than the one the preload stated; the plan now travels with the request;
- a preflight that threw left the decode unguarded at stride 1, so a fault inside the memory guard switched the guard off; an E57 whose plan cannot be established is now refused;
- an unsupported E57 major version is refused, and every section offset is bounded by the declared physical length;
- the EPT and 3D Tiles parsers are strict at their format boundary rather than failing open, and the declared-bounds oracle reads the file's pages instead of raw bytes;
- pointer lock delivered every mouse event to the canvas, so the navigation dock stopped receiving clicks and no mode could be reached with the mouse once walk or fly began; a click while locked now returns the cursor;
- the live probe ran a pick across every point of every visible cloud on each pointer-move frame in walk and fly, and during both custom drags, because only an OrbitControls drag set the flag its gate reads. NavController now reports every way the camera is being driven, so the gate suspends the pick through all four;
- provenance reads the file's own declarations ahead of a density guess, and the phone-LiDAR density band is bounded above, so a tripod station carrying dense returns is not reported as a phone;
- every deployed terrain analysis ended by reloading the page. Five `import()` calls sat in modules the live source transform rewrites, so their specifiers became string-array lookups, their chunks were never emitted, and the browser fetched `/model/DerivedLayer` and got a 404. Vite raised `vite:preloadError`, the stale-chunk handler treated it as a swept-away deploy and reloaded, and a finished run looked like a crash back to the start screen. The five are routed through the module the transform excludes, and the release lint that guards this now parses every transformed module rather than matching lines in one file, so a relative runtime dynamic import cannot reach a deployed build again;
- the terrain report printed one figure as "43% of the surface is interpolated" and another as "Interpolated 37%" for the same run. Both are right and they answer different questions, one over the covered surface and one over the whole grid, so the table now carries both and names the basis of each. The map sheet already did this for its own figure, "63% interpolated (by length)";
- "Ground visibility" labelled a categorical bucket in one section of the terrain report and the classifier's ground share of all returns in another, printing a dash for one and a percentage for the other. The second reads "Ground returns (of all returns)";
- the map sheet stamps the contour style from the export's provenance, and without provenance it fell back to the style the view holds now, which need not be the style that geometry was produced with. One sheet read Generalized while the terrain report for the same run recorded Smooth. The fallback says where its value came from.

## Section profile corrections

The corridor profile is now one method from geometry through stationing to the drawn line.

- station geometry was hard-coded to XY with Z as the vertical axis while the sampler already honoured an arbitrary up axis, so a Y-up scan produced correct sampled heights beside wrong station positions, wrong chainages and a report interval that disagreed with the profile's own headline figure; one shared transect frame now serves the sampler, the corridor auto-width, the stations, the controller and the report;
- a station bracketed by one measured sample and one gap took the measured neighbour's elevation, which produced a grade across ground the profile records as unmeasured; interpolation now requires both brackets and returns a gap otherwise;
- the chart and the PDF drew a Catmull-Rom spline, which passes through every station and still overshoots between them: on the plateau [0, 1, 1, 0] the emitted path peaks at 1.1275 with both bracketing stations at exactly 1, and in chart space that plateau is drawn 32 px above the plot top edge; both now draw straight segments between adjacent samples, with gaps left disconnected;
- corridor membership tested distance along the line and distance across it separately, which admitted a square-ended region: a point one band before the start and one band to the side sat 1.41 bands from the line, while the parameter is documented as excluding anything further than one band. Distance is now measured from the nearest point on the segment, which is what the OGR reference has always done. Between the endpoints the arithmetic is bit-identical, and the recorded 751-station cross-implementation result reproduces station for station;
- the percentile was labelled a bare-earth estimate; the sampler drops classes 3 to 7 and 18 where a source classifies, and keeps 0, 1, 2, 9 plus the 255 sentinel a merged source without a class channel carries, so unclassified returns reach the percentile and the wording now says so.

Z-up station positions move by at most 6.8e-13 and station counts are unchanged. The gap and Y-up corrections change reported values where they apply. A 33-station fixture now probes both end caps, including the exact corners, and agrees with the reference over 66 station comparisons with no difference at all.

## Workspace and tools

- a Work workspace mode that gathers the scene-work tools in one place;
- an Output panel that consolidates every export behind one surface, and a slimmer Streaming panel whose saved views moved to the Inspector;
- Process Studio reports live product status and can be docked from the command palette;
- layer groups in the Layers panel: a named, collapsible set of layer ids with visibility and solo, rename, collapse, select, plus a member picker, where each action writes through the existing layer service one layer at a time so a group never holds a second copy of visibility;
- an inspection issue workflow on annotations, carrying a severity, an open or resolved status and an observation date, with an issue list ordered worst first and a roll-up of what is still open;
- one Speed to Quality performance control with an Auto position and an Advanced disclosure that keeps every underlying knob individually settable;
- a top-down orthographic Plan view, reachable from the navigation bar and the command palette, which restores the scene you left rather than the one it drew;
- tool preflight in Process Studio: a blocked or review-only tool states the condition that limits it and offers the shortest action that lifts it, and the measurement tools gained a readiness surface they did not have.

The performance control is display and streaming only. It drives the streaming preset, the resident point budget, concurrent decodes, the device-pixel-ratio ceiling, Eye Dome Lighting and antialiasing. It does not touch the static load budget, which voxel-reduces the decoded cloud that terrain analysis reads, along with measurement and export, so no slider position can change a measured number, a terrain product or a reported claim. The panel says so where the control is.

## Reading more data

- Krovák (EPSG:5514) ingest and iPhone PDRF7 reading;
- footprint reprojection for any proj4-defined projected CRS rather than UTM alone.

The Krovák definition uses a seven-parameter Bursa-Wolf shift. It agrees with authoritative PROJ to about 5 cm on the surveyed reference points, where the naive three-parameter shift is roughly 10 m out.

### Foundations added for a later release, not reachable in v0.6.6

Each of these is implemented and tested, and nothing in the running application passes through it. They are listed so the source is not mistaken for dead code, and they are not features of this release.

- parsers for 3D Tiles `tileset.json` and PNTS;
- a local out-of-core read planner, and a cross-CRS project placement planner;
- tie-point rigid registration with control-network validation, and a single planar ICP solver the registration model selects directly instead of refusing the planar case.

## Also in this release

Two more foundations appear below, alongside those listed under Reading more data: `ProductExecutorRegistry` and the feature-extraction service. Nothing in the running application passes through either, so treat them as groundwork rather than as behaviour you can exercise.

- a project-wide elevation colour scale, opt-in, applied per frame, so two scans in one project can share a range instead of each stretching its own;
- classifier v3: a structural-verticality cue and a wall-rescue pass;
- a derived-layer model and store, a feature-extraction service over the building and conductor cores, and a scientific receipt serializer over the analysis record;
- a product executor registry foundation that invokes a registered compute core through `ProcessService.runIfAuthorized`, preparing one fail-closed execution seam; production product routes do not pass through it yet;
- streaming corrections: in-flight decodes get eviction hysteresis and the budget counts decoded-pending nodes, while a partial stream stays resident-only beside a static cloud;
- the Clip panel is reachable on mobile, and one font policy now covers every panel, enforced by a lint;
- the evidence record's `packageLockSha256` and `sbom.sha256` are checked against the files on disk. Both were written and never read back, so any value passed. A record describing a different commit than the checkout now says so;
- Stryker returns to 9.6.1: Stryker 10 pulls Babel 8, whose packages declare a Node floor above the 22.17.1 the canonical toolchain pins.

## DSM, DTM and CHM reach cross-implementation evidence

The DSM (top surface, max return per cell) and the DTM (bare-earth grid, min return per cell) move from E3 to `E4_CROSS_IMPLEMENTATION_VALIDATED`. Each grid is recomputed from its point cloud and compared against a committed reference produced by PDAL 2.10.2 `writers.gdal`, on three seeded synthetic clouds per product. The two implementations agree over 7,500 cells to a maximum difference under 4×10⁻⁶ m, within a 0.05 m tolerance registered in `REFERENCE_SLOTS` before the references were generated. The comparisons, their commands, tool versions and checksums are recorded in the study manifests `DSM-PDAL-WRITERS-GDAL-CELL-CENTRED` and `DTM-PDAL-WRITERS-GDAL-CELL-CENTRED`, and the recompute is guarded on every gate run by `tests/groundFilterPdalAgreement.test.ts` with flip and transpose symmetry checks.

The canopy height model (`CHM`) is promoted alongside them. CHM is DSM minus DTM, clamped at zero, and with both parents at E4 it was compared against the PDAL max grid minus the PDAL min grid on the same structure clouds, agreeing over 7,500 cells to a maximum difference under 8×10⁻⁶ m, within a 0.1 m registered tolerance (study `CHM-PDAL-WRITERS-GDAL-DIFFERENCE`, test `tests/chmCrossCheck.test.ts`).

Twelve registered claims are now at E4: `SLOPE-RASTER`, `ASPECT-RASTER`, `HILLSHADE`, `CONTOURS` and `MEAS-AREA` against GDAL, `DSM`, `DTM` and `CHM` against PDAL, the terrain descriptors `TPI` (against gdaldem 3.13.1) and `VRM` (against SAGA 7.8.2), each also checked against the closed form on a controlled analytic fixture, and two more promoted in this release.

`MEAS-PROFILE`, the corridor section profile, reaches its required level. No single tool exposes a corridor percentile over a point cloud, so the reference is assembled from two: OGR/SpatiaLite 5.1.0 places every point on the section line and R 4.4.1 `quantile(type = 7)` reduces each station. Over 751 stations the largest difference is 3.6e-15 m, against a 1e-6 m tolerance registered before the reference existed. Per-station corridor counts match exactly, and the four deliberately empty stations read as gaps on both sides. Both fixtures are synthetic and hold every point clear of a bin boundary and of the corridor edge, so the tie-breaking there is untested and none of this is accuracy against a surveyed section.

`E57-INGEST` reaches E4 against PDAL 2.10.2 `readers.e57`. Decoded cartesian coordinates, namespaced surface normals and colour agreed exactly over all 1,788,994 points of a public CC-BY terrestrial scan across nine dimensions, compared as an exact quantised integer sum at a 1e-6 quantum rather than as a summary statistic, so one point wrong by a micrometre fails the comparison. Intensity is outside it: PDAL rescales intensity by 65535/(max - min) without subtracting the minimum, so the two sides report different numbers for the same file. The scan is a CloudCompare re-export rather than a scanner-native write. Three further files are read by tests of their own. One is a five-scan registered file with its per-scan poses, one carries multiple returns, and the third is 587 MB with an unknown Riegl extension that stays namespaced rather than being read as part of the standard prototype. Those three are too large to commit, so each test reads a path from an environment variable and skips when it is unset. No workflow sets them, so they do not run in the release gate and none of them supports the E4 grade. Spherical coordinates remain untested.

## What the DSM, DTM and CHM evidence covers, and what it does not

The cross-check isolates the cell gridding. The reference radius is 0.45 m, below half a cell, so each cell reduces to the returns at its centre and the two implementations take the maximum or minimum over the same point set. It therefore measures the gridding arithmetic, not a divergent neighbourhood search. The DTM clouds are bare-earth by construction, so it does not exercise ground classification. `GROUND-FILTER` stays at E3 in this release, because its agreement with PDAL's `filters.smrf` holds on low-relief terrain and falls on steep and complex terrain. Void interpolation on real terrain is not exercised, and the DTM's required bar for field validation stays at E5. None of this is survey-grade accuracy or a field campaign.

## Terrain-aware contour generalization, opt-in

Cartographic contour purposes simplify their geometry at a bounded tolerance, expressed as a fraction of the grid cell. That tolerance has always applied evenly to every line, which spends the same amount of give on a long confidently-measured contour and on a small summit ring whose shape a coarse tolerance would erase.

A terrain-aware mode is now offered beside the uniform one. It scales the tolerance per feature from the feature's own evidence: interpolated and low-confidence support, and small closed summits and depressions, are simplified less, while long strongly-measured lines are simplified at the full tolerance. The per-feature factor is clamped so that it can only ever make a line more faithful than the uniform pass, which keeps the chosen tolerance as the bound on every line in the set. The simplifier underneath is unchanged and still refuses to drop a vertex that sits on a gap or below the confidence floor, so neither mode can straighten an interpolated run into a confident-looking line.

Exports record which pass produced their geometry, `olv.contour.generalize.terrain-adaptive@1` or `olv.contour.generalize@1`, alongside the tolerance in effect. Uniform remains the default for every purpose, so contour geometry is byte-identical to v0.6.5 unless the mode is selected.

## Contours draw in the 3D scene

Contours produced by a terrain analysis are drawn over the point cloud as a derived layer, with panel controls for visibility, index emphasis, opacity and vertical lift. Solid and dashed support are distinguished by colour and alpha rather than by dash pattern, and a segment that crosses a data gap is not drawn at all, so a drawn line never spans ground the analysis did not measure.

Re-running the analysis regenerates the layer in place, and closing the scan a layer came from removes it. Each layer carries the digest of the analysis receipt that produced it, built through the provenance path exports already use, so a layer still on screen can be traced back to the run behind it. Scans held in the viewer's Y-up frame are drawn through the full Z-up to Y-up rotation, and the overlay adds no origin offset of its own, because contour geometry arrives in the project frame.

Receipts for the other analytical products are not part of this release. They need provenance captured at analysis time, which contours have and the others do not yet.

## Resident stickiness for streaming, opt-in

The streaming selector can hold a node that is already resident against a marginally better competitor, which reduces the swap churn visible as flicker at the point-budget boundary. A node with a finer candidate beneath it in the same tick competes on its raw score with no bonus, so the retention cannot stall refinement.

It is off by default and enabled with `?stickiness=on`. The default selection is byte-for-byte what v0.6.5 produced. Flicker is not observable outside a browser, so the default stays off until the behaviour is measured on a streamed cloud in one.

## Known limitations

The complete list is in `KNOWN_LIMITATIONS_v0.6.6.md`. It carries the v0.6.5 limits forward, with the evidence-ceiling section updated for the three newly promoted surface products and the scope those cross-checks reach. Terrain-aware generalization is a cartographic option and carries no evidence claim of its own: it changes how a line is drawn, never what the surface says. Multi-layer mounting stays enabled with its one outstanding precision refinement, and there is still no cross-CRS reprojection into a common viewer frame. The residual streaming flicker at the point-budget boundary is unchanged in the default configuration; the stickiness option above is offered against it but is not yet measured in a browser.

## Compatibility

Unchanged from v0.6.5. Modern Chromium browsers prefer WebGPU where the platform and adapter provide it and fall back to WebGL 2 otherwise; Firefox and Safari take the WebGL 2 path. Existing sessions remain compatible. Session files are unaffected: a session saved before this release loads with generalization in its uniform default.

## Verifying this release

```bash
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-assets>
gh attestation verify <archive> --repo Aurtechmx/openlidarviewer
```

The verified asset set is listed in `release-manifest-v0.6.6.json`. The two GitHub-generated Source code archives are not part of it.

## Citing

Citation metadata is provided in `CITATION.cff`, `.zenodo.json` and `codemeta.json`.

ORCID: [0009-0007-3147-323X](https://orcid.org/0009-0007-3147-323X)

- Version: 0.6.6
- License: MIT

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)
Full changelog: [v0.6.5...v0.6.6](https://github.com/Aurtechmx/openlidarviewer/compare/v0.6.5...v0.6.6)
