/**
 * profileViewTransform.test.ts
 *
 * The section viewport transform, its inverse, and vertical exaggeration.
 *
 * Exaggeration is asserted in physical terms: the pixels a metre occupies
 * vertically over the pixels a metre occupies horizontally. Asserting the
 * ratio of the two axis scales instead would pass even when the axes are in
 * different units, which is the case the ratio exists to get right.
 */
import { describe, it, expect } from 'vitest';
import {
  fitProfileView,
  profileDataToScreen,
  profileScreenToData,
  panProfileView,
  zoomProfileViewAt,
  viewExaggeration,
  canStateExaggeration,
  profileVisibleBounds,
  toDevicePixels,
  MIN_DATA_SPAN,
  type ProfileViewport,
  type ProfileDataBounds,
  type ProfileUnitContext,
  type ProfileView,
} from '../src/render/measure/profileViewTransform';

const VP: ProfileViewport = { width: 800, height: 300, devicePixelRatio: 2 };
const BOUNDS: ProfileDataBounds = {
  minChainage: 0,
  maxChainage: 200,
  minHeight: 120,
  maxHeight: 150,
};
const METRES: ProfileUnitContext = { horizontalToMetres: 1, verticalToMetres: 1 };
const FEET_H: ProfileUnitContext = { horizontalToMetres: 0.3048, verticalToMetres: 1 };
const UNKNOWN_V: ProfileUnitContext = { horizontalToMetres: 1, verticalToMetres: null };

const s = new Float64Array(2);
const d = new Float64Array(2);

/** Pixels a physical metre occupies on each axis. */
function pxPerMetre(view: ProfileView, u: ProfileUnitContext): [number, number] {
  return [view.pxPerChainage / u.horizontalToMetres!, view.pxPerHeight / u.verticalToMetres!];
}

describe('fit', () => {
  it('puts the data extent in the viewport and centres it', () => {
    const v = fitProfileView(BOUNDS, VP, { kind: 'fit' }, METRES)!;
    expect(v.centreChainage).toBe(100);
    expect(v.centreHeight).toBe(135);
    profileDataToScreen(v, VP, 0, 150, s);
    expect(s[0]).toBeCloseTo(0, 9);
    expect(s[1]).toBeCloseTo(0, 9);
    profileDataToScreen(v, VP, 200, 120, s);
    expect(s[0]).toBeCloseTo(800, 9);
    expect(s[1]).toBeCloseTo(300, 9);
  });

  it('scales the axes independently and claims no ratio', () => {
    const v = fitProfileView(BOUNDS, VP, { kind: 'fit' }, METRES)!;
    expect(v.pxPerChainage).toBeCloseTo(4, 9);
    expect(v.pxPerHeight).toBeCloseTo(10, 9);
  });
});

describe('round trip', () => {
  const v = fitProfileView(BOUNDS, VP, { kind: 'fit' }, METRES)!;
  it('returns the same data point through screen space', () => {
    for (let i = 0; i < 500; i++) {
      const g = (i * 0.6180339887498949) % 1;
      const c = BOUNDS.minChainage + g * 200;
      const h = BOUNDS.minHeight + ((i * 7 * 0.6180339887498949) % 1) * 30;
      profileDataToScreen(v, VP, c, h, s);
      profileScreenToData(v, VP, s[0]!, s[1]!, d);
      expect(d[0]).toBeCloseTo(c, 9);
      expect(d[1]).toBeCloseTo(h, 9);
    }
  });

  it('maps height upward on screen', () => {
    profileDataToScreen(v, VP, 100, 140, s);
    const high = s[1]!;
    profileDataToScreen(v, VP, 100, 130, s);
    expect(s[1]!).toBeGreaterThan(high);
  });
});

