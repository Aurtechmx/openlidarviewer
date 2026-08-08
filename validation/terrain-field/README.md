# Terrain field-validation harness

Runs OLV's terrain outputs against **real airborne LiDAR** — public, DOI-cited datasets — using **independent implementations** and **controlled boundary crops**. This is the field-data counterpart to the synthetic cross-implementation checks under `validation/cross-implementation/`: those prove the algorithms match GDAL on surfaces with a closed-form answer; this proves they behave on real ground that OLV did not generate.

## What runs where

- `datasets/manifest.json` — the source clouds (USGS 3DEP White Sands; VT StREAM Lab; Hyytiälä UAV), each with its DOI/source, CRS, vertical datum, and the sha256 of the file the crops were cut from. The raw clouds are **not** committed (they are 36 MB–1.7 GB); the crops are.
- `crops/*.crop.json` + `crops/*.f32` — a frozen boundary crop: its UTM bounds, the grid, and the packed ground points OLV consumes.
- `references/*.asc` — the independent reference grids over the same crop.
- `tests/terrainFieldValidation.test.ts` — drives OLV's real terrain core headless and compares. Skips when a reference is absent; the references are committed, so it runs in CI with no PDAL/GDAL/scipy and no raw cloud present.
- `scripts/terrain-field/generate-*.mjs` — the reproduction record (exact PDAL/scipy/GDAL commands). Not run in CI.

## The White Sands leg (bare-earth dunes)

A 100 × 100 m interior crop of USGS 3DEP LPC over gypsum dunes, NAD83(2011) / UTM 13N + NAVD88, class-2 ground only (46,451 returns, 2.2 m of relief around 1237 m). Two comparisons:

| Leg | Reference | What it proves | Result |
|---|---|---|---|
| Gridding correctness | **scipy** `binned_statistic_2d` mean — the *same* point-in-cell operation, a separate codebase | OLV bins and averages real UTM coordinates and NAVD88 elevations correctly | max 0.13 mm, RMSE 0.05 mm |
| Independent standard tool | **PDAL** `writers.gdal` mean — a *different* aggregation (radial ~1.41 m window) | OLV agrees with a mainstream geospatial tool within the data's own accuracy | RMSE 3.1 cm, 99 % within 10 cm |

The gridding leg is tight because both compute the identical quantity. The PDAL leg carries a real, documented method difference: `writers.gdal` averages points within a radius of each cell centre, so it differs from a point-in-cell mean by the local slope across the window — largest on steep dune cells (max ~19 cm), still inside USGS 3DEP's stated ~10 cm vertical accuracy. The tolerance for that leg is that product-spec accuracy, chosen from the specification, not from the observed number.

## Why this is not circular

OLV and the references grid the **same committed ground points** to the **same grid**, each with its own implementation. Agreement means OLV's rasteriser assigns cells, handles edges, and carries the elevation range the way independent tools do — exercised on data from a national mapping programme, not a fixture OLV wrote.

## Reproducing

See the header of `scripts/terrain-field/generate-whitesands-reference.mjs` for the exact commands. The bounds and grid are frozen in `crops/whitesands-dune.crop.json`; `SHA256SUMS` pins every committed fixture. Tool versions behind the committed references: GDAL 3.13.1, scipy 1.17.1, numpy 2.4.6.

## Boundaries

This validates OLV's DTM **gridding** against independent implementations on real ground. It does not on its own establish survey-grade accuracy (that needs surveyed ground control), and it does not yet cover the harder legs — ground *classification* precision/recall against the published class 2, the CHM against the StREAM Lab published product, and ground extraction under the Hyytiälä forest canopy — which are the next crops to add.
