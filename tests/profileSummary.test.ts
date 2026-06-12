/**
 * profileSummary.test.ts — Profile Intelligence truth tests.
 *
 * Every expectation below is hand-computed from the fixture:
 *
 *   station   chainage   elevation   count
 *      0          0         10         5
 *      1         10         12         8     → seg 0–10:  +2 / 10 = +20 %
 *      2         20         11         3     → seg 10–20: −1 / 10 = −10 %
 *      3         30        gap         0     → segs touching the gap: nothing
 *      4         40         14         6
 *      5         50         13         9     → seg 40–50: −1 / 10 = −10 %
 *
 *   length 50 · coverage 5/6 · gain = +2 · loss = 2 (two −1 drops)
 *   average grade = (13 − 10) / (50 − 0) = +6 % (net over covered span)
 *   steepest = the 0→10 segment at +20 % · highest 14 @ 40 · lowest 10 @ 0
 *
 * The 11 → 14 rise across the gap must contribute NOTHING (it was never
 * measured) — that is the honesty contract under test.
 */

import { describe, it, expect } from 'vitest';
import type { ProfileChartSample } from '../src/render/measure/types';
import {
  buildProfileCsv,
  computeProfileSummary,
  formatStation,
  profileStationRows,
  profileSummaryRows,
  scaleProfileSamples,
} from '../src/render/measure/profileSummary';

const FIXTURE: ProfileChartSample[] = [
  { distance: 0, height: 10, count: 5 },
  { distance: 10, height: 12, count: 8 },
  { distance: 20, height: 11, count: 3 },
  { distance: 30, height: NaN, count: 0 },
  { distance: 40, height: 14, count: 6 },
  { distance: 50, height: 13, count: 9 },
];

describe('computeProfileSummary', () => {
  const s = computeProfileSummary(FIXTURE);

  it('length and coverage', () => {
    expect(s.lengthM).toBe(50);
    expect(s.coverage).toBeCloseTo(5 / 6, 12);
  });

  it('gain sums only positive deltas between adjacent covered stations', () => {
    expect(s.gainM).toBeCloseTo(2, 12);
  });

  it('loss sums only negative deltas — the gap-crossing rise contributes nothing', () => {
    // 10→12→11 gives one −1, 14→13 the other; 11→14 spans the gap and is
    // excluded. A naive sum over all covered points would say gain 5 / loss 2.
    expect(s.lossM).toBeCloseTo(2, 12);
  });

  it('average grade is the net over the covered span: +6 %', () => {
    expect(s.averageGrade).toBeCloseTo(0.06, 12);
  });

  it('max grade is the steepest segment, signed: +20 % over 0→10', () => {
    expect(s.maxGrade).toBeCloseTo(0.2, 12);
    expect(s.steepest).not.toBeNull();
    expect(s.steepest!.fromChainage).toBe(0);
    expect(s.steepest!.toChainage).toBe(10);
    expect(s.steepest!.grade).toBeCloseTo(0.2, 12);
  });

  it('locates the extremes', () => {
    expect(s.highest).toEqual({ chainage: 40, elevation: 14 });
    expect(s.lowest).toEqual({ chainage: 0, elevation: 10 });
  });

  it('keeps the sign of a dominant downhill: −30 % beats +20 %', () => {
    const d = computeProfileSummary([
      { distance: 0, height: 10 },
      { distance: 10, height: 12 }, // +20 %
      { distance: 20, height: 9 },  // −30 % — steeper in magnitude
    ]);
    expect(d.maxGrade).toBeCloseTo(-0.3, 12);
    expect(d.steepest!.fromChainage).toBe(10);
    expect(d.steepest!.toChainage).toBe(20);
  });

  it('all-gap profile: every derived figure is null, never 0', () => {
    const g = computeProfileSummary([
      { distance: 0, height: NaN },
      { distance: 10, height: NaN },
    ]);
    expect(g.coverage).toBe(0);
    expect(g.gainM).toBeNull();
    expect(g.lossM).toBeNull();
    expect(g.averageGrade).toBeNull();
    expect(g.maxGrade).toBeNull();
    expect(g.steepest).toBeNull();
    expect(g.highest).toBeNull();
    expect(g.lowest).toBeNull();
  });

  it('a single covered station has extremes but no grades', () => {
    const one = computeProfileSummary([
      { distance: 0, height: NaN },
      { distance: 10, height: 7 },
      { distance: 20, height: NaN },
    ]);
    expect(one.highest).toEqual({ chainage: 10, elevation: 7 });
    expect(one.lowest).toEqual({ chainage: 10, elevation: 7 });
    expect(one.gainM).toBeNull();
    expect(one.averageGrade).toBeNull();
  });
});

