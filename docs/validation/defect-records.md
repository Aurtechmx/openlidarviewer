# Defect records

This page describes the machine-readable defect registry, the two definitions
that decide whether its counts mean anything, and the limits of what it records.

The records themselves are in `validation/defects/defect-registry.json`. The
counts are in `validation/defects/defect-summary.md`, `.json` and `.csv`, all
three generated. No count appears on this page.

## Files

| file | what it is |
| --- | --- |
| `validation/defects/defect-registry.json` | The records. The only hand-written file here. |
| `validation/defects/defect-registry.schema.json` | The schema the registry must satisfy. |
| `scripts/check-defect-registry.mjs` | Validates the registry against the schema, plus rules the schema cannot express. |
| `scripts/build-defect-summary.mjs` | Generates the three summaries. `--check` fails if they are stale. |
| `validation/defects/defect-summary.{json,csv,md}` | Generated. Every statistic, and the defect-to-evidence diagram. |

To regenerate:

```
node scripts/check-defect-registry.mjs
node scripts/build-defect-summary.mjs
```

Both exit 0 on success. `build-defect-summary.mjs --check` exits 1 when a
summary no longer matches the registry, which is how a stale count is caught.

## Scope

One record per `CHANGELOG.md` **Fixed** entry for 0.6.2. Where one entry covers
more than one distinct fault, the faults are listed in that record's
`bundledFaults` field and the record count still follows the changelog, so the
registry total and the changelog total are the same number by construction.

Each record was reconstructed from the repository: the changelog entry, the
erratum where one exists, `KNOWN_LIMITATIONS_v0.6.1.md`, the fix commit,
the merged pull-request body, and the regression test named in the record.

## What "conventional suite" means here

The test suite as it stood at tag `v0.6.1`: every file under `tests/` at that
tag, run by vitest with no environment gating.

It was established by running it, not inferred. A worktree at `v0.6.1` with
`node_modules` linked from the working tree, then `npx vitest run`. The exit
code, the file counts and the test counts are recorded in the registry's
`conventionalSuiteDefinition` block.

Two things this value does not say. It does not say that any test in that run
exercised the defect: seventeen records sit in code that was present at
`v0.6.1`, and the suite passed with all of them in the tree. And it is not
available for code that did not exist at `v0.6.1`. One record spans both cases
and is recorded as `mixed`, with the split stated in its
`conventionalSuiteNote`. The schema permits `unknown`; it does not permit
inferring `green`.

## Version-paired replay

The registry says what each defect was. The replay asks something narrower: run
the regression artifact a record names against the tree at tag `v0.6.1` and
against the current tree, and record what each side did. Reachability at the
baseline is then established per record by that run, or it is not established and
the record says so.

| file | what it is |
| --- | --- |
| `scripts/replay-defects.mjs` | Runs each probe in both trees and writes one raw record per run. |
| `scripts/defect-replay-lib.mjs` | The derivation: probe planning, the state of a pair, and the three comparison files. |
| `scripts/verify-defect-replay.mjs` | Recomputes every derived value from the raw records and refuses any that does not recompute. |
| `validation/defects/replay/raw/` | One record per run: command, exit code, transcript, reporter capture. Nothing in a raw record is a judgement. |
| `validation/defects/replay/replay.{json,csv,md}` | Generated. Every state and every count. |

A probe is evidence for a record only when it failed at the baseline and passed
at the candidate. Three other outcomes exist, they are counted separately, and
none of them is folded into that one.

A probe can pass on both trees. Some do because they were written as the control
beside a case that does discriminate, and a control is supposed to hold before
and after. Others exercise a sibling path the fault never reached: a LAS 1.2
header where the fault needed a LAS 1.4 WKT record, or a pure classifier where
the fault was in one of its two callers. Either way that probe shows nothing
about the old behaviour, and its state is `non-discriminating`.

A probe can also fail at the baseline for a reason that is not the defect. Where
the binding it calls is the helper the fix introduced, the call throws before it
reaches any code under test, so nothing was observed there. That reads
`component-absent-at-baseline`, the same state as a probe whose import did not
resolve in the baseline tree at all.

A run can also fail to settle, through a timeout, a missing reporter file, or a
test title that matched nothing. That is `inconclusive`, which reports on the run
rather than on the probe.

`validation/snapshot/` carries its own copy of the three comparison files,
checked against that snapshot's manifest rather than against the working tree. A
snapshot built before the states above were separated therefore still reports the
older bucket names, and rebuilding it with `npm run validation:snapshot` needs an
environment holding every producer's records. The files under
`validation/defects/replay/` are the current ones.

