# OpenLiDARViewer v0.7.1-alpha.1

This is an alpha on the way to v0.7.1. It has no tag, no DOI and no
publication date. The workflows were walked through on a real scan in the
packaged build of commit `f11abebc1`. The published release is v0.7.0, and its
record, [RELEASE_NOTES_v0.7.0.md](RELEASE_NOTES_v0.7.0.md), does not change.

These notes list what changed since v0.7.0 (tag `v0.7.0`). Volumes and terrain
outputs now state only the evidence that covers them, figures and deliverables
from a sampled load say so, Flow Pulse exports a drainage sheet PDF, scenes clean up after close and replace, exports name the scan they
were measured on, startup and large loads are faster, and the file loaders
handle more malformed input. The license is AGPL-3.0-only; releases through
v0.6.6 remain available under MIT.

## Scene lifecycle

- Undo after closing or replacing a scan no longer brings the old scan's annotations onto the new one. The panel's own Clear all stays undoable.
- A scan that replaces the open scene starts with the clip box off and the elevation and intensity filters cleared. A scan added beside the open ones keeps the box.
- A session imported before its scan no longer leaves its clip box behind when the session is dropped or refused.
- Opening a file while static layers and a stream are both open asks only about the stream's work, and Replace removes only that work. Saved views stay.
- Replacing one stream with another resets the Streaming panel's grade figures and pause state, and cancels a grade still running on the old stream.
- Removing the active layer refreshes the class legend, colour chips, point count and scan report for the layer that takes its place. The class filter resets to all visible.
- Removing the last static layer beside an open stream keeps the stream instead of resetting the app to the empty state, and both Close and a replacing open disarm the lasso so its button stays in sync.
- A cancelled or failed COPC, EPT or out-of-core open returns the panels to their earlier state.
- A stream opened beside a static scan in a different coordinate system shows a notice.

## Figures on sampled loads

- On a large LAS or LAZ opened as a display sample, the class shares, the terrain ground density, the scan scope and the primary limiter say they come from a sample. After a class edit the shares are counted on the loaded points. The pre-load message says the file is read as one record in N.
- The Technical Report has a Terrain analysis section and states the same analysed basis as the map sheet. The terrain verdict names the unclassified share instead of saying the points are not classified to ground.
- The Dataset Story names the bounding box as a bounding box, and the Scan Report's Classification line updates after every class edit.
- The DTM evidence rule converts the run's cell size to metres before judging the studied range, so a scan in feet is read correctly, and a sampled run's ground density is stated without a QL grade. After a layer becomes active, the point-count detail shows the file's count.
- On a sampled scan, the DEM, contour, map sheet and other terrain products read Preview, and their workflow rows name the sample as the reason. Best for no longer lists those products. A full read is unchanged.
- The terrain report, structured exports and analysis records do not state export readiness when the analysis read a sample. Terrain exports and labels say when a fully loaded scan was analysed from a sample.

## Scans and layers

- Pressing a layer's name makes it the active scan. A Created layers list on the Data tab shows or hides contours, drainage lines and the access map, and a session keeps those choices.
- After a scan is removed, the contour map sheet, the Terrain Intelligence report and the other terrain exports name the active scan. A kept terrain result keeps the name of the scan it was computed on.
- Each scan keeps its own Auto-classify caption and class counts while another scan is active. Notes stay with the scan they were placed on, and a note whose scan was closed is not saved.
- When the clip box or a filter hides every point, a card names what is on and offers Turn off clip or Reset filters. The Terrain page says which points a terrain run reads.
- A scan opens on the Tools home rather than on the last scan's Clip box page. Desktop tool pages have a Back button, and the clip box on a streamed scan fits the data extent.

## Measurement

