# Render budget calibration, v3: warm-up on moving frames (pre-registration)

Status: pre-registered. Written and committed before any v3 measurement and
before the v3 warm-up code. The warm-up definition, conditions, precondition,
criteria, datasets, run counts and thresholds below are fixed and are not to be
changed after results are seen. A failing result is recorded as FAIL; a rate
and dataset whose precondition is not met is recorded as VOID.

## Why a v3

v2 (`render-budget-calibration-v2.md`, records
`validation/performance/render-budget-calibration/2026-09-27-c4101a9d-mbp-local-v2-{4x,6x}-{A,B}.json`)
was VOID at 4x on both datasets, VOID at 6x on A, and FAIL at 6x on B (first
render +135 ms on orbit and +103 ms on flythrough, flythrough p95 ratio 1.053).
The v2 warm-up sampled the frames right after a load, while the scan streams in
and the camera is still. Under 4x and 6x throttling on dataset A those frames
stayed under the 16.7 ms target while frames in motion took 30 to 40 ms. The
warm-up measured a different load from the one the governor meets while the
camera moves, which is the only time the calibrated level acts.

v3 changes one thing: which frames the warm-up samples. It samples only frames
drawn while the camera is moving.

## Warm-up definition (fixed before measuring)

- Start: as in v1 and v2, the warm-up is armed by the first governor frame after
  a load starts (pending GPU uploads above 0, or a refinement phase other than
  `full-refine`). Nothing is sampled before that.
- What counts as moving: the governor's existing presentation signal, computed
  in `GovernorWiring.frame` from the render loop's NavController state. A frame
  is moving when the camera is tweening, or when the time since the camera last
  moved (`quietMs`, which is `now - cameraActivityUntilMs + RENDER_HOLDOVER_MS`)
  is below `STILL_MS` (100 ms). When the loop passes no `quietMs`, a frame is
  moving when the NavController phase is `moving`. This is the same test that
  decides whether the v2 outputs are in the moving band; no new signal is added.
- Which frame time is sampled: `frameMs(ms)` reports the interval of the frame
  that just ended. It is sampled only if the governor's previous `frame()` call
  found that frame moving. Still frames are skipped and do not count toward
  either bound.
- End: the warm-up ends at the first of N = 30 moving frames or T = 2000 ms of
  summed moving-frame time. These are the v1 and v2 bounds, now counted over
  moving frames only.
- Minimum: if the warm-up ends with fewer than 10 moving frames (the time bound
  reached first), the calibrated level is 0.
- Pick: the p95 of the sampled moving frames (nearest rank) goes through the
  governor's `frameLoad` and level mapping (`calibrationLevel`), unchanged from
  v1 and v2: level 0, 1 or 2.
- If the camera never moves after a load, the warm-up never ends and the level
  stays unset, which the governor treats as 0.
- Where it lives: in `src/render/perf/governorWiring.ts`, the one governor. No
  second controller. Still off by default, reachable only with
  `?governor=calibrate`, which exists only in dev-flag builds and is compiled out
  of the live build.

## First render

The calibrated level is applied only after the warm-up ends, and the warm-up
cannot end before the camera has moved for at least 10 frames. Before that the
calibrated arm runs exactly the fixed arm's policy. The load and first render
happen before any camera motion in every trajectory, so the calibrated start
cannot touch time to first render.

Prediction, stated before measuring: criterion 3 (time to first render,
calibrated median at most fixed + 100 ms) passes on every trajectory at both
rates on both datasets, and any difference is run-to-run noise. The v2 6x B
first-render failures (+135 ms, +103 ms) are therefore expected not to recur. If
criterion 3 fails in v3, that is recorded as FAIL and read as evidence that the
v2 first-render failures were noise of a size the criterion does not tolerate,
not as a calibration effect.

## What is emulated, and what is not

Unchanged from v2. The slower machine is emulated with Chromium's DevTools CPU
throttling (`Emulation.setCPUThrottlingRate`), which slows the page's main
thread. It does not slow the GPU, does not change GPU memory or bandwidth, and
does not model thermal throttling, battery states, storage or network. A PASS
under v3 supports the calibrated start only for the CPU-bound case on this
machine. It is not evidence for GPU-bound or thermally limited hardware and does
not replace the field-device acceptance record.

## Conditions (fixed before measuring)

As v2:

- CPU throttling rates: 4x and 6x. Each rate is a separate A/B with its own
  verdict per dataset. No other rate is run.
- Throttle applied on a CDP session of the benchmark page after creation and
  before every load, both arms, harness switch `OLV_CAL_AB_CPU_THROTTLE=<rate>`;
  fingerprint flag `cpu-throttle=<rate>x` checked by the pair match rule.
- Viewport 1280 x 720 at device pixel ratio 1 (`Desktop Chrome`), machine,
  browser and flags as v1 and v2.
- Order: 4x dataset A, 4x dataset B, 6x dataset A, 6x dataset B.
- The harness selects v3 with `OLV_CAL_AB_PROTOCOL=v3`, which changes only the
  record name, state directory and protocol path.
- Machine sharing: other agents run e2e on this Mac. Each dataset session holds
  the shared e2e lock from its first run to its evaluation, and runs its own
  preview server on a port other than 4173. The record states that the lock was
  held for the whole session.

## Precondition (the run is VOID if it is not met)

Unchanged from v2. For each rate and dataset, at least 60% of the calibrated
warm runs (21 of the 35) must end with `presentation.governor.calibratedLevel >
0`. If fewer do, that rate and dataset is VOID: the criteria are still computed
and recorded, and no conclusion about calibration is drawn from it.

## Arms, datasets, runs

Unchanged from v1 and v2:

- Fixed: `?governor=on`. Calibrated: `?governor=calibrate`.
- A: OLV-DS-090-JEMEZ-SNOWOFF-2010-FOREST (development set).
  B: OLV-DS-093-ROGUE-SISKIYOU-2019-10TDM3449 (held out). No other dataset;
  autzen is not used.
- 7 alternating fixed/calibrated pairs per dataset and rate, each session one
  headed Chromium `@bench` run of `tests/e2e/navJank.spec.ts` with one cold and
  one warm run per trajectory (orbit, flythrough, zoomShock, scrub,
  stopInspect); the warm run is the sample. Medians per arm.

## Success criteria

Unchanged from v1 and v2 (`CRITERIA_CAL_V1`). No criterion is changed. PASS for
a rate needs the precondition met and every clause on every trajectory on both
datasets.

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
   passes (15/15) and every pair passes the environment match rule.

Bootstrap: 2000 resamples, seed 20260925.

## Decision rule

Calibration stays off by default whatever the outcome. A PASS at a rate on both
datasets is reported as evidence for the CPU-bound case only; turning
calibration on is a maintainer decision. FAIL or VOID is recorded as is. No
parameter is tuned after measuring.

## Record

`validation/performance/render-budget-calibration/<date>-<sha>-<machine>-v3-<rate>x-<A|B>.json`,
never overwritten, holding the raw sessions, the precondition count, the
per-clause values, the lock statement and the verdict (PASS, FAIL or VOID).
