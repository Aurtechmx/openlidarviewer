# Terrain Flow Pulse

Terrain Flow Pulse routes a conceptual surface-flow pulse over an OLV DTM.
Given a terrain surface and a routing model, it answers where topography
sends water from a chosen cell, where contributing area accumulates, and
where the surface holds a sink or an outlet. The code lives under
`src/simulation/flowPulse/`; the shared simulation record and input-basis
types live in `src/simulation/`.

Every result is SIMULATED. It describes the declared model applied to the
declared terrain product. It does not create new measured evidence and does
not predict a real-world outcome.

## What this is not

Terrain Flow Pulse is not rainfall-runoff modelling, hydraulic flood
modelling, storm-sewer modelling, infiltration modelling, soil-saturation
modelling, channel hydraulics, flood-depth prediction or time-to-peak
prediction. The routing takes no rainfall as input and animates no
physically timed water velocity. Flow accumulation counts cells that drain
through a cell, itself included, never water, and a pulse is a visual
traversal of an already-computed topographic routing graph, not a simulated
flood wave. The Lab's rainfall control adds one separate, labelled estimate
on top of the routing, the rational-method peak flow described under
Rainfall estimate below; it changes nothing in the routing, the run record
or its digests. See `docs/validation/claim-register.yaml` for the claims
`TERRAIN-FLOW-PULSE` and `TERRAIN-FLOW-DEPRESSION-INVENTORY`, which state
the exact approved and prohibited claim language.

## DTM basis

Routing reads the canonical OLV DTM through `dtmFlowGrid.ts`, never a second
terrain reconstruction. `terrainDtmToFlowGrid` converts the analysed
`DtmGrid` into a `FlowGrid`: elevations, a per-cell valid mask, and the two
per-axis cell lengths in metres, named `cellMetresX` and `cellMetresY`. A
cell with no ground return is absent from the grid, not an elevation of
zero, so a survey gap reads as a wall rather than as a low point flow could
drain into.

The grid carries no coordinate reference system and no world origin. It
knows physical distance and nothing else. That is why the D8 model can rank
a diagonal against a cardinal neighbour correctly on an anisotropic grid
without knowing a geographic frame's east-west scaling factor, and it is why
an export of the routed field (see Exports, below) states its rasters are in
a local frame unless the caller supplies a real one.

Every run declares a `SimulationInputBasis`, defined in
`src/simulation/simulationInputBasis.ts`: how much of the source the terrain
behind it saw (full, resident-only, or sampled), whether Withheld points
were excluded (a tristate; null means undeclared, not "no"), whether the
horizontal scale resolved, and how many cells are measured versus
interpolated. The function `basisLimitations()` turns that record into the
sentences a reader sees. A resident-streamed or sampled terrain is named as
such rather than presented as if it were the whole source.

## Raw vs conditioned

Two terrain-conditioning modes exist, declared explicitly per run through
`FlowConditioning` in `flowPulseRunner.ts`.

Raw mode routes the DTM as delivered. A cell with no lower neighbour keeps
its flow as a sink. Real depressions, such as a quarry sump, a kettle hole,
or a borrow pit, are real terrain, so raw mode is often the most honest
inspection mode: nothing is silently filled.

Conditioned mode (`priority-flood`) routes over a second, conditioned
surface built by `priorityFlood()`. The canonical DTM is never modified; the
run reports how many cells were raised, the deepest rise, and, through the
depression inventory described below, which cells that rise touched. The
result is called a conditioned drainage surface, never corrected terrain.

### Priority-Flood

`src/simulation/flowPulse/priorityFlood.ts` implements Barnes, Lehman and
Mulla (2014). It floods inward from the edge of the mapped surface, always
advancing from the lowest cell reached so far, and raises a cell reached
from below to the level it was reached at: the elevation water would have to
reach to spill out of the depression holding it. One pass, a binary
min-heap ordered by that spill level then by insertion order, so cells at
one level are taken first in, first out and two cells reached at the same
level resolve the same way on every run, runs in O(n log n).