- When the grid volume is withheld, the cut-fill cross-check volume is withheld too, in the panel, the toast, the PDF and the CSV and GeoJSON exports.
- The full-coverage lasso stockpile reads "exploratory volume preview" instead of "MEASURED", as the stockpile claim allows at every tier, and the lasso toast warns when the lasso was drawn more than 20° from plan view, where raised points can fall outside the footprint.
- Point-sample stockpile confidence is capped by footprint coverage.
- Box volume cites its own claim, MEAS-BOX (E3), instead of the cut-fill claim.
- The MEAS-AREA wording describes the area the tool reports: the area in the polygon's own plane, which equals the planimetric area for a horizontal polygon.
- The PDF profile summary labels its third figure as net rise over run, the summed rise over the summed run.
- PDF measurement rows print the value the Measurements panel shows, in the same units and precision.
- Scan Report density and spacing say "(bounding-box estimate)".
- The lasso volume tool draws on the built app again. Its overlay set its size in a way the page's Content-Security-Policy blocks.
- Volumes show five significant figures. A box with no height withholds its volume, a box drawn with Draw clipping box is a clip region with no volume, and chain totals leave clip regions out.
- The measurement CSV fills the run, rise, grade and angle of a Distance.
- A vertex released before the next frame lands where the pointer was let go, a drag follows one pointer and is cancelled cleanly, and dragging a box corner past the opposite corner no longer moves that corner. The vertex touch target is 44 px on a touch screen.
- A double-click while a tool is paused with Space focuses the camera and keeps the measurement open.
- The profile's compact chart draws heights at the same scale as distances by default and says so. The chips offer 5×, 10× and 20× exaggeration and Fit, and Fit states the exaggeration it took.
- The automatic corridor of a new profile stops at a 5 m half-width instead of growing with the line, on a scan with a known metre scale. Without one it stays 5 % of the line's length. On transects of a real survey, a 37 m corridor read up to 1.0 m RMS from a narrow line of ground returns, against 0.10 to 0.19 m at 5 m. A paired test of a ground-first rule found no measured benefit, so the chart keeps the percentile over every accepted return.
- The result card's Delete deletes through the measurement controller, so it works before the Measurements panel has loaded. The stockpile toast shows five significant figures, and a volume chain with no measured volume states a member's own reason, blaming a clip region only when no member gives one.
- The Profile Workbench always opens showing the section. Once it had been collapsed, with its button or with Escape, every later open showed only its header strip until Expand was pressed.
- A profile's PDF, station CSV and workbench image name the scan the profile was measured on, in that scan's coordinate system, and are withheld with the step to take when the source cannot be settled. The Profile Workbench opens only while a scan the profile was measured on is active.
- The profile PDF prints at standard horizontal and vertical scales, its axes contain the sampled minimum and maximum, and the scale line prints the scale that is drawn. It adds a station band at round chainages, a maximum grade over a fixed base length and the rise between the picked endpoints.
- A profile records how it was sampled when it is committed and when it is resampled. On a streamed scan, the points note says how many loaded points were analysed. The workbench chainage span row says it includes the end caps.
- A measurement across two scans is refused, in the live view and in the CSV and GeoJSON exports, when their horizontal grids cannot be shown to be the same.

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
- A restored session checks its source file and does not apply saved state to a file that has changed.
- A new app version does not reload the page by itself while saved views or held session work are open. It asks first. A failed automatic upgrade keeps the saved offline copy, and offline, a part of the app that cannot load says so and offers no reload.
- Make available offline saves a copy only when the index.html it fetches matches the SHA-256 recorded in the build's asset manifest and every bundle the page loads is listed there. If the site changes during a save, nothing is written, the earlier offline copy is kept, and the page says to reload and try again.
- The notice about unsaved work from another file has Keep for later and no longer covers an open annotation form. The session recovery notice sits beside the left rail.
- The command palette runs the command its row shows when results from several sections are ranked together.
- On a phone, the annotation form keeps Save in reach.
- Frame all and the camera presets are recorded from the dock, the navigation bar, ViewCube Home, the keys and the canvas menu, and the recorder lists what it records.
- L, the camera view keys, Save session and the snapshot key say "Open a scan first" before the viewer has loaded.
- Starting a tool keeps the highlight of a finished lasso result. Undo after deleting a profile brings back the reason it has no chart. A COPC URL that cannot be reached also suggests downloading the file and using Open scan.

## Reproducibility

