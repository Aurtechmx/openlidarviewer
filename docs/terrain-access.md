# Terrain Access

Terrain Access screens a candidate route between two chosen cells over an
OLV DTM against a mobility profile the reader declares themselves. Given a
terrain surface, a profile and a start/goal pair, it answers whether a route
exists under the declared limits, where that route is, and what conditions
along it were the worst. The code lives under `src/simulation/terrainAccess/`;
the shared simulation record and input-basis types live in `src/simulation/`.

Every result is a geometry-based screening.

It describes the declared mobility limits applied to the declared terrain
product. It is never a safety assessment, a guaranteed-passable route, or a
vehicle dynamics simulation. Soil strength, traction, tire/track-soil
interaction, rollover, weather and vegetation compliance are not modelled.
See `docs/validation/claim-register.yaml` for the `TERRAIN-ACCESS` claim,
which states the exact approved and prohibited claim language.

## What this is not

Terrain Access never states or implies that a route is "safe", "drivable"
or "passable". It is not a vehicle dynamics simulation, not a soil-mechanics
or traction model, not a rollover or weather-compliance assessment, and not
a substitute for a site visit or a qualified assessment of a specific
vehicle on specific ground. A found route is a geometric candidate under
limits the reader themselves typed in. Nothing about finding one asserts
those limits were the right ones for any real vehicle.

## Mobility profile

`terrainAccessTypes.ts` defines `TerrainAccessProfile`. Every limit a run
enforces is a value the caller declares explicitly, with no hidden default.
The Lab's own form (`terrainAccessProfileForm.ts`) opens with every field
blank. Walker, ATV and 4x4 vehicle buttons above the fields fill every
required field from `TERRAIN_ACCESS_EXAMPLES`, which states the basis of each
figure. The values show in the fields, stay editable and are labelled as
examples to confirm for the reader's own platform, not a rating or a safety
limit. Picking one does not run anything. The applied profile records which
example it started from and whether any limit or policy was changed
(`origin` in the run record's profile, and the README's Profile section).

The profile's grade fields are entered in the Lab as degrees, the unit a
person reasons in, and converted once, in `parseTerrainAccessProfileForm`,
to the rise/run tangents the model compares internally. That is the same
unit `hornSlopeAspect`'s own slope field uses, so the A* hot path never
repeats that trigonometry. A degree field accepts only a value strictly
between 0° and 90° and says so in degrees: outside that range the tangent
would apply a different limit from the one typed (190° reads as 10°, 270°
as no limit at all).

## DTM basis and units

`dtmTerrainAccessGrid.ts` converts the analysed `DtmGrid` (and, optionally,
an aligned DSM/nDSM) into a `TerrainAccessGrid`. The grid carries elevation with a valid mask,
per-cell terrain confidence (0-100, `DtmGrid.confidence` unchanged) and the
DTM's coverage code. An above-ground height layer and an ROI mask are optional.

A run refuses outright (`UNITS_UNRESOLVED`) rather than guess when the
horizontal scale is unresolved, when a geographic frame's latitude is
unknown, or when the vertical unit-to-metres factor is unresolved or not
finite. A grid whose cell size is 0, negative or not finite, or whose arrays
disagree with its dimensions, is refused as `INVALID_GRID` before any cell
is read. Every
grade, cross-slope and step-height comparison depends on those being real
metric quantities, unlike Flow Pulse's own routing direction, which survives
an unresolved scale.

## Eligibility and cost

`traversabilityCost.ts` separates direction-independent hard blocks (NoData,
outside ROI, low terrain confidence, ruggedness, above-ground obstruction)
from direction-dependent edge limits (longitudinal grade, cross slope, step
height). A cell can be fine to stand on yet unreachable from one heading and
reachable from another.

The minimum terrain confidence is a hard block only under the profile's
`block` unknown policy, and the run record marks it `evaluated` there. Under
`penalize` a cell below the minimum stays eligible and costs the same as it
would with any other minimum (the support term is
`weight * (1 - confidence / 100)` whatever the minimum is), so the minimum
only sets the reported share of route cells below it; the run record, run
card, diagnostics CSV and export README mark it `disclosed`, not `evaluated`.

