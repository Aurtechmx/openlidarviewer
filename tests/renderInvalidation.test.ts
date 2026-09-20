import { describe, expect, it } from 'vitest';

import { RENDER_HOLDOVER_MS } from '../src/render/renderActivityGate';
import {
  ALL_INVALIDATION_REASONS,
  KIND,
  MOVES_CAMERA,
  RenderInvalidation,
  type RenderInvalidationReason,
} from '../src/render/renderInvalidation';

describe('the reason table', () => {
  it('gives every reason exactly one kind', () => {
    for (const reason of ALL_INVALIDATION_REASONS) {
      expect(['once', 'holdover', 'while']).toContain(KIND[reason]);
    }
    expect(new Set(ALL_INVALIDATION_REASONS).size).toBe(ALL_INVALIDATION_REASONS.length);
  });

  it('counts only the three camera reasons as motion', () => {
    expect([...MOVES_CAMERA].sort()).toEqual(['camera-damping', 'camera-input', 'camera-tween']);
    // The distinction the second activity deadline exists for: these want a
    // frame and none of them is the camera moving.
    for (const quiet of ['style', 'filter', 'viewport', 'tool-overlay'] as RenderInvalidationReason[]) {
      expect(MOVES_CAMERA.has(quiet)).toBe(false);
    }
  });
});

describe('once reasons', () => {
  it('asks for a frame and stops after one serves it', () => {
    const inv = new RenderInvalidation();
    expect(inv.needsFrame(0)).toBe(false);
    inv.invalidate('style');
    expect(inv.needsFrame(0)).toBe(true);
    expect(inv.serve(0).reasons).toEqual(['style']);
    expect(inv.needsFrame(0)).toBe(false);
  });

  it('cannot be released, because the change has already happened', () => {
    const inv = new RenderInvalidation();
    inv.invalidate('filter');
    inv.release('filter');
    expect(inv.needsFrame(0)).toBe(true);
  });

  it('coalesces repeats into one pending ask', () => {
    const inv = new RenderInvalidation();
    inv.invalidate('clip');
    inv.invalidate('clip');
    inv.invalidate('clip');
    expect(inv.serve(0).reasons).toEqual(['clip']);
    expect(inv.needsFrame(0)).toBe(false);
  });
});

describe('holdover reasons', () => {
  it('keeps asking for the holdover window and stops at its expiry', () => {
    const inv = new RenderInvalidation();
    inv.invalidate('camera-input', 1000);
    expect(inv.needsFrame(1000)).toBe(true);
    expect(inv.needsFrame(1000 + RENDER_HOLDOVER_MS - 1)).toBe(true);
    // The boundary matches the activity gate: the expiry instant is idle.
    expect(inv.needsFrame(1000 + RENDER_HOLDOVER_MS)).toBe(false);
  });

  it('extends from the most recent input rather than the first', () => {
    const inv = new RenderInvalidation();
    inv.invalidate('camera-input', 1000);
    inv.invalidate('camera-input', 1200);
    expect(inv.needsFrame(1200 + RENDER_HOLDOVER_MS - 1)).toBe(true);
    expect(inv.needsFrame(1200 + RENDER_HOLDOVER_MS)).toBe(false);
  });

  it('survives a served frame', () => {
    const inv = new RenderInvalidation();
    inv.invalidate('camera-input', 0);
    inv.serve(0);
    expect(inv.needsFrame(10)).toBe(true);
  });

  it('treats a non-finite clock as an immediate window rather than a forever one', () => {
    const inv = new RenderInvalidation();
    inv.invalidate('camera-input', Number.NaN);
    expect(inv.needsFrame(0)).toBe(true);
    expect(inv.needsFrame(RENDER_HOLDOVER_MS)).toBe(false);
  });
});

describe('while reasons', () => {
  it('holds until its owner releases it, however many frames run', () => {
    const inv = new RenderInvalidation();
    inv.invalidate('camera-tween');
    for (let frame = 0; frame < 50; frame++) {
      expect(inv.needsFrame(frame * 16)).toBe(true);
      inv.serve(frame * 16);
    }
    inv.release('camera-tween');
    expect(inv.needsFrame(800)).toBe(false);
  });

  it('accepts a release for a reason it is not holding', () => {
    const inv = new RenderInvalidation();
    expect(() => inv.release('lod-fade')).not.toThrow();
    expect(inv.needsFrame(0)).toBe(false);
  });

  it('cannot be released through a reason of another kind', () => {
    const inv = new RenderInvalidation();
    inv.invalidate('gpu-commit-pending');
    inv.release('style');
    expect(inv.holds('gpu-commit-pending', 0)).toBe(true);
  });
});

