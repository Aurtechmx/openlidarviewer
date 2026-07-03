/**
 * metricsJson.test.ts — the debug overlay's machine-readable export (P0).
 *
 * Contract: a stable, versioned schema; absent subsystems serialize as null
 * (never fabricated zeros); unsupported measurements stay null; the JSON
 * string round-trips.
 */

import { buildMetricsDocument, buildMetricsJson } from '../src/perf/metricsJson';
import { DEV_FLAG_DEFAULTS } from '../src/perf/devFlags';
import type { FrameTelemetrySnapshot } from '../src/perf/frameTelemetry';

const telemetry: FrameTelemetrySnapshot = {
  sampledForMs: 1234.5678,
  frame: {
    total: 100,
    windowCount: 60,
    p50Ms: 8.3333,
    p95Ms: 16.9,
    p99Ms: 33.4,
    maxMs: 50.05,
    over16_7: 7,
    over33_3: 2,
  },
  longestTaskMs: 82.4,
  longTaskCount: 3,
  effectiveDpr: 1.5,
};

describe('buildMetricsDocument', () => {
  it('emits the versioned schema with flags and rounded frame timing', () => {
    const doc = buildMetricsDocument({
      appVersion: '0.5.4',
      generatedAt: '2026-07-02T00:00:00.000Z',
      backend: 'webgpu',
      flags: { ...DEV_FLAG_DEFAULTS },
      telemetry,
      rendering: {
        fps: 119.99,
        frameMs: 8.3333,
        drawCalls: 12,
        displayedPoints: 1_000_000,
        totalPoints: 2_000_000,
        gpuBytesEstimate: 24_000_000,
      },
      streaming: null,
    });
    expect(doc.schema).toBe('openlidarviewer.debug-metrics/1');
    expect(doc.appVersion).toBe('0.5.4');
    expect(doc.backend).toBe('webgpu');
    expect(doc.flags).toEqual({ ...DEV_FLAG_DEFAULTS });
    expect(doc.frameTiming).toEqual({
      sampledForMs: 1234.568,
      frames: 100,
      windowCount: 60,
      p50Ms: 8.333,
      p95Ms: 16.9,
      p99Ms: 33.4,
      maxMs: 50.05,
      over16_7Ms: 7,
      over33_3Ms: 2,
      longestTaskMs: 82.4,
      longTaskCount: 3,
      effectiveDpr: 1.5,
    });
    expect(doc.streaming).toBeNull();
  });

  it('absent subsystems are null, not zeros', () => {
    const doc = buildMetricsDocument({
      appVersion: '0.5.4',
      generatedAt: '2026-07-02T00:00:00.000Z',
      backend: null,
      flags: { ...DEV_FLAG_DEFAULTS },
      telemetry: null,
      rendering: null,
      streaming: null,
    });
    expect(doc.frameTiming).toBeNull();
    expect(doc.rendering).toBeNull();
    expect(doc.streaming).toBeNull();
    expect(doc.backend).toBeNull();
  });

  it('unsupported longtask stays null through the export', () => {
    const doc = buildMetricsDocument({
      appVersion: '0.5.4',
      generatedAt: '2026-07-02T00:00:00.000Z',
      backend: 'webgl2',
      flags: { ...DEV_FLAG_DEFAULTS },
      telemetry: { ...telemetry, longestTaskMs: null, longTaskCount: null },
      rendering: null,
      streaming: null,
    });
    const ft = doc.frameTiming as { longestTaskMs: unknown; longTaskCount: unknown };
    expect(ft.longestTaskMs).toBeNull();
    expect(ft.longTaskCount).toBeNull();
  });

  it('optional streaming counters serialize as null when the scheduler does not expose them', () => {
    const doc = buildMetricsDocument({
      appVersion: '0.5.4',
      generatedAt: '2026-07-02T00:00:00.000Z',
      backend: 'webgpu',
      flags: { ...DEV_FLAG_DEFAULTS },
      telemetry: null,
      rendering: null,
      streaming: {
        knownNodes: 100,
        visibleNodes: 40,
        queuedNodes: 3,
        loadingNodes: 2,
        residentNodes: 35,
        displayedPoints: 900_000,
        sourcePoints: 5_000_000,
        cacheBytes: 1_000,
        gpuBytes: 2_000,
        schedulerMs: 1.2345,
        // decodedBytes / cache outcome counters / thrashEvents omitted.
      },
    });
    const s = doc.streaming as Record<string, unknown>;
    expect(s.decodedBytes).toBeNull();
    expect(s.cacheHits).toBeNull();
    expect(s.thrashEvents).toBeNull();
    expect(s.schedulerRecent).toBeNull();
    expect(s.schedulerMs).toBe(1.235);
    expect(s.residentNodes).toBe(35);
  });
});

describe('buildMetricsJson', () => {
  it('produces parseable JSON that round-trips the document', () => {
    const input = {
      appVersion: '0.5.4',
      generatedAt: '2026-07-02T00:00:00.000Z',
      backend: 'webgpu' as const,
      flags: { ...DEV_FLAG_DEFAULTS },
      telemetry,
      rendering: null,
      streaming: null,
    };
    expect(JSON.parse(buildMetricsJson(input))).toEqual(
      JSON.parse(JSON.stringify(buildMetricsDocument(input))),
    );
  });
});
