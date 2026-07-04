/**
 * wheelDollyMath.test.ts
 *
 * Pins the P2 wheel/trackpad dolly maths: delta normalisation across the three
 * `deltaMode`s, the log-space velocity model, and — the important property —
 * refresh-rate independence (the same synthetic sequence reaches the same zoom
 * at 60 / 120 / 144 Hz within a small discretisation tolerance).
 */

import { describe, it, expect } from 'vitest';
import {
  DOM_DELTA_LINE,
  DOM_DELTA_PAGE,
  DOM_DELTA_PIXEL,
  normalizeWheelDeltaPx,
  applyWheelImpulse,
  clampDollyVelocity,
  stepDolly,
  isDollySettled,
} from '../src/render/wheelDollyMath';

describe('normalizeWheelDeltaPx', () => {
  it('passes pixel-mode deltas through unchanged', () => {
    expect(normalizeWheelDeltaPx(120, DOM_DELTA_PIXEL, 16, 800)).toBe(120);
  });
  it('scales line-mode deltas by the line height', () => {
    expect(normalizeWheelDeltaPx(3, DOM_DELTA_LINE, 16, 800)).toBe(48);
  });
  it('scales page-mode deltas by the viewport height', () => {
    expect(normalizeWheelDeltaPx(1, DOM_DELTA_PAGE, 16, 800)).toBe(800);
  });
  it('falls back to sane constants for invalid line/page metrics', () => {
    expect(normalizeWheelDeltaPx(2, DOM_DELTA_LINE, 0, 800)).toBe(32); // 2 * 16 fallback
    expect(normalizeWheelDeltaPx(1, DOM_DELTA_PAGE, 16, -1)).toBe(800); // 1 * 800 fallback
  });
  it('collapses non-finite input to 0', () => {
    expect(normalizeWheelDeltaPx(Number.NaN, DOM_DELTA_PIXEL, 16, 800)).toBe(0);
  });
});

describe('applyWheelImpulse', () => {
  it('adds the scaled delta to the velocity', () => {
    expect(applyWheelImpulse(0, 100, 0.002)).toBeCloseTo(0.2, 12);
  });
  it('ignores non-finite input', () => {
    expect(applyWheelImpulse(0.5, Number.NaN, 0.002)).toBe(0.5);
  });
  it('is unbounded by default (no clamp)', () => {
    expect(applyWheelImpulse(0, 1e6, 1)).toBe(1e6);
  });
  it('respects an opt-in velocity ceiling', () => {
    // 0 + 1e6·1 = 1e6, clamped to 0.8
    expect(applyWheelImpulse(0, 1e6, 1, 0.8)).toBe(0.8);
    expect(applyWheelImpulse(0, -1e6, 1, 0.8)).toBe(-0.8);
  });
});

describe('clampDollyVelocity', () => {
  it('passes a velocity within the ceiling through unchanged', () => {
    expect(clampDollyVelocity(0.3, 0.8)).toBe(0.3);
  });
  it('clamps symmetrically at ±maxVelocity', () => {
    expect(clampDollyVelocity(5, 0.8)).toBe(0.8);
    expect(clampDollyVelocity(-5, 0.8)).toBe(-0.8);
  });
  it('is a no-op for an unbounded / invalid ceiling', () => {
    expect(clampDollyVelocity(9, Number.POSITIVE_INFINITY)).toBe(9);
    expect(clampDollyVelocity(9, 0)).toBe(9);
    expect(clampDollyVelocity(9, -1)).toBe(9);
  });
  it('collapses a non-finite velocity to 0', () => {
    expect(clampDollyVelocity(Number.NaN, 0.8)).toBe(0);
    expect(clampDollyVelocity(Number.POSITIVE_INFINITY, 0.8)).toBe(0);
  });
});

describe('stepDolly', () => {
  it('applies exp(velocity·dt) for a small step', () => {
    expect(stepDolly(0.5, 1 / 60, 0).scale).toBeCloseTo(Math.exp(0.5 / 60), 12);
  });
  it('decays velocity by exp(-friction·dt)', () => {
    expect(stepDolly(1, 0.1, 10).velocity).toBeCloseTo(Math.exp(-1), 12);
  });
  it('returns unit scale for zero velocity or non-positive dt', () => {
    expect(stepDolly(0, 1 / 60, 10).scale).toBe(1);
    expect(stepDolly(0.5, 0, 10).scale).toBe(1);
  });
  it('clamps the per-frame scale to maxFrameScale', () => {
    expect(stepDolly(100, 1, 0, 1.15).scale).toBeCloseTo(1.15, 6);
    expect(stepDolly(-100, 1, 0, 1.15).scale).toBeCloseTo(1 / 1.15, 6);
  });
});

describe('stepDolly — refresh-rate independence', () => {
  function totalZoom(hz: number, seconds: number, v0: number, friction: number): number {
    const dt = 1 / hz;
    const steps = Math.round(seconds * hz);
    let v = v0;
    let total = 1;
    for (let i = 0; i < steps; i++) {
      const s = stepDolly(v, dt, friction, 10); // high clamp so it never engages here
      total *= s.scale;
      v = s.velocity;
    }
    return total;
  }
  it('reaches the same final zoom (within ~0.5%) at 60 / 120 / 144 Hz', () => {
    const v0 = 0.4;
    const friction = 16;
    const T = 0.5;
    const a = totalZoom(60, T, v0, friction);
    const b = totalZoom(120, T, v0, friction);
    const c = totalZoom(144, T, v0, friction);
    expect(b / a).toBeCloseTo(1, 2); // |ratio − 1| < 0.005
    expect(c / a).toBeCloseTo(1, 2);
  });
});

describe('isDollySettled', () => {
  it('is settled below the threshold and moving above it', () => {
    expect(isDollySettled(0.001)).toBe(true);
    expect(isDollySettled(0.01)).toBe(false);
  });
});
