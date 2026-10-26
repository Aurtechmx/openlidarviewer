# Field simulation: cross-implementation check

D8 flow direction, flow accumulation and Priority-Flood conditioning are
computed twice here, and the results are compared on a small set of frozen
terrains.

## What is compared

`oracle/flow_oracle.py` is a second implementation of the same three published
methods, written in Python from their definitions:

- **D8 flow direction**, O'Callaghan & Mark (1984). Steepest descent per unit
  of horizontal distance, in metres, to one of eight neighbours.
- **Flow accumulation**, the count of cells draining through each cell,
  itself included.
- **Priority-Flood conditioning**, Barnes, Lehman & Mulla (2014), with
  `heapq`: the surface flooded inward from its edge, lowest cell first, each
  cell reached from below raised to its spill level plus one float64 step so
  the filled flat drains. The rules the viewer fixes are repeated from the
  method rather than copied from the TypeScript: NoData is a wall and seeds
  only where it reaches the grid boundary, a gap is an exit only when a
  fixture asks, a cell is in a depression only when its original height is
  strictly below the spill level, and cells NoData encloses are counted as
  unreachable rather than filled. Every fixture is conditioned with the
  viewer's defaults for a conditioned run (`float64-step`, NoData as wall)
  unless it carries a `conditioning` block naming its own.

It differs from the viewer in more than language. Accumulation walks
downstream from every cell, where `src/simulation/flowPulse/flowAccumulation.ts`
drains cells in dependency order. The same quantity by two algorithms, so a
bookkeeping error in one does not reproduce in the other.

`tests/fieldSimulationOracleAgreement.test.ts` compares the viewer against the
records in `expected/`, field by field: receiver, direction, status, upstream
counts, the sink, flat and outlet tallies, and for the conditioned half the
conditioned surface cell by cell to the last float64 step, the spill levels,
the depression mask and the fill figures (cells raised, deepest fill, fill
depth sum, flats resolved, rises absorbed, cells unreachable). The heights are
read as float32 on both sides, so the float64 rises start from the same
values.

## What agreement does and does not establish

Agreement catches transcription slips, a drifting tie-break, and mistakes in
scaling the two axes to metres, because each would have to occur identically
in two separately written routines to pass unnoticed.

It is not external validation. Both implementations were written in this
project, so a shared misreading of the published method would survive the
comparison. The fixtures are deliberately small enough that their expected
fields can be checked by hand, which is the backstop for that.

No dataset, no network, and no licence applies: every fixture is a terrain
written out by hand in this directory.

## The fixtures

Names follow the TF-N validation set of the v0.7 field-simulation prompt
(§11): every TF-N item that is a D8/accumulation routing question has a
fixture here.

| Fixture | TF | What it pins |
| --- | --- | --- |
| `plane-east` | TF-1 (constant plane) | A constant plane routes every interior cell the same way. |
| `bowl-notched` | TF-2 (bowl) | A pit stays a sink in raw routing rather than draining through the rim notch. The conditioned half of TF-2: the pit is the one cell the flood raises, to the inner rim's level, and the conditioned surface, spill levels and fill figures agree with the Python flood. `tests/depressionInventory.test.ts` checks the depression table over the same grid, and `tests/priorityFlood.test.ts` and `tests/priorityFloodRandomGrids.test.ts` hold the property coverage. |
| `ridge` | TF-3 (ridge) | Ground falling away on both sides of a crest routes west on one side and east on the other; the crest cells themselves tie on gradient and must all break the tie toward the same neighbour. |
| `anisotropic` | TF-6 (anisotropic grid) | Ten metres east against one metre south: the steeper physical gradient wins over the larger raw drop. |
| `valley-v` | TF-4 (V-shaped valley) | Accumulation converges on the valley axis. |
| `flat-plateau-outlet` | TF-5 (flat plateau with outlet) | A flat interior does not get an invented direction: only the cells with sight of the one lower notch route, the rest report unresolved. |
| `nodata-barrier` | TF-7 (NoData barrier) | Flow does not cross cells with no elevation, and no receiver is an invalid cell. |
| `sl-field-real-terrain` | TF-8 (real terrain fixture) | A real 40x40 m crop of OLV's own bincell DTM over the VT StREAM Lab survey (OpenTopography DOI 10.5069/G9NZ85W7), already committed under `validation/terrain-field/` for that harness. Real relief and real survey NoData gaps, not a hand-written surface. `tests/flowPulseRealTerrainDigest.test.ts` pins a `flowFieldDigest` for it, alongside the field-by-field oracle agreement below. |

## Running it

```
npm run validation:field-simulation:verify   # recompute in Python, compare to expected/
npm run validation:field-simulation:write    # regenerate expected/ after a deliberate change
```

The release gate does not run either. The gate executes no Python, and the
agreement itself is already enforced inside it by the TypeScript test above,
which reads the committed records and needs no interpreter. Regenerating the
records is therefore a deliberate act that appears in the diff rather than
something a gate run can do silently.
