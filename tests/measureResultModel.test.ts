/**
 * measureResultModel.test.ts: the result card says what the Measurements list
 * says. The model formats nothing; it carries the controller's own headline,
 * the trust caption and the unit-unverified notice, and a missing value stays
 * missing rather than becoming a zero.
 */
import { describe, it, expect } from 'vitest';
import { buildResultModel, NO_VALUE_TEXT } from '../src/app/measureResultModel';
import { UNIT_UNVERIFIED_MEASURE_NOTICE } from '../src/render/measure/format';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';

const green = { grade: 'green', caption: 'Well supported', reasons: [], presentable: true } as const;
const yellow = { grade: 'yellow', caption: 'Scale unverified', reasons: [], presentable: true } as const;
const red = { grade: 'red', caption: 'An endpoint sits in a void', reasons: [], presentable: false } as const;

/** A scene with every fact established, so these cases test the summary alone. */
const KNOWN_SCENE = { datumResolved: true, layers: 'single', verticalReferenceKnown: true } as const;

const sum = (over: Partial<MeasurementSummary>): MeasurementSummary =>
  ({ id: 'm1', kind: 'distance', name: 'Distance 1', value: '12.35 m', ...over }) as MeasurementSummary;

describe('buildResultModel', () => {
  it('a distance carries the list\'s own string and copies it verbatim', () => {
    const m = buildResultModel(sum({ trust: green }), KNOWN_SCENE);
    expect(m.value).toBe('12.35 m');
    expect(m.status).toBe('ok');
    expect(m.caveat).toBeNull();
    expect(m.copyText).toBe('Distance 1: 12.35 m');
    expect(m.canClip).toBe(false);
  });

  it('an area keeps its formatted unit text', () => {
    const m = buildResultModel(sum({ kind: 'area', name: 'Area 1', value: '240.1 m²' }), KNOWN_SCENE);
    expect(m.value).toBe('240.1 m²');
    expect(m.copyText).toBe('Area 1: 240.1 m²');
  });

  it('a box offers the clip action', () => {
    const m = buildResultModel(sum({ kind: 'box', name: 'Box 1', value: '4 × 4 × 4 m' }), KNOWN_SCENE);
    expect(m.canClip).toBe(true);
    expect(m.status).toBe('ok');
  });

  it('unit unverified keeps the source number and states the notice, in the copy too', () => {
    const m = buildResultModel(sum({ value: '12.35 units (unverified)', unitUnverified: true }), KNOWN_SCENE);
    expect(m.status).toBe('unit-unverified');
    expect(m.caveat).toBe(UNIT_UNVERIFIED_MEASURE_NOTICE);
    expect(m.copyText).toBe(`Distance 1: 12.35 units (unverified) (${UNIT_UNVERIFIED_MEASURE_NOTICE})`);
  });

  it('a non-presentable figure is flagged with the trust caption, never presented as plain', () => {
    const m = buildResultModel(sum({ trust: red }), KNOWN_SCENE);
    expect(m.status).toBe('not-presentable');
    expect(m.caveat).toBe('An endpoint sits in a void');
    expect(m.copyText).toContain('An endpoint sits in a void');
  });

  it('a yellow grade shows its caption but stays ok', () => {
    const m = buildResultModel(sum({ trust: yellow }), KNOWN_SCENE);
    expect(m.status).toBe('ok');
    expect(m.caveat).toBe('Scale unverified');
  });

  it('a withheld value is never replaced by zero and cannot be copied', () => {
    for (const value of ['—', '', '  ']) {
      const m = buildResultModel(sum({ value, trust: red }), KNOWN_SCENE);
      expect(m.status).toBe('no-value');
      expect(m.value).toBe(NO_VALUE_TEXT);
      expect(m.value).not.toMatch(/\b0\b/);
      expect(m.copyText).toBeNull();
      expect(m.caveat).toBe('An endpoint sits in a void');
    }
  });
});
