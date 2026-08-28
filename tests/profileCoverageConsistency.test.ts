/**
 * profileCoverageConsistency.test.ts — BUG 8
 *
 * The profile summary and the civil statistics must decide "covered vs gap"
 * from ONE rule. A degenerate sampler emits `{ height: finite, count: 0 }`;
 * civilProfileStats treats that as a gap (PR #676) but profileSummary used to
 * treat it as covered by looking at the height alone. For the SAME station the
 * two modules must now agree, and a legacy `count: undefined` finite sample
 * must be covered in both.
 */

import { describe, it, expect } from 'vitest';
import {
  computeCivilProfileStats,
  profileSampleCovered,
} from '../src/render/measure/civilProfileStats';
import { computeProfileSummary } from '../src/render/measure/profileSummary';
import type { ProfileChartSample } from '../src/render/measure/types';

describe('BUG 8 — profile coverage semantics agree across modules', () => {
  it('a count:0 finite station is a gap in BOTH summary and civil stats', () => {
    // Three real stations plus one degenerate count:0 station in the middle.
    const samples: ProfileChartSample[] = [
      { distance: 0, height: 100, count: 5 },
      { distance: 10, height: 101, count: 0 }, // degenerate: finite height, no returns
      { distance: 20, height: 104, count: 7 },
    ];

    const civil = computeCivilProfileStats(samples);
    const summary = computeProfileSummary(samples);

    // Civil marks the middle station as a gap (elevation null).
    expect(civil.stations[1].elevation).toBeNull();
    // The shared predicate must agree.
    expect(profileSampleCovered(samples[1])).toBe(false);

    // Coverage must be identical (2 of 3), not 3/3 from the summary.
    expect(summary.coverage).toBeCloseTo(civil.coverage, 12);
    expect(summary.coverage).toBeCloseTo(2 / 3, 12);
  });

  it('a legacy count:undefined finite station is covered in BOTH', () => {
    const samples: ProfileChartSample[] = [
      { distance: 0, height: 100 },
      { distance: 10, height: 101 },
      { distance: 20, height: 104 },
    ];
    const civil = computeCivilProfileStats(samples);
    const summary = computeProfileSummary(samples);
    expect(profileSampleCovered(samples[1])).toBe(true);
    expect(summary.coverage).toBe(1);
    expect(civil.coverage).toBe(1);
  });

  it('max grade skips the count:0 station in the summary too', () => {
    // Without the shared rule the summary would draw a phantom steep segment
    // into or out of the count:0 station.
    const samples: ProfileChartSample[] = [
      { distance: 0, height: 100, count: 5 },
      { distance: 1, height: 200, count: 0 }, // huge phantom grade if counted
      { distance: 2, height: 100, count: 5 },
    ];
    const summary = computeProfileSummary(samples);
    const civil = computeCivilProfileStats(samples);
    // Both endpoints are covered but the middle is a gap, so no adjacent
    // covered pair exists: max grade is null on both.
    expect(summary.maxGrade).toBeNull();
    expect(civil.maxGrade).toBeNull();
  });
});