Each filled cell is raised a small amount above the cell it was reached
from, turning what would otherwise be a plateau (no descent, so D8 would
report it flat) into a surface with a deterministic path out. By default the
rise is one Float64 step (`fillEpsilon: 'float64-step'`), the smallest the
conditioned surface can hold, as Barnes, Lehman and Mulla specify with
`nextafter`. The conditioned surface is a Float64 copy of the Float32 DTM,
and that is what D8 routes on. The rises add up along a flat, one per cell,
so the far end of a long flat stands highest. On a Float32 surface one step
is 6.1e-5 m at 600 m, so a few hundred cells would climb past an exit only a
centimetre above the true spill point and D8 would drain the far end of the
flat over that exit. A Float64 step is 2^-29 of a Float32 step at the
same height, so a chain of fewer than 2^29 cells stays below the next height
the Float32 DTM can hold, and no exit above the spill level can be
overtaken. The flood itself is ordered by the spill level without the rise,
so the order it advances in never depends on how far a chain has climbed,
and the spill levels match those of a flood with no rise at all.

A fixed rise in the vertical unit can still be asked for. It adds up the
same way, and on a long flat it can carry the far end above a nearby exit
that is only slightly higher than the true spill point, so D8 may then
drain part of the flat over that exit; the spill levels and fill figures
stay correct. The epsilon is not fill. Following Barnes, Lehman and Mulla, a
cell counts as filled only when its original height is strictly below the
spill level it was reached from; a cell level with that spill level (a flat)
rises by the epsilon alone and is counted separately as
`flatCellsResolved`. The `cellsRaised`, `maxFillDepth` and `fillDepthSum`
figures cover filled cells only, and a fill depth is the spill level minus
the original height, never inflated by the epsilon chain across a filled
depression. A rise too small to change the value it is added to, such as a
fixed rise below the Float64 spacing at that height, leaves the cell where
it was; every such absorption is counted in `epsilonAbsorbed` rather than
assumed to have applied.

D8 treats NoData as a wall, and conditioning is seeded consistently with
that. By default, when `fillNoData` is set to `wall`, the flood is seeded at
the edge of the mapped surface: the cells on the grid's boundary and the
cells beside NoData that reaches it, which lies outside the survey. A survey
hole the data encloses is never read as a drainage exit. A region NoData
fully encloses has no route to that edge and keeps its elevations, counted in `cellsUnreachable` rather than silently
left out of the total. The declared alternative, `fillNoData: outlet`
(registered as `olv.simulation.terrain-flow.priority-flood.gap-outlet`),
also seeds every cell touching a gap. That reading suits a gap that is open
water a LiDAR survey left empty, and it is never the default, because over a
genuine survey hole it invents an exit that was never surveyed.

## D8 routing

`src/simulation/flowPulse/d8Flow.ts` implements O'Callaghan and Mark (1984).
For each valid cell, the eight neighbours are inspected in a fixed order:
east, northeast, north, northwest, west, southwest, south, southeast. The
cell drains to whichever neighbour offers the strictly greatest drop per
metre of physical distance, with ties broken by that fixed order rather than
by array layout. The diagonal distance is computed as
`hypot(dx * cellMetresX, dy * cellMetresY)`, never as `sqrt(2) * cellSize`,
so an anisotropic grid, including a geographic frame where each axis uses
the WGS84 degree length at the grid latitude (the east-west one is about the
cosine of latitude times the north-south one), ranks a diagonal against a
cardinal neighbour by real geometry.

A cell with no downslope neighbour is a sink, a flat or an outlet, and raw
mode reports which one rather than choosing for it. A sink has every neighbour
strictly higher or invalid, and flow stops. A flat has no neighbour lower
but at least one equal, and is reported unresolved rather than given an
arbitrary direction from iteration order. An outlet sits on the edge of the
mapped surface, on the grid boundary or beside NoData outside the survey,
with nowhere lower to go on it, so flow leaves the analysed extent. An
outlet is always where flow leaves the mapped surface. A stream that enters
the survey appears instead as a channel that starts at the edge: its
upstream cells lie outside the data, so its area is a lower bound (see Edge
contamination below).

A cell with no elevation is neither routed nor routed into: flow does not
cross NoData.

## Flat handling

This is the one place raw mode is deliberately incomplete rather than
approximate. Draining a flat by array order would let iteration order
masquerade as topography, so `d8Flow` reports a flat cell as unresolved and
stops there. The only way a flat resolves to a direction in this release is
conditioning: Priority-Flood's optional epsilon breaks a filled plateau into
a surface with real descent, and a run over that surface routes every cell
the epsilon reached. The fixture
`validation/field-simulation/fixtures/flat-plateau-outlet.json`, TF-5 in the
validation set, pins this behaviour: a flat interior only routes where a
cell has direct or diagonal line of sight to the one lower notch in its rim,
and the rest of the plateau reports flat.

## Accumulation

