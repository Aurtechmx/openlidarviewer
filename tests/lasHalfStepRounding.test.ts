/**
 * LAS writers quantise X/Y/Z with halves rounded away from zero, as LAStools'
 * I32_QUANTIZE does, so a negative half step lands on the same integer a
 * LAStools write would give (Math.round sends −2.5 to −2, not −3).
 */

import { describe, it, expect } from 'vitest';
import { writeLas, writeLas14 } from '../src/convert/writeLas';
import { roundHalfAwayFromZero } from '../src/convert/lasQuantisation';
import { roundLegacyAngle } from '../src/convert/conversionEvents';
import type { GlobalPoints } from '../src/convert/globalPoints';
import { parseLasRecords } from './helpers/sourceLasQuantisation';

describe('roundHalfAwayFromZero', () => {
  it('rounds halves away from zero on both signs', () => {
    expect([-2.5, -1.5, -0.5, 0.5, 1.5, 2.5].map(roundHalfAwayFromZero)).toEqual([-3, -2, -1, 1, 2, 3]);
    expect([-2.4, -2.6, 2.4, 2.6, 0].map(roundHalfAwayFromZero)).toEqual([-2, -3, 2, 3, 0]);
  });

  it('is the rule the legacy scan-angle write uses', () => {
    expect(roundLegacyAngle(-90.5)).toBe(roundHalfAwayFromZero(-90.5));
  });
});

describe('LAS X/Y/Z quantisation of half steps', () => {
  // Scale 0.5, offset 0: every coordinate below is an exact binary half step.
  const vals = [-1.25, -0.75, -0.25, 0.25, 0.75, 1.25];
  const g: GlobalPoints = {
    count: vals.length,
    x: Float64Array.from(vals),
    y: Float64Array.from(vals.map((v) => -v)),
    z: Float64Array.from(vals),
  };
  const quantisation = { scale: [0.5, 0.5, 0.5] as [number, number, number], offset: [0, 0, 0] as [number, number, number] };
  const expected = vals.flatMap((v) => [v / 0.5, -v / 0.5, v / 0.5].map(roundHalfAwayFromZero));

  for (const [label, write] of [['1.2', writeLas], ['1.4', writeLas14]] as const) {
    it(`LAS ${label} matches half-away-from-zero`, () => {
      const out = parseLasRecords(write(g, { quantisation }));
      expect(out.scale).toEqual([0.5, 0.5, 0.5]);
      expect(Array.from(out.records)).toEqual(expected);
      // -1.25 / 0.5 = -2.5 → -3, not Math.round's -2.
      expect(out.records[0]).toBe(-3);
    });
  }
});
