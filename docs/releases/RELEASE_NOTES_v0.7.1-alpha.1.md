# OpenLiDARViewer v0.7.1-alpha.1

This is an alpha on the way to v0.7.1. It has no tag, no DOI and no
publication date, and the walkthrough of every workflow on a real scan in the
packaged build has not been done. The published release is v0.7.0, and its
record, [RELEASE_NOTES_v0.7.0.md](RELEASE_NOTES_v0.7.0.md), does not change.

These notes list what changed since v0.7.0 (tag `v0.7.0`). Volumes and terrain
outputs now state only the evidence that covers them, scenes clean up after
close and replace, startup and large loads are faster, and the file loaders
handle more malformed input. The license is AGPL-3.0-only; releases through
v0.6.6 remain available under MIT.

## Scene lifecycle

- Undo after closing or replacing a scan no longer brings the old scan's annotations onto the new one. The panel's own Clear all stays undoable.
- A scan that replaces the open scene starts with the clip box off and the elevation and intensity filters cleared. A scan added beside the open ones keeps the box.
- A session imported before its scan no longer leaves its clip box behind when the session is dropped or refused.
- Opening a file while static layers and a stream are both open asks only about the stream's work, and Replace removes only that work. Saved views stay.
- Replacing one stream with another resets the Streaming panel's grade figures and pause state, and cancels a grade still running on the old stream.
- Removing the active layer refreshes the class legend, colour chips, point count and scan report for the layer that takes its place. The class filter resets to all visible.
- Removing the last static layer beside an open stream keeps the stream.
- Close and a replacing open disarm the lasso.
- A cancelled or failed COPC, EPT or out-of-core open returns the panels to their earlier state.
- A stream opened beside a static scan in a different coordinate system shows a notice.

## Measurement

- When the grid volume is withheld, the cut-fill cross-check volume is withheld too, in the panel, the toast, the PDF and the CSV and GeoJSON exports.
- The full-coverage lasso stockpile reads "exploratory volume preview" instead of "MEASURED".
- The lasso toast warns when the lasso was drawn more than 20° from plan view.
- Point-sample stockpile confidence is capped by footprint coverage.
- Box volume cites its own claim, MEAS-BOX (E3), instead of the cut-fill claim.
- The MEAS-AREA wording describes the area the tool reports: the area in the polygon's own plane, which equals the planimetric area for a horizontal polygon.
- The PDF profile summary labels its third figure as net rise over run, the summed rise over the summed run.
- PDF measurement rows print the value the Measurements panel shows, in the same units and precision.
- Scan Report density and spacing say "(bounding-box estimate)".

## Terrain evidence

- A terrain product whose method matches none of a claim's studies is "not covered". The live DTM no longer inherits E4 from a study of a different gridding method.
- The live DTM's median gridding on measured cells was compared with R terra and SciPy. It is E4 on measured cells for cell sizes from 0.1 to 10 m with the grid origin at the data minimum. Other sizes, other origins and filled cells are not covered.
- The map sheet and terrain report cite the cartographic contour claim for generalised or smoothed contours, as the GeoJSON and DXF exports do.
- The map sheet's accuracy heading reads "Internal hold-out accuracy".
- Ground confidence is reported as two figures, for measured and for interpolated cells.
- Change detection says when it assumed the vertical unit from the horizontal unit.
- The DEM package export no longer fails above the attention-raster sample limit. Unsampled cells are written as unresolved.
- TPI and VRM warn when more than 10% of their cells are interpolated.
- Contour Studio, the quality panel, the help text and the precision check no longer use "validated" or "certified".

## Performance

- The 3D engine loads after the first screen. Startup code fell from 597 KiB to 353 KiB gzipped, and a build check fails if it grows back.
- Large scans reach their final display sample sooner (3 M points: 2.0 s to 1.4 s).
- E57 integer fields decode a byte window at a time (10 M values: 1.8 to 9.3 s before, 0.08 to 0.29 s after).
- Streaming spends less main-thread time while the camera moves, and filters rebuild point materials once.
- The measure hover pick waits for the camera to settle, and snap grids are built only while the Measure tool is open.

## Measuring, saving and messages

- Clear deletes every measurement and offers Undo for 8 seconds. Esc during a vertex drag puts the vertex back.
- The result card has Delete, and each Measurements row has Copy, which carries the caveat with the value.
- Polygon volumes show their base level, the median of the outline's vertex heights. The CSV and GeoJSON exports write it as `base_level`.
- "Export session" is now "Save session", and every save says what the file holds. The command palette has Save session, Open session, Open scan and Report PDF.
- Copy view link reports success or failure and is disabled for streamed scans.
- Error messages stay up in proportion to their length, can be dismissed and link to the Session log. A failed URL open shows its reason and Retry.
- A browser with neither WebGPU nor WebGL 2 is told so before the file is decoded.
- Colour chips and measure buttons expose their pressed state, and measure results are announced to screen readers.

## Reproducibility

