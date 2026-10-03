# Known limitations: OpenLiDARViewer 0.7.0-alpha.1

In development. This document is written from the final state at freeze. What
follows is the state so far, and every entry is reproduced rather than carried
forward from v0.6.9 by default.

## Withheld points are excluded from scientific products, not from registration, classification or measurement

The decoder keeps Synthetic, Key-Point, Withheld and Overlap, and both LAS
writers emit them. Terrain analysis, both volume tools (the lasso stockpile and
the polygon Volume tool), profiles (the profile chart and the profile workbench
section), point density (the scan report's Density and Spacing, and the
density tier), elevation comparison between two epochs and feature extraction
leave Withheld points out and record how many points they read,
how many were Withheld and how many they analysed. Overlap points are kept.
When the flags cannot be read, as on a voxel-reduced load or where density
uses the file header's total, the Withheld count is recorded as unknown.
Terrain analysis first decodes the source file again when it can, and then
records the counts from that decode. The ground filter outside terrain, the
classifier, registration, measurement, the health check and the Process
Studio spacing probe read Withheld points like any other return. The elevation difference raster has no metadata block, so its counts
appear in the compare panel only. ASPRS says a producer generally sets Withheld on overlap
points culled during flight-line merging, so this matters on conforming files.

## Flags do not survive every derivation

Clipping carries them. Voxel downsampling leaves them undefined on the points it
produces. Each output point sits at the centroid of its voxel's members, so a
voxel mixing a Withheld return with an ordinary one has no single true Withheld
state to give it. A reduced-view LAS export writes that flag byte as zero; the
source-faithful export decodes the file again and keeps the flags. COPC tiles
always carry the flags byte. An EPT dataset carries it in laszip tiles or in a
`ClassFlags` schema dimension; a binary EPT schema without that dimension has
no flags channel, which reads as absent rather than as false zeros.

## Class names are exact only when the format is known

A source that declares a point data record format gets the exact name. A
streaming source declares none here, and the four codes whose meaning differs
between the legacy and extended tables report both readings rather than one
guess.

## Clear classifications holds for one session on a loaded scan

Clear classes sets every point to class 1 in the viewer. The working classes
are not saved in a session file, so reopening the scan brings back the file's
classes. Streaming COPC and EPT scans can be neither cleared nor
auto-classified: both actions need a fully loaded scan, and Edit classes stays
hidden on a streaming scan. Undo steps back over a clear, a restore and an
auto-classify, but an auto-classify on a scan that carried no classes at all
is not undoable. Restore earlier classes brings back the codes held before the
first clear or auto-classify, hand edits made before it included, so it can
differ from the file's codes. The kept codes take one byte per point once the
first clear or auto-classify runs, and the undo history drops its oldest steps
past 128 MB per scan.

Two outputs carry a cleared or derived marker inside the file: the header
comment of the quick XYZ export and the PDF report. Both name the classifier's
id and version beside derived classes. LAS 1.2 and 1.4, the converter's XYZ
and ASC, CSV and the PNG image exports write the classes with no marker. The
Export panel states the provenance on screen; those files do not.

Auto-classify finds ground, vegetation and buildings only, and buildings come
from a height and roughness heuristic. It does not find wires, poles, water,
bridges or noise, and its result is heuristic, not survey-grade.

## What the ledger settled, and what it did not

Every v0.6.9 limitation was reproduced or cleared rather than carried forward.
The implementation ledger records each one with how it was established and the
test that proves its status. Of the inherited set, the boundary share was fixed,
the stockpile split was closed, and two turned out not to reproduce: the
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

## The ground filter loses ground on curved terrain

The ground filter is measured on five synthetic scenes in two ways.

`tests/groundFilterPdalAgreement.test.ts` compares it, label for label, with
PDAL's `filters.smrf` under the study settings: window 16, slope 0.15,
threshold 0.5 m, no threshold cap, and the despike floor off
(`floorPercentile` 0). The app does not run these settings. Under them the
filter labels 73.94% of PDAL's ground returns as ground, pooled over the five
scenes, with 44.79% on the rolling scene and 0.99% on the low-blunder scene.
These figures are agreement with PDAL, written to
`validation/cross-implementation/pdal-pipeline/results-ground-filter-metrics.json`.
They are not accuracy.

