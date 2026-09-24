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
prediction. It takes no rainfall intensity as input and animates no
physically timed water velocity. Flow accumulation counts cells that drain
through a cell, itself included, never water, and a pulse is a visual
traversal of an already-computed topographic routing graph, not a simulated
flood wave. See `docs/validation/claim-register.yaml` for the claims
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
Mulla (2014). It floods inward from the mapped surface's boundary, always
advancing from the lowest cell reached so far, and raises a cell reached
from below to the level it was reached at: the elevation water would have to
reach to spill out of the depression holding it. One pass, a binary
min-heap ordered by elevation then by insertion order, so two cells reached
at the same elevation resolve the same way on every run, runs in O(n log n).

An optional epsilon parameter raises each filled cell a small amount above
its spill parent, turning what would otherwise be a plateau (no descent, so
D8 would report it flat) into a surface with a deterministic path out. At a
large coordinate magnitude a Float32 increment can be absorbed and the cell
does not actually rise; every such absorption is counted in
`epsilonAbsorbed` rather than assumed to have applied.

D8 treats NoData as a wall, and conditioning is seeded consistently with
that. By default, when `fillNoData` is set to `wall`, only the cells on the
grid's own boundary seed the flood, so a survey hole is never read as a
drainage exit. A region NoData fully encloses has no route to the boundary
and keeps its elevations, counted in `cellsUnreachable` rather than silently
left out of the total. The declared alternative, `fillNoData: outlet`
(registered as `olv.simulation.terrain-flow.priority-flood.gap-outlet`),
also seeds every cell touching a gap. That reading suits a gap that is open
water a LiDAR survey left empty, and it is never the default, because over a
genuine survey hole it invents an exit that was never surveyed.

## D8 routing

`src/simulation/flowPulse/d8Flow.ts` implements O'Callaghan and Mark (1984).
For each valid cell, the eight neighbours are inspected in a fixed order:
east, southeast, south, southwest, west, northwest, north, northeast. The
cell drains to whichever neighbour offers the strictly greatest drop per
metre of physical distance, with ties broken by that fixed order rather than
by array layout. The diagonal distance is computed as
`hypot(dx * cellMetresX, dy * cellMetresY)`, never as `sqrt(2) * cellSize`,
so an anisotropic grid, including a geographic frame where the east-west
cell length scales by the cosine of latitude, ranks a diagonal against a
cardinal neighbour by real geometry.

A cell with no downslope neighbour is one of three things, and raw mode
reports which one rather than choosing for it. A sink has every neighbour
strictly higher or invalid, and flow stops. A flat has no neighbour lower
but at least one equal, and is reported unresolved rather than given an
arbitrary direction from iteration order. An outlet sits on the grid
boundary with nowhere lower to go on the mapped surface, so flow leaves the
analysed extent.

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

Conditioned mode groups the cells Priority-Flood raised into 8-connected
depressions, the same adjacency D8 routes over, and reports, for each one:
cell count; area in square metres when the horizontal scale is resolved,
cell count only otherwise; the deepest rise within that depression; and its
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
version 1. Do not call every single-cell sink a natural pond. A one-cell raw
candidate is a pinpoint, and even a catalogued conditioned depression is a
topographic computation, not a field-surveyed pond.

## Click-to-pulse and catchment

`pulseFrom()` traces the already-computed downstream path from a start cell
to a sink or an outlet, using `traceDownstream` in `d8Flow.ts`, with a
visited guard: a conditioned surface can produce a two-cell cycle where each
of a pair routes to the other, and the tracer stops rather than looping.
Animation speed, where a caller draws one, is presentation only. The path
itself carries the scientific identity.

`catchmentFrom()` walks the D8 receiver graph backwards from a selected
outlet, using `catchmentOf` in `flowAccumulation.ts`, and returns every cell
that drains through it. Donor lists are built once per query rather than
walking every cell's receiver on each call.

## Parameters

`FlowPulseParams`, defined in `flowPulseRunner.ts`, takes the following
fields.

`conditioning` is `raw` or `priority-flood`. `routing` is `d8`, the only
routing model this release ships: verified and offered, while multi-flow
direction and D-infinity remain future work, not shipped. `interpolated` is
`route`, which routes over interpolated DTM cells while disclosing the
count, or `block`, which restricts routing to measured ground only.
`fillEpsilon` is the rise above the spill parent when conditioning, in the
vertical unit. `fillNoData` is `wall` by default, or `outlet`; it controls
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
frequently undeclared, and the run says so rather than guessing. A grid
above 4,000,000 cells is refused outright in this release. The depression
inventory's evidence is weaker than the routing claim's evidence; see
`docs/validation/claim-register.yaml`, entry `TERRAIN-FLOW-DEPRESSION-INVENTORY`.

## Method registry

Six methods are registered under the `terrain-flow` prefix.
`olv.simulation.terrain-flow.d8`, version 1, performs single-flow-direction
routing. `olv.simulation.terrain-flow.priority-flood`, version 2, performs
depression conditioning with NoData treated as a wall.
`olv.simulation.terrain-flow.priority-flood.gap-outlet`, version 1, performs
the same conditioning with NoData gaps read as drainage exits.
`olv.simulation.terrain-flow.accumulation`, version 1, computes flow
accumulation over the D8 graph. `olv.simulation.terrain-flow.catchment`,
version 1, performs upstream catchment extraction.
`olv.simulation.terrain-flow.depression-inventory`, version 1, is the
depression inventory described above. See `docs/science/METHOD_REGISTRY.md`
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
conditioned elevations when conditioning ran. Two runs can share every
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
world origin. An anisotropic grid's rasters are written at the X cell size,
since the ASCII Grid format has one cell-size field, and the README states
the true per-axis sizes. A sinks-and-depressions CSV lists the depression
inventory, largest first. A downstream path and a queried catchment are
written only when the caller supplies them: the path ships as GeoJSON in
local planar metres, marked with a `coordinateFrame` field reading
`local-planar-metres`, since an unmarked GeoJSON file implies WGS84
longitude and latitude by the format's own default; the catchment ships as a
raster mask rather than a traced polygon, since no boundary-tracing
algorithm is implemented.

A summary CSV and the sealed run record round out the figures. A
reproducible config file, named with the `.olv-field-sim.json` extension,
lets a reader re-run the export over the identical DTM and reproduce the
exported field digest; `tests/flowPulsePackage.test.ts` proves this end to
end. A processing manifest, an ordered and hash-chained record of the
methods that ran, is built with `src/science/processingManifest.ts`. A
scientific artifact passport, a tamper-evident but not authenticated
provenance record bound to the accumulation raster, is built with
`src/science/scientificArtifactPassport.ts`; it records source and input
digest, the registered method ids, the processing-manifest head, and the
result digest, the same seam `demPackage.ts` uses for the DEM's bare-earth
raster.

The README states OLV version, source identity and digest, input basis,
parameters, units, results, assumptions, limitations and reproduction steps.
It states SIMULATED and never claims flood, runoff or discharge outside an
explicit negation. A SHA256SUMS file lists the SHA-256 of every file in the
package.

The builder is a pure library. Nothing in this repository wires it to a UI
export action yet.