describe('pan and zoom', () => {
  const base = fitProfileView(BOUNDS, VP, { kind: 'fit' }, METRES)!;

  it('pans by exactly the screen delta', () => {
    const p = panProfileView(base, 40, -25);
    profileDataToScreen(base, VP, 100, 135, s);
    const before = [s[0]!, s[1]!];
    profileDataToScreen(p, VP, 100, 135, s);
    expect(s[0]! - before[0]!).toBeCloseTo(40, 9);
    expect(s[1]! - before[1]!).toBeCloseTo(-25, 9);
  });

  it('holds the data under the cursor fixed while zooming', () => {
    for (const [ax, ay] of [
      [0, 0],
      [800, 300],
      [137, 42],
      [400, 150],
    ]) {
      profileScreenToData(base, VP, ax!, ay!, d);
      const anchored = [d[0]!, d[1]!];
      let v = base;
      for (let i = 0; i < 6; i++) v = zoomProfileViewAt(v, VP, ax!, ay!, 1.2);
      profileScreenToData(v, VP, ax!, ay!, d);
      expect(d[0]).toBeCloseTo(anchored[0]!, 6);
      expect(d[1]).toBeCloseTo(anchored[1]!, 6);
    }
  });

  it('zooming out then in returns the original scale', () => {
    let v = zoomProfileViewAt(base, VP, 300, 100, 1.2);
    v = zoomProfileViewAt(v, VP, 300, 100, 1 / 1.2);
    expect(v.pxPerChainage).toBeCloseTo(base.pxPerChainage, 9);
    expect(v.pxPerHeight).toBeCloseTo(base.pxPerHeight, 9);
    expect(v.centreChainage).toBeCloseTo(base.centreChainage, 6);
  });

  it('ignores a non-finite or non-positive zoom factor', () => {
    expect(zoomProfileViewAt(base, VP, 100, 100, Number.NaN)).toBe(base);
    expect(zoomProfileViewAt(base, VP, 100, 100, 0)).toBe(base);
    expect(zoomProfileViewAt(base, VP, 100, 100, -2)).toBe(base);
  });
});

describe('true vertical exaggeration', () => {
  for (const ratio of [1, 2, 5, 10]) {
    it(`VE ${ratio}x gives a metre ${ratio}x the pixels vertically`, () => {
      const v = fitProfileView(BOUNDS, VP, { kind: 've', ratio }, METRES)!;
      const [mx, my] = pxPerMetre(v, METRES);
      expect(my / mx).toBeCloseTo(ratio, 9);
      expect(viewExaggeration(v, METRES)).toBeCloseTo(ratio, 9);
    });

    it(`VE ${ratio}x holds when the axes are in different units`, () => {
      // Chainage in feet, height in metres. Comparing the two axis scales
      // directly would be wrong by 1/0.3048 here.
      const v = fitProfileView(BOUNDS, VP, { kind: 've', ratio }, FEET_H)!;
      const [mx, my] = pxPerMetre(v, FEET_H);
      expect(my / mx).toBeCloseTo(ratio, 9);
      expect(viewExaggeration(v, FEET_H)).toBeCloseTo(ratio, 9);
      // The raw axis-scale ratio is a different number, so the test above is
      // not measuring the same thing twice.
      expect(v.pxPerHeight / v.pxPerChainage).not.toBeCloseTo(ratio, 3);
    });
  }

  it('contains the whole extent rather than cropping to hold the ratio', () => {
    for (const ratio of [1, 2, 5, 10]) {
      const v = fitProfileView(BOUNDS, VP, { kind: 've', ratio }, METRES)!;
      const vis = profileVisibleBounds(v, VP);
      expect(vis.minChainage).toBeLessThanOrEqual(BOUNDS.minChainage + 1e-9);
      expect(vis.maxChainage).toBeGreaterThanOrEqual(BOUNDS.maxChainage - 1e-9);
      expect(vis.minHeight).toBeLessThanOrEqual(BOUNDS.minHeight + 1e-9);
      expect(vis.maxHeight).toBeGreaterThanOrEqual(BOUNDS.maxHeight - 1e-9);
    }
  });

  it('survives a zoom', () => {
    let v = fitProfileView(BOUNDS, VP, { kind: 've', ratio: 5 }, METRES)!;
    for (let i = 0; i < 5; i++) v = zoomProfileViewAt(v, VP, 250, 90, 1.2);
    expect(viewExaggeration(v, METRES)).toBeCloseTo(5, 9);
  });

  it('refuses a ratio when a unit scale is unknown', () => {
    expect(canStateExaggeration(UNKNOWN_V)).toBe(false);
    expect(fitProfileView(BOUNDS, VP, { kind: 've', ratio: 2 }, UNKNOWN_V)).toBeNull();
    const fit = fitProfileView(BOUNDS, VP, { kind: 'fit' }, UNKNOWN_V)!;
    expect(viewExaggeration(fit, UNKNOWN_V)).toBeNull();
  });

  it('refuses a ratio that is not a positive number', () => {
    for (const r of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fitProfileView(BOUNDS, VP, { kind: 've', ratio: r }, METRES)).toBeNull();
    }
  });

  it('refuses a unit scale that is zero or negative', () => {
    expect(canStateExaggeration({ horizontalToMetres: 0, verticalToMetres: 1 })).toBe(false);
    expect(canStateExaggeration({ horizontalToMetres: 1, verticalToMetres: -1 })).toBe(false);
  });
});