The longitudinal grade of a move from cell A to neighbour B is the largest
of three rise/run tangents: the Horn gradient at A projected on the heading,
the Horn gradient at B projected on the heading, and the edge's own
|z(B) - z(A)| divided by its horizontal length in metres. Its cross slope is
the larger of the two endpoints' Horn components perpendicular to the
heading. Both figures are therefore the same for A to B and B to A, and the
grade is never lower than what the edge itself climbs: a move out of a
V-shaped valley floor, where the centred Horn gradient is zero, is still
gated on its real rise. The same per-edge figures feed the limit check, the
cost and the route diagnostics.

### Step height

The step limit applies to a height discontinuity, not to the rise of a
slope. The step of a move from A to its neighbour B by raster offset d
(`localStep.ts`) compares the move's rise z(B) − z(A) with the rise of the
terrain along the same heading just behind and just past it:

    behind = z(A) − z(A − d)        ahead = z(B + d) − z(B)
    step   = max(0, rise − max(behind, ahead), min(behind, ahead) − rise)

so the step is how far the rise falls outside the bracket of those two. A
plane of any slope, on any cell size, has a step of 0; a ledge of height h on
a plane of any slope has a step of h. Any rise between the two one-sided
rises is what a single change of grade between A − d and B + d produces (a
hill toe, a crest, a bank top), so it is not counted as a step. The mean of
the two would read such a change of grade as a step of half the change in
rise per cell (flat ground meeting a 19° slope on 2.566 m cells would read
0.44 m) and would amplify DTM noise more than the raw rise does.

When only one of A − d and B + d has an elevation (beside the grid edge or a
NoData cell) the bracket is that one rise; there a change of grade right at
the move reads as a step, so the estimate errs towards blocking. When
neither has one, the bracket is the Horn gradient at A and at B projected on
the move. A route over a move that read one side only reports step height
as `estimated` (`stepOneSidedRouteMoves` in the diagnostics), which only the
exploratory evidence policy allows.

A diagonal move passes between its two corner cells. Its step is the larger
of its own step along the diagonal and the easier of the two paths through a
corner, each the larger of its two orthogonal steps:

    step_diag = max(direct, min over corners c of max(step(A → c), step(c → B)))

so a one-cell berm or ditch running across the diagonal blocks it, while a
single high or low cell at one corner leaves the other corner open.

What it cannot resolve: a step is only seen at the grid's own resolution. A
ledge the DTM spreads over more than one cell (interpolation, or a coarse
cell) reads as slope and is judged by the grade limit instead. Two ledges
inside one cell read as one. Because the bracket allows one change of grade
anywhere in the four cells it reads, a ledge where the grade also changes
reads lower than its height by up to that change in rise per cell, which a
coarse cell makes larger: on 2.566 m cells a 20° slope changes the rise per
cell by about 0.93 m. The other way round, a level move between two risers
one cell apart (a tread between two steps, or a cell of noise between two
rough ones) reads the smaller riser as its own step, so on rough terrain the
step limit can close a cell the raw height differences would have left open. The 3×3 local relief (the largest raw height
difference around a cell) is reported beside the route and is never
compared with the step limit.

Width clearance (`footprintClearance.ts`) treats each cell as its
rectangle and the vehicle as a disc of half the declared width. A cell is
refused when its centre is strictly closer than that half-width to a
hard-blocked cell's rectangle or to the survey edge; outside the grid counts
as unsupported. A vehicle exactly as wide as a corridor touches both sides
and fits; a wider one does not. When no cell the limits accept can hold the
footprint, the run is refused and the reason names the width.

A diagonal move is refused when either orthogonal cell beside it is
hard-blocked, at any width, so a route never passes the shared corner of
two unsupported cells. For a positive width the disc swept along the
diagonal must also stay clear of every hard-blocked rectangle, not only at
the two cell centres. A* search, the traversability map and the why-not
inspector apply this one edge rule. Every eligible
edge carries a declared, bounded soft cost, `distance * (1 + sum of weight *
utilization)`, that rises linearly with how much of a limit a move actually
uses. Grade enters that sum once, through the longitudinal term; the step
term reads the step above, so a smooth slope adds nothing to it. Every weight must be a finite number of 0 or more, so no edge costs
less than its length and the A* heuristic stays admissible; a run or preview
with any other weight is refused with `INVALID_WEIGHTS`.

## Evidence gaps and the obstruction surface

