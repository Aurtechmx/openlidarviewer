# Validation report: OpenLiDARViewer v0.7.1-alpha.1

This is an alpha on the way to v0.7.1. It has no tag, no DOI and no
publication date, and the walkthrough of every workflow on a real scan in the
packaged build has not been done. The published record of v0.7.0 is
[VALIDATION_REPORT_v0.7.0.md](VALIDATION_REPORT_v0.7.0.md) and does not change.

## Baseline

v0.7.1-alpha.1 develops from v0.7.0, tag `v0.7.0`. The v0.7.0 evidence record
is unchanged and remains the authority for that release.

## Test record

The test counts, the live entry size, the browser matrix and the packaging
digests are not typed into this document. For a tagged release they come from
the release-authoritative record that the exact-tag workflow generates under
`OLV_GATE_MODE=release` and attaches to the release with `gate.log`,
`gate.log.sha256`, the SBOM, the release manifest and `SHA256SUMS`.
v0.7.1-alpha.1 has no tag, so no such record exists for it. The committed
`docs/validation/test-evidence.json` is a development record and is marked
`releaseAuthoritative: false`.

## What was validated since v0.7.0

Terrain Flow Pulse was compared with TauDEM 5.3.8 and GRASS GIS 8.3.2 on public
DEMs, under a protocol committed before Flow Pulse was run on the data. The
conditioned elevation matched TauDEM on all 119,119 distinct cells. Against
GRASS, 99.21% of D8 directions agreed (gate 98%), the catchment Jaccard index
was 0.9990 (gate 0.99) and 95.2% of accumulations were within 5% (gate 90%).
Six RichDEM test grids agree as corroboration.

The depression inventory matched TauDEM's filled depressions on the two Bear
Creek crops, and a synthetic suite of eight fixtures and five constructed grids
matched hand-derived values.

The live DTM's median gridding on measured cells was compared with R terra and
SciPy. Under protocol v5, all 37,012 compared cells over 50 seeded draws from
0.1 to 10 m agreed within 1e-6 m after float32 rounding. Protocol v4 failed on
reference rounding and is kept as recorded.

The file loaders were run against a pinned corpus of upstream test files from
LASzip, laspy, libE57Format, PROJ and the Point Cloud Library.

## Evidence levels

The register holds 41 claims, 18 of them at E4 and none at E5. Changes since
v0.7.0:

| Claim | Change |
| --- | --- |
| TERRAIN-FLOW-PULSE | E3 to E4 |
| TERRAIN-FLOW-DEPRESSION-INVENTORY | E2 to E3 |
| MEAS-BOX | new, E3 |
| STORAGE-HISTORY | new, E2 |

The live DTM is E4 on measured cells only for cell sizes from 0.1 to 10 m with
the grid origin at the data minimum. Other sizes, other origins and filled
cells are not covered. A terrain product whose method matches none of a claim's
studies is reported as not covered.

## What was NOT tested, and is not claimed

- No held-out reference validation. No product is at E5, and no accuracy figure
  here is an established field accuracy or a survey-grade result.
- Flow Pulse was not compared on D8 tie order, flat resolution, flow length or
  the peak-flow estimate, and agreement on archival data is not field
  validation. Terrain Access is not validated as a safety or trafficability
  result.
- Touch gestures were not exercised on a real device. CI drives them as
  synthesized pointer events.
- The registration stack has unit tests and no user path, so nothing here
  validates it as a feature.
- Analyses on a sampled or partly resident source were not validated against the
  full file.

[KNOWN_LIMITATIONS_v0.7.1-alpha.1.md](KNOWN_LIMITATIONS_v0.7.1-alpha.1.md) lists
each limit with what it discloses.
