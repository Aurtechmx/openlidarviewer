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
import {
  evaluateRefinementReadiness,
  type SchedulerReadinessFacts,
} from '../src/render/streaming/refinementReadiness';
import { FACTS, extra } from './support/streamingDiagnosticsFixture';

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

    // A distinctive per-field pattern anchored to that field's label or position
    // in the readout — short and structural, so it does not restate (and drift
    // from, or duplicate) the formatter's own interpolations. Typed against the
    // field union: adding a field to the record without an entry here is a
    // compile error, and its pattern then forces a rendered line.
    const markers: Record<StreamingDiagnosticField, RegExp> = {
      readinessPhase: /readiness {5}\S/,
      fractionResident: /· resident \d\.\d{3}/,
      churn: /· churn \d\.\d{3}/,
      wantedNodes: /[\d,]+ wanted/,
      residentNodes: /· [\d,]+ resident/,
      inFlightNodes: /[\d,]+ in-flight/,
      queuedNodes: /[\d,]+ queued/,
      decodedPendingNodes: /[\d,]+ decoded-pending ·/,
      failedNodes: /[\d,]+ failed/,
      knownNodes: /[\d,]+ known/,
      visibleNodes: /[\d,]+ visible/,
      residentPoints: /points {8}[\d,]+ resident/,
      decodedPendingPoints: /decoded-pending \//,
      pointBudget: /[\d,]+ budget/,
      lastTickMs: /tick \d/,
      cameraVelocity: /camera \d/,
      cameraState: /u\/s \(\w+\)/,
      effectiveMaxConcurrent: /concurrency [\d,]+/,
      pressureDepthReduction: /pressure -[\d,]+ depth/,
      fpsBudgetFactor: /fps budget ×/,
      fullRescoreCount: /rescores [\d,]+/,
      cacheBytes: /cache {9}[\d.]+ [KMGT]?B \//,
      cacheEntries: /[\d,]+ entries/,
      cacheMaxBytes: /\/ [\d.]+ [KMGT]?B ·/,
      cacheHits: /hits [\d,]+/,
      cacheMisses: /misses [\d,]+/,
      cacheEvictions: /evict [\d,]+/,
      generationId: /generation {4}[\d,]+/,
      decodeRetryCount: /decode retries [\d,]+/,
      uploadPendingNodes: /upload queue {2}[\d,]+ nodes/,
      uploadPendingBytes: /nodes · [\d.]+ [KMGT]?B ·/,
      residentDecodedBytes: /resident decoded [\d.]+ [KMGT]?B/,
    };

    // The map covers exactly the field list — no field left unmarked, none stale.
    expect(Object.keys(markers).sort()).toEqual([...STREAMING_DIAGNOSTIC_FIELDS].sort());
    for (const field of STREAMING_DIAGNOSTIC_FIELDS) {
      expect(text, `field ${field} not reachable in output`).toMatch(markers[field]);
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
    expect(uploadLine!.match(/unavailable/g) ?? []).toHaveLength(3);
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
