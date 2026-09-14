# Authorization integrity benchmark

Frozen adversarial cases for scientific-output authorization. Each perturbs a fully-supported baseline and asks whether the authorization machinery refuses an unsupported output. A01–A12 construct a state (`ProcessService.authorize` / `runIfAuthorized` / `isAuthenticAuthorization`), A13–A20 reuse a token across states, A21–A28 mint the production export permit (`resolveContourExportPermit`). ATR is a structural invariant: a token carries its grant reason and a permit carries its claim set by construction.

| Metric | Value | Target |
|---|---|---|
| UOAR (unsupported authorized) | 0 | 0 |
| ORR (valid controls refused) | 0 | 0 |
| ATR (authorized w/ provenance) | 1 | 1 |
| SAAR (stale tokens accepted) | 0 | 0 |
| CPAR (coverage-blind production permits) | 0 | 0 |

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
| A21 | adversarial | dtm | refused | ✓ | production permit on a sampled read, fully supported frame, registry stubbed validated — exploratory |
| A22 | adversarial | dtm | refused | ✓ | production permit on a resident-only streaming read, registry stubbed validated — exploratory |
| A23 | adversarial | dtm | refused | ✓ | production permit on derived ground, registry stubbed validated — exploratory (GROUND_DERIVED) |
| A24 | adversarial | contours | refused | ✓ | registry patched to validated on every claim, sampled load — still exploratory |
| A25 | adversarial | contours | refused | ✓ | permit vs provenance: crisp map PDF with RMSEz — one governing claim, refused above it |
| A26 | adversarial | contours | refused | ✓ | validated branch with a token minted on state S₁, export attempted on S₂ — capped to exploratory |
| A27 | control | contours | authorized | ✓ | control — interface Claim equals the permit stamp across six frames (supported, sampled, unit unknown, no CRS, derived ground, precision refused) |
| A28 | control | contours | authorized | ✓ | control — full coverage, producer ground, fresh token, registry stubbed validated — validated |
