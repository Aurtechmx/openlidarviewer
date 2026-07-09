# Method versions

Every scientific method OpenLiDARViewer runs is identified by a stable `id@version` so a result can name the exact algorithmic path behind it, and a later release can improve one method without changing the meaning of the others. The authoritative catalogue is `docs/science/METHOD_REGISTRY.md` and its runtime companion `src/science/methodRegistry.ts`.

## Contour Studio geometry (v0.5.9)

The Contour Studio geometry products carry these method ids on the product and in the exported vector attributes (`method_id`, `method_version`):

- `olv.contour.analytical@1` — exact isolines of the terrain grid (marching squares, cell-centre registration). No smoothing or displacement.
- `olv.contour.generalize.dp@1` — cartographic generalization by Douglas–Peucker simplification with a fixed tolerance.
- `olv.contour.generalize.terrain-adaptive@1` — cartographic generalization with a per-feature tolerance scaled by support, confidence, closure, and length, within a bounded band.

These ids are stamped by the geometry-product builders. Routing them through the canonical `ScientificAnalysisRecord` (which validates ids against the method registry) is part of the export wiring and is registered there when an exporter emits the record.

## Stability rule

An id is stable; a behavioural change bumps the `@version`. A number produced by `id@N` must not silently change meaning under the same id and version. When a method changes, its entry in `docs/science/METHOD_REGISTRY.md` and the version stamp move together.
