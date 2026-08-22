/**
 * dampingSettle.test.ts
 *
 * The predicate that decides when an OrbitControls damping tail has stopped
 * being worth a full-rate frame. Three properties matter:
 *
 *   1. `decayRemaining` is the closed form of the geometric tail, so it must
 *      agree with an explicit summation of the same decay.
 *   2. `stepPixels` converts a camera step to on-screen displacement, so the
 *      threshold is perceptual rather than scene-dependent.
 *   3. `DampingSettleGate` stops arming inside a decay and arms again for any
 *      motion above the threshold, including motion the decay did not produce.
 *
 * All poses are generated from closed-form rotations, no randomness.
 */

import { describe, it, expect } from 'vitest';
import {
  decayRemaining,
  stepPixels,
  hasDampingSettled,
  DampingSettleGate,
  SETTLED_REMAINING_PX,
} from '../src/render/dampingSettle';
import { DAMPING_FACTOR, DAMPING_FACTOR_TOUCH } from '../src/render/orbitFeel';
import { projectedPixels } from '../src/render/pixelProjection';

/** Sum the tail of a geometric decay explicitly, past the step just taken. */
function summedTail(step: number, dampingFactor: number, terms: number): number {
  let pending = (step / dampingFactor) * (1 - dampingFactor);
  let total = 0;
  for (let i = 0; i < terms; i++) {
    total += pending * dampingFactor;
    pending *= 1 - dampingFactor;
  }
  return total;
}

/** A camera on the +Z axis, yawed by `yaw` radians about the origin. */
function poseAtYaw(yaw: number, radius: number) {
  return {
    quaternion: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
    position: { x: radius * Math.sin(yaw), y: 0, z: radius * Math.cos(yaw) },
    fov: 60,
  };
}

const ORIGIN_CONTROLS = { target: { x: 0, y: 0, z: 0 }, dampingFactor: DAMPING_FACTOR };
const VIEWPORT_PX = 1080;

