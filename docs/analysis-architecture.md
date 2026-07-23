# Analysis Architecture

This document has two jobs, kept deliberately separate:

1. It records the **analysis architecture that exists today** (Part 1) and the
   **contracts actually enforced today** (Part 2).
2. It carries the **design specification for a proposed `PointSampler` seam**
   (Part 3) that has not been built, the **conditions under which it should be
   built** (Part 4), and the **history of a retired prototype** of it (Part 5).

Nothing in Part 3 is shipped code. It is pseudocode and design rules for whoever
builds the seam. Read Parts 1–2 for what the application does now; read Parts
3–5 for where the analysis layer is meant to go.

---

# Part 1 — Current implemented architecture

Analysis code lives under `src/analysis/`. Today that is:

- `src/analysis/ModuleApi.ts` — the module entry surface.
- `src/analysis/modules/healthCheck.ts`, `src/analysis/modules/scanReport.ts` —
  the shipped analysis modules.

There is **no `PointSampler` interface and no sampler seam in the application**.
Analyses read cloud types directly. Terrain, contour, measurement and report
code consume `PointCloud`, the streaming node stores, or already-rasterised
grids, not a mediating sampler.

The problem the proposed seam addresses is nonetheless real and present:

- **Static clouds** (LAS, LAZ, PLY, E57, PCD, PTX, GLB) hold every point in CPU
  memory once loaded; an analysis can iterate them fully and synchronously.
- **Streaming clouds** (COPC, EPT) materialise points on demand. Only some
  hierarchy nodes are resident at any moment, and the resident set changes
  between frames. Anything iterating "the cloud" sees only what is resident.

Today each analysis that touches streaming handles residency at its own call
site, and the coverage disclosure that reaches the user (the scan report,
resident-only captions on exports) is produced where those features are wired,
not through a shared seam. That per-site handling is what the proposed seam in
Part 3 would replace with one structural rule.

# Part 2 — Current enforceable contracts

What is actually enforced against the analysis layer today:

- **Layer-boundary lint** (`scripts/lint-layer-boundaries.mjs`): `src/terrain`,
  `src/validation`, `src/analysis`, `src/science` must not import UI or three.js,
  so a numeric module runs in a worker or a Node test without a renderer.
- **The honesty contract**: an analysis output that was computed from a partial
  (resident-only) stream is disclosed as such where it is surfaced — the scan
  report and the coverage captions on PDF/PNG exports carry it. This is enforced
  by the tests for those specific features, not by a seam-wide contract.

The `PointSampler` contracts in Part 3 (C1–C5) are **not** enforced today. There
is no sampler implementation and no contract-test file for them; treating them as
live gates would be false. They are the specification for a seam if one is built.

# Part 3 — Proposed future `PointSampler` seam (design, not shipped)

> Everything in this part is **proposed design expressed as pseudocode**. The
> types, files, and rules below do not exist in the application. They describe
> the seam a future analysis wave should land onto so that each feature does not
> re-invent streaming iteration.

## Why a single seam would matter

Without a seam that names the static/streaming difference explicitly, every
analysis feature re-discovers the streaming problem and ships its own subtly
different workaround. The v0.3.4 startup regression — eight `viewer.*`
dereferences ran before the lazy chunk had resolved — was a smaller version of
the same failure mode: each call site discovered the timing rule independently
and got it slightly wrong. The proposed seam makes the rule structural.

## The proposed `PointSampler` interface (pseudocode)

The seam would be a single interface every cloud implements. Every analysis
function in `src/analysis/` would consume a `PointSampler` rather than a
cloud-specific type, so the interface mediates static vs streaming everywhere.

```ts
// PROPOSED — no such file exists today.

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

/** The single seam every cloud would expose and every analysis would consume. */
export interface PointSampler {
  /** `'full'` (static) or `'resident-only'` (streaming). */
  readonly coverage: 'full' | 'resident-only';
  /** Points iterable right now. Equals sourcePointCount for `'full'`. */
  readonly availablePointCount: number;
  /** Total point count claimed by the source dataset. */
  readonly sourcePointCount: number;

  forEach(callback: PointCallback): void;
  forEachInBox(aabb: AABB, callback: PointCallback): void;
  forEachInPrism(
    polygon: readonly Vec3[],
    zMin: number,
    zMax: number,
    callback: PointCallback,
  ): void;
}
```

The interface intentionally omits asynchronous iteration. Heavier analyses
(Forest Mode, surface defect heatmap) would instead be wrapped by an
`AnalysisRunner` (§6) that adds cooperative yield points, cancellation, and
worker offload without changing the sampler contract.

## §1 — Streaming analysis constraints

A sampler whose `coverage` is `'resident-only'` is the biggest footgun in the
analysis layer. Three rules would govern what an analysis may claim.

- **1.1 — Resident-only is the default, never the surprise.** Every streaming
  sampler reports `coverage: 'resident-only'`; there is no path to `'full'` from
  a streaming source, even if every node happens to be resident.
- **1.2 — The available set is a snapshot at call time.** `availablePointCount`
  and the three iterators observe the resident set at the moment the call begins
  and present a consistent snapshot for that call's duration.
- **1.3 — Coverage transparency is the caller's responsibility.** The sampler
  exposes coverage; the caller surfaces it. §3 specifies how.

## §2 — Resident-node semantics