describe('degenerate and hostile input', () => {
  it('handles a flat section without dividing by zero', () => {
    const flat: ProfileDataBounds = {
      minChainage: 0,
      maxChainage: 200,
      minHeight: 137.5,
      maxHeight: 137.5,
    };
    const v = fitProfileView(flat, VP, { kind: 'fit' }, METRES)!;
    expect(Number.isFinite(v.pxPerHeight)).toBe(true);
    expect(v.pxPerHeight).toBeGreaterThan(0);
    expect(v.centreHeight).toBe(137.5);
    profileDataToScreen(v, VP, 100, 137.5, s);
    expect(Number.isFinite(s[0]!)).toBe(true);
    expect(Number.isFinite(s[1]!)).toBe(true);
  });

  it('handles a single-point section on both axes', () => {
    const pt: ProfileDataBounds = {
      minChainage: 42,
      maxChainage: 42,
      minHeight: 7,
      maxHeight: 7,
    };
    const v = fitProfileView(pt, VP, { kind: 'fit' }, METRES)!;
    expect(Number.isFinite(v.pxPerChainage)).toBe(true);
    expect(Number.isFinite(v.pxPerHeight)).toBe(true);
    expect(v.pxPerChainage).toBeGreaterThan(0);
  });

  it('keeps a huge chainage span finite', () => {
    const huge: ProfileDataBounds = {
      minChainage: -1e15,
      maxChainage: 1e15,
      minHeight: 0,
      maxHeight: 1e12,
    };
    const v = fitProfileView(huge, VP, { kind: 'fit' }, METRES)!;
    expect(Number.isFinite(v.pxPerChainage)).toBe(true);
    expect(v.pxPerChainage).toBeGreaterThan(0);
    profileDataToScreen(v, VP, 0, 0, s);
    expect(Number.isFinite(s[0]!)).toBe(true);
    expect(Number.isFinite(s[1]!)).toBe(true);
  });

  it('produces a finite view from non-finite bounds', () => {
    const bad: ProfileDataBounds = {
      minChainage: Number.NaN,
      maxChainage: Number.POSITIVE_INFINITY,
      minHeight: Number.NEGATIVE_INFINITY,
      maxHeight: Number.NaN,
    };
    const v = fitProfileView(bad, VP, { kind: 'fit' }, METRES)!;
    for (const n of [v.centreChainage, v.centreHeight, v.pxPerChainage, v.pxPerHeight]) {
      expect(Number.isFinite(n)).toBe(true);
    }
    expect(v.pxPerChainage).toBeGreaterThan(0);
  });

  it('produces a finite view from a zero-sized viewport', () => {
    const v = fitProfileView(BOUNDS, { width: 0, height: 0, devicePixelRatio: 1 }, { kind: 'fit' }, METRES)!;
    expect(v.pxPerChainage).toBeGreaterThan(0);
    expect(Number.isFinite(v.pxPerHeight)).toBe(true);
  });

  it('ignores a non-finite pan delta', () => {
    const base = fitProfileView(BOUNDS, VP, { kind: 'fit' }, METRES)!;
    const p = panProfileView(base, Number.NaN, Number.POSITIVE_INFINITY);
    expect(p.centreChainage).toBe(base.centreChainage);
    expect(p.centreHeight).toBe(base.centreHeight);
  });

  it('gives a degenerate axis the documented minimum span', () => {
    const flat: ProfileDataBounds = {
      minChainage: 5,
      maxChainage: 5,
      minHeight: 0,
      maxHeight: 10,
    };
    const v = fitProfileView(flat, VP, { kind: 'fit' }, METRES)!;
    expect(v.pxPerChainage).toBeCloseTo(VP.width / MIN_DATA_SPAN, 0);
  });
});

describe('device pixels', () => {
  it('scales by the backing ratio', () => {
    expect(toDevicePixels(VP, 10)).toBe(20);
  });
  it('falls back to 1 for a bad ratio', () => {
    expect(toDevicePixels({ width: 10, height: 10, devicePixelRatio: 0 }, 10)).toBe(10);
    expect(toDevicePixels({ width: 10, height: 10, devicePixelRatio: Number.NaN }, 10)).toBe(10);
  });
});

describe('resize', () => {
  it('keeps the centre and rescales the fit', () => {
    const small = fitProfileView(BOUNDS, VP, { kind: 'fit' }, METRES)!;
    const wide = fitProfileView(
      BOUNDS,
      { width: 1600, height: 300, devicePixelRatio: 2 },
      { kind: 'fit' },
      METRES,
    )!;
    expect(wide.centreChainage).toBe(small.centreChainage);
    expect(wide.pxPerChainage).toBeCloseTo(small.pxPerChainage * 2, 9);
    expect(wide.pxPerHeight).toBeCloseTo(small.pxPerHeight, 9);
  });
});
