# Analysis Architecture

This document is the architectural contract for every future analysis feature in OpenLiDARViewer. It describes how an analysis reads points across both static and streaming clouds, what it can and cannot promise about coverage, how it interacts with memory and cancellation, and what tests the runtime guarantees.

The contract was written ahead of the implementation so that the first analysis features (cross-section profile chart, edge-bleed detector, noise broom, surface-defect heatmap, forest mode, cloud-sampled scan-quality rows) land cleanly onto a shared seam, instead of each one shipping its own ad-hoc cloud iteration.

This document is also the source the contract tests in `tests/analysis-seam-contract.test.ts` are derived from. Those tests are intentionally skipped until v0.3.7 implementations remove the `.skip` markers — they exist as a visible pre-commitment to the rules below.

## Why a single seam matters

OpenLiDARViewer reads point data in two fundamentally different ways:

- **Static clouds** (LAS, LAZ, PLY, E57, PCD, PTX, GLB) carry every point in CPU memory after the load completes. An analysis can iterate every point synchronously.
- **Streaming clouds** (COPC, EPT) materialise points on demand. At any moment, only some hierarchy nodes are resident in GPU memory; the rest live as compressed chunks in the network cache (or have not been fetched at all). An analysis that iterates "the cloud" can only see what is resident — and that resident set changes between frames.

Without a seam that names this difference explicitly, every analysis feature would re-discover the streaming problem and ship its own subtly different workaround. The v0.3.4 startup regression — eight `viewer.*` dereferences ran before the lazy chunk had resolved — was a smaller version of the same failure mode: each call site discovered the timing rule independently and got it slightly wrong. The seam below makes the rule structural.

## The `PointSampler` interface

The seam is a single interface every cloud implements. Every analysis function in `src/analysis/` consumes a `PointSampler`. No analysis function takes a `PointCloud`, a `StreamingPointCloud`, or any cloud-specific type. The interface mediates everything.

```ts
/** A coordinate triple in render space. */
export interface Vec3 { x: number; y: number; z: number; }

/** Axis-aligned bounding box: [minX, minY, minZ, maxX, maxY, maxZ]. */
export type AABB = readonly [number, number, number, number, number, number];

/** Per-point attribute payload — every analysis chooses what it needs. */
export interface PointAttributes {
  readonly rgb?: readonly [number, number, number];
  readonly intensity?: number;
  readonly classification?: number;
  readonly returnNumber?: number;
  readonly numberOfReturns?: number;
  readonly gpsTime?: number;
}

/** The callback shape every iteration accepts. */
export type PointCallback = (
  x: number,
  y: number,
  z: number,
  attributes: PointAttributes,
) => void;

/**
 * The single seam every cloud exposes and every analysis consumes.
 *
 * Read-only by contract. The sampler MUST NOT expose write paths and the
 * analysis MUST NOT mutate any state outside its own return value. See the
 * "Contracts" section below.
 */
export interface PointSampler {
  /**
   * Whether this sampler can iterate the entire dataset (`'full'`) or only
   * the subset currently resident in memory (`'resident-only'`).
   *
   * Static clouds always report `'full'`. Streaming clouds always report
   * `'resident-only'`. The UI MUST surface this distinction whenever an
   * analysis output is exported, shared, or screenshotted; see §3
   * "Coverage transparency rules".
   */
  readonly coverage: 'full' | 'resident-only';

  /**
   * Number of points the sampler can actually iterate right now. For
   * `'full'` coverage this equals `sourcePointCount`. For `'resident-only'`
   * coverage this is the count of points in resident nodes — typically
   * much smaller than the source dataset.
   */
  readonly availablePointCount: number;

  /**
   * Total point count claimed by the source dataset. For COPC / EPT this
   * is the manifest-declared count; for static clouds this equals
   * `availablePointCount`.
   */
  readonly sourcePointCount: number;

  /** Iterate every available point in unspecified order. */
  forEach(callback: PointCallback): void;

  /** Iterate every available point inside the AABB in unspecified order. */
  forEachInBox(aabb: AABB, callback: PointCallback): void;

  /**
   * Iterate every available point inside the prism formed by extruding the
   * 2D polygon `polygon` vertically between `zMin` and `zMax`. The polygon
   * MUST be closed (last vertex implicitly connects to first) and SHOULD
   * be simple (non-self-intersecting); behaviour on self-intersecting
   * polygons is implementation-defined but MUST NOT throw.
   */
  forEachInPrism(
    polygon: readonly Vec3[],
    zMin: number,
    zMax: number,
    callback: PointCallback,
  ): void;
}
```

