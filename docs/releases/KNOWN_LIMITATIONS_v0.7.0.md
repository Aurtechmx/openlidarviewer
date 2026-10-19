# Known limitations: OpenLiDARViewer 0.7.0

Every entry below was reproduced against this release rather than carried
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
streaming source declares none here, and the fourteen codes whose meaning
differs between the legacy and extended tables (8 and 10 to 22) report both
readings rather than one guess.

## Class edits are not stored in a session file

A session file stores the class filter, not per-point classes. Lasso edits,
clears and auto-classify results are gone after a session is saved and
restored. Save session says so when the open scan carries class edits. To keep
them, export the scan as LAS at display resolution: a full-resolution export
re-reads the source file and refuses while class edits differ from it. The
recovery journal does not keep class edits either, and a streaming scan cannot
be reclassified, so Save session gives no warning there. Storing an edit log
keyed to the source file's SHA-256 is planned for v0.7.1.

## A Safari chunk failure does not reload the page by itself

When a lazy part of the app fails to load while the browser reports a
connection, the page reloads on its own only when the server confirms the file
is gone. Safari names no file in that error, so the cause cannot be checked and
the page is kept: a notice offers Retry, and a reload is offered only after a
failed retry or a second failure, through a dialog that says what reloading
would discard. A Safari tab left open across a new deploy therefore needs that
explicit reload to load the new version.

## Clear classifications holds for one session on a loaded scan

Clear classes sets every point to class 1 in the viewer. The working classes
are not saved in a session file, so reopening the scan brings back the file's
classes. Streaming COPC and EPT scans can be neither cleared nor
auto-classified: both actions need a fully loaded scan, and Edit classes stays
hidden on a streaming scan. Undo steps back over a clear, a restore and an
auto-classify. Restore earlier classes brings back the codes held before the
first clear or auto-classify, hand edits made before it included, so it can
differ from the file's codes. The kept codes take one byte per point once the
first clear or auto-classify runs, and the undo history drops its oldest steps
past 128 MB per scan or past 50 steps; the newest step is always kept.

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

## What was settled from v0.6.9, and what was not

Every v0.6.9 limitation was reproduced or cleared rather than carried forward.
Each one has a test that proves its status. Of the inherited set, the boundary share was fixed,
the stockpile split was closed, and two turned out not to reproduce: the
oriented extent is presented as a principal-axis estimate with its failure mode
named, and truncation is reported rather than hidden.

## The boundary share now measures the survey edge

It seeded a distance field at every cell that was not measured, so on a grid
thinned by a display stride nearly every measured cell sat beside a seed. It
seeds only from cells with no reachable data now, and distances travel through
the surveyed region, so neither depends on how densely the surface was sampled:
the test geometry reads about 33 per cent both at full decode and strided.

## An Area ring that is far from planar or touches itself reports no area

An Area polygon is judged in its own best-fit plane. A ring whose vertices
sit further from that plane than a quarter of the ring's radius (the largest
distance of a vertex from the ring's centre within that plane, so the verdict
does not change when the ring turns; about 14 degrees of tilt across the
ring), or whose edges touch at a vertex or
overlap, reports no area. The Measure panel, totals and every export omit the
area figures and state the reason; the perimeter is kept. A ring that is only
slightly off its plane, such as a roof facet picked with a little noise, still
reports its plane area, which is a lower bound on the draped surface.

## A lasso volume has one figure and a cross-check

The toast, the saved record, the CSV, GeoJSON and the report all read one
stockpile result built from the area-weighted grid. The cut-fill figure is
kept beside it under the `pointsample_*` columns as a cross-check; from
`olv.volume.stockpile@3` it is area-weighted too, and its estimator is named by
the record's `crossCheck.method`. A record saved before this change keeps its
method version and its stored figure; it is never recomputed. The lasso
footprint is the drawn lasso projected onto the horizontal plane at the
reference height; in an oblique view, points of a tall pile that project inside
the lasso but lie outside that plane footprint are left out.

## Volumes are area-weighted; gaps are interpolated and graded

The polygon Volume tool, the lasso volume and the stockpile breakdown all
integrate a horizontal grid: each cell holding points contributes its
footprint-clipped area times its median height, so a densely scanned area no
longer outweighs a sparse one. A cell without points inside the convex extent
of the covered cells takes a surface interpolated from its nearest covered
neighbours; one outside that extent is left out, never extrapolated. Every
volume states its interpolated and excluded shares. Above 25% interpolated the
figure is low-confidence; above 50% it is withheld with the reason. A sharp
step that falls inside one cell goes to the side holding more of the cell's
points, so a step between a dense and a sparse half still reads high by up to
one cell width times the step (56 m³ for a 50 m³ known answer in
`docs/validation/volume-known-answer-baseline.json`). The grid's cell size is
derived from the point spacing, so on an exact lattice the cell edges can fall
on lattice points; which cell such a point joins is then decided by
floating-point rounding, and a very small selection can move by a cell's worth
under translation.

