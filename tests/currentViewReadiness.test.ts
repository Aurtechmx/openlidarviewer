/**
 * currentViewReadiness.test.ts
 *
 * The current-view readout: `streamingViewStatus` turns ONE streaming
 * diagnostics snapshot into the panel's headline, fraction and detail.
 *
 * The contract under test is that the panel describes the WANTED set — the
 * nodes the scheduler selected for the camera as it stands — and nothing else.
 * A resident/known hierarchy ratio is not a completion percentage for a
 * view-dependent source, a failed node can never read as ready, and a settled
 * view whose wanted set then grows must fall back below 100% (there is no
 * latch to hold it up).
 *
 * The last case pins the shared authority: the same
 * `SchedulerReadinessFacts` that the renderer's phase machine evaluates is what
 * the panel line is derived from, so the two can never disagree.
 */

import { describe, it, expect } from 'vitest';
import { streamingViewStatus } from '../src/ui/streamingViewStatus';
import {
  buildStreamingDiagnostics,
  type StreamingDiagnostics,
} from '../src/render/streaming/streamingDiagnostics';
import {
  evaluateRefinementReadiness,
  type SchedulerReadinessFacts,
} from '../src/render/streaming/refinementReadiness';

/** Neutral values for every quantity this readout does not read. */
const EXTRA = {
  knownNodes: 4096,
  visibleNodes: 0,
  residentPoints: 0,
  decodedPendingPoints: 0,
  pointBudget: 1_000_000,
  lastTickMs: 1,
  cameraVelocity: 0,
  cameraStable: true,
  effectiveMaxConcurrent: 4,
  pressureDepthReduction: 0,
  fpsBudgetFactor: 1,
  fullRescoreCount: 0,
  cacheBytes: 0,
  cacheEntries: 0,
  cacheMaxBytes: 1,
  cacheHits: 0,
  cacheMisses: 0,
  cacheEvictions: 0,
};

/** Build a snapshot the way the scheduler does: one verdict, from the facts. */
function snapshot(facts: Partial<SchedulerReadinessFacts>): StreamingDiagnostics {
  const full: SchedulerReadinessFacts = {
    wantedCount: 0,
    residentCount: 0,
    inFlightCount: 0,
    queuedCount: 0,
    decodedPendingCount: 0,
    failedCount: 0,
    ...facts,
  };
  return buildStreamingDiagnostics(full, evaluateRefinementReadiness(full), EXTRA);
}

describe('streamingViewStatus — the current view, not the whole source', () => {
  it('refuses a verdict with no wanted set: indeterminate, no fabricated percentage', () => {
    const v = streamingViewStatus(snapshot({ wantedCount: 0 }), false);
    expect(v.state).toBe('unknown');
    expect(v.determinate).toBe(false);
    expect(v.fraction).toBeNull();
    expect(v.headline).toBe('Establishing current view…');
  });

  it('reports a loading view as resident-over-wanted', () => {
    const v = streamingViewStatus(
      snapshot({ wantedCount: 10, residentCount: 4, queuedCount: 3, inFlightCount: 3 }),
      false,
    );
    expect(v.state).toBe('loading');
    expect(v.headline).toBe('Loading current view…');
    expect(v.fraction).toBeCloseTo(0.4, 10);
    expect(v.detail).toBe('4 / 10 requested nodes resident');
  });

  it('reports a tail still landing as refining', () => {
    const v = streamingViewStatus(
      snapshot({ wantedCount: 20, residentCount: 19, decodedPendingCount: 1 }),
      false,
    );
    expect(v.state).toBe('settling');
    expect(v.headline).toBe('Refining current view…');
    expect(v.fraction).toBeCloseTo(0.95, 10);
  });

  it('calls a fully resident wanted set ready, at a real 100%', () => {
    const v = streamingViewStatus(snapshot({ wantedCount: 20, residentCount: 20 }), false);
    expect(v.state).toBe('settled');
    expect(v.headline).toBe('Current view ready');
    expect(v.fraction).toBe(1);
  });

  it('never reads as ready while a wanted node has failed', () => {
    const v = streamingViewStatus(
      snapshot({ wantedCount: 20, residentCount: 19, failedCount: 1 }),
      false,
    );
    expect(v.state).toBe('incomplete');
    expect(v.headline).toBe('Current view incomplete — 1 requested node could not load');
    expect(v.headline).not.toMatch(/ready/);
    expect(v.fraction).toBeCloseTo(0.95, 10);
  });

  it('pluralises the failed-node count', () => {
    const v = streamingViewStatus(
      snapshot({ wantedCount: 20, residentCount: 18, failedCount: 2 }),
      false,
    );
    expect(v.headline).toBe('Current view incomplete — 2 requested nodes could not load');
  });

  it('tells a paused view apart from a failed one', () => {
    const v = streamingViewStatus(
      snapshot({ wantedCount: 10, residentCount: 6, queuedCount: 4 }),
      true,
    );
    expect(v.state).toBe('paused');
    expect(v.headline).toBe('Paused');
    expect(v.tone).not.toBe('warn');
    expect(v.detail).toBe('6 / 10 requested nodes resident');
  });

  it('falls back below 100% when a settled view acquires a new wanted set', () => {
    const settled = streamingViewStatus(snapshot({ wantedCount: 20, residentCount: 20 }), false);
    expect(settled.fraction).toBe(1);
    // The camera moved: the scheduler now wants 50 nodes and holds the 20 it had.
    const moved = streamingViewStatus(
      snapshot({ wantedCount: 50, residentCount: 20, queuedCount: 30 }),
      false,
    );
    expect(moved.state).toBe('loading');
    expect(moved.fraction).toBeCloseTo(0.4, 10);
    expect(moved.headline).not.toBe('Current view ready');
  });

  it('derives its state from the SAME facts the renderer phase machine evaluates', () => {
    const facts: SchedulerReadinessFacts = {
      wantedCount: 30,
      residentCount: 29,
      inFlightCount: 1,
      queuedCount: 0,
      decodedPendingCount: 0,
      failedCount: 0,
    };
    const rendererVerdict = evaluateRefinementReadiness(facts);
    const panel = streamingViewStatus(
      buildStreamingDiagnostics(facts, rendererVerdict, EXTRA),
      false,
    );
    expect(panel.state).toBe(rendererVerdict.phase);
    expect(panel.fraction).toBe(
      rendererVerdict.phase === 'unknown' ? null : rendererVerdict.fractionResident,
    );
  });
});
