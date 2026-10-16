import { describe, expect, test } from 'vitest';
import { healthCheck } from '../src/analysis/modules/healthCheck';
import { PointCloud } from '../src/model/PointCloud';

/**
 * The stray-outlier check when more than half the points share one value on
 * an axis, so the median absolute deviation there is 0.
 */

const row = (pos: number[], name: string) => {
  const cloud = new PointCloud({ positions: new Float32Array(pos), origin: [0, 0, 0], sourceFormat: 'ply', name });
  const r = healthCheck.run(cloud).rows.find((x) => x.label === 'Stray Outliers');
  if (!r) throw new Error('Stray Outliers row missing');
  return r;
};

describe('Stray Outliers with MAD = 0 on an axis', () => {
  test('a flat floor beside a gentle ramp reports no strays', () => {
    // 600 points at z = 0 and 400 on a 1-40 cm ramp: MAD(z) is 0, and the old
    // ±1e-9 band flagged all 400 ramp points.
    const pos: number[] = [];
    for (let i = 0; i < 600; i++) pos.push(i % 30, Math.floor(i / 30), 0);
    for (let i = 0; i < 400; i++) pos.push(30 + (i % 20), Math.floor(i / 20), 0.01 * (1 + (i % 40)));
    const r = row(pos, 'ramp');
    expect(r.status).toBe('pass');
    expect(r.value).toBe('None');
  });

  test('a real stray is still flagged against the interquartile scale', () => {
    const pos: number[] = [];
    for (let i = 0; i < 600; i++) pos.push(i % 30, Math.floor(i / 30), 0);
    for (let i = 0; i < 400; i++) pos.push(30 + (i % 20), Math.floor(i / 20), 0.01 * (1 + (i % 40)));
    pos.push(10, 10, 50);
    const r = row(pos, 'ramp+stray');
    expect(r.status).toBe('warn');
    expect(r.value).toMatch(/^1 outlier/);
    expect(r.value).toContain('interquantile range');
  });

  test('no spread at all on an axis is reported as not assessable, not as strays', () => {
    const pos: number[] = [];
    for (let i = 0; i < 950; i++) pos.push(i % 30, Math.floor(i / 30), 0);
    for (let i = 0; i < 50; i++) pos.push(i, 40, 0.02 * i);
    const r = row(pos, 'flat');
    expect(r.status).toBe('info');
    expect(r.value).toMatch(/^Not assessable/);
    expect(r.value).toContain('Z');
  });
});
