/**
 * measureVerticalUnit.test.ts
 *
 * Compound-CRS honesty: a scan whose horizontal unit is metres (UTM) but whose
 * heights are in US survey feet (e.g. NAVD88) carries TWO linear factors. The
 * measurement stack must scale a vertical readout by the VERTICAL factor, not
 * the horizontal one, and must refuse the 3D quantities a single factor cannot
 * repair. These pin the pure seams the controller delegates to.
 */

import { describe, it, expect } from 'vitest';
import {
  formatLengthRender,
  formatVolume,
  VERTICAL_UNIT_MISMATCH_MEASURE_NOTICE,
  VERTICAL_MISMATCH_KINDS,
} from '../src/render/measure/format';
import { gradeMeasurement } from '../src/render/measure/measurementTrust';

const strong = { snappedToPoint: true, pointsWithinRadius: 40 } as const;

describe('measurement vertical unit (compound CRS)', () => {
  it('a height reads through the VERTICAL factor, not the horizontal one', () => {
    // Δz of 10 render units on a foot-height CRS is 10 ft = 3.048 m.
    // Adaptive precision (5 sig figs) prints "3.0480 m", not the old "3.05 m".
    expect(formatLengthRender(10, 0.3048, 'metric')).toBe('3.0480 m');
    // The pre-fix path multiplied by the horizontal factor (1) — 3.28× too large.
    expect(formatLengthRender(10, 1, 'metric')).toBe('10.000 m');
  });

  it('box volume scales linear²·vertical on a mixed-unit CRS', () => {
    // 10×10×10 render units, linear 1, vertical 0.3048 → 10·10·3.048 = 304.8 m³.
    expect(formatVolume(1000 * 1 * 1 * 0.3048, 'metric')).toBe('304.80 m³');
  });

  it('refuses the trust grade when the vertical unit differs from horizontal', () => {
    const t = gradeMeasurement({
      vertices: [strong, strong],
      crsKnown: true,
      verticalUnitMismatch: true,
    });
    expect(t.grade).toBe('red');
    expect(t.presentable).toBe(false);
    expect(t.reasons).toContain(VERTICAL_UNIT_MISMATCH_MEASURE_NOTICE);
  });

  it('names as unreliable exactly the kinds the trust grade refuses', () => {
    const text = VERTICAL_UNIT_MISMATCH_MEASURE_NOTICE;
    const [correct, unreliable] = text.split('converted correctly.');
    const unreliableKinds: Record<string, string> = {
      distance: 'distance', polyline: 'polyline', 'plane area': 'area',
      slope: 'slope', angle: 'angle', profile: 'profile',
    };
    const named = Object.keys(unreliableKinds).filter((w) => unreliable.split('NOT reliable')[0].toLowerCase().includes(w.toLowerCase()));
    expect(new Set(named.map((w) => unreliableKinds[w]))).toEqual(new Set(VERTICAL_MISMATCH_KINDS));
    for (const [word, kind] of [['Heights', 'height'], ['box sizes', 'box'], ['volumes', 'volume']] as const) {
      expect(correct).toContain(word);
      expect(VERTICAL_MISMATCH_KINDS.has(kind)).toBe(false);
    }
    expect(correct).toMatch(/the run of a line and the plan area of a ring/);
    expect(text).toMatch(/reproject the scan to one unit/);
    // The headline is refused while the breakdown beneath a distance is read:
    // the notice names the breakdown figures that are computed from converted values.
    expect(text).toMatch(/Run, Rise, Slant and Grade under a distance are computed from the converted run and rise/);
  });

  it('equal vertical/horizontal unit leaves the grade untouched (common case)', () => {
    const t = gradeMeasurement({
      vertices: [strong, strong],
      crsKnown: true,
      verticalUnitMismatch: false,
    });
    expect(t.grade).toBe('green');
    expect(t.presentable).toBe(true);
  });
});
