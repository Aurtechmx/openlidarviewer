/**
 * profileAxes.test.ts
 *
 * Covers the profile axis generator across seven decades of range, on
 * degenerate input, and over the vertical-reference wording.
 *
 * Exactness check. A tick is asserted to be an exact multiple of its step by
 * dividing and comparing to the nearest integer with a RELATIVE tolerance, not
 * by `value % step === 0`. Neither a decimal tick nor a decimal step is exactly
 * representable in binary — `0.3 % 0.1` is 0.09999999999999998, so a remainder
 * test would reject a correct tick — and at an index of 5 × 10¹⁴ an absolute
 * epsilon sits below the spacing of the doubles involved and would never fire.
 * The label is asserted separately: it must round-trip to the tick and match a
 * plain decimal shape, which is what "no float noise" means on screen.
 */

import { describe, it, expect } from 'vitest';
import {
  axisTicks,
  minorTickStep,
  minorTickValues,
  formatAxisValue,
  chainageTickLabels,
  stationTickLabels,
  stationMarkerLabels,
  axisSpanCaption,
  axisTitle,
  chainageAxisTitle,
  heightAxisTitle,
  profileHeightWord,
  profileAxes,
  CHAINAGE_AXIS_WORD,
  PROFILE_LOCAL_HEIGHT_WORD,
  DEFAULT_TARGET_TICKS,
  MAX_AXIS_TICKS,
  type AxisTicks,
} from '../src/render/measure/profileAxes';
import { formatStation } from '../src/render/measure/profileSummary';
import { heightLabel } from '../src/geo/height';
import type { VerticalReference } from '../src/geo/height';
import type {
  ProfileView,
  ProfileViewport,
  ProfileUnitContext,
} from '../src/render/measure/profileViewTransform';

/** Plain decimal, optional sign, no exponent and no residue tail. */
const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** Multiples of `step` divide to an integer within a relative tolerance. */
function isExactMultiple(value: number, step: number): boolean {
  const q = value / step;
  const nearest = Math.round(q);
  return Math.abs(q - nearest) <= 1e-9 * Math.max(1, Math.abs(q));
}

function assertWellFormed(t: AxisTicks, lo: number, hi: number, target: number): void {
  expect(Number.isFinite(t.step)).toBe(true);
  expect(t.step).toBeGreaterThan(0);
  expect(t.values.length).toBeGreaterThan(0);
  expect(t.values.length).toBeLessThanOrEqual(MAX_AXIS_TICKS);
  expect(Number.isInteger(t.decimals)).toBe(true);
  expect(t.decimals).toBeGreaterThanOrEqual(0);
  expect([4, 5]).toContain(t.minorPerMajor);

  for (let i = 0; i < t.values.length; i++) {
    const v = t.values[i]!;
    expect(Number.isFinite(v)).toBe(true);
    expect(isExactMultiple(v, t.step)).toBe(true);
    if (i > 0) expect(v).toBeGreaterThan(t.values[i - 1]!);
  }

  // The step's leading digit is 1, 2 or 5, and the minor rule follows it.
  const exp = Math.round(Math.log10(t.step / mantissaOf(t.step)));
  expect([1, 2, 5]).toContain(mantissaOf(t.step));
  expect(Number.isFinite(exp)).toBe(true);
  expect(t.minorPerMajor).toBe(mantissaOf(t.step) === 2 ? 4 : 5);
  // Each minor division lands on a round decimal fraction of the major step.
  expect([1, 2, 5]).toContain(mantissaOf(minorTickStep(t)));

  // `decimals` is exactly what the step needs: it round-trips there and, when
  // it is not zero, one place fewer loses the step. Too few decimals and the
  // first check fails; too many and the second passes where it should not.
  expect(Number(t.step.toFixed(t.decimals))).toBe(t.step);
  if (t.decimals > 0) {
    expect(Number(t.step.toFixed(t.decimals - 1))).not.toBe(t.step);
  }

  const labels = chainageTickLabels(t);
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]!;
    expect(label).toMatch(PLAIN_DECIMAL);
    expect(Number(label)).toBe(t.values[i]!);
    const dot = label.indexOf('.');
    expect(dot < 0 ? 0 : label.length - dot - 1).toBe(t.decimals);
  }

  const span = hi - lo;
  if (span > 0) {
    const pad = t.step * 1e-9;
    for (const v of t.values) {
      expect(v).toBeGreaterThanOrEqual(lo - pad);
      expect(v).toBeLessThanOrEqual(hi + pad);
    }
    // The chosen step is at least span/target and at most 2.5 × that, so the
    // count lands between target/2.5 - 1 and target + 1.
    expect(t.values.length).toBeGreaterThanOrEqual(Math.max(1, Math.floor(target / 2.5) - 1));
    expect(t.values.length).toBeLessThanOrEqual(target + 1);
  }
}