## Two densities, each stating its basis

Analyse reads the resident gather and the Scan Report divides the declared count
by the sampled footprint. They differ by roughly the stride factor. Neither
hides its basis: on a strided load the report says in the value itself that it
is the declared count over the display-sample footprint. What is missing is one
record rather than two computations.

The Analyse ground density is the scaled ground-return count divided by the
area of the ground surface's covered cells (measured plus interpolated), so it
does not rise as the stride thins the sample. It still assumes the stride is
uniform across the scan.

## Hold-out statistics have their own limits

The hold-out builds its validation surface on a grid anchored at the minimum of
the ground returns, not at the delivered DTM's origin, so its cells can be
offset from the delivered grid by up to one cell. The hold-out RMSE describes
that surface, built with the same method and cell size, not the delivered cells
themselves.

The measured-cell reliability interval is a Wilson 95 % interval at a tolerance
equal to the hold-out RMSE. That tolerance is estimated from the same residuals,
and neighbouring residuals are spatially correlated, so the interval is narrower
than its nominal 95 %.

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
through Priority-Flood depression filling first. Only cells below their
spill level count as filled; a level plateau that the conditioning tilts by a
small epsilon so it can drain is not reported as a depression or as fill.
Either way, a cell with no
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
resolve. Other named refusals are `NO_DTM`, `INVALID_PROFILE`, `INVALID_WEIGHTS`
(a cost weight that is negative or not a finite number), `START_BLOCKED`,
`END_BLOCKED`, `NO_ROUTE`, `INSUFFICIENT_EVIDENCE`, `TOO_LARGE`,
`OBSTRUCTION_EVIDENCE_UNAVAILABLE` (an above-ground obstruction limit is set
and no aligned above-ground surface exists), `SURFACE_MISALIGNED` (the
above-ground surface does not cover the same cells as the terrain),
`SURFACE_STALE` (the above-ground surface was built with a different terrain
surface) and `INVALID_ROI` (a region-of-interest mask that does not fit the
grid), and the Lab refuses a preview or run whose terrain may have changed
since the profile was applied.

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

A move's grade is the largest of the Horn gradient along the heading at
either end cell and the move's own rise over its length, and its cross slope
the larger of the two end cells' sideways Horn components. The figure is
conservative: a cell-scale feature steeper than its neighbourhood gates the
moves across it even where the smoothed gradient is gentle.

The minimum terrain confidence blocks cells only under the `block` unknown
policy, where the run record marks it `evaluated`. Under `penalize` it changes
neither eligibility nor cost and only sets the reported share of route cells
below it, so the run record, run card, diagnostics CSV and export README mark
it `disclosed`.

The default evidence-gap policy is exploratory. Under it, a cell whose slope
or aspect used a substituted Horn neighbour (the grid's outer ring or beside a
NoData void) is allowed, and so is a cell with no above-ground return when the
obstruction limit is evaluated: such a cell passes the obstruction limit
because nothing was measured above it, not because it was shown to be clear.
Cross-slope, longitudinal grade and an evaluated ruggedness limit are then
marked `estimated`, not `evaluated`, when any route cell used a substituted
neighbour, and the obstruction limit is marked `estimated` when any route
cell has no above-ground return. The run card, run record and diagnostics CSV
report the route share of those cells and the policy applied. The conservative
policy blocks both kinds of cell instead, and with a ruggedness limit also any
cell whose ruggedness window holds a substituted-neighbour cell, which can
leave no route on a small or patchy grid.

The obstruction surface leaves out ASPRS noise (classes 7 and 18). When the
terrain run read a sample of the scan rather than every point, the obstruction
limit is marked `estimated` under either policy: thin returns such as posts or
wires can be missing from the sample.

Vehicle length is recorded in the profile and the diagnostics but not
enforced: eligibility uses width-only clearance, not full swept-body
collision. The independent Python oracle that cross-checks the routing core
was written inside this project, not taken from an external routing tool, so
the `TERRAIN-ACCESS` claim sits at E3.

## Registration is not exposed

Six modules implement alignment. No user path reaches them.

Compare elevation, which needs exactly two loaded layers, compares two epochs
that declare the same horizontal CRS in their supplied coordinates, with no
registration. Only a pair without a common declared CRS is aligned, with its
own planar fit that applies a yaw and a horizontal shift and not the fitted Z,
and only when the surface constrains the pose. That fit lives in the change
detection code and does not reach the six modules.

A half-wired alignment tool is worse than none, and the workflow it would need
is not built.

## Four legs block a merge; the iOS simulator is advisory

