/**
 * tests/touchGesture.test.ts
 *
 * Unit coverage for the v0.3.7 mobile touch-gesture decomposition. Pins:
 *
 *   - clean pinch produces non-zero `dPinch`, zero `dTwist`, zero `dPan`
 *   - clean twist produces non-zero `dTwist`, zero `dPinch`, zero `dPan`
 *   - clean pan produces non-zero `dPan`, zero everything else
 *   - dead-zones suppress noise on every axis independently
 *   - the −π / +π wrap-around doesn't spike the twist signal
 *   - a sloppy gesture decomposes into all three independently
 *
 * This is the seam every Viewer touch handler reads through, so
 * regressions here will surface on every mobile session.
 */

import { describe, it, expect } from 'vitest';
import {
  decompose2Pointer,
  isZero,
  DEFAULT_GESTURE_THRESHOLDS,
  type Pointer,
} from '../src/render/touchGesture';

const P = (x: number, y: number): Pointer => ({ x, y });

describe('decompose2Pointer — orthogonal channels', () => {
  it('reads a clean horizontal pinch-in as positive dPinch only', () => {
    // Fingers start at (0,0) and (200,0) — 200 px apart. They move to
    // (50,0) and (150,0) — 100 px apart. Pinch ratio = (100-200)/150 = −0.667.
    const d = decompose2Pointer(P(0, 0), P(200, 0), P(50, 0), P(150, 0));
    expect(d.dPinch).toBeLessThan(0);
    expect(d.dTwist).toBe(0);
    expect(d.dPan).toEqual({ x: 0, y: 0 });
  });

  it('reads a clean spread as negative-distance, positive pinch ratio', () => {
    const d = decompose2Pointer(P(50, 0), P(150, 0), P(0, 0), P(200, 0));
    expect(d.dPinch).toBeGreaterThan(0);
    expect(d.dTwist).toBe(0);
    expect(d.dPan).toEqual({ x: 0, y: 0 });
  });

  it('reads a clean 90° twist as ~π/2 radians, zero pinch and pan', () => {
    // Fingers at (−100,0) and (100,0) — horizontal. They twist 90° CCW
    // to (0,−100) and (0,100) — vertical. Distance unchanged.
    const d = decompose2Pointer(P(-100, 0), P(100, 0), P(0, -100), P(0, 100));
    expect(d.dPinch).toBe(0);
    expect(Math.abs(d.dTwist)).toBeCloseTo(Math.PI / 2, 3);
    expect(d.dPan).toEqual({ x: 0, y: 0 });
  });

  it('reads a clean lateral pan as dPan only', () => {
    // Both fingers shift right by 60 px. Distance and angle unchanged.
    const d = decompose2Pointer(P(0, 0), P(100, 0), P(60, 0), P(160, 0));
    expect(d.dPinch).toBe(0);
    expect(d.dTwist).toBe(0);
    expect(d.dPan.x).toBe(60);
    expect(d.dPan.y).toBe(0);
  });
});

