# OpenLiDARViewer v0.6.8

An engineering and provenance release. No product changed evidence level this
cycle: the register holds 34 claims, 17 of them at E4, none at E5. The
work went into what the viewer tells you about its own numbers, into reopening
a heavy local file without rebuilding its index, and into a body of
externally-checkable provenance.

## Scan output tells you which sample it measured

A strided load carries three nested populations: the count the file declares,
the subset the stride decoded, and the smaller set an analysis gathers. Rows
across the Scan Report, the Dataset Intelligence card, the Analyse fitness
summary and the terrain and technical PDFs named a number without saying which
population it came from, and several stated a constant where the label implied
a measurement.

- Classification reports the measured unclassified share instead of a hardcoded
  zero, so a cloud that is 95 percent code 1 reads that way.
- The dataset card reports the resident point count and labels its basis
  `display-sample`, where it previously reported the declared count as `full`.
- Scan Report rows name their sample basis. "Captured" is now "File created" and
  "Capture Sensor" is "System identifier", because that is what the header field
  holds.
- Edge and boundary sentences distinguish a cell near the data boundary from one
  interpolated at a long reach from any measured cell.
- Airborne provenance decides from footprint area and density rather than
  matching a vendor string first.

## Reopening a heavy local file

A large local LAS or LAZ indexed into the Origin Private File System is now
found again on reopen instead of rebuilt. A cache map records which promoted
store holds which file, keyed by a whole-file SHA-256 rather than by name or
size, so an edited file is a miss and never a wrong hit. A quick locator decides
only whether computing that digest is worth it.

Eviction skips any store another tab still holds open, and refuses to evict at
all when it cannot determine liveness. A janitor sweeps stores an earlier
session abandoned. Cache-map writes are serialised under a lock, so two tabs
indexing at once cannot drop each other's entries.

## Streaming says what it is ready for

Readiness describes the current view rather than the whole source, refinement
orders work toward the centre of what you are looking at, and point size
compensates while coarse nodes stand in for fine ones, so a refining view reads
as refining rather than as sparse. Residency, decode retries and upload-queue
totals are reported from the scheduler that owns them.

## Validation and change figures refuse rather than substitute

Several analysis outputs used to answer with a number under a caveat when the
input did not support one. Each now reports no figure and states why, because a
caveat is a line of prose above a number, and the number is what gets quoted.

- The hold-out validation refuses an invalid split fraction, cell size or seed,
  a ground mask that does not cover the cloud, and a requested train-only
  reclassification that could not be produced. It used to substitute a default
  or the whole-cloud figure in the same field. The report carries the reason.
- Every residual figure is captioned in the unit it is in. When the frame
  states no vertical scale, the Analyse panel, the terrain PDF, the review bar
  and the exported `validation.json` say source Z units, and the ASPRS-style
  RMSEz, NVA and VVA fields are withheld rather than labelled metres.
- `validation.json` records which ground classification the validated surface
  was fitted from: the whole cloud, a classifier re-run on the training points
  only, or the source's own classification when class 2 was trusted. The
  spatially blocked figure records the same, and the panel and report describe
  the contrast between the two figures from those records. The earlier wording
  said the blocked figure predicts across a real gap and runs larger; neither
  is measured.
- Two-epoch change reports no cut and fill volume and no elevation difference
  when the two epochs cannot be confirmed to share a frame, when their grids
  differ in cell size, dimensions or origin, or when one epoch's vertical scale
  resolves and the other's does not. The difference raster can still be viewed
  and is exported only from a fully co-registered pair. Volumes are summed with
  compensated arithmetic, a comparison with no comparable cells reports no
  value rather than zero, and the uncertainty band describes the raw net it is
  printed beside.
- Checkpoint accuracy validates the per-stratum minimum and the output of a
  caller-supplied uncertainty combination, and refuses the record when either
  is unusable.
- The analysis is told whether the frame resolved a scale, separately from the
  scale factor it uses for geometry. The live path supplies a placeholder factor
  of 1 for a scan with no CRS, and the analysis derived "resolved" from that
  factor, so none of the withholding above was reachable from the application
  until the two facts were stated apart.
- A comparison in which no cell is measured in both epochs reports that, rather
  than a NaN volume, and offers no difference raster. A geographic pair keeps
  its elevation differences and withholds only the volumes, as before.
- Re-resolving the same coordinate system, which opening a second tile of one
  survey does, no longer counts as a frame change: derived classifications stay
  valid, the terrain cache is kept, and the on-screen result is not refused as
  stale. A derived classification the frame has invalidated is withheld from
  building and wire extraction as it already was from terrain.
- A terrain export from a layer that carries a project placement publishes no
  origin rather than the layer's own, which would have translated every
  coordinate by the placement offset.

## Provenance you can check

- Contours export as a complete package with a DXF, a validation record and the
  Contour Studio settings.
- A Scan QA report replaces the retired acceptance checklist, stating the
  coordinate-quality verdict, classification provenance and what the report does
  not establish.
- The Coconino checkpoint artifacts state the universe they measure and agree
  with the evidence level the claim register assigns the DTM.
