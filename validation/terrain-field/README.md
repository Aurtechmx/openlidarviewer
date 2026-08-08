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

## The StREAM Lab leg (survey-classified riparian drone data)

A 40 × 40 m riparian crop of the VT StREAM Lab drone survey (OpenTopography DOI 10.5069/G9NZ85W7), decimated 1:160 to ~8 pts/m² (deterministic, so reproducible). Unlike the bare desert, this crop is **survey-classified** with real above-ground returns — ground, high vegetation, unclassified — so OLV's classifier can be checked against a published classification.

| Leg | What it checks | Result |
|---|---|---|
| Ground classification | OLV `deriveClassification` (with the crop's RGB + return counts, the cues the survey classifier had) vs the survey's class 2 | ground **recall 0.976**, vegetation **precision 0.976** |
| DTM on survey ground | OLV vs the scipy point-in-cell mean on the survey's class-2 returns | max 0.09 mm, RMSE 0.03 mm |

**Why recall and vegetation-precision, not ground-precision.** OLV's ground is more *inclusive* than the survey's: the survey leaves ambiguous near-ground returns Unclassified, and OLV assigns those to ground, so ground precision against the survey's conservative class 2 measures a definitional difference, not an error. The honest, robust statements are that OLV catches the survey's ground (recall) and that when OLV calls a point vegetation it really is vegetation (precision). Both hold above 0.95 on real riparian terrain. The DTM leg is the same point-in-cell check as White Sands, confirming the gridding on ultra-dense drone data at a different UTM zone.

## Reliability studies (beyond the reference comparisons)

The harness also carries the reliability invariants the terrain-hardening pass asks for, built on shared validation-only numerics (`src/validation/terrainMetrics.ts`, `src/validation/evidenceMonotonicity.ts`):

- **Comparators** — MAE, RMSE, median absolute error, signed bias, max, and coverage / rejection fractions, plus a wraparound-safe circular aspect comparator so 359° and 1° read as 2° apart (`tests/terrainMetrics.test.ts`).
- **Density perturbation** — a deterministic 1:1 → 1:64 thinning of the real White Sands ground shows coverage falling 1.00 → 0.19 and RMSE rising to ~3.4 cm as support weakens, reproducibly (`tests/terrainFieldValidation.test.ts`). Input degrades → coverage drops → error grows, on real data.
- **Boundary behaviour** — slope/aspect error grouped by distance from an artificial crop edge: the interior (≥ 1 cell in) matches the full-surface truth exactly, and only the edge ring carries the kernel's clamp error (`tests/terrainBoundary.test.ts`).
- **Evidence monotonicity** — a derived product may never out-rank its source: readiness, product-grade, coverage and export-evidence ladders, with resident-only / sampled never promotable to full (`tests/evidenceMonotonicity.test.ts`).

## Boundaries

This validates OLV's DTM **gridding** against independent implementations on real ground (two datasets, two UTM zones), and OLV's **ground classification** against a real survey classification. It does not on its own establish survey-grade accuracy (that needs surveyed ground control), and it does not yet cover: the StREAM Lab published 0.1 m DTM/CHM as a raster reference (needs the published product downloaded), ground extraction under the Hyytiälä forest canopy, and coastal ground + structure classification on the Pangandaran dataset. Those are the next crops, staged in `datasets/manifest.json`.
