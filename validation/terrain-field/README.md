# Terrain field-validation harness

Runs OLV's terrain outputs against **real airborne LiDAR** — public, DOI-cited datasets — using **independent implementations** and **controlled boundary crops**. This is the field-data counterpart to the synthetic cross-implementation checks under `validation/cross-implementation/`: those prove the algorithms match GDAL on surfaces with a closed-form answer; this proves they behave on real ground that OLV did not generate.

## What runs where

- `datasets/manifest.json` — the source clouds (USGS 3DEP White Sands; VT StREAM Lab; Hyytiälä UAV), each with its DOI/source, CRS, vertical datum, and the sha256 of the file the crops were cut from. The raw clouds are **not** committed (they are 36 MB–1.7 GB); the crops are.
- `crops/*.crop.json` + `crops/*.f32` — a frozen boundary crop: its UTM bounds, the grid, and the packed ground points OLV consumes. Each crop names the acquisition it was cut from with the manifest's `sourceId`.

`sourceId` is a handle local to this harness. It names an acquisition as its publisher distributes it, and it is **not** a `datasetId` in `validation/datasets/dataset-register.yaml`; nothing here resolves there. The register demands a named licence and a digest for bytes that were fetched, and three of these acquisitions have neither recorded: the raw StREAM Lab, Hyytiälä and Pangandaran clouds carry no sha256, and the Zenodo terms behind the last two were never resolved to a named licence. Registering them would mean writing provenance nobody measured, so the harness keeps a name that claims nothing. `scripts/lint-terrain-field-ids.mjs` (`npm run lint:terrain-field-ids`, in the release gate) fails if the `datasetId` name returns or if a crop cites a handle no manifest record declares.
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

### Against the survey team's own published DTM

`references/sl-field__published-dtm.asc` is the 0.1 m DTM the survey team
published beside the point cloud (OpenTopography DOI 10.5069/G9NZ85W7),
aggregated by mean onto the crop's 1 m grid. It shares no code and no method
with OLV, which makes it a different kind of reference from the bin-cell grid
above: that one is scipy computing the same statistic and agreeing to
3.4 × 10⁻⁵ m, this one is another team's product.

| | |
|---|---|
| Cells measured by both | 1,071 of 1,600 |
| Mean difference | +0.0153 m |
| RMSE | 0.0716 m |
| Within 0.10 m | 91.3 % |

Three asymmetries make this a product-agreement bound rather than an accuracy
figure. The committed crop is decimated 1:160, about 8 pts/m² against the
survey's 1,295, so the published product saw 160 times more ground. Their
method interpolates a continuous surface at 0.1 m where OLV takes the mean of
the ground returns that land in each 1 m cell. And their DTM fills all 1,600
cells because voids and the stream channel are interpolated, the channel
carrying interpolated bathymetry rather than measured bed, so only cells where
both carry a value are compared and OLV is never scored against an invented
elevation. Restricting to open ground under 0.5 m of canopy barely moves the
result (RMSE 0.0734 m), so the disagreement is not a canopy artifact.

Neither surface is a check shot. Agreement between two derived products is not
accuracy against surveyed ground.

## The Estonia leg (Lambert Conformal Conic national survey)

A 100 × 100 m interior crop of the Estonian Land Board 2020 national LiDAR (tile 568539, Zenodo DOI 10.5281/zenodo.19232743, CC BY 4.0). Its coordinate system is **L-EST97 / Lambert Conformal Conic (EPSG:3301)** with an EH2000 vertical datum — a third projection family beside the UTM/TM White Sands and StREAM crops, so it checks OLV grids LCC easting/northing correctly. Flat boreal plain, ~1.6 m of relief, 12,571 class-2 ground returns.

| Leg | Reference | What it proves | Result |
|---|---|---|---|
| Gridding correctness | **scipy** `binned_statistic_2d` mean | OLV bins and averages real LCC coordinates correctly | max 0.04 mm, RMSE 0.01 mm |

## The Marsh Island leg — absolute accuracy vs INDEPENDENT surveyed checkpoints

