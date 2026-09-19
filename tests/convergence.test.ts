import { describe, it, expect } from 'vitest';
import {
  IDLE,
  nextConvergence,
  phaseToDraw,
  isConverged,
  type ConvergenceState,
} from '../src/render/streaming/convergence';
import type { PhaseCount } from '../src/render/streaming/temporalPhase';

const COUNTS: PhaseCount[] = [2, 4, 8];
const parked = (epoch: number, phaseCount: PhaseCount) => ({ epoch, moving: false, phaseCount });

/** Run `frames` parked frames at one epoch, from a starting state. */
function park(from: ConvergenceState, epoch: number, k: PhaseCount, frames: number) {
  let s = from;
  const drawn: (number | null)[] = [];
  for (let i = 0; i < frames; i++) {
    s = nextConvergence(s, parked(epoch, k));
    drawn.push(phaseToDraw(s));
  }
  return { state: s, drawn };
}

describe('convergence', () => {
  it.each(COUNTS)('draws each phase once then stops, k=%i', (k) => {
    const { state, drawn } = park(IDLE, 1, k, k + 4);
    expect(drawn.slice(0, k)).toEqual(Array.from({ length: k }, (_, i) => i));
    // Everything after the sweep draws nothing: the image cannot change, so the
    // renderer has something to stop for.
    expect(drawn.slice(k).every((p) => p === null)).toBe(true);
    expect(isConverged(state)).toBe(true);
  });

  it.each(COUNTS)('stays converged while the epoch holds, k=%i', (k) => {
    const { state } = park(IDLE, 1, k, k + 50);
    const after = nextConvergence(state, parked(1, k));
    expect(after).toBe(state);
  });

  // A sweep drawn against a camera that has since moved cannot be resumed: the
  // frames already contributed describe a different picture.
  it('drops the sweep when the camera moves, rather than pausing it', () => {
    const mid = park(IDLE, 1, 4, 2).state;
    expect(mid.kind).toBe('converging');
    const moved = nextConvergence(mid, { epoch: 1, moving: true, phaseCount: 4 });
    expect(moved).toEqual(IDLE);
    expect(phaseToDraw(moved)).toBeNull();
  });

  it('restarts from phase 0 after motion, not from where it stopped', () => {
    const mid = park(IDLE, 1, 4, 3).state;
    const moved = nextConvergence(mid, { epoch: 1, moving: true, phaseCount: 4 });
    const resumed = nextConvergence(moved, parked(2, 4));
    expect(phaseToDraw(resumed)).toBe(0);
  });

  // Parking is not the only thing that changes what a pixel means. A colour mode
  // or a filter moves the epoch while the camera is perfectly still.
  it('restarts on an epoch change with the camera still parked', () => {
    const done = park(IDLE, 1, 4, 5).state;
    expect(isConverged(done)).toBe(true);
    const next = nextConvergence(done, parked(2, 4));
    expect(next.kind).toBe('converging');
    expect(phaseToDraw(next)).toBe(0);
  });

  it('restarts mid-sweep on an epoch change', () => {
    const mid = park(IDLE, 1, 8, 5).state;
    const next = nextConvergence(mid, parked(9, 8));
    expect(next).toEqual({ kind: 'converging', epoch: 9, nextPhase: 0, contributed: 0 });
  });

  // Convergence is known one frame after the last phase is drawn, and that is
  // not an off-by-one to tidy away. On frame k there is still a phase to draw,
  // so a machine that reported converged there would have `phaseToDraw` return
  // null and the last phase would never reach the image: 1/k of the points
  // silently missing. The extra frame issues no accumulation work.
  it.each(COUNTS)('stays unconverged while a phase is still owed, k=%i', (k) => {
    for (let f = 1; f <= k; f++) {
      const { state, drawn } = park(IDLE, 3, k, f);
      expect(isConverged(state)).toBe(false);
      expect(drawn[f - 1]).toBe(f - 1);
    }
    expect(isConverged(park(IDLE, 3, k, k + 1).state)).toBe(true);
  });

  it.each(COUNTS)('draws every phase before reporting converged, k=%i', (k) => {
    const { drawn } = park(IDLE, 3, k, k + 1);
    const contributed = drawn.filter((p): p is number => p !== null);
    expect(new Set(contributed).size).toBe(k);
    expect(drawn[k]).toBeNull();
  });

  it('draws nothing while moving, however long the camera moves', () => {
    let s: ConvergenceState = IDLE;
    for (let i = 0; i < 20; i++) {
      s = nextConvergence(s, { epoch: i, moving: true, phaseCount: 4 });
      expect(phaseToDraw(s)).toBeNull();
      expect(isConverged(s)).toBe(false);
    }
  });

  it('never names a phase outside the sweep', () => {
    for (const k of COUNTS) {
      const { drawn } = park(IDLE, 1, k, k + 6);
      for (const p of drawn) if (p !== null) expect(p).toBeLessThan(k);
    }
  });
});
