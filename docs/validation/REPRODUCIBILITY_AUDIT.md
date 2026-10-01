# Reproducibility audit of export paths (v0.7.0)

This audit lists every export path and records which provenance fields the
output carries, in the file itself or in a sidecar inside the same download.
Ledger entry: L181.

## Fields

| Key | Field |
| --- | --- |
| B | App version and build commit |
| S | Source file identity: base name only, never a path |
| H | Source content hash |
| C | CRS and vertical reference |
| CS | Where the CRS came from (VLR, EVLR, user, unknown) |
| I | Format probe interpretation level (`metadata.interpretationLevel`) |
| D | Data basis: full, sampled, resident-only |
| M | Method ids and versions from `src/science/methodRegistry.ts` |
| P | Parameters used |
| T | Timestamp |
| R | Result can be regenerated from the recorded fields |

Values: `yes`, `no`, `part` (present in some cases or in a weaker form), `n/a`.

## Record structures reused

- `processingManifest.ts`: ordered, hash-chained ops (`id@version` plus
  params). The interpretation record is a new op,
  `olv.provenance.source-interpretation@1`, placed first in the chain. A
  manifest built without it is byte-identical to before.
- `scientificArtifactPassport.ts`: binds source, analysis record, manifest
  head and artifact digest.
- `exportProvenance.ts`: one provenance object for all terrain exports, with
  `provenanceLines` (text) and `provenanceJson` (structured).
- `figureProvenance.ts`: PNG `tEXt`/`iTXt` chunks.
- New for single-file vector exports: `src/export/lightProvenance.ts`, a flat
  record (build, time, base name, CRS label, level, basis).

## Before

| Export | B | S | H | C | CS | I | D | M | P | T | R |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DEM package ZIP (ASC, GeoTIFF, README, passport) | yes | yes | no | yes | no | no | yes | yes | part | yes | part |
| EvidenceDEM rasters (inside the DEM package) | yes | yes | no | yes | no | no | yes | yes | yes | yes | part |
| Contour GeoJSON (analytical, cartographic) | yes | yes | no | yes | no | no | yes | yes | part | yes | part |
| Contour DXF, SVG (comment block) | yes | yes | no | yes | no | no | yes | part | part | yes | part |
| Contour map PDF | yes | yes | no | yes | no | no | yes | part | part | yes | part |
| Contour deliverable ZIP | yes | yes | no | yes | no | no | yes | yes | part | yes | part |
| Terrain intelligence report PDF | yes | yes | no | yes | no | no | yes | part | part | yes | part |
| Flow Pulse package ZIP | yes | yes | no | yes | no | no | no | yes | yes | yes | yes |
| Terrain Access package ZIP | yes | yes | no | yes | no | no | no | yes | yes | yes | yes |
| Observatory package ZIP | yes | no | part | part | no | no | yes | yes | yes | yes | yes |
| Measurement GeoJSON | no | no | no | part | no | no | no | no | no | no | part |
| Measurement CSV | no | no | no | part | no | no | no | no | no | no | part |
| Measurement integrity report JSON | part | yes | no | part | no | no | no | no | no | yes | part |
| Site KML, scan-area KML | no | no | no | part | no | no | no | no | no | no | part |
| Image exports (height, intensity, class, normal, ortho PNG) | yes | no | no | yes | no | no | no | n/a | part | yes | part |
| PNG world file (`.pgw`) | no | no | no | no | no | no | no | n/a | n/a | no | n/a |
| Studio figure PNG | yes | no | no | yes | no | no | no | n/a | part | yes | part |
| Scan report PDF | part | yes | no | yes | no | yes | part | no | no | yes | part |
| Session file (`.olvsession`) | part | yes | no | yes | no | no | no | yes | part | yes | part |
| Point cloud re-save LAS 1.2, 1.4, `.las.gz` | part | no | no | yes | no | no | no | n/a | n/a | no | n/a |
| Point cloud re-save XYZ, ASC | no | no | no | part | no | no | no | n/a | n/a | no | n/a |

Summary before, counting a row as full when B, S, C, I, D, M, P and T are all
`yes`: full 0, partial 19, none 2 (world file; XYZ, ASC). No row carried both
I and D.

## After

Only the changed rows are listed; every other row is as above.

| Export | I | D | B | S | T | What changed |
| --- | --- | --- | --- | --- | --- | --- |
| DEM package ZIP | yes | yes | yes | yes | yes | README `Interpretation level`, `Data basis`; manifest op |
| EvidenceDEM rasters | yes | yes | yes | yes | yes | Same README and passport as the DEM package |
| Contour GeoJSON | yes | yes | yes | yes | yes | `metadata.sourceInterpretation`; manifest op |
| Contour DXF, SVG | yes | yes | yes | yes | yes | `Interpretation`, `Data basis` comment lines |
| Contour deliverable ZIP | yes | yes | yes | yes | yes | Provenance JSON and README; the sheet PDF inside is covered by them |
| Terrain intelligence report PDF | yes | yes | yes | yes | yes | `Interpretation level` and `Data basis` rows in the provenance table |
| Flow Pulse package ZIP | yes | yes | yes | yes | yes | README lines; manifest op |
| Terrain Access package ZIP | yes | yes | yes | yes | yes | README lines; manifest op |
| Observatory package ZIP | yes | yes | yes | no | yes | README lines; manifest op (basis from the run record) |
| Measurement GeoJSON | yes | yes | yes | yes | yes | `provenance` foreign member (RFC 7946 section 6.1) |
| Site KML | yes | yes | yes | yes | yes | One provenance line in the document description |
| Image exports (PNG) | yes | yes | yes | no | yes | `olv:interpretation-level`, `olv:data-basis` chunks |