The above-ground obstruction limit is evaluated from the terrain run's own
DSM, kept on the DTM grid. The obstruction surface takes the top return per
cell without ASPRS noise (classes 7 and 18); Withheld points are left out by
the gather. The full-cloud DSM and its products keep every return. The Lab receives it as an above-ground surface bound
to that run's DTM by the DTM product digest; a surface built with a different
terrain surface is refused with `SURFACE_STALE`, and one whose origin, array
lengths, row orientation, horizontal CRS or vertical unit differ from the
terrain's is refused with `SURFACE_MISALIGNED`. Without such a surface the
"Constrain above-ground obstruction" control is disabled.

The profile's evidence-gap policy decides two kinds of cell: a cell whose
slope and aspect used a synthesised Horn neighbour (the grid's outer ring or
beside a NoData void), and, while the obstruction limit is evaluated, a cell
with no above-ground return. `conservative` blocks them. `exploratory`, the
default, allows them and reports their share of the route. Under exploratory,
cross-slope and longitudinal grade are marked `estimated` rather than
`evaluated` when any route cell's window left the grid or touched NoData, and
an evaluated ruggedness limit is marked `estimated` when any route cell's VRM
window holds such a cell. Under conservative, a ruggedness limit also blocks
any cell whose 3×3 ruggedness window holds such a cell, so ruggedness is never
`estimated` under conservative. The obstruction limit is marked `estimated`
under either policy when its surface was built from a sample of the scan, and
when any route cell has no above-ground return; the run states "Above-ground
obstruction could not be checked on K of R route cells: the surface has no
above-ground evidence there, so those cells are not known to be clear." The
points the surface rests on (sampled or not, points read and in the scan,
noise left out, Withheld treatment) are recorded with it. The run record, run card and diagnostics CSV state
the policy and these statuses, and the export README repeats the statuses. The policy and the surface
binding, with its point basis, are part of the run's input digest
(`olv.simulation.terrain-access.input-digest.v5`). On a geographic frame the
digest also names the degree-to-metre model (`wgs84-degree-series`: the WGS84
meridional and parallel degree lengths at the grid latitude), so a run under
the earlier 111,320 m conversion does not share an identity with a current one.

## Search

`aStarTerrain.ts` runs a deterministic 8-connected A* with a written-down,
total tie-break: lower f, then lower h, then lower cell index. It is
admissible and consistent because every edge multiplier is at least 1. The
same grid, profile and endpoints always produce the same route.

## Route diagnostics, traversability map, why-not inspector

A found route's `RouteDiagnostics` (`routeDiagnostics.ts`) report the worst
conditions actually crossed, rather than a single opaque cost number:
maximum and p95 grade and cross-slope (per-edge, as defined above, with the
p95 weighted by edge length: the smallest value whose edges cover at least
95% of the route length, with compensated sums and a 1e-12 relative tolerance
so an exact boundary such as 95 of 100 equal diagonal edges returns the 95th
value), the largest step crossed (the figure the step limit applies to),
the largest local relief touched, minimum terrain confidence, and which cost
term dominated, each term summed as edge length times its weighted
utilization so it is the share of the route cost it adds. A term adding
less than 1% of the route's extra cost is not named as a driver.

The traversability map (`buildTraversabilityMap`) classifies every readable
cell into a declared bucket (blocked, unknown, or low/moderate/high cost)
for the Lab's grid and 3D overlay. The why-not inspector (`whyNotEligible`)
answers, for any single cell, exactly which declared limit blocks it, or
that no in-bounds neighbour offers a viable move. When every move out of a
cell exceeds an edge limit, it names the move that misses by the smallest
excess relative to its own limit, so a step in metres and a grade or cross
slope in tangents are compared on one scale. It never returns a vague
"not reachable".

## Refusals

A run refuses by name rather than guessing: `NO_DTM`, `UNITS_UNRESOLVED`,
`INVALID_PROFILE`, `INVALID_WEIGHTS` (a cost weight that is negative or not a
finite number), `START_BLOCKED`, `END_BLOCKED`, `NO_ROUTE`,
`INSUFFICIENT_EVIDENCE`, `TOO_LARGE`, `OBSTRUCTION_EVIDENCE_UNAVAILABLE` (the
profile sets an above-ground obstruction limit and no aligned above-ground
surface exists), `SURFACE_MISALIGNED` (the above-ground surface does not cover
the same cells as the terrain), `SURFACE_STALE` (the above-ground surface was
built with a different terrain surface), `INVALID_ROI` (a region-of-interest
mask of the wrong length or with values other than 0 and 1) and
`INVALID_GRID` (a cell size or dimensions a run cannot read).

