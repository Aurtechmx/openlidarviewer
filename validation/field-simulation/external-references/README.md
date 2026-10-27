# Field simulation: external references

The fixtures in `../fixtures/` are compared against a second implementation
written in this project. The three here carry outputs from tools written
outside it, TauDEM and GRASS GIS, on real terrain. The study that uses them is
pre-registered in `validation/protocols/flow-pulse-external-references-v1.md`.

## Files

| File | Register id | Reference |
| --- | --- | --- |
| `bear-creek-taudem-fill-A.json` | `OLV-DS-119-BEAR-CREEK-TAUDEM-FILL-A` | TauDEM 5.3.8 PitRemove filled elevation |
| `bear-creek-taudem-fill-B.json` | `OLV-DS-120-BEAR-CREEK-TAUDEM-FILL-B` | TauDEM 5.3.8 PitRemove filled elevation |
| `reunion-pluies-grass.json` | `OLV-DS-121-REUNION-PLUIES-GRASS-WINDOW` | GRASS GIS 8.3.2 D8 direction, accumulation and catchment |

The sources are `OLV-DS-117-BEAR-CREEK-TAUDEM-PITFILL` and
`OLV-DS-118-REUNION-GRASS-FLOW` in `validation/datasets/dataset-register.yaml`.
Neither source is vendored; each fixture is a window cut from it.

## Format

Each file keeps the fields of `../fixtures/*.json` (`name`, `why`,
`cellMetresX`, `cellMetresY`, `z`) and adds provenance fields, a `window` in
source-raster cells, and a `reference` block holding the other tool's output
for the same cells.

Rows of `z` run north to south, as in the source raster. OpenLiDARViewer's row
0 is the southern row, so a reader reverses the rows before routing. Every
row-major index in `reference` is over `z` as stored.

Elevations are written as the shortest decimal that reads back to the source
Float32 value, so loading them into a `Float32Array` recovers the source bits.

## How they were cut

The windows were cut with GDAL, `gdal_translate -of ENVI -srcwin`, and the
Réunion catchment polygon was rasterised onto the window grid with
`gdal_rasterize -burn 1 -init 0` (cell-centre rule). The exact commands are in
each file's `cut` field. Rebuilding from the same source files gives the same
bytes; the sha256 of each file is recorded in the register.

## Licence

Both sources are CC-BY-4.0. Credit:

- Cybercastor (2023). TauDEM for Bear Creek [Data set]. Zenodo.
  <https://doi.org/10.5281/zenodo.8335853>
- Poncet, N. et al. (2026). Flow direction and accumulation maps, streams
  post-processed from BDAlti 25m DEM on Reunion island + Riviere des Pluies
  catchment boundaries [Data set]. Zenodo.
  <https://doi.org/10.5281/zenodo.18790150>

The Réunion elevations derive from IGN's BD ALTI 25 m, which IGN publishes on
data.gouv.fr under Licence Ouverte 2.0 (Etalab)
(<https://www.data.gouv.fr/datasets/bd-alti-r-1>, checked 2026-10-25). The
Zenodo depositor does not state the upstream licence; the CC-BY-4.0 record is
the licence relied on for the derived grids.

Each fixture changes its source: it is a window of the source rasters, re-encoded as JSON,
with the catchment polygon rasterised onto the window grid.