The level is `not-probed` when the file opened on its signature and
`not-recorded` when the export path did not read it. The data basis is
`unknown` when the producing layer recorded none.

Summary after, on the same count: full 2 (Flow Pulse and Terrain Access
packages), partial 17, none 2. Twelve rows now carry both I and D. The DEM and
contour exports stay partial because the cell size is printed in the README but
not bound in the manifest, and no export records H.

### Where the CRS came from (CS), L194

| Export | CS | Where |
| --- | --- | --- |
| Measurement GeoJSON | yes | `provenance.crsOrigin` |
| Site KML | yes | `CRS source ...` in the provenance line |
| Observatory package ZIP | yes | `crsOrigin` param of the interpretation op; README line |

`crsOrigin` is copied from the resolved CRS: the source token (`las-vlr`,
`las-evlr`, `user-override`, ...), name, EPSG, vertical datum and the source
that declared it. Each field reads `unknown` when no CRS was resolved.

### Source and analysis-input digests (H), L209

| Export | Source SHA-256 | Analysis input SHA-256 | CRS origin |
| --- | --- | --- | --- |
| Point XYZ, PLY, OBJ | `# Source SHA-256:` / `comment` line | not an analysis | `CRS source ...` line |
| Point CSV | no slot | not an analysis | no slot |
| LAS re-save | Text Area Description VLR | not an analysis | same VLR |
| XYZ, ASC re-save | `#` line | not an analysis | `#` line |
| Measurement GeoJSON | `provenance.sourceSha256` | not an analysis | `provenance.crsOrigin` |
| Site KML | provenance line | not an analysis | provenance line |
| Integrity and findings report JSON | `dataset.sourceSha256` | not an analysis | `dataset.crsOrigin` |
| Figure and snapshot PNG | `olv:source-sha256` | not an analysis | `olv:crs-origin` |
| Scan report PDF | Dataset summary row | not an analysis | Dataset summary row |
| Contour GeoJSON, DXF, SVG | provenance block | `Input SHA-256` | `CRS origin` |
| Contour map sheet PDF | Info dictionary Subject | Subject | Subject |
| DEM package | README; DTM passport | README | README; manifest op |
| Complete deliverable ZIP | `Provenance.json`; README | same | same |
| Terrain report PDF | provenance footer | footer | footer |
| Observatory package | README; passport | README (resident positions) | README; manifest op |
| Flow Pulse, Terrain Access packages | README; passport | README (`Input digest`, the DTM product digest) | README; manifest op |

The source digest is SHA-256 over the original file bytes, hashed in a worker
the first time a scan is exported and cached per file. A streamed scan records
`not available for streamed sources`; a scan whose file is not held records
that; no export writes a stand-in value. The analysis-input digest is SHA-256
over the gathered XYZ the terrain core read, each value a little-endian
float32, in order; it is computed inside the core, in the terrain worker, and
is carried by the cached and persisted core.

## Remaining gaps

| Gap | Where | Reason left open |
| --- | --- | --- |
| No source content hash for streamed scans | COPC, EPT, 3D Tiles, out-of-core LAS | Only part of the file is read. The record states it. |
| Digests and CRS origin | session file; point and measurement CSV; multi-layer figure PNG | No slot, or no single source file. |
| Measurement CSV | measurement export | No metadata slot; a comment line breaks spreadsheet readers. Export the GeoJSON beside it. |
| Measurement methods | GeoJSON, KML, integrity report | Measurement geometry has no registered method id. The record says so. |
| Contour map sheet PDF | Contour Studio | The title block has no free row; the record is in the GeoJSON, DXF, SVG and the deliverable ZIP made from the same run. |
| Session file | `.olvsession` | The session manifest is built without the analysed basis, so its op reads `not-recorded` / `unknown`. |
| World file | image export | No slot. |
| Cell size and interval in the terrain manifest | terrain exports | The DTM op notes the cell size is not captured; the README prints it. |

## How reproduction is tested

`tests/reproduceFromProvenance.test.ts` reads the recorded fields back and
re-runs the same method on the same fixture:

- Measure distance: geometry and CRS from the GeoJSON, same `length_m`.
- DEM product: cell size from the README, same `dtm.asc` bytes.
- Flow Pulse: `*.olv-field-sim.json` and the manifest, same `fieldDigest` and
  the same accumulation grid.

`tests/exportSourceInterpretation.test.ts` checks the fields in each changed
export.
