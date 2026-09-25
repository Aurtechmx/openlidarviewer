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
enforces is a value the caller declares explicitly, with no hidden default
and no vehicle preset presented as validated. The Lab's own form
(`terrainAccessProfileForm.ts`) ships with every field blank. There is no
"load a preset" control, because a preset would smuggle unreviewed numbers
into a run and imply they were checked against the reader's actual
platform.

The profile's grade fields are entered in the Lab as degrees, the unit a
person reasons in, and converted once, in `parseTerrainAccessProfileForm`,
to the rise/run tangents the model compares internally. That is the same
unit `hornSlopeAspect`'s own slope field uses, so the A* hot path never
repeats that trigonometry.

## DTM basis and units

`dtmTerrainAccessGrid.ts` converts the analysed `DtmGrid` (and, optionally,
an aligned DSM/nDSM) into a `TerrainAccessGrid`. The grid carries elevation with a valid mask,
per-cell terrain confidence (0-100, `DtmGrid.confidence` unchanged) and the
DTM's coverage code. An above-ground height layer and an ROI mask are optional.

A run refuses outright (`UNITS_UNRESOLVED`) rather than guess when the
horizontal scale is unresolved, when a geographic frame's latitude is
unknown, or when the vertical unit-to-metres factor is unresolved. Every
grade, cross-slope and step-height comparison depends on those being real
metric quantities, unlike Flow Pulse's own routing direction, which survives
an unresolved scale.

## Eligibility and cost

`traversabilityCost.ts` separates direction-independent hard blocks (NoData,
outside ROI, low terrain confidence, ruggedness, above-ground obstruction)
from direction-dependent edge limits (longitudinal grade, cross slope, step
height). A cell can be fine to stand on yet unreachable from one heading and
reachable from another.

Eligible cells are then dilated by half the declared vehicle width
(`footprintClearance.ts`), so a passage narrower than the vehicle is
excluded even where its centre cells are individually clear. Every eligible
edge carries a declared, bounded soft cost, `distance * (1 + sum of weight *
utilization)`, that rises linearly with how much of a limit a move actually
uses.

## Search

`aStarTerrain.ts` runs a deterministic 8-connected A* with a written-down,
total tie-break: lower f, then lower h, then lower cell index. It is
admissible and consistent because every edge multiplier is at least 1. The
same grid, profile and endpoints always produce the same route.

## Route diagnostics, traversability map, why-not inspector

A found route's `RouteDiagnostics` (`routeDiagnostics.ts`) report the worst
conditions actually crossed, rather than a single opaque cost number:
maximum and p95 grade and cross-slope, maximum local step, minimum terrain
confidence, and which cost term dominated.

The traversability map (`buildTraversabilityMap`) classifies every readable
cell into a declared bucket (blocked, unknown, or low/moderate/high cost)
for the Lab's grid and 3D overlay. The why-not inspector (`whyNotEligible`)
answers, for any single cell, exactly which declared limit blocks it, or
that no in-bounds neighbour offers a viable move. It never returns a vague
"not reachable".

## Refusals

A run refuses by name rather than guessing: `NO_DTM`, `UNITS_UNRESOLVED`,
`INVALID_PROFILE`, `START_BLOCKED`, `END_BLOCKED`, `NO_ROUTE`,
`INSUFFICIENT_EVIDENCE`, `TOO_LARGE`.

The Lab also refuses a stale preview or run (`STALE_INPUT`) the moment the
terrain behind it may have changed since the profile was applied. That is a
Lab-detected precondition, not one `runTerrainAccess` itself can observe,
since the core is a synchronous pure function with no notion of "since this
preview was built".

## The field simulation lab

`src/ui/fieldSimulation/terrainAccessLab.ts` is opened from the command
palette next to Flow Pulse. It has three stages: the blank mobility-profile
form; the traversability-map preview, where start and goal are chosen on a
keyboard- and pointer-accessible 2D result grid (arrow keys move, Enter or
Space activates) and any cell can be inspected with "Why not?" without a
route existing; and the completed run, with diagnostics, the route drawn on
the grid and, where scene membership is supplied, in the 3D scene through
`TerrainAccessOverlay`.

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
supplies a world origin and CRS/WKT; otherwise the raster is written at a
local (0, 0) origin and the README says so, exactly as the DEM package and
Flow Pulse's own export already behave.

The run record's basis is read from the DTM's own `coverageMode` via
`simulationInputBasis()`, the same field Flow Pulse reads; a full-resolution
re-decode that strides down to a point budget is now stamped `'sampled'`
there (`computeTerrainCore`'s own fix), so Terrain Access states the same
sampled-vs-full basis honestly without any change of its own.

Vehicle length is recorded, not enforced. Eligibility is width-only
morphological dilation. A full swept-body orientation check would need a
heading-aware collision test this release does not implement.

No field or vehicle trial exists. The independent Python oracle
(`validation/terrain-access/oracle/terrain_access_oracle.py`) is a
cross-implementation check written inside this project, not an externally
maintained routing tool. See the `TERRAIN-ACCESS` claim's
`requiredEvidenceNote` for why E3 is this release's ceiling.
