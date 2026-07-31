/**
 * streamingDiagnostics.test.ts
 *
 * Pins the streaming-diagnostics record. Two things break if this is untested.
 *
 * First, completeness: a diagnostics snapshot is only useful if a reader can
 * trust that a missing number means "not measured" rather than "the builder
 * forgot". The field list and the record are checked against each other so
 * neither can drift.
 *
 * Second — and this is the one that costs an investigation — honesty about
 * gaps. Five of these quantities the scheduler cannot supply today, and the
 * whole point of emitting them as a literal `null` alongside an `unavailable`
 * list is that nobody quotes an invented figure in a bug report. A regression
 * that silently substituted an estimate, or dropped the field, would look
 * completely normal on screen.
 */

import { describe, it, expect } from 'vitest';
import {
  buildStreamingDiagnostics,
  STREAMING_DIAGNOSTIC_FIELDS,
  type SchedulerDiagnosticsExtra,
} from '../src/render/streaming/streamingDiagnostics';
import {
  evaluateRefinementReadiness,
  type SchedulerReadinessFacts,
} from '../src/render/streaming/refinementReadiness';

/** A mid-load wanted set: 60 of 100 resident, work still moving. */
const FACTS: SchedulerReadinessFacts = {
  wantedCount: 100,
  residentCount: 60,
  inFlightCount: 4,
  queuedCount: 36,
  decodedPendingCount: 2,
  failedCount: 1,
};

/** Everything the scheduler reports today, with no optional field supplied. */
function extra(overrides: Partial<SchedulerDiagnosticsExtra> = {}): SchedulerDiagnosticsExtra {
  return {
    knownNodes: 28_000,
    visibleNodes: 140,
    residentPoints: 3_200_000,
    decodedPendingPoints: 51_000,
    pointBudget: 5_000_000,
    lastTickMs: 2.5,
    cameraVelocity: 0.75,
    cameraStable: true,
    effectiveMaxConcurrent: 3,
    pressureDepthReduction: 1,
    fpsBudgetFactor: 0.85,
    fullRescoreCount: 12,
    cacheBytes: 8_388_608,
    cacheEntries: 64,
    cacheMaxBytes: 16_777_216,
    cacheHits: 900,
    cacheMisses: 100,
    cacheEvictions: 7,
    ...overrides,
  };
}

/** The five quantities the streaming path cannot supply through the scheduler. */
const OPTIONAL_FIELDS = [
  'generationId',
  'decodeRetryCount',
  'uploadPendingNodes',
  'uploadPendingBytes',
  'residentDecodedBytes',
] as const;

function build(
  facts: SchedulerReadinessFacts = FACTS,
  overrides: Partial<SchedulerDiagnosticsExtra> = {},
) {
  return buildStreamingDiagnostics(
    facts,
    evaluateRefinementReadiness(facts),
    extra(overrides),
  );
}

describe('field completeness', () => {
  it('emits every declared field, and nothing beyond them plus `unavailable`', () => {
    const d = build();
    expect(Object.keys(d).sort()).toEqual(
      [...STREAMING_DIAGNOSTIC_FIELDS, 'unavailable'].sort(),
    );
  });

  it('declares 32 value fields — at or above the ~24 the diagnostics contract names', () => {
    expect(STREAMING_DIAGNOSTIC_FIELDS).toHaveLength(32);
    expect(STREAMING_DIAGNOSTIC_FIELDS.length).toBeGreaterThanOrEqual(24);
  });

  it('lists no field twice', () => {
    expect(new Set(STREAMING_DIAGNOSTIC_FIELDS).size).toBe(STREAMING_DIAGNOSTIC_FIELDS.length);
  });

  it('never emits `undefined` — a missing quantity is an explicit null', () => {
    const d = build();
    const record = d as unknown as Record<string, unknown>;
    for (const field of STREAMING_DIAGNOSTIC_FIELDS) {
      const value = record[field];
      expect(value === null || typeof value === 'number' || typeof value === 'string').toBe(true);
    }
  });
});

describe('values pass through from the scheduler unaltered', () => {
  it('copies the wanted-set node counts the readiness verdict was derived from', () => {
    const d = build();
    expect(d.wantedNodes).toBe(100);
    expect(d.residentNodes).toBe(60);
    expect(d.inFlightNodes).toBe(4);
    expect(d.queuedNodes).toBe(36);
    expect(d.decodedPendingNodes).toBe(2);
    expect(d.failedNodes).toBe(1);
  });

  it('copies the hierarchy, point, budget, cadence and cache figures', () => {
    const d = build();
    expect(d.knownNodes).toBe(28_000);
    expect(d.visibleNodes).toBe(140);
    expect(d.residentPoints).toBe(3_200_000);
    expect(d.decodedPendingPoints).toBe(51_000);
    expect(d.pointBudget).toBe(5_000_000);
    expect(d.lastTickMs).toBe(2.5);
    expect(d.cameraVelocity).toBe(0.75);
    expect(d.effectiveMaxConcurrent).toBe(3);
    expect(d.pressureDepthReduction).toBe(1);
    expect(d.fpsBudgetFactor).toBe(0.85);
    expect(d.fullRescoreCount).toBe(12);
    expect(d.cacheBytes).toBe(8_388_608);
    expect(d.cacheEntries).toBe(64);
    expect(d.cacheMaxBytes).toBe(16_777_216);
    expect(d.cacheHits).toBe(900);
    expect(d.cacheMisses).toBe(100);
    expect(d.cacheEvictions).toBe(7);
  });

  it('reports the scheduler\'s hysteretic stability verdict as a named state', () => {
    expect(build(FACTS, { cameraStable: true }).cameraState).toBe('stable');
    expect(build(FACTS, { cameraStable: false }).cameraState).toBe('moving');
  });

  it('carries the readiness phase, fraction and churn it was handed', () => {
    const d = build();
    expect(d.readinessPhase).toBe('loading');
    expect(d.fractionResident).toBeCloseTo(0.6, 12);
    expect(d.churn).toBeCloseTo(0.4, 12);
  });

  it('reports a settled set as settled', () => {
    const settled: SchedulerReadinessFacts = {
      wantedCount: 40,
      residentCount: 40,
      inFlightCount: 0,
      queuedCount: 0,
      decodedPendingCount: 0,
      failedCount: 0,
    };
    const d = build(settled);
    expect(d.readinessPhase).toBe('settled');
    expect(d.fractionResident).toBe(1);
    expect(d.churn).toBe(0);
  });
});

