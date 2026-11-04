# Profile ground-first rule: result of the paired test

Protocol: [profile-ground-first-paired-v1.md](profile-ground-first-paired-v1.md).
Fixtures, figures and the check that reproduces them:
`tests/fixtures/profile-paired/` and `tests/profileGroundFirstPaired.test.ts`.

## Outcome

Run on 2026-11-04 through the app's sampler. Means of four realisations; `E` is
recovery error and `H` is height error, both relative to RMS(u).

| Background | Labels | All-returns E | Ground-first E | All-returns H | Ground-first H |
|---|---|---:|---:|---:|---:|
| flat | filter | 0.214 | 0.308 | 0.234 | 0.328 |
| 10 % slope | filter | 0.212 | 0.240 | 0.250 | 0.281 |
| 30 % slope | filter | 0.216 | 0.219 | 0.307 | 0.313 |
| hill | filter | 0.192 | 0.248 | 0.430 | 0.484 |
| flat | ground-known | 0.214 | 0.218 | 0.234 | 0.240 |
| 10 % slope | ground-known | 0.212 | 0.215 | 0.250 | 0.255 |
| 30 % slope | ground-known | 0.216 | 0.219 | 0.307 | 0.312 |
| hill | ground-known | 0.192 | 0.192 | 0.430 | 0.436 |

The `classified` control gave the same series under both rules. No station was
empty. Amplitude retained `G` was 0.927 to 0.974 over every rule and label set;
the lowest was `ground-first` with `filter` labels on the hill.

The decision rule's worst figures on `filter` were `E` 0.308 against 0.216 and `H`
0.484 against 0.430; on `ground-known` they were `E` 0.219 against 0.216 and `H`
0.436 against 0.430. All four differences are inside the 0.10 margin, so the rule
allowed `ground-first`.

The prediction did not hold. `ground-first` lost on `E` on flat ground as
predicted, but it did not win on `H` on `ground-known`. The fixture cannot show
that win: three crowns put at most 28 % canopy returns in any station, near the
25th percentile the all-returns rule reads, so the two rules read almost the
same height there. This test measured the rule's cost and could not measure its
benefit under dense unclassified canopy.

## What was done

The chart keeps the all-returns rule, `olv.profile.corridor-percentile@2`. This
departs from the rule's allowed outcome: `ground-first` was inside the margin
without a measured benefit, and all-returns is the rule the OGR/R study covers.

## Corridor width, an unplanned finding

Three transects of the Virginia Tech StREAM Lab Spring 2026 drone survey (see
`docs/project/THIRD_PARTY_NOTICES.md`) were compared after the result above, as an
exploratory check. These were 740 m and 142 m long, from an even 1-in-90 sample
of 210.9 million points, with the provider's classes. The sampled points are not
in the repository. The two rules stayed close, and `ground-first` was slightly
rougher on all three (RMS second difference 0.42, 0.16 and 0.24 m against 0.40,
0.14 and 0.22 m). Corridor width moved the line far more. Against a line of ground returns 1 m in half-width, the RMS
difference was:

| Half-width | Along-strip transects | Across-strip transect |
|---|---:|---:|
| Automatic (37 m; 7.1 m across) | 0.52 to 1.00 m | 0.09 m |
| 5 m | 0.10 to 0.19 m | 0.06 m |
| 2 m | 0.04 to 0.09 m | 0.06 m |

The automatic corridor of a new profile now stops at a 5 m half-width on a scan
whose metre scale is resolved; a scan with no linear scale keeps 5 % of its
length. The provider labels serve as the reference here. They are not ground
truth.