The interface intentionally omits asynchronous iteration. Heavier analyses (Forest Mode, surface defect heatmap) will instead be wrapped at a higher level by an `AnalysisRunner` — see §6 below — which gives them cooperative yield points, cancellation, and worker offload without changing the sampler contract.

## §1 — Streaming analysis constraints

A `PointSampler` whose `coverage` is `'resident-only'` is the single biggest source of footguns in the whole analysis layer. Three rules govern what an analysis is allowed to claim about its output.

### Rule 1.1 — Resident-only is the default, never the surprise

Every streaming sampler MUST report `coverage: 'resident-only'`. There is no path by which a streaming sampler returns `coverage: 'full'`, even if every node happens to be resident at a given moment. The streaming pipeline can evict at any time; an analysis must never assume "I saw everything" from a streaming source.

### Rule 1.2 — The available set is a snapshot at call time

`availablePointCount`, `forEach`, `forEachInBox`, and `forEachInPrism` all observe the set of resident nodes at the moment the call begins. The streaming scheduler may load and evict during a long iteration; the sampler MUST present a consistent snapshot for the duration of a single call, even if that means buffering node references at call start.

### Rule 1.3 — Coverage transparency is the caller's responsibility

The sampler exposes coverage; it does not enforce its own surfacing. The caller (every analysis function, and ultimately every UI) is responsible for surfacing the coverage to the user. §3 specifies how.

## §2 — Resident-node semantics

When a sampler iterates a `'resident-only'` cloud:

- The iteration visits every point in every resident node, in unspecified per-node order.
- A node is "resident" if it is currently uploaded to a GPU buffer that the streaming renderer is drawing from. Nodes in the compressed-chunk cache but not currently uploaded are NOT resident.
- The sampler MUST NOT trigger eviction or upload of new nodes as a side-effect of iteration. Analysis is a pure read.
- The sampler MAY skip points marked as fading-out or fading-in by the streaming renderer's animation curves; those points are visually present but transitionally unstable. The implementation chooses; the test contract verifies determinism, not selection policy.

## §3 — Coverage transparency rules

Every UI surface that consumes an analysis output MUST display a coverage indicator when `coverage === 'resident-only'`.

| Surface | Required indicator |
|---|---|
| **Live overlay on the canvas** | A small text annotation in the overlay corner: *"Partial coverage — analysing N of M points (resident only)"* with `N = availablePointCount`, `M = sourcePointCount`. |
| **Inspector panel result** | A footer line on the result block: *"Resident-node coverage: N of M points."* |
| **PDF report section** | A row in the section's metadata block: *"Coverage: resident-only · N of M points · result is approximate."* |
| **PNG export** | The scan-report card embedded at export time MUST carry a coverage line when the source analysis was resident-only. |
| **`.olvsession` round-trip** | The session schema carries the coverage state for every persisted analysis result so a reload reproduces the warning. |

A `'full'` coverage analysis MAY surface its coverage but is not required to.

The indicator copy is uniform across the project — see `src/analysis/coverageMessages.ts` (added in v0.3.7 with the first analysis implementation) for the canonical strings.

## §4 — Memory limits

Every analysis runs against a memory budget derived from the renderer's point budget:

```
analysisBudget = renderer.pointBudget       // ~4 000 000 points on typical desktop
                                             // ~1 500 000 on phone, derived from
                                             // src/render/deviceProfile.ts
```

The analysis MUST NOT allocate more than `analysisBudget` worth of intermediate point storage. Concretely:

- A reduction (count, sum, mean, histogram) is unbounded in input size, bounded in output — always within budget.
- A transform (per-point reliability score, per-point classification) is the same shape as the input — within budget iff input ≤ budget.
- A spatial bin (density grid, NPS heatmap) is bounded by the grid cell count, not the input — within budget for plausible grid sizes (≤ 4 000 × 4 000 cells).
- A point-by-point gather (extract all points in a polygon prism) MUST yield-and-resume above 1 000 000 points. The `AnalysisRunner` enforces this; see §6.

