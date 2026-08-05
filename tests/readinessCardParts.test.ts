/**
 * readinessCardParts.test.ts
 *
 * The Analyse panel's readiness cards set a big figure with the unit as a narrow
 * subscript beside it. A short real unit ("m", "%", "ft", "% meas.") belongs in
 * that slot, but a long word-y annotation — "(vertical unit unverified)" on the
 * CONTOUR READINESS card when the scan's vertical unit is unresolved — collapsed
 * the narrow slot into a one-char-per-line column. These assert the long unit is
 * kept OUT of the subscript and folded onto the detail line instead, while the
 * short units still render in the subscript exactly as before.
 */

import { describe, it, expect } from 'vitest';
import { splitReadinessValue, readinessCardParts } from '../src/ui/AnalysePanel';

describe('splitReadinessValue', () => {
  it('splits a leading figure from its unit', () => {
    expect(splitReadinessValue('68%')).toEqual({ num: '68', unit: '%' });
    expect(splitReadinessValue('31% measured')).toEqual({ num: '31', unit: '% measured' });
    expect(splitReadinessValue('1 m')).toEqual({ num: '1', unit: 'm' });
    expect(splitReadinessValue('Not ready')).toEqual({ num: 'Not ready', unit: '' });
  });
});

describe('readinessCardParts', () => {
  it('keeps short real units in the compact subscript', () => {
    expect(readinessCardParts('68%', 'x').unitText).toBe('%');
    expect(readinessCardParts('1 m', 'x').unitText).toBe('m');
    expect(readinessCardParts('10 ft', 'x').unitText).toBe('ft');
    expect(readinessCardParts('31% measured', 'x').unitText).toBe('% meas.');
  });

  it('keeps a long/multi-word unit OUT of the compact subscript', () => {
    const parts = readinessCardParts('10 (vertical unit unverified)', 'Coverage 60%');
    expect(parts.num).toBe('10');
    // The big figure stays a clean number, and the long annotation never lands
    // in the narrow subscript (which is what wrapped one char per line).
    expect(parts.unitText).toBe('');
    expect(parts.unitText).not.toContain('vertical');
    // The caveat is preserved for the reader, on the normally-wrapping detail.
    expect(parts.detailText).toBe('Coverage 60% · (vertical unit unverified)');
  });

  it('does not duplicate the caveat when the detail already carries it', () => {
    const detail = 'Coverage 60% · relief 12.3 (vertical unit unverified)';
    const parts = readinessCardParts('10 (vertical unit unverified)', detail);
    expect(parts.unitText).toBe('');
    expect(parts.detailText).toBe(detail);
  });
});