describe('decayRemaining', () => {
  it('matches an explicit summation of the same decay', () => {
    expect(decayRemaining(0.5, DAMPING_FACTOR)).toBeCloseTo(summedTail(0.5, DAMPING_FACTOR, 4000), 9);
    expect(decayRemaining(3, DAMPING_FACTOR_TOUCH)).toBeCloseTo(
      summedTail(3, DAMPING_FACTOR_TOUCH, 4000),
      9,
    );
  });

  it('is 13.29 times the current step at the desktop damping factor', () => {
    expect(decayRemaining(1, DAMPING_FACTOR)).toBeCloseTo(13.2857, 4);
  });

  it('is 4.56 times the current step at the touch damping factor', () => {
    expect(decayRemaining(1, DAMPING_FACTOR_TOUCH)).toBeCloseTo(4.5556, 4);
  });

  it('scales linearly in the step', () => {
    expect(decayRemaining(2, DAMPING_FACTOR)).toBeCloseTo(2 * decayRemaining(1, DAMPING_FACTOR), 12);
  });

  it('has nothing left to run for a zero, negative or non-finite step', () => {
    expect(decayRemaining(0, DAMPING_FACTOR)).toBe(0);
    expect(decayRemaining(-1, DAMPING_FACTOR)).toBe(0);
    expect(decayRemaining(Number.NaN, DAMPING_FACTOR)).toBe(0);
  });

  it('never settles when the decay factor cannot decay', () => {
    expect(decayRemaining(1, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(decayRemaining(1, -0.5)).toBe(Number.POSITIVE_INFINITY);
    expect(hasDampingSettled(1e-9, 0)).toBe(false);
  });

  it('leaves nothing pending when the factor zeroes the delta on the tick', () => {
    expect(decayRemaining(1, 1)).toBe(0);
    expect(hasDampingSettled(1e6, 1)).toBe(true);
  });
});

describe('stepPixels', () => {
  it('projects a rotation through its arc length at the target distance', () => {
    const px = stepPixels(0.01, 0, 200, VIEWPORT_PX, Math.PI / 3);
    expect(px).toBeCloseTo(projectedPixels(0.01 * 200, 200, VIEWPORT_PX, Math.PI / 3), 9);
  });

  it('is scene-independent for rotation: the target distance cancels', () => {
    const near = stepPixels(0.01, 0, 5, VIEWPORT_PX, Math.PI / 3);
    const far = stepPixels(0.01, 0, 5000, VIEWPORT_PX, Math.PI / 3);
    expect(near).toBeCloseTo(far, 9);
  });

  it('adds translation on top of rotation', () => {
    const rotationOnly = stepPixels(0.01, 0, 200, VIEWPORT_PX, Math.PI / 3);
    const both = stepPixels(0.01, 2, 200, VIEWPORT_PX, Math.PI / 3);
    expect(both).toBeGreaterThan(rotationOnly);
    expect(both - rotationOnly).toBeCloseTo(
      projectedPixels(2, 200, VIEWPORT_PX, Math.PI / 3),
      9,
    );
  });

  it('counts a pure pan, which carries no rotation at all', () => {
    expect(stepPixels(0, 1, 200, VIEWPORT_PX, Math.PI / 3)).toBeGreaterThan(0);
  });

  it('takes the magnitude of a negative rotation or translation', () => {
    expect(stepPixels(-0.01, -2, 200, VIEWPORT_PX, Math.PI / 3)).toBeCloseTo(
      stepPixels(0.01, 2, 200, VIEWPORT_PX, Math.PI / 3),
      9,
    );
  });

  it('stays finite with the camera on the orbit target', () => {
    expect(Number.isFinite(stepPixels(0.01, 1, 0, VIEWPORT_PX, Math.PI / 3))).toBe(true);
  });
});

describe('hasDampingSettled', () => {
  it('settles exactly at the point the remaining travel reaches the threshold', () => {
    const atThreshold = (SETTLED_REMAINING_PX * DAMPING_FACTOR) / (1 - DAMPING_FACTOR);
    expect(hasDampingSettled(atThreshold, DAMPING_FACTOR)).toBe(false);
    expect(hasDampingSettled(atThreshold * 0.999, DAMPING_FACTOR)).toBe(true);
  });

  it('holds a step whose remaining travel is still a visible glide', () => {
    expect(hasDampingSettled(1, DAMPING_FACTOR)).toBe(false);
  });
});

describe('DampingSettleGate', () => {
  const RADIUS = 200;

  /**
   * Feed the gate a damping tail: a yaw that advances by `d * v0 * (1 - d)^n`
   * per tick, the decay OrbitControls applies. Returns the tick count that
   * stayed armed and the on-screen travel still pending at the cut.
   */
  function runTail(releaseSpeedRad: number, dampingFactor: number) {
    const gate = new DampingSettleGate();
    const controls = { target: { x: 0, y: 0, z: 0 }, dampingFactor };
    let yaw = 0;
    let pending = releaseSpeedRad;
    gate.arms(poseAtYaw(yaw, RADIUS), controls, VIEWPORT_PX);
    let armedTicks = 0;
    for (let tick = 0; tick < 600; tick++) {
      yaw += pending * dampingFactor;
      pending *= 1 - dampingFactor;
      if (!gate.arms(poseAtYaw(yaw, RADIUS), controls, VIEWPORT_PX)) {
        return {
          armedTicks,
          pendingPx: stepPixels(pending, 0, RADIUS, VIEWPORT_PX, Math.PI / 3),
        };
      }
      armedTicks++;
    }
    return { armedTicks, pendingPx: Number.POSITIVE_INFINITY };
  }

  it('arms the first pose, which has no predecessor to measure against', () => {
    const gate = new DampingSettleGate();
    expect(gate.arms(poseAtYaw(0, RADIUS), ORIGIN_CONTROLS, VIEWPORT_PX)).toBe(true);
  });

  it('does not arm when the camera has not moved between poses', () => {
    const gate = new DampingSettleGate();
    gate.arms(poseAtYaw(0, RADIUS), ORIGIN_CONTROLS, VIEWPORT_PX);
    expect(gate.arms(poseAtYaw(0, RADIUS), ORIGIN_CONTROLS, VIEWPORT_PX)).toBe(false);
  });

  it('arms while a drag-speed step is still arriving', () => {
    const gate = new DampingSettleGate();
    gate.arms(poseAtYaw(0, RADIUS), ORIGIN_CONTROLS, VIEWPORT_PX);
    expect(gate.arms(poseAtYaw(0.02, RADIUS), ORIGIN_CONTROLS, VIEWPORT_PX)).toBe(true);
  });

  it('cuts a hard flick well inside the tail OrbitControls keeps dispatching', () => {
    const { armedTicks } = runTail(0.36, DAMPING_FACTOR);
    expect(armedTicks).toBeGreaterThan(20);
    expect(armedTicks).toBeLessThan(90);
  });

  it('cuts a gentle release sooner than a hard flick', () => {
    expect(runTail(0.02, DAMPING_FACTOR).armedTicks).toBeLessThan(
      runTail(0.36, DAMPING_FACTOR).armedTicks,
    );
  });

  it('leaves under the pixel threshold pending whatever the release speed', () => {
    for (const speed of [0.01, 0.05, 0.1, 0.36, 0.9]) {
      expect(runTail(speed, DAMPING_FACTOR).pendingPx).toBeLessThan(SETTLED_REMAINING_PX);
    }
  });

  it('cuts the touch tail sooner, its damping being four times as strong', () => {
    expect(runTail(0.1, DAMPING_FACTOR_TOUCH).armedTicks).toBeLessThan(
      runTail(0.1, DAMPING_FACTOR).armedTicks,
    );
  });

  it('arms again for a fresh move after the tail has been cut', () => {
    const gate = new DampingSettleGate();
    gate.arms(poseAtYaw(0, RADIUS), ORIGIN_CONTROLS, VIEWPORT_PX);
    expect(gate.arms(poseAtYaw(1e-9, RADIUS), ORIGIN_CONTROLS, VIEWPORT_PX)).toBe(false);
    expect(gate.arms(poseAtYaw(0.05, RADIUS), ORIGIN_CONTROLS, VIEWPORT_PX)).toBe(true);
  });

  it('arms for a pan that carries no rotation', () => {
    const gate = new DampingSettleGate();
    const parked = { quaternion: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: RADIUS }, fov: 60 };
    const panned = { quaternion: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 4, y: 0, z: RADIUS }, fov: 60 };
    gate.arms(parked, ORIGIN_CONTROLS, VIEWPORT_PX);
    expect(gate.arms(panned, { target: { x: 4, y: 0, z: 0 }, dampingFactor: DAMPING_FACTOR }, VIEWPORT_PX))
      .toBe(true);
  });

  it('reads the same tail as settled sooner on a shorter viewport', () => {
    const tall = new DampingSettleGate();
    const short = new DampingSettleGate();
    const step = 1e-4;
    tall.arms(poseAtYaw(0, RADIUS), ORIGIN_CONTROLS, 2160);
    short.arms(poseAtYaw(0, RADIUS), ORIGIN_CONTROLS, 270);
    expect(tall.arms(poseAtYaw(step, RADIUS), ORIGIN_CONTROLS, 2160)).toBe(true);
    expect(short.arms(poseAtYaw(step, RADIUS), ORIGIN_CONTROLS, 270)).toBe(false);
  });
});
