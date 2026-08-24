# Streaming scheduler baseline

A frozen record of what the streaming scheduler decides, and a gate that fails
when any of it moves for the same input.

## What is recorded

`reference-runs-streaming.json` holds one trace per format the scheduler drives
today — COPC, EPT, and the OLV tile store — over a single scripted camera path
of 28 ticks: a full orbit, a dolly to inside the cube, a fast rotation, a hold,
and a retreat in which the camera turns its back on the scan and the point
budget collapses to a tenth. Per tick it records the scheduler's own wanted set
in selection order, the ids it moved into its queue in queue order, the ids a
decode actually started for, the ids it evicted, the ancestor-protection set,
the refined-away set, the refining-candidate set, the export frontier, the
resident set and point count, and every non-zero node score.

Each fixture also carries `deferPathTrace`: the same path with the
memory-pressure eviction plan switched off, so the deferred-eviction pass is the
only thing releasing nodes. That second run is where ancestor protection is
visible as a decision rather than as a set. The pressure plan walks the whole
resident set in one priority order and carries no protection, so with both
passes live it releases the coarse nodes the deferred pass has just held back,
and the two together record protection without ever recording it changing an
outcome. In the isolated run the budget collapse leaves a shortfall larger than
every unprotected resident node put together, the deferred pass releases the
leaves and holds their ancestors, and those ancestors go one tick later.

`ancestorCeiling` records `MAX_ANCESTOR_STEPS` against two walks that reach it —
a parent chain that closes into a cycle, and a chain twice as long as the
ceiling. No real hierarchy gets near it, so the constant would otherwise be
pinned by nothing.

Every value comes from running the code. The wanted set is read out of the live
scheduler rather than recomputed: `readinessFacts()` walks it and resolves each
member through the node store, so a recording shim over one call returns those
ids in the order selection built them. The frontier, the refined-away set and
the refining-candidate set are the exported functions themselves. The eviction
list is the scheduler's own eviction callback.

`module-graph-and-bundle.json` holds the verbatim output of
`scripts/lint-module-graph.mjs` and `scripts/check-bundle-budget.mjs` as they
stood when the trace was recorded, so the shape of the module graph and the size
of the shipped chunks are dated to the same tree. Regenerate with
`npm run build && node scripts/record-streaming-baseline-env.mjs`.

## What the gate establishes

`tests/streamingLegacyEquivalence.test.ts` regenerates the record and fails on
any difference: a different wanted set, a different queue order, a different
protection or refined-away decision, a different eviction, a different frontier,
a different resident count. It is drift detection from this commit forward.

## What the gate does not establish

It does not show that the move onto explicit `parentId` ancestry preserved the
behaviour of the octree-key walk it replaced. The record compares this tree
against a snapshot of itself; the key-shift walk is no longer in the tree, so it
cannot be run here and no before-and-after comparison exists in this file. The
side-by-side claim for that change lives in
`tests/streamingHierarchyGeneric.test.ts`, which keeps the key-shift walk as a
reference implementation and asserts the two agree over real COPC hierarchies.

## Determinism

Both recordings in `it('two full recordings are byte-identical')` must produce
the same bytes. Every hierarchy is generated from one seed, the camera path is
scripted, the clock is injected, the decoder resolves instantly, and every
recorded list is either an order the code produced or is sorted before it is
written. No wall clock, no random number, and no hash-container ordering reaches
an output.

## Fixtures

- **COPC** — a synthetic COPC file from `tests/fixtures/copc/synthCopc.ts`, 128
  nodes over four levels, in a 256 m cube on the render origin.
- **EPT** — a generated Entwine dataset served from memory, 128 nodes over four
  levels, in a 256 m cube at a UTM position. Its whole hierarchy is one root
  file, so the octree finishes inside the first-paint budget and no background
  deepening runs while the trace is being recorded. The on-disk
  `tests/fixtures/ept-tiny` is a single node, which is enough to decode and far
  too small for a scheduler to select, defer, protect or evict anything.
- **OLV tile store** — a 40 000-point LAS indexed out of core and served through
  `OlvTileSource`, 85 nodes whose ids (`t`, `t0`, `t00`, …) carry no coordinate
  at all, which is the case the parent-identity walk exists for.

The tile-store fixture folds the build's recentring origin to zero. `OlvTileOctree`
records each node's cube in the store's local frame while `OlvTileSource` reports
the build's world origin as its `renderOrigin`, and the scheduler subtracts
`renderOrigin` from every record's bounds — so a UTM build origin moves the whole
hierarchy hundreds of kilometres out of frame and every node scores zero. The
adapter has no construction site in `src/`, so this is a fixture choice and not a
workaround for behaviour a user can reach.

## Regenerating

After a deliberate behaviour change, and only then:

```
UPDATE_STREAMING_BASELINE=1 npx vitest run tests/streamingLegacyEquivalence.test.ts
```

Commit the regenerated JSON with the change that explains it.
