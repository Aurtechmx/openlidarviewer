/**
 * scanFacts.test.ts — the fail-closed scan-facts normaliser.
 */

import { describe, it, expect } from 'vitest';
import { deriveScanFacts } from '../src/process/scanFacts';

describe('deriveScanFacts — unknowns default to the safe side', () => {
  it('an empty signal set yields a conservative static, no-CRS, unclassified scan', () => {
    const f = deriveScanFacts({});
    expect(f.kind).toBe('static');
    expect(f.coverage).toBe('full'); // static clouds are whole-file
    expect(f.crs).toBeNull(); // never assume a CRS
    expect(f.pointCount).toBe(0);
    expect(f.classification).toBe('none');
    expect(f.groundClassified).toBe(false);
    expect(f.hasBuildingClass).toBe(false);
    expect(f.medianSpacing).toBeUndefined();
  });

  it('a streaming scan with no coverage signal is resident-only, not full', () => {
    expect(deriveScanFacts({ kind: 'streaming' }).coverage).toBe('resident-only');
    // An explicit coverage is kept.
    expect(deriveScanFacts({ kind: 'streaming', coverage: 'full' }).coverage).toBe('full');
  });

  it('ground can never be trusted on an unclassified cloud', () => {
    // groundClassified true but classification none → forced false.
    expect(deriveScanFacts({ groundClassified: true }).groundClassified).toBe(false);
    // With classification present AND stated producer provenance, it stands.
    expect(deriveScanFacts({ groundClassified: true, classification: 'full', classificationProvenance: 'producer' }).groundClassified).toBe(true);
    // But an OMITTED provenance is fail-closed (unknown → untrusted), so ground
    // is withheld until a caller states the source.
    expect(deriveScanFacts({ groundClassified: true, classification: 'full' }).groundClassified).toBe(false);
  });

  it('a negative or non-finite point count clamps to 0', () => {
    expect(deriveScanFacts({ pointCount: -5 }).pointCount).toBe(0);
    expect(deriveScanFacts({ pointCount: NaN }).pointCount).toBe(0);
    expect(deriveScanFacts({ pointCount: 1000 }).pointCount).toBe(1000);
  });

  it('feature flags are false unless explicitly true', () => {
    const f = deriveScanFacts({ hasRgb: undefined, hasIntensity: true });
    expect(f.hasRgb).toBe(false);
    expect(f.hasIntensity).toBe(true);
  });
});