`src/simulation/flowPulse/flowAccumulation.ts` computes, for every cell, the
number of cells that drain through it, itself included, by draining cells in
dependency order (a topological sort over the D8 graph) rather than by
walking downstream from every cell, which would revisit the same trunk cell
once per contributing cell. Contributing area in square metres is a
separate step, the function `contributingAreaM2()`, gated on the caller's
declaration that the horizontal scale is known. When it is not known, the
function returns null and the run reports cell counts only. Accumulation is
never labelled discharge.

## Depression inventory

Section 10.10 of the implementation prompt asks for a depression inventory,
and `src/simulation/flowPulse/depressionInventory.ts` catalogues sinks and
filled depressions individually rather than folding them into one grid-wide
total. A single raised-cell count cannot distinguish one deep borrow pit
from fifty shallow single-cell potholes that happen to sum to the same
count.

Raw mode lists every D8 sink as its own one-cell candidate, a pinpoint
rather than a measured extent. Finding the true extent of a depression is
exactly what Priority-Flood computes, so raw mode makes no claim about one.

Conditioned mode groups the cells Priority-Flood filled, those whose
original height is strictly below their spill level, into 8-connected
depressions, the same adjacency D8 routes over. A level plateau lifted only
by the epsilon is not a depression and is not listed. For each depression it
reports: cell count; area in square metres when the horizontal scale is
resolved, cell count only otherwise; the deepest fill within that
depression, its spill level minus the cell's original height; and its
outlet elevation, the lowest raw elevation among the valid, unfilled cells
touching it, where the flood entered before finding higher ground.

Sink count is always read off the raw, unconditioned surface, independent of
which surface the run actually routed over. Conditioning removes most
interior sinks by construction, so a sink count read off the conditioned
routing would mostly report that conditioning worked rather than how many
depressions the raw terrain held.

Ordering is deterministic: depressions rank by largest cell count first.
Single-cell raw candidates, which carry no size to rank by, order by grid
position instead. Both tie-break on the lowest member cell index, never on
component-discovery order.

The method is registered as `olv.simulation.terrain-flow.depression-inventory`,
version 2. Do not call every single-cell sink a natural pond. A one-cell raw
candidate is a pinpoint, and even a catalogued conditioned depression is a
topographic computation, not a field-surveyed pond.

## Click-to-pulse and catchment

`pulseFrom()` traces the already-computed downstream path from a start cell
to a sink or an outlet, using `traceDownstream` in `d8Flow.ts`, with a
visited guard. Every D8 step is strictly downhill, so the receiver graph has
no cycle; the guard is a defence against a corrupted field, not a case the
routing produces.
Animation speed, where a caller draws one, is presentation only. The path
itself carries the scientific identity.

`catchmentFrom()` walks the D8 receiver graph backwards from a selected
outlet, using `catchmentOf` in `flowAccumulation.ts`, and returns every cell
that drains through it. Donor lists are built once per query rather than
walking every cell's receiver on each call.

## Rainfall estimate (rational method)

The Lab's rainfall control sets a rainfall intensity i in mm/h (1 to 200,
default 25) and a runoff coefficient C (0.05 to 1). For a selected outlet,
and for the end of a traced path, the Lab shows the steady-state peak flow
by the rational method (Kuichling 1889),

    Q = C · i · A,

with i converted to m/s by dividing by 3.6e6 and A the cell's contributing
area in m², its upstream cell count times the cell area. Q is shown in L/s
below 1,000 L/s and in m³/s from there up. In HEC-22's SI form,
Q = C·I·A / 360 with I in mm/h and A in hectares; the two agree, and
`tests/rationalDischarge.test.ts` pins that. The code is
`src/simulation/flowPulse/rationalDischarge.ts`, registered as
`olv.simulation.terrain-flow.rational-peak`, version 1.

The ground-cover presets are midpoints of published ranges, never site
measurements: woodland, mature and in good condition, 0.02 to 0.15 (Schwab,
Fangmeier, Elliot and Frevert 1993, soil group B, 25 to 200 mm/h); grass on
sandy soil at 2 to 7 % slope, 0.10 to 0.15; grass on heavy soil at 2 to 7 %
slope, 0.18 to 0.22 (the default); unimproved ground, 0.10 to 0.30; and
asphalt paving, 0.70 to 0.95. The last four are from FHWA HEC-22, Urban
Drainage Design Manual, 3rd edition (FHWA-NHI-10-009, 2009), Table 3-1,
after ASCE (1960).

