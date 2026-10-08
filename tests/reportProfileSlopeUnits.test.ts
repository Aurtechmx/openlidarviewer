/**
 * The report's profile slope detail (Max / Min / Avg grade) must use the same
 * per-axis units as its summary line. On a compound CRS (metre eastings over
 * foot heights) the slope line read the native samples as if both axes shared
 * one unit, so a 10 m run rising 10 ft printed +100% beside a 30.48% summary.
 */
import { describe, expect, it } from 'vitest';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import { buildMeasurementRows } from '../src/report/ReportMeasurementSection';

const FOOT = 0.3048;

function profile(a: Vec3, b: Vec3, samples: { distance: number; height: number }[]): Measurement {
  return { id: 'p', kind: 'profile', name: '', points: [a, b], profileChart: samples } as Measurement;
}

/** 11 native samples with height equal to distance (a uniform 1:1 native slope). */
const SAMPLES = Array.from({ length: 11 }, (_, i) => ({ distance: i, height: i }));

function extras(m: Measurement, f: number, vf: number, up: Vec3 = [0, 0, 1]) {
  const row = buildMeasurementRows([m], 'metric', f, up, vf, true)[0];
  return row.profileExtras!;
}

function slopePcts(line: string): number[] {
  return [...line.matchAll(/([+-]?[\d.]+)%/g)].map((x) => Number(x[1]));
}

describe('report profile slope line: per-axis units', () => {
  const zUp = profile([0, 0, 0], [10, 0, 10], SAMPLES);

  it('metre horizontal over foot vertical reads 30.48%, matching the summary', () => {
    const e = extras(zUp, 1, FOOT);
    expect(e.summary).toContain('30.48% grade');
    expect(slopePcts(e.slopeSummary)).toEqual([30.48, 30.48, 30.48]);
  });

  it('foot horizontal over metre vertical reads 328.08%', () => {
    const e = extras(zUp, FOOT, 1);
    expect(e.summary).toContain('328.08% grade');
    expect(slopePcts(e.slopeSummary)).toEqual([328.08, 328.08, 328.08]);
  });

  it('a single-unit CRS is unchanged', () => {
    expect(slopePcts(extras(zUp, 1, 1).slopeSummary)).toEqual([100, 100, 100]);
    expect(slopePcts(extras(zUp, FOOT, FOOT).slopeSummary)).toEqual([100, 100, 100]);
  });

  it('a Y-up scan applies the vertical factor along Y', () => {
    const yUp = profile([0, 0, 0], [10, 10, 0], SAMPLES);
    const e = extras(yUp, 1, FOOT, [0, 1, 0]);
    expect(e.summary).toContain('30.48% grade');
    expect(slopePcts(e.slopeSummary)).toEqual([30.48, 30.48, 30.48]);
  });

  it('with no samples, the station heights get the same correction', () => {
    const bare = profile([0, 0, 0], [10, 0, 10], []);
    expect(slopePcts(extras(bare, 1, FOOT).slopeSummary)).toEqual([30.48, 30.48, 30.48]);
    expect(slopePcts(extras(bare, 1, 1).slopeSummary)).toEqual([100, 100, 100]);
  });
});