describe('the metered-commit deadlock', () => {
  it('keeps the loop awake from the frame the queue fills to the frame it drains', () => {
    // The failure this rules out: a queue that drains only from rendered
    // frames, filled while the loop is asleep, never drains.
    const inv = new RenderInvalidation();
    let queued = 0;
    const enqueue = () => {
      const wasEmpty = queued === 0;
      queued += 1;
      if (wasEmpty) inv.invalidate('gpu-commit-pending');
    };
    const pump = () => {
      if (queued > 0) queued -= 1;
      if (queued === 0) inv.release('gpu-commit-pending');
    };

    expect(inv.needsFrame(0)).toBe(false); // asleep
    enqueue();
    enqueue();
    enqueue();
    let frames = 0;
    while (inv.needsFrame(frames * 16) && frames < 100) {
      inv.serve(frames * 16);
      pump();
      frames++;
    }
    expect(queued).toBe(0);
    expect(frames).toBe(3);
    expect(inv.needsFrame(frames * 16)).toBe(false); // back to sleep
  });
});

describe('served frames', () => {
  it('reports what asked for the frame, in declaration order', () => {
    const inv = new RenderInvalidation();
    inv.invalidate('style');
    inv.invalidate('camera-tween');
    inv.invalidate('clip');
    const served = inv.serve(0);
    expect(served.reasons).toEqual(['camera-tween', 'style', 'clip']);
    expect(served.cameraMoving).toBe(true);
  });

  it('does not call a hover, a filter or a resize camera motion', () => {
    const inv = new RenderInvalidation();
    inv.invalidate('tool-overlay');
    inv.invalidate('filter');
    inv.invalidate('viewport');
    const served = inv.serve(0);
    expect(served.reasons.length).toBe(3);
    expect(served.cameraMoving).toBe(false);
  });

  it('describes the frame about to be drawn, not the state after it', () => {
    const inv = new RenderInvalidation();
    inv.invalidate('screenshot');
    expect(inv.serve(0).reasons).toEqual(['screenshot']);
    expect(inv.serve(0).reasons).toEqual([]);
  });

  it('stops reporting camera motion once the holdover expires', () => {
    const inv = new RenderInvalidation();
    inv.invalidate('camera-input', 0);
    expect(inv.serve(0).cameraMoving).toBe(true);
    expect(inv.cameraMoving(RENDER_HOLDOVER_MS)).toBe(false);
  });
});

describe('clear', () => {
  it('drops every kind, so a held condition must be re-asserted', () => {
    const inv = new RenderInvalidation();
    inv.invalidate('style');
    inv.invalidate('device-recovery');
    inv.invalidate('camera-input', 0);
    inv.clear();
    expect(inv.needsFrame(0)).toBe(false);
    expect(inv.reasons(0)).toEqual([]);
  });
});

describe('every reason behaves as its kind says', () => {
  it('asks for a frame when invalidated, whichever reason it is', () => {
    for (const reason of ALL_INVALIDATION_REASONS) {
      const inv = new RenderInvalidation();
      inv.invalidate(reason, 0);
      expect(inv.needsFrame(0)).toBe(true);
      expect(inv.holds(reason, 0)).toBe(true);
    }
  });

  it('survives a frame if and only if it is not a once reason', () => {
    for (const reason of ALL_INVALIDATION_REASONS) {
      const inv = new RenderInvalidation();
      inv.invalidate(reason, 0);
      inv.serve(0);
      expect(inv.holds(reason, 0)).toBe(KIND[reason] !== 'once');
    }
  });
});

describe('consumeOnce', () => {
  it('clears the once reasons and leaves the others, without a report', () => {
    const inv = new RenderInvalidation();
    inv.invalidate('style');
    inv.invalidate('camera-tween');
    inv.invalidate('camera-input', 0);
    inv.consumeOnce();
    expect(inv.holds('style', 0)).toBe(false);
    expect(inv.holds('camera-tween', 0)).toBe(true);
    expect(inv.holds('camera-input', 0)).toBe(true);
  });

  it('agrees with serve about what survives a frame', () => {
    for (const reason of ALL_INVALIDATION_REASONS) {
      const served = new RenderInvalidation();
      const consumed = new RenderInvalidation();
      served.invalidate(reason, 0);
      consumed.invalidate(reason, 0);
      served.serve(0);
      consumed.consumeOnce();
      expect(consumed.holds(reason, 0)).toBe(served.holds(reason, 0));
    }
  });
});