describe('formatStation', () => {
  it('metric uses the km+m convention', () => {
    expect(formatStation(0, 'metric')).toBe('0+000.00');
    expect(formatStation(1234.5, 'metric')).toBe('1+234.50');
  });

  it('imperial uses the US 100-ft station convention', () => {
    // 10 m = 32.8084 ft → station 0+32.81.
    expect(formatStation(10, 'imperial')).toBe('0+32.81');
    // 100 m = 328.084 ft → station 3, remainder 28.08 ft.
    expect(formatStation(100, 'imperial')).toBe('3+28.08');
    expect(formatStation(0, 'imperial')).toBe('0+00.00');
  });
});

describe('profileSummaryRows', () => {
  it('metric rows carry the hand-computed values', () => {
    const rows = profileSummaryRows(computeProfileSummary(FIXTURE), 'metric');
    const byLabel = new Map(rows.map((r) => [r.label, r.value]));
    expect(byLabel.get('Length')).toBe('50.00 m');
    expect(byLabel.get('Elevation gain / loss')).toBe('+2.00 m / −2.00 m');
    expect(byLabel.get('Avg grade')).toBe('6.00%');
    expect(byLabel.get('Max grade')).toBe('20.00%');
    expect(byLabel.get('Steepest section')).toBe('0+000.00 → 0+010.00 (20.00%)');
    expect(byLabel.get('Highest point')).toBe('14.00 m @ 0+040.00');
    expect(byLabel.get('Lowest point')).toBe('10.00 m @ 0+000.00');
  });

  it('imperial rows convert lengths and stationing', () => {
    const rows = profileSummaryRows(computeProfileSummary(FIXTURE), 'imperial');
    const byLabel = new Map(rows.map((r) => [r.label, r.value]));
    // 50 m = 164.04 ft; 14 m = 45.93 ft; grades are unit-free.
    expect(byLabel.get('Length')).toBe('164.04 ft');
    expect(byLabel.get('Avg grade')).toBe('6.00%');
    expect(byLabel.get('Highest point')).toBe('45.93 ft @ 1+31.23');
  });

  it('an empty profile renders honest dashes', () => {
    const rows = profileSummaryRows(
      computeProfileSummary([
        { distance: 0, height: NaN },
        { distance: 10, height: NaN },
      ]),
      'metric',
    );
    const byLabel = new Map(rows.map((r) => [r.label, r.value]));
    expect(byLabel.get('Elevation gain / loss')).toBe('—');
    expect(byLabel.get('Steepest section')).toBe('—');
    expect(byLabel.get('Highest point')).toBe('—');
  });
});

describe('buildProfileCsv', () => {
  it('metric CSV: one row per station, gaps blank, counts carried', () => {
    const csv = buildProfileCsv(FIXTURE, 'metric');
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe('station,chainage_m,elevation_m,points,grade_to_next_pct');
    expect(lines).toHaveLength(1 + FIXTURE.length);
    expect(lines[1]).toBe('0+000.00,0.00,10.000,5,20.00');
    expect(lines[2]).toBe('0+010.00,10.00,12.000,8,-10.00');
    // Station 2's next neighbour is the gap → no grade; the gap row itself
    // keeps its place with elevation blank and its honest 0 count.
    expect(lines[3]).toBe('0+020.00,20.00,11.000,3,');
    expect(lines[4]).toBe('0+030.00,30.00,,0,');
    expect(lines[5]).toBe('0+040.00,40.00,14.000,6,-10.00');
    // Last station never has a grade-to-next.
    expect(lines[6]).toBe('0+050.00,50.00,13.000,9,');
  });

  it('imperial CSV converts chainage and elevation and says so in the header', () => {
    const csv = buildProfileCsv(FIXTURE, 'imperial');
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe('station,chainage_ft,elevation_ft,points,grade_to_next_pct');
    // 10 m = 32.81 ft chainage; 12 m elevation = 39.370 ft; grade unit-free.
    expect(lines[2]).toBe('0+32.81,32.81,39.370,8,-10.00');
  });

  it('legacy samples without counts get a blank points column, not a fake 0', () => {
    const csv = buildProfileCsv(
      [
        { distance: 0, height: 1 },
        { distance: 10, height: 2 },
      ],
      'metric',
    );
    const lines = csv.trimEnd().split('\n');
    expect(lines[1]).toBe('0+000.00,0.00,1.000,,10.00');
  });
});

