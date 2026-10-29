# Zenodo 15421291 small-file study

This study opens one public file, `iPhone.laz` from Zenodo record
[10.5281/zenodo.15421291](https://doi.org/10.5281/zenodo.15421291) (Hrdina, M.,
LiDAR Scanners Comparison - Point Clouds, CC BY 4.0), through each of OLV's
ingestion paths. It compares the results with each other and with an
independent reader. It also checks the record's `GroundTruth.xlsx` workbook
against the coordinate list the repository already uses.

It checks decoding, attribute handling, export and CRS provenance. It is not
sphere detection, a forestry or DBH result, or an instrument-accuracy result,
and it moves no evidence level.

## Inputs

| Register id | File | Bytes | SHA-256 |
| --- | --- | --- | --- |
| OLV-DS-055-SCANCMP-IPHONE | iPhone.laz | 11,725,514 | `bfa58faa10fd3f8bc573fee8f03bbd8d5c6722bc24550fca550f21b696569e5d` |
| OLV-DS-056-SCANCMP-GROUNDTRUTH | GroundTruth.xlsx | 31,392 | `76bdc3760ff73a5583b329536cef1a91a1c24f4f1b9ec9b11766d95622ba2a6e` |

Source URLs, licence, author and acquisition date are in
`validation/datasets/dataset-register.yaml`. Neither file is committed. The
TLS and ZEB files of the same record are not needed. `LA03mapry.laz` (202 MB) is
an optional colour-readability experiment that this command does not run.

## Running it

```
npm run validate:zenodo-small -- --setup-venv
```

The command looks for the files under `zenodo/15421291/` in the external-data
cache: the folder given by `--data`, else `$OLV_EXTERNAL_DATA`, else `../SCANS`
beside the repository. It checks size and SHA-256 against the register before
using either file and never downloads. To fetch the files, run
`node scripts/acquire-dataset.mjs OLV-DS-055-SCANCMP-IPHONE` and the same for
OLV-DS-056.

The independent reader runs in a Python venv with the versions pinned in
`scripts/zenodo-study/requirements.txt` (laspy 2.5.4, lazrs 0.6.2, numpy
2.1.3, openpyxl 3.1.5). `--setup-venv` creates it under the results folder;
`--python` or `$ZENODO_STUDY_PYTHON` names an existing one. The pooled path needs
Playwright's Chromium.

Results go to `validation-results/zenodo-15421291/` (or `--out`), which git
ignores: `results.json` holds every check with its data, and `summary.md` is
a table of them. Each check ends as passed, failed, skipped, unsupported or
unavailable. The exit code is 1 when a required check fails or a required
input, package or browser is unavailable. A missing dependency is never
reported as a pass. `--keep` keeps the intermediate record and LAS files
(about 800 MB).

The comparison logic has an offline unit test on a synthetic cloud,
`tests/zenodoStudyCompare.test.ts`; the command runs it first. The study itself
is not part of `vitest run`.

## Paths compared

| Path | What runs |
| --- | --- |
| reference | laspy + lazrs reads the original; no OLV code |
| serial | `loadLazFromFile` with pooling refused: whole-file laz-perf decode, the loader's origin choice and cloud construction |
| fullfile | `loadLas` on the whole buffer, pooling refused with `?decodePool=off` because Node has no `Worker`. This is serial coverage, not pooled |
| pooled | the same loader in headless Chromium with the default policy; the file has over a million points, so the LAZ chunks are decoded by a pool of `lazChunkWorker` workers. The run fails unless the loader reports the pooled path. The page calls the loader directly; the app calls it from its parse worker for a non-COPC LAZ, and streams this file as COPC instead |
| copc | `StreamingPointCloud.open` (which opens `CopcSource`) over an `ArrayBufferRangeSource`, the full hierarchy walk, then every data node read by range and decoded once with `decompressChunk` and `decodeRecords`, the functions the COPC worker runs, with the stream's own decode metadata |
| copc-reversed | the same over a local `File` range source with the nodes decoded in reverse order, to show the file-level colour decision does not depend on which node arrives first |
| app | the app from the dev server in headless Chromium: open through the file input, orbit and zoom, read the Coordinate system section and Export readiness, choose EPSG:5514, read both again without reopening |
| export | `convertCloud` to LAS 1.4 from the serial cloud, read back by laspy |

Each path is reduced to one fixed-width record per point: the LAS integer X,
Y, Z and every per-point attribute OLV keeps for point format 7. The paths
hold float32 positions about an origin, so integers are recovered as
`round((world - offset) / scale)`. The residual of that step is reported per
axis and must stay under the float32 half-step at the largest local
coordinate. Both sides are then sorted by the whole record and compared
position by position. Duplicate records are kept, and there is no nearest
neighbour, ICP or deduplication.

