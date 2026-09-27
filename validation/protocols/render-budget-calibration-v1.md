# Render budget calibration, v1 (pre-registration)

Status: pre-registered. Written and committed before any calibration code
was measured. The criteria, datasets, run counts and thresholds below are
fixed and are not to be changed after results are seen. A failing result is
recorded as FAIL.

## Question

The per-tier point budgets in `src/render/deviceProfile.ts` (`DESKTOP_BUDGET`,
`MOBILE_BUDGET`) are a fixed table keyed on reported memory and cores. The
frame budget governor (`src/render/perf/frameBudgetGovernor.ts`, v3 A/B passed
on OLV-DS-090 and held-out OLV-DS-093, off by default) then lowers the render
scale and the drawn point fraction during motion, starting every motion from
full scale and stepping down only after the load window fills.

Does starting motion from a level picked from frames measured on this machine,
instead of from the fixed table, hold frame time without costing load time,
quality stability or scientific output?

## What calibration does

- It lives inside the governor module. There is no second controller: the
  calibrated level is one more input to the pure `frameBudgetPolicy`, and the
  governor's hysteresis, floors and restore-when-still rules are unchanged.
- Warm-up: after a scan starts loading (the first frame on which GPU uploads
  are pending or the refinement phase leaves `full-refine`), the governor keeps
  the frame times it already receives. Warm-up ends after 30 frames or 2000 ms
  of summed frame time, whichever comes first. With fewer than 10 frames it
  picks nothing and the fixed behaviour stands.
- Pick: p95 of the warm-up frames is mapped through the governor's own load
  function (`frameLoad`, load 0 at the 60 Hz target, 1 at twice it) onto the
  governor's own load levels: load 0 gives level 0 (no change), load in
  (0, 0.5] gives level 1, above 0.5 gives level 2.
- Use: while the camera moves, the governor's level is the higher of its live
  level and the calibrated level, so motion starts at the calibrated render
  scale and point fraction instead of at 1. When the camera is still, both
  outputs return to 1 as in v3. The static tier table itself (the LOD point
  budget handed to the loader) is not changed, so no node selection and no
  resident point changes.
- Pure presentation: render scale and drawn point fraction only. No buffer an
  analysis reads is touched; `tests/presentationInvariance.test.ts` is
  extended to cover the calibrated level.
- Enable path: off by default. Enabled only by the existing development flag,
  `?governor=calibrate` (the governor on, plus calibration), which is compiled
  out of the live build by `__OLV_DEV_FLAGS__` like `?governor=on`. There is no
  user-facing governor preference, so none is added.

## Arms

- Fixed: `?governor=on` (v3 governor, static starting level).
- Calibrated: `?governor=calibrate`.

Both arms run the governor, so the comparison isolates the calibrated
starting level.

## Datasets

- A: OLV-DS-090-JEMEZ-SNOWOFF-2010-FOREST (development set).
- B: OLV-DS-093-ROGUE-SISKIYOU-2019-10TDM3449 (held out).

No other dataset is used. Autzen is not used.

## Runs

As the governor v3 protocol: 7 alternating fixed/calibrated pairs per
dataset, each session one headed Chromium `@bench` run of
`tests/e2e/navJank.spec.ts` with one cold and one warm run per trajectory
(orbit, flythrough, zoomShock, scrub, stopInspect); the warm run is the
sample. Medians per arm. Reference machine: the maintainer's Apple M3 Max
MacBook Pro, headed Chrome for Testing, same fingerprint in both arms except
the calibration flag.

## Success criteria

PASS needs every clause on every trajectory on both datasets.

1. p95 frame time (active window), calibrated median at most 1.05 times the
   fixed median (not worse, with a 5% noise allowance). A paired bootstrap 95%
   CI of the ratio is reported; the verdict uses the medians.
2. Frames over 50 ms (active window), calibrated median not higher than fixed.
3. Time to first render (warm load, the viewer's own "time to first render"),
   calibrated median at most fixed median + 100 ms.
4. Quality transitions, calibrated median at most the fixed median + 2 (the
   governor v3 limit).
5. Last camera input to stationary full quality, calibrated median at most
   fixed median + 500 ms (the governor v3 limit); a run that never reaches it
   counts as infinite.
6. After settling, render scale and point fraction back at 1 with no mesh
   reduced in every calibrated run, and the backing ratio equal to the fixed
   runs'.
7. Scientific result digests identical: `tests/presentationInvariance.test.ts`
   passes with the calibrated level active, and every pair passes the
   environment match rule.

Bootstrap: 2000 resamples, seed 20260925, as v3.

## Record

`validation/performance/render-budget-calibration/<date>-<sha>-<machine>-v1-<A|B>.json`,
never overwritten, holding the raw sessions, per-clause values and the
verdict, including FAIL.
