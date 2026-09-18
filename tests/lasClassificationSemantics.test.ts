/**
 * lasClassificationSemantics.test.ts — pins ASPRS class naming to the point
 * data record format that carries it.
 *
 * Before this module, class 12 was named "Overlap" for every format in the
 * point inspector and "Reserved (12)" in the export legend, and every code at
 * or above 19 was reported as user-defined. These tests fix the meaning of
 * both ranges so a future table cannot drift apart again.
 */

import { describe, it, expect } from 'vitest';
import {
  classificationName,
  classAllocation,
  describeClassification,
  isExtendedPdrf,
  isValidPdrf,
  FIRST_EXTENDED_PDRF,
} from '../src/lasSemantics';

describe('point data record format', () => {
  it('treats formats 6 and above as extended', () => {
    expect(isExtendedPdrf(5)).toBe(false);
    expect(isExtendedPdrf(FIRST_EXTENDED_PDRF)).toBe(true);
    expect(isExtendedPdrf(10)).toBe(true);
  });

  it('accepts only the formats the specification defines', () => {
    expect(isValidPdrf(0)).toBe(true);
    expect(isValidPdrf(10)).toBe(true);
    expect(isValidPdrf(11)).toBe(false);
    expect(isValidPdrf(-1)).toBe(false);
    expect(isValidPdrf(2.5)).toBe(false);
  });
});

describe('class 12 depends on the format', () => {
  it('is Overlap Points in the legacy formats', () => {
    for (const pdrf of [0, 1, 2, 3, 4, 5]) {
      expect(classificationName(12, pdrf)).toBe('Overlap Points');
    }
  });

  it('is reserved in the extended formats', () => {
    for (const pdrf of [6, 7, 8, 9, 10]) {
      expect(classificationName(12, pdrf)).toBe('Reserved');
      expect(classAllocation(12, pdrf)).toBe('reserved');
    }
  });

  it('never names an extended class 12 Overlap', () => {
    expect(classificationName(12, 6)).not.toMatch(/overlap/i);
  });
});

describe('codes 19 to 22 are defined, not user-defined', () => {
  it.each([
    [19, 'Overhead Structure'],
    [20, 'Ignored Ground'],
    [21, 'Snow'],
    [22, 'Temporal Exclusion'],
  ])('names extended class %i as %s', (code, name) => {
    expect(classificationName(code, 6)).toBe(name);
    expect(classAllocation(code, 6)).toBe('defined');
  });

  it('reports 23 to 63 as reserved rather than user-definable', () => {
    for (const code of [23, 40, 63]) {
      expect(classAllocation(code, 6)).toBe('reserved');
      expect(classificationName(code, 6)).toBe(`Reserved (${code})`);
    }
  });

  it('reports 64 and above as user definable', () => {
    for (const code of [64, 128, 255]) {
      expect(classAllocation(code, 6)).toBe('user-definable');
      expect(classificationName(code, 6)).toBe(`User definable (${code})`);
    }
  });
});

describe('the legacy table keeps its own meanings', () => {
  it.each([
    [8, 'Model Key-point'],
    [9, 'Water'],
    [2, 'Ground'],
  ])('names legacy class %i as %s', (code, name) => {
    expect(classificationName(code, 1)).toBe(name);
  });

  it('names rail and road surface only in the extended table', () => {
    expect(classificationName(10, 6)).toBe('Rail');
    expect(classificationName(11, 6)).toBe('Road Surface');
    expect(classificationName(10, 1)).toBe('Reserved');
    expect(classificationName(11, 1)).toBe('Reserved');
  });
});

describe('overlap reads beside the base class, not instead of it', () => {
  it('keeps the base class when the overlap flag is set', () => {
    const shown = describeClassification(2, 6, {
      synthetic: false,
      keyPoint: false,
      withheld: false,
      overlap: true,
    });
    expect(shown).toBe('Ground · Overlap');
  });

  it('shows the base class alone when no flag is set', () => {
    expect(describeClassification(6, 6)).toBe('Building');
  });
});

describe('invalid input', () => {
  it('does not invent a name for an out-of-range code', () => {
    expect(classificationName(-1, 6)).toBe('Invalid (-1)');
    expect(classificationName(256, 6)).toBe('Invalid (256)');
  });
});
