# v0.5.5 baseline — scenarios, metric schema, and honesty rules

**Program:** `docs/_audit/v0.5.5-program.md` §5 P0.
**Purpose:** a reproducible BEFORE picture of navigation/streaming behavior at
v0.5.4, captured before any v0.5.5 behavior change lands. Every performance
claim in the v0.5.5 release notes must trace back to a before/after pair
rooted here.

## Honesty rules (read first)

- **No fabricated numbers.** This directory contains no wall-clock
  performance figures yet. Frame times, time-to-first-points, upload stalls,
  and every other wall-clock metric MUST be measured on the maintainer's
  reference devices (desktop + mobile-class, per §8 of the program). Numbers
  measured in a CI container, a VM, or an agent sandbox are **not
  representative and are never recorded as baseline claims.**
- What IS committed now is the **deterministic scheduler-decision baseline**
  (`tests/fixtures/v055/schedulerBaseline.json`): scheduler *decisions*
  (selection, eviction, budget factors) in mocked time over a fixed-seed
  synthetic octree. It contains no wall-clock measurements by construction.
- Raw machine output from maintainer runs stays under an **ignored local
  path** (e.g. `benchmarks/local/`, untracked); only summarized,
  non-machine-specific results are committed here.

## Scenario matrix (the 14 program §P0 scenarios)

| # | Scenario | Status at P0 |
|---|----------|--------------|
| 1 | Remote COPC, low latency | Maintainer machine (manual; real network) |
| 2 | Remote COPC, simulated latency/bandwidth caps | Maintainer machine (manual; DevTools throttling) |
| 3 | Remote EPT | Maintainer machine (manual) |
| 4 | Local COPC | Maintainer machine (manual) |
| 5 | Large local LAZ | Maintainer machine (manual) |
| 6 | Repeated orbit around a fixed pivot | **Automated (scheduler-level)** — `tests/streamingBaselineV055.test.ts`, phase `orbit` |
| 7 | Repeated wheel-notch zoom | **Automated (scheduler-level)** — phase `wheel-zoom` (camera-path dolly profile; real wheel *events* need a browser and stay manual until P2 lands its unit-tested controller) |
| 8 | Trackpad-style wheel stream | Maintainer machine (manual; needs real trackpad event streams) |
| 9 | Hand-tool drag across the viewport | Deferred until P1 exists (tool ships in v0.5.5); then automated pointer tests + manual device matrix |
| 10 | Rapid rotate–stop–refine | **Automated (scheduler-level)** — phases `rotate-fast` + `settle` |
| 11 | Saved-view / frame-cloud tween | Maintainer machine (manual until P3 destination hints land) |
| 12 | Memory pressure | **Partially automated** — the pressure/hysteresis state machines are pinned by `tests/streamingScheduler.test.ts` and engage inside the baseline trace; whole-app memory behavior stays manual |
| 13 | Tab background/foreground | Maintainer machine (manual) |
| 14 | Resize + DPR change | Maintainer machine (manual; becomes partially automatable with P5's DPR controller) |

"Automated (scheduler-level)" means: deterministic in vitest, mocked clock,
synthetic octree, instant decoder — it pins scheduler *decisions*, not
device performance. The two runs-identical determinism assertion and the
committed-fixture pin both run in the `slow` test bucket on every gate.

## Metric schema

### Live session export — `openlidarviewer.debug-metrics/1`

Produced by the `?debug=1` overlay's **Copy metrics JSON** action
(`src/perf/metricsJson.ts`). Top-level keys:

- `schema`, `appVersion`, `generatedAt`, `backend` (`webgpu` | `webgl2` | null)
- `flags` — the parsed dev flags (`src/perf/devFlags.ts`):
  `streamingScore`/`wheelDolly` (`default`|`legacy`), `handPan`,
  `refinementPhase`, `adaptiveDpr`, `uploadQueue`, `angularPrediction` (bool)
- `frameTiming` (null until sampling) — `sampledForMs`, `frames`,
  `windowCount`, `p50Ms`/`p95Ms`/`p99Ms`/`maxMs` (rolling window,
  nearest-rank percentiles), `over16_7Ms`/`over33_3Ms` (cumulative counts),
  `longestTaskMs`/`longTaskCount` (PerformanceObserver `longtask`; **null
  where unsupported — never 0**), `effectiveDpr`
- `rendering` (null before the first frame) — `fps`, `frameMs`, `drawCalls`,
  `displayedPoints`, `totalPoints`, `gpuBytesEstimate`
- `streaming` (null when no streaming scan is open) — resident/known/visible
  node counts, queue depths, displayed/source points, compressed-cache
  bytes + hit/miss/eviction counts, decoded/GPU byte estimates, scheduler
  tick times (`schedulerMs`, `schedulerRecent` p50/p95/max), upload/evict
  event counts, thrash events. Optional counters the scheduler does not
  currently expose serialize as null.

Metrics named in the program but NOT yet in the schema (wheel-event rate,
input-to-frame delay, time-to-coarse-coverage stages, fetched/canceled/stale
byte accounting, GPU upload ms/frame, selection vs residency budgets,
scheduler phase, EDL motion state) arrive with the controllers that produce
them (P2–P7). They are absent, not zero — the schema version will bump as
fields land.

### Scheduler-decision baseline — `openlidarviewer.v055-scheduler-baseline/1`

`tests/fixtures/v055/schedulerBaseline.json`, regenerated only via
`UPDATE_V055_BASELINE=1 npx vitest run tests/streamingBaselineV055.test.ts`
as a deliberate, reviewed change. Contains:

- `seed`, `budgets`, `baseDepthCap`, `nodeCount`, `sourcePoints`
- `trace[]` — per scheduler tick: `phase`, `tick`, `tMs` (mocked clock),
  `visible`, `queuedAfterDrain`, `residentNodes`, `residentPoints`,
  `maxResidentDepth`, `depthCap`, `cameraVelocity`, `isStable`,
  `effectiveMaxConcurrent`, `fpsBudgetFactor`, `pressureDepthReduction`,
  `decodesCumulative`, `evictionsCumulative`, `fullRescoreCount`
- `referenceCameras` — the sorted resident-node id set at each phase's
  final camera. **This is the v0.5.4 selected-node pin P4 must compare its
  pixel-space scoring against** (ship behind `?streamingScore=legacy`).

Known limitation, stated honestly: at this fixture's octree depth (≤ 3) the
velocity depth caps (−3/−6 levels off a base cap of 18) never restrict
selection — the trace pins their *arithmetic* (`depthCap` column), not a
selection change. The P4 regression work must add a deeper reference dataset
on the maintainer machine for that dimension.

## Feature flags (development/audit only)

`?streamingScore=legacy` · `?wheelDolly=legacy` · `?handPan=off` ·
`?refinementPhase=off` · `?adaptiveDpr=off` · `?uploadQueue=off` ·
`?angularPrediction=off`

Parsed once per session by `src/perf/devFlags.ts` (lazy chunk — never in the
index). At P0 they are surfaced in the metrics export but consumed by
nothing; each later PR (P1–P7) gates its controller on its flag so every new
behavior is independently disableable for A/B against this baseline.
