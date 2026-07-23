/**
 * renderActivityGate.test.ts — the "render this frame or skip it" decision.
 *
 * This lived as `Viewer._shouldRenderFrame` plus a scattered heartbeat counter
 * and an activity timestamp. It reads `performance.now()` and the streaming
 * scheduler, so it could only run inside a live render loop, and the parts
 * most likely to be wrong had no coverage: the exact holdover-expiry boundary,
 * the heartbeat coinciding with a render, and the PRIORITY between the four
 * reasons to render (tween, recent input, streaming busy, heartbeat).
 *
 * The gate takes an injected `now`, so every one of those is a plain Node
 * assertion. The Viewer keeps only the loop wiring and the actual `render()`.
 */

import { describe, it, expect } from 'vitest';
import { RenderActivityGate, RENDER_HOLDOVER_MS, IDLE_HEARTBEAT_FRAMES } from '../src/render/renderActivityGate';

/** A parked gate: no input, heartbeat freshly reset, nothing streaming. */
function parked(): RenderActivityGate {
  const g = new RenderActivityGate();
  g.noteRendered(); // heartbeat -> 0
  return g;
}

const idle = { tweening: false, streamingBusy: false };

describe('RenderActivityGate', () => {
  it('renders while a tween is in progress, whatever else is true', () => {
    const g = parked();
    expect(g.shouldRender(1_000_000, { tweening: true, streamingBusy: false })).toBe(true);
  });

  it('renders for the full holdover window after an input bump', () => {
    const g = parked();
    g.bump(1000);
    expect(g.shouldRender(1000, idle)).toBe(true);
    expect(g.shouldRender(1000 + RENDER_HOLDOVER_MS - 1, idle)).toBe(true);
  });

  it('stops rendering exactly when the holdover expires', () => {
    const g = parked();
    g.bump(1000);
    // The check is `now < until`, so the boundary instant itself is already
    // expired. Off-by-one here would keep the GPU awake one frame too long
    // forever, or cut a frame short of the window.
    expect(g.shouldRender(1000 + RENDER_HOLDOVER_MS, idle)).toBe(false);
  });

  it('renders while streaming is loading, then stops when it goes quiet', () => {
    const g = parked();
    expect(g.shouldRender(5000, { tweening: false, streamingBusy: true })).toBe(true);
    expect(g.shouldRender(5000, { tweening: false, streamingBusy: false })).toBe(false);
  });

  it('fires the heartbeat once enough idle frames have passed', () => {
    const g = parked();
    // Each idle frame: the gate says skip, then the loop notes the skip. After
    // IDLE_HEARTBEAT_FRAMES of them the counter reaches the threshold and the
    // next check fires the heartbeat.
    for (let i = 0; i < IDLE_HEARTBEAT_FRAMES; i++) {
      expect(g.shouldRender(9000, idle)).toBe(false);
      g.noteSkipped();
    }
    expect(g.shouldRender(9000, idle)).toBe(true);
  });

  it('resets the heartbeat when a frame renders, so ticks are evenly spaced', () => {
    const g = parked();
    for (let i = 0; i < IDLE_HEARTBEAT_FRAMES; i++) g.noteSkipped();
    expect(g.shouldRender(9000, idle)).toBe(true);
    g.noteRendered();
    // Immediately after a render the counter is 0 again — no double heartbeat.
    expect(g.shouldRender(9000, idle)).toBe(false);
  });

  it('a fresh gate renders on its first frame (heartbeat starts armed)', () => {
    // Without an initial render the very first loop iteration must still draw,
    // or the scene never appears until the first input.
    const g = new RenderActivityGate();
    expect(g.shouldRender(0, idle)).toBe(true);
  });

  it('exposes the activity deadline for the shared moving-camera signal', () => {
    // The EDL suspend and the DPR throttle read the same deadline, so it must
    // be observable rather than private to the gate.
    const g = parked();
    g.bump(2000);
    expect(g.activityUntilMs).toBe(2000 + RENDER_HOLDOVER_MS);
  });

  it('bump assigns the deadline from the given now (unconditional, matching the loop)', () => {
    // The clock is performance.now(), which is monotonic, so successive bumps
    // only increase in practice. The gate assigns unconditionally rather than
    // taking a max — a faithful copy of the original, not a new guard.
    const g = parked();
    g.bump(1500);
    expect(g.activityUntilMs).toBe(1500 + RENDER_HOLDOVER_MS);
    g.bump(2000);
    expect(g.activityUntilMs).toBe(2000 + RENDER_HOLDOVER_MS);
  });
});
