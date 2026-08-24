/**
 * pdfInfoDate.test.ts — the Info-dictionary date must never come from a clock.
 *
 * The defect this guards against is subtle because the failure is intermittent:
 * two builds only differ when they straddle a second boundary. So the cases
 * that matter are the fallbacks, where reaching for `new Date()` would look
 * harmless and would reintroduce the flake.
 */

import { describe, it, expect } from 'vitest';
import { pdfInfoDate, PDF_EPOCH } from '../src/pdfInfoDate';

describe('pdfInfoDate', () => {
  it('passes a Date through unchanged', () => {
    const d = new Date('2026-03-04T05:06:07Z');
    expect(pdfInfoDate(d).getTime()).toBe(d.getTime());
  });

  it('parses an ISO string, which is how most models carry the stamp', () => {
    expect(pdfInfoDate('2026-03-04T05:06:07Z').toISOString()).toBe('2026-03-04T05:06:07.000Z');
  });

  it('accepts epoch milliseconds', () => {
    expect(pdfInfoDate(1_700_000_000_000).getTime()).toBe(1_700_000_000_000);
  });

  for (const [label, value] of [
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['an unparseable string', 'not a date'],
    ['an invalid Date', new Date('nonsense')],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ] as const) {
    it(`falls back to the epoch for ${label}, never to the clock`, () => {
      expect(pdfInfoDate(value as never).getTime()).toBe(PDF_EPOCH.getTime());
    });
  }

  it('is stable across calls, which is the property the PDFs depend on', () => {
    const a = pdfInfoDate(undefined);
    const b = pdfInfoDate(undefined);
    expect(a.getTime()).toBe(b.getTime());
  });
});
