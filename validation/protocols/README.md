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
- **P6** `recordWrittenOn` is not before a claim's freeze date.
- **P9** a freeze marked `preregistered` has a freeze date strictly before its
  result date, and one marked `adopted-with-result` does not.
- **R11** a manifest's `protocolRef` resolves, its digest still matches, the
  protocol governs that claim, the manifest's metrics, datasets and parameter
  sets are the ones the protocol admits, and a measured outcome cites a claim
  entry that records `resultLandedOn`.
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

## Freeze provenance is per claim

Each `claims[]` entry carries its own `freeze` block, because one protocol can
govern claims whose tolerances were fixed at different times and under different
conditions. In `PROTO-RASTER-HORN-GDAL-ANALYTIC-DEM` two of the three were
preregistered weeks ahead and the third was not.

`status` has two values and they are not interchangeable:

- `preregistered` — a commit shows this tolerance while the claim had no
  result, so the result cannot have chosen it. `witnessCommit` is the
  **earliest** such commit; a later one that also shows the tolerance proves
  less.
- `adopted-with-result` — the tolerance was fixed in the same change that
  produced the numbers. Often defensible, when a sibling claim's tolerance is
  carried over on the merits. Never a preregistration, and it may not be
  written as one.

`witnessCommit` is a hash rather than prose so that checking it is a git
command instead of an interpretation. `resultLandedOn` is the other half: R11
refuses to let a manifest asserting a measured outcome cite a claim entry
without it, so a freeze cannot be made unfalsifiable by leaving the comparison
date out.

The first version of this directory got exactly this wrong. It carried one
frozen date for a record governing three claims, which was true for two of them
and false for the third, and no check in the tree could tell. A reviewer caught
it by walking `git log` on `src/validation/crossCheck.ts`. P9 is that walk,
written down.

## Records here

| protocol | governs | state |
| --- | --- | --- |
| `PROTO-RASTER-HORN-GDAL-ANALYTIC-DEM` | `SLOPE-RASTER`, `ASPECT-RASTER`, `HILLSHADE` against GDAL 3.13.1 on the frozen analytic DEM | transcribed from `REFERENCE_SLOTS`; slope and hillshade preregistered at `a78b0f9`, aspect adopted with its result at `40e2ca1`; three studies run under it |
| `EXAMPLE-PROTO-SLOPE-RASTER-GDAL-HORN` | a template, referenced only by the example manifest | nothing under it has been run |

There is no protocol here for a study nobody has designed. An empty tolerance
for a study that does not exist is not a freeze, and a directory of them would
make the ones that mean something harder to find.
