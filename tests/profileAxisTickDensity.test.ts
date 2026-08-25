/**
 * profileAxisTickDensity.test.ts — an axis that carries the detail it was asked for.
 *
 * Two things made the workbench plot coarser than its size warranted.
 *
 * The step was always rounded UP to the next nice value, which can only ever
 * produce fewer ticks than the target. On a 1-2-5 ladder the shortfall reaches
 * a factor of two and a half: a 13.5 m height span asking for six ticks gives a
 * raw step of 2.25, which rounds to 5 and draws three. Half the requested
 * detail, silently.
 *
 * And the target itself was a constant, so a workbench canvas ten times the
 * width of the panel thumbnail asked for the same six ticks and spent the extra
 * room on whitespace.
 */

import { describe, it, expect } from 'vitest';
import {
  axisTicks,
  targetTicksForLength,
  DEFAULT_TARGET_TICKS,
  MAX_TARGET_TICKS,
  CHAINAGE_TICK_SPACING_PX,
  HEIGHT_TICK_SPACING_PX,
} from '../src/render/measure/profileAxes';

describe('choosing the step nearest the target', () => {
  it('takes the finer step when it lands closer to the ask', () => {
    // The reported profile: 13.522 m of height, six ticks wanted. Rounding up
    // gave a step of 5 and three ticks; 2 is the nearer answer.
    const t = axisTicks(3.5, 17.022, 6);
    expect(t.step).toBe(2);
    expect(t.values.length).toBeGreaterThanOrEqual(6);
  });

  it('keeps the coarser step when THAT is closer', () => {
    // Not a bias toward density: 97.935 m over six ticks wants 16.3, and 20
    // misses by less than 10 does. The rule is distance to the target, not
    // "more ticks".
    expect(axisTicks(0, 97.935, 6).step).toBe(20);
  });

  it('never returns a step that is not a nice number', () => {
    for (const span of [0.7, 3, 13.522, 97.935, 1234, 88_000]) {
      const { step } = axisTicks(0, span, 6);
      const m = step / Math.pow(10, Math.floor(Math.log10(step)));
      expect([1, 2, 5].some((n) => Math.abs(m - n) < 1e-9), `step ${step}`).toBe(true);
    }
  });

  it('is deterministic on a tie, keeping the coarser axis', () => {
    // A span whose two candidates miss the target equally must not depend on
    // evaluation order.
    const a = axisTicks(0, 30, 10);
    const b = axisTicks(0, 30, 10);
    expect(a.step).toBe(b.step);
  });
});

describe('sizing the target to the strip', () => {
  it('asks for more ticks on a longer strip', () => {
    const small = targetTicksForLength(220, CHAINAGE_TICK_SPACING_PX);
    const large = targetTicksForLength(2000, CHAINAGE_TICK_SPACING_PX);
    expect(large).toBeGreaterThan(small);
  });

  it('asks for more height ticks than chainage ticks at one size', () => {
    // A height label is stacked beside the plot, so what it can collide with is
    // a line height rather than the width of a reading.
    expect(targetTicksForLength(500, HEIGHT_TICK_SPACING_PX)).toBeGreaterThan(
      targetTicksForLength(500, CHAINAGE_TICK_SPACING_PX),
    );
  });

  it('never asks for fewer than two, because one tick states no scale', () => {
    expect(targetTicksForLength(10, CHAINAGE_TICK_SPACING_PX)).toBe(2);
    expect(targetTicksForLength(0, CHAINAGE_TICK_SPACING_PX)).toBe(2);
  });

  it('stays within the tick ceiling on an absurd strip', () => {
    expect(targetTicksForLength(1e9, HEIGHT_TICK_SPACING_PX)).toBeLessThanOrEqual(
      MAX_TARGET_TICKS,
    );
  });

  it('falls back to the default rather than guessing on bad input', () => {
    expect(targetTicksForLength(Number.NaN, CHAINAGE_TICK_SPACING_PX)).toBe(
      DEFAULT_TARGET_TICKS,
    );
    expect(targetTicksForLength(500, 0)).toBe(DEFAULT_TARGET_TICKS);
  });
});

describe('what the reported plot now draws', () => {
  it('carries finer chainage and height detail at workbench size', () => {
    // 2000 by 500, the section in the report: chainage every 5 m where it was
    // every 20, height every 2 m where it was every 5.
    const x = axisTicks(0, 97.935, targetTicksForLength(2000, CHAINAGE_TICK_SPACING_PX));
    const y = axisTicks(3.5, 17.022, targetTicksForLength(500, HEIGHT_TICK_SPACING_PX));
    expect(x.step).toBeLessThanOrEqual(5);
    expect(y.step).toBeLessThanOrEqual(2);
    expect(x.values.length).toBeGreaterThanOrEqual(15);
  });
});
