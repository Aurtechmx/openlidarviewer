# Validation report: OpenLiDARViewer v0.7.0

## Baseline

v0.7.0 develops from v0.6.9, tag `v0.6.9`, commit
`c164e907f50ff49da7233385d92285c53dfb3b8d`. The v0.6.9 evidence record is
unchanged and remains the authority for that release.

## Test record

The test counts, the live entry size, the browser matrix and the packaging
digests for this release are not typed into this document. They come from the
release-authoritative record, `test-evidence-v0.7.0.json`, which the exact-tag
workflow generates under `OLV_GATE_MODE=release` and attaches to the release
with `gate.log`, `gate.log.sha256`, the SBOM, the release manifest and
`SHA256SUMS`. The record names the commit it measured, and that commit is the
tagged commit. The committed `docs/validation/test-evidence.json` is a
development record and is marked `releaseAuthoritative: false`.

## What has been validated

ASPRS class semantics and the classification flag layouts were verified against
the ASPRS LAS Specification 1.4 R15, Tables 8, 9, 16 and 17, rather than against
restated wording. That check corrected four legacy class labels and one defect
in the semantics module itself.

Classification flags round-trip through both writers: a record is written,
decoded and compared, covering every extended flag combination.

Unit handling was checked by tests that hold one figure to the same value on
every surface that prints it: the on-screen readout, the PDF, CSV, GeoJSON, KML,
the integrity report and snapshots. They cover compound horizontal and vertical
units, an undeclared vertical unit, and a geographic CRS.

Terrain Flow Pulse and Terrain Access are checked against synthetic surfaces
with known routing, depressions, grades and costs, and against an internal
oracle. That sets their claims at E3 and E2 as listed below. Neither has been
compared with an independent field result.

## Evidence levels

No existing claim changed evidence level. The register holds 37 claims, 17 of
them at E4 and none at E5. Three claims are new:

| Claim | Level |
| --- | --- |
| TERRAIN-FLOW-PULSE | E3 |
| TERRAIN-FLOW-DEPRESSION-INVENTORY | E2 |
| TERRAIN-ACCESS | E3, internal oracle ceiling |

Standards corrections do not promote a claim.

## What was NOT tested, and is not claimed

- No held-out reference validation. No product is at E5, and no accuracy figure
  here is an established field accuracy or a survey-grade result.
- Terrain Access is not validated as a safety or trafficability result, and
  Flow Pulse is not validated as hydrology.
- Touch gestures were not exercised on a real device. CI drives them as
  synthesized pointer events.
- The registration stack has unit tests and no user path, so nothing here
  validates it as a feature.
- Analyses on a sampled or partly resident source were not validated against the
  full file.

`KNOWN_LIMITATIONS_v0.7.0.md` lists each limit with what it discloses.