/** Leading digit of a 1/2/5 × 10ⁿ step. */
function mantissaOf(step: number): number {
  const e = Math.floor(Math.log10(step) + 1e-12);
  const m = step / Math.pow(10, e);
  return Math.round(m * 1e6) / 1e6;
}

const DECADES = [1e-6, 0.05, 1, 7, 250, 1e6, 1e9];
const TARGETS = [2, 4, 6, 8, 10, 25];

describe('axisTicks across decades', () => {
  for (const span of DECADES) {
    for (const target of TARGETS) {
      it(`span ${span} at ~${target} ticks`, () => {
        assertWellFormed(axisTicks(0, span, target), 0, span, target);
      });
      it(`span ${span} offset off a boundary at ~${target} ticks`, () => {
        const lo = span * 0.317;
        const hi = lo + span;
        assertWellFormed(axisTicks(lo, hi, target), lo, hi, target);
      });
      it(`span ${span} straddling zero at ~${target} ticks`, () => {
        assertWellFormed(axisTicks(-span / 2, span / 2, target), -span / 2, span / 2, target);
      });
    }
  }

  it('holds exactness on a decimal step where a remainder test would not', () => {
    const t = axisTicks(0, 0.5, 5);
    expect(t.step).toBe(0.1);
    expect(t.values).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(chainageTickLabels(t)).toEqual(['0.0', '0.1', '0.2', '0.3', '0.4', '0.5']);
    // The residue test this module avoids: 0.3 % 0.1 is not zero.
    expect(0.3 % 0.1).toBeGreaterThan(0);
  });

  it('emits no float noise where naive arithmetic would', () => {
    const t = axisTicks(0, 0.7, 7);
    for (const label of chainageTickLabels(t)) {
      expect(label).not.toMatch(/0000000|9999999/);
    }
    expect(chainageTickLabels(axisTicks(11.9, 12.1, 4))).toContain('12.00');
  });
});

