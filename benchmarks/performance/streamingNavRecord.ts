/**
 * streamingNavRecord.ts
 *
 * The record a fast-navigation streaming measurement writes, the pure
 * accumulator that builds it, and the rules that keep it honest. Sibling to
 * `frameRecord.ts`, and it inherits that file's two load-bearing rules.
 *
 * A missing measurement is `unavailable` with a reason, never `0` and never a
 * measured distribution with no samples. This harness runs in Node, where the
 * two GPU-bound components — end-to-end frame time and the mesh-creation /
 * upload cost — cannot be observed at all: there is no render loop and no GL
 * context. Reporting `0` for them would assert a perfect result; reporting a
 * fabricated distribution would be worse. So they are `unavailable` with a
 * reason that names the runtime limitation, and `validateNavigationRecord`
 * REFUSES a Node record that claims to have measured either. The device path
 * (Playwright, real GPU) is what fills them in — see `docs/benchmarks.md`.
 *
 * A comparison names its environment. Frame and latency numbers from different
 * runtimes, machines or backends are not comparable, and pooling them produces
 * a figure that describes nothing. The environment travels with the record so a
 * later comparator can refuse an incomparable pair rather than average it.
 *
 * Deliberately no timing and no I/O here. This is the part a reviewer has to
 * trust, so it reads a clock through nothing and touches no seam — the Node
 * driver in `tests/benchmark/streamingNav.test.ts` owns the clock and the
 * scheduler, and feeds this accumulator plain numbers.
 *
 * Pure — no DOM, no three.js, no `node:` builtin, no wall clock, no random.
 */

/** A latency distribution. Percentiles lead, because these times are not normal. */
export interface LatencySummary {
  /** Samples observed. */
  readonly count: number;
  /** Arithmetic mean (0 when there are no samples). */
  readonly mean: number;
  /** Median. */
  readonly p50: number;
  /** 95th percentile — the hitch a user notices. */
  readonly p95: number;
  /** 99th percentile — the worst routinely-seen stall. */
  readonly p99: number;
  /** Largest sample. */
  readonly max: number;
}

/**
 * A latency component: either a measured sample distribution, or unavailable
 * with a reason. There is no third shape, so "measured but empty" and "0 for
 * missing" are both unrepresentable at the type level.
 */
export type LatencyComponent =
  | {
      readonly status: 'measured';
      readonly unit: 'ms';
      readonly runtime: 'node' | 'browser';
      readonly summary: LatencySummary;
      /** Raw samples, retained so a summary can be re-derived or re-binned. */
      readonly samples: readonly number[];
    }
  | { readonly status: 'unavailable'; readonly reason: string };

/** A scalar measurement: measured with a unit, or unavailable with a reason. */
export type ScalarMetric =
  | { readonly status: 'measured'; readonly value: number; readonly unit: string }
  | { readonly status: 'unavailable'; readonly reason: string };

/** Where a run happened. Two records are comparable only when these match. */
export interface StreamingNavEnvironment {
  /** The runtime the measurement was taken in. */
  readonly runtime: 'node' | 'browser';
  readonly os: string;
  readonly architecture: string;
  /** Node version for a Node run, else null. */
  readonly nodeVersion: string | null;
  /** Browser string for a browser run, else null. */
  readonly browser: string | null;
  /** Render backend actually used; `'none'` for a Node scheduler-only run. */
  readonly backend: 'webgpu' | 'webgl2' | 'none';
}

/** The scripted workload a record was produced against. */
export interface StreamingNavWorkload {
  readonly datasetId: string;
  /** Total points in the synthetic source. */
  readonly sourcePoints: number;
  /** Octree nodes in the source hierarchy. */
  readonly nodeCount: number;
  /** Resident point budget the scheduler streamed against. */
  readonly pointBudget: number;
  /** Concurrent-decode budget applied. */
  readonly maxConcurrentDecodes: number;
  /** Camera waypoints in the scripted fast-navigation path. */
  readonly waypoints: number;
  /** Scheduler `update()` ticks driven across the run. */
  readonly ticks: number;
  /** Fixture + camera-script seed, for reproducibility of the workload. */
  readonly seed: number;
}

/**
 * One fast-navigation streaming measurement.
 *
 * The headline (`frameTimeMs`) and `meshCreationMs` are GPU-bound and come back
 * `unavailable` from a Node run; the four scheduler-side quantities are
 * measured directly. `peakDecodedNotResidentBytes` is measured but is expected
 * to be ~0 on the immediate-commit path — see the field doc.
 */
export interface StreamingNavRecord {
  readonly schemaVersion: 1;
  readonly label: string;
  /** Git revision the harness ran against. */
  readonly revision: string;
  /** ISO timestamp — volatile, present for provenance, never hashed. */
  readonly generatedAt: string;
  readonly environment: StreamingNavEnvironment;
  readonly workload: StreamingNavWorkload;

