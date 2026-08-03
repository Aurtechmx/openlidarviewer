# SpatialContext — consumer inventory and routing order

`src/geo/SpatialContext.ts` is one explicit description of the frame a dataset's
coordinates live in: horizontal CRS and linear unit, vertical unit and datum
reference, up axis, project-frame placement, and the single fail-closed gate
`metricClaimsPermitted`. It is a façade over pieces that already exist
(`isLinearUnitKnown`, the `CrsValidation` ladder, `verticalReferenceFromDatum`,
`ProjectSpatialFrame`), not a new source of truth.

This file is the inventory of the consumers that each re-derive unit, datum,
axis, or frame today, and the order they should later route through
`SpatialContext`. **No consumer is routed in the PR that adds this document.**
Routing is the atomic follow-up: the value of the model is that every consumer
reads the same object, and that only lands when they all move to it.

## Why the inventory matters

Each row below answers the same few questions — *what is the linear unit, is it
known, what is the vertical datum, which axis is up, is this a metric-safe frame*
— from its own reading of `metadata.crs` / a `ResolvedCrs`. When two rows answer
differently, the output is plausible but wrong on unit or axis, which is the
defect class the coordinate-integrity roadmap exists to close. Centralising the
answer removes the opportunity to diverge.

## How to read the table

- **Derives today at** — the file:line where the consumer currently reads a unit,
  datum, or axis from CRS metadata.
- **Reads** — the fact(s) it derives.
- **Route to** — the `SpatialContext` field(s) it should read instead.

## Inventory (13 consumers)

| # | Consumer | Derives today at | Reads | Route to |
|---|----------|------------------|-------|----------|
| 1 | Point inspection | `src/render/pointInfo.ts:121`, `:137`–`:149` (`pointVerticalReference` → `verticalReferenceFromDatum`); axis at `src/main.ts:5160` | linear unit for axis suffix; vertical reference; up axis | `linearUnit`, `verticalReference`, `verticalUnitToMetres`, `upAxis` |
| 2 | Scan report | `src/analysis/modules/scanReport.ts:67`–`:68` (`scanReportUnitBasis`, `isLinearUnitKnown`) | linear unit known; unit-to-metres | `linearUnitKnown`, `linearUnitToMetres`, `metricClaimsPermitted` |
| 3 | Space / object report | `src/render/measure/spaceReportPdf.ts:39` (`unitToMetres`); `src/terrain/space/spaceReportLayout.ts` | horizontal unit-to-metres | `linearUnitToMetres`, `metricClaimsPermitted` |
| 4 | Stockpile volume | `src/render/measure/volume.ts:118` (`horizontalBasis`), `:212` (pts/m² via `linearUnitToMetres`); lasso density at `src/main.ts:559`–`:564` | up-axis basis; unit-to-metres; unit known | `upAxis`, `linearUnitToMetres`, `metricClaimsPermitted` |
| 5 | Density & fitness grades | `src/render/streaming/sampleGrade.ts:42`, `:205` (areal density); gate at `src/main.ts:3397`–`:3402` (`unitToMetres`, `isLinearUnitKnown`) | areal basis; unit-to-metres; unit known | `linearUnitToMetres`, `metricClaimsPermitted` |
| 6 | Terrain analysis | `src/app/terrainAnalysisRunner.ts:82`–`:119`, `:361`–`:367` (`linearUnitToMetres`, `verticalUnitToMetres`, `verticalDatum`) | horizontal + vertical unit-to-metres; vertical datum | `linearUnitToMetres`, `verticalUnitToMetres`, `verticalReference`, `verticalDatum`, `upAxis` |
| 7 | Epoch comparison | `src/terrain/change/compareDtms.ts:51`–`:90` (`isGeographic`, `horizontalUnitKnown`, `frameIncompatible`); fed from `src/main.ts:6605`–`:6663` | geographic flag; unit known both epochs; vertical datum match | `isGeographic`, `linearUnitKnown`, `verticalReference`, `verticalDatum`, `metricClaimsPermitted` |
| 8 | Contours | `src/terrain/contour/geojsonContours.ts:178` (`isWgs84EllipsoidalHeight`), `:245` (`verticalUnitToMetres`); `src/terrain/contour/contourFeatureModel.ts:74`–`:83` | vertical datum (RFC-7946 allow-list); vertical unit-to-metres | `verticalReference`, `verticalUnitToMetres`, `verticalDatum` |
| 9 | PDF reports | `src/render/measure/mapSheetPdf.ts` (`SceneUpAxis`); `src/render/measure/terrainReportPdf.ts`; `src/render/measure/spaceReportPdf.ts:39` | up axis; unit-to-metres; datum labels | `upAxis`, `linearUnitToMetres`, `verticalReference`, `metricClaimsPermitted` |
| 10 | LAS export | `src/convert/writeLas.ts:54`–`:67` (`linearUnitCode`, `verticalDatum` EPSG, `verticalUnitCode`) | horizontal unit code; vertical datum EPSG; vertical unit code | `linearUnit`, `verticalEpsg`, `verticalUnitToMetres`, `epsg` |
| 11 | GeoJSON / KML / DXF export | KML `src/export/kmlExport.ts:113`, `:226`, `:298` (`verticalDatum`, `unitToMetres`); GeoJSON `src/terrain/contour/geojsonContours.ts:245`; DXF `src/terrain/contour/dxfContours.ts:62`, `:128` (`$INSUNITS`) | vertical datum / altitude mode; unit-to-metres; DXF linear unit | `verticalReference`, `verticalDatum`, `linearUnit`, `linearUnitToMetres`, `metricClaimsPermitted` |
| 12 | Measurement labels | `src/render/measure/annotationMapProjection.ts:37` (`SceneUpAxis`); unit fed via `src/main.ts:2208` (`setUnitToMetres`), datum via `:2180` | up axis; unit-to-metres; vertical datum | `upAxis`, `linearUnitToMetres`, `verticalUnitToMetres`, `verticalReference` |
| 13 | Elevation colorbars | `src/render/colorbar.ts` (ramp domain); range at `src/geo/projectElevationRange.ts`; vertical scaling at `src/ui/contourStudioMount.ts:97` (`verticalUnitToMetres`); datum label from `crs.verticalDatum` in the panel context | vertical unit-to-metres; vertical datum for the axis label | `verticalUnitToMetres`, `verticalReference`, `verticalDatum` |

