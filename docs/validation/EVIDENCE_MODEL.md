# Evidence model

Research-hardening Phase 1. Every scientific product OpenLiDARViewer generates
carries an **evidence level**, an explicit, honest statement of how strongly the
claim is supported, and a **required** level it must reach before it may be
exported as a *validated* (non-exploratory) result. This replaces the single
`Production` status previously used in the validation matrix, which conflated
"the code works" with "the science is validated".

The canonical, machine-readable register is
[`claim-register.yaml`](./claim-register.yaml). The evidence-level identifiers
and gate logic live in [`src/validation/evidenceLevel.ts`](../../src/validation/evidenceLevel.ts)
(unit-tested in `tests/evidenceLevel.test.ts`).

## The ladder

Ordered weakest → strongest; higher is stronger.

| Level | Meaning |
|---|---|
| `E0_IMPLEMENTED` | Code exists and runs. Correctness not assessed. |
| `E1_UNIT_VERIFIED` | Unit tests pin the implementation against hand-worked expectations. |
| `E2_ANALYTICALLY_VERIFIED` | Output checked against a closed-form / analytic ground truth (e.g. slope of a synthetic plane = atan(gradient)). |
| `E3_SYNTHETICALLY_VALIDATED` | Validated end-to-end against generated known-truth fixtures (synthetic surfaces, labelled clouds we created). |
| `E4_CROSS_IMPLEMENTATION_VALIDATED` | A second, independent implementation (PDAL, GDAL, CloudCompare, …) agrees within a stated tolerance. |
| `E5_EXTERNALLY_VALIDATED` | Validated against external field ground truth by a PROSPECTIVE study: the protocol and its tolerance frozen before the observations, and the operators independent of this project. See "What E5 costs" below. |
| `E6_INDEPENDENTLY_REPRODUCED` | An independent party reproduced the result from the archived artifact. |

**The load-bearing boundary is E3 → E4.** Everything at or below E3 is verified
only against *our own* code or *our own* synthetic data. Per the non-negotiable
rules, precision is not accuracy and synthetic validation is not field
validation, so **nothing at or below E3 may claim independent or field-grade
accuracy**. Independent evidence begins at E4; field-grade validity at E5.

## What E5 costs, and why data alone does not buy it

The one-line definition above understates E5, so this section states the whole
price. `scripts/verify-field-study.mjs` enforces it, and two of its rules are
about the STUDY rather than the data:

F10 refuses a protocol written afterwards. A study whose
`preregistration.registeredAt` falls after `fieldwork.startedAt` is rejected with
"a protocol written after the observations is a report, and its tolerance was
chosen knowing the answer." The tolerance has to be committed while the result is
still unknown.
F9 refuses operators who built the software: `operators.independent` cannot
be true for anyone affiliated with this project.

The consequence is easy to miss when reading the ladder alone. An archival
dataset cannot reach E5, however good it is. A published survey with a thousand independent checkpoints was observed
before any protocol here existed, so F10 refuses it on ordering alone. The
distinction being drawn is between measuring how well the software did on data
someone already collected, and committing to a tolerance in advance and then
finding out.

Archival external data is still worth acquiring. It widens the scope a claim has
been exercised over, it can move a claim to E4 against an independent
implementation, and it is how a weakness gets found. It sits at E4, and a
register entry should say so.

Of the 28 registered claims, 17 currently sit below their required level, and
every one of those 17 requires E5. None of them is waiting on a download.

## Per-claim fields

Each register entry records, at minimum:

- `claimId`, `product`, `algorithm`, `algorithmVersion`
- `claim`, the precise scientific statement, with the event and tolerance it refers to
- `currentEvidence`, `requiredEvidence`
- `supportingTests`, `supportingDatasets`
- `units`, `crsDatum`, applicable units and CRS/datum requirements
- `assumptions`, `failureModes`
- `exportAllowed`, `userLabel`
- `validationOwner`, `lastValidationDate`, `externalSource`

Replacing the old single `Production` status, every entry carries the split:

- `softwareStatus`, does the code work / ship?
- `evidenceLevel`, the ladder rung above.
- `externalValidationStatus`, `none` | `pending` | `partial` | `complete`.
- `approvedClaim`, the strongest statement the evidence permits.
- `prohibitedClaim`, statements the evidence does **not** permit (guards against overstatement).

## Export & badge gate

`exportDecision(current, required, exportAllowed)` in the module:

- meets required → exportable as a validated artifact;
- below required (but `exportAllowed`) → exportable **only** as an explicitly
  watermarked *exploratory* artifact carrying its refusal reason;
- `exportAllowed: false` → never offered, even exploratory.

The v0.5.7 UI evidence badges (Phase 17) map each level via `evidenceBadge(...)`
to: Not assessed / Analytic / Synthetic / Cross-implementation / External /
Independently reproduced.

## Processing-provenance manifest

Alongside the gate verdict, every terrain export's provenance embeds a
**verify-only processing manifest** (`src/science/processingManifest.ts`,
schema 1): the ordered list of registered methods that produced the artifact,
each op bound to the final parameters the provenance actually carries, chained
by SHA-256 hashes seeded from the manifest envelope (schema, build identity,
source name). `verifyProcessingManifest` recomputes the chain and reports the
first altered op, so a reviewer holding only the artifact (or a `.olvsession`
that embeds the same manifest) can confirm the record of *what was run, in
what order, with which settings* is intact. The claim stops there: it is
ordering + parameters + tamper-evidence, not an execution recipe, no executor
consumes it, and an op whose settings never reached the provenance says
`params not captured in this slice` rather than fabricating them.

## How to use it

- When adding or changing a product, add/update its register entry in the same
  change. A product with no register entry is treated as `E0` / not exportable.
- Existing caveats may be strengthened, never silently removed (rule 12).
- When external evidence is unavailable, build the harness, write the dataset
  spec, and set `externalValidationStatus: pending`, do not infer it from
  density, format, or metadata (rule 9).

## Tooling that moves a claim up the ladder (Phase 3 to 4)

These exist now; they are the mechanisms, not the evidence. A claim only rises
when the mechanism is actually run against real data and the result committed.

- **E3 → E4 (cross-implementation).** `src/validation/crossCheck.ts` compares our
  grid to an independent tool's grid within a stated tolerance. The procedure is
  in [`cross-implementation.md`](./cross-implementation.md). Four reference slots
  are supplied, `SLOPE-RASTER`, `ASPECT-RASTER`, `HILLSHADE` and `CONTOURS`,
  each an independent GDAL comparison on a frozen analytic fixture; every other
  slot ships `pending`. No reference output is bundled for a slot that has not
  been compared, and none is fabricated.
- **Honest internal error.** `src/terrain/validate/spatialBlockHoldout.ts`
  replaces random point hold-out (optimistic) with spatially-blocked hold-out and
  a bootstrap CI. It still is not field accuracy (E5); it is a less-biased E3
  diagnostic.
- **Reliability vs support.** `src/terrain/validate/reliabilitySplit.ts` reports
  measured-cell empirical reliability with a Wilson interval, kept separate from
  interpolated-cell model support, which carries no calibrated-probability claim.
- **Unit safety.** `src/units/units.ts` makes source-unit vs metre confusion a
  compile error at the measurement and CRS boundaries.
