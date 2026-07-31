/**
 * streamingDiagnostics.ts
 *
 * A pure builder for the flat streaming-diagnostics record: one snapshot of
 * everything the streaming path knows about itself, in named fields, with no
 * formatting, no timers, no DOM and no three.js.
 *
 * WHY A RECORD RATHER THAN A READOUT. The `?debug=1` overlay already prints
 * streaming counters, but it prints them — the numbers exist only as laid-out
 * text, so nothing else can assert on them and a second consumer (a metrics
 * export, a stress harness, a bug report attachment) has to re-derive them from
 * the scheduler by hand. Two derivations eventually disagree, and the one a
 * developer is watching while diagnosing is the one a measurement should quote.
 * This module is that single derivation: a value, built once, that a display
 * can render and a test can check.
 *
 * WHAT IS IN IT. 32 named fields, every one traceable to something the
 * streaming path actually tracks: the readiness verdict and churn from
 * `refinementReadiness.ts`; the six wanted-set node counts that verdict was
 * derived from; the hierarchy and view counts from `StreamingNodeStore.counts()`
 * and `StreamingScheduler.stats()`; the point totals and budget; the scheduler's
 * cadence and adaptation state; and the compressed-chunk cache tier in full from
 * `StreamingScheduler.cacheStats()`.
 *
 * THE HONESTY RULE. Five fields name quantities the scheduler does NOT expose
 * today — its generation id and cumulative decode-retry count are private with
 * no accessor, the GPU upload queue is optional and privately held, and no
 * running total of decoded bytes is accumulated anywhere (`decodedChunkBytes`
 * sizes one chunk; nothing sums them). Those fields are emitted as a literal
 * `null` and named in `unavailable`, rather than dropped (which would hide the
 * gap) or estimated (which would invent a number and let a reader mistake it for
 * a measurement). The same rule covers `fractionResident` and `churn` when
 * readiness is `'unknown'`: with an empty wanted set there is no fraction to
 * report, so the fields are null and named.
 *
 * Deliberately NOT here: cumulative fetched/network byte totals. Nothing in the
 * streaming path counts them, so there is no honest way to emit the field at
 * all — not even as a null, which would imply a source that merely failed to
 * report. Adding it means adding the counter first.
 *
 * Pure and deterministic — unit-tested in Node.
 *
 * STATUS: the pure half only. No caller assembles a `SchedulerDiagnosticsExtra`
 * from a live scheduler yet, and the `?debug=1` overlay still prints its own
 * counters. Until this record is what the overlay renders, it is a tested leaf
 * module rather than a shipped diagnostic.
 */

import type {
  RefinementReadiness,
  RefinementReadinessPhase,
  SchedulerReadinessFacts,
} from './refinementReadiness';

/**
 * Everything outside the readiness facts, as the scheduler already reports it.
 * Each field names its source so the wiring is a lookup rather than a judgement
 * call; optional fields are the ones the scheduler cannot supply today.
 */
export interface SchedulerDiagnosticsExtra {
  /** `store.counts().known` — nodes the hierarchy has revealed. */
  readonly knownNodes: number;
  /** `stats().visible` — nodes inside the frustum at the last tick. */
  readonly visibleNodes: number;
  /** `store.residentPointCount` — points uploaded and drawable. */
  readonly residentPoints: number;
  /** `store.decodedPendingPointCount` — decoded, awaiting commit. */
  readonly decodedPendingPoints: number;
  /** `scheduler.pointBudget` — the resident-point budget in force. */
  readonly pointBudget: number;
  /** `stats().lastTickMs` — wall time of the most recent scheduling pass. */
  readonly lastTickMs: number;
  /** `stats().cameraVelocity` — smoothed linear speed, world units/second. */
  readonly cameraVelocity: number;
  /** `stats().isStable` — the hysteretic settle verdict, not a raw threshold. */
  readonly cameraStable: boolean;
  /** `stats().effectiveMaxConcurrent` — decode slots allowed this tick. */
  readonly effectiveMaxConcurrent: number;
  /** `stats().pressureDepthReduction` — levels of depth given up under pressure. */
  readonly pressureDepthReduction: number;
  /** `stats().fpsBudgetFactor` — budget multiplier from FPS-pressure adaptation. */
  readonly fpsBudgetFactor: number;
  /** `stats().fullRescoreCount` — cumulative full octree rescores. */
  readonly fullRescoreCount: number;
  /** `cacheStats().byteSize` — compressed chunks currently held. */
  readonly cacheBytes: number;
  /** `cacheStats().count` — compressed chunks currently held. */
  readonly cacheEntries: number;
  /** `cacheStats().maxBytes` — the cache's ceiling. */
  readonly cacheMaxBytes: number;
  /** `cacheStats().hits` — cumulative. */
  readonly cacheHits: number;
  /** `cacheStats().misses` — cumulative. */
  readonly cacheMisses: number;
  /** `cacheStats().evictions` — cumulative. */
  readonly cacheEvictions: number;

