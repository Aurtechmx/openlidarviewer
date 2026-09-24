# Terrain Access: cross-implementation check

Horn slope/aspect, Vector Ruggedness Measure, hard eligibility, width
dilation, directional grade and least-cost routing are computed twice here,
and the two results are compared on a small set of frozen terrains.

## What is compared

`oracle/terrain_access_oracle.py` is a second implementation of the method
definitions in the governing prompt (§12), written in Python from those
definitions rather than from the TypeScript:

- Horn slope/aspect, including its border-extrapolation policy, ported field
  for field from `src/terrain/ground/terrainDerivatives.ts`'s documented
  algorithm.
- Vector Ruggedness Measure, Sappington, Longshore & Thompson (2007).
- Hard eligibility and width clearance, the node/edge split
  `src/simulation/terrainAccess/traversabilityCost.ts` documents.
- Directional longitudinal grade and cross slope, the gradient decomposition
  `src/simulation/terrainAccess/directionalGrade.ts` documents.
- Least-cost routing, by Dijkstra, where the viewer runs A* with a
  planimetric-distance heuristic and a different tie-break rule. Two
  different search algorithms over the same declared cost graph; if they
  agree on total cost, hard-eligibility counts, and block-reason tallies, a
  bug in one search's bookkeeping is unlikely to reproduce identically in the
  other.

`tests/terrainAccessOracleAgreement.test.ts` compares the viewer against the
records in `expected/`, field by field: outcome, cost, eligible-cell count,
block-reason tally, and, on the fixtures verified tie-free, the exact path.

## What agreement does and does not establish

Agreement catches transcription slips, a sign error in the gradient/aspect
convention, and a mistake in scaling the two horizontal axes to metres,
because each would have to occur identically in two separately written
routines to pass unnoticed.

It is not external validation. Both implementations were written in this
project, so a shared misreading of the published method would survive the
comparison. The fixtures are deliberately small, and each carries a `why`
field explaining what it pins, which is the backstop for that.

No dataset, no network, and no licence applies: every fixture is a terrain
written out by hand in this directory.

## Why some fixtures do not compare an exact path

A* (the viewer) and Dijkstra (the oracle) use deliberately different
tie-break rules; see `aStarTerrain.ts`'s header. When a fixture's cost graph
holds two or more equal-cost routes, a symmetric detour around one excluded
cell for instance, the two searches are not required or expected to choose
the same one. Asserting exact path equality there would pin an artefact of
two independently chosen orderings, not a property of the method. Those
fixtures still get the strictly stronger checks: identical cost, identical
path length, and a direct check that the viewer's own path never touches a
cell the oracle also excluded. The test file's `TIE_FREE` set names which
fixtures were checked by hand (see each one's `why`) to have a single
lowest-cost route, where exact-path comparison is meaningful.

## The fixtures

| Fixture | What it pins |
| --- | --- |
| `TA-1-flat-plane` | A flat plane under permissive limits routes near-diagonally at close to the Euclidean cost. |
| `TA-2-tilted-plane-directional` | A tight cross-slope limit accepts the straight-downslope heading and rejects any heading that leaves it; cross slope is evaluated per heading, not as total slope. |
| `TA-4-step-barrier` | A step too tall to cross forces a detour around the one open row; the direct corridor is provably unusable. |
| `TA-5-width-clearance-narrow` / `-wide` | The same 1-cell gap is passable at zero vehicle width and unpassable once the declared width cannot clear it after dilation. |
| `TA-6-nodata-corridor` | A full-width NoData wall with no gap: NO_ROUTE, not a route that crosses it. |
| `TA-7-low-confidence-block` / `-penalize` | The same weak-evidence cell is hard-excluded under `unknownPolicy: 'block'` and cost-penalized instead (and so eligible again) under `'penalize'`. |
| `TA-8-ruggedness` / `-unset` | A rough spike forces a detour once `maxRuggedness` is declared, and does not when it is left `null`. |
| `TA-3-cross-slope-trap` | A uniform plane whose direct row is closed by a single NoData cell; every detour requires a north/south move, and a tight `maxCrossSlope` rejects all of them even though the plane's total slope would pass either limit read as one scalar, so the outcome is `NO_ROUTE`. |
| `TA-9-dsm-obstruction` | Above-ground DSM evidence (`heightAboveGround`), not terrain geometry, closes two cells and forces the same kind of detour TA-4 forces with a step. |
| `TA-10-anisotropic-grid` | `cellMetresX` and `cellMetresY` differ, as an unequal-metre geographic grid would; the route cost and the diagonal heading it depends on must reflect the true physical distances, not the raster index. |

## Running it

```
python3 validation/terrain-access/oracle/terrain_access_oracle.py --check   # recompute in Python, compare to expected/
python3 validation/terrain-access/oracle/terrain_access_oracle.py --write   # regenerate expected/ after a deliberate change
```

`tests/terrainAccessOracleAgreement.test.ts` reads the committed `fixtures/`
and `expected/` records directly and needs no interpreter, so the release
gate exercises the agreement without running any Python. Regenerating the
records is a deliberate act that appears in the diff.
