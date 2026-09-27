# Render budget calibration, v2: emulated slower CPU (pre-registration)

Status: pre-registered. Written and committed before any v2 measurement. The
conditions, precondition, criteria, datasets, run counts and thresholds below
are fixed and are not to be changed after results are seen. A failing result
is recorded as FAIL; a run whose precondition is not met is recorded as VOID.

## Why a v2

The v1 A/B (`render-budget-calibration-v1.md`, records
`validation/performance/render-budget-calibration/2026-09-27-8a644fb5-mbp-local-v1-{A,B}.json`)
failed and was inconclusive: on the Apple M3 Max the warm-up picked level 0 in
all 70 calibrated runs, so both arms ran the same starting level and the test
measured noise. v2 asks the v1 question under conditions where the warm-up has
a chance to pick a nonzero level.

## What is emulated, and what is not

The slower machine is emulated with Chromium's DevTools CPU throttling
(`Emulation.setCPUThrottlingRate`). This slows the main thread of the page,
so JavaScript, layout and the per-frame CPU work of the renderer take longer.
It does not slow the GPU, does not change GPU memory or bandwidth, and does
not model thermal throttling, battery power states or a slower storage or
network path. A PASS under v2 supports the calibrated start only for the
CPU-bound case on this machine. It does not replace the field-device
acceptance record, and it is not evidence for GPU-bound or thermally limited
hardware.

## Conditions (fixed before measuring)

- CPU throttling rates: 4x and 6x. Each rate is a separate A/B with its own
  verdict per dataset. No other rate is run.
- Applied with `Emulation.setCPUThrottlingRate` on a CDP session of the
  benchmark page, set once after the page is created and again before every
  load (cold and warm), in both arms. Harness switch:
  `OLV_NAV_CPU_THROTTLE=<rate>` for `tests/e2e/navJank.spec.ts`, passed by
  `scripts/calibration-ab.mjs` from `OLV_CAL_AB_CPU_THROTTLE=<rate>`. The
  rate is written into the session fingerprint flags as `cpu-throttle=<rate>x`,
  so the pair environment match rule checks that both arms ran the same rate.
- Viewport and device pixel ratio: unchanged from v1, the Playwright `bench`
  project's `Desktop Chrome` profile, 1280 x 720 CSS pixels at device pixel
  ratio 1. The harness does not size load by viewport; the load comes from
  the dataset and the throttled CPU. No viewport change is made.
- Machine, browser, flags and everything else as v1.
- Order: 4x dataset A, 4x dataset B, 6x dataset A, 6x dataset B.

## Precondition (the run is VOID if it is not met)

For each rate and dataset, at least 60% of the calibrated warm runs (21 of the
35) must end with the governor reporting a calibrated level above 0
(`presentation.governor.calibratedLevel > 0`). If fewer do, that rate and
dataset is VOID: neither PASS nor FAIL, the criteria are still computed and
recorded, and no conclusion about calibration is drawn from it.

## Arms, datasets, runs

As v1:

- Fixed: `?governor=on`. Calibrated: `?governor=calibrate`.
- A: OLV-DS-090-JEMEZ-SNOWOFF-2010-FOREST (development set).
  B: OLV-DS-093-ROGUE-SISKIYOU-2019-10TDM3449 (held out). No other dataset;
  autzen is not used.
- 7 alternating fixed/calibrated pairs per dataset and rate, each session one
  headed Chromium `@bench` run of `tests/e2e/navJank.spec.ts` with one cold and
  one warm run per trajectory (orbit, flythrough, zoomShock, scrub,
  stopInspect); the warm run is the sample. Medians per arm.

## Success criteria

Unchanged from v1 (`CRITERIA_CAL_V1`); PASS for a rate needs the precondition
met and every clause on every trajectory on both datasets.

1. p95 frame time (active window), calibrated median at most 1.05 times the
   fixed median; a paired bootstrap 95% CI of the ratio is reported.
2. Frames over 50 ms, calibrated median not higher than fixed.
3. Time to first render (warm load), calibrated median at most fixed + 100 ms.
4. Quality transitions, calibrated median at most fixed + 2.
5. Last camera input to stationary full quality, calibrated median at most
   fixed + 500 ms; a run that never reaches it counts as infinite.
6. After settling, render scale and point fraction back at 1, no mesh
   reduced, backing ratio equal to the fixed runs'.
7. Scientific result digests identical: `tests/presentationInvariance.test.ts`
   passes and every pair passes the environment match rule.

Bootstrap: 2000 resamples, seed 20260925.

## Decision rule

Calibration stays off by default whatever the outcome. A PASS at a rate on
both datasets is reported as evidence for the CPU-bound case only; turning
calibration on is a maintainer decision. FAIL or VOID is recorded as is.

## Record

`validation/performance/render-budget-calibration/<date>-<sha>-<machine>-v2-<rate>x-<A|B>.json`,
never overwritten, holding the raw sessions, the precondition count, the
per-clause values and the verdict (PASS, FAIL or VOID).
