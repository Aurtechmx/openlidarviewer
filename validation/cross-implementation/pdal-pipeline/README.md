# PDAL pipeline studies — ground filtering and DTM

Extends the cross-implementation evidence from rasters to the point-cloud end of
the pipeline. The raster matrix next door starts from a DEM and compares kernels
against GDAL; these two studies start from returns.

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

## The two studies

| study | manifest | what it compares |
| --- | --- | --- |
| ground filtering | `../studies/GROUND-FILTER-PDAL-SMRF.study.json` | our `classifyGroundSmrf` against `filters.smrf`, per return, on five scenes |
| DTM | `../studies/DTM-PDAL-WRITERS-GDAL.study.json` | our `rasterizeDtm` against `writers.gdal`, per cell, on three scenes |

Both tolerances were registered at `pending` before either study ran, and both
are covered by the manifest's `protocolDigest`.

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
| `olv-SHA256SUMS` | hash per OLV output |
| `reference-runs.json` | environment, argv, exit code and stderr for every invocation |
| `results.json` | the comparison legs, with the boundaries found |

## Reproducing

```
node scripts/generate-point-cloud-fixtures.mjs
node scripts/run-pdal-reference.mjs
npx vitest run tests/groundFilterPdalAgreement.test.ts
```

The third step recomputes the OLV side, rewrites `olv/` and `results.json`, and
asserts the comparisons. Re-running any step rewrites byte-identical files.

## Boundaries found

Recorded in `results.json` under `boundaries`, and summarised here once the
studies have run.