Chromium, Firefox, WebKit and Windows block a merge. The `e2e-firefox`,
`e2e-webkit` and `windows` jobs run in `ci.yml` and are listed in `ci-green`'s
`needs`, which the ruleset for `main` requires. Windows runs
Chromium. The iPhone-shaped WebKit project runs in the cross-browser smoke
workflow, which sits outside `ci-green` and which no ruleset requires. Touch
gestures run end to end on all three engines, and in the iPhone-shaped WebKit
project, as synthesized pointer events. Multi-touch on a real device is
unverified. An iOS simulator check drives real Mobile Safari on a pinned
simulator (iOS 26.5, iPhone 17e) and has passed end to end, including a
two-finger pinch. It runs when started by hand, and on a push that changes its
own workflow or scripts, and is advisory until 20
consecutive passes, counted by `scripts/ios-streak.mjs`.

## The two monoliths are still monoliths

`src/main.ts` is 4,256 lines, after the Save view snapshot
moved to its own lazy module, the Analyse panel's longitude and latitude
wiring moved to the mapper module, the Planetary Computer CRS record moved to
its own module and the view cube's wiring was condensed, and
`src/render/Viewer.ts` is 5,936, 287 lines below its v0.6.9 count of 6,223. Five getters collapsed to make room for a memory
accessor and a size-mode call, and the streamed draw cull then paid for its own
wiring by moving the pass onto the streaming renderer and collapsing two more
expressions. Making the loop request-driven then took another thirty-one out:
the activity deadlines, the reasons a frame is wanted and the scheduler left
together as one object, which is fewer lines here and one thing to reach for
there. The frame gained a decision while the file lost lines. The two-finger
pinch and pan now share one screen-space shift, which took another
thirty-six out. The figure view context moved into the export adapter, which
took twenty-one more. The measure click handling moved into the
measurement controller, which took twenty-eight more. The draw precision bound's model-view accessor took one line and a shorter doc comment gave back two. The terrain gather's up-axis rule moved to its own module, which took ten more. A shrink-only lint
fails the build when either passes its recorded baseline, so a raise is a hand
edit to `docs/validation/monolith-size-baseline.json` and always shows in the
diff.
Fan-out is 97 for the shell, 73 for the renderer and 29 for the Analyse panel,
across 1160 modules with no dependency cycles.

## The shell has little headroom

`npm run check:bundle` on the live build reports the index chunk at 663 KiB
of its 795 KiB ceiling and the Viewer chunk at 625 KiB of 716 KiB. Both
ceilings were lowered in this release, the index from 812 KiB to 795 KiB and
the Viewer from 740 KiB to 716 KiB. New work still goes behind a lazy seam
rather than being paid for by a raise.

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
depend on placement distance: the matrix the GPU receives stays within 5 µm of
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
re-quantised at 1 mm, or 0.001 of the source unit (1e-7 degree on a geographic
CRS), with the offset at the floor of the data minimum, and the provenance text
gives the reason. The scale widens on an axis whose extent would need more than
2.0e9 steps.

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
- LAS 1.4 export writes the coordinate system as OGC WKT only for the CRS
  whose definition OLV stores (checked against PROJ 9.8.1, EPSG v12.029):
  WGS 84, NAD83, NAD83(2011), NAD27 and ETRS89 UTM zones, GDA94 and GDA2020
  MGA zones, the national grids and geographic CRS of the built-in registry,
  and a scan's own valid WKT. Any other EPSG code, including State Plane
  codes, is refused for LAS 1.4 and can be written as LAS 1.2 with GeoTIFF
  keys. The vertical CRS goes into the WKT as a compound only for the vertical
  codes the LAS vertical keys already check (NAVD88, NGVD29, MSL, EGM, AHD,
  NAP, DHHN2016, EVRF and the others in that table, in the unit of the
  heights); a LAS 1.4 export with another vertical code is refused. Heights
  with a declared unit but no vertical datum are written to LAS 1.4 only when
  the unit is the one a WKT reader assumes (the horizontal unit, or metres
  under a geographic CRS); otherwise the export is refused, because no datum
  is invented. LAS 1.2 records either case as GeoTIFF keys.
- Assign EPSG accepts a geographic or projected code from the EPSG v12.029
  tables or the built-in registry. A code added to EPSG after v12.029 is
  refused as unknown until the tables are regenerated
  (`scripts/gen-epsg-crs-tables.mjs`). No datum transformation is applied by
  an assignment.
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
  needs neither. Classes above 31 are refused or wrapped as before. When a
  derived or cleared classification of a legacy file is written as LAS 1.4, a
  point whose class 8 or 12 is unchanged from the producer's code (kept when
  the first clear or auto-classify runs) is written as class 1 with the
  key-point or overlap flag; a class 8 or 12 with no producer record behind it
  is written unchanged, and the report lists it with a warning. A source whose
  point format is unknown is not translated, and its codes are written
  unchanged.