  /**
   * End-to-end frame time p50/p95/p99. `unavailable` in a Node run: there is no
   * render loop or GPU to time a frame. Captured on a real device — see
   * `docs/benchmarks.md`.
   */
  readonly frameTimeMs: LatencyComponent;

  /** Per-node decode wall time (chunk bytes → typed arrays). Measured in Node. */
  readonly nodeDecodeMs: LatencyComponent;
  /**
   * Per-node queue-wait: wall time a node sat visibly in the scheduler queue,
   * across at least one tick boundary, before its decode was dispatched. Nodes
   * dispatched within the tick they were wanted contribute 0. Measured in Node.
   */
  readonly queueWaitMs: LatencyComponent;
  /**
   * Per-node mesh creation + GPU upload. `unavailable` in a Node run: building
   * the `BufferGeometry` and uploading it needs a GL context. Captured on a
   * real device — see `docs/benchmarks.md`.
   */
  readonly meshCreationMs: LatencyComponent;
  /** Session start → first node resident (first paint). Measured in Node. */
  readonly firstRenderMs: ScalarMetric;

  /**
   * Peak bytes that finished decoding but were not yet resident.
   *
   * On the default immediate-commit path `_commitDecoded` marks a node resident
   * and fires `onNodeReady` in the SAME microtask the decode resolves, so this
   * backlog is architecturally ~0 — decode → resident is atomic. A non-zero
   * value here is the signal that a metered-commit / upload-queue path is
   * carrying a decoded backlog, which is exactly what the follow-on hardening
   * work would introduce and then need to bound. Measured in Node.
   */
  readonly peakDecodedNotResidentBytes: ScalarMetric;

  /** Scheduler `update()` wall time per tick — the streaming CPU cost a frame pays. */
  readonly schedulerTickMs: LatencyComponent;
  /**
   * Peak concurrent in-flight decode footprint: summed estimated bytes of nodes
   * dispatched but not yet resident. The transient decode-pipeline memory held
   * outside the resident set. Measured in Node.
   */
  readonly inFlightDecodeBytesPeak: ScalarMetric;

  readonly nodesResident: number;
  readonly nodesEvicted: number;
  readonly thrashEvents: number;
  readonly peakResidentPoints: number;
  /** Whole-session wall time, ms. */
  readonly sessionMs: number;

  /**
   * Caveats that travel with the numbers, so the committed artifact reads
   * honestly on its own — e.g. that Node decode time reflects the harness's
   * representative typed-array assembly, not laz-perf LAZ decompression.
   */
  readonly notes: readonly string[];
}

/** Why a record was refused. */
export type NavRecordProblem =
  | 'missing-revision'
  | 'unavailable-without-reason'
  | 'measured-without-samples'
  | 'negative-sample'
  | 'node-claims-frame-time'
  | 'node-claims-mesh-creation'
  | 'scalar-unavailable-without-reason';

/** A reason string shorter than this reads as a placeholder, not an explanation. */
export const MIN_REASON_LENGTH = 20;