  /**
   * Scheduler generation id. Private (`_generationId`) with no accessor today —
   * omit it and the field reports null rather than a guess.
   */
  readonly generationId?: number;
  /**
   * Cumulative decode retries. The scheduler holds per-node failure counts in a
   * private map (`_decodeFailures`) and totals them nowhere; omit unless a
   * caller can supply a real sum.
   */
  readonly decodeRetryCount?: number;
  /** `GpuUploadQueue.pendingCount` — absent when no upload queue is attached. */
  readonly uploadPendingNodes?: number;
  /** `GpuUploadQueue.pendingBytes` — absent when no upload queue is attached. */
  readonly uploadPendingBytes?: number;
  /**
   * Decoded bytes held by resident nodes. `decodedChunkBytes` sizes a single
   * chunk exactly, but nothing accumulates a total, so this is null unless the
   * caller measured it. A per-point estimate would read like a measurement.
   */
  readonly residentDecodedBytes?: number;
}

/**
 * One flat streaming-diagnostics snapshot. Every value is a number, a string, or
 * a literal `null` meaning "this quantity is not available from the streaming
 * path as it stands" — never a fabricated stand-in.
 */
export interface StreamingDiagnostics {
  // — readiness, derived from scheduler state rather than a clock —
  readonly readinessPhase: RefinementReadinessPhase;
  /** Null when the phase is `'unknown'` (empty wanted set, no denominator). */
  readonly fractionResident: number | null;
  /** Null when the phase is `'unknown'`. */
  readonly churn: number | null;

  // — node states over the wanted set (the readiness denominator) —
  readonly wantedNodes: number;
  readonly residentNodes: number;
  readonly inFlightNodes: number;
  readonly queuedNodes: number;
  readonly decodedPendingNodes: number;
  readonly failedNodes: number;

  // — hierarchy and view —
  readonly knownNodes: number;
  readonly visibleNodes: number;

  // — points and budget —
  readonly residentPoints: number;
  readonly decodedPendingPoints: number;
  readonly pointBudget: number;

  // — scheduler cadence and adaptation —
  readonly lastTickMs: number;
  readonly cameraVelocity: number;
  readonly cameraState: 'stable' | 'moving';
  readonly effectiveMaxConcurrent: number;
  readonly pressureDepthReduction: number;
  readonly fpsBudgetFactor: number;
  readonly fullRescoreCount: number;

  // — compressed-chunk cache tier —
  readonly cacheBytes: number;
  readonly cacheEntries: number;
  readonly cacheMaxBytes: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly cacheEvictions: number;

  // — tracked somewhere, but not reachable through the scheduler today —
  readonly generationId: number | null;
  readonly decodeRetryCount: number | null;
  readonly uploadPendingNodes: number | null;
  readonly uploadPendingBytes: number | null;
  readonly residentDecodedBytes: number | null;

  /**
   * Field names emitted as null in this snapshot, in field order. Empty when
   * every field carried a value. A reader should treat this as the record's own
   * account of what it could not measure.
   */
  readonly unavailable: readonly string[];
}

/** A value field of {@link StreamingDiagnostics} — everything but `unavailable`. */
export type StreamingDiagnosticField = Exclude<keyof StreamingDiagnostics, 'unavailable'>;

/**
 * Every value field, in record order. Exported so a display can iterate the
 * record without hard-coding a second list that could drift from this one; typed
 * against the interface so a rename or a typo is a compile error rather than a
 * field that quietly stops being shown.
 */
export const STREAMING_DIAGNOSTIC_FIELDS: readonly StreamingDiagnosticField[] = [
  'readinessPhase',
  'fractionResident',
  'churn',
  'wantedNodes',
  'residentNodes',
  'inFlightNodes',
  'queuedNodes',
  'decodedPendingNodes',
  'failedNodes',
  'knownNodes',
  'visibleNodes',
  'residentPoints',
  'decodedPendingPoints',
  'pointBudget',
  'lastTickMs',
  'cameraVelocity',
  'cameraState',
  'effectiveMaxConcurrent',
  'pressureDepthReduction',
  'fpsBudgetFactor',
  'fullRescoreCount',
  'cacheBytes',
  'cacheEntries',
  'cacheMaxBytes',
  'cacheHits',
  'cacheMisses',
  'cacheEvictions',
  'generationId',
  'decodeRetryCount',
  'uploadPendingNodes',
  'uploadPendingBytes',
  'residentDecodedBytes',
];

/**
 * Reject a value that cannot be one of these quantities. Every field here is a
 * count, a byte total, a duration, or a multiplier — all non-negative and
 * finite. A NaN reaching a diagnostics record is worse than a crash: it renders
 * as a plausible-looking dash and is read as data.
 */
function requireQuantity(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `buildStreamingDiagnostics: ${name} must be a finite value >= 0 (received ${String(value)})`,
    );
  }
}

/**
 * An optional quantity: absent means genuinely unavailable (recorded as null
 * and named), present means it must still be a real number — a caller that
 * supplies NaN has a bug, and calling that "unavailable" would bury it.
 */
function optionalQuantity(
  value: number | undefined,
  name: string,
  unavailable: string[],
): number | null {
  if (value === undefined) {
    unavailable.push(name);
    return null;
  }
  requireQuantity(value, name);
  return value;
}

