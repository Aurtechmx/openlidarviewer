# Contour Studio

Contour Studio turns a correctly analyzed LiDAR scan into a clear, evidence-aware contour deliverable, without crowding the analysis panel. This page describes the workflow, the honesty model, and where each piece lives in the source.

## The workflow

```text
Load scan → analyze → see terrain readiness → Create Contour Deliverable
          → choose a purpose → review recommendations → export
```

After analysis, a Terrain Products launcher leads the results. Its state (hidden, unavailable, exploratory, or available) is computed from the analysis result and the reference frame. Opening it reveals the Contour Studio workspace: purpose cards, a review bar of recommendations, an evidence ladder, and an export bar. The Analyse panel keeps its own Export Contours, DEM (ZIP) and Intelligence report (PDF) buttons; the Studio adds the purpose cards, the review bar and the complete export bar.

## Honesty model

The science stays stricter than the UI looks:

- Unknown vertical units or a geographic CRS cap the output to cartographic-only; metric contour support is claimed only on a projected metre-based frame, and a source-unit number is never presented as metres.
- Analytical contours are exact isolines of the grid; cartographic contours are generalized for legibility, reference the analytical geometry's hash, and are never labelled exact.
- A label is never placed on an unsupported span as if it were measured; interpolated spans are marked interpolated.
- Every scientific export routes through the one evidence resolver: the contour vectors (GeoJSON, DXF, SVG), the map-sheet PDF, the DEM raster package, the complete deliverable ZIP, and the terrain intelligence report all mint their permit through the same central gate. The decision can only downgrade: a product is capped to exploratory when a prerequisite is incomplete and blocked when there is nothing usable. A blocked product yields a diagnostic explanation, never a polished deliverable; an exploratory product is watermarked, and the permit decision is stamped into each artifact's provenance.
- Validation is internal (hold-out) only; nothing is survey-grade, and no output asserts certification or standards compliance.

## Purposes

A purpose is a bundle of presentation defaults only (Engineering Plan, Survey Review, Terrain Research, Presentation Map, Custom). Selecting one changes defaults for settings the user has not overridden. Because the state carries no evidence field, a purpose switch is structurally incapable of raising a claim.

## Source map

Pure cores under `src/terrain/contourStudio/`:

- `contourStudioLaunchState.ts` + `contourStudioLaunchStateFromResult.ts`: the launcher state machine and its adapter from the analysis result.
- `contourStudioState.ts` / `contourStudioPurpose.ts` / `contourStudioReducer.ts` / `contourStudioController.ts`: the serializable state, purpose presets, reducer, and observable store.
- `contourLevelDefinition.ts`: unit-safe interval and base (source and metre, or null when unknown).
- `contourReviewSummary.ts`: the review-bar model, surfaced from the analysis with rationale.
- `contourGeometryProduct.ts`: the analytical/cartographic split with hashing and displacement stats.
- `contourAdaptiveGeneralize.ts`: terrain-aware per-feature generalization.
- `contourLabelEngine.ts`: print-aware label placement with a suppression audit.
- `contourDeliverablePdfModel.ts`: the multipage PDF content model.
- `contourPackageManifest.ts`: the complete-package manifest and the §21.1 vector attributes.

UI (vanilla-TS DOM builders) under `src/ui/`: `contourStudioLauncher.ts`, `contourStudioWorkspace.ts`, mounted lazily via `contourStudioMount.ts`. The evidence gate manifest is `src/export/exportManifest.ts`.

## Status and limits

The Studio's export bar writes the contour vectors (GeoJSON, DXF and SVG), the map sheet (PDF), the DEM package (ZIP), the complete deliverable (ZIP) and the Intelligence report (PDF). A product that cannot run is disabled, and the reason is shown. The map sheet is also available as Contour map sheet (PDF) in the Export tab, and it runs the same export with the Studio's starting purpose.

When the analysis was built from a display sample or a resident streaming set, the map sheet says so under the accuracy heading and prints the analysed basis. It leaves out the USGS density reference, and it titles the accuracy block "Hold-out accuracy (preview)". On a placed scan the sheet's orientation arrow reads "Grid N", and its timestamps are in UTC with the zone named. The WGS 84 contour GeoJSON is refused for a scan on NAD27 or on a datum the viewer cannot confirm, because OLV applies no datum shift; the button shows the reason.

Since the first Studio release, every export product (including the DEM raster package and the terrain intelligence report, which shipped in 0.5.9 with their own product-specific gates) has been folded under the single central evidence resolver. See `docs/releases/VALIDATION_REPORT_v0.5.9.md` and `docs/validation/THREATS_TO_VALIDITY.md` for the evidence scope.