## Results

Run on 2026-10-28, Node 22.23.4, macOS 26.5 arm64, Chromium 153 headless,
14 cores. 2,207,759 points on every path.

| Comparison | Records compared | Fields | Mismatched records |
| --- | --- | --- | --- |
| serial vs reference | 2,207,759 | 18 | 0 |
| fullfile vs reference and vs serial | 2,207,759 | 18 | 0 |
| copc-reversed vs reference and vs copc | 2,207,759 | 13 | 0 |
| pooled vs reference | 2,207,759 | 18 | 0 |
| copc vs reference | 2,207,759 | 13 | 0 |
| pooled vs serial | 2,207,759 | 18 | 0 |
| copc vs serial | 2,207,759 | 13 | 0 |
| export vs reference | 2,207,759 | 16 | 0 |

The file holds 2 exactly repeated records and 147 repeated X, Y, Z
positions. Every path keeps both repeated records.

Representation error, the largest `|world - (integer * scale + offset)|`:

| Path | X (m) | Y (m) | Z (m) | float32 bound (m) |
| --- | --- | --- | --- | --- |
| serial, pooled | 1.89e-6 | 3.78e-6 | 2.37e-7 | 1.91e-6 / 3.82e-6 / 2.38e-7 |
| copc | 1.89e-6 | 1.89e-6 | 1.89e-6 | 1.91e-6 on each axis |

The scale step is 0.001 m, so every integer is recovered without ambiguity.
The serial and pooled paths recentre on the floored header minimum
(-744305, -1036303, 306) and the COPC path on the octree centre, which explains
the different bounds.

COPC structure: 130 data nodes on one hierarchy page, depth 0 to 5. All 130
were decoded once each. There are no duplicate keys, no overlapping byte ranges
and no short nodes, and the node counts sum to the header's 2,207,759.

Attributes:

- RGB is stored as 8-bit colour times 256, so the low byte is 0 everywhere.
  OLV keeps the high byte, which loses nothing here. A LAS export writes each
  8-bit value times 257, so the 16-bit numbers differ from the source while
  the 8-bit colour is unchanged.
- Intensity, classification, return number and number of returns are 0 on
  every point. LAS numbers returns from 1. A LAS export writes 0 as 1 and
  records that in its log and in the file's text area. That is the only
  attribute the export changes besides RGB scaling.
- The COPC streaming path does not decode scan angle, user data, scanner
  channel, scan direction or edge of flight line. The study reports these as
  unsupported on that path; the serial and pooled paths decode them.
- The three float64 extra-bytes dimensions, NormalX, NormalY and NormalZ, are
  not read by any OLV path and are not written on export, so the round trip is
  not lossless. The COPC hierarchy, the empty WKT record and the qgis
  statistics EVLR are not carried to the export either.

Colour: the iPhone RGB reads as readable (chromatic fraction 0.90, luminance
interquartile range 132) and the scan opens in RGB, "true colour — the scan
carries per-point RGB". Both node orders make the same 16-bit colour decision.
For the near-uniform LA03 colour, `tests/zenodoLa03ColourObserved.test.ts` runs
on 2,000 real LA03 records (`tests/fixtures/zenodo-15421291/OLV-DS-054-la03-sample.las`,
52,321 bytes, re-extracted bit for bit by `scripts/zenodo-study/extract-la03-fixture.py`
after it checks the source hash). The colour is measured as uniform, the scan opens
in another supported mode, and RGB stays selectable.

Negative controls, run on the real file:

| Control | Result |
| --- | --- |
| wrong-hash input (truncated copy) | the command fails before any decode, naming the size and hash |
| missing input, missing venv | reported unavailable; exit 1 |
| cancelled node read | `RangeReadError` with code `aborted` |
| node range past the end of the file | `LoadError` naming the node and the file size |
| negative range offset | `RangeReadError` with code `out-of-range` |
| half of a node's compressed bytes passed straight to the decoder | `LoadError` (malformed-file): the chunk is shorter than the size the hierarchy declares. laz-perf's `ChunkDecoder` takes a pointer and no length; given half of a 458,467-byte node it returned all 92,519 points with no error, and from point 404 on its output depended on the WASM heap bytes after the input. Since the decoder cannot detect this, `decompressChunk` now checks the chunk against the declared node size |
| pool workers after a pooled load | all 4 chunk workers closed within 2 s |

## CRS provenance

The file sets the WKT bit in global encoding and carries a record-id 2112 WKT
VLR whose payload is one NUL byte. It declares no CRS. EPSG:5514 comes from the
publisher's record description.

