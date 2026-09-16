# OpenLiDARViewer v0.6.9

v0.6.9 changes how a stockpile volume is computed, opens a local LAZ file progressively instead of after a full decode, keeps a terrain core on the device across a reopen, and decomposes the two shell files that carried most of the wiring.

One measurement method changed. No product changed evidence level. The register holds 34 claims, 2 at E1, 6 at E2, 9 at E3 and 17 at E4, none at E5.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## The stockpile volume is integrated over area

The interactive stockpile estimate no longer sums a point sample. It integrates over a grid, clipping each cell to the lasso polygon and taking the median surface within the cell, so the figure no longer moves with the density of the points that happened to be resident. The registered method is `olv.volume.stockpile-area-grid` at generation 2; the point-sample estimator `olv.volume.stockpile` v1 is the one it replaces.

The estimate is live in the lasso toast, with its authority stated on the result: MEASURED when the source is fully resident, PREVIEW while it is not, and withheld where the scope does not support a figure. A streaming source (COPC, EPT or an out-of-core index) stays at PREVIEW until the whole source is resident. A renderer that reports itself ready does not make the source complete, and readiness is no longer read as residency.

VOL-STOCKPILE stays at E3. The area-grid method is checked against synthetic known truth; its accuracy against surveyed field volume is not established.

The v0.6.8 limitation that recorded the area-grid estimator as implemented and unreachable no longer holds. What is still true is narrower: the canonical stockpile record beyond the toast is not integrated. The session record, the report and the measurement CSV still carry the point-sample cut and fill volume record. Read the release as delivering an interactive area-weighted stockpile estimate, not a new record in the exports.

## A local LAZ file opens progressively

Opening a local LAZ no longer waits for the whole compressed file; an ordinary LAS still reads whole under the memory guard, or through the out-of-core index when it is heavy. The header prefix is read first, a parse worker frames the file from it, and a range source reads the chunk table and decodes chunks from a pool, so the file is never resident whole.

A stand-in preview cloud is drawn while the pooled decode continues. The preview is sampled by one global stride, so only the preview budget crosses the worker boundary: the smaller of the render budget and 2,000,000 points.

The load telemetry names the file, its bytes, the declared point count, the point format, the chunk count, the stride, the preview budget, and the requested, unique and re-read bytes. On the committed 291,163 byte fixture the only re-read is the 64 KiB header prefix.

Measured figures for the open path are recorded in `docs/validation/local-laz-open-baseline.json`, which names the revision each was taken at.

## A terrain core survives a reopen

A computed TerrainCore is persisted to the Origin Private File System and restored when the same analysis is asked for again. The key is the identity of the analysed input, not of the file: a SHA-256 over the analysed positions, a SHA-256 over the classification, the core parameters, and the method generation. Any mismatch recomputes. Only cores that took at least a second to compute are persisted, and the store is bounded to 512 MiB by least-recent use.

`docs/validation/terrain-core-opfs-restore-baseline.json` records the benchmark, taken on Chromium against real OPFS at revision c14cc2c1 plus the benchmark commit: fresh compute of 6.6 s, 6.2 s and 9.4 s against restore medians of 24 ms, 62 ms and 96 ms at 100k, 500k and 1M points, with byte-identical grids. `docs/terrain-intelligence.md` describes the cache.

## Work that cannot run on the main thread refuses

A worker failure no longer silently falls back to the main thread for any workload. The fallback runs only for sizes measured as safe: 25,000 points and 1,000 estimated cells for terrain, 1,000,000 points for classification, from `docs/validation/sync-fallback-budget-baseline.json`. Anything larger refuses with a typed error that states nothing was produced, rather than freezing the page. Both worker clients hold a 120 s reply deadline, and the Analyse panel says when a result was computed on the main thread.

## Faster analysis with identical output

Four numeric paths were rewritten and held to byte identity against the code they replace: DTM cell samples are stored contiguously for the sorted aggregations, the ICP target is indexed once and the solver's buffers reused, the voxel accumulator is typed with an open-addressing lookup, and the two square-opening implementations in the morphology step are tested against each other. The timings, including a DTM aggregation median of 994 ms falling to 168 ms, are in `docs/validation/local-laz-open-baseline.json` at the revisions named there.

These are engineering changes. No terrain number moves, and no claim changes level because of them.

## The shell and the renderer are decomposed

`src/main.ts` goes from 5,557 lines to 4,977 and `src/render/Viewer.ts` from 6,423 to 6,223, with the Analyse panel at 2,905. The module graph holds 840 modules and zero cycles. Fan-out on the concentration modules is watched and printed as a table: 112 for the shell, 77 for the renderer, 23 for the Analyse panel.

The scan route, the Viewer-to-Inspector visual synchronisation and the streaming panel controls each moved into a coordinator over narrow ports. The action registry is split into contributors and built lazily. The Viewer's render core is built in a bootstrap module, and the Analyse panel's raster and relief previews moved into a surface-tiles module.

