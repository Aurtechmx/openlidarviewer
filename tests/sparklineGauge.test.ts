/**
 * sparklineGauge.test.ts
 *
 * Pure-geometry contract tests for the sparkline and gauge primitives.
 * Pins the path-string format and the auto-range behaviour so a
 * future tweak can't silently break the Inspector mini-dashboards.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSparkBars,
  buildSparkline,
} from '../src/ui/dashboards/sparkline';
import { buildGauge } from '../src/ui/dashboards/gauge';

describe('buildSparkline — line geometry', () => {
  it('returns an empty result for an empty sample set', () => {
    const r = buildSparkline({ samples: [], width: 100, height: 20 });
    expect(r.paths.length).toBe(0);
    expect(r.plotted).toBe(0);
  });

  it('emits one path per contiguous finite-sample run', () => {
    const r = buildSparkline({
      samples: [1, 2, Number.NaN, 4, 5],
      width: 100,
      height: 20,
    });
    expect(r.paths.length).toBe(2);
    expect(r.plotted).toBe(4);
  });

  it('returns a single path when every sample is finite', () => {
    const r = buildSparkline({
      samples: [0, 1, 2, 3],
      width: 100,
      height: 20,
    });
    expect(r.paths.length).toBe(1);
    expect(r.paths[0]).toMatch(/^M/);
    // 4 samples → 1 M + 3 L commands.
    expect(r.paths[0].match(/L/g)?.length).toBe(3);
  });

  it('auto-ranges y to the finite samples', () => {
    const r = buildSparkline({ samples: [3, 7, Number.NaN], width: 50, height: 20 });
    expect(r.yMin).toBe(3);
    expect(r.yMax).toBe(7);
  });

  it('honors explicit yMin / yMax', () => {
    const r = buildSparkline({
      samples: [3, 7],
      width: 50,
      height: 20,
      yMin: 0,
      yMax: 10,
    });
    expect(r.yMin).toBe(0);
    expect(r.yMax).toBe(10);
  });

  it('treatGapsAsZero plots NaN as a 0-sample instead of breaking', () => {
    const r = buildSparkline({
      samples: [1, Number.NaN, 3],
      width: 50,
      height: 20,
      treatGapsAsZero: true,
    });
    expect(r.paths.length).toBe(1);
    expect(r.plotted).toBe(3);
  });

  it('plots higher values higher on the canvas (Y inverted)', () => {
    // Compare y coordinates extracted from the path string for a two-sample input.
    const r = buildSparkline({ samples: [0, 100], width: 50, height: 20 });
    const matches = [...r.paths[0].matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)];
    const y0 = parseFloat(matches[0][2]);
    const y1 = parseFloat(matches[1][2]);
    expect(y1).toBeLessThan(y0);
  });
});

describe('buildSparkBars — bar geometry', () => {
  it('emits one rect per sample', () => {
    const r = buildSparkBars({ samples: [1, 2, 3, 4], width: 80, height: 20 });
    expect(r.bars.length).toBe(4);
  });

  it('bars are non-overlapping (gap between adjacent rects)', () => {
    const r = buildSparkBars({ samples: [5, 5, 5, 5], width: 100, height: 20 });
    for (let i = 1; i < r.bars.length; i++) {
      expect(r.bars[i].x).toBeGreaterThanOrEqual(r.bars[i - 1].x + r.bars[i - 1].width);
    }
  });

  it('a max-value bar reaches near the inner-height ceiling', () => {
    const r = buildSparkBars({ samples: [10], width: 50, height: 20, yMin: 0, yMax: 10 });
    expect(r.bars[0].height).toBeGreaterThan(15); // inner height = 16 with default PAD=1
  });

  it('a min-value bar has height 0', () => {
    const r = buildSparkBars({ samples: [0], width: 50, height: 20, yMin: 0, yMax: 10 });
    expect(r.bars[0].height).toBe(0);
  });
});

describe('buildGauge — semi-circular geometry', () => {
  it('a value at min produces an empty value path', () => {
    const g = buildGauge({ value: 0, min: 0, max: 100, width: 80, height: 50 });
    expect(g.valuePath).toBe('');
    expect(g.fraction).toBe(0);
    expect(g.trackPath).toMatch(/^M/);
  });

  it('a value at max produces a value arc near the track length', () => {
    const g = buildGauge({ value: 100, min: 0, max: 100, width: 80, height: 50 });
    expect(g.valuePath).toMatch(/^M/);
    expect(g.fraction).toBe(1);
  });

  it('fraction reflects the value position in the range', () => {
    const g = buildGauge({ value: 25, min: 0, max: 100, width: 80, height: 50 });
    expect(g.fraction).toBeCloseTo(0.25, 6);
  });

  it('clamps an above-max value to fraction 1', () => {
    const g = buildGauge({ value: 200, min: 0, max: 100, width: 80, height: 50 });
    expect(g.fraction).toBe(1);
  });

  it('clamps a below-min value to fraction 0', () => {
    const g = buildGauge({ value: -50, min: 0, max: 100, width: 80, height: 50 });
    expect(g.fraction).toBe(0);
  });

  it('degenerate range (min == max) yields fraction 0', () => {
    const g = buildGauge({ value: 5, min: 5, max: 5, width: 80, height: 50 });
    expect(g.fraction).toBe(0);
    expect(g.valuePath).toBe('');
  });

  it('NaN value yields fraction 0', () => {
    const g = buildGauge({
      value: Number.NaN,
      min: 0,
      max: 100,
      width: 80,
      height: 50,
    });
    expect(g.fraction).toBe(0);
  });

  it('centre point sits at the horizontal midpoint of the viewport', () => {
    const g = buildGauge({ value: 50, min: 0, max: 100, width: 100, height: 50 });
    expect(g.cx).toBe(50);
  });
});
