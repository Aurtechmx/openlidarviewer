/**
 * measurementTrust.test.ts — the per-measurement honesty grade. The brand made
 * tangible: a number is only as trustworthy as the points under its endpoints.
 */

import { describe, it, expect } from 'vitest';
import { gradeMeasurement, summarizeMeasurementTrust } from '../src/render/measure/measurementTrust';

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
