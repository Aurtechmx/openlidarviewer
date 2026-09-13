/**
 * contourStudioLaunchState.test.ts
 *
 * Pins the pure Contour Studio launcher state machine (spec §4): visibility,
 * disabled reasons, exploratory capping, and the available happy path.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateContourStudioLaunchState,
  MAX_UNSUPPORTED_FRACTION_FOR_DELIVERABLE,
  type ContourStudioPrerequisites,
} from '../src/terrain/contourStudio/contourStudioLaunchState';

/** A fully-ready scan: every prerequisite satisfied. */
function ready(): ContourStudioPrerequisites {
  return {
    scanLoaded: true,
    analysisComplete: true,
    streaming: false,
    terrainSurfaceAvailable: true,
    groundSourceAvailable: true,
    intervalRecommended: true,
    verticalUnitsKnown: true,
    crsProjected: true,
    unsupportedFraction: 0.03,
    supportSufficient: true,
  };
}

describe('evaluateContourStudioLaunchState', () => {
  it('hides the launcher before analysis (not-analyzed)', () => {
    const s = evaluateContourStudioLaunchState({ ...ready(), scanLoaded: true, analysisComplete: false });
    expect(s.status).toBe('not-analyzed');
    expect(s.visible).toBe(false);
  });

  it('hides the launcher when no scan is loaded', () => {
    const s = evaluateContourStudioLaunchState({ ...ready(), scanLoaded: false });
    expect(s.status).toBe('not-analyzed');
    expect(s.visible).toBe(false);
  });

  it('offers a full deliverable when every prerequisite is met', () => {
    const s = evaluateContourStudioLaunchState(ready());
    expect(s.status).toBe('available');
    if (s.status === 'available') {
      expect(s.actionEnabled).toBe(true);
      expect(s.actionLabel).toBe('Create Contour Deliverable');
    }
  });

  it('blocks (unavailable) when no terrain surface exists', () => {
    const s = evaluateContourStudioLaunchState({ ...ready(), terrainSurfaceAvailable: false });
    expect(s.status).toBe('unavailable');
    if (s.status === 'unavailable') {
      expect(s.actionEnabled).toBe(false);
      expect(s.reasons.some((r) => /no terrain surface/i.test(r))).toBe(true);
    }
  });

  it('blocks when there is no usable ground source', () => {
    const s = evaluateContourStudioLaunchState({ ...ready(), groundSourceAvailable: false });
    expect(s.status).toBe('unavailable');
    if (s.status === 'unavailable') {
      expect(s.reasons.some((r) => /no usable ground/i.test(r))).toBe(true);
    }
  });

  it('blocks when unsupported fraction exceeds the deliverable ceiling', () => {
    const s = evaluateContourStudioLaunchState({
      ...ready(),
      unsupportedFraction: MAX_UNSUPPORTED_FRACTION_FOR_DELIVERABLE + 0.01,
    });
    expect(s.status).toBe('unavailable');
    if (s.status === 'unavailable') {
      expect(s.reasons.some((r) => /unsupported surface/i.test(r))).toBe(true);
    }
  });

  it('treats a non-finite unsupported fraction as fully unsupported (conservative)', () => {
    const s = evaluateContourStudioLaunchState({ ...ready(), unsupportedFraction: Number.NaN });
    expect(s.status).toBe('unavailable');
  });

  it('caps to exploratory when vertical units are unknown', () => {
    const s = evaluateContourStudioLaunchState({ ...ready(), verticalUnitsKnown: false });
    expect(s.status).toBe('exploratory');
    if (s.status === 'exploratory') {
      expect(s.actionLabel).toBe('Create Exploratory Contours');
      expect(s.reasons.some((r) => /vertical units are unknown/i.test(r))).toBe(true);
    }
  });

  it('caps to exploratory on a geographic CRS', () => {
    const s = evaluateContourStudioLaunchState({ ...ready(), crsProjected: false, crsKind: 'geographic' });
    expect(s.status).toBe('exploratory');
    if (s.status === 'exploratory') {
      expect(s.reasons.some((r) => /geographic/i.test(r))).toBe(true);
    }
  });

  it('caps to exploratory on a sampled read, naming the sample', () => {
    const s = evaluateContourStudioLaunchState({ ...ready(), coverage: 'sampled' });
    expect(s.status).toBe('exploratory');
    if (s.status === 'exploratory') {
      expect(s.reasons.some((r) => /sample of the scan/i.test(r))).toBe(true);
      expect(s.reasons.some((r) => /resident streaming set/i.test(r))).toBe(false);
    }
  });

  it('caps to exploratory on a resident streaming set, naming the resident set', () => {
    const s = evaluateContourStudioLaunchState({ ...ready(), coverage: 'resident-only' });
    expect(s.status).toBe('exploratory');
    if (s.status === 'exploratory') {
      expect(s.reasons.some((r) => /resident streaming set/i.test(r))).toBe(true);
      expect(s.reasons.some((r) => /sample of the scan/i.test(r))).toBe(false);
    }
  });

  it('full coverage while still streaming names only the streaming condition', () => {
    const s = evaluateContourStudioLaunchState({ ...ready(), coverage: 'full', streaming: true });
    expect(s.status).toBe('exploratory');
    if (s.status === 'exploratory') {
      expect(s.reasons.filter((r) => /sample|resident/i.test(r))).toHaveLength(0);
      expect(s.reasons.some((r) => /streaming/i.test(r))).toBe(true);
    }
  });

  it('caps to exploratory over derived ground, so it never outranks the capability model', () => {
    const s = evaluateContourStudioLaunchState({ ...ready(), groundIsDerived: true });
    expect(s.status).toBe('exploratory');
    if (s.status === 'exploratory') expect(s.reasons.some((r) => /derived by the filter/i.test(r))).toBe(true);
  });

  it('caps to exploratory while still streaming', () => {
    const s = evaluateContourStudioLaunchState({ ...ready(), streaming: true });
    expect(s.status).toBe('exploratory');
    if (s.status === 'exploratory') {
      expect(s.reasons.some((r) => /streaming/i.test(r))).toBe(true);
    }
  });

  it('caps to exploratory when support is present but sparse', () => {
    const s = evaluateContourStudioLaunchState({ ...ready(), supportSufficient: false });
    expect(s.status).toBe('exploratory');
    if (s.status === 'exploratory') {
      expect(s.reasons.some((r) => /too sparse/i.test(r))).toBe(true);
    }
  });

  it('a hard blocker outranks a soft exploratory reason', () => {
    // No surface (hard) AND unknown units (soft) → unavailable, not exploratory.
    const s = evaluateContourStudioLaunchState({
      ...ready(),
      terrainSurfaceAvailable: false,
      verticalUnitsKnown: false,
    });
    expect(s.status).toBe('unavailable');
  });
});