describe('decompose2Pointer — dead-zones', () => {
  it('suppresses sub-threshold pinch as noise', () => {
    // 1 % spread — below the 3 % pinch dead-zone.
    const d = decompose2Pointer(P(0, 0), P(100, 0), P(-0.5, 0), P(100.5, 0));
    expect(d.dPinch).toBe(0);
  });

  it('suppresses sub-threshold twist as noise', () => {
    // ~1° twist — below the 4° twist dead-zone.
    const angle = (1 * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const d = decompose2Pointer(
      P(-100, 0),
      P(100, 0),
      P(-100 * cos, -(-100 * sin)),
      P(100 * cos, -(100 * sin)),
    );
    expect(d.dTwist).toBe(0);
  });

  it('suppresses sub-threshold pan as noise', () => {
    // 2 px centroid drift — below the 6 px pan dead-zone.
    const d = decompose2Pointer(P(0, 0), P(100, 0), P(2, 0), P(102, 0));
    expect(d.dPan).toEqual({ x: 0, y: 0 });
  });

  it('honours custom thresholds', () => {
    // A 5 % pinch that would normally fire, suppressed by raising the
    // dead-zone above it.
    const d = decompose2Pointer(P(0, 0), P(100, 0), P(2.5, 0), P(97.5, 0), {
      ...DEFAULT_GESTURE_THRESHOLDS,
      pinchDeadZone: 0.1,
    });
    expect(d.dPinch).toBe(0);
  });
});

describe('decompose2Pointer — edge cases', () => {
  it('returns zero deltas when the gesture is perfectly stationary', () => {
    const d = decompose2Pointer(P(50, 50), P(150, 50), P(50, 50), P(150, 50));
    expect(isZero(d)).toBe(true);
  });

  it('does not spike the twist when the segment crosses the −π / +π boundary', () => {
    // Segment angle starts at ~+179° and rotates 2° CCW to ~−179°.
    // Naive subtraction would read this as nearly a full turn; the
    // wrap-correction must keep it tiny.
    const a0 = (179 * Math.PI) / 180;
    const a1 = (-179 * Math.PI) / 180;
    const r = 100;
    const prevA: Pointer = { x: -Math.cos(a0) * r, y: Math.sin(a0) * r };
    const prevB: Pointer = { x: Math.cos(a0) * r, y: -Math.sin(a0) * r };
    const curA: Pointer = { x: -Math.cos(a1) * r, y: Math.sin(a1) * r };
    const curB: Pointer = { x: Math.cos(a1) * r, y: -Math.sin(a1) * r };
    const d = decompose2Pointer(prevA, prevB, curA, curB);
    // Should be ~2° wrapped to ≈ 0.035 rad. Must NOT be on the order of π.
    expect(Math.abs(d.dTwist)).toBeLessThan(0.2);
  });

  it('decomposes a sloppy gesture (pinch + twist + pan) into all three channels', () => {
    // Spread by ~30 %, twist by 30°, drift centre by 40 px right.
    const r0 = 100;
    const r1 = 130;
    const ang = (30 * Math.PI) / 180;
    const c0 = { x: 0, y: 0 };
    const c1 = { x: 40, y: 0 };
    const prevA: Pointer = { x: c0.x - r0, y: c0.y };
    const prevB: Pointer = { x: c0.x + r0, y: c0.y };
    const curA: Pointer = {
      x: c1.x - r1 * Math.cos(ang),
      y: c1.y + r1 * Math.sin(ang),
    };
    const curB: Pointer = {
      x: c1.x + r1 * Math.cos(ang),
      y: c1.y - r1 * Math.sin(ang),
    };
    const d = decompose2Pointer(prevA, prevB, curA, curB);
    expect(d.dPinch).toBeGreaterThan(0);
    expect(Math.abs(d.dTwist)).toBeGreaterThan(0.4); // ≈ 30° = 0.52 rad
    expect(d.dPan.x).toBeGreaterThan(30);
    expect(d.dPan.y).toBe(0);
  });

  it('handles a degenerate pair (both pointers coincident) without throwing', () => {
    const d = decompose2Pointer(P(50, 50), P(50, 50), P(60, 60), P(60, 60));
    expect(d.dPinch).toBe(0);
    expect(d.dTwist).toBe(0);
    // Pan is still computed from the centroid drift; (10, 10) → magnitude
    // ~14 px → above the 6 px dead-zone.
    expect(d.dPan.x).toBe(10);
    expect(d.dPan.y).toBe(10);
  });
});

describe('isZero', () => {
  it('returns true for a fully dead-zoned delta', () => {
    expect(isZero({ dPinch: 0, dTwist: 0, dPan: { x: 0, y: 0 } })).toBe(true);
  });
  it('returns false if any channel is non-zero', () => {
    expect(isZero({ dPinch: 0.01, dTwist: 0, dPan: { x: 0, y: 0 } })).toBe(false);
    expect(isZero({ dPinch: 0, dTwist: 0.01, dPan: { x: 0, y: 0 } })).toBe(false);
    expect(isZero({ dPinch: 0, dTwist: 0, dPan: { x: 1, y: 0 } })).toBe(false);
  });
});