- The release gate runs from a source archive and records `source: "archive"`. REPRODUCIBILITY.md gives the command.
- `npm run dem:package -- <crop> <outdir>` writes the DEM package from a committed crop and checks it with the three Python readers.
- The release workflow sets `SOURCE_DATE_EPOCH` to the tagged commit's time.
- The DEM package carries a QGIS `.qml` style for its evidence, attention and sensitivity rasters, and its README lists every code.
- CITATION.cff, codemeta.json and .zenodo.json carry the same metadata, and a lint checks them.
- The method id `olv.dtm.idw-fill` is now `olv.dtm.geodesic-fill@1`. The old id still resolves, and a cached terrain core is rebuilt once.

## Flow Pulse

- TERRAIN-FLOW-PULSE moves from E3 to E4 after a comparison with TauDEM 5.3.8 and GRASS GIS 8.3.2 on public DEMs. The conditioned elevation matched TauDEM on all 119,119 distinct cells. Against GRASS, 99.21% of D8 directions agreed, the catchment Jaccard index was 0.9990 and 95.2% of accumulations were within 5%.
- TERRAIN-FLOW-DEPRESSION-INVENTORY moves from E2 to E3, from TauDEM's filled depressions and a synthetic suite with hand-derived values.
- Six RichDEM test grids agree with Flow Pulse as corroboration. No level changes from them.
- D8 tie order, flat resolution, flow length and the peak-flow estimate were not compared. Agreement on archival data is not field validation.

## Format robustness

A pinned corpus of upstream test files from LASzip, laspy, libE57Format, PROJ and the Point Cloud Library opens through the normal load path. Five loader fixes came with it:

- A LAS file whose ESRI WKT names a vertical CRS (`VERTCS`) takes its horizontal unit from the projected CRS. A file in US survey feet used to report metres.
- A LAZ file with an invalid compression record is refused with the faulty field named.
- An E57 file with images only says so, and a file with scans and images opens with a warning.
- A COPC range request answered with 416 is reported as a changed or short object.
- A COPC read cut short by a cancel or a dropped connection keeps its cancelled or connection-closed reason.

## Storage history

The scan report has a "Storage history" row for LAS and LAZ files opened from disk. It tests whether the stored integer coordinates are compatible with an earlier storage grid from a fixed candidate set. It reports the grid, "none detected", or why the test did not run. A supported grid says nothing about how or by whom the file was produced. The capability is a preview, and its claim, STORAGE-HISTORY, is at E2.

## Local coordinate systems

A LAS file whose WKT is a named local or engineering CRS (`LOCAL_CS`, `ENGCRS`) keeps that name. Change detection refuses two local frames with different names, and the layers are not combined. Two layers that name the same local frame are reported as unverified.

## Evidence tooling

- The field-study verifier requires a per-operator independence record. It rejects statistics that cannot hold together, such as a bias above the RMSE or an RMSE above the largest residual.
- An RMSE below the stated instrument accuracy (F17) is a warning. It fails only below the 1% χ² bound.
- The evidence record lists 18 E4 claims, and `lint:evidence` fails when that count differs from the register.
- A new lint keeps claim and terrain-matrix wording in line with each protocol's freeze status.

## Claims language

"Preregistered" is removed from claims whose protocols were adopted together with their result, including MEAS-AREA, E57-INGEST, TPI, VRM, CHM and Aspect. "Validated", "certified" and similar words are removed from the interface where no study supports them.

## Evidence register

The register holds 41 claims, 18 of them at E4 and none at E5. Since v0.7.0, MEAS-BOX (E3) and STORAGE-HISTORY (E2) are new, TERRAIN-FLOW-PULSE moved to E4 and TERRAIN-FLOW-DEPRESSION-INVENTORY moved to E3. Nothing here is a survey-grade result, and held-out validation against independent reference data has not been done.

## Changes that affect scripts

- Stockpile CSV and GeoJSON: `grid_authority=measured` is now `exploratory_full_coverage`. `preview` and `withheld` are unchanged.
- Contour GeoJSON: `meanConfidence` is now `presentationSupport`.
- Measurement CSV and GeoJSON: polygon volumes add a `base_level` column and property.
- Box measurements in CSV and GeoJSON cite MEAS-BOX instead of VOL-POINT-SAMPLE.
- A withheld stockpile volume exports no cross-check volume.
- DTM provenance cites `olv.dtm.geodesic-fill@1` instead of `olv.dtm.idw-fill`, and its evidence line reads E4 or "measured cells not covered" by the rule above.

## Known limits

[KNOWN_LIMITATIONS_v0.7.1-alpha.1.md](KNOWN_LIMITATIONS_v0.7.1-alpha.1.md) lists the limits of this build. The validation record is [VALIDATION_REPORT_v0.7.1-alpha.1.md](VALIDATION_REPORT_v0.7.1-alpha.1.md), and the dated history is in [CHANGELOG.md](../../CHANGELOG.md).
