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

## Class edits are not stored in a session file

A session file stores the class filter, not per-point classes. Lasso edits,
clears and auto-classify results are gone after a session is saved and
restored. Save session says so when the open scan carries class edits. To keep
them, export the scan as LAS at display resolution: a full-resolution export
re-reads the source file and refuses while class edits differ from it. The
recovery journal does not keep class edits either, and a streaming scan cannot
be reclassified, so Save session gives no warning there. Storing an edit log
keyed to the source file's SHA-256 is planned for v0.7.1.

## A Safari chunk failure online can still reload the page

When a lazy part of the app fails to load while the browser reports a
connection, the page reloads only if the server no longer has the file. Safari
names no file in that error, so on a connection that reports online but has no
uplink, Safari still reloads the page once, as before.

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
id and version beside derived classes. LAS 1.2 and 1.4 and the converter's XYZ
and ASC exports write the classes with no classifier id or version, only a
"Classes edited in app" line (yes or no, and "not applicable" when the classes
are left out); the measurement CSV sidecar carries the same line and the PNG
image export carries nothing. The Export panel states the provenance on screen.

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

## An Area ring that is far from planar or touches itself reports no area

An Area polygon is judged in its own best-fit plane. A ring whose vertices
sit further from that plane than a quarter of the ring's half-extent (about
14 degrees of tilt across the ring), or whose edges touch at a vertex or
overlap, reports no area. The Measure panel, totals and every export omit the
area figures and state the reason; the perimeter is kept. A ring that is only
slightly off its plane, such as a roof facet picked with a little noise, still
reports its plane area, which is a lower bound on the draped surface.

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

## Findings added during a higher-density reload are not protected

Saved findings added to a layer while a higher-density reload is decoding are
dropped when the layer is replaced. The confirm names the findings that exist
when you confirm. Measurements and annotations are not affected.

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

Terrain Access opens from its row on the Analyse home and from the command
palette, next to Flow Pulse. It screens
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

`src/main.ts` is 4,316 lines, twenty-five fewer since the Save view snapshot
moved to its own lazy module and the Analyse panel's longitude and latitude
wiring moved to the mapper module, and `src/render/Viewer.ts` is 5,962, two hundred and sixty-one lines
below its v0.6.9 count. Five getters collapsed to make room for a memory
accessor and a size-mode call, and the streamed draw cull then paid for its own
wiring by moving the pass onto the streaming renderer and collapsing two more
expressions. Making the loop request-driven then took another thirty-one out:
the activity deadlines, the reasons a frame is wanted and the scheduler left
together as one object, which is fewer lines here and one thing to reach for
there. The frame gained a decision while the file lost lines. The two-finger
pinch and pan now share one screen-space shift, which took another
thirty-six out. The figure view context moved into the export adapter, which
took twenty-one more. The measure click handling moved into the
measurement controller, which took twenty-eight more. A shrink-only lint
fails the build when either passes its recorded baseline, so a raise is a hand
edit to `docs/validation/monolith-size-baseline.json` and always shows in the
diff. It caught an added line twice during this cycle, and a banked drop once.
Fan-out is 97 for the shell, 75 for the renderer and 23 for the Analyse panel,
across 1105 modules with no dependency cycles.

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
gate. Picking and distance are computed in Float64. Exported coordinates are
exact to under 1 mm within a 16 km extent. LAS export keeps the source file's
scale and offset when the source is LAS or LAZ, the header values are valid,
the coordinates are the source's own and every one fits int32. Within the
extent where Float32 positions resolve the scale (16,384 m at a 1 mm scale,
1,024 m at 0.1 mm, past 100 km at 1 cm) each exported X, Y and Z integer record
equals the source's. Beyond that extent the scale and offset are still kept and
an integer record can differ from the source's by a few steps: up to 2 steps at
a 1 mm scale over 40 km. The export's provenance text records which case
applied. A reprojected, voxel-reduced, streamed or non-LAS export is
re-quantised at 1 mm (1e-7 degree on a geographic CRS) with the offset at the
floor of the data minimum, and the provenance text gives the reason.

## Release caveats on exports and reproduction

