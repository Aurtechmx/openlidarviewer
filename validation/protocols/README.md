# Frozen validation protocols

A protocol record is the decision taken **before** a study ran: what question it
answers, which datasets and parameter sets it admits, and the tolerance that
decides its outcome.

## Why the file is separate from the study

A study manifest already carries `protocolDigest`, recomputed from the manifest
itself. That catches one field being edited, but not a record rewritten whole,
because whoever rewrites it recomputes that digest too.

A protocol lives in its own file, written and committed before the study runs.
A manifest points at it through `protocolRef` and repeats its digest. To loosen
a tolerance quietly you now have to edit the protocol, restamp its digest,
restamp `protocolRef.digest`, and restamp the manifest's own `protocolDigest`.
Each of those is a line in the diff, which is the whole point: the change stops
reading as "one number moved" and starts reading as "the frozen protocol
changed".

None of this makes tampering impossible. It makes it visible.

## Rules

| | |
| --- | --- |
| Shape | `validation/protocols/protocol.schema.json` |
| Checks | `node scripts/verify-cross-implementation-study.mjs` (rules P1–P8, and R11/R12 on the manifests) |
| Filename | `<protocolId>.protocol.json`, so a record is findable from the id a manifest cites |

What the verifier enforces:

- **P2** the record's `digest` describes the record on disk.
- **P4** every `claimId` is in `docs/validation/claim-register.yaml`.
- **P5** `requiredWithinToleranceFraction` is inside (0, 1]; a gate of 0 would
  call any comparison agreement.
- **P6** `recordWrittenOn` is not before `frozenOn`.
- **R11** a manifest's `protocolRef` resolves, its digest still matches, the
  protocol governs that claim, and the manifest's metrics, datasets and
  parameter sets are the ones the protocol admits.
- **R12** a non-example manifest whose status asserts a measured outcome must
  carry a `protocolRef`.

Writing a protocol promotes nothing. Evidence levels live in
`docs/validation/claim-register.yaml` and move only by a human editing that
file.

## Writing one

1. Write the record, with the tolerance and its derivation, and a
   `decisionRule` a reader can apply to the numbers without asking you what you
   meant.
2. Stamp `digest` with `protocolRecordDigestOf()` from
   `scripts/verify-cross-implementation-study.mjs`.
3. Commit it. **Then** run the study.

`frozenOn` is the date the decision was fixed; `recordWrittenOn` is the date the
file was written. When they differ the record is a transcription of an earlier
freeze, and `freezeWitness` has to name where that earlier freeze can be read
independently of this file. A protocol written after the numbers is a
description of a result, not a gate on it, and the dates are what let a reader
tell the two apart.

## Records here

| protocol | governs | state |
| --- | --- | --- |
| `PROTO-RASTER-HORN-GDAL-ANALYTIC-DEM` | `SLOPE-RASTER`, `ASPECT-RASTER`, `HILLSHADE` against GDAL 3.13.1 on the frozen analytic DEM | transcribed from the freeze in `REFERENCE_SLOTS`; three studies run under it |
| `EXAMPLE-PROTO-SLOPE-RASTER-GDAL-HORN` | a template, referenced only by the example manifest | nothing under it has been run |

There is no protocol here for a study nobody has designed. An empty tolerance
for a study that does not exist is not a freeze, and a directory of them would
make the ones that mean something harder to find.
