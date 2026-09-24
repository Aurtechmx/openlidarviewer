# Known limitations: OpenLiDARViewer 0.7.0-alpha.1

**In development.** This document is written from the final state at freeze. What
follows is the state so far, and every entry is reproduced rather than carried
forward from v0.6.9 by default.

## Classification flags are preserved but not yet acted upon

The decoder keeps Synthetic, Key-Point, Withheld and Overlap, and both LAS
writers emit them. No processing path consumes them yet, so a withheld point
still enters terrain, density and stockpile as an ordinary return. ASPRS says a
producer generally sets Withheld on overlap points culled during flight-line
merging, so this matters on conforming files. A withheld processing policy is
open work.

## Flags do not survive every derivation

Clipping carries them. Voxel downsampling leaves them undefined on the points it
produces. Each output point sits at the centroid of its voxel's members, so a
voxel mixing a Withheld return with an ordinary one has no single true Withheld
state to give it. A reduced-view LAS export writes that flag byte as zero; the
source-faithful export decodes the file again and keeps the flags. EPT and COPC
decode on their own path and produce no flags, which reads as absent rather
than as false zeros.

## Class names are exact only when the format is known

A source that declares a point data record format gets the exact name. A
streaming source declares none here, and the four codes whose meaning differs
between the legacy and extended tables report both readings rather than one
guess.

## What the ledger settled, and what it did not

Every v0.6.9 limitation was reproduced or cleared rather than carried forward.
The implementation ledger records each one with how it was established and the
test that proves its status. Of the inherited set, the boundary share was fixed,
the stockpile split was half closed, and two turned out not to reproduce: the
oriented extent is presented as a principal-axis estimate with its failure mode
named, and truncation is reported rather than hidden.

## The boundary share now measures the survey edge

It seeded a distance field at every cell that was not measured, so on a grid
thinned by a display stride nearly every measured cell sat beside a seed. Over
one geometry it read 33 per cent at full decode and 100 per cent strided. It
seeds only from cells with no reachable data now, and distances travel through
the surveyed region, so neither depends on how densely the surface was sampled.

## One lasso still answers twice

The toast reports an area-weighted grid volume. The stored record holds the
point-sample figure, and they do not agree. The record now names which estimator
produced it, and a record written before that field carries none rather than
being read as the newer method, but the two numbers are still two numbers.
Moving the stored figure changes an exported value and is not done here.

## Two densities, each stating its basis

Analyse reads the resident gather and the Scan Report divides the declared count
by the sampled footprint. They differ by roughly the stride factor. Neither
hides its basis: on a strided load the report says in the value itself that it
is the declared count over the display-sample footprint. What is missing is one
record rather than two computations.

## Flow Pulse is topographic routing only

Flow Pulse opens from the command palette and routes flow over the analysed DTM
with D8. It builds a routing graph over that surface. It is not rainfall,
runoff, infiltration or flood modelling, and accumulation counts cells rather
than water.

The lab offers a conditioning control: raw routing, or the same surface run
through Priority-Flood depression filling first. Either way, a cell with no
lower neighbour keeps its flow as a sink, and a cell level with a neighbour is
reported unresolved rather than given a direction. Interpolated cells are
routed over, so a path may cross ground no return landed on, and routes stop
at cells with no elevation.

There is no click-to-pulse on the live scan; `Viewer.ts` has no picking seam
this feature reaches without growing the monolith. Instead a keyboard- and
pointer-accessible 2D result grid stands in for that click, with a
downstream-path trace, an upstream-catchment trace, and a log-scaled
accumulation overlay (cell counts, not water) drawn on the grid and, when the
caller supplies scene membership, in the 3D scene as well.

Each run lists its limitations beside its figures. Whether Withheld points were
excluded is not recorded for the terrain behind it, so no run can state it
either way. A terrain built from a streamed subset or a sample is named as
such. With the horizontal scale unresolved, contributing area in square metres
is withheld and cell counts remain. A geographic frame whose latitude is
unknown is refused, including a scene whose contributing layers do not share
one origin, since the latitude is read from that origin. A grid above 4,000,000
cells is refused.

The result is a summary card plus the interactive grid. An export package (ZIP)
is available from the lab: accumulation and direction rasters, a depression
table, the sealed run record and its reproducible config, and a processing
manifest with a README and an artifact passport, plus the traced path and
catchment when the lab has drawn them. Export refuses on a stale result rather
than naming a terrain that changed under it.

