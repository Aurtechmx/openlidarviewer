# Authorization integrity benchmark

Frozen adversarial cases for scientific-output authorization. Each perturbs a fully-supported baseline and asks whether the existing authorization machinery (`ProcessService.authorize` / `runIfAuthorized` / `isAuthenticAuthorization`) correctly refuses an unsupported output.

| Metric | Value | Target |
|---|---|---|
| UOAR (unsupported authorized) | 0 | 0 |
| ORR (valid controls refused) | 0 | 0 |
| ATR (authorized w/ provenance) | 1 | 1 |
| SAAR (stale tokens accepted) | 0 | 0 |

| Case | Kind | Product | Outcome | Correct | What it perturbs |
|---|---|---|---|---|---|
| A01 | adversarial | dtm | refused | ✓ | forge an authorization object |
| A02 | adversarial | dtm | refused | ✓ | clone a valid authorization object |
| A03 | adversarial | dtm | refused | ✓ | downgrade READY→REVIEW after issuance (re-authorize on the mutated state) |
| A04 | adversarial | dtm | refused | ✓ | remove the required ground evidence |
| A05 | adversarial | dtm | refused | ✓ | full coverage → resident-only coverage |
| A06 | adversarial | building-footprints | refused | ✓ | known units → unknown units (metric product) |
| A07 | adversarial | cross-epoch-change | refused | ✓ | compatible vertical reference → missing/incompatible |
| A08 | adversarial | dtm | refused | ✓ | producer classification provenance → derived/unknown |
| A09 | adversarial | contours | refused | ✓ | precision authorized → insufficient (adapted: unconfirmed metric unit) |
| A10 | adversarial | dtm | refused | ✓ | validated export through an unauthorized path |
| A11 | adversarial | dsm | refused | ✓ | use an authorization for the wrong product |
| A12 | control | dtm | authorized | ✓ | valid control — complete supported state |
| A13 | adversarial | dtm | refused | ✓ | authentic token reused after a relevant state revision (classification) |
| A14 | adversarial | dtm | refused | ✓ | authentic token reused for another dataset |
| A15 | adversarial | dtm | refused | ✓ | subject completeness full → partial (coverage) |
| A16 | adversarial | dtm | refused | ✓ | support completeness complete → incomplete (unit / vertical reference) |
| A17 | adversarial | building-footprints | refused | ✓ | evidence scope narrowed after authorization (building class removed) — broader dependent claim withdrawn |
| A18 | adversarial | dtm | refused | ✓ | requested claim widened beyond evidence scope (sampled coverage, full-dataset DTM requested) — refused |
| A19 | adversarial | cross-epoch-change | refused | ✓ | supporting evidence removed (one epoch collapses to resident-only) — stronger dependent claim withdrawn |
| A20 | control | dtm | authorized | ✓ | valid state-bound control — token verified against its own unchanged state |
