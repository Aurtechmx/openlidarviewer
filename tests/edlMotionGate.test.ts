/**
 * edlMotionGate.test.ts — the pure decision behind suspending EDL during camera
 * motion. Pins: a tween or recent input reads as "moving"; EDL runs only when
 * enabled AND parked; disabling EDL never runs the post-process.
 */

import { describe, it, expect } from 'vitest';
import { cameraIsMoving, edlActiveThisFrame } from '../src/render/edlMotionGate';

describe('cameraIsMoving', () => {
  it('is true while a camera tween animates, regardless of the activity window', () => {
    expect(cameraIsMoving(true, 1000, 0)).toBe(true);
  });

  it('is true while recent input is still inside the render-holdover window', () => {
    expect(cameraIsMoving(false, 900, 1000)).toBe(true); // now < activityUntilMs
  });

  it('is false when parked: no tween and the holdover has expired', () => {
    expect(cameraIsMoving(false, 1000, 1000)).toBe(false); // now == activityUntil → expired
    expect(cameraIsMoving(false, 1500, 1000)).toBe(false);
  });
});

describe('edlActiveThisFrame', () => {
  it('runs EDL only when it is enabled and the camera is parked', () => {
    expect(edlActiveThisFrame(true, false)).toBe(true);
  });

  it('suspends EDL while moving, even when enabled', () => {
    expect(edlActiveThisFrame(true, true)).toBe(false);
  });

  it('never runs EDL when it is disabled', () => {
    expect(edlActiveThisFrame(false, false)).toBe(false);
    expect(edlActiveThisFrame(false, true)).toBe(false);
  });
});