- `docs/project/THIRD_PARTY_NOTICES.md` lists every derived validation file
  committed under `validation/terrain-field/` with its source, licence and DOI.
  Raw source clouds are not redistributed; the derived crops and checkpoint
  records are, and the two documents which stated otherwise now say so.
- The slope claim no longer records a 16.2 degree border shortfall against
  `gdaldem -compute_edges`; the kernel was corrected and the matrix asserts
  agreement on the border ring. The border stays outside the claim because the
  supporting study does not compute edges.

A scientific artifact passport, an evidence boundary inspector and a SHA-256
over the DTM surface are implemented and tested, but no user path reaches them
in v0.6.8. They are recorded in `docs/validation/unreachable-modules.json`,
which a lint enforces, so they are inventory rather than delivered features.

## Interface

Derived analytical layers are listed in the Layers panel. Hillshade can be
styled with an elevation ramp. A coordinate readout follows the probe. The
profile section can filter its scatter by attribute and draw its sample corridor
in 3D. Building and wire candidates open in a review surface. A findings ledger
persists across a session.

## 3D Tiles

Tilesets using REPLACE refinement render correctly, hiding a parent only once
every child is resident, and the 1.1 `contents[]` array on a tile is read.

## Fixed

- Six modules each declared their own metre-to-foot factor, two of them rounded.
  A length converted two different ways depending on which surface displayed it.
- Adaptive precision banded on the raw float, so a value one unit in the last
  place below a decade gained a spurious significant digit. An exact 10 ft span
  read `10.0000 ft`.
- A focused resize grip resized the panel and orbited the camera at the same
  time, because the camera's focus guard recognised only input, textarea and
  select elements.
- The reclassify lasso painted above the panels and swallowed clicks meant for
  them.
- Object metrics measured in source units and labelled the result metres.
- The interior scan panel did the same for dimensions, floor area, ceiling
  height and enclosed volume, printing metres and feet on an unknown unit.
- A measurement CSV or GeoJSON named its columns `length_m`, `area_m2` and
  `volume_m3` on a scan whose unit never resolved. Those columns are now
  `length_source`, `area_source2` and `volume_source3`, the dimensioned floor
  plan is refused on the same condition, and the grid recommendation is
  withheld rather than sized from source coordinates against a metre ladder.
- The epoch surface builder dropped the vertical unit factor, so a compound
  frame with a foot vertical despiked at a floor of about 0.09 m instead of
  0.30 m.
- Contour deliverables stated a unit and a grade that disagreed with the
  analysis that produced them.
- GeoTIFF fields short enough to fit inline are written inline, and clip
  provenance is kept through the export.
- Slow touch gestures are kept, yaw rotates around world up, and ending a
  gesture cancels cleanly.
- The no-CDN loader options reach every parse call, so a build configured to
  fetch nothing fetches nothing.
- Derived classes computed under a frame that was later invalidated are
  withheld from a new analysis instead of carried into it.
- The quantile convention each statistic uses is named in its record, and two
  accumulators that summed naively are compensated.
- The DEM README, the contour deliverable and the readiness card labelled an
  unresolved unit as metres; each now says "units" or "source Z units".
- A full three-axis epoch alignment on a compound frame applied the solved
  vertical shift in the fit's scaled Z rather than in raw Z.
- The grid recommendation on a geographic frame multiplied relief by the metres
  per degree and ignored the cosine of latitude in the width.
- After a coordinate-system override the interior report and floor-plan buttons
  did nothing; they now refuse with the reason.

## Known limitations

The evidence ceiling is unchanged: 17 products at E4, none at E5. The
registration stack, the stockpile area-grid estimator, the artifact passport,
the evidence boundary inspector and the DTM surface digest are implemented and
tested but not wired into a user path, and are registered as unreachable rather
than described as delivered. Touch gestures are verified on Chromium only.
`KNOWN_LIMITATIONS_v0.6.8.md` carries the full list.

## The project has its own domain

OpenLiDARViewer is now at its own name rather than under a company subdomain.

- Project and documentation: <https://openlidarviewer.org/>
- Live viewer: <https://app.openlidarviewer.org/>
- Source: <https://github.com/Aurtechmx/openlidarviewer>

`lidar.aurtech.mx` keeps working. It answers with a permanent redirect to the
new application host, carrying the path and query across, so a deep link
published in an earlier release, a Zenodo record or a paper still resolves.

Release notes, evidence records and manifests from earlier versions still name
the host they shipped with. Those are statements about what was true at the
time, and rewriting them would make the record dishonest, so they are left
alone. A lint holds the current metadata together and exempts the historical
paths by name.

## Licensing

Unchanged from v0.6.7: OpenLiDARViewer is distributed under AGPL-3.0-only.
Releases through v0.6.6 were published under MIT and stay available under those
terms. The license of a bundled dependency or of any test or validation dataset
is unaffected.

## Compatibility

Sessions written by v0.6.8 use schema version 8, unchanged. Sessions from
version 1 onward open. The canonical toolchain is Node 22.18.0 with npm 10.9.3.

## Verifying this release

`REPRODUCIBILITY_v0.6.8.md` describes how to rebuild the release, verify a
downloaded archive without rebuilding it, and regenerate each reported figure.

## Citing

Cite the version DOI for v0.6.8, or the concept DOI 10.5281/zenodo.21544619 for
the series.