- A LAS 1.2 write cannot keep every acquisition field. Scan angles are stored
  as whole degrees from -90 to 90 and there is no scanner channel, so a LAS 1.4
  file with an angle that rounds beyond 90 degrees or a nonzero channel is
  refused until the opt-in for those two losses is ticked. Angles inside the
  range are rounded to a whole degree, with halves rounding away from zero (-1.5
  is written as -2, where it was -1), and the file's text area records that
  without asking. The text
  area is the only place the file itself records a conversion: a reader that
  ignores it sees nothing, and a format other than LAS has no such record.
- The point-cloud converter writes the source coordinates in their stored
  axis order. It does not infer an up axis from the scan's shape, and the
  viewer's display orientation does not change an exported coordinate. A
  local PLY, OBJ or glTF model with no CRS is rotated from Y-up to Z-up,
  (x, y, z) written as (x, -z, y), only when "Rotate a local Y-up model to
  Z-up" is ticked; the report and the file's conversion record say so. That
  option is refused when the export keeps or assigns a CRS and for a format
  that is Z-up by specification. A glTF source, Y-up by specification, is
  refused under a CRS until its axes are reconciled: set the scan to Local,
  export with the rotation, then assign the CRS to that file. A PLY or OBJ
  under a CRS is assumed to store easting, northing and height in X, Y and
  Z; OLV cannot tell from a PLY or OBJ file that its axes are otherwise.
