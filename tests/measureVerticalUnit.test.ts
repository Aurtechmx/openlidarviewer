/**
 * measureVerticalUnit.test.ts
 *
 * Compound-CRS honesty: a scan whose horizontal unit is metres (UTM) but whose
 * heights are in US survey feet (e.g. NAVD88) carries TWO linear factors. The
 * measurement stack must scale a vertical readout by the VERTICAL factor, not
 * the horizontal one. These pin the pure seams the controller delegates to.
 */

import { describe, it, expect } from 'vitest';
import { formatLengthRender, formatVolume } from '../src/render/measure/format';
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

  it('does not refuse the trust grade on a compound CRS', () => {
    // Every kind is now computed in the per-axis metre frame, so the compound
    // CRS is no longer a refusal: the grade is the ordinary one.
    const t = gradeMeasurement({ vertices: [strong, strong], crsKnown: true });
    expect(t.grade).toBe('green');
    expect(t.presentable).toBe(true);
  });
});