`tests/groundFilterTruthRecall.test.ts` scores PDAL, the study settings and the
shipped settings against the ground labels each scene was built with, and
writes the figures to
`validation/cross-implementation/pdal-pipeline/results-ground-filter-truth.json`.
In the table, shipped means window 8, slope 0.2, threshold 0.5 m, a 2.5 m cap
and a 5th-percentile despike floor, at a 1 m cell. The app takes the cell size
from each cloud's grid, and does not run the filter when a cloud already has
usable class-2 ground.

| Scene | Shipped recall / precision | Study recall / precision | PDAL recall / precision |
| --- | --- | --- | --- |
| Plane with buildings | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% |
| Rolling with buildings | 69.0% / 100.0% | 38.5% / 100.0% | 86.0% / 100.0% |
| Ridge with buildings | 91.9% / 100.0% | 69.2% / 100.0% | 96.6% / 100.0% |
| Plane with low blunders | 98.6% / 99.7% | 0.0% / 0.0% | 31.5% / 99.0% |
| Plane with gap | 100.0% / 100.0% | 100.0% / 100.0% | 100.0% / 100.0% |

The low-blunder scene holds 30 returns 4 m below the ground. With the despike
floor off, each one sets the minimum of its cell. Opening removes peaks, not
pits, so the surface stays down at the blunders and the true ground above it is
rejected. Under the study settings the filter calls only the 30 blunders
ground. The shipped 5th-percentile floor stops the blunders dragging the
surface down, so 98.6% of the ground is kept, but the 30 blunders are still
labelled ground.

The remaining limit is curved terrain. The filter tests each return against an
opened surface that cuts through convex ground, so ground on a curve is
rejected. With the shipped settings the rolling scene keeps 69.0% of its
ground. With the shipped settings, precision is 99.67% or higher on every
scene, and the only false ground calls are the 30 low blunders on the
low-blunder scene.

The truth labels come from this project's own scene generator. Five synthetic
scenes are not survey data, and these figures say nothing beyond them.

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

Each run lists its limitations beside its figures. A run states whether
Withheld points were left out of the terrain behind it, as the terrain analysis
recorded it; when a contributing source carried no flags, the run says the
exclusion is not recorded. A terrain built from a streamed subset or a sample is named as
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
stays drawn on the scan after the lab closes, until the user turns it off. It
is removed when the terrain or CRS it was built from goes stale: another scan
loads, the scan closes, the CRS changes or a classification edit invalidates
the terrain.

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

Compare elevation, which needs exactly two loaded layers, aligns the second
epoch to the first with its own planar fit, applying a yaw and a horizontal
shift with Z locked, before it differences them. That fit lives in the change
detection code and does not reach the six modules.

A half-wired alignment tool is worse than none, and the workflow it would need
is not built.

## Four legs block a merge; the iOS simulator is advisory

Chromium, Firefox, WebKit and Windows block a merge. The `e2e-firefox`,
`e2e-webkit` and `windows` jobs run in `ci.yml` and are listed in `ci-green`'s
`needs`, which the ruleset for `main` requires (ledger L13). Windows runs
Chromium. The iPhone-shaped WebKit project runs in the cross-browser smoke
workflow, which sits outside `ci-green` and which no ruleset requires. Touch
gestures run end to end on all three engines, and in the iPhone-shaped WebKit
project, as synthesized pointer events. Multi-touch on a real device is
unverified. An iOS simulator check drives real Mobile Safari on a pinned
simulator (iOS 26.5, iPhone 17e) and has passed end to end, including a
two-finger pinch. It runs only when started by hand and is advisory until 20
consecutive passes, counted by `scripts/ios-streak.mjs`. No matrix is recorded
for this development cut: that evidence comes from the engines themselves.

## The two monoliths are still monoliths