- The integrity report's digest is an unkeyed SHA-256 over the report body. A
  match shows the digest agrees with the contents, which catches accidental
  edits. Anyone who edits a figure can recompute it, so it is a
  self-consistency check, not a signature. It does not show who made the
  report, and the verifier does not compare `sourceSha256` against a source
  file.
- A report signed with "Sign this report" carries an ECDSA P-256 signature that
  detects a change to the report's figures or signed metadata after signing and shows whether two reports were signed
  by the same key. It does not show who holds the key, when the report was
  signed (the time is the signer's own claim), which source file the report came
  from, or that the numbers are right. The private key lives in one browser
  profile; clearing site data deletes it, and a compromised profile can sign
  anything. Every signed report carries the key id, so reports signed with one key
  can be linked. Removing the signature field leaves a report that verifies as an
  unsigned one.
- LAS export keeps the source scale and offset and returns the source's integer
  records within the extent Float32 positions resolve (16 km at a 1 mm scale);
  a reprojected, voxel-reduced, streamed or non-LAS export is re-quantised at
  1 mm. See the section above.
- LAS classes convert by meaning only where the specification gives one.
  Between LAS 1.0 to 1.3 and LAS 1.4, legacy class 8 (Model Key-point) becomes
  class 1 with the key-point flag, and legacy class 12 (Overlap Points) becomes
  class 1 with the overlap flag. The other numbers whose meaning differs (8, 10
  to 22) have no mapping between the two tables, so they are written unchanged
  and the report lists each with its point count. A LAS 1.4 export read by a
  LAS 1.2 reader shows class 19 and the other defined extended classes as
  reserved; high noise (18) has no legacy class. A LAS 1.2 write with such a
  class is refused until "Allow class numbers to change meaning" is ticked, and
  a LAS 1.2 write of points carrying the LAS 1.4 overlap flag is refused until
  "Allow the overlap flag to be dropped" is ticked. Each opt-in allows only its
  own loss, and the refusal names every opt-in the write needs. A LAS 1.4 write
  needs neither. Classes above 31 are refused or wrapped as before. A derived or cleared classification, or a source whose
  point format is unknown, is not translated: when such a classification of a
  legacy file is written as LAS 1.4, untouched legacy class 8 and 12 points are
  written as the reserved codes 8 and 12, with no translation and no warning.
- A LAS 1.2 write cannot keep every acquisition field. Scan angles are stored
  as whole degrees from -90 to 90 and there is no scanner channel, so a LAS 1.4
  file with an angle that rounds beyond 90 degrees or a nonzero channel is
  refused until the opt-in for those two losses is ticked. Angles inside the
  range are rounded to a whole degree, with halves rounding away from zero (-1.5
  is written as -2, where it was -1), and the file's text area records that
  without asking. The text
  area is the only place the file itself records a conversion: a reader that
  ignores it sees nothing, and a format other than LAS has no such record.
- The reproduction pack's metrics reproduce exactly under the Node version
  pinned in `.nvmrc`. Another Node or V8 version can change the last digits.

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

## Exports carry the geographic refusal, not the endpoint grade

On a geographic CRS the PDF report, profile sheet, CSV, GeoJSON, KML, findings,
integrity report, chain total and drawn labels withhold every figure but
heights, as the Measure panel does. The per-measurement support grade does not
travel with them: a measurement with an endpoint in empty space reads
Unverified in the panel and is still published as a number. On a compound CRS
whose height unit differs from its horizontal unit, the panel refuses 3D
lengths, grades and tilted areas, while the exports and the PDF publish them
computed with each axis in its own unit.

## The vertical unit is handled differently by different features

When a file declares no vertical unit, the features do not agree on what a height
is. The Scan Report and the streamed extent rows refuse to borrow the horizontal
unit: Height stays in source units and reads "source units (vertical unit not
declared)", and a declared but invalid vertical unit (zero, negative or
non-finite) is kept in source units and labelled the same way. The Measure tool,
the lasso volume, the project size, the terrain analysis runner and the
classifier cues call `verticalMetresPerUnit(ctx, 'horizontal')`, which borrows
the horizontal unit, so the same scan can show Height in source units in the
Scan Report and in metres in Measure. Only the lasso volume readout says so, with
" · heights assumed in the horizontal unit (vertical unit not declared)". A
height read in Measure carries no vertical-unit note of its own; it is flagged
only when the horizontal unit is unknown. A valid declared vertical unit is used
by every feature.

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

