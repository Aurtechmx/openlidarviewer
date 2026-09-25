/**
 * The governor's v2 outputs come back after the camera stops, through the
 * real render loop and frame demand.
 *
 * The A/B run of 32d633b2 ended every orbit/flythrough/zoomShock/scrub run
 * with render scale 0.6, point fraction 0.4 and a reduced mesh. Two causes,
 * each pinned here:
 *  - the refinement phase reads 'moving' for RENDER_HOLDOVER_MS (350 ms) after
 *    the last camera change, longer than a camera takes to come to rest, so a
 *    restore keyed on the phase had not run when the view was already still;
 *  - frame demand asked for no frame on the governor's behalf, so a loop that
 *    went idle while the outputs were reduced left them reduced until the
 *    next wake.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runRenderFrame, type RenderLoopHost } from '../src/render/renderLoop';
import { FrameDemand } from '../src/render/frameDemand';
import { RENDER_HOLDOVER_MS } from '../src/render/renderActivityGate';
import { GOVERNOR_WINDOW, installGovernor, uninstallGovernor } from '../src/render/perf/governorWiring';
import { TARGET_FRAME_MS } from '../src/render/perf/frameBudgetGovernor';

const FRAME = 1000 / 60;
const loadedMs = TARGET_FRAME_MS * 2.6; // load 0.8

afterEach(() => {
  uninstallGovernor();
  vi.restoreAllMocks();
});

/** A host whose camera last moved at `lastMove`, with the Viewer's phase rule. */
function host(clock: { now: number }, lastMove: number): RenderLoopHost {
  const noop = () => {};
  const over: Partial<RenderLoopHost> = {
    advanceFrameClock: () => FRAME / 1000,
    cameraActivityUntilMs: () => lastMove + RENDER_HOLDOVER_MS,
    activityUntilMs: () => lastMove + RENDER_HOLDOVER_MS,
    navQuality: () => ({ dpr: 1, phase: clock.now < lastMove + RENDER_HOLDOVER_MS ? 'moving' : 'coverage' }),
  };
  return new Proxy(over as RenderLoopHost, {
    get: (target, key: string) => (key in target ? (target as unknown as Record<string, unknown>)[key]
      : key === 'shouldRenderFrame' ? () => true
        : key === 'hasStreaming' || key === 'isTweening' ? () => false
          : key === 'toolMode' ? () => 'orbit'
            : key === 'sweepState' ? () => 'none'
              : () => noop()),
  });
}

describe('governor restore after the last camera move', () => {
  it('restores render scale and point budget well inside the phase holdover', () => {
    const clock = { now: 1000 };
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
    const g = installGovernor();
    for (let i = 0; i < GOVERNOR_WINDOW; i++) g.frameMs(loadedMs);
    const lastMove = 1000;
    const h = host(clock, lastMove);
    runRenderFrame(h); // moving under load
    expect(g.presentation().renderScale).toBe(0.6);
    // The camera is still from here on. A camera at rest is reported after ten
    // still navigation updates (navDriver SETTLE_UPDATES): ~167 ms at 60 Hz.
    while (clock.now < lastMove + 10 * FRAME) {
      clock.now += FRAME;
      runRenderFrame(h);
    }
    expect(clock.now).toBeLessThan(lastMove + RENDER_HOLDOVER_MS);
    expect(g.presentation()).toEqual({ renderScale: 1, pointBudgetFraction: 1, reducedMeshes: 0 });
  });
});

describe('frame demand while the governor is reduced', () => {
  it('asks for frames until the outputs are back, then lets the loop sleep', () => {
    const now = { ms: 0 };
    const d = new FrameDemand({
      nowMs: () => now.ms,
      tweening: () => false,
      streamingBusy: () => false,
      commitPending: () => false,
      fading: () => false,
    });
    const g = installGovernor();
    for (let i = 0; i < GOVERNOR_WINDOW; i++) g.frameMs(loadedMs);
    g.frame('moving', false);
    expect(g.presentation().renderScale).toBeLessThan(1);
    now.ms = 10_000; // every holdover long past
    expect(d.needsFrame(now.ms)).toBe(true);
    g.frame('full-refine', false, 10_000);
    expect(g.presentation().renderScale).toBe(1);
    expect(d.needsFrame(now.ms)).toBe(false);
  });
});