`START_BLOCKED` and `END_BLOCKED` say whether the cell is off the grid, has
no elevation (NoData), or which declared limit blocks it, in the why-not
inspector's words. `NO_ROUTE` grows the area each endpoint can reach over the
moves the search takes, stops at the smaller one, and names the reasons that
close the moves out of it with their shares, for example "The start can reach
1,234 cells; the moves out of that area are closed by step height (61%), cross
slope (22%) and NoData cells (17%)." The survey edge is not counted.

The Lab also refuses a stale preview or run (`STALE_INPUT`) the moment the
terrain behind it may have changed since the profile was applied. That is a
Lab-detected precondition, not one `runTerrainAccess` itself can observe,
since the core is a synchronous pure function with no notion of "since this
preview was built".

## The field simulation lab

`src/ui/fieldSimulation/terrainAccessLab.ts` is opened from the command
palette next to Flow Pulse. It has three stages: the mobility-profile form,
blank or filled from an example; the traversability-map preview, where start
and goal are chosen on a keyboard- and pointer-accessible 2D result grid
(arrow keys move, Enter or Space activates) and any cell can be inspected
with "Why not?" without a route existing; and the completed run, with
diagnostics, the route drawn on the grid and, where scene membership is
supplied, in the 3D scene through `TerrainAccessOverlay`. The run card states
the limits the run applied (grade and cross slope in degrees, step and
vehicle width in metres, minimum confidence), for a refused run too.

The run reuses the preview's grid, terrain features, eligibility and
traversability map when its inputs give the same preparation digest as the
preview's (the run's input digest plus the whole profile, the cost weights
and the run parameters); any difference and it prepares afresh. The result
and its record are the same either way.

## Exports

`src/export/terrainAccessPackage.ts` builds a ZIP: the found route as
GeoJSON, the traversability map as an Esri ASCII Grid raster, a diagnostics
table, the sealed run record, a reproducible `*.olv-field-sim.json` config,
a processing manifest, a scientific artifact passport bound to the raster,
and a README that repeats this document's own "never safe, drivable or
passable" wording rather than paraphrasing it. Re-running the config over
the same terrain reproduces the same `resultDigest`.

## Known limitations

The cell readout reports a real elevation with its unit when the terrain's
load-time recentring origin and vertical scale both resolve, and an honest
"unknown" otherwise, using the same `ElevationReference` gate
`flowGridCursor.ts` uses for Flow Pulse, applied here too. Horizontal length
is always metric, and so is every grade/step figure: the runner refuses
`UNITS_UNRESOLVED` before a result can exist if the horizontal scale or the
vertical unit-to-metres factor does not resolve.

The 3D traversability-map/route overlay persists on the scan after the Lab
modal closes, mirroring Flow Pulse's `FlowOverlay` lifecycle: it is disposed
only when the user turns it off, or when the terrain/CRS it was built from
goes stale (a different scan loading, a scan closing, a CRS change, or a
classification edit), through the same disposal-registry seam
(`registerTerrainAccessOverlayInvalidator`/`invalidateTerrainAccessOverlay`
in `lazyChunks.ts`) `terrainAnalysisRunner.ts` already calls for Flow Pulse.

Exported rasters and the route GeoJSON carry the real world corner in the
dataset CRS, and a `.prj` sidecar when the CRS resolves, when the caller
supplies a world origin and CRS/WKT; with a CRS but no world origin the
package writes no `.prj` and the README marks the CRS as not applied;
otherwise the raster is written at a
local (0, 0) origin and the README says so, exactly as the DEM package and
Flow Pulse's own export already behave.

The run record's basis is read from the DTM's own `coverageMode` via
`simulationInputBasis()`, the same field Flow Pulse reads; a full-resolution
re-decode that strides down to a point budget is now stamped `'sampled'`
there (`computeTerrainCore`'s own fix), so Terrain Access states the same
sampled-vs-full basis honestly without any change of its own.

Vehicle length is recorded, not enforced. Eligibility is a width-only
disc clearance. A full swept-body orientation check would need a
heading-aware collision test this release does not implement.

No field or vehicle trial exists. The independent Python oracle
(`validation/terrain-access/oracle/terrain_access_oracle.py`) is a
cross-implementation check written inside this project, not an externally
maintained routing tool. See the `TERRAIN-ACCESS` claim's
`requiredEvidenceNote` for why E3 is this release's ceiling.
