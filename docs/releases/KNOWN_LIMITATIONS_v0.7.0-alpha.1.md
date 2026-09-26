# Known limitations: OpenLiDARViewer 0.7.0-alpha.1

In development. This document is written from the final state at freeze. What
follows is the state so far, and every entry is reproduced rather than carried
forward from v0.6.9 by default.

## Withheld points are excluded from terrain, profiles and density only

The decoder keeps Synthetic, Key-Point, Withheld and Overlap, and both LAS
writers emit them. Terrain analysis, lasso stockpile volumes, profiles (the
profile chart and the profile workbench section) and point density (the scan report's Density and
Spacing, and the density tier) leave Withheld points out and record how many
points they read, how many were Withheld and how many they analysed. Overlap
points are kept. When the flags cannot be read, as on a voxel-reduced load or
where density uses the file header's total, the Withheld count is recorded as
unknown. The polygon Volume tool and the other analyses still read a Withheld point
as an ordinary return. ASPRS says a producer generally sets Withheld on overlap
points culled during flight-line merging, so this matters on conforming files.

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

## A lasso volume has one figure and a cross-check

The toast, the saved record, the CSV, GeoJSON and the report all read one
stockpile result built from the area-weighted grid. The point-sample cut and
fill is kept beside it under its own columns as a cross-check, and the two
still differ. A record saved before this change keeps its method version and
its stored figure; it is never recomputed. The polygon Volume tool still uses
the point sample.

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
declares, with no preset presented as validated. It is not a safety
assessment, a guaranteed-passable route or a vehicle dynamics simulation:
soil strength, traction, track or tyre interaction with the ground, rollover,
weather and vegetation are not modelled, and no text in the Lab, the run
record or the export calls a route safe, drivable or passable.

The Lab has three stages: the mobility-profile form; a traversability-map
preview where start and goal are chosen on a keyboard- and pointer-accessible
result grid, with a "why not?" inspector for any cell; and the completed run,
with route diagnostics and the route drawn on the grid and on the scan. Cell
readouts give elevation in the dataset's vertical datum and unit, or say it is
unknown. Lengths, slopes and steps are in metres; a run refuses by name
(`UNITS_UNRESOLVED`) when the horizontal scale or the vertical unit does not
resolve. Other named refusals are `NO_DTM`, `INVALID_PROFILE`, `START_BLOCKED`,
`END_BLOCKED`, `NO_ROUTE`, `INSUFFICIENT_EVIDENCE` and `TOO_LARGE`, and the Lab
refuses a preview or run whose terrain may have changed since the profile was
applied.

The cell readout states a real elevation with its resolved unit, or
"unknown" rather than the DTM's grid-local `z` printed bare, using the same
`ElevationReference` gate `flowGridCursor.ts` uses for Flow Pulse. Every
length/slope/step figure is always metric: `UNITS_UNRESOLVED` refuses before
a result can exist if the horizontal scale or vertical unit-to-metres factor
does not resolve. The route and traversability overlay stays on the scan
after the Lab closes and is removed when the scan closes, the CRS changes or
the classes are edited, through the same disposal-registry seam
(`registerTerrainAccessOverlayInvalidator`/`invalidateTerrainAccessOverlay`
in `lazyChunks.ts`) Flow Pulse's overlay already uses. Exported rasters and
the route GeoJSON carry the real world corner in the dataset CRS, with a
`.prj` when a world origin and CRS/WKT are supplied, rather than always a
local (0, 0) origin. The run record states whether the terrain was built
from every point or from a sample, read from the DTM's own `coverageMode`
(`computeTerrainCore`'s own fix, shared by every reader of that field), so
Terrain Access states the same honest basis without a change of its own.

Vehicle length is recorded in the profile and the diagnostics but not
enforced: eligibility uses width-only clearance, not full swept-body
collision. The independent Python oracle that cross-checks the routing core
was written inside this project, not taken from an external routing tool, so
the `TERRAIN-ACCESS` claim sits at E3.

## Registration is not exposed

Six modules implement alignment. No user path reaches them.

A half-wired alignment tool is worse than none, and the workflow it would need
is not built.

## The browser matrix is advisory

Chromium blocks a release; Firefox, WebKit and Windows do not, and no ruleset
requires the cross-browser smoke workflow. Touch gestures run end to end on all
three engines, and in the iPhone-shaped WebKit project, as synthesized pointer
events. Multi-touch on a real device is unverified. An advisory iOS simulator
check drives real Mobile Safari on a pinned simulator (iOS 26.5,
iPhone 17e) and has passed end to end, including a two-finger pinch. It
stays advisory until 20 consecutive passes, counted by `scripts/ios-streak.mjs`
under the rule in ledger L13. No matrix is
recorded for this development cut: that evidence comes from the engines
themselves.

## The two monoliths are still monoliths

`src/main.ts` is 4,691 lines (the desktop rail and phone sheet wiring moved to
`src/app/workspace/workspaceShell.ts`) and `src/render/Viewer.ts` is 6,136, eighty-seven lines
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
Fan-out is 103 for the shell, 76 for the renderer and 23 for the Analyse panel,
across 1000 modules with no dependency cycles.

## The shell has little headroom

The eager bundle measures about 799 KiB against an 812 KiB ceiling. New work
goes behind a lazy seam rather than being paid for by a raise.

## Multi-layer mounting is enabled, with a precision refinement outstanding

Physical multi-layer mounting ships enabled, unchanged from v0.6.9. Two
georeferenced layers declaring the same projected CRS mount into one shared
project frame at their real separation, non-destructively, and each boundary
recovers the world coordinate in the frame it names. One item remains a
precision refinement rather than a correctness defect. The renderer forms each
mesh's model-view matrix on the CPU in float64, so display precision does not
depend on placement distance: the matrix the GPU receives stays within 4 µm of
the exact product at every offset tested, from 0 to 1,000 km, in each browser
engine. The analysis paths that store placed coordinates, and the terrain
gather, carry the placement in Float32. The mount-precision gate therefore still
refuses a placement whose Float32 step would pass 1 mm, which on a metre grid is
a placed reach of 16,384 m or more, and those paths stay under 1 mm inside the
gate. Picking and distance are computed in Float64 and are exact, as are
exports.

## No cross-CRS reprojection

Unchanged from prior releases. Scans must share a coordinate reference system to
be compared, and the viewer refuses rather than approximating.
