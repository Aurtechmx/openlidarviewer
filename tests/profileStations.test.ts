import { describe, it, expect } from 'vitest';
import {
  stationsAlongLine,
  slopeGradesPerSegment,
  summariseSlopes,
  type ProfileStation,
} from '../src/render/measure/profileStations';

/**
 * tests/profileStations.test.ts
 *
 * Pure data layer for the Profile-as-Deliverable foundation. v0.3.10
 * absorbed v0.4 Tier 1 — these tests pin the chainage placement, the
 * per-segment slope math, and the summary aggregator against
 * deterministic analytical inputs.
 */

describe('stationsAlongLine — chainage placement', () => {
  it('places stations at the interval, with start + end always included', () => {
    // 100 m horizontal section, 25 m interval → 0, 25, 50, 75, 100.
    const stations = stationsAlongLine({
      a: [0, 0, 100],
      b: [100, 0, 110],
      intervalM: 25,
    });
    expect(stations.length).toBe(5);
    expect(stations.map((s) => s.chainage)).toEqual([0, 25, 50, 75, 100]);
    // Last station carries the endpoint flag; others don't.
    expect(stations[stations.length - 1].isEndpoint).toBe(true);
    for (let i = 0; i < stations.length - 1; i++) {
      expect(stations[i].isEndpoint).toBe(false);
    }
  });

  it('always emits a terminal station even when the section ends mid-interval', () => {
    // 73 m section, 25 m interval → 0, 25, 50, 73.
    const stations = stationsAlongLine({
      a: [0, 0, 0],
      b: [73, 0, 0],
      intervalM: 25,
    });
    expect(stations.map((s) => s.chainage)).toEqual([0, 25, 50, 73]);
    expect(stations[stations.length - 1].isEndpoint).toBe(true);
  });

  it('linearly interpolates Z between the endpoints', () => {
    // 100 m horizontal, rise from Z=0 to Z=10. Mid-station at 50 m
    // should sit at Z=5.
    const stations = stationsAlongLine({
      a: [0, 0, 0],
      b: [100, 0, 10],
      intervalM: 50,
    });
    expect(stations[1].position[2]).toBeCloseTo(5, 9);
    expect(stations[2].position[2]).toBeCloseTo(10, 9);
  });

  it('uses HORIZONTAL distance, not 3D length, for chainage', () => {
    // 100 m horizontal, 10 m vertical. 3D length ≈ 100.5 m but
    // chainage should still be 100 m (cartographer convention).
    const stations = stationsAlongLine({
      a: [0, 0, 0],
      b: [100, 0, 10],
      intervalM: 50,
    });
    expect(stations[stations.length - 1].chainage).toBeCloseTo(100, 9);
  });

  it('returns [] for a degenerate horizontal section', () => {
    // Same XY, different Z — section has no horizontal length.
    const stations = stationsAlongLine({
      a: [10, 10, 0],
      b: [10, 10, 50],
      intervalM: 1,
    });
    expect(stations).toEqual([]);
  });

  it('returns [] for non-finite inputs', () => {
    expect(
      stationsAlongLine({ a: [0, 0, 0], b: [Number.NaN, 0, 0], intervalM: 10 }),
    ).toEqual([]);
    expect(
      stationsAlongLine({ a: [0, 0, 0], b: [100, 0, 0], intervalM: Number.NaN }),
    ).toEqual([]);
    expect(
      stationsAlongLine({ a: [0, 0, 0], b: [100, 0, 0], intervalM: 0 }),
    ).toEqual([]);
    expect(
      stationsAlongLine({ a: [0, 0, 0], b: [100, 0, 0], intervalM: -10 }),
    ).toEqual([]);
  });

  it('handles a diagonal section in the XY plane', () => {
    // 3-4-5 triangle: horizontal length = 5 (sqrt(3²+4²) = 5).
    const stations = stationsAlongLine({
      a: [0, 0, 0],
      b: [3, 4, 0],
      intervalM: 1,
    });
    expect(stations[0].chainage).toBe(0);
    expect(stations[stations.length - 1].chainage).toBeCloseTo(5, 6);
    // Second station at chainage 1 sits at (0.6, 0.8) along the unit vector.
    expect(stations[1].position[0]).toBeCloseTo(0.6, 6);
    expect(stations[1].position[1]).toBeCloseTo(0.8, 6);
  });
});

