import { describe, it, expect } from 'vitest';
import {
  exposureFor,
  shouldAccumulate,
  isExposureSwap,
  type Exposure,
} from '../src/render/continuity/convergenceExposure';
import { IDLE, nextConvergence, type ConvergenceState } from '../src/render/continuity/convergence';
import {
  applyLensIntent,
  tracksContinuously,
  viewportCentre,
  KEYBOARD_STEP_PX,
  type LensSource,
  type Viewport,
  type LensSizing,
} from '../src/render/continuity/lensPlacement';
import { LENS_CLOSED, insideLens } from '../src/render/continuity/evidenceLens';
import type { PhaseCount } from '../src/render/continuity/temporalPhase';

const PHASES = 4 as PhaseCount;
const view: Viewport = { widthPx: 800, heightPx: 600 };
const sizing: LensSizing = { radiusPx: 60, featherPx: 20 };

/** Drive a parked camera through a whole sweep under one epoch. */
function sweep(reducedMotion: boolean): Exposure[] {
  let state: ConvergenceState = IDLE;
  const seen: Exposure[] = [];
  for (let f = 0; f < 8; f++) {
    state = nextConvergence(state, { epoch: 1, refinement: 'full-refine', phaseCount: PHASES });
    seen.push(exposureFor(state, reducedMotion));
  }
  return seen;
}

describe('exposure under reduced motion', () => {
  it('shows the direct rendering for the whole sweep, then swaps once', () => {
    const seen = sweep(true);
    const swaps = seen.filter((e, i) => i > 0 && isExposureSwap(seen[i - 1], e)).length;
    expect(swaps).toBe(1);
    expect(seen[0]).toBe('direct');
    expect(seen[seen.length - 1]).toBe('accumulated');
  });

  it('shows the history as it builds when motion is not reduced', () => {
    const seen = sweep(false);
    expect(seen.every((e) => e === 'accumulated')).toBe(true);
  });

  it('reaches the same final image either way', () => {
    expect(sweep(true).at(-1)).toBe(sweep(false).at(-1));
  });

  it('presents the direct rendering while idle under either preference', () => {
    expect(exposureFor(IDLE, true)).toBe('direct');
    expect(exposureFor(IDLE, false)).toBe('direct');
  });

  it('does not let the preference change what is computed', () => {
    let state: ConvergenceState = IDLE;
    for (let f = 0; f < 8; f++) {
      state = nextConvergence(state, { epoch: 1, refinement: 'full-refine', phaseCount: PHASES });
      // The accumulation decision reads no preference at all.
      expect(shouldAccumulate(state)).toBe(state.kind === 'converging');
    }
  });

  it('returns to the direct rendering when a moving camera breaks the epoch', () => {
    let state: ConvergenceState = IDLE;
    state = nextConvergence(state, { epoch: 1, refinement: 'full-refine', phaseCount: PHASES });
    state = nextConvergence(state, { epoch: 1, refinement: 'moving', phaseCount: PHASES });
    expect(exposureFor(state, true)).toBe('direct');
    expect(exposureFor(state, false)).toBe('direct');
  });
});

describe('which sources track and which pin', () => {
  it('tracks a hovering pointer and pins everything else', () => {
    expect(tracksContinuously('pointer')).toBe(true);
    expect(tracksContinuously('touch')).toBe(false);
    expect(tracksContinuously('keyboard')).toBe(false);
  });

  it('keeps a touch lens open after the finger lifts', () => {
    const placed = applyLensIntent(
      LENS_CLOSED, { kind: 'at', source: 'touch', xPx: 300, yPx: 200 }, view, sizing,
    );
    const after = applyLensIntent(placed, { kind: 'release', source: 'touch' }, view, sizing);
    expect(after.enabled).toBe(true);
    expect(after.centreXPx).toBe(300);
    expect(insideLens(300, 200, after)).toBe(true);
  });

  it('closes a pointer lens when the pointer leaves', () => {
    const placed = applyLensIntent(
      LENS_CLOSED, { kind: 'at', source: 'pointer', xPx: 300, yPx: 200 }, view, sizing,
    );
    expect(applyLensIntent(placed, { kind: 'release', source: 'pointer' }, view, sizing).enabled)
      .toBe(false);
  });

  it('closes a pinned lens on dismiss, whatever put it there', () => {
    for (const source of ['touch', 'keyboard'] as LensSource[]) {
      const placed = applyLensIntent(
        LENS_CLOSED, { kind: 'at', source, xPx: 100, yPx: 100 }, view, sizing,
      );
      expect(applyLensIntent(placed, { kind: 'close' }, view, sizing).enabled).toBe(false);
    }
  });
});

