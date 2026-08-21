/**
 * hoverPickGate.test.ts — the pure gate behind "suspend the live probe pick
 * while the user is interacting or the camera is tweening". Pins the full truth
 * table, and pins that the gate runs during a plain hover (no flag set) — the
 * case a debounced `moving` flag would have wrongly frozen.
 *
 * `navigating` is pinned separately because only an OrbitControls drag sets
 * `userInteracting`: walk, fly, the custom orbit drag and the hand-pan drag are
 * invisible to it, and the pick they let through scans every point in every
 * visible cloud once per pointer-move frame.
 */

import { describe, it, expect } from 'vitest';
import { shouldRunProbePick } from '../src/render/hoverPickGate';

describe('shouldRunProbePick', () => {
  it('runs during a plain hover: not interacting, not tweening', () => {
    expect(shouldRunProbePick({ userInteracting: false, tweening: false })).toBe(true);
  });

  it('suspends while the user is actively interacting (dragging)', () => {
    expect(shouldRunProbePick({ userInteracting: true, tweening: false })).toBe(false);
  });

  it('suspends while a camera tween is animating', () => {
    expect(shouldRunProbePick({ userInteracting: false, tweening: true })).toBe(false);
  });

  it('suspends when both interacting and tweening', () => {
    expect(shouldRunProbePick({ userInteracting: true, tweening: true })).toBe(false);
  });

  it('suspends while the camera is driven by a mode OrbitControls misses', () => {
    // Walk, fly, the custom orbit drag and the hand-pan drag all report here.
    expect(
      shouldRunProbePick({ userInteracting: false, tweening: false, navigating: true }),
    ).toBe(false);
  });

  it('runs on a plain hover when navigating is explicitly false', () => {
    expect(
      shouldRunProbePick({ userInteracting: false, tweening: false, navigating: false }),
    ).toBe(true);
  });

  it('treats an omitted navigating as not navigating, so old callers are unchanged', () => {
    expect(shouldRunProbePick({ userInteracting: false, tweening: false })).toBe(true);
  });

  it('stays suspended when navigating combines with either other flag', () => {
    expect(
      shouldRunProbePick({ userInteracting: true, tweening: false, navigating: true }),
    ).toBe(false);
    expect(
      shouldRunProbePick({ userInteracting: false, tweening: true, navigating: true }),
    ).toBe(false);
  });
});
