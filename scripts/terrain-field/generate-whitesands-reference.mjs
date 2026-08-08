#!/usr/bin/env node
/**
 * generate-whitesands-reference.mjs — reproduce the White Sands crop + references.
 *
 * NOT run in CI (no raw cloud, no PDAL/GDAL/scipy there). It records the exact
 * procedure so the committed fixtures under validation/terrain-field/ can be
 * regenerated and audited. The committed crop is what tests/terrainFieldValidation
 * .test.ts consumes; the committed reference grids are what it compares against.
 *
 * Prerequisites: the source LAZ (see datasets/manifest.json sourceSha256), PDAL,
 * GDAL, and a Python env with numpy + scipy.
 *
 * Steps (bounds + grid are frozen in crops/whitesands-dune.crop.json):
 *
 *   # 1. Class-2 ground, 100 m interior crop → CSV of X,Y,Z (OLV input) :
 *   pdal pipeline <crop→range[2:2]→writers.text order=X,Y,Z> ground.csv
 *   #    then pack X-origin,Y-origin,Z as Float32 → crops/whitesands-dune__ground.f32
 *
 *   # 2. Independent point-in-cell mean (scipy) — the SAME operation OLV performs,
 *   #    a separate codebase → references/whitesands-dune__bincell-dtm.asc :
 *   scipy.stats.binned_statistic_2d(x, y, z, 'mean', bins=[xedges, yedges])
 *
 *   # 3. Independent standard tool, windowed mean (PDAL) → GTiff → AAIGrid :
 *   pdal pipeline <crop→range[2:2]→writers.gdal output_type=mean res=1 origin_x/y width/height>
 *   gdal_translate -of AAIGrid pdal-dtm.tif references/whitesands-dune__pdal-dtm.asc
 *
 * Tool versions used for the committed references: GDAL 3.13.1, scipy 1.17.1,
 * numpy 2.4.6. Recorded here, not asserted, per the cross-implementation record
 * convention. sha256 of every committed fixture is in SHA256SUMS.
 */
console.log('This is a reproduction record. See the header for the exact commands.');
console.log('CI does not run it: no raw cloud and no PDAL/GDAL/scipy are present there.');
