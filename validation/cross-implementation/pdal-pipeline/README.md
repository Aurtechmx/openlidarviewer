# PDAL pipeline studies — ground filtering, DTM and DSM

Extends the cross-implementation evidence from rasters to the point-cloud end of
the pipeline. The raster matrix next door starts from a DEM and compares kernels
against GDAL; these three studies start from returns.

This directory **promotes nothing**. `docs/validation/claim-register.yaml` and
`REFERENCE_SLOTS` in `src/validation/crossCheck.ts` are untouched.

## Evidence level

The scenes here are synthetic and their ground membership is known by
construction, so comparing our filter against those labels is **E3** — one
implementation against a generator this project also wrote, however many scenes
there are. It is **E4** only where a second independent implementation produced
the reference, which is PDAL, recorded in `reference-runs.json`. Every leg in
`results.json` carries `reference` and `evidenceLevel`. **Eight fixtures is not
E4 breadth, and a synthetic cloud is not a survey.**

## The three studies

| study | manifest | what it compares |
| --- | --- | --- |
| ground filtering | `../studies/GROUND-FILTER-PDAL-SMRF.study.json` | our `classifyGroundSmrf` against `filters.smrf`, per return, on five scenes |
| DTM | `../studies/DTM-PDAL-WRITERS-GDAL.study.json` | our `rasterizeDtm` (min) against `writers.gdal` `output_type: min`, per cell, on three scenes |
| DSM | `../studies/DSM-PDAL-WRITERS-GDAL.study.json` | our `buildDsm` (max) against `writers.gdal` `output_type: max`, per cell, on three scenes |

Every tolerance was registered at `pending` before its study ran, and each is
covered by the manifest's `protocolDigest`.

The DSM study is the DTM study with min → max. It uses its own cell-centred
scenes (`pc-09..11`) that stack roof, facade and canopy returns above the ground
return, so the per-cell maximum (the top surface) sits above the minimum (the
bare earth) and the study tests upper-surface selection rather than re-running
the DTM grid check. The scenes are cell-centred for the same estimator reason
the DTM scenes are: every above-ground return is placed at the cell centre so
`writers.gdal`'s radius disc and `buildDsm`'s square cell hold the same set and
their maxima are comparable at float32 spacing. A scattered scene with structure
(`pc-01..05`) could not be used — a disc is not a square, and no tolerance near
float32 spacing would hold.

## Reference pinning

| item | value |
| --- | --- |
| `pdal --version` | `pdal 2.10.2 (git-version: Release)` |
| resolved `pdal` | recorded in `reference-runs.json` under `environment.pdalResolvedPath` |
| resolved `gdal_translate` | recorded in `reference-runs.json` under `environment.gdalTranslateResolvedPath` |
| container pinning | `not-executed` — the Docker daemon is not running on this host, so PDAL was invoked from the host PATH |

Every pipeline is a committed file under `pipelines/`, and every argv, exit code
and stderr is in `reference-runs.json`. Filenames inside them are repo-relative
and each command runs with the repository root as its working directory.

## Why the DTM run has two commands

`writers.gdal` creates rasters through the GDAL Create API and the AAIGrid driver
is CreateCopy-only, so asking for it exits 1. The raster is written as GeoTIFF —
the byte record of what PDAL computed — and `gdal_translate` transcodes it to the
text grid the test parses. Both files are committed and both hashes are recorded.

## Why the DTM fixtures are gridded

`writers.gdal` is a radius estimator: a cell takes its value from every point
within `radius` of the cell centre. `rasterizeDtm` is a cell estimator: a point
contributes to the one cell it falls in. A disc is not a square, so on a
scattered cloud over sloping ground the two cannot agree exactly however the
parameters are set, and a tolerance wide enough to absorb the difference would be
too wide to catch a real fault.

One return per cell centre with `radius` below half a cell removes the confound.
What the study then tests is the georeferencing — grid origin, cell indexing and
row order — and **not** aggregation over a realistic cloud. That question is left
open rather than answered with a gate that could not fail.

## Row order

`writers.gdal` writes north first, as a GeoTIFF and an ESRI ASCII Grid both do.
`rasterizeDtm` indexes row 0 at the minimum of the second horizontal axis, which
is south. The comparison flips one side and says so; the v0.4.3 aspect mirror
recorded in `src/terrain/ground/terrainDerivatives.ts` came from getting exactly
this wrong, and the rolling and ridge fixtures vary in y precisely so a flip
cannot pass.

## Layout

