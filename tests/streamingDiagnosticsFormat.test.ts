/**
 * streamingDiagnosticsFormat.test.ts
 *
 * Pins `formatStreamingDiagnostics`, the text half of the streaming-diagnostics
 * record. Three properties matter more than layout.
 *
 * Honesty: a field the record names in `unavailable` must render as the word
 * `unavailable`, never as `0` or a dash — otherwise a reader quotes an invented
 * zero from a bug report.
 *
 * Completeness (anti-rot): the formatter hand-lays-out its lines rather than
 * iterating `STREAMING_DIAGNOSTIC_FIELDS`, so a field added to the record later
 * would compile clean and silently never render. A per-field reachability check
 * fails CI the moment that happens — the marker map is typed against the field
 * union, so a new field is both a compile error here and a missing line there.
 */

import { describe, it, expect } from 'vitest';
import {
  buildStreamingDiagnostics,
  formatStreamingDiagnostics,
  STREAMING_DIAGNOSTIC_FIELDS,
  type SchedulerDiagnosticsExtra,
  type StreamingDiagnosticField,
} from '../src/render/streaming/streamingDiagnostics';
import { formatByteSize, groupInt } from '../src/io/formatByteSize';
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

/** All five otherwise-unavailable quantities, so nothing lands in `unavailable`. */
const OPTIONALS = {
  generationId: 42,
  decodeRetryCount: 5,
  uploadPendingNodes: 8,
  uploadPendingBytes: 65_536,
  residentDecodedBytes: 12_582_912,
} as const;

describe('formatStreamingDiagnostics', () => {
  it('renders a short line for a null record', () => {
    expect(formatStreamingDiagnostics(null)).toBe('(no active stream)');
  });

  it('makes every diagnostic field reachable in a fully-populated readout', () => {
    const d = build({ ...OPTIONALS });
    expect(d.unavailable).toEqual([]);
    const text = formatStreamingDiagnostics(d);

    // A distinctive marker per field, derived from the record's own values so
    // the check tracks the data rather than a second hard-coded copy. Typed
    // against the field union: adding a field to the record without an entry
    // here is a compile error, and its marker then forces a rendered line.
    const markers: Record<StreamingDiagnosticField, string> = {
      readinessPhase: `readiness     ${d.readinessPhase}`,
      fractionResident: `resident ${d.fractionResident!.toFixed(3)}`,
      churn: `churn ${d.churn!.toFixed(3)}`,
      wantedNodes: `${groupInt(d.wantedNodes)} wanted`,
      residentNodes: `${groupInt(d.residentNodes)} resident`,
      inFlightNodes: `${groupInt(d.inFlightNodes)} in-flight`,
      queuedNodes: `${groupInt(d.queuedNodes)} queued`,
      decodedPendingNodes: `${groupInt(d.decodedPendingNodes)} decoded-pending`,
      failedNodes: `${groupInt(d.failedNodes)} failed`,
      knownNodes: `${groupInt(d.knownNodes)} known`,
      visibleNodes: `${groupInt(d.visibleNodes)} visible`,
      residentPoints: `${groupInt(d.residentPoints)} resident`,
      decodedPendingPoints: `${groupInt(d.decodedPendingPoints)} decoded-pending`,
      pointBudget: `${groupInt(d.pointBudget)} budget`,
      lastTickMs: `tick ${d.lastTickMs.toFixed(1)} ms`,
      cameraVelocity: `${d.cameraVelocity.toFixed(2)} u/s`,
      cameraState: `(${d.cameraState})`,
      effectiveMaxConcurrent: `concurrency ${groupInt(d.effectiveMaxConcurrent)}`,
      pressureDepthReduction: `-${groupInt(d.pressureDepthReduction)} depth`,
      fpsBudgetFactor: `×${d.fpsBudgetFactor.toFixed(2)}`,
      fullRescoreCount: `rescores ${groupInt(d.fullRescoreCount)}`,
      cacheBytes: `${formatByteSize(d.cacheBytes)} /`,
      cacheEntries: `${groupInt(d.cacheEntries)} entries`,
      cacheMaxBytes: `/ ${formatByteSize(d.cacheMaxBytes)}`,
      cacheHits: `hits ${groupInt(d.cacheHits)}`,
      cacheMisses: `misses ${groupInt(d.cacheMisses)}`,
      cacheEvictions: `evict ${groupInt(d.cacheEvictions)}`,
      generationId: `generation    ${groupInt(d.generationId!)}`,
      decodeRetryCount: `decode retries ${groupInt(d.decodeRetryCount!)}`,
      uploadPendingNodes: `${groupInt(d.uploadPendingNodes!)} nodes`,
      uploadPendingBytes: formatByteSize(d.uploadPendingBytes!),
      residentDecodedBytes: `resident decoded ${formatByteSize(d.residentDecodedBytes!)}`,
    };

    // The map covers exactly the field list — no field left unmarked, none stale.
    expect(Object.keys(markers).sort()).toEqual([...STREAMING_DIAGNOSTIC_FIELDS].sort());
    for (const field of STREAMING_DIAGNOSTIC_FIELDS) {
      expect(text, `field ${field} not reachable in output`).toContain(markers[field]);
    }
  });

  it('renders byte quantities through the shared formatter, not raw integers', () => {
    const d = build({ uploadPendingBytes: 65_536, residentDecodedBytes: 12_582_912 });
    const text = formatStreamingDiagnostics(d);
    expect(text).toContain('8.0 MB');   // cacheBytes
    expect(text).toContain('16.0 MB');  // cacheMaxBytes
    expect(text).toContain('64.0 KB');  // uploadPendingBytes
    expect(text).toContain('12.0 MB');  // residentDecodedBytes
    expect(text).not.toContain('8,388,608');
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
    const generationLine = text.split('\n').find((l) => l.startsWith('generation'));
    expect(generationLine).toBeDefined();
    // The word, not a fabricated 0.
    expect(generationLine).toContain('unavailable');
    expect(generationLine).not.toMatch(/generation\s+0\b/);

    const uploadLine = text.split('\n').find((l) => l.startsWith('upload queue'));
    expect(uploadLine).toBeDefined();
    // All three quantities on this line are unavailable, none rendered as 0.
    expect(uploadLine).not.toContain('0 nodes');
    expect(uploadLine).not.toContain('0 B');
    expect((uploadLine!.match(/unavailable/g) ?? []).length).toBe(3);
  });

  it('prints fractionResident/churn as "unavailable" when readiness is unknown', () => {
    // An empty wanted set → phase 'unknown' → both derived terms null and named.
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
    expect(d.unavailable).toContain('fractionResident');
    expect(d.unavailable).toContain('churn');
    const readinessLine = text0(d);
    expect(readinessLine).toContain('resident unavailable');
    expect(readinessLine).toContain('churn unavailable');
  });
});

/** The first (readiness) line of a rendered record. */
function text0(d: Parameters<typeof formatStreamingDiagnostics>[0]): string {
  return formatStreamingDiagnostics(d).split('\n')[0];
}