The measurement path (`src/main.ts:2193`–`:2238`) is the seam that currently
assembles a bespoke "map context" for several of these consumers (labels, PDF,
colorbars). That assembly point is where a `SpatialContext` should be built once
and handed down, rather than each consumer re-reading `crsService.current()`.

## Proposed routing order

Route in blast-radius order: read-only display first (a wrong reading is visible
and reversible), the internal metric gates next, comparison and contours after,
and the exporters last (a wrong reading there ships in a file a reader trusts).

1. **Phase A — read-only display.** Point inspection (1), measurement labels
   (12), elevation colorbars (13), scan report (2). These render what the model
   already carries and persist nothing, so they validate `spatialContextFrom`
   against live data at the lowest cost. Point inspection is the natural first
   move: it already calls `verticalReferenceFromDatum` directly, so the swap is
   one field read.
2. **Phase B — metric gates.** Stockpile volume (4), density & fitness grades
   (5), terrain analysis (6), space / object report (3). Each already fails
   closed on an unknown unit with its own check; replace that ad-hoc gate with
   the single `metricClaimsPermitted`, so the fail-closed rule has one
   definition.
3. **Phase C — comparison and contours.** Epoch comparison (7), contours (8).
   Comparison must decide frame compatibility from two contexts; giving it two
   `SpatialContext` objects makes "same unit, same datum, same axis" one
   comparison instead of several. Contours' RFC-7946 ellipsoidal-height
   allow-list becomes a read of `verticalReference === 'ellipsoidal'`.
4. **Phase D — exporters.** PDF reports (9), LAS export (10), GeoJSON / KML / DXF
   export (11). Highest stakes and the roadmap's "one effective spatial context
   per export" (P0 #9): the file's coordinates, its labels, and its embedded CRS
   metadata should all come from one context so an override can never label a
   file with a CRS it did not use.

## Not in this PR

The PR that adds `SpatialContext.ts`, its matrix test, and this inventory routes
**zero** consumers. `SpatialContext.ts` has no importers yet, by design: a
half-migrated tree where some consumers read the model and others still re-derive
is worse than today's, because the two can disagree silently. The migration lands
consumer by consumer, in the phases above, each behind the existing gates.