What the estimate assumes, as the Lab and the exports state it: rain falls
uniformly over the whole catchment and lasts at least its time of
concentration, so all of it contributes at once (steady state); C lumps
infiltration, storage and every other loss into one coefficient; the area
comes from D8 single-direction routing over the raw or the Priority-Flood
conditioned surface, whichever the run used, so in conditioned mode
depressions are filled and drain through; there is no storage, timing,
infiltration model or channel hydraulics. It is not a flood or water-depth
prediction. HEC-22 limits the method to drainage areas below 80 ha (0.8 km²);
a larger catchment is flagged beside its figure.

The figure is withheld, in the same words as every other metric figure,
whenever the horizontal scale is not resolved, since there is then no area in
square metres. An edge-contaminated catchment's peak flow reads "at least",
because its area is a lower bound.

The map follows the estimate. A cell is drawn as a channel when its estimated
peak flow reaches a fixed display threshold of 1 L/s, so raising the rainfall
or C draws more of the network. Line width and brightness, and the particles'
number and brightness, follow log10 of the peak flow on a fixed scale from
1 L/s to 1,000 L/s. Particle speed still follows the upstream cell count: it
is a display encoding, never a water velocity. Without square metres the map
keeps the upstream-count lines. The 3D drainage overlay always draws the
upstream count.

## Edge contamination

A contributing area is complete only when everything upslope of the outlet is
on the grid. `src/simulation/flowPulse/edgeContamination.ts` flags each cell
whose D8 upslope area holds a survey-edge cell (on the grid border, or beside
NoData that reaches the border) that routes into the surface: ground outside
the survey may also drain through such a cell, so its area is a lower bound.
This is the D8 edge-contamination criterion of the WhiteboxTools
EdgeContamination tool (Lindsay 2016). An edge cell that is itself an outlet
is not a seed, since flow leaves there, and a hole the survey encloses is a
wall, not outside ground. Seeds are pushed downstream in dependency order, so
a catchment is contaminated exactly when its outlet cell is. Registered as
`olv.simulation.terrain-flow.edge-contamination`, version 1.

Wherever an area appears it says so: the result card counts the contaminated
cells and marks the largest contributing area, the Largest drainage figure
reads "≥", the selection panel writes "at least: the catchment reaches the
survey edge, so ground outside the survey may also drain here", and the peak
flow, the watershed GIF and the export package carry the same lower bound.

## Pour-point snapping

A D8 channel is one cell wide, so a click one cell beside a trunk picks a
hillslope cell whose catchment is a handful of cells. In catchment mode a
pointer click therefore moves the outlet to the cell with the highest
upstream count within 2 cells (a square window), the standard snap-pour-point
step (as in the WhiteboxTools SnapPourPoints tool); ties keep the clicked
cell, then the nearest. The Lab says where it moved the outlet from, the
Snap outlet to channel button turns snapping off, and a keyboard selection is
always exact. Registered as `olv.simulation.terrain-flow.pour-point-snap`,
version 1; the export package records the cell that was picked.

## Watershed GIF

With a catchment drawn, Export GIF writes an animated GIF of it,
`<name>-watershed-<col>-<row>.gif`. Frames reveal the catchment by D8 flow
length to the outlet: the distance along each cell's D8 path, one cell size
for an orthogonal step and √2 cell sizes for a diagonal one on a square grid,
computed in one pass up the reverse D8 tree from the outlet
(`src/simulation/flowPulse/flowLength.ts`, registered as
`olv.simulation.terrain-flow.flow-length`, version 1). Frame k shows the cells
with flow length at most L_k = L_max · k / 36, coloured by flow length on
viridis over a grey hillshade of the DTM; the last frame holds the complete
catchment for three seconds. It is labelled flow length, never time: no
velocity is modelled.

Each frame carries a title naming the outlet's column and row and the source
file, the frame label "flow length ≤ X m", a legend with metre ticks, a scale
bar in metres, a north arrow (grid north of the scan's projected CRS; grid
row 0 is the southern row, so north is up), and a footer with the method and
surface, the cell size, the contributing area (marked as a lower bound when
edge-contaminated), the peak flow at the current rainfall and C, the CRS, the
OLV version and the date. Cells outside the catchment are shaded darker, NoData
is dotted, the outlet is ringed, and the channel lines at the current rainfall
are drawn as the reveal reaches them. Cells stay square (each is an s × s block
of pixels, or one pixel per d × d cells on a catchment wider than the page) and
the image is at most 1,000 px on its long side. The encoder
(`src/export/gifEncoder.ts`) writes GIF89a with one 256-colour palette, LZW
with variable code size and clear codes, the NETSCAPE2.0 loop and a comment
holding the same provenance as plain text; it is loaded only when a GIF is
exported, and the export yields between frames and shows its progress on the
button.