| Case | Result |
| --- | --- |
| original file | no CRS; resolves to `unknown`, source `default-assumption`. Nothing is taken from the file name, the coordinate magnitudes or the record description |
| a stored catalogue record for the same name | not applied to a file opened from disk |
| publisher's statement supplied as a catalogue assertion | EPSG:5514, source `catalog-tile`, asserted by the record description, confidence medium, not user-confirmed |
| user override | EPSG:5514, source `user-override`, user-confirmed |
| measurement eligibility | ground-metre claims refused while unresolved, permitted under the assertion or the override |
| the app | opening shows "CRS unknown. Coordinates are shown in source units only." with the override control beside it. Choosing EPSG:5514 there updates the section and the Export readiness row to Known without reopening; Vertical datum stays Unknown |
| coordinates | cloud positions and origin byte-identical before and after each resolution and export; exports under each CRS hold the same integers |
| session read-back | keeps `catalog-tile` and its asserting party, `user-override`, and `unknown` apart |
| LAS export | no CRS: no WKT, CRS source `default-assumption`. Catalogue: EPSG:5514 WKT, CRS source `catalog-tile` with the asserting party. Override: WKT, CRS source `user-override`. Assign: WKT plus a `crs-assigned` line stating that coordinates were not moved |

OLV has no catalogue entry for this record. The study supplies the
publisher's statement in the shape the resolver receives for a streamed
catalogue tile. No coordinate transformation is performed anywhere in the
study.

## Workbook

`GroundTruth.xlsx` has two sheets. `TreesPoints` holds 236 trees with
BM-prefixed identifiers and the columns `x`, `y`, `z`, `Specie`, `DBH_T`,
`H_T`, `H_Model`, `Volume` and `Pozn`. The workbook does not document them. By
name, `DBH_T` and `H_T` look like field measurements and `H_Model` and `Volume`
look modelled; this repository does not rely on that reading and does not use
the sheet. `ReferencePoints` holds 13 entries: the control point
Auto and the spheres Koule01 to Koule12, with coordinates stored as text. All
13 match `validation/sphere-accuracy/spheres-epsg5514.csv` by name. The largest
difference is 5.0e-7 m, which is the CSV's rounding to 6 decimals.
`tests/sphereAccuracyLayerA.test.ts` uses that CSV to check distance arithmetic
and coordinate handling. It reads no scan and locates no sphere. The number of
published decimals says nothing about survey accuracy, and agreement between
the workbook and the CSV does not show that OLV found the spheres in any scan.

## Defects found and fixed

- A session read back without the name of the catalogue behind a
  catalogue-asserted CRS (`src/io/sessionCrs.ts`). Test:
  `tests/sessionCrsAssertedBy.test.ts`.
- A LAS export raised return numbers of 0 to 1 without saying so
  (`src/convert/writeLas.ts`, the clamp in both writers; reported from
  `src/convert/convertCloud.ts`). Test: `tests/convertReturnZero.test.ts`.
- Export readiness and the Dataset Story read the file's declared CRS, so
  after the user assigned EPSG:5514 the Coordinate system row still said
  Unknown (`src/main.ts`, `buildCurrentStoryInputs`). They now read the
  resolved CRS. Test: `tests/exportHealthGeoref.test.ts`; the app journey
  above shows it on the real file.
- A COPC node chunk shorter than its declared size decoded into a full set
  of points built partly from unrelated WASM memory
  (`src/io/copc/copcChunkDecompress.ts`). It is now refused before decoding.
  Test: `tests/copcTruncatedChunk.test.ts`.
- An export with an assigned CRS did not record the assignment, so the
  written WKT read like the source's own declaration
  (`src/convert/convertCloud.ts`). Test: `tests/convertAssignRecord.test.ts`.

## Not covered

- The pooled run calls the loader from a page, not from the app's parse
  worker. The app journey covers open, navigation and CRS assignment; clip,
  measure, export from the UI and reopen were not driven. Firefox and WebKit
  were not run.
- Opened in the app, iPhone.laz is detected as COPC and streamed
  (`src/app/openScan.ts`, `detectCopc` before any LAZ loader), so the app
  itself uses the COPC path, not the serial or pooled LAZ loaders. Its Export
  readiness Scan scope row therefore reads "Resident preview": the streaming
  card records `resident-only` coverage at attach time
  (`src/app/inspectorCardRefreshers.ts`), because residency moves with the
  view and the budget. That label is accurate for a stream; it does not say
  whether all 130 nodes happened to be resident.
- Physical accuracy of any kind, sphere fitting, and the TLS, ZEB and LA03
  files.
- Normals: OLV does not read LAS extra-bytes dimensions.
