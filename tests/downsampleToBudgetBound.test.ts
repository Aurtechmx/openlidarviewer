import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  downsampleToBudget,
  downsampleToBudgetReport,
  MAX_DOWNSAMPLE_PASSES,
} from '../src/process/voxelDownsample';
import { PointCloud } from '../src/model/PointCloud';

/**
 * `downsampleToBudget` promises a cloud at or under the budget in a bounded
 * number of full-cloud passes. The cloud that broke the old loop is a
 * uniform random volume: the surface-based size estimate lands far below the
 * point spacing, every point sits alone in its voxel, and a proportional
 * step of a few percent per pass moves nothing. Twelve such passes ended
 * above budget. The fixtures here are that cloud at a size a test can afford,
 * plus the surface cloud the estimate was designed for.
 */

function randomVolume(n: number, seed: number, box: [number, number, number]): PointCloud {
  let s = seed >>> 0;
  const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0xffffffff);
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = rnd() * box[0];
    positions[i * 3 + 1] = rnd() * box[1];
    positions[i * 3 + 2] = rnd() * box[2];
  }
  return new PointCloud({ positions, origin: [0, 0, 0], sourceFormat: 'laz', name: 'volume' });
}

function surface(side: number): PointCloud {
  const positions = new Float32Array(side * side * 3);
  let k = 0;
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      positions[k++] = i * 0.5;
      positions[k++] = j * 0.5;
      positions[k++] = Math.sin(i / 9) * 0.2;
    }
  }
  return new PointCloud({ positions, origin: [0, 0, 0], sourceFormat: 'las', name: 'surface' });
}

describe('downsampleToBudget: bounded passes, never over budget', () => {
  it('a uniform random volume at 0.75 of its count lands under budget within a few passes', () => {
    // The 2 M-point, 1000 x 1000 x 50 m case at one tenth the count.
    const cloud = randomVolume(200_000, 3, [1000, 1000, 50]);
    const budget = 150_000;
    const r = downsampleToBudgetReport(cloud, budget);
    expect(r.cloud.pointCount).toBeLessThanOrEqual(budget);
    expect(r.cloud.pointCount).toBeGreaterThan(budget * 0.5);
    expect(r.passes).toBeLessThanOrEqual(8);
    expect(r.passes).toBeLessThanOrEqual(MAX_DOWNSAMPLE_PASSES);
  });

  it('holds the contract across budgets from a tenth to nine tenths of the count', () => {
    const cloud = randomVolume(60_000, 11, [300, 300, 20]);
    for (const fraction of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const budget = Math.floor(cloud.pointCount * fraction);
      const r = downsampleToBudgetReport(cloud, budget);
      expect(r.cloud.pointCount, `fraction ${fraction}`).toBeLessThanOrEqual(budget);
      expect(r.passes, `fraction ${fraction}`).toBeLessThanOrEqual(MAX_DOWNSAMPLE_PASSES);
    }
  });

  it('a surface cloud still converges in a pass or two and keeps most of the budget', () => {
    const cloud = surface(200);
    const r = downsampleToBudgetReport(cloud, 5000);
    expect(r.cloud.pointCount).toBeLessThanOrEqual(5000);
    expect(r.cloud.pointCount).toBeGreaterThan(3000);
    expect(r.passes).toBeLessThanOrEqual(4);
  });

  it('is deterministic and reports zero passes when the cloud already fits', () => {
    const cloud = randomVolume(20_000, 5, [100, 100, 10]);
    const a = downsampleToBudget(cloud, 7000);
    const b = downsampleToBudget(cloud, 7000);
    expect(a.positions).toEqual(b.positions);
    const fits = downsampleToBudgetReport(cloud, 50_000);
    expect(fits.cloud).toBe(cloud);
    expect(fits.passes).toBe(0);
  });
});

describe('the render budget is a device question, not a window-size one', () => {
  it('main.ts derives the budget and the load plan from the touch-first signal', () => {
    const main = readFileSync(resolve(__dirname, '..', 'src', 'main.ts'), 'utf8');
    const caps = main.slice(main.indexOf('const deviceCapsValue = deviceCaps({'));
    expect(caps.slice(0, caps.indexOf('});'))).toContain('isMobile: isTouchFirstDevice()');
    expect(main).toContain('isTouchFirst: isTouchFirstDevice,');
  });
});
