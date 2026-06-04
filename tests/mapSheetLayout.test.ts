/**
 * mapSheetLayout.test.ts — pure cartographic layout maths for the map sheet.
 */

import { describe, it, expect } from 'vitest';
import {
  fitTransform,
  niceStep,
  niceRoundDown,
  gridTicks,
  scaleBar,
  mapScaleRatio,
} from '../src/terrain/contour/mapSheetLayout';

describe('fitTransform', () => {
  it('fits a wider-than-frame bbox by width and centres vertically', () => {
    const t = fitTransform(
      { minX: 0, minY: 0, maxX: 200, maxY: 100 },
      { x: 10, y: 20, w: 400, h: 400 },
    );
    expect(t.scale).toBeCloseTo(2, 6); // 400/200 (width-bound)
    expect(t.drawnW).toBeCloseTo(400, 6);
    expect(t.drawnH).toBeCloseTo(200, 6);
    // corners map inside the frame; bottom-left at the centred origin
    expect(t.ox).toBeCloseTo(10, 6);
    expect(t.oy).toBeCloseTo(20 + (400 - 200) / 2, 6);
  });

  it('maps world points into the frame', () => {
    const t = fitTransform({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, { x: 0, y: 0, w: 200, h: 200 });
    const px = t.ox + (50 - 0) * t.scale;
    const py = t.oy + (50 - 0) * t.scale;
    expect(px).toBeCloseTo(100, 6);
    expect(py).toBeCloseTo(100, 6);
  });
});

describe('nice numbers', () => {
  it('niceStep keeps roughly the target count', () => {
    expect(niceStep(1000, 5)).toBe(200);
    expect(niceStep(950, 10)).toBe(100);
    expect(niceStep(3, 5)).toBeCloseTo(1, 6);
    expect(niceStep(0.9, 3)).toBeCloseTo(0.5, 6);
  });
  it('niceRoundDown is the largest 1/2/5 decade ≤ x', () => {
    expect(niceRoundDown(740)).toBe(500);
    expect(niceRoundDown(1900)).toBe(1000);
    expect(niceRoundDown(2.4)).toBe(2);
    expect(niceRoundDown(0)).toBe(0);
  });
});

describe('gridTicks', () => {
  it('emits round multiples within range', () => {
    expect(gridTicks(585120, 588040, 1000)).toEqual([586000, 587000, 588000]);
    expect(gridTicks(0, 10, 2.5)).toEqual([0, 2.5, 5, 7.5, 10]);
  });
});

describe('scaleBar + mapScaleRatio', () => {
  it('picks a round total that fits and splits into segments', () => {
    // 0.5 pt per metre, 200 pt max → ≤400 m → round down to 200 m.
    const b = scaleBar(0.5, 200);
    expect(b.totalGround).toBe(200);
    expect(b.segGround).toBe(50);
    expect(b.barPt).toBeCloseTo(100, 6);
  });
  it('expresses scale as a 1:N ratio', () => {
    // 1 metre of ground drawn as exactly 1 page point.
    const n = mapScaleRatio(1);
    // 1 pt = 0.0254/72 m of paper → N = 72/0.0254 ≈ 2835
    expect(Math.round(n)).toBe(2835);
  });
});
