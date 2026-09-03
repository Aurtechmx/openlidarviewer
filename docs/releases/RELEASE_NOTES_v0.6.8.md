# OpenLiDARViewer v0.6.8

An engineering and provenance release. No product changed evidence level this
cycle: the register still holds 33 claims, 17 of them at E4, none at E5. The
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

## Provenance you can check

- A scientific artifact passport binds an exported product to the method, the
  inputs and the software that produced it.
- An evidence boundary inspector shows where a claim's support ends.
- The delivered DTM surface carries a SHA-256 of the surface itself.
- Contours export as a complete package with a DXF, a validation record and the
  Contour Studio settings.
- A Scan QA report replaces the retired acceptance checklist, stating the
  coordinate-quality verdict, classification provenance and what the report does
  not establish.

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

## Known limitations

The evidence ceiling is unchanged: 17 products at E4, none at E5. The
registration stack and the stockpile area-grid estimator are implemented and
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