| path | contents |
| --- | --- |
| `fixtures/` | eight point clouds as CSV, plus the by-construction ground labels as `.truth` |
| `fixtures.json` | fixture manifest: geometry, surface, point counts, hashes |
| `fixture-SHA256SUMS` | hash per fixture file |
| `pipelines/` | one committed PDAL pipeline per run |
| `pdal/` | the PDAL outputs |
| `pdal-SHA256SUMS` | hash per PDAL output |
| `olv/` | the same products computed by this project, for side-by-side diffing |
| `olv-SHA256SUMS` | hash per OLV output for the ground-filter and DTM studies |
| `olv-dsm-SHA256SUMS` | hash per OLV output for the DSM study |
| `reference-runs.json` | environment, argv, exit code and stderr for the ground-filter and DTM invocations |
| `reference-runs-dsm.json` | the same, for the DSM invocations, kept separate so the DSM study never rewrites the older studies' provenance |
| `pdal-dsm-SHA256SUMS` | hash per PDAL DSM output |
| `results-ground-filter.json` | the five ground legs, with the boundaries found |
| `results-dtm.json` | the three DTM legs, with the boundaries found |
| `results-dsm.json` | the three DSM legs, with the boundaries found |

One results file per study rather than one for all: a manifest names the raw
artifacts a derived summary came from and carries a digest over them, and a
combined file could not be true to every derivation. The DSM reference is written
into its own `reference-runs-dsm.json` for the same reason — the ground-filter
and DTM manifests already froze the exact bytes of `reference-runs.json`, and a
new study may not rewrite an old study's provenance to record its own.

## Reproducing

```
node scripts/generate-point-cloud-fixtures.mjs
node scripts/run-pdal-reference.mjs
node scripts/run-pdal-dsm-reference.mjs
npx vitest run tests/groundFilterPdalAgreement.test.ts
```

The last step recomputes the OLV side, rewrites `olv/` and all three results
files, and asserts the comparisons. Re-running any step rewrites byte-identical
files.

## What the studies found

**DTM: `agree`.** All 7500 cells across the three scenes are within the
registered 0.00005 m and the largest single difference is 3.78e-6 m, about half
a float32 step at these elevations. Grid origin, cell indexing and row order line
up with PDAL.

**DSM: `agree`.** All 7500 cells across the three scenes are within the same
registered 0.00005 m and the largest single difference is 3.78e-6 m, the same
float32 magnitude as the DTM. 1273 of those cells carry a maximum above their
minimum — a roof or a canopy — so the run tests the top-surface selection and not
only the grid. `buildDsm` and `writers.gdal` `output_type: max` pick the same
highest return per cell.

**Ground filtering: `partial`.** The two planar scenes agree with PDAL on every
one of their 21682 returns. The rolling, ridge and low-blunder scenes do not:
0.607, 0.773 and 0.740 against a registered 0.99, and 0.822 pooled over 55151
returns.

The disagreement is one-directional and concentrated. Of the 9813 returns the two
sides labelled differently, 9812 are bare earth as the scene was built and 9810
are returns only PDAL called ground. The two agree completely about every
building and vegetation return in every scene, so this is not a difference about
what an object is; on those three scenes `classifyGroundSmrf` rejects bare earth
that `filters.smrf` accepts. Against the by-construction labels — an E3 reading,
reported separately in `results-ground-filter.json` — balanced accuracy is 0.693
against 0.930 on the rolling scene, 0.846 against 0.983 on the ridge, and 0.492
against 0.650 on the low-blunder scene.

What causes it is not settled here and is not asserted. The scenes that agree
have no curvature, and the three that disagree carry curvature, a 30 % gradient,
or gross low returns.

## Boundaries

Recorded per study in `results-ground-filter.json` and `results-dtm.json` under
`boundaries`. In short:

- **Agreement with PDAL is not accuracy against ground truth.** Both
  implementations can be wrong about the same ground in the same way, and on a
  synthetic scene both were handed a surface nobody surveyed.
- **One parameter set per study.** Neither says anything about another cell size,
  another window ladder, a non-zero slope-scaled term, or the 2.5 m threshold cap
  our filter applies by default and that the ground study switches off to match
  the reference.
- **`floorPercentile` is 0** in the ground study, matching the reference's
  per-cell minimum. The pipeline orchestrator enables a small despike floor by
  default, so the low-blunder scene exercises the leaf as the reference runs it
  and not as the product ships it.
- **The DTM and DSM studies cannot speak for a realistic cloud.** See above on
  why the fixtures are gridded; the DSM scenes stack returns at the cell centre
  for the same reason.
- **Every DTM cell receives exactly one return, and every DSM cell receives a
  ground return**, so nothing here says anything about how either side marks or
  fills a cell with no data.
- **The DSM study covers one aggregation, the maximum.** It says nothing about
  first- or last-return selection, a percentile-of-top surface, or any cell size
  other than 1 m.
