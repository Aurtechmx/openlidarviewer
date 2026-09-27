# Known limitations: OpenLiDARViewer 0.7.0

Draft for the release freeze. Each `[FREEZE: ...]` marker is a figure the
release step fills from the machine files named beside it. Every entry is
reproduced from the v0.7 implementation ledger
(`docs/releases/V070_IMPLEMENTATION_LEDGER.md`), which records how each was
established and the test that holds it.

## No result here was measured on a real phone or tablet

Touch, layout and frame-time evidence comes from desktop browsers and from
emulated viewports. No run on a real phone, tablet or WebKit device is
recorded (L42, L96, L103, L109, L110). A touch-first device is therefore
capped at the simplest rendering rung until a measured record names a higher
one.

## The frame budget governor is off

Governor v3 passed its pre-registered comparison on one machine and one
browser. That is not enough to turn it on for every device, so it stays off
and is compiled out of the published build. The render budget remains a fixed
table per tier.

## Calibration is inconclusive

Calibrating the governor's starting level from warm-up frames failed its
pre-registered comparison on both datasets. On the test machine the warm-up
picked the lowest level in all 70 runs, so the calibrated and fixed arms ran
the same policy. The comparison says nothing yet about calibration on
hardware where the warm-up would pick a higher level, and that would need a
new pre-registration. Calibration is off.

## Raw files are not recovered

Recovering point records from a headerless or unknown-layout file is not
included in 0.7.0. An unknown file is described by the probe, not opened. A
labelled corpus and acceptance criteria for a future attempt were committed
before any recovery code, in `validation/intake-corpus/` (#1075).

## The DEM package is plain GeoTIFF

The rasters in the DEM package are plain GeoTIFF files. None is written in a
cloud-optimised layout, and the package carries no STAC item. The evidence raster is written by default. The sensitivity and
attention rasters are written only on request, so a default package is at
tier T2 and never T3. Sensitivity measures agreement between a fixed set of
settings, and attention level 0 means no reason was found. Neither is an
accuracy figure.

## The Observatory is a preview

Its basis is the resident points only. It needs declared station positions,
and a labelled assumed origin drops it to preview. Suggested stations are
candidates ranked by how many shadowed voxels they would observe, not optimal
positions, and reachability on the ground is not checked. Flow Pulse and
Terrain Access are also preview: Flow Pulse is topographic routing, not a
flood or runoff model, and Terrain Access is a geometry screening, not a
safety guarantee.

## Work still partial or deferred in the ledger

Each row below is PARTIAL or DEFERRED in `V070_CURRENT_STATUS.md` at the time
of drafting. [FREEZE: regenerate the status file and reconcile this list.]

### Measurement and semantics

- L06: Analyse and the Scan Report compute density separately. Each states
  its basis, and on a strided load they differ by about the stride factor.
- L28: voxel downsampling leaves Withheld and the other flags undefined on
  the points it produces. A reduced-view LAS export writes that byte as zero;
  the source-faithful export keeps the flags.
- L19: the ground filter scores near F1 0.5 on mountain scenes and 0.34
  precision under dense canopy against external labels. It is documented, not
  tuned to the benchmark.
- L20: there is no cross-CRS reprojection. The viewer refuses rather than
  approximating.

### Rendering precision and streaming

- L14: model-view matrices are formed in float64 on the CPU for far-mounted
  layers. [FREEZE: state the refinement still outstanding.]
- L46: streaming nodes are culled to the view frustum on every rendered
  frame, and no renderer benchmark record measures the effect.

### The Continuity Field is built and not wired

L52, L55 to L59, L61, L62, L64 to L67, L69, L71, L75, L77, L80 to L84, L89,
L90 and L115 cover the Continuity Field: display epoch, temporal phases,
depth-aware accumulation, gap closing, the lens, support, fallback rungs,
history targets, metrics and export labelling. The modules are tested in Node
and no renderer calls them, so no frame has been drawn through the field. It
is hidden in the capability manifest. An exported image is labelled but not
isolated from reconstruction (L64, L115). Choosing a phase count per scene
(L68) and re-measuring the point kernel (L70) wait for that wiring.

### Unreachable code

- L15: the registration stack ships and no user path reaches it. It stays in
  the unreachable register until the whole workflow exists.

## The evidence ceiling

The claim register holds [FREEZE: E4] claims at E4 and none at E5.
[FREEZE: note any claim that changed level this cycle, or state that none
did.]

## The two monoliths are still monoliths

`src/main.ts` is [FREEZE: monolith-size-baseline main.ts lines] lines and
`src/render/Viewer.ts` is [FREEZE: monolith-size-baseline Viewer.ts lines],
from `docs/validation/monolith-size-baseline.json`. A shrink-only lint fails
the build when either grows.

## Multi-layer mounting keeps its precision caveat

Layers mounted far from the origin render with the float64 model-view path
above. [FREEZE: carry the far-mount wording from the corrected limitation in
#1066.]

## Inherited limits

Limits carried from v0.6.9 without change are listed in
`KNOWN_LIMITATIONS_v0.6.9.md` and were each reproduced in the ledger rather
than carried by default.
