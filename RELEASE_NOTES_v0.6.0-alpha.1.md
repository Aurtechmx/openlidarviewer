v0.6.0-alpha.1 opens the v0.6 cycle. Where v0.5.9 finished a deliverable workflow, this cut is about the machine underneath it: the viewer starts faster, streams without visual noise, recovers cleanly when a deploy sweeps its own code out from under an open tab, and fixes two rendering-correctness defects. It also lays the first structural groundwork for the v0.6 workflow features.

This is an alpha for evaluation. Interfaces and internals may still change before v0.6.0, and the v0.6 headline workflows are not in this cut.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Faster first load

The Analyse and Object panels — two of the heaviest interface modules — now mount when the first scan loads instead of at boot. The live entry chunk drops from 792 KiB to about 678 KiB (−15 %), and the bundle-budget guard's ceiling tightens from 800 to 720 KiB with an early-warning threshold at 680, so the win is locked in rather than left to erode.

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

## Internal restructuring

A composition root (`AppRuntime`/`AppContext`) now owns the shared application state that previously lived in scattered module-level variables, and the first extracted service manages the layer list against it. Behaviour is unchanged — this is the foundation the v0.6 workflow features build on, landed early so they arrive on stable ground.