The result grid's selected-cell readout states a real elevation with its
resolved unit, or "unknown" rather than a bare number, and a raised cell's
fill depth in the conditioning limitation carries the same unit, failing
closed to "in source units" when it did not resolve. The exported ASCII
rasters carry the real lower-left corner and a `.prj` sidecar when the CRS
resolves, rather than a fixed local (0, 0) origin. The accumulation overlay
now stays drawn on the scan after the lab closes, until the user turns it
off or the terrain/CRS it was built from goes stale; that staleness is only
re-checked the next time the lab is reopened, not the moment the change
happens, so a dataset swapped while the lab stays closed can leave a stale
overlay on screen until it is reopened once.

## Terrain Access is a geometry screening, never a safety guarantee

Terrain Access opens from the command palette next to Flow Pulse. It screens
a route between two chosen cells against a mobility profile the reader
declares themselves, with no preset presented as validated. It is not a
safety assessment, a guaranteed-passable route, or a vehicle dynamics
simulation; soil strength, traction, tire/track-soil interaction, rollover,
weather and vegetation compliance are not modelled, and no string in the
Lab, the run record or the export calls a route safe, drivable or passable.

A browser check of the sibling Flow Pulse feature on a real UTM tile found
five defects. Terrain Access shares the same architecture and inherits four
of them, disclosed here rather than left for a reader to discover:

The cell readout and the export diagnostics report elevation and distance in
the DTM's own working frame, which is not necessarily the dataset's true
vertical datum and unit; a recentred local origin would print a small local
number instead of the real-world elevation.

The 3D traversability overlay is only visible while the Lab modal is open
and its GPU resources are released when the modal closes, so it is never
seen alongside the rest of the scene.

Exported rasters carry a local (0, 0) origin and no `.prj` unless a world
origin and CRS name are supplied, and the route GeoJSON is local planar
metres rather than the dataset's real coordinates.

The run record's basis is read from the DTM's own `coverageMode`, the same
field Flow Pulse reads, so a mismatch between that field and how the
terrain was actually analysed would read the same way in both features.

These four are tracked as shared, cross-simulation fixes on
`fix/flow-pulse-findings-v070` and its Terrain Access follow-on, not as four
independent problems to solve twice. Fixing the frame/CRS gap for one
simulation and not the other would leave them disagreeing about the same
terrain.

`src/main.ts` is 4,965 lines and `src/render/Viewer.ts` is 6,153, seventy lines
below its v0.6.9 count. Five getters collapsed to make room for a memory
accessor and a size-mode call, and the streamed draw cull then paid for its own
wiring by moving the pass onto the streaming renderer and collapsing two more
expressions. Making the loop request-driven then took another thirty-one out:
the activity deadlines, the reasons a frame is wanted and the scheduler left
together as one object, which is fewer lines here and one thing to reach for
there. The frame gained a decision while the file lost lines. A shrink-only lint
fails the build when either passes its recorded baseline, so a raise is a hand
edit to `docs/validation/monolith-size-baseline.json` and always shows in the
diff. It caught an added line twice during this cycle, and a banked drop once.
Fan-out is 109 for the shell, 76 for the renderer and 23 for the Analyse panel,
across 912 modules with no dependency cycles.

The lab has three stages: the blank mobility-profile form; a
traversability-map preview where start and goal are chosen on a keyboard-
and pointer-accessible 2D result grid, with a "why not?" inspector for any
cell; and the completed run, with route diagnostics, the route drawn on the
grid and, where scene membership is supplied, in the 3D scene. A run refuses
by name (`NO_DTM`, `UNITS_UNRESOLVED`, `INVALID_PROFILE`, `START_BLOCKED`,
`END_BLOCKED`, `NO_ROUTE`, `INSUFFICIENT_EVIDENCE`, `TOO_LARGE`), and the
lab separately refuses a stale preview or run the moment the terrain behind
it may have changed since the profile was applied.

Vehicle length is recorded in the profile and the diagnostics but not
enforced; eligibility uses width-only clearance, not full swept-body
collision. The independent Python oracle that cross-checks the routing core
is a check written inside this project, not an externally maintained
routing tool, which is why the `TERRAIN-ACCESS` claim sits at E3 rather than
a cross-implementation level against an outside tool.
