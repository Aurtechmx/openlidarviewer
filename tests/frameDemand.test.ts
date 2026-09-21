import { describe, expect, it } from 'vitest';

import { FrameDemand, type FrameDemandSignals } from '../src/render/frameDemand';
import { RENDER_HOLDOVER_MS } from '../src/render/renderActivityGate';

function demand(over: Partial<FrameDemandSignals> = {}): { d: FrameDemand; now: { ms: number } } {
  const now = { ms: 0 };
  const d = new FrameDemand({
    nowMs: () => now.ms,
    tweening: () => false,
    streamingBusy: () => false,
    commitPending: () => false,
    fading: () => false,
    ...over,
  });
  return { d, now };
}

describe('needsFrame', () => {
  it('is false when nothing asked and nothing is running', () => {
    const { d } = demand();
    expect(d.needsFrame(0)).toBe(false);
  });

  it('is true after any input, for the holdover window', () => {
    const { d } = demand();
    d.input();
    expect(d.needsFrame(0)).toBe(true);
    expect(d.needsFrame(RENDER_HOLDOVER_MS)).toBe(false);
  });

  it('is true while a tween, a streaming fetch or a fade runs', () => {
    for (const key of ['tweening', 'streamingBusy', 'fading'] as const) {
      const { d } = demand({ [key]: () => true });
      expect(d.needsFrame(0), key).toBe(true);
    }
  });

  it('holds a while-reason until it finishes', () => {
    const { d } = demand();
    d.changed('gpu-commit-pending');
    expect(d.needsFrame(10_000)).toBe(true);
    d.finished('gpu-commit-pending');
    expect(d.needsFrame(10_000)).toBe(false);
  });

  it('keeps a once-reason until a frame runs, not merely until it is recorded', () => {
    const { d } = demand();
    d.changed('style');
    expect(d.needsFrame(0)).toBe(true);
    expect(d.needsFrame(60_000)).toBe(true);
  });
});

describe('the two bumps', () => {
  it('differ only in whether the camera is said to have moved', () => {
    const { d: hover } = demand();
    hover.input();
    expect(hover.gate.activityUntilMs).toBe(RENDER_HOLDOVER_MS);
    // A hover must not stand the motion-gated effects down.
    expect(hover.gate.cameraUntilMs).toBe(0);

    const { d: moved } = demand();
    moved.cameraMoved();
    expect(moved.gate.cameraUntilMs).toBe(RENDER_HOLDOVER_MS);
  });

  it('both keep the loop wanting frames', () => {
    const { d: a } = demand();
    a.input();
    const { d: b } = demand();
    b.cameraMoved();
    expect(a.needsFrame(0)).toBe(true);
    expect(b.needsFrame(0)).toBe(true);
  });
});

describe('shouldRender', () => {
  it('is the gate, which has an idle heartbeat needsFrame deliberately lacks', () => {
    const { d } = demand();
    // Nothing has asked, so the loop does not need a frame; the gate would
    // still draw one on its heartbeat if a frame ran.
    expect(d.needsFrame(0)).toBe(false);
    expect(d.shouldRender()).toBe(true);
  });
});

describe('scheduler state', () => {
  it('reports stopped before the backend is up', () => {
    const { d } = demand();
    expect(d.schedulerState).toBe('stopped');
  });

  it('survives a stop without losing what asked', () => {
    const { d } = demand();
    d.changed('filter');
    d.stop();
    expect(d.needsFrame(0)).toBe(true);
  });
});

describe('drawn-frame listeners', () => {
  it('runs each listener per drawn frame and stops on unsubscribe', () => {
    const { d } = demand();
    let a = 0;
    let b = 0;
    const offA = d.onDrawnFrame(() => { a += 1; });
    d.onDrawnFrame(() => { b += 1; });
    d.frameDrawn();
    d.frameDrawn();
    expect([a, b]).toEqual([2, 2]);
    offA();
    d.frameDrawn();
    expect([a, b]).toEqual([2, 3]);
  });

  it('runs nothing of its own accord', () => {
    const { d } = demand();
    let runs = 0;
    d.onDrawnFrame(() => { runs += 1; });
    expect(d.needsFrame(0)).toBe(false);
    expect(runs).toBe(0);
  });

  it('drops its listeners on dispose', () => {
    const { d } = demand();
    let runs = 0;
    d.onDrawnFrame(() => { runs += 1; });
    d.dispose();
    d.frameDrawn();
    expect(runs).toBe(0);
  });
});

// A decoded node awaiting a metered GPU commit is pending visible work, and
// the loop must not sleep on it. The scheduler's `queued` and `loading` counts
// are both zero by then, so `streamingBusy` answers false; fades hid the gap,
// because a fading node keeps the chain alive on its own. The mobile and
// low-quality paths turn fades off, and the remaining commits would then drain
// one pump per 250 ms safety heartbeat instead of one per frame.
describe('pending GPU commits keep the loop awake', () => {
  it('needs a frame with no fetch backlog, no fade, no tween and no input', () => {
    const { d } = demand({ commitPending: () => true });
    expect(d.needsFrame(0)).toBe(true);
  });

  it('keeps needing frames until the queue drains, not until a heartbeat', () => {
    let pending = 3;
    const { d, now } = demand({ commitPending: () => pending > 0 });
    // Each frame pumps one entry. Well inside the 250 ms heartbeat, so nothing
    // here is the heartbeat making progress.
    for (let frame = 0; frame < 3; frame++) {
      expect(d.needsFrame(now.ms), `frame ${frame}`).toBe(true);
      pending--;
      now.ms += 16;
    }
    expect(d.needsFrame(now.ms)).toBe(false);
  });

  it('is what keeps it awake, not the other signals', () => {
    // All four false is the sleeping case; only commitPending is flipped.
    expect(demand({}).d.needsFrame(0)).toBe(false);
    expect(demand({ commitPending: () => true }).d.needsFrame(0)).toBe(true);
  });

  it('answers false on the shipped immediate mode, where nothing is ever pending', () => {
    // `immediate` commits inside the decode, so the store's decoded set is
    // empty and the loop sleeps exactly as it did before this signal existed.
    const { d } = demand({ commitPending: () => false });
    expect(d.needsFrame(0)).toBe(false);
  });
});
