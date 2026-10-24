/**
 * rationalDischarge.test.ts — the rational-method peak-flow estimate.
 *
 * Q = C · i · A with i in mm/h converted to m/s and A in m². Pinned here: the
 * unit conversion (against HEC-22's SI form Q = C·I·A/360 with A in hectares),
 * linearity in each of C, i and A, the withheld state when the area has no
 * metres, the 0.8 km² area warning, the lower-bound wording, the fixed display
 * threshold, and that every preset is the midpoint of the range it cites.
 */
import { describe, expect, it } from 'vitest';
import {
  DISPLAY_THRESHOLD_M3S,
  PEAK_FLOW_WITHHELD,
  RAINFALL_DEFAULT,
  RAINFALL_MAX_MM_H,
  RAINFALL_MIN_MM_H,
  RATIONAL_MAX_AREA_M2,
  RUNOFF_C_MAX,
  RUNOFF_C_MIN,
  RUNOFF_C_STEP,
  RUNOFF_PRESETS,
  areaLimitWarning,
  clampRainfall,
  flowDisplayField,
  flowDisplayStrength,
  formatPeakFlow,
  intensityMetresPerSecond,
  minAreaForFlowM2,
  peakFlowEstimate,
  peakFlowText,
  presetOf,
  rationalAssumptions,
  rationalPeakM3s,
} from '../src/simulation/flowPulse/rationalDischarge';

describe('unit conversion', () => {
  it('converts mm/h to m/s by dividing by 3.6e6', () => {
    expect(intensityMetresPerSecond(36)).toBeCloseTo(1e-5, 15);
    expect(intensityMetresPerSecond(3.6e6)).toBe(1);
  });

  it('agrees with the SI form HEC-22 writes, Q = C·I·A/360 with A in hectares', () => {
    for (const [c, i, ha] of [[0.2, 25, 8.0687], [0.825, 100, 0.5], [1, 200, 80], [0.05, 1, 0.01]] as const) {
      expect(rationalPeakM3s(c, i, ha * 10_000)).toBeCloseTo((c * i * ha) / 360, 12);
    }
  });

  it('gives a hand value: C 0.5, 36 mm/h, 1 ha is 0.05 m³/s', () => {
    expect(rationalPeakM3s(0.5, 36, 10_000)).toBeCloseTo(0.05, 12);
  });
});

describe('linearity', () => {
  const q = (c: number, i: number, a: number) => rationalPeakM3s(c, i, a);
  it('is linear in C, in i and in A', () => {
    const base = q(0.3, 40, 5000);
    expect(q(0.6, 40, 5000)).toBeCloseTo(2 * base, 12);
    expect(q(0.3, 120, 5000)).toBeCloseTo(3 * base, 12);
    expect(q(0.3, 40, 20_000)).toBeCloseTo(4 * base, 12);
    expect(q(0.3, 40, 0)).toBe(0);
  });

  it('the display threshold area scales inversely with C·i', () => {
    const a = minAreaForFlowM2({ intensityMmH: 25, runoffC: 0.2 });
    expect(rationalPeakM3s(0.2, 25, a)).toBeCloseTo(DISPLAY_THRESHOLD_M3S, 15);
    expect(minAreaForFlowM2({ intensityMmH: 50, runoffC: 0.2 })).toBeCloseTo(a / 2, 9);
  });
});

describe('withheld and flagged estimates', () => {
  it('withholds Q when the area has no metres, in the wording the Lab uses', () => {
    const e = peakFlowEstimate(null, RAINFALL_DEFAULT);
    expect(e.ok).toBe(false);
    if (e.ok) return;
    expect(e.reason).toBe(PEAK_FLOW_WITHHELD);
    expect(PEAK_FLOW_WITHHELD).toBe('Withheld: the horizontal scale is not resolved');
    expect(peakFlowText(e)).toBe(PEAK_FLOW_WITHHELD);
  });

  it('flags an area above 0.8 km² and not one at or below it', () => {
    expect(RATIONAL_MAX_AREA_M2).toBe(800_000);
    const small = peakFlowEstimate(800_000, RAINFALL_DEFAULT);
    const large = peakFlowEstimate(1_200_000, RAINFALL_DEFAULT);
    expect(small.ok && small.aboveAreaLimit).toBe(false);
    expect(areaLimitWarning(small)).toBeNull();
    expect(large.ok && large.aboveAreaLimit).toBe(true);
    expect(areaLimitWarning(large)).toContain('1.20 km², above the 0.8 km² (80 ha)');
  });

  it('marks a lower bound in the text', () => {
    const e = peakFlowEstimate(80_687, { intensityMmH: 25, runoffC: 0.2 }, true);
    expect(peakFlowText(e)).toBe('at least 112 L/s at 25 mm/h, C 0.2');
    expect(peakFlowText(peakFlowEstimate(80_687, { intensityMmH: 25, runoffC: 0.2 }))).toBe('112 L/s at 25 mm/h, C 0.2');
  });

  it('clamps a setting into the slider ranges', () => {
    expect(clampRainfall({ intensityMmH: 0, runoffC: 2 })).toMatchObject({ intensityMmH: RAINFALL_MIN_MM_H, runoffC: RUNOFF_C_MAX });
    expect(clampRainfall({ intensityMmH: 999, runoffC: 0 })).toMatchObject({ intensityMmH: RAINFALL_MAX_MM_H, runoffC: RUNOFF_C_MIN });
    expect(clampRainfall({ intensityMmH: Number.NaN, runoffC: Number.NaN })).toMatchObject({ intensityMmH: 25, runoffC: 0.2 });
  });
});