## Parameters

`FlowPulseParams`, defined in `flowPulseRunner.ts`, takes the following
fields.

`conditioning` is `raw` or `priority-flood`. `routing` is `d8`, the only
routing model this release ships: verified and offered, while multi-flow
direction and D-infinity remain future work, not shipped. `interpolated` is
`route`, which routes over interpolated DTM cells while disclosing the
count, or `block`, which restricts routing to measured ground only.
`fillEpsilon` is the rise above the cell a filled cell was reached from
when conditioning: `float64-step` (the default) for one Float64 step, or a
fixed rise in the vertical unit. The value `float32-step` names a Float32
step this method no longer takes, and a run given it is refused with a
message naming `float64-step`. `fillNoData` is `wall` by default, or `outlet`; it controls
how conditioning reads a NoData cell, while routing always treats NoData as
a wall regardless of this setting. `maxCells` refuses a grid above this cell
budget, 4,000,000 by default, rather than silently striding it.
`withheldExcluded` is the caller's declaration about Withheld points behind
the DTM, a tristate that defaults to whatever the terrain gather stamped on
the DTM.

## Failure and refusal states

`runFlowPulse` returns a typed refusal rather than a partially filled
result. The codes are `NO_DTM`, `NO_VALID_CELL`, `TOO_LARGE`, and
`UNITS_UNRESOLVED`, the last covering a geographic frame with unknown
latitude, since the east-west cell length cannot be derived without it. An
unresolved horizontal scale on a projected frame does not refuse the run:
direction is computable from the ratio of the two axis lengths, so the run
proceeds, reports cell counts, and withholds every square-metre figure.

## Limitations

D8 is single-flow-direction. Real water divides across a divergent
hillslope; D8 sends every cell's flow to exactly one neighbour regardless.
Raw mode's flats are reported, not resolved, as described above under Flat
handling. Interpolated DTM cells are routed over by default, so a path may
cross ground no return landed on, and the run's limitations state how many.
Whether Withheld points were excluded from the terrain behind a run is
frequently undeclared; the run then records it as undeclared instead of
guessing. A grid
above 4,000,000 cells is refused outright in this release. The depression
inventory's evidence is weaker than the routing claim's evidence; see
`docs/validation/claim-register.yaml`, entry `TERRAIN-FLOW-DEPRESSION-INVENTORY`.

## Method registry

Ten methods are registered under the `terrain-flow` prefix.
`olv.simulation.terrain-flow.d8`, version 2, performs single-flow-direction
routing. `olv.simulation.terrain-flow.priority-flood`, version 5, performs
depression conditioning with NoData treated as a wall.
`olv.simulation.terrain-flow.priority-flood.gap-outlet`, version 3, performs
the same conditioning with NoData gaps read as drainage exits.
`olv.simulation.terrain-flow.accumulation`, version 1, computes flow
accumulation over the D8 graph. `olv.simulation.terrain-flow.catchment`,
version 1, performs upstream catchment extraction.
`olv.simulation.terrain-flow.depression-inventory`, version 2, is the
depression inventory described above. `olv.simulation.terrain-flow.rational-peak`,
`olv.simulation.terrain-flow.edge-contamination`,
`olv.simulation.terrain-flow.flow-length` and
`olv.simulation.terrain-flow.pour-point-snap`, each version 1, are the
rainfall estimate, the edge flag, the GIF's flow length and the outlet snap
described above. See `docs/science/METHOD_REGISTRY.md`
for the full catalogue entry per id, including citations.

## Reproducibility and the run record

Every run seals a `FieldSimulationRunRecord`, defined in
`src/simulation/simulationRunRecord.ts`: source identity and basis, the
model and its registered methods, every parameter, a flat result summary,
the limitations the reader must be told, and a SHA-256 digest over all of
the above except the run's own id and generation timestamp. Re-running one
saved configuration and getting the same digest is what "reproducible"
means here.

