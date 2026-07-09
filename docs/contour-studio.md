# Contour Studio

Contour Studio turns a correctly analyzed LiDAR scan into a clear, evidence-aware contour deliverable, without crowding the analysis panel. This page describes the workflow, the honesty model, and where each piece lives in the source.

## The workflow

```text
Load scan → analyze → see terrain readiness → Create Contour Deliverable
          → choose a purpose → review recommendations → export
```

After analysis, a Terrain Products launcher appears outside the analysis panel. Its state (hidden, unavailable, exploratory, or available) is computed from the analysis result and the reference frame. Opening it reveals the Contour Studio workspace: purpose cards, a review bar of recommendations, an evidence ladder, and an export bar. The contour export controls no longer live inline in the analysis panel.

## Honesty model

The science stays stricter than the UI looks:

- Unknown vertical units or a geographic CRS cap the output to cartographic-only; metric contour support is claimed only on a projected metre-based frame, and a source-unit number is never presented as metres.
- Analytical contours are exact isolines of the grid; cartographic contours are generalized for legibility, reference the analytical geometry's hash, and are never labelled exact.
- A label is never placed on an unsupported span as if it were measured; interpolated spans are marked interpolated.
- Every scientific export routes through the evidence gate. The decision can only downgrade: a product is capped to exploratory when a prerequisite is incomplete and blocked when there is nothing usable. A blocked product yields a diagnostic explanation, never a polished deliverable, and an exploratory product is watermarked.
- Validation is internal (hold-out) only; nothing is survey-grade, and no output asserts certification or standards compliance.

## Purposes

A purpose is a bundle of presentation defaults only (Engineering Plan, Survey Review, Terrain Research, Presentation Map, Custom). Selecting one changes defaults for settings the user has not overridden. Because the state carries no evidence field, a purpose switch is structurally incapable of raising a claim.

## Source map

Pure cores under `src/terrain/contourStudio/`:

- `contourStudioLaunchState.ts` + `contourStudioLaunchStateFromResult.ts` — the launcher state machine and its adapter from the analysis result.
- `contourStudioState.ts` / `contourStudioPurpose.ts` / `contourStudioReducer.ts` / `contourStudioController.ts` — the serializable state, purpose presets, reducer, and observable store.
- `contourLevelDefinition.ts` — unit-safe interval and base (source and metre, or null when unknown).
- `contourReviewSummary.ts` — the review-bar model, surfaced from the analysis with rationale.
- `contourGeometryProduct.ts` — the analytical/cartographic split with hashing and displacement stats.
- `contourAdaptiveGeneralize.ts` — terrain-aware per-feature generalization.
- `contourLabelEngine.ts` — print-aware label placement with a suppression audit.
- `contourDeliverablePdfModel.ts` — the multipage PDF content model.
- `contourPackageManifest.ts` — the complete-package manifest and the §21.1 vector attributes.

UI (vanilla-TS DOM builders) under `src/ui/`: `contourStudioLauncher.ts`, `contourStudioWorkspace.ts`, mounted lazily via `contourStudioMount.ts`. The evidence gate manifest is `src/export/exportManifest.ts`.

## Status and limits

v0.5.9 lands the Contour Studio cores and the workspace shell. The pixel-level PDF/raster rendering, the ZIP byte assembly, functional exports, worker progress/cancel for heavy compute, and the browser end-to-end suite are integration and device-verified work that sits on top of these cores. See `VALIDATION_REPORT_v0.5.9.md` and `docs/validation/THREATS_TO_VALIDITY.md` for the evidence scope.
