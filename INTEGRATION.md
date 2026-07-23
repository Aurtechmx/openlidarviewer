# Measurement-context line — host integration

`MeasurePanel` now renders a context line under every measurement value. Until
the host feeds it real facts it stays on the fail-closed default ("Viewer
measurement · approximate — shared datum unresolved"). To feed the live state,
add these three lines inside `refreshMeasurePanel()` in `src/main.ts`, directly
after `measurePanel.update(viewer.measure.getSummaries())` (src/main.ts:5510):

```ts
measurePanel.setConfidenceContext({
  datumResolved: viewer.measure.datumResolved,   // MeasureController.ts getter; fed by Viewer._refreshMeasureDatum (src/render/Viewer.ts:2111-2121)
  layers: viewer.clouds().length <= 1 ? 'single' : 'mixed',
  verticalReferenceKnown: (crsService.current()?.verticalDatum ?? null) !== null,  // same read as src/main.ts:2625
});
```

Notes for the integrator:

- `viewer.measure.datumResolved` is a new getter on `MeasureController`
  (src/render/measure/MeasureController.ts, next to `get worldUp`), true when
  `Viewer._refreshMeasureDatum` resolved a non-null shared origin.
- `layers: 'mixed'` for a multi-layer scene is deliberately fail-closed (it
  demotes to "approximate"). To distinguish `all-verified` / `incomparable`,
  expose `lastCompatibility` from `createLayerService`
  (src/app/LayerService.ts:186 and :206) and map it through
  `layerContextOf([...lastCompatibility.values()])` from
  `src/render/measure/measureConfidence.ts`.
- `refreshMeasurePanel` already runs on every measurement/layer refresh, so no
  extra subscription is needed; `setConfidenceContext` no-ops on identical
  facts and re-renders the list otherwise.
