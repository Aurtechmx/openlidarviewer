v0.6.0-alpha.1 opens the v0.6 cycle. Where v0.5.9 finished a deliverable workflow, this cut is about the machine underneath it: the viewer starts faster, streams without visual noise, recovers cleanly when a deploy sweeps its own code out from under an open tab, and fixes two rendering-correctness defects. It also lays the first structural groundwork for the v0.6 workflow features.

This is an alpha for evaluation. Interfaces and internals may still change before v0.6.0, and the v0.6 headline workflows are not in this cut.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Faster first load

The Analyse and Object panels — two of the heaviest interface modules — now mount when the first scan loads instead of at boot, cutting the live entry chunk from 792 KiB, and the bundle-budget guard's ceiling tightens from 800 to 720 KiB with an early-warning threshold at 680. After the alpha correctness hardening the live entry measures **693 KiB** — within the 720 KiB ceiling, above the 680 KiB early-warning line, so the guard flags it for attention before the next cut.

## Streaming without flicker

Opening a COPC or EPT cloud no longer makes refining regions pulse. LOD transitions used to cross-fade with transparency while keeping depth writes for Eye Dome Lighting; the two overlapping detail levels z-fought for the duration of every fade, and each region flashed as it refined. Transitions are now an opaque per-point dissolve: a stable hash of each point gates its sprite through the size pipeline, so nodes materialise and retire smoothly with no transparency, no depth-sort conflict, and exact EDL throughout. An evicted node dissolves out from whatever density it had reached, never snapping to full first.

## Correct reclassification on any up-axis

Polygon reclassification projected the polygon onto a proper horizontal basis for non-Z-up scans but tested each point in raw XY — two different coordinate spaces, so rotated, Y-up, tilted, or far-from-origin clouds could reclassify the wrong points. Both now project through the same basis, height included. The Z-up path is byte-for-byte unchanged, and the case is pinned by tests across Y-up, tilted, flipped, non-origin, and filtered scenarios.

## Deploy-safe sessions

A tab left open across a deploy used to break on the next action that touched a code chunk the deploy had swept away. That failure is now classified across browser and bundler phrasings and answered with one guarded reload — the URL and query are preserved, and a per-tab cooldown turns a persistent failure into an actionable error instead of a reload loop.

## Smaller guarantees

- The live probe's detailed GPU pick pauses while the camera is being dragged and fires once on settle — navigation stops paying for a readout nobody is reading.
- Measurement station tables build their rows when first expanded; exports are byte-identical.
- A dependency-singleton guard fails the release gate if a second copy of three, laz-perf, proj4, or pdf-lib ever enters the tree; a real duplicate LAZ decoder was collapsed by dropping an unused loader dependency.

## Streaming large public datasets

Large EPT datasets expose thousands of hierarchy sub-files. The viewer used to load all of them before drawing a single point, so a big project looked hung on open. The hierarchy walk now paints from a bounded first-paint pass and continues loading in the background, and a persistently-failing fetch can no longer spin the walk into a runaway loop.

## Correctness and honesty hardening

A pass across the streaming, loader, and measurement paths, prompted by an external engineering review:

- **Non-finite streaming coordinates are refused.** A malformed COPC/EPT header transform, or a float tile carrying a NaN, is caught in the decoder and the node is refused with a structured error the scheduler backs off — instead of NaN reaching the GPU. File-loaded clouds already had this guard; streaming nodes now do too.
- **A session is checked against the scan it's applied to.** A saved session's measurements are local to the scan they were captured over. Import now compares the session's stored scan fingerprint against the loaded scan and refuses a clear mismatch, rather than silently realigning one scan's analysis onto another.
- **Stockpile confidence is honest about units.** A points/m² density can't earn HIGH confidence when the CRS's horizontal unit is unknown — an unknown unit was being treated as metres. The density figure is labelled accordingly.
- **Sharper elevations and datums.** Streaming elevation ranges read from the decoded data bounds rather than the octree cube (a tall cube no longer inflates the legend), profile heights read against the correct datum, and every file loader routes through the central non-finite sanitiser.

## Foundation for multi-scan projects

The largest open item — that georeferenced scans with different origins overlap near local zero instead of sitting at their true relative positions — gets its foundation here: value types and pure transform math for one shared project coordinate frame, unit-tested including the precision bound. The scene wiring that puts it on screen is staged and documented, not yet enabled.

## Known limitations

This is an alpha. The project spatial frame's scene wiring and an anti-thrash streaming-selection option (which targets a residual budget-boundary flicker) are implemented and tested but left staged/opt-in, pending visual verification in a browser. Measurement remains for visual inspection, not survey-grade unless validated against survey-grade data and procedures.

## Internal restructuring

A composition root (`AppRuntime`/`AppContext`) now owns the shared application state that previously lived in scattered module-level variables, and the first extracted service manages the layer list against it. Behaviour is unchanged — this is the foundation the v0.6 workflow features build on, landed early so they arrive on stable ground.
