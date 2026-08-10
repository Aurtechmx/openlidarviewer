# SpatialContext — consumer inventory and routing status

`src/geo/SpatialContext.ts` is one explicit description of the frame a dataset's
coordinates live in: horizontal CRS and linear unit, vertical unit and datum
reference, up axis, project-frame placement, and the single fail-closed gate
`metricClaimsPermitted`. It is a façade over pieces that already exist
(`isLinearUnitKnown`, the `CrsValidation` ladder, `verticalReferenceFromDatum`,
`ProjectSpatialFrame`), not a new source of truth.

`src/geo/frameCompatibility.ts` is its two-dataset companion. It answers the two
questions a comparison needs SEPARATELY: may these frames be compared in plan,
and may their heights be compared. A single "compatible" boolean cannot state
either case honestly, and the epoch comparison used to apply one answer to both
axes.

This file is the inventory of every consumer that reads a unit, datum, axis or
frame fact, and whether it now routes through the context. It is machine
checked: `scripts/lint-spatial-context.mjs` fails the release gate when a row
here disagrees with the imports in the tree, when a routed consumer goes back to
a hand-rolled predicate, or when prose anywhere claims a consumer count the
table does not support.

## Where the context is built

Once, at a boundary, then passed down.

- **`CrsService.context()`** (`src/geo/CrsService.ts`) is the active scan's
  context. It is memoised on the resolved CRS and invalidated inside
  `_setCurrent`, so two consumers reading it in one frame get the same object
  and a stale one cannot outlive the override that replaced it. It is never
  `null`: with no scan open it is the explicit unknown frame, whose
  `metricClaimsPermitted` is `false`, so an early read fails closed rather than
  dereferencing null.
- **`spatialContextFrom(cloud.metadata?.crs)`** is used where several scans are
  in play at once and there is no single "active" CRS: the epoch comparison
  builds one context per epoch, the streaming grade builds one for the streaming
  source, and the LAS and report exporters build one for the cloud being written.

A leaf that calls `spatialContextFrom` while its caller already holds a context
has re-opened the divergence this closes.

## How to read the table

- **Status** — `migrated` means the file imports the context and reads its
  fields. `carrier` means it reads a fact the context computed, carried to it on
  an export model, and derives nothing itself. `pending` means it still derives
  its own answer.
- **Routes through** — the file(s) the gate checks. Every `migrated` path must
  import `geo/SpatialContext` or `geo/frameCompatibility`; every `migrated` and
  `carrier` path must be free of the deprecated predicates listed below.
- **Reads** — the context fields it now uses.

## Inventory (13 consumers)

| # | Consumer | Status | Routes through | Reads |
|---|----------|--------|----------------|-------|
| 1 | Point inspection | migrated | `src/render/pointInfo.ts` | `linearUnit`, `verticalReference`, `verticalUnitToMetres` |
| 2 | Scan report | migrated | `src/analysis/modules/scanReport.ts` | `linearUnitKnown`, `linearUnitToMetres` |
| 3 | Space / object report | migrated | `src/main.ts` | `linearUnitToMetres`, `linearUnitKnown` |
| 4 | Stockpile and cut/fill volume | migrated | `src/main.ts` | `linearUnitToMetres`, `linearUnitKnown`, `verticalMetresPerUnit` |
| 5 | Density and fitness grades | migrated | `src/render/streaming/runFullCloudGradeAction.ts` | `linearUnitKnown`, `linearUnitToMetres`, `verticalMetresPerUnit` |
| 6 | Terrain analysis | migrated | `src/app/terrainAnalysisRunner.ts` | `isGeographic`, `linearUnitToMetres`, `epsg`, `verticalEpsg`, `verticalDatum`, `crsName`, `kind`, `verticalMetresPerUnit` |
| 7 | Epoch comparison | migrated | `src/app/epochFramePrep.ts`, `src/geo/frameCompatibility.ts`, `src/main.ts` | `isGeographic`, `linearUnitKnown`, `linearUnitToMetres`, `verticalReference`, `verticalUnitToMetres`, `verticalScaleKnown` |
| 8 | Contours | carrier | `src/terrain/contour/geojsonContours.ts` | `verticalReference`, carried on `ContourFeatureModel` |
| 9 | PDF reports | migrated | `src/app/reportExport.ts` | `linearUnitKnown`, `linearUnitToMetres`, `verticalUnitToMetres` |
| 10 | LAS export | migrated | `src/convert/convertCloud.ts` | `linearUnit`, `verticalLinearUnit`, `verticalEpsg` |
| 11 | GeoJSON / KML / DXF export | migrated | `src/main.ts`, `src/app/kmlActions.ts`, `src/export/scanFootprint.ts` | `isGeographic`, `verticalDatum`, `verticalMetresPerUnit`, `upAxis` |
| 12 | Measurement labels | migrated | `src/main.ts` | `linearUnitToMetres`, `linearUnitKnown`, `isGeographic`, `verticalMetresPerUnit` |
| 13 | Elevation colorbars | migrated | `src/main.ts`, `src/app/terrainAnalysisRunner.ts` | `verticalMetresPerUnit`, `kind` |

