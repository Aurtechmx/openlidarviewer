/**
 * hoverPickGate.test.ts — the pure gate behind "suspend the live probe pick
 * while the user is interacting or the camera is tweening". Pins the full truth
 * table, and pins that the gate runs during a plain hover (neither flag set) —
 * the case a debounced `moving` flag would have wrongly frozen.
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
});