Rewriting a non-discriminating probe so that it fails at the baseline was
considered for each one and rejected each time. Every such probe sits in a record
that already carries a probe discriminating on the same fault, so a rewritten
control would restate evidence the record already has. One record fails the other
way round: the functions its probe would need to call were deleted by the fix, so
no probe that must pass at the candidate can reach them, and that record reads
`non-discriminating` instead of reproduced.

## Detection and discovery are separate fields

`detectingMechanism` names the validation suite that exposed the defect and
takes the value `none` when no suite did. `discoveryMethod` says how it was
found instead: `validation suite`, `code review`, `user report` or `unknown`.

They are separate because not every defect here was found by a suite. Several
came out of a targeted read of the code, and one was recorded as an open gap in
the v0.6.1 limitations before any of these suites existed. Folding those into a
suite would inflate the counts the registry exists to report, so
`check-defect-registry.mjs` fails the registry if the two fields disagree.

## Taxonomy

Each record carries one primary `validationCategory` and any number of
`secondaryTags`, drawn from the same fifteen-term list, which the schema
enumerates. The terms are of two kinds: some name what the code did wrong, some
name why the existing checks did not see it. The generator classifies them and
reports the two groupings separately, counting each record at most once per
table. The primary-category table is reported on its own alongside them.

## A correction to the changelog's composition

The 0.6.2 changelog says eighteen defects are fixed, "four carried from the
v0.6.1 vertical-unit audit, fourteen found by the new suites". The total holds.
The split does not, on two points.

`KNOWN_LIMITATIONS_v0.6.1.md` records five vertical-unit gaps, not four. Four
were closed in PR #47: `OLV-DEF-004`, `OLV-DEF-005`, `OLV-DEF-006` and
`OLV-DEF-007`. The fifth, the RFC 7946 third ordinate, is `OLV-DEF-001` and was
closed later under PR #68. It is carried from the same audit and was not found
by a new suite.

`OLV-DEF-008`, the despike blunder floor, was found while threading the
vertical-unit factor through the fill and slope stages in PR #47. It appears in
no v0.6.1 limitation and no suite reported it.

So the carried set is five records rather than four, PR #47 accounts for five
changelog entries rather than four, and the suite-found set is smaller than
fourteen. The exact figures are in `defect-summary.md` under Detection, and are
counted from the `detectingMechanism` and `discoveryMethod` fields rather than
stated here.

## What the registry does not establish

Reachability is per record and is not uniform. Some defects reached shipped
output, some sit on paths the pipeline does not use today, and one requires a
coordinate reference system combination that no real source was shown to
produce. Each record's `reachability` field says which.

A magnitude is recorded only where one was measured. Where none was, the field
is `null`. It is never zero, and the schema rejects a blank string in its place.

Severity is a judgement against the scale in the registry, not a measured
quantity. The scale is stated so the judgement can be disputed against it.

The `whyNotDetected` field describes the tests that existed, read at the fix
commit. It is not a claim that no other check anywhere could have caught the
defect.

This is not a defect census. It covers defects fixed in 0.6.2 and recorded in
the changelog. Defects a suite reported and left unfixed are tracked in the
limitations documents, not here.

## Interpretation

Everything above this heading describes what the records contain. What follows
is reading, and is separable from the records.

Three observations survive the records without extending them.

The suites that found defects found them by comparing two things that had to
agree: two exporters of one raster, the streaming and static gradings of one
scan, an independent decoder against the shipped one, a declaration against the
artifact it describes. None of these is a new idea. Metamorphic relations,
differential testing against a second implementation and cross-checking against
an independent oracle are long-standing practice, and this project applies them
rather than introduces them. What the records support is narrower: on this
codebase, a check with a second source of truth found faults that a check
asserting one path's own output did not.

The pre-existing tests that missed a defect frequently asserted the defect.
Several records name a case that pinned the wrong behaviour as expected: a
foot-vertical ordinate asserted to carry feet, a fixed generating-software
literal asserted verbatim, a hold-out ratio that only held because of the bug.
A test written from the code rather than from an external requirement records
what the code does. That is a property of how those tests were written, and the
records show it happening more than once.

Unit and frame handling dominates the categories. That is consistent with a
codebase where a quantity is derived in more than one place and the derivations
drifted apart, which is what most of these records describe. It is a statement
about this release's records and not a rate: no comparable registry exists for
earlier releases, so nothing here says whether the concentration is rising or
falling.