describe('axisTicks exact placements', () => {
  it('places round ticks over 0..100', () => {
    const t = axisTicks(0, 100, 5);
    expect(t.step).toBe(20);
    expect(t.decimals).toBe(0);
    expect(t.values).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('starts at or above the low bound, never below it', () => {
    const t = axisTicks(3, 97, 5);
    expect(t.step).toBe(20);
    expect(t.values).toEqual([20, 40, 60, 80]);
    expect(t.values[0]!).toBeGreaterThanOrEqual(3);
  });

  it('ends at or below the high bound', () => {
    const t = axisTicks(1, 9, 4);
    expect(t.step).toBe(2);
    expect(t.values).toEqual([2, 4, 6, 8]);
  });

  it('counts inclusively at both ends', () => {
    const t = axisTicks(0, 10, 5);
    expect(t.values).toEqual([0, 2, 4, 6, 8, 10]);
    expect(t.values.length).toBe(6);
  });

  it('keeps the 2 of the 1/2/5 progression', () => {
    const t = axisTicks(0, 12, 6);
    expect(t.step).toBe(2);
    expect(mantissaOf(t.step)).toBe(2);
  });

  it('keeps the 2 of the progression below one', () => {
    const t = axisTicks(0, 1.2, 6);
    expect(t.step).toBe(0.2);
    expect(mantissaOf(t.step)).toBe(2);
  });

  it('keeps the 5 of the progression', () => {
    const t = axisTicks(0, 30, 6);
    expect(t.step).toBe(5);
    expect(mantissaOf(t.step)).toBe(5);
  });

  it('keeps the 1 of the progression', () => {
    const t = axisTicks(0, 6, 6);
    expect(t.step).toBe(1);
    expect(mantissaOf(t.step)).toBe(1);
  });

  it('sets decimals from the step, not from the value', () => {
    expect(axisTicks(0, 100, 5).decimals).toBe(0);
    expect(axisTicks(0, 0.5, 5).decimals).toBe(1);
    expect(axisTicks(0, 0.25, 5).decimals).toBe(2);
    expect(axisTicks(0, 2.5e-6, 5).decimals).toBe(7);
    expect(axisTicks(0, 1e9, 5).decimals).toBe(0);
  });
});

describe('minor subdivisions', () => {
  it('splits a 1 step into 5', () => {
    const t = axisTicks(0, 6, 6);
    expect(t.step).toBe(1);
    expect(t.minorPerMajor).toBe(5);
    expect(minorTickStep(t)).toBeCloseTo(0.2, 12);
  });

  it('splits a 2 step into 4', () => {
    const t = axisTicks(0, 12, 6);
    expect(t.step).toBe(2);
    expect(t.minorPerMajor).toBe(4);
    expect(minorTickStep(t)).toBeCloseTo(0.5, 12);
  });

  it('splits a 5 step into 5', () => {
    const t = axisTicks(0, 30, 6);
    expect(t.step).toBe(5);
    expect(t.minorPerMajor).toBe(5);
    expect(minorTickStep(t)).toBeCloseTo(1, 12);
  });

  it('omits the major positions from the minor list', () => {
    const t = axisTicks(0, 10, 5);
    const minors = minorTickValues(t, 0, 10);
    expect(minors.length).toBeGreaterThan(0);
    for (const m of minors) {
      expect(Number.isFinite(m)).toBe(true);
      expect(t.values).not.toContain(m);
      expect(isExactMultiple(m, minorTickStep(t))).toBe(true);
    }
  });

  it('returns an empty minor list for a zero-width range', () => {
    const t = axisTicks(5, 5, 6);
    expect(minorTickValues(t, 5, 5).length).toBeLessThanOrEqual(1);
  });
});

describe('degenerate input', () => {
  const CASES: ReadonlyArray<readonly [string, number, number, number]> = [
    ['zero range at zero', 0, 0, 6],
    ['zero range at a round value', 250, 250, 6],
    ['zero range off a boundary', 7.3, 7.3, 6],
    ['zero range negative', -412.75, -412.75, 6],
    ['inverted range', 100, 0, 6],
    ['inverted range off a boundary', 9.5, -3.25, 6],
    ['NaN low', Number.NaN, 100, 6],
    ['NaN high', 0, Number.NaN, 6],
    ['both NaN', Number.NaN, Number.NaN, 6],
    ['infinite low', Number.NEGATIVE_INFINITY, 100, 6],
    ['infinite high', 0, Number.POSITIVE_INFINITY, 6],
    ['both infinite', Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, 6],
    ['target zero', 0, 100, 0],
    ['target one', 0, 100, 1],
    ['target negative', 0, 100, -8],
    ['target NaN', 0, 100, Number.NaN],
    ['target infinite', 0, 100, Number.POSITIVE_INFINITY],
    ['target fractional', 0, 100, 4.7],
    ['target absurd', 0, 100, 1e9],
  ];

  for (const [name, lo, hi, target] of CASES) {
    it(`${name} yields finite ticks without throwing`, () => {
      const t = axisTicks(lo, hi, target);
      expect(t.values.length).toBeGreaterThan(0);
      expect(t.values.length).toBeLessThanOrEqual(MAX_AXIS_TICKS);
      expect(Number.isFinite(t.step)).toBe(true);
      expect(t.step).toBeGreaterThan(0);
      for (const v of t.values) {
        expect(Number.isFinite(v)).toBe(true);
        expect(isExactMultiple(v, t.step)).toBe(true);
      }
      for (const label of chainageTickLabels(t)) expect(label).toMatch(PLAIN_DECIMAL);
    });
  }

  it('reads an inverted range as its ordered pair', () => {
    expect(axisTicks(100, 0, 5)).toEqual(axisTicks(0, 100, 5));
  });

  it('yields at least one tick for a zero range', () => {
    for (const v of [0, 1, 7.3, -412.75, 1e9, 1e-6]) {
      expect(axisTicks(v, v, 6).values.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('bounds the tick count under an absurd target', () => {
    expect(axisTicks(0, 1e9, 1e9).values.length).toBeLessThanOrEqual(MAX_AXIS_TICKS);
  });

  it('separates ticks at a magnitude where a fine step could not', () => {
    const t = axisTicks(1e9, 1e9 + 1e-6, 6);
    for (let i = 1; i < t.values.length; i++) {
      expect(t.values[i]!).toBeGreaterThan(t.values[i - 1]!);
    }
  });

  it('formats a non-finite tick value as an em dash', () => {
    expect(formatAxisValue(Number.NaN, 2)).toBe('—');
    expect(formatAxisValue(Number.POSITIVE_INFINITY, 2)).toBe('—');
    expect(formatAxisValue(1.5, Number.NaN)).toBe('2');
  });
});

describe('chainage labels and civil stationing', () => {
  const METRIC_UNITS: ProfileUnitContext = { horizontalToMetres: 1, verticalToMetres: 1 };
  const UNKNOWN_UNITS: ProfileUnitContext = {
    horizontalToMetres: null,
    verticalToMetres: 1,
  };

  it('gives plain chainage labels as bare numbers', () => {
    const t = axisTicks(0, 500, 5);
    expect(chainageTickLabels(t)).toEqual(['0', '100', '200', '300', '400', '500']);
  });

  it('gives civil stationing through the shared station formatter', () => {
    const t = axisTicks(0, 2000, 4);
    const labels = stationTickLabels(t, METRIC_UNITS, 'metric');
    expect(labels).not.toBeNull();
    expect(labels).toEqual(t.values.map((v) => formatStation(v, 'metric')));
    expect(labels![0]).toBe('0+000.00');
    expect(labels).toContain('1+000.00');
  });

  it('gives imperial stationing through the same formatter', () => {
    const t = axisTicks(0, 200, 4);
    const labels = stationTickLabels(t, METRIC_UNITS, 'imperial');
    expect(labels).toEqual(t.values.map((v) => formatStation(v, 'imperial')));
  });

  it('converts a foot-unit chainage before stationing it', () => {
    const feet: ProfileUnitContext = {
      horizontalToMetres: 0.3048,
      verticalToMetres: 0.3048,
    };
    const t = axisTicks(0, 1000, 4);
    const labels = stationTickLabels(t, feet, 'metric');
    expect(labels).toEqual(t.values.map((v) => formatStation(v * 0.3048, 'metric')));
  });

  it('refuses stationing when the horizontal metres scale is unknown', () => {
    const t = axisTicks(0, 2000, 4);
    expect(stationTickLabels(t, UNKNOWN_UNITS, 'metric')).toBeNull();
    expect(
      stationTickLabels(t, { horizontalToMetres: 0, verticalToMetres: 1 }, 'metric'),
    ).toBeNull();
    expect(
      stationTickLabels(t, { horizontalToMetres: Number.NaN, verticalToMetres: 1 }, 'metric'),
    ).toBeNull();
  });

  it('labels emitted station markers with the same formatter', () => {
    const stations = [
      { chainage: 0, position: [0, 0, 0] as [number, number, number], isEndpoint: false },
      { chainage: 50, position: [50, 0, 0] as [number, number, number], isEndpoint: false },
      { chainage: 73.4, position: [73.4, 0, 0] as [number, number, number], isEndpoint: true },
    ];
    expect(stationMarkerLabels(stations, 1, 'metric')).toEqual([
      formatStation(0, 'metric'),
      formatStation(50, 'metric'),
      formatStation(73.4, 'metric'),
    ]);
  });

  it('captions a span on the significant-figure policy', () => {
    expect(axisSpanCaption(247.5312, 'm')).toBe('247.53 m');
    expect(axisSpanCaption(247.5312, null)).toBe('247.53');
    expect(axisSpanCaption(Number.NaN, 'm')).toBe('—');
  });
});

describe('axis titles', () => {
  it('titles the chainage axis with its own unit', () => {
    expect(chainageAxisTitle('m')).toBe('Chainage (m)');
    expect(chainageAxisTitle('ft')).toBe('Chainage (ft)');
    expect(chainageAxisTitle(null)).toBe(CHAINAGE_AXIS_WORD);
    expect(chainageAxisTitle('  ')).toBe(CHAINAGE_AXIS_WORD);
  });

  it('carries a different unit on each axis', () => {
    const model = profileAxes(VIEW, VIEWPORT, {
      reference: 'orthometric',
      horizontalUnit: 'm',
      verticalUnit: 'ft',
      units: { horizontalToMetres: 1, verticalToMetres: 0.3048 },
    });
    expect(model.x.title).toBe('Chainage (m)');
    expect(model.y.title).toBe('Elevation (ft)');
  });

  const WORDS: ReadonlyArray<readonly [VerticalReference, string]> = [
    ['orthometric', 'Elevation'],
    ['ellipsoidal', 'Ellipsoidal height'],
    ['depth', 'Depth'],
    ['unknown', 'Height (datum unknown)'],
    ['local', 'Local height'],
  ];

  for (const [reference, word] of WORDS) {
    it(`says "${word}" for a ${reference} reference`, () => {
      expect(profileHeightWord(reference)).toBe(word);
      expect(heightAxisTitle(reference, 'm')).toBe(`${word} (m)`);
      expect(heightAxisTitle(reference, null)).toBe(word);
    });
  }

  it('claims an elevation only where an orthometric datum was declared', () => {
    for (const [reference] of WORDS) {
      const asserts = profileHeightWord(reference) === 'Elevation';
      expect(asserts).toBe(reference === 'orthometric');
    }
  });

  it('never says "Elevation" without a datum', () => {
    expect(profileHeightWord('unknown')).not.toContain('Elevation');
    expect(profileHeightWord('local')).not.toContain('Elevation');
    expect(heightAxisTitle('unknown', 'm')).not.toContain('Elevation');
    expect(heightAxisTitle('local', 'ft')).not.toContain('Elevation');
  });

  it('defers to the shared height wording for every non-local reference', () => {
    for (const reference of ['orthometric', 'ellipsoidal', 'depth', 'unknown'] as const) {
      expect(profileHeightWord(reference)).toBe(heightLabel(reference));
    }
    expect(PROFILE_LOCAL_HEIGHT_WORD).toBe('Local height');
  });

  it('leaves a word alone when its unit is unknown', () => {
    expect(axisTitle('Chainage', null)).toBe('Chainage');
    expect(axisTitle('Chainage', 'm')).toBe('Chainage (m)');
  });
});

const VIEW: ProfileView = {
  centreChainage: 250,
  centreHeight: 120,
  pxPerChainage: 2,
  pxPerHeight: 4,
};

const VIEWPORT: ProfileViewport = { width: 800, height: 400, devicePixelRatio: 1 };

describe('profileAxes over a view', () => {
  const BASE = {
    reference: 'unknown' as VerticalReference,
    horizontalUnit: 'm',
    verticalUnit: 'm',
    units: { horizontalToMetres: 1, verticalToMetres: 1 } satisfies ProfileUnitContext,
  };

  it('produces one label and one pixel per tick', () => {
    const model = profileAxes(VIEW, VIEWPORT, BASE);
    expect(model.x.labels.length).toBe(model.x.ticks.values.length);
    expect(model.x.pixels.length).toBe(model.x.ticks.values.length);
    expect(model.y.labels.length).toBe(model.y.ticks.values.length);
    expect(model.y.pixels.length).toBe(model.y.ticks.values.length);
  });

  it('places ticks inside the drawable area', () => {
    const model = profileAxes(VIEW, VIEWPORT, BASE);
    for (const px of model.x.pixels) {
      expect(px).toBeGreaterThanOrEqual(-1);
      expect(px).toBeLessThanOrEqual(VIEWPORT.width + 1);
    }
    for (const py of model.y.pixels) {
      expect(py).toBeGreaterThanOrEqual(-1);
      expect(py).toBeLessThanOrEqual(VIEWPORT.height + 1);
    }
  });

  it('runs height upward on screen', () => {
    const model = profileAxes(VIEW, VIEWPORT, BASE);
    for (let i = 1; i < model.y.pixels.length; i++) {
      expect(model.y.pixels[i]!).toBeLessThan(model.y.pixels[i - 1]!);
    }
  });

  it('titles the height axis honestly for an undeclared datum', () => {
    expect(profileAxes(VIEW, VIEWPORT, BASE).y.title).toBe('Height (datum unknown) (m)');
  });

  it('switches the chainage axis to stationing on request', () => {
    const model = profileAxes(VIEW, VIEWPORT, { ...BASE, stationing: true });
    expect(model.x.labels[0]).toMatch(/^-?\d+\+\d+\.\d{2}$/);
  });

  it('falls back to plain chainage when stationing cannot be stated', () => {
    const model = profileAxes(VIEW, VIEWPORT, {
      ...BASE,
      stationing: true,
      units: { horizontalToMetres: null, verticalToMetres: null },
    });
    for (const label of model.x.labels) expect(label).toMatch(PLAIN_DECIMAL);
  });

  it('honours the default target tick count', () => {
    const model = profileAxes(VIEW, VIEWPORT, BASE);
    expect(model.x.ticks.values.length).toBeLessThanOrEqual(DEFAULT_TARGET_TICKS + 1);
    expect(model.y.ticks.values.length).toBeLessThanOrEqual(DEFAULT_TARGET_TICKS + 1);
  });

  it('honours an explicit target per axis', () => {
    const model = profileAxes(VIEW, VIEWPORT, {
      ...BASE,
      targetXTicks: 10,
      targetYTicks: 3,
    });
    expect(model.x.ticks.values.length).toBeGreaterThan(model.y.ticks.values.length);
  });

  it('emits minor positions between the major ones', () => {
    const model = profileAxes(VIEW, VIEWPORT, BASE);
    expect(model.x.minorPixels.length).toBeGreaterThan(model.x.pixels.length);
    for (const px of model.x.minorPixels) expect(Number.isFinite(px)).toBe(true);
  });
});