describe('a lens with no position of its own', () => {
  it('opens at the viewport centre, not the origin', () => {
    const opened = applyLensIntent(LENS_CLOSED, { kind: 'open', source: 'keyboard' }, view, sizing);
    expect(opened.enabled).toBe(true);
    expect({ x: opened.centreXPx, y: opened.centreYPx }).toEqual(viewportCentre(view));
    expect(opened.centreXPx).not.toBe(0);
  });

  it('leaves an already-open lens where the viewer put it', () => {
    const placed = applyLensIntent(
      LENS_CLOSED, { kind: 'at', source: 'keyboard', xPx: 120, yPx: 90 }, view, sizing,
    );
    const again = applyLensIntent(placed, { kind: 'open', source: 'keyboard' }, view, sizing);
    expect(again.centreXPx).toBe(120);
    expect(again.centreYPx).toBe(90);
  });

  it('moves by whole steps', () => {
    const opened = applyLensIntent(LENS_CLOSED, { kind: 'open', source: 'keyboard' }, view, sizing);
    const moved = applyLensIntent(opened, { kind: 'nudge', dxSteps: 2, dySteps: -1 }, view, sizing);
    expect(moved.centreXPx).toBe(opened.centreXPx + 2 * KEYBOARD_STEP_PX);
    expect(moved.centreYPx).toBe(opened.centreYPx - KEYBOARD_STEP_PX);
  });

  it('cannot be driven off the viewport', () => {
    let lens = applyLensIntent(LENS_CLOSED, { kind: 'open', source: 'keyboard' }, view, sizing);
    for (let i = 0; i < 50; i++) {
      lens = applyLensIntent(lens, { kind: 'nudge', dxSteps: -1, dySteps: -1 }, view, sizing);
    }
    expect(lens.centreXPx).toBe(0);
    expect(lens.centreYPx).toBe(0);
    for (let i = 0; i < 100; i++) {
      lens = applyLensIntent(lens, { kind: 'nudge', dxSteps: 1, dySteps: 1 }, view, sizing);
    }
    expect(lens.centreXPx).toBe(view.widthPx);
    expect(lens.centreYPx).toBe(view.heightPx);
  });

  it('does not open on a nudge', () => {
    expect(applyLensIntent(LENS_CLOSED, { kind: 'nudge', dxSteps: 1, dySteps: 0 }, view, sizing).enabled)
      .toBe(false);
  });
});

describe('positions that are not positions', () => {
  it('refuses a non-finite placement rather than opening somewhere undefined', () => {
    for (const bad of [NaN, Infinity]) {
      const out = applyLensIntent(
        LENS_CLOSED, { kind: 'at', source: 'touch', xPx: bad, yPx: 10 }, view, sizing,
      );
      expect(out.enabled).toBe(false);
    }
  });

  it('survives a nudge carrying a non-finite step', () => {
    const opened = applyLensIntent(LENS_CLOSED, { kind: 'open', source: 'keyboard' }, view, sizing);
    const out = applyLensIntent(opened, { kind: 'nudge', dxSteps: NaN, dySteps: 1 }, view, sizing);
    expect(Number.isFinite(out.centreXPx)).toBe(true);
    expect(out.centreXPx).toBe(opened.centreXPx);
  });

  it('places nothing in a viewport with no area', () => {
    const none: Viewport = { widthPx: 0, heightPx: 0 };
    expect(applyLensIntent(LENS_CLOSED, { kind: 'open', source: 'keyboard' }, none, sizing).enabled)
      .toBe(false);
  });

  it('clamps an out-of-viewport touch onto the canvas', () => {
    const out = applyLensIntent(
      LENS_CLOSED, { kind: 'at', source: 'touch', xPx: 9999, yPx: -40 }, view, sizing,
    );
    expect(out.centreXPx).toBe(view.widthPx);
    expect(out.centreYPx).toBe(0);
  });
});
