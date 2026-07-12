# Method registry

`src/science/methodRegistry.ts` is the single catalogue of the scientific
methods OpenLiDARViewer runs. Every algorithm that produces a reported number
has one stable identifier and an integer version, so provenance and reports can
name the exact method and revision behind a figure and a reader can trace it to
the paper that specifies it.

## Identifier and versioning rules

- **Id form:** `olv.<area>.<method>` (e.g. `olv.validation.spatial-block`). The
  id never changes once published.
- **Version:** an integer, bumped only when the method's behaviour changes in a
  way that could move its numbers (a new threshold, a corrected estimator, a
  different formula). A pure refactor that leaves the output identical does not
  bump it.
- **Tag form:** `id@version`, e.g. `olv.validation.spatial-block@2`.
- **Citations are never fabricated.** An internal composition with no single
  source paper says so.

## Registered methods

| Id | Ver | Method | Citation |
|---|---|---|---|
| `olv.ground.smrf` | 1 | SMRF ground extraction | Pingel, Clarke & McBride (2013) |
| `olv.terrain.slope-horn` | 1 | Horn slope & aspect | Horn (1981) |
| `olv.terrain.vrm` | 1 | Vector Ruggedness Measure | Sappington et al. (2007) |
| `olv.terrain.tpi` | 1 | Topographic Position Index | Weiss (2001) |
| `olv.dtm.idw-fill` | 1 | DTM raster + IDW void fill | internal (standard IDW) |
| `olv.validation.holdout-rmse` | 2 | Hold-out vertical accuracy (classify-inside-fold) | ASPRS (2014) formulas, hold-out basis |
| `olv.validation.spatial-block` | 2 | Spatial-block cross-validation | Roberts et al. (2017) |
| `olv.validation.reliability-wilson` | 1 | Measured-cell reliability | Wilson (1927) |
| `olv.registration.icp-planar` | 1 | Planar rigid ICP | Besl & McKay (1992); Umeyama (1991) |
| `olv.volume.stockpile` | 1 | Stockpile cut-fill volume ±1σ | internal (prismatic cut-fill) |

## Honesty boundary

Registering a method names the algorithm; it does not upgrade the evidence
behind its output. The hold-out vertical accuracy uses the ASPRS 2014 formulas
on internally withheld points, not independent survey checkpoints, and the
evidence registry still governs whether any product may be presented as
validated. See `docs/validation/` and the evidence model.
