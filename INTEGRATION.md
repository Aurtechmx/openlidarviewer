# Layer Health Card — integration notes

What this branch adds, without wiring it in:

- `src/app/layerHealth.ts` — pure builders (`buildLayerHealth`, `buildCompatibilityReport`), no DOM.
- `src/ui/LayerHealthCard.ts` — the Inspector card (`readonly root`, `update(layers, report)`, `clear()`).
- `tests/layerHealth.test.ts` — 27 tests pinning wording, fail-closed behaviour and the claim ban.
- `src/style.css` — `.olv-layerhealth-*` block appended at the end of the file.

`src/main.ts`, `src/render/Viewer.ts`, `src/ui/Inspector.ts` and `src/app/LayerService.ts` are untouched. This file says exactly where to attach the card and where every `LayerHealthInput` field already lives.

## Where to mount the card

`src/ui/Inspector.ts`, constructor:

- Construct next to the Dataset Intelligence card: `this._datasetIntelligence = new DatasetIntelligenceCard();` is at `src/ui/Inspector.ts:1222`. Add `this._layerHealth = new LayerHealthCard();` beside it (field declaration next to `_datasetIntelligence` at `src/ui/Inspector.ts:655`).
- Insert `this._layerHealth.root` into the `el('aside', …)` children list at `src/ui/Inspector.ts:1224-1228`, directly **after** `this._layersSection` (line 1227). The card then reads immediately under the Layers list it explains, and above Color-by.
- Add a passthrough setter on Inspector next to `setLayerCrsFlags` (`src/ui/Inspector.ts:1383`), e.g. `setLayerHealth(layers, report)` calling `this._layerHealth.update(...)`, and call `this._layerHealth.clear()` wherever the layers list is cleared (`this._layers.replaceChildren()` at `src/ui/Inspector.ts:1891`).

## Where the data comes from

Everything is already computed once per layer-set change inside `refreshCrsFlags` (`src/app/LayerService.ts:318-335`) and its helper `syncProjectFrame` (`src/app/LayerService.ts:189-316`). That is the one call site to extend — it already pushes `lastCompatibility` and `lastUnmounted` to the Inspector via `inspector.setLayerCrsFlags(...)` at `src/app/LayerService.ts:325`. Assemble the `LayerHealthInput[]` there and push it through the new setter in the same breath.

Per field:

| `LayerHealthInput` field | Source |
| --- | --- |
| `name` | `LayerInfo.name`, built in `buildLayerInfos` (`src/app/LayerService.ts:144-163`) from `viewer.getCloud(id)` (`src/render/Viewer.ts:4104`). |
| `crsName` | `LayerInfo.crsName` (`src/app/LayerService.ts:157`), i.e. `cloud.metadata.crs.name` (`ResolvedCrs.name`, `src/geo/CoordinateTypes.ts:95`). Pass `null` when absent. |
| `crsSource` | `ResolvedCrs.source` (`src/geo/CoordinateTypes.ts:103`; union at `:50`). Not on `LayerInfo` today — read it from `cloud.metadata.crs.source` when assembling, or extend `buildLayerInfos`. Set by `crsCoordinator` (`src/app/crsCoordinator.ts:109` for `'las-vlr'`, `:127` for `'ept-srs'`/`'copc-meta'`). The builder maps the union to labels ("file header", "user override", …). |
| `horizontalUnit` | `ResolvedCrs.linearUnit` (`src/geo/CoordinateTypes.ts:101`) — already a name. `'unknown'` in the resolved CRS should be passed as `null` so the row fails closed. |
| `verticalUnit` | There is **no vertical unit name** in `ResolvedCrs` — only `verticalUnitToMetres` (`src/geo/CoordinateTypes.ts:135`). Pass `null` unless a declared name exists; do not reverse-map the factor to a name (that would be a guess the builder's wording contract forbids). |
| `verticalDatum` | `LayerInfo.verticalDatum` (`src/app/LayerService.ts:158`). |
| `compatibility` | `lastCompatibility.get(id)` (`src/app/LayerService.ts:186`, filled at `:206`) — the `classifyLayerCompatibility` result. Note the precision demotion at `src/app/LayerService.ts:310-313`: a layer rejected on precision is reported to the viewer as `'incompatible'`; use the same demoted value here so the card agrees with the estimators. |
| `mounted` | The `mounted` boolean computed at `src/app/LayerService.ts:278` (`willMount || infos.length <= 1`) — the exact value handed to `viewer.setCloudMounted` (`src/render/Viewer.ts:2237`). Equivalently `!lastUnmounted.includes(id)` (`src/app/LayerService.ts:187`, `:315`). |
| `sourceOrigin` | `viewer.getCloud(id)?.sourceOrigin` (read the same way at `src/app/LayerService.ts:214`; declared on the model at `src/model/PointCloud.ts:181`). `undefined` → `null`. |
| `frameOffset` | `deps.projectFrame.transformFor(id)` (`src/app/projectFrame.ts:88` interface, `:232` impl) → `LayerSpatialTransform.sourceToProject` (`src/geo/ProjectSpatialFrame.ts:52`). Pass it **only when the layer is actually in the shared frame** (aligned and not in `projectFrame.unaligned`, `src/app/projectFrame.ts:90`); an unaligned layer's transform is the identity into its own private frame (`src/app/projectFrame.ts:203-208`), which is not an offset to the project — pass `null`. |
| `precisionMm` / `precisionBasis` | `mountPrecision(info, cloud, aligned ? frame : null)` (`src/app/LayerService.ts:114-138`, called at `:270`). It is module-private: either export it, or stash each layer's result in a `lastPrecision` map inside `syncProjectFrame` next to `lastUnmounted`. `precisionMm = errorMetres === null ? null : errorMetres * 1000`; `precisionBasis` maps 1:1. |
| `streaming` | Per-app today there is at most one streaming source: `viewer.isStreamingActive()` (`src/render/Viewer.ts:4126`) / `viewer.streamingCloud` (`src/render/Viewer.ts:2299`). Set `streaming: true` for the layer id that belongs to the streaming source, false otherwise. |

## The report

`buildCompatibilityReport` wants `{ name, compatibility, verticalDatumKnown }` per layer, from the same pass:

- `compatibility`: as above (`lastCompatibility`, with the precision demotion applied).
- `verticalDatumKnown`: `info.verticalDatum != null || info.verticalEpsg != null` (`LayerInfo` fields at `src/app/LayerService.ts:158-159`) — the same facts `verticalReferenceKey` classifies from (`src/model/layerCompatibility.ts`).

Call shape at the end of `refreshCrsFlags`:

```ts
inspector.setLayerHealth(
  infos.map((info) => ({ name: info.name, rows: buildLayerHealth(toHealthInput(info)) })),
  buildCompatibilityReport(infos.map(toReportLayer)),
);
```

The builders handle the 0- and 1-layer cases themselves ("No layers loaded." / "One layer loaded — cross-layer comparison does not apply."), and `LayerHealthCard.update([], …)` hides the card, so no call-site guards are needed.
