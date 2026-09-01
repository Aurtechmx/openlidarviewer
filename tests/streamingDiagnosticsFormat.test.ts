/**
 * streamingDiagnosticsFormat.test.ts
 *
 * Pins `formatStreamingDiagnostics`, the text half of the streaming-diagnostics
 * record. The one property that matters more than layout is honesty: a field
 * the record names in `unavailable` must render as the word `unavailable`, never
 * as `0` or a dash — otherwise a reader quotes an invented zero from a bug
 * report. These tests assert that directly, plus the null-input and
 * fully-populated cases.
 */

import { describe, it, expect } from 'vitest';
import {
  buildStreamingDiagnostics,
  formatStreamingDiagnostics,
  type SchedulerDiagnosticsExtra,
} from '../src/render/streaming/streamingDiagnostics';
import {
  evaluateRefinementReadiness,
  type SchedulerReadinessFacts,
} from '../src/render/streaming/refinementReadiness';

const FACTS: SchedulerReadinessFacts = {
  wantedCount: 100,
  residentCount: 60,
  inFlightCount: 4,
  queuedCount: 36,
  decodedPendingCount: 2,
  failedCount: 1,
};

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

function build(overrides: Partial<SchedulerDiagnosticsExtra> = {}) {
  return buildStreamingDiagnostics(
    FACTS,
    evaluateRefinementReadiness(FACTS),
    extra(overrides),
  );
}

describe('formatStreamingDiagnostics', () => {
  it('renders a short line for a null record', () => {
    expect(formatStreamingDiagnostics(null)).toBe('(no active stream)');
  });

  it('renders every value field of a fully-populated record', () => {
    // Supply all five otherwise-optional quantities so nothing is unavailable.
    const d = build({
      generationId: 42,
      decodeRetryCount: 5,
      uploadPendingNodes: 8,
      uploadPendingBytes: 65_536,
      residentDecodedBytes: 12_582_912,
    });
    expect(d.unavailable).toEqual([]);

    const text = formatStreamingDiagnostics(d);
    expect(text).not.toContain('unavailable');
    // Readiness + wanted set + points + scheduler + cache + optionals present.
    expect(text).toContain('readiness');
    expect(text).toContain('resident 0.600'); // fractionResident
    expect(text).toContain('100 wanted');
    expect(text).toContain('60 resident');
    expect(text).toContain('4 in-flight');
    expect(text).toContain('36 queued');
    expect(text).toContain('1 failed');
    expect(text).toContain('3,200,000 resident');
    expect(text).toContain('5,000,000 budget');
    expect(text).toContain('tick 2.5 ms');
    expect(text).toContain('(stable)');
    expect(text).toContain('×0.85'); // fps budget factor
    expect(text).toContain('hits 900 misses 100');
    expect(text).toContain('42'); // generationId
    expect(text).toContain('8 nodes'); // uploadPendingNodes
    expect(text).toContain('65,536 bytes'); // uploadPendingBytes
    expect(text).toContain('12,582,912 bytes'); // residentDecodedBytes
  });

  it('prints named-unavailable fields as "unavailable", never a number', () => {
    // No optional quantities supplied: all five land in `unavailable`.
    const d = build();
    expect([...d.unavailable].sort()).toEqual(
      [
        'decodeRetryCount',
        'generationId',
        'residentDecodedBytes',
        'uploadPendingBytes',
        'uploadPendingNodes',
      ].sort(),
    );

    const text = formatStreamingDiagnostics(d);
    const generationLine = text
      .split('\n')
      .find((l) => l.startsWith('generation'));
    expect(generationLine).toBeDefined();
    // The word, not a fabricated 0.
    expect(generationLine).toContain('unavailable');
    expect(generationLine).not.toMatch(/generation\s+0\b/);

    const uploadLine = text.split('\n').find((l) => l.startsWith('upload queue'));
    expect(uploadLine).toBeDefined();
    // All three quantities on this line are unavailable, none rendered as 0.
    expect(uploadLine).not.toContain('0 nodes');
    expect(uploadLine).not.toContain('0 bytes');
    expect((uploadLine!.match(/unavailable/g) ?? []).length).toBe(3);
  });

  it('prints fractionResident/churn as "unavailable" when readiness is unknown', () => {
    // An empty wanted set → phase 'unknown' → both derived terms null.
    const emptyFacts: SchedulerReadinessFacts = {
      wantedCount: 0,
      residentCount: 0,
      inFlightCount: 0,
      queuedCount: 0,
      decodedPendingCount: 0,
      failedCount: 0,
    };
    const d = buildStreamingDiagnostics(
      emptyFacts,
      evaluateRefinementReadiness(emptyFacts),
      extra(),
    );
    const text = formatStreamingDiagnostics(d);
    expect(d.unavailable).toContain('fractionResident');
    expect(d.unavailable).toContain('churn');
    const readinessLine = text.split('\n')[0];
    expect(readinessLine).toContain('resident unavailable');
    expect(readinessLine).toContain('churn unavailable');
  });
});
