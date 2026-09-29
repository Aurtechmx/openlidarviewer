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
not bound in the manifest, and no export records H or CS.

## Remaining gaps

| Gap | Where | Reason left open |
| --- | --- | --- |
| No source content hash | every export | No production caller computes a file hash; `sourceSha256` is wired but unset. The Observatory package records a resident positions digest (SHA-256 of every resident position the run read), which identifies the resident point set, not the file. |
| CRS source (VLR, EVLR, user) not recorded | every export | The resolved CRS is recorded, not where it came from. Needs a field on the resolved CRS. |
| Measurement CSV | measurement export | No metadata slot; a comment line breaks spreadsheet readers. Export the GeoJSON beside it. |
| Measurement methods | GeoJSON, KML, integrity report | Measurement geometry has no registered method id. The record says so. |
| Contour map sheet PDF | Contour Studio | The title block has no free row; the record is in the GeoJSON, DXF, SVG and the deliverable ZIP made from the same run. |
| Integrity report, scan report PDF | report exports | Not changed in this pass; the scan report already states the level. |
| Studio figure PNG | figure studio | Stamped from `main.ts`, which may not grow. |
| Session file | `.olvsession` | The session manifest is built without the analysed basis, so its op reads `not-recorded` / `unknown`. |
| LAS re-save | point cloud export | The Description VLR slot exists but carries the datum note only. |
| XYZ, ASC re-save; world file | point cloud and image export | No slot, and the export is not a ZIP. |
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