describe('scaleProfileSamples (v0.4.5, B2 unit seam)', () => {
  it('scales distances AND heights by the factor; counts ride along untouched', () => {
    // Foot-CRS render units → metres at f = 0.3048:
    // 10 ft → 3.048 m chainage, 100 ft → 30.48 m elevation.
    const scaled = scaleProfileSamples(
      [
        { distance: 10, height: 100, count: 4 },
        { distance: 20, height: 50, count: 0 },
      ],
      0.3048,
    );
    expect(scaled[0].distance).toBeCloseTo(3.048, 12);
    expect(scaled[0].height).toBeCloseTo(30.48, 12);
    expect(scaled[0].count).toBe(4);
    expect(scaled[1].distance).toBeCloseTo(6.096, 12);
    expect(scaled[1].count).toBe(0);
  });

  it('NaN gaps survive scaling as gaps', () => {
    const scaled = scaleProfileSamples([{ distance: 5, height: NaN, count: 0 }], 0.3048);
    expect(scaled[0].distance).toBeCloseTo(1.524, 12);
    expect(Number.isNaN(scaled[0].height)).toBe(true);
  });

  it('a missing count stays MISSING (pre-v0.4.5 series), never a fake 0', () => {
    const scaled = scaleProfileSamples([{ distance: 1, height: 2 }], 0.3048);
    expect('count' in scaled[0]).toBe(false);
  });

  it('invalid factors fall back to 1 and the input array is never mutated', () => {
    const src = [{ distance: 7, height: 3, count: 1 }];
    const out = scaleProfileSamples(src, Number.NaN);
    expect(out[0]).toEqual({ distance: 7, height: 3, count: 1 });
    expect(out).not.toBe(src);
    expect(out[0]).not.toBe(src[0]);
  });
});

describe('profileStationRows (v0.4.5, B5 — shared row model)', () => {
  it('metric rows carry the hand-computed values, gaps as honest blanks', () => {
    const rows = profileStationRows(FIXTURE, 'metric');
    expect(rows).toHaveLength(FIXTURE.length);
    expect(rows[0]).toEqual({
      station: '0+000.00',
      chainage: '0.00',
      elevation: '10.000',
      points: '5',
      grade: '20.00',
    });
    // Station 2's neighbour is the gap → no grade; the gap row keeps its
    // place with a blank elevation and its honest 0 count.
    expect(rows[2].grade).toBe('');
    expect(rows[3]).toEqual({
      station: '0+030.00',
      chainage: '30.00',
      elevation: '',
      points: '0',
      grade: '',
    });
    // The last station never has a grade-to-next.
    expect(rows[5].grade).toBe('');
  });

  it('imperial rows convert chainage and elevation: 10 m = 32.81 ft / 39.370 ft', () => {
    const rows = profileStationRows(FIXTURE, 'imperial');
    expect(rows[1]).toEqual({
      station: '0+32.81',
      chainage: '32.81',
      elevation: '39.370',
      points: '8',
      grade: '-10.00',
    });
  });

  it('the CSV is exactly these rows joined — panel table and export cannot diverge', () => {
    const rows = profileStationRows(FIXTURE, 'metric');
    const lines = buildProfileCsv(FIXTURE, 'metric').trimEnd().split('\n');
    rows.forEach((r, i) => {
      expect(lines[i + 1]).toBe(
        `${r.station},${r.chainage},${r.elevation},${r.points},${r.grade}`,
      );
    });
  });
});
