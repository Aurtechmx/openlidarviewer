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
// are both zero by then, so `streamingBusy` answers false, and the remaining
// commits would drain one pump per 250 ms safety heartbeat instead of one per
// frame.
//
// Staying awake is half of it. The gate decides whether an awake frame DRAWS,
// and it read only the fetch side, so the tail of a burst could be uploaded
// and then idle-throttled. Driving a real session never caught that happening
// — the scheduler is still ticking whenever geometry lands — so `commitWork`
// and the owed paint below make it structural rather than incidental.
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
    // The queue is empty, and exactly one frame is still owed: the last entry
    // was pumped AFTER that frame painted, so the scene on screen is one node
    // stale. It sleeps once that paint has happened, not before.
    expect(d.needsFrame(now.ms)).toBe(true);
    expect(d.shouldRender()).toBe(true);
    expect(d.needsFrame(now.ms)).toBe(false);
  });

  it('draws the frames a burst is still uploading on, not just the last', () => {
    // The gate is parked and the heartbeat freshly reset, so every `true` here
    // is `commitWork` and nothing else.
    let pending = true;
    const { d } = demand({ commitPending: () => pending });
    d.frameDrawn();
    expect(d.shouldRender()).toBe(true);
    pending = false;
    // Still not drawn: the falling edge is seen where the pump's effect is,
    // in the scheduler's post-frame question.
    expect(d.needsFrame(0)).toBe(true);
    expect(d.shouldRender()).toBe(true);
  });

  it('owes exactly one paint, and a second drain does not double it', () => {
    let pending = true;
    const { d } = demand({ commitPending: () => pending });
    // One frame with the commit outstanding, which is what arms the latch.
    // The pump only ever runs inside a frame body whose `shouldRender` has
    // already sampled, so a burst draining unobserved is unreachable.
    expect(d.shouldRender()).toBe(true);
    pending = false;
    expect(d.needsFrame(0)).toBe(true);
    expect(d.shouldRender()).toBe(true);
    expect(d.needsFrame(0)).toBe(false);
    // A fresh burst arms it again rather than finding the latch already spent.
    pending = true;
    expect(d.shouldRender()).toBe(true);
    pending = false;
    expect(d.needsFrame(0)).toBe(true);
    expect(d.shouldRender()).toBe(true);
    expect(d.needsFrame(0)).toBe(false);
  });

  it('owes a paint when geometry lands, with no commit queue involved at all', () => {
    // The shipped path: `immediate` mode, so `commitPending` is false for the
    // whole session and the queue-watching latch never arms. The node-ready
    // event is what has to carry it.
    const { d } = demand({ commitPending: () => false });
    d.gate.noteRendered();
    expect(d.needsFrame(0)).toBe(false);
    d.streamedGeometryChanged();
    expect(d.needsFrame(0)).toBe(true);
    expect(d.shouldRender()).toBe(true);
    expect(d.needsFrame(0)).toBe(false);
  });

  it('keeps owing when geometry lands after the frame decided to draw', () => {
    // The loop renders, THEN pumps and ticks, and in metered mode
    // `onNodeReady` fires from inside the pump. So the sequence below is one
    // frame: decide, draw, land, end-of-frame. Discharging the debt at the
    // end would have this frame absolve itself of a node it never showed.
    const { d } = demand({ commitPending: () => false });
    d.gate.noteRendered();
    d.streamedGeometryChanged();
    expect(d.shouldRender()).toBe(true); // decided; debt discharged here
    d.streamedGeometryChanged(); // lands mid-body, after the render
    d.frameDrawn(); // end of the frame body
    expect(d.needsFrame(0)).toBe(true);
    expect(d.shouldRender()).toBe(true);
    expect(d.needsFrame(0)).toBe(false);
  });

  it('never sleeps on geometry that landed after the frame decided to draw', () => {
    // One call of `frame` is one loop iteration in the real order: the gate
    // decides, the render happens, THEN the body pumps and ticks the
    // scheduler — which is where `onNodeReady` fires in metered mode — and
    // the scheduler asks last whether to go round again.
    let busy = true;
    const { d } = demand({ streamingBusy: () => busy });
    d.gate.noteRendered();

    // Frame 1 draws because fetches are outstanding. Then the body runs: a
    // node reaches the scene, and the last fetch completes in the same body.
    expect(d.shouldRender()).toBe(true);
    d.gate.noteRendered();
    d.streamedGeometryChanged();
    busy = false;
    d.frameDrawn();
    // The picture was taken before the node arrived, so it is still owed —
    // and nothing else is asking now that the fetches are done.
    expect(d.needsFrame(0)).toBe(true);

    // Frame 2 pays it.
    expect(d.shouldRender()).toBe(true);
    d.gate.noteRendered();
    d.frameDrawn();
    expect(d.needsFrame(0)).toBe(false);

    // And it stays settled rather than spinning on a flag nothing clears.
    d.gate.noteSkipped();
    expect(d.needsFrame(0)).toBe(false);
  });

  it('does not owe a paint when no commit was ever pending', () => {
    // `immediate` mode never populates the decoded set, so there is no falling
    // edge to detect and the loop must sleep exactly as it did before.
    const { d } = demand({ commitPending: () => false });
    d.gate.noteRendered(); // park the heartbeat; a fresh gate draws its first frame
    expect(d.needsFrame(0)).toBe(false);
    expect(d.needsFrame(16)).toBe(false);
    expect(d.shouldRender()).toBe(false);
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

describe('an active fade both wakes the loop and draws', () => {
  it('draws while the dissolve runs, not once per heartbeat', () => {
    // `needsFrame` always saw the fade; the gate did not, so the loop spun at
    // rAF and skipped almost every frame it woke for.
    let fading = true;
    const { d } = demand({ fading: () => fading });
    d.gate.noteRendered();
    expect(d.needsFrame(0)).toBe(true);
    expect(d.shouldRender()).toBe(true);
    // Still drawing several frames in, with the heartbeat freshly reset each
    // time, which is what a smooth dissolve needs.
    for (let f = 0; f < 5; f++) {
      d.gate.noteRendered();
      expect(d.shouldRender(), `frame ${f}`).toBe(true);
    }
    fading = false;
    d.gate.noteRendered();
    expect(d.shouldRender()).toBe(false);
    expect(d.needsFrame(0)).toBe(false);
  });
});
