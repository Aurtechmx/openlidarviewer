/**
 * classificationProvenance.test.ts — OLV-derived classification must not read as
 * surveyed producer classification. Derived / manual / unknown ground can at
 * most reach `review`; only producer ground is GROUND_TRUSTED.
 */

import { describe, it, expect } from 'vitest';
import { deriveScanFacts } from '../src/process/scanFacts';
import { signalsFromLive } from '../src/app/processStudioMount';
import type { LiveScanAccessors } from '../src/app/processStudioMount';
import { evaluateCapabilities, capabilityFor } from '../src/process/processCapabilities';
import type { ScanFacts } from '../src/process/ProcessPlan';

const metreCrs: ScanFacts['crs'] = { source: 'epsg', name: 'X', linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false } as ScanFacts['crs'];

describe('deriveScanFacts gates ground/building trust on provenance', () => {
  const raw = { kind: 'static' as const, coverage: 'full' as const, crs: metreCrs, pointCount: 1000, classification: 'full' as const, groundClassified: true, hasBuildingClass: true };

  it('an OMITTED provenance is fail-closed to unknown, never trusted', () => {
    const facts = deriveScanFacts(raw); // no provenance stated → unknown, untrusted
    expect(facts.classificationProvenance).toBe('unknown');
    expect(facts.groundClassified).toBe(false);
    expect(facts.hasBuildingClass).toBe(false);
  });

  it('an explicitly-stated producer classification is trusted', () => {
    const facts = deriveScanFacts({ ...raw, classificationProvenance: 'producer' });
    expect(facts.classificationProvenance).toBe('producer');
    expect(facts.groundClassified).toBe(true);
    expect(facts.hasBuildingClass).toBe(true);
  });

  it('OLV-derived classification is NOT trusted', () => {
    const facts = deriveScanFacts({ ...raw, classificationProvenance: 'derived' });
    expect(facts.classificationProvenance).toBe('derived');
    expect(facts.groundClassified).toBe(false);
    expect(facts.hasBuildingClass).toBe(false);
  });

  it('manual and unknown provenance are also not trusted', () => {
    expect(deriveScanFacts({ ...raw, classificationProvenance: 'manual' }).groundClassified).toBe(false);
    expect(deriveScanFacts({ ...raw, classificationProvenance: 'unknown' }).groundClassified).toBe(false);
  });

  it('unclassified scan reports provenance none', () => {
    expect(deriveScanFacts({ ...raw, classification: 'none', groundClassified: false }).classificationProvenance).toBe('none');
  });
});

describe('the capability model demotes derived ground to review', () => {
  const dtmFor = (provenance: 'producer' | 'derived') => {
    const facts = deriveScanFacts({ kind: 'static', coverage: 'full', crs: metreCrs, pointCount: 1000, classification: 'full', groundClassified: true, classificationProvenance: provenance });
    return capabilityFor(evaluateCapabilities({ scans: [facts] }), 'dtm')!;
  };
  it('producer ground → DTM ready (GROUND_TRUSTED)', () => {
    expect(dtmFor('producer').reasonCode).toBe('GROUND_TRUSTED');
  });
  it('derived ground → DTM review (GROUND_DERIVED), never trusted', () => {
    const cap = dtmFor('derived');
    expect(cap.readiness).toBe('review');
    expect(cap.reasonCode).toBe('GROUND_DERIVED');
  });
});

describe('signalsFromLive maps the derived flag to provenance', () => {
  const base: LiveScanAccessors = {
    getStreamingPointCount: () => null, getActivePointCount: () => 1000, getResolvedCrs: () => metreCrs,
    getPresentClassCodes: () => [2, 6], getClassificationDerived: () => false,
  };
  it('producer classification → provenance producer, ground trusted', () => {
    const s = signalsFromLive(base)!;
    expect(s.classificationProvenance).toBe('producer');
    expect(deriveScanFacts(s).groundClassified).toBe(true);
  });
  it('OLV-derived classification → provenance derived, ground not trusted', () => {
    const s = signalsFromLive({ ...base, getClassificationDerived: () => true })!;
    expect(s.classificationProvenance).toBe('derived');
    expect(deriveScanFacts(s).groundClassified).toBe(false);
  });
});
