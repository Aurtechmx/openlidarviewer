# Field simulation: cross-implementation check

D8 flow direction and flow accumulation are computed twice here, and the two
results are compared on a small set of frozen terrains.

## What is compared

`oracle/flow_oracle.py` is a second implementation of the same two published
methods, written in Python from their definitions:

- **D8 flow direction**, O'Callaghan & Mark (1984). Steepest descent per unit
  of horizontal distance, in metres, to one of eight neighbours.
- **Flow accumulation**, the count of cells draining through each cell,
  itself included.

It differs from the viewer in more than language. Accumulation walks
downstream from every cell, where `src/simulation/flowPulse/flowAccumulation.ts`
drains cells in dependency order. The same quantity by two algorithms, so a
bookkeeping error in one does not reproduce in the other.

`tests/fieldSimulationOracleAgreement.test.ts` compares the viewer against the
records in `expected/`, field by field: receiver, direction, status, upstream
counts, and the sink, flat and outlet tallies.

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

| Fixture | What it pins |
| --- | --- |
| `plane-east` | A constant plane routes every interior cell the same way. |
| `bowl-notched` | A pit stays a sink in raw routing rather than draining through the rim notch. |
| `anisotropic` | Ten metres east against one metre south: the steeper physical gradient wins over the larger raw drop. |
| `nodata-barrier` | Flow does not cross cells with no elevation, and no receiver is an invalid cell. |
| `valley-v` | Accumulation converges on the valley axis. |

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
