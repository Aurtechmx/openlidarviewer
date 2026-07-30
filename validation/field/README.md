# Field studies (E5)

**This container is empty. No field study has been run.**

`studies/` holds one record, `EXAMPLE-DTM-FIELD-CHECK.field.json`, prefixed
`EXAMPLE-` and marked `example: true`. It is a filled-in template. No instrument
was set up, no checkpoint was surveyed, and nobody went to a site.

## What is here

| File | What it is |
| --- | --- |
| `field-study.schema.json` | What a field study record must state |
| `studies/EXAMPLE-*.field.json` | One example, counted nowhere |
| `EXAMPLE-protocol.md` | The preregistered protocol the example points at |
| `../../scripts/verify-field-study.mjs` | The verifier, exit 1 on a bad record |
| `../../tests/fieldStudyRecord.test.ts` | Proof each refusal fires for its own reason |

## What a record has to state

An instrument with a stated accuracy and a calibration date, the survey method
and reference frame, where the checkpoints came from and how many there were,
how each one was used, how many operators worked and whether they were
independent of each other and of this project, a protocol frozen before anyone
went to the site, and an explicit list of what the study does not cover.

## What the verifier refuses

The one that matters is checkpoint leakage. `src/validation/checkpointAccuracy.ts`
refuses a checkpoint set whose members were used as control, in registration, for
parameter tuning or for manual correction: an accuracy figure over them measures
the fit, not the error. That protects a function call. `verify-field-study.mjs`
applies the same refusal to a whole record, which is the half that was missing —
a record can carry leaked checkpoints and an RMSE without ever passing through
that function.

It also refuses a protocol registered after fieldwork started, a tolerance edited
after the fact (the protocol digest stops matching), an operator affiliated with
this project counted as independent, a status the numbers do not support, a scope
broader than the strata surveyed, and an RMSE below the reference instrument's own
stated accuracy.

## Why it stays empty until it is not

E5 needs real instruments, real ground and real surveyors. None of that can be
produced from inside a repository, and inventing it would destroy the only thing
this project is actually claiming: that its evidence statements can be checked.
An empty verified container is a true statement.