`src/main.ts` is 4,429 lines and `src/render/Viewer.ts` is 6,022, two hundred and one lines
below its v0.6.9 count. Five getters collapsed to make room for a memory
accessor and a size-mode call, and the streamed draw cull then paid for its own
wiring by moving the pass onto the streaming renderer and collapsing two more
expressions. Making the loop request-driven then took another thirty-one out:
the activity deadlines, the reasons a frame is wanted and the scheduler left
together as one object, which is fewer lines here and one thing to reach for
there. The frame gained a decision while the file lost lines. The two-finger
pinch and pan now share one screen-space shift, which took another
thirty-six out. The figure view context moved into the export adapter, which
took twenty-one more. A shrink-only lint
fails the build when either passes its recorded baseline, so a raise is a hand
edit to `docs/validation/monolith-size-baseline.json` and always shows in the
diff. It caught an added line twice during this cycle, and a banked drop once.
Fan-out is 97 for the shell, 75 for the renderer and 23 for the Analyse panel,
across 1063 modules with no dependency cycles.

## The shell has little headroom

`npm run check:bundle` on the live build reports the index chunk at 576 KiB
of its 795 KiB ceiling and the Viewer chunk at 628 KiB of 716 KiB. The
ceilings are unchanged. New work still goes behind a lazy seam rather than
being paid for by a raise.

## An idle scene still draws four frames a second

When nothing asks for a frame the render loop sleeps, but it still draws one
heartbeat frame every 250 ms (`IDLE_HEARTBEAT_MS` in
`src/render/frameScheduler.ts`) so that a change nobody announced reaches the
screen. On a machine without GPU rendering the browser draws those frames in
software, so an idle scene holding a large cloud keeps using CPU while nothing
on screen moves.

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

## Measurement exports with more than one scan open

The GeoJSON and CSV measurement exports place each measurement through the
scan it belongs to and name that scan in a `source` field and in the file
name. Each point is placed through the scan it was picked on. A session keeps
that record. A measurement with no pick record, such as one from an older
session, is placed through the scan it was recorded on only when the open
scans place a point the same way, and is refused otherwise. A
measurement with no recorded scan, one whose points sit on scans whose heights
are not in one frame, or a set spanning scans that declare different coordinate
systems is refused rather than exported. A session saved with one scan and
restored with two open is placed through the scan it matches; when that scan
cannot be identified, close the other scans and export again. The integrity
and findings reports name the active scan; they carry lengths and areas, not
coordinates. The site KML is written only while one scan is open.

## Truncated files and unknown units

A LAS file whose body ends before its declared records opens with the records
it holds and reads as partial coverage: "Truncated: N of M points read".
Truncation is recorded for uncompressed LAS only; a truncated LAZ is not marked partial. When the horizontal unit is
unknown, measurement rows, the measure hint, the profile chart, summary and PDF,
and the Profile Workbench state the unit is unverified.

## Export digests that some surfaces cannot carry

Provenance-carrying exports record the source file SHA-256, the CRS origin and,
for an export that comes from an analysis, the SHA-256 of the points it read.
Some surfaces cannot carry every field:

- A streamed scan (COPC, EPT, 3D Tiles, a local LAS opened out of core) records
  "not available for streamed sources" in place of a source digest. Only a part
  of the file is ever read.
- A scan opened without a retained File (a session restore, a link) records
  that the original bytes are not held.
- Point CSV and measurement CSV have no comment slot and carry none of the
  three. Export the GeoJSON or XYZ beside them.
- The GeoTIFF rasters carry band names and units only; the README and the
  passport in the same package carry the digests.
- A figure PNG rendered from several visible layers has no single source file
  and carries neither the source digest nor the CRS origin chunk.
- A terrain analysis over several layers, or over a static layer and a
  stream, records no single source digest and states how many sources it
  combined. The analysis-input digest covers the whole sample, which is
  strided and in the viewer's scene frame, so only this app can reproduce it.
- Flow Pulse and Terrain Access packages read a DTM, not points: their input
  digest is the DTM product digest.
- The batch converter hashes each input file, but records the CRS origin as
  unknown, because it does not resolve a CRS per file.
- The session file is unchanged and carries none of the three.

## One streamed source at a time

Many static layers can be open at once. A streamed COPC, EPT or 3D Tiles
tileset source is open one at a time: opening one closes the stream already
open and every static layer, and opening a static file while a stream is open
closes the stream. A local LAS or LAZ file too heavy for memory streams from
disk. It replaces an open stream, with that stream's class legend counts, scan
report and confidence, and keeps the static layers open.

## No cross-CRS reprojection

Unchanged from prior releases. Scans must share a coordinate reference system to
be compared, and the viewer refuses rather than approximating.