describe('the unavailable-field honesty path', () => {
  it('names every quantity the scheduler cannot supply, and nulls it', () => {
    const d = build();
    expect(d.generationId).toBeNull();
    expect(d.decodeRetryCount).toBeNull();
    expect(d.uploadPendingNodes).toBeNull();
    expect(d.uploadPendingBytes).toBeNull();
    expect(d.residentDecodedBytes).toBeNull();
    expect(d.unavailable).toEqual([...OPTIONAL_FIELDS]);
  });

  it('reports nothing unavailable once a caller supplies all five', () => {
    const d = build(FACTS, {
      generationId: 3,
      decodeRetryCount: 11,
      uploadPendingNodes: 2,
      uploadPendingBytes: 4096,
      residentDecodedBytes: 12_345_678,
    });
    expect(d.generationId).toBe(3);
    expect(d.decodeRetryCount).toBe(11);
    expect(d.uploadPendingNodes).toBe(2);
    expect(d.uploadPendingBytes).toBe(4096);
    expect(d.residentDecodedBytes).toBe(12_345_678);
    expect(d.unavailable).toEqual([]);
  });

  it('names only the fields actually missing when some are supplied', () => {
    // The real mixed case: an upload queue is attached, so its two counters are
    // real, while generation and retry totals remain unreachable.
    const d = build(FACTS, { uploadPendingNodes: 1, uploadPendingBytes: 2048 });
    expect(d.unavailable).toEqual(['generationId', 'decodeRetryCount', 'residentDecodedBytes']);
  });

  it('accepts a genuine zero rather than treating it as absent', () => {
    // 0 retries is a measurement, not a gap — the difference matters when the
    // question is "did anything fail?".
    const d = build(FACTS, { decodeRetryCount: 0, generationId: 0 });
    expect(d.decodeRetryCount).toBe(0);
    expect(d.generationId).toBe(0);
    expect(d.unavailable).not.toContain('decodeRetryCount');
    expect(d.unavailable).not.toContain('generationId');
  });

  it('nulls and names the derived readiness terms when nothing is wanted', () => {
    // An empty wanted set yields the 'unknown' verdict, which carries no
    // fraction and no churn — so neither is invented here either.
    const empty: SchedulerReadinessFacts = {
      wantedCount: 0,
      residentCount: 0,
      inFlightCount: 0,
      queuedCount: 0,
      decodedPendingCount: 0,
      failedCount: 0,
    };
    const d = build(empty);
    expect(d.readinessPhase).toBe('unknown');
    expect(d.fractionResident).toBeNull();
    expect(d.churn).toBeNull();
    expect(d.unavailable).toEqual(['fractionResident', 'churn', ...OPTIONAL_FIELDS]);
  });
});

describe('poison values throw, naming the argument', () => {
  it('rejects a non-finite required scheduler figure', () => {
    expect(() => build(FACTS, { cacheBytes: Number.NaN })).toThrow(TypeError);
    expect(() => build(FACTS, { cacheBytes: Number.NaN })).toThrow(/extra\.cacheBytes/);
  });

  it('rejects a negative required scheduler figure', () => {
    expect(() => build(FACTS, { lastTickMs: -1 })).toThrow(/extra\.lastTickMs/);
    expect(() => build(FACTS, { visibleNodes: -1 })).toThrow(/extra\.visibleNodes/);
  });

  it('rejects a poisoned readiness fact, naming it as a fact', () => {
    const bad: SchedulerReadinessFacts = { ...FACTS, wantedCount: Number.NaN };
    // The readiness evaluator rejects it first; call the builder directly with a
    // valid verdict to prove the builder validates the facts on its own too.
    expect(() =>
      buildStreamingDiagnostics(bad, { phase: 'unknown' }, extra()),
    ).toThrow(/facts\.wantedCount/);
  });

  it('rejects a SUPPLIED optional that is not a real number', () => {
    // Absent means unavailable; NaN means the caller's counter is broken, and
    // filing that under "unavailable" would bury the bug.
    expect(() => build(FACTS, { generationId: Number.NaN })).toThrow(/generationId/);
    expect(() => build(FACTS, { uploadPendingBytes: -1 })).toThrow(/uploadPendingBytes/);
  });
});

describe('the record is a pure value', () => {
  it('builds an identical record from identical inputs', () => {
    expect(build()).toEqual(build());
  });

  it('does not mutate the inputs it was given', () => {
    const facts = { ...FACTS };
    const e = extra();
    const before = { facts: { ...facts }, extra: { ...e } };
    buildStreamingDiagnostics(facts, evaluateRefinementReadiness(facts), e);
    expect(facts).toEqual(before.facts);
    expect(e).toEqual(before.extra);
  });

  it('gives each call its own `unavailable` array', () => {
    const first = build();
    const second = build();
    expect(first.unavailable).not.toBe(second.unavailable);
    expect(first.unavailable).toEqual(second.unavailable);
  });
});