## Vertical CRS in exported rasters and LAS files

The DTM and DSM GeoTIFFs carry a vertical CRS only when it can be written as
an EPSG code in the unit of the heights. The writer knows the unit and axis
direction of a fixed list of vertical CRS codes, checked against the EPSG
registry. A code outside that list, a height unit the analysis could not
resolve, a datum with no EPSG code in the height unit (EGM2008 heights in
feet, for example) or a depth CRS leaves the vertical CRS off. The heights
keep their unit as the band unit, and the DEM package README names the source
code and the reason. The contour deliverable writes its DTM the same way, but
its README does not yet carry that note.

When the source declares no vertical unit, the height unit is borrowed from
the horizontal unit, and a vertical CRS written from it states that borrowed
unit as part of the CRS. The DEM package README says so beside the code.

LAS files written by the converter name the vertical CRS in the unit of the Z
values through the same table (NAVD88 in US survey feet is EPSG:6360). A
vertical code outside the table, or one with no unit to check it against,
passes through from the source unchanged, so a reader takes its unit from the
code.

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

## Longitude and latitude exports apply no datum transformation

The site KML, the scan-area KML, the RFC 7946 contour GeoJSON and the accepted
building-footprint GeoJSON write longitude and latitude. OLV computes them
without a datum transformation, so the export depends on the scan's datum:

- WGS 84 (EPSG:4326, 4979, WGS 84 / UTM and Web Mercator) is exported
  unchanged.
- NAD83 (EPSG:4269, 6318, NAD83 / UTM 26901 to 26923, NAD83(2011) / UTM 6330
  to 6349, and CONUS Albers 5070) is exported as if it were WGS 84, and every
  file says the positions are approximate, about 1 to 2 m. NAD83(2011) and
  WGS 84 at epoch 2026.75 differ by 0.9 to 1.6 m across the conterminous
  United States (0.89 m at Miami, 1.61 m at Seattle).
- ETRS89, RGF93, GDA94, GDA2020 and NZGD2000, geographic or projected, are also
  exported as if they were WGS 84, and every file names the datum and the size
  of the difference. Each datum is fixed to its plate at a reference epoch, so
  the difference grows every year. At epoch 2026.75 PROJ gives 0.93 m for
  ETRS89 (RGF93 follows it), 0.40 m for GDA2020 and 1.96 m for GDA94. NZGD2000
  needs the New Zealand deformation model, which PROJ does not have offline;
  the files state about 1 m.
- NAD27 is refused. proj4 has no NAD27 grids and would apply no shift, which is
  34.6 m wrong at 100 W, 40 N and 61.7 m wrong in UTM zone 12. Reproject in
  OLV refuses a NAD27 datum leg for the same reason, so it cannot produce a
  WGS 84-labelled file that the exports would treat as exact.
- A geographic CRS on CGCS2000 or another datum OLV does not list, or with no
  EPSG code, is refused.
- A projected CRS whose proj4 definition carries no datum is refused unless its
  EPSG datum is WGS 84 (Web Mercator).
- British National Grid, CH1903+ / LV95 and S-JTSK / Krovák carry a Helmert
  shift in their proj4 definitions and are exported without a datum note. A
  Helmert shift is an approximation of the national transformation grids.
- A geographic coordinate with latitude outside -90 to 90, longitude outside
  -180 to 180, or a non-finite value is refused. Longitudes are not wrapped.

The NAD27 refusal reads: "This scan is on NAD27. Longitude and latitude export
needs a datum transformation that OLV does not apply yet, and Reproject in OLV
applies no NAD27 shift. Reproject the scan to WGS 84 with PROJ, GDAL or PDAL
using the NADCON or NTv2 grids, then open the result." The KML buttons, the
building-footprint export and the contour GeoJSON export show it.

Planned for v0.7.1: real datum transformation with epoch and grids (NADCON,
NTv2 and time-dependent ITRF transformations), so NAD83, NAD27 and the
plate-fixed datums can be exported at their true WGS 84 positions.

