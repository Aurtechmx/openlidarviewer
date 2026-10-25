# OpenLiDARViewer v0.6.8

v0.6.8 is an engineering and provenance release. The work went into what the viewer says about its own numbers, into reopening a heavy local file without rebuilding its index, and into provenance a reader outside the project can check.

No product changed evidence level this cycle. The register holds 34 claims, 2 at E1, 6 at E2, 9 at E3 and 17 at E4, none at E5. Groundwork for E5 registers the Rogue tiles, makes the dev and holdout split deterministic and exposure-honest, and recomputes the manifest invariants; the holdout has not been run.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Scan output names the sample it measured

A strided load decodes a subset of what the file declares, and an analysis gathers a smaller set again. Reports named a figure without saying which of the three it described; every row now states its basis.

Classification reports its measured unclassified share instead of a hardcoded zero, and the dataset card reports the resident count as `display-sample` rather than the declared count as `full`. Two header fields are labelled as what they hold: "File created" and "System identifier". Edge cells are distinguished from cells interpolated far from any measurement, and footprint and density decide airborne provenance.

## Reopening a heavy local file

A large local LAS or LAZ indexed into the Origin Private File System is found again on reopen instead of rebuilt. A whole-file SHA-256 keys the index, so an edited file never matches a stale one.

Eviction skips stores another tab still holds open, and refuses outright when it cannot tell. A janitor sweeps what an earlier session abandoned, and two tabs indexing at once cannot drop each other's entries.

## Streaming says what it is ready for

Readiness describes the current view, not the whole source, and refinement works outward from the centre. Point size compensates while coarse nodes stand in for fine ones, so a refining view looks like one. Residency, decode retries and queue totals match the work behind them.

## Validation and change figures refuse rather than substitute

Several analysis outputs answered with a number under a caveat when the input did not support one. They now report no figure and say why.

Hold-out validation refuses invalid parameters, a ground mask that does not cover the cloud, and a train-only reclassification it could not produce. Every residual figure carries its own unit: with no stated vertical scale it reads source Z units, and the ASPRS-style RMSEz, NVA and VVA fields stay empty. `validation.json` names which ground classification the surface was fitted from.

Two-epoch change reports no volume and no elevation difference when the epochs cannot be confirmed to share a frame, when their grids disagree, or when only one resolves a vertical scale. The difference raster stays viewable and exports only from a co-registered pair. A geographic pair keeps its elevation differences and withholds only volumes.

A frame with no resolved linear unit states no metric figure. Withheld: the ground-return density and its USGS 3DEP floor, the map sheet's metre accuracy figures, the complexity window in ground metres, and the density threshold that caps the readiness verdict.

Re-resolving the same coordinate system is no longer a frame change, so derived classifications and the terrain cache survive opening a second tile of a survey. The kernels refuse impossible specifications instead of repairing them, and trusting the source ground classification is refused when no class 2 points exist.

The CHANGELOG carries the full list of conditions each check refuses.

## Provenance you can check

Contours export as a package with a DXF, a validation record and the Contour Studio settings. A Scan QA report replaces the retired acceptance checklist, stating the coordinate-quality verdict, classification provenance and what it does not establish.

`docs/project/THIRD_PARTY_NOTICES.md` lists every derived validation file under `validation/terrain-field/` with its source, licence and DOI. Raw source clouds are not redistributed; the derived crops and checkpoint records are, and the two documents which claimed otherwise now draw that distinction.

The slope claim no longer records a 16.2 degree border shortfall against `gdaldem -compute_edges`. The border stays outside the claim because the supporting study does not compute edges.

An artifact passport, an evidence boundary inspector and a SHA-256 over the DTM surface are implemented and tested but unreachable from the interface, and are registered as inventory rather than delivered features.

## Interface

Derived analytical layers are listed in the Layers panel. Hillshade takes an elevation ramp. A coordinate readout follows the probe. The profile section filters its scatter by attribute and draws its corridor in 3D. Building and wire candidates open in a review surface. A findings ledger persists across a session.

## 3D Tiles

Tilesets using REPLACE refinement render correctly, hiding a parent only once every child is resident, and the 1.1 `contents[]` array on a tile is read.

## Fixed

