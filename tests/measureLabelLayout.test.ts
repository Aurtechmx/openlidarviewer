import { describe, it, expect } from 'vitest';
import { layoutLabels } from '../src/render/measure/labelLayout';
import type { LabelBox } from '../src/render/measure/labelLayout';

const box = (x: number, y: number): LabelBox => ({ x, y, width: 40, height: 16 });

describe('layoutLabels', () => {
  it('returns an empty array for no labels', () => {
    expect(layoutLabels([])).toEqual([]);
  });

  it('leaves a single label on its anchor', () => {
    const [r] = layoutLabels([box(100, 50)]);
    expect(r.x).toBe(100);
    expect(r.y).toBe(50);
    expect(r.displaced).toBe(false);
  });

  it('leaves vertically distant labels untouched', () => {
    const out = layoutLabels([box(100, 50), box(100, 200)]);
    expect(out[0].y).toBe(50);
    expect(out[1].y).toBe(200);
    expect(out.every((l) => !l.displaced)).toBe(true);
  });

  it('does not move horizontally separated labels at the same y', () => {
    const out = layoutLabels([box(0, 50), box(500, 50)]);
    expect(out[0].y).toBe(50);
    expect(out[1].y).toBe(50);
  });

  it('pushes an overlapping label clear and flags it displaced', () => {
    const out = layoutLabels([box(100, 50), box(100, 52)]);
    expect(out[0].y).toBe(50);
    expect(out[1].y).toBeGreaterThan(out[0].y + 16);
    expect(out[1].displaced).toBe(true);
  });

  it('preserves input order regardless of vertical sorting', () => {
    const out = layoutLabels([box(0, 100), box(0, 50)]);
    // Index 0 was the lower label (y=100), index 1 the upper (y=50).
    expect(out[0].y).toBe(100);
    expect(out[1].y).toBe(50);
  });
});