- Terrain analysis, and the DTM, contours, map sheet and terrain exports
  built from it, take the up axis from metadata by the same rule. A PLY or
  OBJ under a CRS (the file's, or one assigned in the app) is analysed as
  stored and is never rotated because of its shape. A glTF or GLB under a CRS
  is not analysed, and the Analyse panel says how to reconcile its axes. Only
  a PLY, OBJ or glTF model with no CRS, or one set to Local, has its up axis
  detected from the point layout; the panel states the detected axis and,
  for Y-up, that the points were rotated to Z-up as (x, -z, y). A detected
  Y-up model is not analysed together with Z-up layers. The detected axis is
  shown in the panel only and is not recorded in the exported provenance.
- Measurement, navigation, the Layer Health card and the measurement and map
  exports (CSV, GeoJSON, KML, integrity report, PDF) read a layer's up axis by
  the same rule as terrain and conversion. A PLY or OBJ under a CRS is
  measured and navigated Z-up; with no CRS it is read Y-up, and the Up axis
  row in Layer Health says so. Measurement does not detect the axis from the
  point layout, so a local Z-up PLY measures along Y until a CRS is assigned.
  A measurement on a glTF or GLB under a CRS prints the reason in place of any
  height, grade, profile, box or volume figure; its CSV and GeoJSON exports are
  refused and the PDF leaves it out with the reason. Assigning, replacing or
  clearing a CRS re-reads measurements already taken and re-cuts their
  profiles and volumes. Height colouring, the elevation scale and the colour
  legend follow the same axis. A reopened session re-cuts a profile or volume
  that was cut along another axis; when the layer's points are not there to
  re-cut it, the chart or cut and fill is withheld with the reason until they
  are. The session file keeps the format's up axis for matching and records
  the resolved axis beside it. A CRS change that moves a layer's axis clears an
  active elevation filter whose window no longer matches the scene's heights,
  and says so.
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
are not in one frame is refused rather than exported. Each measurement is
written with the coordinate system, unit scales, up axis and source digest of
the scan it was taken on, whichever scan is active. Measurements on scans whose
coordinate frames differ (a different CRS, linear or vertical unit, vertical
datum or up axis) are refused together, with a message naming the scans and
their CRS ("Measurements on A (EPSG:32612) and B (EPSG:32613) use different
coordinate frames; export one scan's measurements at a time"). Nothing is
converted between frames; export each scan's measurements on its own. A session saved with one scan and
restored with two open is placed through the scan it matches; when that scan
cannot be identified, close the other scans and export again.

The release rule for every measurement output is: when a measurement's owning
scan, its frame or its permissions cannot be resolved, the result is withheld;
an output never borrows the active scan's units, frame, permissions,
classification epoch or dataset identity. The integrity report names the scan
its measurements were taken on and records that scan's classification epoch; a
report spanning two scans is refused, because it holds one dataset identity and
one epoch. The PDF report, the site KML and the saved findings describe the
active scan and hold only the measurements it owns; a measurement taken on
another scan, on a closed scan, or with no record of its scan while several
are open is left out, and the PDF and KML state how many were withheld and why
(the findings list says so when they are added). Make the owning scan active to
report its measurements. A frame's permissions come from one place for the
live tool and every export: a geographic, Web Mercator or geocentric frame
refuses lengths, areas, grades and volumes, and a geocentric or
depth-positive-down frame also refuses heights, because its Z axis is not a
local vertical. These reports carry lengths and areas, not coordinates. The
site KML is written only while one scan is open.

The tabular exports round to three decimals. A value of 0.0005 and above keeps
three decimals; a smaller nonzero value keeps three significant digits, down to
values far below any physical length, so a nonzero measurement is not written
as 0.

## Truncated files and unknown units

A LAS file whose body ends before its declared records opens with the records
it holds and reads as partial coverage: "Truncated: N of M points read".
Truncation is recorded for uncompressed LAS only; a truncated LAZ is not marked partial. When the horizontal unit is
unknown, measurement rows, the measure hint, the profile chart, summary and PDF,
and the Profile Workbench state the unit is unverified.
A projected EPSG code that arrives without a unit (no GeoTIFF unit key, a WKT
with no UNIT, or an EPT `srs` with codes only) takes its unit from the curated
CRS registry or a list of metre families checked against the EPSG dataset
(UTM on WGS 84, NAD83, NAD83(2011), NAD83(CSRS), NAD27 and ETRS89; GDA94 and
GDA2020 MGA; ETRS89 LAEA and LCC Europe; SWEREF99; DHDN Gauss-Kruger; MGI
Austria; Web Mercator; British National Grid; RD New; Lambert-93; NZTM); any
other code is treated as unknown, not as metres. A vertical EPSG code fixes the height unit when no
vertical unit is declared. A declared vertical unit wins over the code's own
(NAVD88 with US survey feet reads as NAVD88 height in ftUS, as in GDAL), and a
declared vertical unit code the app cannot read leaves the height unit unknown.
A WKT vertical unit is read by its conversion factor, as PROJ reads it: a
centimetre, millimetre, kilometre or yard, or a unit with any other name,
converts by the factor the file states. A unit name that disagrees with its
factor (UNIT["metre",0.3048]) is converted by the factor and the conflict is
noted. A vertical unit that is not a length (an angular unit), or whose factor
is missing, zero, negative or not finite, is invalid: no height is derived from
it, and it never falls back to the vertical code's unit or the horizontal unit.
GeoKey vertical unit codes other than metre, foot and US survey foot are not
read and count as invalid. A projected CRS unit is read the same way: a
centimetre, kilometre or yard grid converts by its declared factor in Measure,
the exports and the scan reports. LAS 1.2 output refuses such a unit, LAS 1.4
output keeps the source WKT that states it, and the contour DXF, contour SVG
and map sheet label its coordinates as unitless source units rather than
naming the unit.

## Depth references, geocentric frames and Web Mercator are refused, not converted

Terrain analysis, contours, DEM export, Flow Pulse, Terrain Access and change
detection refuse a depth-positive-down vertical reference on either epoch
("Depth-positive-down vertical reference; elevation workflows refuse it until
normalisation is supported."). Depths are not negated into heights. A
geocentric CRS (EPSG:4978 and similar) is refused by every metric, terrain and
elevation workflow; it is not converted to geographic or projected
coordinates. Web Mercator is treated as grid units only: horizontal lengths,
areas, grades, slopes and volumes are withheld and heights are kept; no
scale-factor correction is applied. A geocentric code outside the built-in
list is recognised only from its WKT or GeoTIFF model type. A WKT
engineering CRS (ENGCRS, LOCAL_CS) is not yet classified as local and keeps
its current handling. Reproject refuses a geocentric source or target, because
it maps only horizontal X and Y.

## Exports carry the geographic refusal, not the endpoint grade

On a geographic CRS the PDF report, profile sheet, CSV, GeoJSON, KML, findings,
integrity report, chain total and drawn labels withhold every figure but
heights, as the Measure panel does. The per-measurement support grade does not
travel with them: a measurement with an endpoint in empty space reads
Unverified in the panel and is still published as a number. On a compound CRS
whose height unit differs from its horizontal unit, the panel, the exports and
the PDF all compute 3D lengths, grades and tilted areas with each axis in its
own unit.

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

A declared vertical unit that cannot be read is never borrowed from the
horizontal unit. Measure, the trust grade, chain totals, the lasso volume, the
PDF report, CSV, GeoJSON, KML, findings and the integrity report withhold every
height and every figure built on one (3D length, tilted area, angle, grade,
profile, box and volume) with "height unit could not be interpreted", and keep
only plan figures: the horizontal distance of a height or profile, the run of a
grade, the plan area of an area, the width and depth of a box and the footprint
of a volume. Measure withholds the whole row, including those plan figures,
which only the exports carry. Coordinates are unchanged, and no figure is shown
in raw source units instead.

## Imperial readouts are in international feet

The imperial display converts through metres to the international foot
(0.3048 m) and labels it "ft", including on a scan whose CRS unit is the US
survey foot. The conversion is correct, but the figure is not the survey-foot
coordinate difference: 5,000 US survey feet read as 5000.01 ft. There is no
"ftUS" display unit; read the metric figure, or the source coordinates, when
the survey-foot value itself is needed.

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
code. A source vertical unit that cannot be read, or one that is not metre,
foot or US survey foot (a centimetre or yard height, for example), refuses the
LAS conversion with the reason, because no LAS vertical unit key can state it.

The DTM and DSM GeoTIFFs of a source whose heights are in a valid unit other
than metre, foot or US survey foot keep those heights in the source unit with
no vertical CRS and no band unit, and the DEM package README reads the
elevation unit as unknown.

## One streamed source at a time

Many static layers can be open at once. A streamed COPC, EPT or 3D Tiles
tileset source is open one at a time: opening one closes the stream already
open and every static layer, and opening a static file while a stream is open
closes the stream. A local LAS or LAZ file too heavy for memory streams from
disk. It replaces an open stream, with that stream's class legend counts, scan
report and confidence, and keeps the static layers open.

## Large E57 files are refused; spherical-only E57 scans are skipped

An E57 file is decoded whole in memory, and the plan reserves two copies of the
file plus a fixed allowance before any point is decoded, under a decode ceiling
of 2,000,000,000 bytes. An E57 of about 900 MB or more therefore cannot be
opened on any device: it is refused before its points are read, with the reason
stated. A smaller E57 that does not fit the device's memory opens as a strided
sample, and the scan report says so. Opening multi-gigabyte E57 files (for
example 4 GB) is not supported in this release; convert them to LAS/LAZ or COPC
to open them.

A scan that stores only spherical coordinates (range, azimuth, elevation) and no
Cartesian X/Y/Z is skipped with a warning that names it and its record count. A
file whose scans are all spherical-only opens no points.

## glTF and PLY files past the loader's limits are refused

A glTF or GLB is refused when its node graph reaches the same node twice,
when its node hierarchy is deeper than 256 levels, or when opening it would
emit more vertices than the loader's cap. It is also refused before parsing
when an accessor with no bufferView, or a sparse accessor, would be
zero-filled to more than 96 MB in total, or when an accessor count is not a
non-negative whole number. A PLY is
refused when an element declares records but no properties, or when its
header is longer than 64 KiB.

## Draco-compressed glTF and GLB files do not open

The Draco mesh decoder is not bundled with the viewer, and the viewer does not
download one. A glTF or GLB that lists KHR_draco_mesh_compression, as used or
as required, is refused with a message that says so, even when the file carries
an uncompressed fallback. Re-export the model without Draco compression, or as
PLY or OBJ. The glTF loader's own library loader would otherwise fetch a
decoder from a public CDN and evaluate it.

## Limits on E57, PCD, EPT, COPC and remote URLs

These limits are fixed numbers. A file past one is refused, or its hierarchy is
read only up to it, with the limit named.

- E57: an XML section above 64 MiB, nested deeper than 256 levels, or holding
  more than 200,000 elements or 400,000 attributes. The E57 files checked here
  hold 8 to 60 elements; a single file of about 8,000 scans fits.
- PCD: a SIZE or COUNT entry that is not a positive whole number for a declared
  field, a binary header with fewer SIZE entries than fields, and a binary
  body shorter than POINTS records. An ascii body with a POINTS count above its
  rows opens with the rows present.
- EPT: a hierarchy of more than 2,000,000 nodes (the COPC ceiling) is read up
  to that point, the scene is missing the rest, and the open reports it. A
  manifest schema of more than 64 attributes is refused.
- COPC: a hierarchy entry for a data node larger than 128 MiB is dropped.
- Remote URLs (COPC, EPT, 3D Tiles): host names that are bare single labels
  (`intranet`), end in a private-network suffix (`.local`, `.internal`, `.lan`,
  `.home.arpa`, `.intranet`, `.corp`, `.private`, `.localdomain`), or are
  loopback, private, link-local, shared, multicast or reserved IPv4 or IPv6
  literals are refused. The check reads the text of the host. A public name
  whose DNS record points at a private address (for example `127.0.0.1.nip.io`)
  is not refused, because the address is not known before the request.

## E57 intensity is normalised; a missing channel is dropped

E57 intensity is stored on a 0–65535 scale per scan. A scan that declares
`intensityLimits` is normalised over them. With no usable limits, an Integer or
ScaledInteger intensity field is normalised over the minimum and maximum its
prototype declares. A Float field with no limits is scaled by 65535 when its
largest valid value is at most 1; otherwise its values are kept raw, rounded and
clamped to 0–65535. The source values are not retained, and the result is not
calibrated reflectance. Colour or intensity a file
flags invalid is masked per point: the point keeps its position, the value is
drawn in the neutral grey, left out of intensity ranges, the colour balance and
voxel means, and written as an empty CSV field or `nan` in XYZ and ASC. PLY and
OBJ omit colour, and LAS omits colour and intensity, for the whole file when any
exported point is flagged, because those formats have no null value; the
conversion record states the count. A channel some merged scans lack is still
dropped from the merged cloud and reported in the load warnings rather than
masked per point. Raw intensity retention is planned.

## No cross-CRS reprojection

Unchanged from prior releases. Scans must share a coordinate reference system to
be compared, and the viewer refuses rather than approximating.

## Measurement GeoJSON heights and KML altitude

OLV has no geoid model, so it cannot convert a sea-level (orthometric) height
to a WGS 84 ellipsoidal height. The measurement GeoJSON therefore writes 2D
positions unless the scan's heights are already WGS 84 ellipsoidal heights in
metres (EPSG:4979) on an unshifted WGS 84 datum. Source elevations travel
unconverted in each feature's `elevations_source`, with their datum and unit in
the collection's `vertical_reference`; a reader who needs ellipsoidal heights
must apply a geoid model (for NAVD88, GEOID18) themselves.

The Site KML writes `absolute` altitude only for an EGM96 geoid height in
metres, the surface KML defines `absolute` against. A NAVD88, EGM2008 or other
metric mean-sea-level height is not converted to EGM96, so it is clamped to
ground instead of being written as if it were. The source elevation, unit and
datum stay in each feature's description, and the document note states why. No
geoid conversion is applied by OLV.

A measurement with no shape in longitude and latitude (a vertical wall area, a
purely vertical distance) is exported with no geometry and a stated reason.

## Longitude and latitude exports apply no datum transformation

The site KML, the scan-area KML, the RFC 7946 contour GeoJSON and the accepted
building-footprint GeoJSON write longitude and latitude. OLV computes them
without a datum transformation, so the export depends on the scan's datum:

- WGS 84 (EPSG:4326, 4979, WGS 84 / UTM and Web Mercator) is exported
  unchanged.
- NAD83 (EPSG:4269, 6318, NAD83 / UTM 26901 to 26923, NAD83(2011) / UTM 6330
  to 6348, and CONUS Albers 5070) is exported as if it were WGS 84, and every
  file says the positions are approximate, about 1 to 2 m. NAD83(2011) and
  WGS 84 at epoch 2026.75 differ by 0.9 to 1.6 m across the conterminous
  United States (0.89 m at Miami, 1.61 m at Seattle).
- ETRS89, RGF93, GDA94, GDA2020 and NZGD2000, geographic or projected, are also
  exported as if they were WGS 84, and every file names the datum and the size
  of the difference. Each datum is fixed to its plate at a reference epoch, so
  the difference grows every year. At epoch 2026.75 PROJ gives 0.93 m for
  ETRS89 (RGF93 follows it), 0.40 m for GDA2020 and 1.97 m for GDA94. NZGD2000
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
49 N, and at most 2.98 degrees at 84 N in a standard 6-degree zone. The
widened zones 32V and 31X, 33X, 35X and 37X reach about 6 degrees (5.97
degrees at 9 E, 84 N in zone 33). The arrow and the rose's top face read
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

## The draw precision bound is a diagnostic for one view

The scan report's "Draw precision bound" row bounds the error of the eye-space
position of each point centre, `modelView * vec4(p, 1.0)` in binary32, under
round-to-nearest arithmetic, for the camera at the moment the report was
generated. It does not cover projection, the divide by w, the point sprite
size, depth or survey accuracy, and it never stops a draw. It is computed for
the active static cloud only; streaming scans and the Observatory overlay are
not evaluated. The storage error is a worst-case figure from the Float32
buffer, because binary64 source positions are not kept after load. With no
established linear unit, or a vertical unit different from the horizontal
one, the bound is shown in source units and not graded. The mapping from
OLV's shaders to the bounded expression was read from three.js 0.186.0 and
pinned by content against 0.186.1 (`docs/architecture/draw-precision-contract.md`);
any other three.js version
fails `tests/drawPrecisionShaderContract.test.ts` until it is read again.

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

## Change detection does not estimate a vertical offset between epochs

Epoch alignment never applies a vertical shift, and two epochs that declare one
horizontal CRS are not aligned at all. A systematic vertical offset between
the two epochs, such as a datum or geoid difference or a sensor bias, is not
estimated or removed, so it appears as change over the whole compared area. The
change result in the panel says so. Check the difference over ground known to
be stable: a non-zero mean there is a bias, not change.

The level of detection is propagated as 1.96·√(σz_before² + σz_after² + σreg²)
(Wheaton et al. 2010, uniform form). Each σz is that epoch's random-split
hold-out RMSEz over the whole surface: a point-vs-surface residual with the
ground re-classified from the training points only, and it includes the
epoch's own bias. It is not checkpoint accuracy and not a per-cell DEM
uncertainty. The 95 % level holds only if the errors are normal, independent
and unbiased. σreg must be the vertical registration error measured on stable
reference areas; the app has no stable-area assessment yet, so σreg is
unavailable. When a local-frame alignment runs, its residuals (at the applied
pose, and the solver's own fit) are reported but are fit statistics and are
not used as σreg. With
σreg missing and both σz measured, the threshold is
max(1.96·√(σz_before² + σz_after²), 0.1 m) and is labelled "incomplete — lower
bound"; significance counts and detectable volumes carry the same label, and the
raw net volume is unthresholded. Only when no term is known does it fall back to
a fixed 0.1 m labelled "assumed, not measured". Two DTMs are differenced only
when they share a grid to float64 representation; an offset grid is refused,
not resampled. The difference raster (.asc) has no header field for the
threshold, so the level of detection travels in the panel text, not the file.

A cell is differenced only where both DTMs hold a measured height, meaning
ground returns fall in that cell in both epochs. Cells where either surface is
interpolated, including the fill the DTM build extends past an epoch's own
footprint, are left out, and the result states how many cells and what share
of the cells with a height in both surfaces that was. The grid carries no
flag that separates a bracketed interpolation from an extrapolation, so
neither is used. So that cells between returns are not mostly fill, the shared
grid's cell is at least twice the mean point spacing of the sparser epoch,
estimated from all its points; a finer extent-based cell is kept only when the
data are that dense. Where ground returns are much sparser than all returns,
under dense vegetation, cells without a ground return are still left out.

## Epochs in one CRS are not registered; local-frame alignment needs informative relief

Two epochs that declare the same horizontal CRS are compared in their supplied
coordinates. No registration is estimated or applied, and the panel and the
registration record say so. A rigid fit cannot separate a horizontal shift
along a slope from a real change in height: on two identical lattices on a 0.5
slope, a +1 m uplift was read as a 0.40 m x shift and a mean change of 0.800 m.
A real horizontal misregistration between such epochs is therefore not
corrected and appears as change. A shared declared CRS is not an accuracy
statement, and registration uncertainty is not quantified, so the level of
detection is labelled incomplete, a lower bound.

Epochs without a common declared CRS are aligned only when the surface
constrains yaw, x, y and z independently. Before any damping, every iteration
tests the point-to-plane information matrix of those four terms (the yaw row
scaled by the RMS lever arm): its smallest-to-largest eigenvalue ratio and the
information left on each horizontal direction after the other terms are
eliminated must both reach 0.01. A plane, flat or sloped, and a single ridge are
refused as unobservable, and the epochs are compared as supplied. Gentle relief
can be refused too: a synthetic surface with RMS slopes of 14 % and 11 % along
its two axes was. An accepted fit pairs
points only within three mean point spacings of the before epoch's sample,
starts from a centroid placement, and is withheld when under half of the
sampled after points have a partner or the fit residual exceeds 0.75 spacings.
It applies yaw and x/y, not the fitted Z. Non-uniform real change on the
compared relief can still pull the fit. The fitting residual and the residual
at the applied pose are reported separately; neither is a registration
uncertainty, and a small fitting residual does not validate the alignment.

## The CRS override fingerprint samples a source, it does not hash it

A remembered CRS override records a content fingerprint of its source so that
two files agreeing on name, point count, extent and position are still told
apart. The fingerprint is taken at open from a few parts of the source: the
first and last 64 KiB of a local or fetched file (with its size), the COPC
header and VLRs with the root hierarchy page, or the EPT manifest with the root
hierarchy document. Of each part it hashes at most the first 64 KiB, and it
records each part's full length. Two sources whose parts have the same lengths
and differ only after the first 64 KiB of a part, or only in the unsampled
interior of a file, get the same fingerprint, so the override still applies to
the edited source. Fingerprints taken different ways are not compared. Where
Web Crypto is unavailable, as in an insecure context, or a read fails, no
fingerprint is taken and the override matches on name, point count, extent and
position alone, as do records saved without one.

## Orthographic PNG transparency marks pixels with no drawn point

The georeferenced orthographic PNG makes a pixel transparent when no drawn
point covers it, not when the survey has no data there. Gaps between the points
of a sparse or thinned cloud are therefore transparent even inside the scanned
area, and a larger point size closes them. A pixel counts as covered at 50 %
coverage or more; below that it is transparent, so the thin antialiased edge of
a point can be dropped. To find coverage the export renders the view twice,
once on a black and once on a white background, and both frames are drawn on
the live canvas, so the view flashes black and white while the export runs.

## Held session work is restored only within the same page

Session work kept because its scan was not open at import is held in memory.
It is placed when the matching scan is opened later in the same page; reloading
or closing the page loses the held copy, although a session saved before that
writes it back. Work that names a scan still not open, or a source that is open
twice and so cannot be matched to one scan, stays held. In a session with no
project frame, work marked as placed in a project frame is reported as not
restored. Opening a streamed COPC or EPT scan does not trigger the restore;
only a static scan open does.
