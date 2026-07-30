# Research impact

This page is empty of results, and that is the accurate state.

`validation/impact/` holds the schema and the verifier for recording use of
this software in research: an institutional deployment, a paper that used it, a
citation. Each record needs a source a reader can resolve without asking us.
`scripts/verify-impact-record.mjs` refuses a record marked `verified` whose only
source is a private communication or this project's own say-so, and
`validation/impact/summary.json` counts nothing that has not passed it. The
schema is deliberately harder to satisfy than the claim it records is exciting.

At the time of writing the register contains one example record and no real
ones, so `countedRecords` is 0. That number will stay 0 until somebody outside
this project uses the software and says so somewhere a stranger can check, and
there is no way to hurry it that would leave the number worth reading.

## Why it is not a list of everything we have heard

Impact is the easiest thing in a research repository to overstate. A mailing
list message saying someone tried the viewer is not evidence that they did,
and a screenshot is not a citation. Recording those would spend the
credibility that the rest of the evidence discipline here exists to earn, and
it would spend it on the least important claim the project makes.

So the bar is a public, resolvable source. The cost of that bar is this page
being empty for a while, which is a cost worth paying.

## Adding a record

Write a record under `validation/impact/records/`, run
`npm run validation:impact:verify`, and rebuild the summary with
`npm run validation:impact:summary`. The verifier will tell you what is
missing. If it refuses the record, the record is wrong, not the check.