Help is derived from the action registry, the key binding table and the help catalog, covering 7 topics with search. A shadowed help-overlay key binding is removed.

## Interface

Headings are sentence case, values that carry the result are set at a focal size, hairlines are fewer, and motion is bounded under a reduced-motion preference. One owner holds the top-centre lane, the project card first and the recommended-view chip after it. Between 768 and 1100 px the dock folds Snapshot, Copy view link and Probe into More. The touch hint yields after the first gesture and can be reopened from the palette. On a phone the results come first, and the sheet opens to half height when a run completes.

Scientific state reads in one grammar across the interface, a glyph and a word. Export Health rows carry a glyph as a second channel and the informational tier is styled. The Dataset Story is mounted in the Analyse panel when a scan opens, and stays reachable from the palette. Analyse status is announced in a live region, the report verifier traps focus, a disabled export product explains why it is disabled, ten empty states say what fills them, and the load stages read "Reading metadata" and "Preparing display".

The Tools tab opens with a launcher card. It lists Measure, Inspect point, Annotate and Clip box from the action registry with their keys and hints, states how many of each the session has placed so far, and folds to a strip while a tool panel is up. Probe stays on the dock only.

Panel rows lead with the result. A value that carries the figure is set at 12 px against an 11 px label, the readouts that carry figures use tabular numbers, the dock and the workspace tab strip are concentric with what they contain, floating surfaces share one layered shadow, and a press has one scale. Layer Health folds frame and mount detail behind a disclosure when one layer is loaded, the Export summary keeps a neutral line and moves its caveat to a note, Provenance bounds read label left and figure right with the citation below, Workflow, RGB and Background are collapsible with their open state remembered, and Scan Intelligence replaces three unknown rows with one line.

## Fixed

- A terrain gather across several layers that refuse to combine names the shared-frame rule it applied, instead of reporting a bare refusal.
- A coordinate-system refusal links to the Help topic that explains it.
- A torn out-of-core index left payload files it no longer named; those are swept.
- Every contour permit runs through one authorization backbone, and a granted decision always states its claim set.
- The confidence surface no longer describes itself as calibrated, and the pooled row is dropped.
- Each reason string names the condition it reports.
- A classification run names an assumed unit and reports support rather than a percentage, and the corpus test is gated on the method identity.
- Scan output states the real analysed basis, withholds a capture type it has no evidence for, and analysis is reachable from the palette.
- A non-finite digest is refused, the layer table is derived rather than assembled twice, and navigation listeners are released.
- The Output panel's findings ledger is styled, empty launchers are hidden, and a site KML is written without measurements.
- The palette's hover follows the pointer only after the pointer moves.
- The empty-state tooltip closes when the stage hides.
- A streaming source counts as complete only once its hierarchy is, not once every node known so far is resident, so an EPT source that deepens after it opens no longer reports a completeness it has not established.
- Terrain Intelligence Report rows wrap a long label inside its column, a long scan name shrinks to fit, a verdict reason is printed once, and the stride-scaled ground density warning says the scale reaches the loaded display sample rather than the whole file.
- Export Health names a strided local file as a display sample instead of reporting an unknown scope, and the Layer Health loading row says which count is declared and which is resident.
- The top lane is handed on when the project card's fade ends rather than when it begins, with a bounded fallback for a card that reports no transition end.
- The module-graph lint refuses to bank a raise and records fan-in.
- A deposited release's limitations document keeps the counts it shipped with, so the release-truth lint does not demand an edit to a published file.

## Known limitations

The complete list is in `KNOWN_LIMITATIONS_v0.6.9.md`. The evidence ceiling is unchanged: 17 products at E4, none at E5. The registration stack, the artifact passport, the evidence boundary inspector and the DTM surface digest are implemented and tested but not wired into a user path, and are registered as unreachable rather than described as delivered. The canonical stockpile record beyond the toast is not integrated. Touch gestures are verified on Chromium only in CI.

## Licensing

Unchanged from v0.6.8: OpenLiDARViewer is distributed under AGPL-3.0-only. Releases through v0.6.6 were published under MIT and stay available under those terms. The license of a bundled dependency or of any test or validation dataset is unaffected.

## Compatibility

Sessions written by v0.6.9 use schema version 8, unchanged. Sessions from version 1 onward open. The canonical toolchain is Node 22.18.0 with npm 10.9.3, unchanged.

## Verifying this release

`REPRODUCIBILITY_v0.6.9.md` describes how to rebuild the release, verify a downloaded archive without rebuilding it, and regenerate each reported figure.

## Citing

The version DOI for v0.6.9 is pending Zenodo deposition. Cite the concept DOI 10.5281/zenodo.21544619 for the series.
