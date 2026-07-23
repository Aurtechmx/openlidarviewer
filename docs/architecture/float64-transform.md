# The Float64 transform — removing the destructive rebase

Status: steps 1–5 landed. The destructive rebase is gone —
`PointCloud.rebaseOrigin`, `restoreSourceFrame` and `isRebased` are removed,
mounting is a Float64 placement (`Viewer.setLayerPlacement`), and the
immutability test suite proves there is no writer left. Step 6 (browser
verification of two-layer placement, then revisiting
`MULTI_LAYER_MOUNT_ENABLED`) remains, and it has an explicit prerequisite:
the estimator/accumulator fold. The fold toolbox (step 3's shared boundary)
is written, but terrain gather, lasso, profiles and volumes still iterate
positions without adding the layer translation into the shared
grid/accumulator — correct today only because mounting is disabled, so every
transform is the identity. Those consumers must adopt the fold before
two-layer placement can be verified, let alone enabled.

## The problem, stated exactly

Mounting a layer into the shared project frame currently calls
`PointCloud.rebaseOrigin`, which rewrites every Float32 position in place and
moves `origin` so `local + origin` is preserved. That choice was deliberate:
the first implementation translated the three.js mesh instead, and the scene
split in two — rendering saw project space while picking, terrain gather,
lasso, profiles, volumes and export bounds read cloud-local data. Rebasing the
data kept every consumer coherent for free.

The price is the two defects the alpha releases disclose: the source geometry
is not immutable (a mount rewrites it), and the round trip is not exact (the
rewrite re-quantises to the Float32 lattice at the new origin — measured at
~0.06 mm per km of separation, saturating after the first cycle). Both are
bounded; neither is acceptable in a stable release whose defining claim is
deterministic, non-destructive spatial operations.

## Invariants after the flip

1. `positions` is written exactly once, by the loader. Byte-identical
   afterwards through mount, unmount, hide, session restore, removal and
   export. Pinned by `tests/sourceGeometryImmutable.test.ts`, whose
   "documents the defect" case must be flipped to expect identity in the
   same change that removes the rewrite.
2. `positions[i] + sourceOrigin` is the source-frame world coordinate,
   always. `worldXYZ()` and `cloudToGlobal()` already promise this and
   survive the flip unchanged.
3. A layer's placement in the project frame is a per-layer **Float64
   translation** (`LayerSpatialTransform.sourceToProject`, which already
   exists as a tested value type). It is data ABOUT the layer, never applied
   INTO the layer's buffer.
4. Mount and unmount are exact inverses: setting and clearing a translation
   cannot lose precision, because nothing is re-quantised. `rebaseQuantum`
   stops describing a cost and starts describing the (unchanged) resolution
   a layer's own frame gives it.

## Where each consumer class lands

The alpha.3 accessor migration (f389a51 + the exporter batch) already moved
every source-frame consumer onto `sourceOrigin`; those need nothing. The
remaining classes and their coordinate space:

| Consumer class | Space needed | Change at flip time |
|---|---|---|
| Renderer (mesh placement) | render | mesh position = `sourceToProject − renderOrigin`, Float64 folded on CPU per mesh (three values per layer per frame — not per point), GPU stays Float32 |
| Picking (`nearestPointAlongRay`) | project | fold the layer translation into the ray, not the points: transform the ray into the layer's source frame, pick, transform the hit back |
| Terrain gather, lasso, profiles, volumes | project | combined estimators iterate per layer; add the layer's translation when writing into the shared grid/accumulator |
| Camera framing / orbit clamp (`_visibleBoundingBox`) | project | translate each layer's cached bounds by its transform before merging |
| Measurement datum (`_refreshMeasureDatum`) | project | today: unanimity over literal origins; after: unanimity over `sourceOrigin + transform`, same rule, computed values |
| `exportGeoContext` (measurements, inspect context, session rebase) | source | switch `c.origin` → `c.sourceOrigin`; measurement geometry is captured in layer-local coordinates, and layer-local IS source-local once nothing rewrites positions |
| crsCoordinator inspector descriptor | source | widen the descriptor to carry `sourceOrigin` |
| Sessions | source | geometry is already stored layer-local + origin; origin recorded becomes `sourceOrigin` (equal today, so old sessions stay valid) |
| Renderer origin collection (`Viewer.ts:2062`) | render | unchanged — placement is exactly its job |

The columns are the point: after the flip there are only two lifts —
source (`sourceOrigin`) and project (`sourceOrigin` then translation) — and
each site names which one it means. No site may add a bare `origin` again;
`lint:position-access` holds the surface and `origin` itself is removed.

## The flip sequence (each step gated, in order)

1. **DONE — Widen the seams.** Add the project-space accessor next to
   `worldXYZ` (`projectXYZ(index, transform, out)`), and the per-layer
   transform lookup on the Viewer entry. Pure additions; no behaviour change.
2. **DONE — Migrate the four deferred sites** (`exportGeoContext`,
   measurement datum, crsCoordinator descriptor, sessions) to the source
   frame. Each was a no-op at the time — same property as every earlier
   batch.
3. **DONE (boundary) — Teach the cross-layer consumers the translation**
   (picking, terrain gather, lasso, profiles, volumes, camera bounds), each
   behind the existing single-layer identity: with one layer the transform
   is zero, so every change is provably a no-op in the shipped
   configuration. The fold toolbox and the scene-bounds/picking adoption
   landed; the estimator/accumulator consumers still need to adopt it —
   see the Status note, this is step 6's prerequisite.
4. **DONE — Flip the renderer** to mesh-level placement with the
   render-origin fold (`Viewer.setLayerPlacement`).
5. **DONE — Remove `rebaseOrigin`.** Mounting sets the transform instead;
   `restoreSourceFrame` and `isRebased` went with it (a cloud no longer
   knows or cares whether it is placed — placement state lives with the
   frame, not the data). The "documents the defect" test flipped to a pinned
   read-only API surface plus byte-identity, and `rebaseQuantum` stays as
   the admission-gate model of the retired mechanism's cost.
6. **REMAINING — Browser verification** of two-layer placement — the step
   the roadmap has always said cannot be skipped — and only then may
   `MULTI_LAYER_MOUNT_ENABLED` be revisited. Prerequisite: the
   estimator/accumulator fold (terrain gather, lasso, profiles, volumes),
   which is correct today only because mounting is disabled.

Steps 1–4 were individually shippable no-ops. Step 5 was the point of no
return; it has landed, and 6 is what stands between the placement
architecture and enabling multi-layer mounting.

## What this does not change

Frame compatibility gating (the verified / horizontal-only / unknown /
incompatible ladder) is orthogonal and already fails closed; the transform
only changes HOW a permitted mount is applied, never WHETHER it is
permitted. Streaming sources keep their own render origin and remain
unmergeable with static clouds in this cycle.