Above the budget, the analysis MUST surface a "partial result" indicator instead of producing a wrong answer or running out of memory.

## §5 — Cancellation model

Every analysis function accepts an `AbortSignal`. Every long analysis (over 100 ms estimated wall time) MUST poll the signal at every cooperative yield point.

```ts
async function runDensityHeatmap(
  sampler: PointSampler,
  options: { cellSizeMetres: number },
  signal?: AbortSignal,
): Promise<DensityHeatmap> {
  signal?.throwIfAborted();
  // ... initial setup
  for (const batch of batches(sampler, BATCH_SIZE)) {
    signal?.throwIfAborted();
    // ... batch reduction
    await yieldToBrowser();
  }
  return result;
}
```

When the signal fires:

- The analysis throws an `AbortError` (DOMException with name `'AbortError'`).
- Any partial result is discarded — the analysis never returns half-finished output.
- The UI shows a brief *"Analysis cancelled"* toast through the existing `dropZone.setError` channel (with a non-error category) and removes any in-progress overlay.
- Any cache key derived from the analysis parameters is NOT populated; a future identical request triggers a fresh run.

## §6 — Deterministic cache model

Analyses are deterministic functions of `(sampler identity, parameters, coverage snapshot)`. The runtime MAY cache results and return the cached output on a repeat call with the same key.

### Cache key composition

```
cacheKey = sha256(
  sourceCloudId,        // stable per loaded cloud
  analysisName,         // 'density', 'edge-bleed', 'profile-slab', etc.
  serializedParams,     // JSON.stringify of the analysis options
  coverage,             // 'full' | 'resident-only'
  residentNodesHash,    // omitted when coverage === 'full'
)
```

For `'full'` coverage, the cache key omits `residentNodesHash` because the result is invariant to the streaming state.

For `'resident-only'` coverage, the cache key includes the sorted set of resident node IDs at call time. Different resident sets produce different keys; a streaming cloud whose resident set changed between two analysis calls correctly cache-misses.

### Cache eviction

The cache is LRU-bounded at 32 entries per source cloud, total 256 across the runtime. Eviction is opportunistic; on memory pressure (`PerformanceObserver` heap > 80 % of limit) the cache is aggressively pruned.

### Cache is transparent

Callers never see the cache directly. They call `runAnalysis(name, sampler, params, signal)`; the runner consults the cache before doing the work. A cache hit returns synchronously (within a microtask); a miss runs the analysis.

## §7 — Worker offload

Analyses with estimated wall time > 200 ms MUST run in a Web Worker. The `AnalysisRunner` decides:

- Static cloud + analysis declared `cpu-heavy: true` → worker.
- Streaming cloud → main thread (worker boundary serialisation overhead exceeds the per-call benefit because resident-only iteration is naturally short).
- Anything else → main thread.

Worker analyses transfer their `PointSampler` snapshot at call time (the resident point buffer for streaming, the full buffer for static). Results return via `postMessage`. No DOM access from worker code.

The worker implementation lives in `src/analysis/runtime/analysisWorker.ts` and is added in v0.3.7 with the first cpu-heavy analysis.

## §8 — Analysis contracts (testable, machine-checkable)

The following contracts are encoded as skipped test cases in `tests/analysis-seam-contract.test.ts`. They become the gate for every v0.3.7 analysis implementation: until an analysis can un-skip the relevant tests by passing them, it does not ship.

### Contract C1 — Determinism

For the same `(sampler, parameters, coverage snapshot)`, the analysis returns bit-identical output across runs. Concretely:

- Static clouds: two consecutive runs against the same loaded cloud, same parameters, produce identical output bytes.
- Streaming clouds: two consecutive runs against the same `residentNodesHash`, same parameters, produce identical output bytes. Different `residentNodesHash` may produce different output (the test verifies the dependency, not the equivalence).

### Contract C2 — Abortable

An analysis cancelled via `AbortSignal` within the first 50 % of its estimated runtime:

- Throws an `AbortError`.
- Does not populate the cache.
- Does not leave any GPU buffer, worker handle, or DOM listener dangling.

### Contract C3 — Non-mutating

An analysis run against a sampler MUST NOT change:

