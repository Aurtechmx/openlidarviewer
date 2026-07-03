/**
 * metricsJson.ts
 *
 * The machine-readable metrics export behind the debug overlay's
 * "Copy metrics JSON" action (v0.5.5 P0). Pure serializer: it takes what the
 * overlay already has — the live sample it polls, the frame-telemetry
 * snapshot, the parsed dev flags — and emits one stable JSON document.
 *
 * Honesty rules baked in:
 *   - Nothing is fabricated. Absent subsystems serialize as null, and
 *     unsupported measurements (e.g. `longtask` on an unsupporting browser)
 *     stay null rather than reading 0.
 *   - Values are copied read-only from state the renderer/scheduler already
 *     exposes; this module computes nothing new.
 *
 * Pure — no DOM, no three.js — fully unit-tested in Node. Rides the lazy
 * DebugOverlay chunk, never the index.
 */

import type { DevFlags } from './devFlags';
import type { FrameTelemetrySnapshot } from './frameTelemetry';

/** Renderer-level stats, structurally matching `FrameStats` (Viewer.ts). */
export interface MetricsRenderingInput {
  fps: number;
  frameMs: number;
  drawCalls: number;
  displayedPoints: number;
  totalPoints: number;
  gpuBytesEstimate: number;
}

/**
 * Streaming counters, structurally matching `StreamingDebugStats`
 * (DebugOverlay.ts). Optional fields stay optional — absent means the
 * subsystem does not currently expose them, and they serialize as null.
 */
export interface MetricsStreamingInput {
  knownNodes: number;
  visibleNodes: number;
  queuedNodes: number;
  loadingNodes: number;
  residentNodes: number;
  displayedPoints: number;
  sourcePoints: number;
  cacheBytes: number;
  decodedBytes?: number;
  gpuBytes: number;
  schedulerMs: number;
  schedulerRecent?: { count: number; p50: number; p95: number; max: number };
  cacheHits?: number;
  cacheMisses?: number;
  cacheEvictions?: number;
  nodesReady?: number;
  nodesEvicted?: number;
  thrashEvents?: number;
}

/** Everything the export document is built from. */
export interface MetricsJsonInput {
  appVersion: string;
  /** ISO-8601 timestamp of the export (caller supplies — testable). */
  generatedAt: string;
  backend: 'webgpu' | 'webgl2' | null;
  flags: DevFlags;
  telemetry: FrameTelemetrySnapshot | null;
  rendering: MetricsRenderingInput | null;
  streaming: MetricsStreamingInput | null;
}

/** Round to 3 decimals for stable, readable ms values. */
function ms(v: number): number {
  return Math.round(v * 1000) / 1000;
}

const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/**
 * Build the metrics document as a plain object (exported for tests) —
 * fixed key order, versioned schema.
 */
export function buildMetricsDocument(input: MetricsJsonInput): Record<string, unknown> {
  const t = input.telemetry;
  const r = input.rendering;
  const s = input.streaming;
  return {
    schema: 'openlidarviewer.debug-metrics/2',
    appVersion: input.appVersion,
    generatedAt: input.generatedAt,
    backend: input.backend,
    // Only controls that actually change the measured runtime are reported as
    // flags. Controllers whose code exists in the tree but is not yet wired
    // into the live render/stream path are listed under stagedControllers, so
    // a benchmark can never read a staged flag as an active feature.
    flags: {
      wheelDolly: input.flags.wheelDolly,
      handPan: input.flags.handPan,
      refinementPhase: input.flags.refinementPhase,
      adaptiveDpr: input.flags.adaptiveDpr,
    },
    stagedControllers: ['streamingScore', 'uploadQueue', 'angularPrediction'],
    frameTiming: t
      ? {
          sampledForMs: ms(t.sampledForMs),
          frames: t.frame.total,
          windowCount: t.frame.windowCount,
          p50Ms: ms(t.frame.p50Ms),
          p95Ms: ms(t.frame.p95Ms),
          p99Ms: ms(t.frame.p99Ms),
          maxMs: ms(t.frame.maxMs),
          over16_7Ms: t.frame.over16_7,
          over33_3Ms: t.frame.over33_3,
          longestTaskMs: t.longestTaskMs === null ? null : ms(t.longestTaskMs),
          longTaskCount: t.longTaskCount,
          effectiveDpr: t.effectiveDpr,
        }
      : null,
    rendering: r
      ? {
          fps: ms(r.fps),
          frameMs: ms(r.frameMs),
          drawCalls: r.drawCalls,
          displayedPoints: r.displayedPoints,
          totalPoints: r.totalPoints,
          gpuBytesEstimate: r.gpuBytesEstimate,
        }
      : null,
    streaming: s
      ? {
          knownNodes: s.knownNodes,
          visibleNodes: s.visibleNodes,
          queuedNodes: s.queuedNodes,
          loadingNodes: s.loadingNodes,
          residentNodes: s.residentNodes,
          displayedPoints: s.displayedPoints,
          sourcePoints: s.sourcePoints,
          cacheBytes: s.cacheBytes,
          decodedBytes: orNull(s.decodedBytes),
          gpuBytes: s.gpuBytes,
          schedulerMs: ms(s.schedulerMs),
          schedulerRecent: s.schedulerRecent
            ? {
                count: s.schedulerRecent.count,
                p50Ms: ms(s.schedulerRecent.p50),
                p95Ms: ms(s.schedulerRecent.p95),
                maxMs: ms(s.schedulerRecent.max),
              }
            : null,
          cacheHits: orNull(s.cacheHits),
          cacheMisses: orNull(s.cacheMisses),
          cacheEvictions: orNull(s.cacheEvictions),
          nodesReady: orNull(s.nodesReady),
          nodesEvicted: orNull(s.nodesEvicted),
          thrashEvents: orNull(s.thrashEvents),
        }
      : null,
  };
}

/** The JSON string the overlay copies to the clipboard (2-space indent). */
export function buildMetricsJson(input: MetricsJsonInput): string {
  return JSON.stringify(buildMetricsDocument(input), null, 2);
}
