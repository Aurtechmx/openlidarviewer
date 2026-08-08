/**
 * touchTapGate.test.ts — the clean-tap gate that turns raw pointer events into a
 * double-tap-to-focus decision, rejecting drags and pinches.
 */

import { describe, it, expect } from 'vitest';
import { TouchTapGate } from '../src/render/touchTapGate';

describe('TouchTapGate', () => {
  it('two clean quick taps at the same spot fire a focus on the second up', () => {
    const g = new TouchTapGate();
    g.down(1, 100, 100);
    expect(g.up(0, 1000, 100, 100)).toBeNull(); // first tap
    g.down(1, 101, 99);
    expect(g.up(0, 1150, 101, 99)).toEqual({ x: 101, y: 99 }); // double → focus
  });

  it('a drag (finger moves past the slop) is not a tap', () => {
    const g = new TouchTapGate();
    g.down(1, 100, 100);
    expect(g.up(0, 1000, 100, 100)).toBeNull();
    g.down(1, 100, 100);
    g.move(140, 100); // moved 40 px → drag
    expect(g.up(0, 1100, 140, 100)).toBeNull();
  });

  it('a two-finger sequence (pinch/pan) is never a tap', () => {
    const g = new TouchTapGate();
    g.down(1, 100, 100);
    expect(g.up(0, 1000, 100, 100)).toBeNull(); // prime a first tap
    // Second finger down marks the sequence multi-touch.
    g.down(1, 100, 100);
    g.down(2, 200, 100);
    expect(g.up(1, 1100, 200, 100)).toBeNull(); // first finger lifts, one remains
    expect(g.up(0, 1120, 100, 100)).toBeNull(); // second lifts — not a tap
  });

  it('a slow second tap (beyond the double-tap window) does not fire', () => {
    const g = new TouchTapGate();
    g.down(1, 100, 100);
    expect(g.up(0, 1000, 100, 100)).toBeNull();
    g.down(1, 100, 100);
    expect(g.up(0, 1500, 100, 100)).toBeNull(); // 500 ms later → separate taps
  });

  it('reset clears any pending tap', () => {
    const g = new TouchTapGate();
    g.down(1, 10, 10);
    expect(g.up(0, 1000, 10, 10)).toBeNull();
    g.reset();
    g.down(1, 10, 10);
    expect(g.up(0, 1100, 10, 10)).toBeNull(); // no pending anchor after reset
  });
});
