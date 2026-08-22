/**
 * tests/profileCorridorCaps.test.ts
 *
 * Corridor membership at and beyond the section-line endpoints.
 *
 * `sampleProfile` documents its band as a distance from the segment a to b.
 * That makes the corridor a capsule: a rectangle between the endpoints closed
 * by a half-disc of radius `bandWidth` at each end. The cases below pin the
 * cap boundary, which the rectangular gate this file was written for admitted
 * out to a corner at sqrt(2) times the band.
 *
 * GEOMETRY. The line is axis-aligned over 16 m with a 2.5 m band and a 1 m bin
 * step, so chainage is x and perpendicular offset is y. Every coordinate is a
 * multiple of 1/8, exactly representable in the Float32Array the sampler reads
 * and in the double it projects with, so a boundary point sits exactly on the
 * boundary and no case is decided by rounding. (1.5, 2.0, 2.5) is a Pythagorean
 * triple, which is what puts an exact radial boundary within reach of dyadic
 * coordinates.
 *
 * Admission is read off the per-bin corridor count: a probe cloud holds only
 * the points under test, so a count of 1 is an admission and 0 is a rejection.
 */

import { describe, it, expect } from 'vitest';
import { sampleProfile } from '../src/render/measure/profileSampler';

const Z_UP: [number, number, number] = [0, 0, 1];
const A: [number, number, number] = [0, 0, 0];
/** 16 m line with a 1 m bin step: 17 stations at x = 0 .. 16. */
const LEN = 16;
const B: [number, number, number] = [LEN, 0, 0];
const SAMPLES = 17;
const BAND = 2.5;
/** Probe elevation. Any finite value works; the tests read counts, not heights. */
const PROBE_Z = 3;

type Point = readonly [number, number, number];

function pack(points: ReadonlyArray<Point>): Float32Array {
  const out = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i][0];
    out[i * 3 + 1] = points[i][1];
    out[i * 3 + 2] = points[i][2];
  }
  return out;
}

const profileOf = (points: ReadonlyArray<Point>) =>
  sampleProfile({
    a: A, b: B, up: Z_UP, positions: pack(points), samples: SAMPLES, bandWidth: BAND,
  });

/** Total corridor admissions across every station. */
const admissions = (points: ReadonlyArray<Point>): number =>
  profileOf(points).reduce((n, s) => n + (s.count ?? 0), 0);

/** Horizontal distance from (x, y) to the nearer of the two endpoints. */
const distanceToEnd = (x: number, y: number): number =>
  Math.min(Math.hypot(x - A[0], y - A[1]), Math.hypot(x - B[0], y - B[1]));

