/**
 * measurementTrust.test.ts — the per-measurement honesty grade. The brand made
 * tangible: a number is only as trustworthy as the points under its endpoints.
 */

import { describe, it, expect } from 'vitest';
import { gradeMeasurement, summarizeMeasurementTrust } from '../src/render/measure/measurementTrust';
import { GEOGRAPHIC_CRS_MEASURE_NOTICE } from '../src/render/measure/format';

const strong = { snappedToPoint: true, pointsWithinRadius: 50 };
const weakSparse = { snappedToPoint: true, pointsWithinRadius: 6 };
const voidPt = { snappedToPoint: false, pointsWithinRadius: 0 };

describe('gradeMeasurement', () => {
  it('green when every endpoint snapped to a dense neighbourhood (CRS known)', () => {
    const t = gradeMeasurement({ vertices: [strong, strong], crsKnown: true });
    expect(t.grade).toBe('green');
    expect(t.presentable).toBe(true);
    expect(t.caption.toLowerCase()).toContain('verified');
  });

  it('red and not presentable when an endpoint sits in a void', () => {
    const t = gradeMeasurement({ vertices: [strong, voidPt], crsKnown: true });
    expect(t.grade).toBe('red');
    expect(t.presentable).toBe(false);
    expect(t.reasons.join(' ').toLowerCase()).toContain('empty space');
  });

  it('worst endpoint drives the grade', () => {
    expect(gradeMeasurement({ vertices: [strong, weakSparse], crsKnown: true }).grade).toBe('yellow');
    expect(gradeMeasurement({ vertices: [strong, strong, voidPt], crsKnown: true }).grade).toBe('red');
  });

  it('caps a green at yellow when the CRS is unknown (scale unverified)', () => {
    const t = gradeMeasurement({ vertices: [strong, strong], crsKnown: false });
    expect(t.grade).toBe('yellow');
    expect(t.reasons.join(' ')).toMatch(/CRS/);
    expect(t.presentable).toBe(true); // still presentable, just caveated
  });

  it('caps a green at yellow for a resident-only (streaming subset) measurement', () => {
    const t = gradeMeasurement({ vertices: [strong, strong], crsKnown: true, residentOnly: true });
    expect(t.grade).toBe('yellow');
    expect(t.reasons.join(' ').toLowerCase()).toContain('subset');
  });

  it('a void endpoint stays red even with an unknown CRS (does not double-downgrade past red)', () => {
    const t = gradeMeasurement({ vertices: [voidPt, voidPt], crsKnown: false });
    expect(t.grade).toBe('red');
    expect(t.presentable).toBe(false);
  });

  it('geographic CRS is a REFUSAL: red + not presentable even with perfect support', () => {
    // Degrees are not distances — the figure mixes degree X/Y with linear Z,
    // so it is wrong, not merely uncertified. Stronger than the yellow
    // "unknown CRS" cap: perfect endpoint support cannot rescue it.
    const t = gradeMeasurement({ vertices: [strong, strong], crsKnown: true, geographicCrs: true });
    expect(t.grade).toBe('red');
    expect(t.presentable).toBe(false);
    expect(t.caption.toLowerCase()).toContain('degrees');
    // The reason is the ONE shared copy — hint bar, panel caveat and grade
    // must never fork their wording.
    expect(t.reasons).toContain(GEOGRAPHIC_CRS_MEASURE_NOTICE);
  });

  it('geographic refusal still reports endpoint support honestly (reasons stack)', () => {
    const t = gradeMeasurement({ vertices: [strong, weakSparse], crsKnown: true, geographicCrs: true });
    expect(t.grade).toBe('red');
    // Both signals surface: the sparse-support reason AND the geographic one.
    expect(t.reasons.join(' ').toLowerCase()).toContain('sparse');
    expect(t.reasons).toContain(GEOGRAPHIC_CRS_MEASURE_NOTICE);
  });

  it('geographicCrs false / omitted changes nothing (projected behaviour intact)', () => {
    const a = gradeMeasurement({ vertices: [strong, strong], crsKnown: true });
    const b = gradeMeasurement({ vertices: [strong, strong], crsKnown: true, geographicCrs: false });
    expect(b).toEqual(a);
  });

  it('refuses an empty measurement', () => {
    const t = gradeMeasurement({ vertices: [], crsKnown: true });
    expect(t.grade).toBe('red');
    expect(t.presentable).toBe(false);
  });

  it('every grade ships at least one reason (show-me-why is never empty)', () => {
    for (const v of [[strong, strong], [strong, weakSparse], [strong, voidPt]]) {
      expect(gradeMeasurement({ vertices: v, crsKnown: true }).reasons.length).toBeGreaterThan(0);
    }
  });
});

describe('summarizeMeasurementTrust (Evidence Capsule roll-up)', () => {
  const g = gradeMeasurement({ vertices: [strong, strong], crsKnown: true }); // green
  const y = gradeMeasurement({ vertices: [strong, weakSparse], crsKnown: true }); // yellow
  const r = gradeMeasurement({ vertices: [strong, voidPt], crsKnown: true }); // red

  it('counts grades and writes a one-line breakdown', () => {
    const s = summarizeMeasurementTrust([g, y, r, undefined]);
    expect(s).toMatchObject({ total: 3, green: 1, yellow: 1, red: 1 });
    expect(s.line).toBe('3 measurements — 1 verified, 1 caution, 1 unverified');
  });

  it('ignores ungraded (undefined) entries and handles an all-empty input', () => {
    expect(summarizeMeasurementTrust([undefined, undefined]).total).toBe(0);
    expect(summarizeMeasurementTrust([]).line).toBe('No graded measurements');
  });

  it('singular phrasing for one measurement, omits empty buckets', () => {
    const s = summarizeMeasurementTrust([g]);
    expect(s.line).toBe('1 measurement — 1 verified');
  });
});