## Deprecated predicates

These are the hand-rolled forms the context replaced. The gate rejects them
inside any `migrated` or `carrier` file:

| Banned form | Read instead |
|---|---|
| `isLinearUnitKnown(crs)` | `ctx.linearUnitKnown`, or `ctx.metricClaimsPermitted` for the full gate |
| `verticalReferenceFromDatum(…)` | `ctx.verticalReference` / `ctx.verticalReferenceKnown` |
| `validateCrsForMeasurement(…)` | `ctx.metricValidity` / `ctx.metricSeverity` |
| `crs.kind === 'geographic'` | `ctx.isGeographic` |
| `verticalUnitToMetres ?? linearUnitToMetres` | `verticalMetresPerUnit(ctx, policy)` with the policy named |
| A local WGS 84 3D allow-list spelled out by code | the carried `verticalReference === 'ellipsoidal'` |

`src/geo/CoordinateTypes.ts`, `src/geo/CrsValidation.ts`, `src/geo/height.ts`
and `src/geo/CrsService.ts` are the definitions themselves rather than
consumers. The façade is built on top of them, so they are not checked.

## The vertical-fallback policies

A missing vertical unit has three defensible answers, and the tree used to spell
all three as `??` chains that look alike. `verticalMetresPerUnit(ctx, policy)`
names them:

- `'none'` — no fallback. Correct wherever the output states a metre value for a
  height (RFC 7946 ordinates, KML `absolute`): a horizontal unit is not evidence
  about Z.
- `'horizontal-when-known'` — fall back only when the horizontal factor is
  itself a real declared unit. Correct for a label that names the unit.
- `'horizontal'` — the GeoTIFF convention as written. Correct only where a
  factor keeps a GEOMETRY self-consistent (grid spacing, cell floors) rather
  than making a claim.

A declared but degenerate vertical factor (zero, negative, non-finite) fails
closed under every policy: the source is corrupt, and borrowing the horizontal
factor would answer a question the file already answered wrongly.

## Seams inside routed consumers that still derive

Every row above is routed. Three seams inside those consumers still hold their
own derivation, and they are named here rather than hidden:

- **`src/analysis/streamingExtentRows.ts`** takes a structural CRS subset rather
  than a context, so the streaming Scan Report's extent rows still call
  `isLinearUnitKnown` directly. Its signature is exercised by six existing test
  call sites; changing it is a separate, mechanical change.
- **`src/main.ts`'s contour-export `linearUnit`** still reads
  `crsService.current()?.linearUnit`, because "no scan open yet" and "a scan
  whose CRS is unknown" are two different answers there and the context
  deliberately collapses both to the unknown frame. Routing it would flip the
  DXF `$INSUNITS` default for an export taken before the CRS resolves.
- **`src/render/measure/volume.ts`** and `stockpileVolume.ts` are pure geometry
  over source-local coordinates and hold no CRS at all. Their unit gate lives at
  the call site, which is routed (row 4). They are correct un-migrated, and
  handing them a context would be ceremony.

## Fail-closed behaviour this migration preserves

- An unknown linear unit still yields source-unit extents with no metre claim.
  The context reports the inert placeholder factor 1 in `linearUnitToMetres`,
  and `linearUnitKnown` is what every consumer gates on, so the placeholder is
  never multiplied into a metre figure.
- A missing vertical unit still produces no metre height. `verticalScaleKnown`
  is `false` and `verticalMetresPerUnit(ctx, 'none')` returns `undefined`, which
  the KML writer and the RFC 7946 writer both treat as "withhold".
- Geographic degrees still never enter a linear metric. `isGeographic` fails the
  ladder, so `metricClaimsPermitted` is `false`, and the epoch comparison
  refuses volumes on a degree grid rather than printing degree² figures as m³.
- A frame that was never declared still reads as unverified, not as a match.
  `declaredFrameLabel` returns `null` rather than the display placeholder, so two
  undeclared scans cannot compare equal and claim a shared frame.
