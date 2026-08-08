# Coconino slope/aspect reference — reproduction

Source (public domain, USGS 3DEP): `USGS_LPC_AZ_Coconino_2019_B19_w1407n1486.laz`
(project 19049), NAD83(2011) / Conus Albers (EPSG:6350), NAVD88 Geoid12B.

Real steep forested terrain — the case the analytic-DEM and flat White Sands
slope checks do not cover.

## Steps

1. **DTM crop.** From the tile's class-2 ground, pick the 150 × 150 m interior
   window of greatest relief (40.4 m here, ~27% mean slope, local slopes to
   ~45°), origin Albers (−1406700, 1486600). Grid at 1 m with scipy
   `binned_statistic_2d(..., statistic='mean')`, written ESRI ASCII, row 0 =
   north → `references/coconino-slope__bincell-dtm.asc`.

2. **NumPy Horn spot-check** (independent implementation, same convention):
   ```
   python3 scripts/terrain-field/generate-slope-aspect-spotcheck.py \
     validation/terrain-field/references/coconino-slope__bincell-dtm.asc \
     validation/terrain-field/references/coconino-slope__slope-aspect-spotcheck.json
   ```
   Freezes 735 interior cells with a full 3×3 neighbourhood.

3. **gdaldem independent-tool reference** (GDAL 3.13.1):
   ```
   gdaldem slope coconino-slope__bincell-dtm.asc coconino-slope__gdaldem-slope.asc \
     -of AAIGrid -s 1.0 -alg Horn
   ```

`tests/coconinoSlopeAspect.test.ts` runs OLV `hornSlopeAspect` on the DTM and
compares to both: the NumPy cells to floating-point tolerance, and gdaldem's
slope (converted to degrees) within the registered E4 tolerance of 0.5°, over
interior cells with slope ≥ 2°.

Measured: OLV vs NumPy Horn max 3e-8 (slope) / 1e-7 rad (aspect); OLV vs gdaldem
3.13.1 max 0.013°, mean 0.003° over 19,834 cells. This broadens the slope
cross-implementation evidence from the analytic surface to real national-survey
terrain; it does not on its own promote the claim beyond E4.
