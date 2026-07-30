# Impact records

**This container is empty. No institutional use, research output or citation has
been recorded.** `summary.json` counts zero and says so.

`records/` holds one record, `EXAMPLE-RESEARCH-OUTPUT.impact.json`, prefixed
`EXAMPLE-` and marked `example: true`. It is a filled-in template.

## What is here

| File | What it is |
| --- | --- |
| `impact-record.schema.json` | What an impact record must state |
| `records/EXAMPLE-*.impact.json` | One example, counted nowhere |
| `summary.json` | Built from records that verify; examples and unverified records are excluded and listed |
| `../../scripts/verify-impact-record.mjs` | The verifier, exit 1 on a bad record |
| `../../scripts/build-impact-summary.mjs` | The builder, `--check` for staleness |
| `../../tests/impactRecord.test.ts` | Proof each refusal fires for its own reason |

## What a record has to state

What happened, who it happened at, and a source a stranger can resolve: a DOI,
an arXiv id, a PubMed id, an ISBN, a handle, a Software Heritage identifier, or
an https URL with an independent archive snapshot beside it. Plus how the source
was checked, by what method and on what date, and whether the work was done by
this project's own members.

## What the verifier refuses

A record with no verifiable source may not sit at status `verified`. The
vocabulary keeps `personal-communication` and `unpublished` so a record can say
honestly what it is; those simply never reach a count. It also refuses a
verified URL with no archive snapshot, a "verified" status next to a
`not-verified` method, a self-report standing in for verification, our own
authorship filed as institutional adoption, and the same source recorded twice.

It does not fetch anything: a DOI that passes the shape check here has not been
resolved by the script, and the record names who resolved it and when.

## Why the bar is here

An unverifiable claim of impact is worse than none. It spends exactly the
credibility that the rest of this repository's evidence discipline exists to
earn, and it is the easiest sentence in the world to write.