describe('slopeGradesPerSegment — per-segment math', () => {
  const stations = (chainages: number[], zs: number[]): ProfileStation[] =>
    chainages.map((c, i) => ({
      chainage: c,
      position: [c, 0, zs[i]],
      isEndpoint: i === chainages.length - 1,
    }));

  it('returns [] for fewer than 2 stations', () => {
    expect(slopeGradesPerSegment({ stations: [] })).toEqual([]);
    expect(slopeGradesPerSegment({ stations: stations([0], [0]) })).toEqual([]);
  });

  it('computes a 5% uphill grade as +5%', () => {
    // 100 m run, 5 m rise → 5 %.
    const sts = stations([0, 100], [0, 5]);
    const grades = slopeGradesPerSegment({ stations: sts });
    expect(grades.length).toBe(1);
    expect(grades[0].run).toBe(100);
    expect(grades[0].rise).toBe(5);
    expect(grades[0].gradePercent).toBeCloseTo(5, 9);
    // atan(5/100) ≈ 2.862°.
    expect(grades[0].gradeDegrees).toBeCloseTo(2.8624052, 5);
  });

  it('computes downhill grades as negative percentages', () => {
    const sts = stations([0, 100], [10, 0]);
    const grades = slopeGradesPerSegment({ stations: sts });
    expect(grades[0].gradePercent).toBeCloseTo(-10, 9);
    expect(grades[0].gradeDegrees).toBeLessThan(0);
  });

  it('produces one grade per segment between adjacent stations', () => {
    const sts = stations([0, 50, 100], [0, 3, 8]);
    const grades = slopeGradesPerSegment({ stations: sts });
    expect(grades.length).toBe(2);
    expect(grades[0].gradePercent).toBeCloseTo(6, 9); // 3 / 50
    expect(grades[1].gradePercent).toBeCloseTo(10, 9); // 5 / 50
  });

  it('uses samples when provided (overriding linear Z baked into stations)', () => {
    // Stations have linear Z baked in (0, 5, 10) — but the cloud
    // actually dips at the middle (0, 2, 10). The samples should
    // override the station Z and produce the dip-aware grades.
    const sts = stations([0, 50, 100], [0, 5, 10]);
    const samples = [
      { distance: 0, height: 0 },
      { distance: 50, height: 2 },
      { distance: 100, height: 10 },
    ];
    const grades = slopeGradesPerSegment({ stations: sts, samples });
    expect(grades[0].gradePercent).toBeCloseTo(4, 9); // 2 / 50
    expect(grades[1].gradePercent).toBeCloseTo(16, 9); // 8 / 50
  });

  it('produces NaN grade when a sample is NaN at the station chainage', () => {
    const sts = stations([0, 100], [0, 0]);
    const samples = [
      { distance: 0, height: 0 },
      { distance: 100, height: Number.NaN },
    ];
    const grades = slopeGradesPerSegment({ stations: sts, samples });
    expect(grades[0].gradePercent).toBeNaN();
    expect(grades[0].gradeDegrees).toBeNaN();
  });
});

describe('summariseSlopes', () => {
  it('returns NaN summary for empty input', () => {
    const s = summariseSlopes([]);
    expect(s.maxGradePercent).toBeNaN();
    expect(s.minGradePercent).toBeNaN();
    expect(s.avgGradePercent).toBeNaN();
  });

  it('returns NaN summary when every grade is NaN', () => {
    const s = summariseSlopes([
      { fromIndex: 0, toIndex: 1, run: 1, rise: 0, gradePercent: Number.NaN, gradeDegrees: Number.NaN },
    ]);
    expect(s.maxGradePercent).toBeNaN();
    expect(s.avgGradePercent).toBeNaN();
  });

  it('skips NaN grades from min/max/avg', () => {
    const s = summariseSlopes([
      { fromIndex: 0, toIndex: 1, run: 50, rise: 5, gradePercent: 10, gradeDegrees: 5.7 },
      { fromIndex: 1, toIndex: 2, run: 50, rise: -1, gradePercent: -2, gradeDegrees: -1.1 },
      { fromIndex: 2, toIndex: 3, run: 50, rise: 0, gradePercent: Number.NaN, gradeDegrees: Number.NaN },
    ]);
    expect(s.maxGradePercent).toBe(10);
    expect(s.minGradePercent).toBe(-2);
    expect(s.avgGradePercent).toBeCloseTo(4, 9); // (10 + -2) / 2
  });
});