- Six modules each declared their own metre-to-foot factor, two of them rounded, so a length converted differently depending on which surface displayed it. A lint now compares conversion factors by value rather than by spelling.
- Adaptive precision banded on the raw float, so an exact 10 ft span read `10.0000 ft`.
- Object metrics measured in source units and labelled the result metres. The interior scan panel did the same for dimensions, floor area, ceiling height and enclosed volume.
- A measurement CSV or GeoJSON named its columns `length_m`, `area_m2` and `volume_m3` on a scan whose unit never resolved. Those columns are now `length_source`, `area_source2` and `volume_source3`, the dimensioned floor plan is refused on the same condition, and the grid recommendation is withheld rather than sized from source coordinates against a metre ladder.
- The epoch surface builder dropped the vertical unit factor, so a compound frame with a foot vertical despiked at a floor of about 0.09 m instead of 0.30 m.
- A full three-axis epoch alignment on a compound frame applied the solved vertical shift in the fit's scaled Z rather than in raw Z.
- The grid recommendation on a geographic frame multiplied relief by the metres per degree and ignored the cosine of latitude in the width.
- Contour deliverables stated a unit and a grade that disagreed with the analysis that produced them.
- The DEM README, the contour deliverable and the readiness card labelled an unresolved unit as metres; each now says "units" or "source Z units".
- GeoTIFF fields short enough to fit inline are written inline, and clip provenance is kept through the export.
- Slow touch gestures are kept, yaw rotates around world up, and ending a gesture cancels cleanly.
- A focused resize grip resized the panel and orbited the camera at once; the camera's focus guard recognised only input, textarea and select elements.
- The reclassify lasso painted above the panels and swallowed clicks meant for them.
- A lasso reclassify only edits points the user can see, so reclassifying into a hidden class hid its own result. The target class is revealed and the toast says so; every other hidden class stays hidden.
- The no-CDN loader options reach every parse call, so a build configured to fetch nothing fetches nothing.
- The quantile convention each statistic uses is named in its record, and two accumulators that summed naively are compensated.
- After a coordinate-system override the interior report and floor-plan buttons did nothing; they now refuse with the reason.
- Moving the mouse over a parked scene cut Eye Dome Lighting and dropped the pixel ratio for a third of a second, as did a colour-mode switch, a filter change and a canvas resize. Only camera motion degrades the render now.
- The Layers panel is re-parented out of the Inspector into the workspace rail, where nothing was painted behind it, so its group headers and rows read over the point cloud.
- Packaging a source tree that has no repository dropped every tracked file under a directory named `release`, including the archive-portability and build-identity evidence. Archives cut from the repository were never affected; re-packaging an extracted archive was.
- The Performance control's tooltip names what the control trades: the computation is unchanged, the resident-point budget is not, and a resident-only measurement or export reads whatever is resident when it runs.
- The contour map sheet prints the build that drew it, which every other provenance-bearing export already carried.
- The map sheet's density row names the quantity it measures. The USGS floors are nominal pulse density and the figure beside them is measured ground-return density, which the technical report for the same scan declines to grade against those floors.
- A stockpile preview stated its band as `± x m³ (1σ)` beside a confidence word, which reads as a calibrated interval on the volume. The band is now named a model band, and the grade names what it measures: how well the footprint was sampled.
- A TPI slope-position class read a non-finite slope as zero, the value that separates flat from middle-slope, so a cell whose slope never resolved could be labelled flat. It stays nodata.
- The external reference-label agreement measured on real airborne scenes (OpenGF expert labels, producer class-2 ground) is recorded against the derived-classification heuristic that produced it, not the terrain ground filter.

## Known limitations

The complete list is in `KNOWN_LIMITATIONS_v0.6.8.md`. The evidence ceiling is unchanged: 17 products at E4, none at E5. The registration stack, the stockpile area-grid estimator, the artifact passport, the evidence boundary inspector and the DTM surface digest are implemented and tested but not wired into a user path, and are registered as unreachable rather than described as delivered. Touch gestures are verified on Chromium only.

## The project has its own domain

OpenLiDARViewer is now at its own name rather than under a company subdomain.

- Project and documentation: <https://openlidarviewer.org/>
- Live viewer: <https://app.openlidarviewer.org/>
- Source: <https://github.com/Aurtechmx/openlidarviewer>

`lidar.aurtech.mx` keeps working. It answers with a permanent redirect to the new application host, carrying the path and query across, so a deep link published in an earlier release, a Zenodo record or a paper still resolves. Release notes, evidence records and manifests from earlier versions still name the host they shipped with, and are left as they were published.

## Licensing

Unchanged from v0.6.7: OpenLiDARViewer is distributed under AGPL-3.0-only. Releases through v0.6.6 were published under MIT and stay available under those terms. The license of a bundled dependency or of any test or validation dataset is unaffected.

## Compatibility

Sessions written by v0.6.8 use schema version 8, unchanged. Sessions from version 1 onward open. The canonical toolchain moves to Node 22.18.0 with npm 10.9.3, and its verifier reads the pin instead of a hardcoded version.

## Verifying this release

`REPRODUCIBILITY_v0.6.8.md` describes how to rebuild the release, verify a downloaded archive without rebuilding it, and regenerate each reported figure.

## Citing

Cite the version DOI for v0.6.8, or the concept DOI 10.5281/zenodo.21544619 for the series.