- Iteration visits every point in every resident node, in unspecified order.
- A node is "resident" if it is uploaded to a GPU buffer the streaming renderer
  is drawing from. Compressed-chunk-cache nodes are not resident.
- The sampler must not trigger eviction or upload as a side-effect. Analysis is
  a pure read.
- The sampler may skip fading-in/out points; the contract verifies determinism,
  not selection policy.

## §3 — Coverage transparency rules

Every UI surface consuming an analysis output would display a coverage indicator
when `coverage === 'resident-only'`.

| Surface | Required indicator |
|---|---|
| Live canvas overlay | *"Partial coverage — analysing N of M points (resident only)"* |
| Inspector panel result | *"Resident-node coverage: N of M points."* |
| PDF report section | *"Coverage: resident-only · N of M points · result is approximate."* |
| PNG export | The embedded scan-report card carries a coverage line. |
| `.olvsession` round-trip | The schema persists coverage so a reload reproduces it. |

A `'full'` coverage analysis may surface its coverage but need not. The
indicator copy would be uniform across the project, held in a single canonical
strings module (proposed, e.g. `src/analysis/coverageMessages.ts` — not yet
created).

## §4 — Memory limits

Every analysis would run against a budget derived from the renderer's point
budget (`renderer.pointBudget`; ~4,000,000 on desktop, ~1,500,000 on phone, from
`src/render/deviceProfile.ts`) and must not allocate more than that in
intermediate point storage. Reductions are bounded in output; transforms are
input-shaped; spatial bins are cell-bounded; a point-by-point gather must
yield-and-resume above 1,000,000 points via the `AnalysisRunner` (§6). Above
budget, surface a "partial result" indicator rather than a wrong answer.

## §5 — Cancellation model

Every analysis function would accept an `AbortSignal` and poll it at every
cooperative yield point. On fire: throw `AbortError`, discard any partial
result, show a brief *"Analysis cancelled"* toast, and never populate a cache
key derived from the run.

## §6 — Deterministic cache model

Analyses would be deterministic functions of
`(sampler identity, parameters, coverage snapshot)`. The cache key composes
`sourceCloudId`, `analysisName`, `serializedParams`, `coverage`, and — for
resident-only — the sorted resident-node-ID hash (omitted for `'full'`). LRU
bounded at 32 per cloud / 256 total, pruned aggressively on heap pressure. The
cache is transparent to callers.

## §7 — Worker offload

Analyses estimated over 200 ms would run in a Web Worker (static + `cpu-heavy`),
while streaming analyses stay on the main thread (short resident-only iteration
makes the serialisation boundary a net loss). A worker analysis would transfer
its sampler snapshot at call time and return via `postMessage`, with no DOM
access. The worker implementation would live at
`src/analysis/runtime/analysisWorker.ts` when a cpu-heavy analysis lands.

## §8 — Proposed analysis contracts (design, not live gates)

These are DESIGN contracts. There is no sampler implementation and no
contract-test file today; when analyses are built they should honour the
relevant contracts.

- **C1 — Determinism.** Same `(sampler, parameters, coverage snapshot)` →
  bit-identical output. Different `residentNodesHash` may differ (the contract
  verifies the dependency, not equivalence).
- **C2 — Abortable.** Cancelled within the first 50 % of estimated runtime:
  throws `AbortError`, does not populate the cache, leaves no GPU buffer, worker
  handle, or DOM listener dangling.
- **C3 — Non-mutating.** Must not change the cloud's points/attributes, active
  color mode, camera/viewport/post-processing, or the streaming scheduler's
  wanted/resident/pending sets.
- **C4 — Coverage semantics.** For resident set `R`:
  `availablePointCount === sum(node.pointCount for node in R)`; `forEach`
  invokes the callback exactly `availablePointCount` times; `forEachInBox` fires
  only for points strictly inside the AABB (closed lower, open upper) and in a
  resident node; a node loaded mid-iteration is not seen (snapshot semantics).
- **C5 — Budget honesty.** Over-budget output either yields a smaller result
  with `truncated: true`, or throws `BudgetExceededError` before allocating.

# Part 4 — Migration conditions

Build the seam when the first analysis that actually needs it lands — a
cpu-heavy analysis (worker offload, §7) or one that must iterate streaming
clouds with disclosed partial coverage. At that point:

1. Introduce `PointSampler` and concrete `StaticPointSampler` /
   `StreamingPointSampler` implementations alongside the feature, not ahead of it.
2. Move the coverage-disclosure strings into the canonical module (§3).
3. Land the contract tests (C1–C5) as real, non-skipped tests bound to the new
   implementation — so the specification becomes an enforced gate at the moment
   there is something to enforce it against.

Until then, the rules above are design, and Part 2 lists what is genuinely
enforced.

# Part 5 — Retired prototype / history

An earlier revision expressed this design as a shipped `PointSampler.ts`
interface plus eighteen skipped contract tests in
`tests/analysis-seam-contract.test.ts`. Both were removed. The interface named
`StaticPointSampler.ts` and `StreamingPointSampler.ts`, neither of which was ever
written, and the only thing importing the interface was the test file skipping
its own assertions. Five releases later the tests were still skipped and their
prose still said "the next release".

They were removed because a permanent placeholder shaped like a gate is worse
than an honest paragraph: a reader counts it as coverage. The design reasoning
was kept — as this document — separated from any claim of executable reality. Do
not recreate the deleted placeholder files or restore the skipped tests; land
real ones with the seam per Part 4.
