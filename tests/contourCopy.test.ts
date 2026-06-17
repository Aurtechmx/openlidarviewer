/**
 * contourCopy.test.ts — honest-UX copy + formatting specs,
 * including a voice guard against marketing filler.
 */

import { describe, it, expect } from 'vitest';
import {
  ANALYSE_LABELS,
  ANALYSE_DESCRIPTIONS,
  WHAT_THIS_ANSWERS,
  GRADE_MEANING,
  NOT_SURVEY_GRADE,
  confidenceWord,
  formatHonestValue,
  describeIntervalOption,
  recommendIntervalText,
} from '../src/terrain/contour/contourCopy';
import type { IntervalGateResult, IntervalOption } from '../src/terrain/contour/intervalGate';

describe('formatHonestValue', () => {
  it('shows an explained dash when the value is absent', () => {
    const d = formatHonestValue({ value: null, reasonWhenAbsent: 'No points landed here.' });
    expect(d.text).toBe('—');
    expect(d.isAbsent).toBe(true);
    expect(d.detail).toBe('No points landed here.');
    expect(d.confidenceText).toBeNull();
  });

  it('falls back to a default reason when none is given', () => {
    expect(formatHonestValue({ value: Number.NaN }).detail).toMatch(/no data/i);
  });

  it('pairs a value with its confidence word', () => {
    const d = formatHonestValue({ value: 12.3, confidence: 92, units: 'm' });
    expect(d.text).toBe('12.30 m');
    expect(d.confidenceText).toBe('92% confident (high)');
    expect(d.isAbsent).toBe(false);
  });

  it('omits confidence text when confidence is unknown', () => {
    const d = formatHonestValue({ value: 5, units: '%', digits: 0 });
    expect(d.text).toBe('5 %');
    expect(d.confidenceText).toBeNull();
  });
});

describe('confidenceWord', () => {
  it('maps to high/moderate/low at the evidence thresholds', () => {
    expect(confidenceWord(90)).toBe('high');
    expect(confidenceWord(50)).toBe('moderate');
    expect(confidenceWord(10)).toBe('low');
    expect(confidenceWord(Number.NaN)).toBe('low');
  });
});

describe('interval copy', () => {
  const opt = (intervalM: number, supported: boolean, reason = ''): IntervalOption => ({
    intervalM,
    supported,
    reason,
  });

  it('describes supported and unsupported options plainly', () => {
    expect(describeIntervalOption(opt(2, true))).toBe('2 m contours');
    expect(describeIntervalOption(opt(0.5, false, 'finer than 2× surface error'))).toMatch(
      /unavailable/i,
    );
  });

  it('recommends an interval or admits none is reliable', () => {
    const ok: IntervalGateResult = { options: [], recommendedM: 2, warnings: [] };
    const none: IntervalGateResult = { options: [], recommendedM: null, warnings: [] };
    expect(recommendIntervalText(ok)).toMatch(/Suggested: 2 m/);
    expect(recommendIntervalText(none)).toMatch(/no contour interval is reliable/i);
  });
});

describe('grade meanings', () => {
  it('explains every evidence grade', () => {
    expect(GRADE_MEANING.solid).toBeTruthy();
    expect(GRADE_MEANING.dashed).toMatch(/interpolated/i);
    expect(GRADE_MEANING.gap).toMatch(/no reliable data/i);
  });
});

describe('voice guard — plain language, no marketing filler', () => {
  it('contains no marketing filler', () => {
    const banned = [
      'leverage',
      'robust',
      'seamless',
      'powerful',
      'comprehensive',
      'delve',
      'showcase',
      'elevate',
      'transform',
      'utilize',
      'cutting-edge',
      'unlock',
      'effortless',
    ];
    const corpus = [
      ...Object.values(ANALYSE_LABELS),
      ...Object.values(ANALYSE_DESCRIPTIONS),
      ...WHAT_THIS_ANSWERS,
      ...Object.values(GRADE_MEANING),
      NOT_SURVEY_GRADE,
    ]
      .join(' ')
      .toLowerCase();
    for (const word of banned) expect(corpus.includes(word)).toBe(false);
  });
});