- The release gate runs from a source archive and records `source: "archive"`. REPRODUCIBILITY.md gives the command.
- The build ships `PRIVACY.md`, and the third-party notices add the missing entries and test fixture licences, including the Newsreader and Figtree fonts (OFL) used by the drainage sheet.
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
- Flow Pulse exports a drainage sheet PDF next to Drainage in 3D. A dialog chooses its sections: drainage map, hydrology summary, traced path and catchment, and depression table. The sheet has a cover page, a site map with labelled catchments, catchment pages and an appendix of definitions and sources. Every page is marked PREVIEW, and a long scan name is shortened so the footer stays clear of that label.
- The cover of the drainage and watershed sheets gives two watershed counts: those over 1 % of the area and the smaller ones. It used to give only the first, which did not match the outlet count on the other pages. The depression table note reads, for example, "25 of 1,464 depressions shown".
- Flow Pulse and Terrain Access packages write a `.prj` beside their placed rasters when the scan has an EPSG code but no WKT, and their READMEs say the `.prj` carries the source CRS definition.

## Format robustness

A pinned corpus of upstream test files from LASzip, laspy, libE57Format, PROJ and the Point Cloud Library opens through the normal load path. Five loader fixes came with it.

- A LAS file whose ESRI WKT names a vertical CRS (`VERTCS`) takes its horizontal unit from the projected CRS. A file in US survey feet used to report metres.
- A LAZ file with an invalid compression record is refused with the faulty field named.
- An E57 file with images only says so, and a file with scans and images opens with a warning.
- A COPC range request answered with 416 is reported as a changed or short object.
- A COPC read cut short by a cancel or a dropped connection keeps its cancelled or connection-closed reason.
- A glTF or GLB is checked against its own buffers before any point is read. Declared data the file does not hold is refused instead of read as zeros, and the check reads the same chunks the parser reads. Meshopt and Draco compression are refused with a reason. Embedded `data:` buffers are decoded in memory, so they open under the deployment's connection policy.
- A COPC node or LAZ chunk whose bytes differ from the declared size is refused as malformed.

## Storage history

The scan report has a "Storage history" row for LAS and LAZ files opened from disk. It tests whether the stored integer coordinates are compatible with an earlier storage grid from a fixed candidate set. It reports the grid, "none detected", or why the test did not run. A supported grid says nothing about how or by whom the file was produced. The capability is a preview, and its claim, STORAGE-HISTORY, is at E2.

## Coordinate systems

- A LAS file whose WKT is a named local or engineering CRS (`LOCAL_CS`, `ENGCRS`) keeps that name, inside a compound CRS too. Change detection refuses two local frames with different names, and the layers are not combined. Two layers that name the same local frame are reported as unverified.
- A bound CRS takes its unit from its source CRS. Two custom coordinate systems with the same name are compared on their definition. Trailing NUL characters in a CRS text no longer slow the comparison.
- A saved session keeps the catalogue name behind an asserted CRS, and an export with an assigned CRS records the assignment in the file.
- `PROJECTEDCRS` and `GEOGRAPHICCRS` are read as WKT2 keywords. The change-detection frame check compares two same-name custom CRSs on their definition, as the layer check does. `base_level` in the measurement CSV and GeoJSON is read along the scan's up axis. The session-saved toast counts what the file holds and says what was left out.
- Rasters in a DEM package get a `.prj` from the stored definition of their EPSG code.
- The LAS 1.4 export records the CRS as OGC WKT, built from the EPSG code when the source has none, or refuses the export. The panel no longer says the CRS is stored as GeoTIFF keys.

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

- Stockpile CSV and GeoJSON exports write `grid_authority=exploratory_full_coverage` where they wrote `measured`. `preview` and `withheld` are unchanged.
- Contour GeoJSON features carry `presentationSupport` in place of `meanConfidence`.
- Polygon volumes add a `base_level` column to the measurement CSV and a `base_level` property to its GeoJSON.
- Box measurements in CSV and GeoJSON cite MEAS-BOX instead of VOL-POINT-SAMPLE.
- A withheld stockpile volume exports no cross-check volume.
- DTM provenance cites `olv.dtm.geodesic-fill@1` instead of `olv.dtm.idw-fill`, and its evidence line reads E4 or "measured cells not covered" by the rule above.

## Known limits

[KNOWN_LIMITATIONS_v0.7.1-alpha.1.md](KNOWN_LIMITATIONS_v0.7.1-alpha.1.md) lists the limits of this build. The validation record is [VALIDATION_REPORT_v0.7.1-alpha.1.md](VALIDATION_REPORT_v0.7.1-alpha.1.md), and the dated history is in [CHANGELOG.md](../../CHANGELOG.md).