describe('sampleProfile corridor: end caps', () => {
  it('rejects all four corners of the enclosing rectangle', () => {
    const corners: Array<readonly [number, number]> = [
      [-BAND, BAND], [-BAND, -BAND], [LEN + BAND, BAND], [LEN + BAND, -BAND],
    ];
    for (const [x, y] of corners) {
      // Each corner is sqrt(2) * BAND from the segment, so the stated
      // "further than BAND from the segment is ignored" rule excludes it.
      expect(distanceToEnd(x, y)).toBeCloseTo(Math.SQRT2 * BAND, 12);
      expect(admissions([[x, y, PROBE_Z]]), `corner (${x}, ${y})`).toBe(0);
    }
  });

  it('admits at and inside the start cap radius, rejects outside it', () => {
    // Radii 1.875, 2.5 and 3.125 about the start endpoint, all with a negative
    // chainage and a perpendicular offset no greater than BAND, which is what
    // the rectangular gate keyed on.
    const inside: Point = [-1.125, 1.5, PROBE_Z]; // r = 1.875
    const onBoundary: Point = [-1.5, 2.0, PROBE_Z]; // r = 2.5, exactly BAND
    const outside: Point = [-1.875, 2.5, PROBE_Z]; // r = 3.125

    expect(distanceToEnd(inside[0], inside[1])).toBe(1.875);
    expect(distanceToEnd(onBoundary[0], onBoundary[1])).toBe(BAND);
    expect(distanceToEnd(outside[0], outside[1])).toBe(3.125);

    expect(admissions([inside]), 'inside the cap').toBe(1);
    expect(admissions([onBoundary]), 'on the cap boundary').toBe(1);
    expect(admissions([outside]), 'outside the cap').toBe(0);
  });

  it('admits at and inside the end cap radius, rejects outside it', () => {
    const inside: Point = [LEN + 1.125, 1.5, PROBE_Z]; // r = 1.875
    const onBoundary: Point = [LEN + 1.5, 2.0, PROBE_Z]; // r = 2.5, exactly BAND
    const outside: Point = [LEN + 1.875, 2.5, PROBE_Z]; // r = 3.125

    expect(distanceToEnd(inside[0], inside[1])).toBe(1.875);
    expect(distanceToEnd(onBoundary[0], onBoundary[1])).toBe(BAND);
    expect(distanceToEnd(outside[0], outside[1])).toBe(3.125);

    expect(admissions([inside]), 'inside the cap').toBe(1);
    expect(admissions([onBoundary]), 'on the cap boundary').toBe(1);
    expect(admissions([outside]), 'outside the cap').toBe(0);
  });

  it('keeps a point just past an end that is genuinely within the band', () => {
    // The caps are not truncated away: a return 0.5 m before the start and
    // 0.25 m off the axis is 0.559 m from the endpoint, well inside the band,
    // and belongs to the first station.
    const before: Point = [-0.5, 0.25, PROBE_Z];
    const after: Point = [LEN + 0.5, -0.25, PROBE_Z];
    expect(distanceToEnd(before[0], before[1])).toBeLessThan(BAND);
    expect(distanceToEnd(after[0], after[1])).toBeLessThan(BAND);

    const series = profileOf([before, after]);
    expect(series[0].count, 'first station').toBe(1);
    expect(series[0].height).toBe(PROBE_Z);
    expect(series[SAMPLES - 1].count, 'last station').toBe(1);
    expect(series[SAMPLES - 1].height).toBe(PROBE_Z);
    // Nothing leaked into an interior station.
    for (let i = 1; i < SAMPLES - 1; i++) expect(series[i].count, `station ${i}`).toBe(0);
  });

  it('is unchanged between the endpoints: the perpendicular band still rules', () => {
    for (const x of [0, 4, 8, 12, LEN]) {
      for (const sign of [1, -1]) {
        expect(admissions([[x, sign * BAND, PROBE_Z]]), `on the band at x=${x}`).toBe(1);
        expect(admissions([[x, sign * (BAND + 0.5), PROBE_Z]]), `past the band at x=${x}`).toBe(0);
      }
    }
  });

  it('matches a capsule predicate over a lattice covering both caps', () => {
    // A deterministic 1/4 m lattice spanning two band widths past each end and
    // each side. Per-station counts are compared, not a total, so an admission
    // moved from one station to another cannot cancel out.
    const step = 0.25;
    const points: Point[] = [];
    const expected = new Array<number>(SAMPLES).fill(0);
    const binStep = LEN / (SAMPLES - 1);
    for (let x = -2 * BAND; x <= LEN + 2 * BAND; x += step) {
      for (let y = -2 * BAND; y <= 2 * BAND; y += step) {
        points.push([x, y, PROBE_Z]);
        const nearest = x < 0 ? 0 : x > LEN ? LEN : x;
        if (Math.hypot(x - nearest, y) > BAND) continue;
        const bin = Math.min(SAMPLES - 1, Math.max(0, Math.round(x / binStep)));
        expected[bin]++;
      }
    }
    expect(points.length).toBe(105 * 41);
    expect(expected.reduce((n, c) => n + c, 0)).toBeGreaterThan(0);
    expect(profileOf(points).map((s) => s.count)).toEqual(expected);
  });
});