That digest deliberately does not cover the routed arrays byte for byte.
That is a separate figure, `result.fieldDigest`, computed in
`src/simulation/flowPulse/flowFieldDigest.ts`: a second SHA-256 over the
receiver, direction and status arrays, the upstream counts, and the
conditioned elevations when conditioning ran. The conditioned elevations
are hashed at Float32, the precision of the DTM they came from, although
routing ran on the Float64 surface: the filled levels survive that rounding
exactly, and the Float64 rise that orders a filled flat, which does not, is
recorded by the receivers it produced. Two runs can share every
summary figure, such as an identical sink count, flat count, outlet count
and maximum upstream count, while routing to opposite edges of the grid, and
only the field digest tells them apart.

## Exports

`src/export/flowPulsePackage.ts` builds the Flow Pulse deliverable as one
ZIP, through the function `buildFlowPulsePackage`. It follows the pattern
`src/terrain/export/demPackage.ts` already established for the DEM
deliverable: a pure function from a result to ZIP bytes, reusing that
package's own Esri ASCII Grid writer rather than a new one.

The package contains an accumulation raster and a direction raster, one
value per DTM cell, at a local (0, 0) origin unless the caller supplies a
world origin. When the caller supplies a world origin and the DTM's raster frame (its
`originH1`/`originH2` corner offset and cell size, in source units), the
lower-left corner is the world origin plus that offset and the rasters use
the source cell size. Without both, the rasters sit at a local (0, 0)
corner in metres, and an anisotropic grid's rasters are written at the X cell size, since the ASCII Grid format has one
cell-size field, and the README states the true per-axis sizes. A sinks-and-depressions CSV lists the depression
inventory, largest first. A downstream path and a queried catchment are
written only when the caller supplies them: the path ships as GeoJSON with
one vertex per cell centre, marked with a `coordinateFrame` field that reads
`scan-crs` when the export is placed and the CRS name resolved,
`scan-source-coordinates` when it is placed and no CRS name resolved, and
`local-planar-metres` when it is not placed (no world origin or no raster
frame) (the same names the Terrain Access export uses), since an unmarked GeoJSON file implies WGS84
longitude and latitude by the format's own default; the catchment ships as a
raster mask rather than a traced polygon, since no boundary-tracing
algorithm is implemented.

A summary CSV and the sealed run record round out the figures. A
reproducible config file, named with the `.olv-field-sim.json` extension,
lets a reader re-run the export over the identical DTM and reproduce the
exported field digest; `tests/flowPulsePackage.test.ts` proves this end to
end. A processing manifest, an ordered and hash-chained record of the
methods that ran, is built with `src/science/processingManifest.ts`. A
scientific artifact passport, an unauthenticated provenance record (a
self-consistency check, not a signature) bound to the accumulation raster, is built with
`src/science/scientificArtifactPassport.ts`; it records source and input
digest, the registered method ids, the processing-manifest head, and the
result digest, the same seam `demPackage.ts` uses for the DEM's bare-earth
raster.

The README states OLV version, source identity and digest, input basis,
parameters, units, results, assumptions, limitations and reproduction steps.
It states SIMULATED and never claims flood, runoff or discharge outside an
explicit negation. A SHA256SUMS file lists the SHA-256 of every file in the
package.

The Flow Pulse Lab's Export package (ZIP) button builds this package from
the current run, through `buildFlowPulseExport` in
`src/ui/fieldSimulation/flowPulseLab.ts`. It passes the world origin, the
CRS name and WKT (written as a `.prj` only when the export is placed, that is, when a world origin and the raster frame are also supplied; without them the rasters are in local metres and the README marks the CRS as not applied), the DTM's
raster frame, the vertical origin and the terrain verdict. When the vertical
origin is known and the vertical unit resolved, the depression table's
`outletElevation` is the source elevation the Lab's readout shows. Otherwise
the readout shows no elevation, and the column is `outletElevationLocal`, in
the load-time recentred frame. A Blocked or Preview terrain run puts its
verdict and the interpolated share of the surface at the top of the
README.

With a catchment selected, the package also names its outlet. The README's
Catchment outlet section and `<name>-catchment-outlet.json` give the outlet's
column (from the west) and row (from the south), its cell-centre position in
the same frame as the rasters (`coordinateFrame` as for the path), the cell
the click picked when the outlet was snapped, the cell count, the
contributing area (withheld without metres), and the edge-contamination flag,
which makes the area a lower bound. When the Lab shows a peak flow, the
package records the rainfall intensity and C (with the preset and its
published range), the rational-method peak flow at the outlet and at the end
of a traced path (also in the path GeoJSON's properties), the lower-bound and
area-limit flags and the assumptions, and the processing manifest lists the
rational-method, edge-contamination and snapping steps that applied.
