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

describe('layoutLabels with anchors far off screen', () => {
  // A crafted camera pose or vertex can project to a finite coordinate of any
  // size. The cell loops used to step a counter by one across the box's span,
  // which never ends once the coordinate passes 2^53 / the cell size.
  const FAR = [1e18, -1e18, 1e15, -1e15, 6e17, Number.MAX_VALUE / 4];

  for (const v of FAR) {
    it(`finishes at once for x = ${v}`, () => {
      const t0 = performance.now();
      const out = layoutLabels([box(v, 50), box(100, 50), box(100, 52)]);
      expect(performance.now() - t0).toBeLessThan(500);
      // The far label keeps its anchor and does not push the visible ones.
      expect(out[0]).toEqual({ x: v, y: 50, displaced: false });
      expect(out[1].y).toBe(50);
      expect(out[2].y).toBeGreaterThan(66);
    });

    it(`finishes at once for y = ${v}`, () => {
      const t0 = performance.now();
      const out = layoutLabels([box(100, v), box(100, 50), box(100, 52)]);
      expect(performance.now() - t0).toBeLessThan(500);
      expect(out[0]).toEqual({ x: 100, y: v, displaced: false });
      expect(out[1].y).toBe(50);
    });
  }

  it('a box whose size is absurd is not laid out either', () => {
    const t0 = performance.now();
    const out = layoutLabels([{ x: 0, y: 0, width: 1e18, height: 16 }, { x: 0, y: 0, width: 40, height: 1e18 }, box(0, 0)]);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out[2]).toEqual({ x: 0, y: 0, displaced: false });
  });

  it('many far labels cost nothing and leave the near ones in their normal layout', () => {
    const boxes: LabelBox[] = [];
    for (let i = 0; i < 400; i++) boxes.push(box(i % 2 ? 1e18 : -1e18, i));
    boxes.push(box(10, 10), box(10, 12));
    const t0 = performance.now();
    const out = layoutLabels(boxes);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out[400].y).toBe(10);
    expect(out[401].y).toBeGreaterThan(26);
  });

  it('a label at the edge of the limit is still laid out and collides normally', () => {
    const out = layoutLabels([box(1e6, 50), box(1e6, 52)]);
    expect(out[1].y).toBeGreaterThan(out[0].y + 16);
  });
});
