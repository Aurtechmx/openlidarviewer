# src/observation

Reserved for the Observatory observation kernel (`docs/observatory/SPEC.md`).

This layer is pure: no DOM, `three` or `ui/` imports (OB-INT-01). It is
registered in `LAYERS` in `scripts/lint-layer-boundaries.mjs` from phase O0
onward, before any module exists here, so the boundary holds from the first
file a later phase adds.

O1 adds the first two modules: `types.ts` (the observation-model vocabulary)
and `stateTable.ts` (OB-ST-01, the pure counters-to-state function). Both are
registered staged in `docs/validation/unreachable-modules.json`: nothing in
the production graph builds an evidence ledger to call them with yet. The ray
builder (O3) and the ledger and traversal (O4) are next.