## Grid north, not true north

The map sheet's orientation arrow, the compass rose and the distance bearing in
the Measurements panel are measured from the scan's +Y axis. On a projected CRS
that is grid north, which differs from true north by the meridian convergence:
1.29 degrees in UTM zone 12 at 109 W, 40 N, 2.27 degrees at a zone edge at
49 N, and at most 2.98 degrees at 84 N. The arrow and the rose's top face read
"Grid N", and the bearing reads, for example, "042° grid" on a projected CRS
with an EPSG code. With no CRS, a local engineering CRS or a Y-up scan, the
bearing reads "(local axes)", and the map sheet keeps its "local grid up / true
north unknown" note. A geographic CRS shows no bearing, because a degree of
longitude and a degree of latitude are not the same length. Hillshade and
aspect azimuths are grid-relative too, as is usual in GIS.

Planned for v0.7.1: a true-north arrow on the map sheet, rotated by the
meridian convergence at the sheet centre and labelled with that angle.

## The reference plane is a drawing, not a surface

The View panel's reference plane is a visual grid at an elevation the user
sets. It has these limits:

- Nothing snaps to it. Measurements, picks and the clip box ignore it.
- A plane through three picked points passes through those three points
  exactly. It is not fitted to the scan around them, so the noise in each pick
  goes straight into its tilt.
- "Use scan minimum" takes the lowest point in the scan, which is often a
  noise return or a pit. It is not ground, and the panel says so.
- On a geographic scan the grid is laid out in degrees on the horizontal axes,
  and the readout calls its spacing "units" because a degree is not a length.
- Automatic spacing is chosen for the scale at the centre of the view. Toward
  the horizon of a low perspective view the far lines draw closer together, and
  they fade out below about 14 px apart rather than being drawn.
- The grid covers the scan and one scan size around it, capped at 100 major
  lines either side of the view centre. Past that it fades out.
- A point lying exactly on the plane can share pixels with a line, because
  polygon offset does not apply to lines.
- Lines are one pixel wide on both renderer backends.
- With two or more layers that share no datum, the plane is not drawn: there is
  no single source frame to place it in. That includes a mounted multi-tile
  project, whose tiles have different file origins: the panel says "Close the
  other layers to draw it". A single tile left placed in a project frame is
  drawn in that tile's own source coordinates.
- "Use scan minimum" takes the lowest point of every visible layer's bounding
  box, which is a box corner, not necessarily a point a pick would find. For a
  streamed COPC or EPT source it is the minimum of the header's bounding box,
  not of the points loaded so far.
- Closing the scan removes the plane. A plane is not carried from one scan to
  the next except through a saved session.

## Storage-grid diagnostics are a library, not a tool

`src/diagnostics/latticeForensics.ts` looks for earlier storage grids in
the integers of LAS and LAZ files: it predicts where a candidate grid
leaves spectral peaks, scores them and tests whether the points sit on
that grid's nodes. No panel calls it, so the application shows no result
from it. The caller supplies the candidate grids, their Jacobians and
their mapped nodes. It reads horizontal coordinates only. Its phase
uncertainty is a delete-one-window jackknife, which ignores spatial
correlation between windows. Empirical p-values cannot fall below 1/2001
per peak, and the combined value below that is a model figure, not a
calibrated probability. A supported grid is a grid the points are
compatible with; it does not say which operation produced it.

## Volumes on a voxel-reduced cloud cannot exclude noise or Withheld points

A polygon or lasso volume on a cloud the loader voxel-reduced reads centroids.
A centroid carries the class of the first point in its voxel and no flags, so
the walk cannot tell which of the points it stands for were ASPRS noise
(classes 7 and 18) or Withheld. The volume is integrated over all of them, and
the record, the Measure panel, the exports, the integrity report and the PDF
report say that exclusion was unavailable and give the reduction mode with the
resident and declared point counts. A high noise return inside a footprint can
move such a figure a long way. A cloud reduced only by a stride keeps original
records and is filtered as usual. Noise and Withheld points are not removed
before the voxel pass at load.