- The cloud's point count, point coordinates, or attribute values.
- The cloud's currently-active color mode.
- The renderer's camera, viewport, or post-processing state.
- The streaming scheduler's wanted set, resident set, or pending queue.

The test exercises each of these invariants by snapshotting the relevant state before and after the analysis run and comparing.

### Contract C4 — Coverage semantics

For a streaming sampler with resident set `R`:

- `availablePointCount === sum(node.pointCount for node in R)`.
- `forEach(cb)` invokes `cb` exactly `availablePointCount` times.
- `forEachInBox(aabb, cb)` invokes `cb` only for points strictly inside `aabb` (closed lower bound, open upper bound) AND in a resident node.
- A node loaded during iteration is NOT seen by that iteration (snapshot semantics from §1.2).

### Contract C5 — Budget honesty

Analyses with estimated output size > `analysisBudget` MUST either:

- Yield a smaller output (downsampled, binned, summary) AND report `truncated: true` in the result metadata.
- OR throw a `BudgetExceededError` (a custom Error subclass) BEFORE allocating the output.

The test fakes an over-budget input and verifies one of these two paths.

## §9 — Sampler implementations to be added in v0.3.7

The v0.3.6 release ships the interface, the documentation, and the skipped contract tests. It does NOT ship sampler implementations or analysis functions — that work belongs to v0.3.7. The implementations queued are:

```
src/analysis/
├── PointSampler.ts               ← interface + base types (this file, v0.3.6)
├── StaticPointSampler.ts         ← wraps a static PointCloud (v0.3.7)
├── StreamingPointSampler.ts      ← wraps a StreamingPointCloud + EptStreamingPointCloud (v0.3.7)
├── runtime/
│   ├── AnalysisRunner.ts         ← cache, cancellation, worker dispatch (v0.3.7)
│   ├── analysisWorker.ts         ← cpu-heavy worker (v0.3.7)
│   └── coverageMessages.ts       ← canonical UI strings for coverage (v0.3.7)
├── density.ts                    ← density grid + NPS heatmap (v0.3.7 / v0.4.0)
├── profile.ts                    ← cross-section slab (v0.3.7)
├── edgeBleed.ts                  ← phone-LiDAR silhouette overlay (v0.3.7)
├── outliers/
│   ├── isolated.ts               ← Nazeri k-NN cluster filter (v0.3.7)
│   └── clusterIDW.ts             ← Matkan iterative IDW filter (v0.3.7)
└── forest/                       ← Fareed metric catalogue (v0.4.0)
    ├── chm.ts
    ├── fhd.ts
    ├── cgf.ts
    └── lad.ts
```

Adding any of these earlier than v0.3.7 means shipping unverified analysis code against a still-unwritten test contract. The strategic rule for v0.3.6 is explicit: *the analysis seam is more important than prematurely adding advanced analysis features.* This document, the interface, and the contract tests are the seam. Everything else waits.

## §10 — Non-goals (v0.3.6)

The following are explicitly NOT in v0.3.6:

- Sampler implementations (above).
- Any analysis function (above).
- Any UI consumer of an analysis (forest mode, edge bleed overlay, reliability heatmap, cross-section chart, surface defect heatmap, cloud-sampled scan-quality audit rows).
- Multi-scan analysis (M3C2, change detection, CAD/BIM overlay) — these require multi-cloud loading infrastructure not yet present.
- Worker pool management beyond the single-analysis worker described in §7.

These are queued for v0.3.7, v0.4.0, and v0.5.x respectively. The v0.3.6 release ships only the contract.

## §11 — Why this is the v0.3.6 keystone

The LLM Council that deliberated the v0.3.6 scope identified this design document as the single most important item in the release. Three independent reviewers caught the same failure mode in earlier drafts: analyses that pretend to work on streaming clouds but silently return a fraction of the data. The "looks correct, missing half the data" failure is the same class as v0.3.4's `viewer.*` regression — a missing structural rule, not a missing feature.

Writing this document before any analysis ships is the cheapest move that prevents the entire v0.3.7 / v0.4.0 analysis layer from inheriting that failure mode by accident. Every analysis that lands after v0.3.6 can be verified against the contracts in §8; an analysis that cannot un-skip its contract test does not ship.