/** Nearest-rank percentile over an ascending copy. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(idx, sorted.length - 1)];
}

/** Summarise a latency sample set. Empty input yields an all-zero summary. */
export function summariseLatency(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) {
    return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  let sum = 0;
  for (const s of sorted) sum += s;
  return {
    count: sorted.length,
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

/** Build a measured latency component from raw samples. */
export function measuredLatency(
  samples: readonly number[],
  runtime: 'node' | 'browser',
): LatencyComponent {
  return {
    status: 'measured',
    unit: 'ms',
    runtime,
    summary: summariseLatency(samples),
    samples: [...samples],
  };
}

/** Build an unavailable latency/scalar reason holder. */
export function unavailable(reason: string): { status: 'unavailable'; reason: string } {
  return { status: 'unavailable', reason };
}

/**
 * Refuse a record that cannot support a comparison, or that fabricates a
 * measurement the runtime could not take. The node-claims-* checks are the
 * honesty teeth: a Node run must declare frame time and mesh creation
 * unavailable, because it has no way to measure either.
 */
export function validateNavigationRecord(rec: StreamingNavRecord): NavRecordProblem[] {
  const problems: NavRecordProblem[] = [];
  if (!rec.revision) problems.push('missing-revision');

  const checkLatency = (c: LatencyComponent): void => {
    if (c.status === 'unavailable') {
      if (c.reason.length < MIN_REASON_LENGTH) problems.push('unavailable-without-reason');
      return;
    }
    if (c.samples.length === 0) problems.push('measured-without-samples');
    if (c.samples.some((s) => s < 0)) problems.push('negative-sample');
  };
  const checkScalar = (m: ScalarMetric): void => {
    if (m.status === 'unavailable' && m.reason.length < MIN_REASON_LENGTH) {
      problems.push('scalar-unavailable-without-reason');
    }
  };

  checkLatency(rec.frameTimeMs);
  checkLatency(rec.nodeDecodeMs);
  checkLatency(rec.queueWaitMs);
  checkLatency(rec.meshCreationMs);
  checkLatency(rec.schedulerTickMs);
  checkScalar(rec.firstRenderMs);
  checkScalar(rec.peakDecodedNotResidentBytes);
  checkScalar(rec.inFlightDecodeBytesPeak);

  if (rec.environment.runtime === 'node') {
    if (rec.frameTimeMs.status === 'measured') problems.push('node-claims-frame-time');
    if (rec.meshCreationMs.status === 'measured') problems.push('node-claims-mesh-creation');
  }
  return problems;
}

/**
 * A thin, pure sample accumulator. The driver owns the clock and the scheduler
 * seams; it pushes plain numbers here and reads peaks back. Deliberately does
 * NOT read a clock — every timestamp arrives pre-differenced as a duration in
 * ms, so this class is trivially deterministic in a unit test.
 */
export class NavigationSamples {
  private readonly _decodeMs: number[] = [];
  private readonly _queueWaitMs: number[] = [];
  private readonly _tickMs: number[] = [];

  private _firstRenderMs: number | undefined;
  private _peakDecodedNotResidentBytes = 0;
  private _peakInFlightDecodeBytes = 0;
  private _peakResidentPoints = 0;
  private _nodesResident = 0;
  private _nodesEvicted = 0;
  private _thrashEvents = 0;

  /** One node decode wall time, ms. */
  pushDecodeMs(ms: number): void {
    this._decodeMs.push(ms);
  }
  /** One node queue-wait, ms. Non-negative by construction; guarded anyway. */
  pushQueueWaitMs(ms: number): void {
    this._queueWaitMs.push(ms < 0 ? 0 : ms);
  }
  /** One scheduler tick wall time, ms. */
  pushTickMs(ms: number): void {
    this._tickMs.push(ms);
  }
  /** Record the first-paint marker once; later calls are ignored. */
  noteFirstRender(ms: number): void {
    if (this._firstRenderMs === undefined) this._firstRenderMs = ms;
  }
  noteResident(): void {
    this._nodesResident += 1;
  }
  noteEvicted(): void {
    this._nodesEvicted += 1;
  }
  noteThrash(): void {
    this._thrashEvents += 1;
  }
  /** Peak decoded-but-not-resident backlog, bytes. */
  observeDecodedNotResidentBytes(bytes: number): void {
    if (bytes > this._peakDecodedNotResidentBytes) this._peakDecodedNotResidentBytes = bytes;
  }
  /** Peak concurrent in-flight decode footprint, bytes. */
  observeInFlightDecodeBytes(bytes: number): void {
    if (bytes > this._peakInFlightDecodeBytes) this._peakInFlightDecodeBytes = bytes;
  }
  observeResidentPoints(points: number): void {
    if (points > this._peakResidentPoints) this._peakResidentPoints = points;
  }

  /** Build the final record. `now` is the driver's session clock in ms. */
  finalize(args: {
    label: string;
    revision: string;
    generatedAt: string;
    environment: StreamingNavEnvironment;
    workload: StreamingNavWorkload;
    sessionMs: number;
    frameTimeMs: LatencyComponent;
    meshCreationMs: LatencyComponent;
    notes: readonly string[];
  }): StreamingNavRecord {
    const runtime = args.environment.runtime;
    const firstRender: ScalarMetric =
      this._firstRenderMs === undefined
        ? unavailable('no node became resident during the run, so first paint was never reached')
        : { status: 'measured', value: this._firstRenderMs, unit: 'ms' };
    return {
      schemaVersion: 1,
      label: args.label,
      revision: args.revision,
      generatedAt: args.generatedAt,
      environment: args.environment,
      workload: args.workload,
      frameTimeMs: args.frameTimeMs,
      nodeDecodeMs: measuredLatency(this._decodeMs, runtime),
      queueWaitMs: measuredLatency(this._queueWaitMs, runtime),
      meshCreationMs: args.meshCreationMs,
      firstRenderMs: firstRender,
      peakDecodedNotResidentBytes: {
        status: 'measured',
        value: this._peakDecodedNotResidentBytes,
        unit: 'bytes',
      },
      schedulerTickMs: measuredLatency(this._tickMs, runtime),
      inFlightDecodeBytesPeak: {
        status: 'measured',
        value: this._peakInFlightDecodeBytes,
        unit: 'bytes',
      },
      nodesResident: this._nodesResident,
      nodesEvicted: this._nodesEvicted,
      thrashEvents: this._thrashEvents,
      peakResidentPoints: this._peakResidentPoints,
      sessionMs: args.sessionMs,
      notes: args.notes,
    };
  }
}