describe('formatting', () => {
  it('writes L/s below 1,000 L/s and m³/s from there up', () => {
    expect(formatPeakFlow(0.00123)).toBe('1.2 L/s');
    expect(formatPeakFlow(0.0456)).toBe('45.6 L/s');
    expect(formatPeakFlow(0.2804)).toBe('280 L/s');
    expect(formatPeakFlow(0.9994)).toBe('999 L/s');
    expect(formatPeakFlow(1.5)).toBe('1.50 m³/s');
    expect(formatPeakFlow(250)).toBe('250 m³/s');
  });
});

describe('display field', () => {
  it('draws a cell once its peak flow reaches 1 L/s, so more rain draws more of the network', () => {
    const area = Float64Array.from([10, 100, 1000, 10_000, 100_000]);
    const light = flowDisplayField(area, { intensityMmH: 5, runoffC: 0.2 });
    const heavy = flowDisplayField(area, { intensityMmH: 100, runoffC: 0.2 });
    expect(heavy.channelCells).toBeGreaterThan(light.channelCells);
    for (let i = 0; i < area.length; i++) {
      const q5 = rationalPeakM3s(0.2, 5, area[i]!);
      expect(light.channel[i]).toBe(q5 >= DISPLAY_THRESHOLD_M3S ? 1 : 0);
      if (light.channel[i]) expect(heavy.strength[i]).toBeGreaterThan(light.strength[i]!);
    }
  });

  it('places 1 L/s at 0, 1,000 L/s at 1 and is linear in log Q between', () => {
    expect(flowDisplayStrength(0.001)).toBe(0);
    expect(flowDisplayStrength(0.0005)).toBe(0);
    expect(flowDisplayStrength(1)).toBeCloseTo(1, 12);
    expect(flowDisplayStrength(5)).toBe(1);
    expect(flowDisplayStrength(0.01)).toBeCloseTo(1 / 3, 12);
    expect(flowDisplayStrength(0.1)).toBeCloseTo(2 / 3, 12);
  });
});

describe('presets', () => {
  it('each preset is the midpoint of the published range it cites, on a slider step', () => {
    for (const p of RUNOFF_PRESETS) {
      expect(p.c).toBeCloseTo((p.range[0] + p.range[1]) / 2, 12);
      expect(p.c).toBeGreaterThanOrEqual(RUNOFF_C_MIN);
      expect(p.c).toBeLessThanOrEqual(RUNOFF_C_MAX);
      const steps = (p.c - RUNOFF_C_MIN) / RUNOFF_C_STEP;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
      expect(p.source.length).toBeGreaterThan(10);
    }
  });

  it('the published ranges: HEC-22 Table 3-1 and the woodland row', () => {
    const byId = Object.fromEntries(RUNOFF_PRESETS.map((p) => [p.id, p]));
    expect(byId.asphalt!.range).toEqual([0.70, 0.95]);
    expect(byId['lawn-heavy']!.range).toEqual([0.18, 0.22]);
    expect(byId['lawn-sandy']!.range).toEqual([0.10, 0.15]);
    expect(byId.unimproved!.range).toEqual([0.10, 0.30]);
    expect(byId.woodland!.range).toEqual([0.02, 0.15]);
  });

  it('names a preset only while its midpoint is the coefficient in use', () => {
    expect(presetOf(RAINFALL_DEFAULT)?.id).toBe('lawn-heavy');
    expect(presetOf({ ...RAINFALL_DEFAULT, runoffC: 0.3 })).toBeNull();
    expect(presetOf({ intensityMmH: 25, runoffC: 0.2 })).toBeNull();
  });
});

describe('assumptions', () => {
  it('states the steady state, the lumped losses, the routing surface and the area limit', () => {
    const pf = rationalAssumptions('priority-flood').join(' ');
    expect(pf).toContain('Q = C × i × A');
    expect(pf).toContain('lasts at least its time of concentration');
    expect(pf).toContain('C lumps infiltration');
    expect(pf).toContain('Priority-Flood-conditioned');
    expect(pf).toContain('0.8 km²');
    expect(pf).toContain('not a flood or water-depth prediction');
    expect(rationalAssumptions('raw').join(' ')).toContain('raw surface');
  });
});
