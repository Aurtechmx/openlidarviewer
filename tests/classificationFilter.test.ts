/**
 * classificationFilter.test.ts — drop classified non-ground returns before
 * the ground filter, keeping ground/unclassified/water and never mutating input.
 */

import { describe, it, expect } from 'vitest';
import {
  excludeNonGroundClasses,
  NON_GROUND_CLASSES,
} from '../src/terrain/ground/classificationFilter';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const p = (x: number, z: number): TerrainPoint => ({ x, y: 0, z });

describe('excludeNonGroundClasses', () => {
  it('drops vegetation/building/noise, keeps ground/unclassified/water', () => {
    const pts = [p(0, 1), p(1, 9), p(2, 1), p(3, 5), p(4, 1), p(5, 1)];
    // classes:      2 grnd  5 veg    6 bldg   1 uncl   9 water  7 noise
    const cls = [2, 5, 6, 1, 9, 7];
    const r = excludeNonGroundClasses(pts, cls);
    expect(r.excludedCount).toBe(3); // 5, 6, 7
    expect(r.points.map((q) => q.x)).toEqual([0, 3, 4]); // ground, unclassified, water
    expect(r.byClass).toEqual({ 5: 1, 6: 1, 7: 1 });
  });

  it('keeps everything when classification is absent or misaligned', () => {
    const pts = [p(0, 1), p(1, 2)];
    expect(excludeNonGroundClasses(pts, null).excludedCount).toBe(0);
    expect(excludeNonGroundClasses(pts, [5]).points.length).toBe(2); // wrong length → keep all
    expect(excludeNonGroundClasses(pts, [5, 6], []).excludedCount).toBe(0); // empty exclude set
  });

  it('treats the 255 no-class sentinel as keep', () => {
    const pts = [p(0, 1), p(1, 1)];
    const r = excludeNonGroundClasses(pts, Uint8Array.from([255, 5]));
    expect(r.points.map((q) => q.x)).toEqual([0]); // 255 kept, 5 dropped
  });

  it('does not mutate the input array', () => {
    const pts = [p(0, 1), p(1, 1)];
    excludeNonGroundClasses(pts, [5, 2]);
    expect(pts.length).toBe(2);
  });

  it('default class set is vegetation + building + noise', () => {
    expect([...NON_GROUND_CLASSES].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 18]);
  });
});
