# Authorization integrity benchmark

Frozen adversarial cases for scientific-output authorization. Each perturbs a fully-supported baseline and asks whether the existing authorization machinery (`ProcessService.authorize` / `runIfAuthorized` / `isAuthenticAuthorization`) correctly refuses an unsupported output.

| Metric | Value | Target |
|---|---|---|
| UOAR (unsupported authorized) | 0 | 0 |
| ORR (valid controls refused) | 0 | 0 |
| ATR (authorized w/ provenance) | 1 | 1 |

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