/**
 * Build one diagnostics snapshot.
 *
 * `readiness` must be the verdict for `facts` (i.e. from
 * `evaluateRefinementReadiness(facts)`); both are taken rather than recomputed
 * so a caller that already evaluated readiness for the phase machine reports the
 * SAME verdict it acted on, instead of a second one computed a tick later.
 *
 * @throws TypeError if any required quantity — or any supplied optional one —
 * is non-finite or negative, naming the argument.
 */
export function buildStreamingDiagnostics(
  facts: SchedulerReadinessFacts,
  readiness: RefinementReadiness,
  extra: SchedulerDiagnosticsExtra,
): StreamingDiagnostics {
  requireQuantity(facts.wantedCount, 'facts.wantedCount');
  requireQuantity(facts.residentCount, 'facts.residentCount');
  requireQuantity(facts.inFlightCount, 'facts.inFlightCount');
  requireQuantity(facts.queuedCount, 'facts.queuedCount');
  requireQuantity(facts.decodedPendingCount, 'facts.decodedPendingCount');
  requireQuantity(facts.failedCount, 'facts.failedCount');

  requireQuantity(extra.knownNodes, 'extra.knownNodes');
  requireQuantity(extra.visibleNodes, 'extra.visibleNodes');
  requireQuantity(extra.residentPoints, 'extra.residentPoints');
  requireQuantity(extra.decodedPendingPoints, 'extra.decodedPendingPoints');
  requireQuantity(extra.pointBudget, 'extra.pointBudget');
  requireQuantity(extra.lastTickMs, 'extra.lastTickMs');
  requireQuantity(extra.cameraVelocity, 'extra.cameraVelocity');
  requireQuantity(extra.effectiveMaxConcurrent, 'extra.effectiveMaxConcurrent');
  requireQuantity(extra.pressureDepthReduction, 'extra.pressureDepthReduction');
  requireQuantity(extra.fpsBudgetFactor, 'extra.fpsBudgetFactor');
  requireQuantity(extra.fullRescoreCount, 'extra.fullRescoreCount');
  requireQuantity(extra.cacheBytes, 'extra.cacheBytes');
  requireQuantity(extra.cacheEntries, 'extra.cacheEntries');
  requireQuantity(extra.cacheMaxBytes, 'extra.cacheMaxBytes');
  requireQuantity(extra.cacheHits, 'extra.cacheHits');
  requireQuantity(extra.cacheMisses, 'extra.cacheMisses');
  requireQuantity(extra.cacheEvictions, 'extra.cacheEvictions');

  // The `'unknown'` verdict carries no derived terms at all, so there is
  // nothing to copy — the two fields are null and named, like any other
  // quantity this record cannot measure.
  const derived = readiness.phase === 'unknown' ? null : readiness;

  // Named in field order, so the list reads the way the record does.
  const unavailable: string[] = [];
  if (derived === null) unavailable.push('fractionResident', 'churn');

  return {
    readinessPhase: readiness.phase,
    fractionResident: derived === null ? null : derived.fractionResident,
    churn: derived === null ? null : derived.churn,

    wantedNodes: facts.wantedCount,
    residentNodes: facts.residentCount,
    inFlightNodes: facts.inFlightCount,
    queuedNodes: facts.queuedCount,
    decodedPendingNodes: facts.decodedPendingCount,
    failedNodes: facts.failedCount,

    knownNodes: extra.knownNodes,
    visibleNodes: extra.visibleNodes,

    residentPoints: extra.residentPoints,
    decodedPendingPoints: extra.decodedPendingPoints,
    pointBudget: extra.pointBudget,

    lastTickMs: extra.lastTickMs,
    cameraVelocity: extra.cameraVelocity,
    cameraState: extra.cameraStable ? 'stable' : 'moving',
    effectiveMaxConcurrent: extra.effectiveMaxConcurrent,
    pressureDepthReduction: extra.pressureDepthReduction,
    fpsBudgetFactor: extra.fpsBudgetFactor,
    fullRescoreCount: extra.fullRescoreCount,

    cacheBytes: extra.cacheBytes,
    cacheEntries: extra.cacheEntries,
    cacheMaxBytes: extra.cacheMaxBytes,
    cacheHits: extra.cacheHits,
    cacheMisses: extra.cacheMisses,
    cacheEvictions: extra.cacheEvictions,

    generationId: optionalQuantity(extra.generationId, 'generationId', unavailable),
    decodeRetryCount: optionalQuantity(
      extra.decodeRetryCount,
      'decodeRetryCount',
      unavailable,
    ),
    uploadPendingNodes: optionalQuantity(
      extra.uploadPendingNodes,
      'uploadPendingNodes',
      unavailable,
    ),
    uploadPendingBytes: optionalQuantity(
      extra.uploadPendingBytes,
      'uploadPendingBytes',
      unavailable,
    ),
    residentDecodedBytes: optionalQuantity(
      extra.residentDecodedBytes,
      'residentDecodedBytes',
      unavailable,
    ),

    unavailable,
  };
}
