import { describe, it, expect } from 'vitest';
import { formatVolume, formatVolumeNumber } from '../src/render/measure/format';
import { stockpileResultHeadline } from '../src/render/measure/stockpileResult';
import { presentStockpileAreaGrid, stockpileAreaGridToastLine } from '../src/render/measure/stockpilePresenter';
import type { VolumeRecord } from '../src/render/measure/types';
import type { Vec3 } from '../src/render/navMath';

// Displayed volumes carry the same 5 significant figures as lengths and areas.
describe('volume display precision', () => {
  it('rounds large volumes to 5 significant figures', () => {
    expect(formatVolume(499909.6, 'metric')).toBe('499,910 m³');
    expect(formatVolume(1234.5678, 'metric')).toBe('1,234.6 m³');
    expect(formatVolume(12.3456, 'metric')).toBe('12.346 m³');
  });
  it('keeps small volumes non-zero', () => {
    expect(formatVolume(0.5, 'metric')).not.toMatch(/^0(\.0+)? /);
    expect(formatVolumeNumber(0.5)).toBe('0.5000');
    expect(formatVolumeNumber(-12.3456)).toBe('-12.346');
  });
  it('the lasso headline uses 5 significant figures', () => {
    const r = { fill: 499909.6, cut: 2544.3, net: 497365.3 } as unknown as VolumeRecord;
    const h = stockpileResultHeadline(r, 1);
    expect(h).toContain('fill 499,910 m³ · cut 2,544.3 m³ · net 497,370 m³');
    expect(h).not.toMatch(/\.\d0 m³/);
  });
  it('shows 5 significant figures on a small whole volume', () => {
    expect(formatVolume(3, 'metric')).toBe('3.0000 m³');
  });
  it('a display-sample preview says it can change between runs, once', () => {
    const RECT: Vec3[] = [[0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]];
    const pts: number[] = [];
    for (let x = 0.25; x < 20; x += 0.5) for (let y = 0.25; y < 10; y += 0.5) pts.push(x, y, 3);
    const line = stockpileAreaGridToastLine(presentStockpileAreaGrid(
      RECT, Float32Array.from(pts), { z: 0, uncertainty: 0.05 },
      { sourceComplete: true, sampled: true, streaming: false },
    ));
    expect(line).toMatch(/PREVIEW \(display sample\)/);
    expect(line.match(/can change between runs/g)?.length).toBe(1);
  });
});