The other legs compare OLV to an independent *implementation* on the same points. This one compares OLV to independent *surveyed ground truth*: the USGS Marsh Island / New Bedford MA UAS survey (Over et al. 2024, DOI 10.5066/P19TLXVG, CC0 / public domain) ships **104 RTK check shots** (Emlid RS3) that are separate from the aerial control points. The classified point cloud's Z and the checkpoints are both **NAVD88 orthometric** in NAD83(2011) UTM 19N, so they compare with no vertical-datum reconciliation.

OLV grids the committed class-2 ground with the production `rasterizeDtm` (point-in-cell mean), and each checkpoint is compared to the DTM cell it falls in. Matching protocol, fixed before the accuracy was computed: nearest cell, no interpolation; a checkpoint whose cell has no classified ground is rejected; a residual over 1 m is a gross outlier (a check shot above the bare-earth surface) reported separately on a physical 1 m threshold.

| Metric | OLV DTM vs checkpoints |
|---|---|
| N used / rejected | 101 / 3 (no classified ground) |
| RMSE | 2.8 cm |
| MAE | 2.3 cm |
| median \|err\| | 1.8 cm |
| signed bias | −0.2 cm |
| max \|err\| | 8.2 cm |

The asserted bounds in the test come from the accuracy budget (RTK ~2 cm + a UAS bare-earth product's ~10 cm class), not from these figures. This is OLV's first absolute-accuracy result against surveyed truth; the datum matches, so it is not limited by geoid reconciliation.

## The Coconino leg — absolute accuracy in steep, forested terrain

Marsh Island is flat coastal marsh. This leg adds the hard case it does not cover: bare-earth extraction **under canopy**. Source is the USGS AZ Coconino B1 2019 airborne LiDAR (Atlantic project 19049; NGTOC task order 140G0219F0247), public domain via the USGS 3D Elevation Program. Its aerial-accuracy checkpoints (NVA + VVA, project-report Tables 8/9) are held **separate from the 12 LiDAR Control Points**, so they are an independent vertical-accuracy set, not reused for calibration. Checkpoints are reprojected from UTM 12N to the tile CRS (NAD83(2011) / Conus Albers, EPSG:6350); tile Z and checkpoint Z are both **NAVD88 orthometric (Geoid12B)**, so there is no vertical-datum reconciliation.

The checkpoints are sparse — 1–2 per 1 km tile across the whole ~50×110 km project — so a given tile usually contains none. The committed tile `w1407n1486` contains exactly one: **TR03**, a *vegetated* (VVA) checkpoint at 2567.66 m in forest (+2.8 cm residual there). The leg has since grown the way the harness was built to: `coconino-metrics.json` records **13 checkpoints (6 NVA + 7 VVA) across 8 project tiles**, pooled RMSEz 8.65 cm, each tile gridded with the production `rasterizeDtm` at 1.0 m (the USGS 3DEP QL2 bare-earth DEM resolution) and each checkpoint compared to its DTM cell.

| Metric | OLV DTM vs USGS aerial checkpoints |
|---|---|
| N used / rejected | 13 / 0 (6 NVA + 7 VVA, 8 tiles) |
| pooled RMSEz (1 m cell) | 8.65 cm |
| committed-tile TR03 (forest VVA) | +2.8 cm |

The per-checkpoint bound in the test is the USGS accuracy class for the checkpoint's type (NVA 0.30 m, VVA 0.60 m), not a figure fitted to the result. Thirteen checkpoints are still a small sample, not a distribution to certify against, and the fixture and test grow with N automatically as more project tiles are added (`scripts/terrain-field/generate-coconino-reference.py <tile.laz ...>`).

## The Coconino slope/aspect leg (real steep terrain)

The slope/aspect cross-checks otherwise run on a synthetic analytic DEM and on flat White Sands. This leg adds real steep ground: a 150 × 150 m crop of the same Coconino tile with 40 m of relief, local slopes to ~45° in conifer forest, gridded to a 1 m point-in-cell DTM. OLV's `hornSlopeAspect` is compared two ways on that DTM (`tests/coconinoSlopeAspect.test.ts`):

| Reference | What it proves | Result |
|---|---|---|
| **NumPy Horn** — same convention, separate codebase, 735 frozen interior cells | the implementation on steep real ground | max 3e-8 (slope), 1e-7 rad (aspect) |
| **gdaldem 3.13.1** `slope -alg Horn` — a different tool | OLV agrees with a mainstream tool on real steep terrain | max 0.013°, mean 0.003° over 19,834 cells |

This broadens the slope cross-implementation evidence from the analytic surface to national-survey terrain. It does not, on its own, promote the claim beyond E4 — it is still cross-implementation agreement, not accuracy against surveyed truth. Reproduction: `scripts/terrain-field/generate-coconino-slope-reference.md`.

## Reliability studies (beyond the reference comparisons)

The harness also carries the reliability invariants the terrain-hardening pass asks for, built on shared validation-only numerics (`src/validation/terrainMetrics.ts`, `src/validation/evidenceMonotonicity.ts`):

- **Comparators** — MAE, RMSE, median absolute error, signed bias, max, and coverage / rejection fractions, plus a wraparound-safe circular aspect comparator so 359° and 1° read as 2° apart (`tests/terrainMetrics.test.ts`).
- **Density perturbation** — a deterministic 1:1 → 1:64 thinning of the real White Sands ground shows coverage falling 1.00 → 0.19 and RMSE rising to ~3.4 cm as support weakens, reproducibly (`tests/terrainFieldValidation.test.ts`). Input degrades → coverage drops → error grows, on real data.
- **Boundary behaviour** — slope/aspect error grouped by distance from an artificial crop edge: the interior (≥ 1 cell in) matches the full-surface truth exactly, and only the edge ring carries the kernel's clamp error (`tests/terrainBoundary.test.ts`).
- **Evidence monotonicity** — a derived product may never out-rank its source: readiness, product-grade, coverage and export-evidence ladders, with resident-only / sampled never promotable to full (`tests/evidenceMonotonicity.test.ts`).
- **Capability ↔ evidence agreement** — the ProcessPlan evaluator and the evidence-monotonicity guard can't disagree: degrading coverage or losing unit trust only weakens a verdict, each step is a valid non-promoting evidence transition, and the evaluator is idempotent (`tests/processPlanInvariants.test.ts`).
- **Fail-closed counterfactuals** — every guard paired with the one fact that, flipped, would let the product through, so a dead guard shows up as an already-ready counterfactual; a missing fact reads as the closed state, never a default (`tests/failClosedCounterfactuals.test.ts`).
- **Full-pipeline benchmark** — points → DTM → slope/aspect → contours on the real crop, checked for well-formed stages and byte-identical determinism across two runs; stage times logged, never asserted (`tests/terrainPipelineBenchmark.test.ts`).
- **Evidence re-evaluation** — the assessment surface is idempotent and one-directional: re-running never upgrades a level, and a cross-check with no real matching reference stays pending, never agree (`tests/evidenceReEval.test.ts`).

## Running it

```
npm run validate:terrain
```

runs every leg against the committed references and prints one verdict:

- **PASS** — every declared leg ran and agreed.
- **REVIEW** — nothing disagreed, but a leg was skipped because its reference or crop fixture was absent (a fresh checkout mid-generation), so coverage was partial and PASS cannot be claimed.
- **FAIL** — a leg disagreed with its reference.

The command is an orchestrator: the legs live in the harness test files and every number comes from the real terrain core and the shared comparators. It exits non-zero only on FAIL, so a checkout missing an optional fixture reviews rather than breaks. `--json` prints the machine-readable report; `--out PATH` also writes it. The report shape is defined and rolled up in `src/validation/terrainReport.ts` (PASS only when every leg ran and passed — the single source of truth for the verdict rule).

## Boundaries

This validates OLV's DTM **gridding** against independent implementations on real ground (two datasets, two UTM zones), and OLV's **ground classification** against a real survey classification. It does not on its own establish survey-grade accuracy (that needs surveyed ground control), and it does not yet cover: the StREAM Lab published 0.1 m CHM as a raster reference, ground extraction under the Hyytiälä forest canopy, and coastal ground + structure classification on the Pangandaran dataset. Those are the next crops, staged in `datasets/manifest.json`.
