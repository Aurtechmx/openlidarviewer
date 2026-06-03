/**
 * crsValidation.test.ts
 *
 * Pure contract tests for the CRS measurement-safety classifier. Each
 * `ResolvedCrs` kind is pinned to its verdict so a regression flips a
 * named case instead of a vague "wrong empty state".
 */

import { describe, it, expect } from 'vitest';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import {
  crsCaveatLine,
  shouldBlockMetricHeadline,
  validateCrsForMeasurement,
} from '../src/geo/CrsValidation';

function make(overrides: Partial<ResolvedCrs> = {}): ResolvedCrs {
  return {
    kind: 'projected',
    name: 'EPSG:26918',
    epsg: 26918,
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    source: 'las-vlr',
    confidence: 'high',
    userConfirmed: false,
    ...overrides,
  };
}

describe('validateCrsForMeasurement — projected CRS', () => {
  it('returns safe-metric for a standard UTM zone', () => {
    const r = validateCrsForMeasurement(make());
    expect(r.validity).toBe('safe-metric');
    expect(r.severity).toBe('ok');
    expect(r.canDisplayMetric).toBe(true);
    expect(r.canSaveMeasurement).toBe(true);
  });

  it('returns safe-metric even when units are US survey feet', () => {
    const r = validateCrsForMeasurement(
      make({ linearUnit: 'us-survey-foot', linearUnitToMetres: 0.304800609601 }),
    );
    expect(r.validity).toBe('safe-metric');
    expect(r.canDisplayMetric).toBe(true);
  });

  it('caveat is empty for safe-metric', () => {
    const r = validateCrsForMeasurement(make());
    expect(crsCaveatLine(r)).toBe('');
  });
});

describe('validateCrsForMeasurement — local coordinates', () => {
  it('returns safe-explicit-local for a phone-scan-style dataset', () => {
    const r = validateCrsForMeasurement(
      make({
        kind: 'local',
        name: 'Local coordinates (no CRS)',
        linearUnit: 'unknown',
        linearUnitToMetres: 1,
        confidence: 'high',
      }),
    );
    expect(r.validity).toBe('safe-explicit-local');
    expect(r.severity).toBe('caution');
    expect(r.canDisplayMetric).toBe(true);
    expect(r.canSaveMeasurement).toBe(true);
  });

  it('surfaces a "assume metres" caveat for local', () => {
    const r = validateCrsForMeasurement(
      make({ kind: 'local', linearUnit: 'unknown', linearUnitToMetres: 1 }),
    );
    expect(crsCaveatLine(r)).toMatch(/metres/i);
  });
});

describe('validateCrsForMeasurement — geographic CRS', () => {
  it('returns requires-projection for a lat/lon CRS', () => {
    const r = validateCrsForMeasurement(
      make({ kind: 'geographic', name: 'WGS 84', linearUnit: 'unknown', linearUnitToMetres: 1 }),
    );
    expect(r.validity).toBe('requires-projection');
    expect(r.severity).toBe('warn');
    expect(r.canDisplayMetric).toBe(false);
    expect(r.canSaveMeasurement).toBe(false);
  });

  it('blocks the metric headline for geographic', () => {
    const r = validateCrsForMeasurement(
      make({ kind: 'geographic', linearUnit: 'unknown' }),
    );
    expect(shouldBlockMetricHeadline(r)).toBe(true);
  });

  it('suggests projecting before measuring', () => {
    const r = validateCrsForMeasurement(make({ kind: 'geographic' }));
    expect(r.suggestion).toMatch(/projected CRS/i);
  });
});

describe('validateCrsForMeasurement — unknown CRS', () => {
  it('returns unknown-needs-confirmation when kind is unknown', () => {
    const r = validateCrsForMeasurement(
      make({ kind: 'unknown', name: 'CRS unknown', confidence: 'none' }),
    );
    expect(r.validity).toBe('unknown-needs-confirmation');
    expect(r.canSaveMeasurement).toBe(false);
  });

  it('returns unknown-needs-confirmation when crs is null', () => {
    const r = validateCrsForMeasurement(null);
    expect(r.validity).toBe('unknown-needs-confirmation');
  });

  it('returns unknown-needs-confirmation when crs is undefined', () => {
    const r = validateCrsForMeasurement(undefined);
    expect(r.validity).toBe('unknown-needs-confirmation');
  });
});

describe('validateCrsForMeasurement — non-finite unit ratio', () => {
  it('returns non-finite-unit for NaN ratio', () => {
    const r = validateCrsForMeasurement(make({ linearUnitToMetres: Number.NaN }));
    expect(r.validity).toBe('non-finite-unit');
    expect(r.severity).toBe('block');
  });

  it('returns non-finite-unit for zero ratio', () => {
    const r = validateCrsForMeasurement(make({ linearUnitToMetres: 0 }));
    expect(r.validity).toBe('non-finite-unit');
  });

  it('returns non-finite-unit for negative ratio', () => {
    const r = validateCrsForMeasurement(make({ linearUnitToMetres: -1 }));
    expect(r.validity).toBe('non-finite-unit');
  });

  it('returns non-finite-unit for Infinity ratio', () => {
    const r = validateCrsForMeasurement(
      make({ linearUnitToMetres: Number.POSITIVE_INFINITY }),
    );
    expect(r.validity).toBe('non-finite-unit');
  });
});

describe('shouldBlockMetricHeadline — convenience predicate', () => {
  it('returns false for a projected CRS', () => {
    expect(shouldBlockMetricHeadline(validateCrsForMeasurement(make()))).toBe(false);
  });

  it('returns true for an unknown CRS', () => {
    expect(
      shouldBlockMetricHeadline(validateCrsForMeasurement(make({ kind: 'unknown' }))),
    ).toBe(true);
  });

  it('returns true for a non-finite unit ratio', () => {
    expect(
      shouldBlockMetricHeadline(
        validateCrsForMeasurement(make({ linearUnitToMetres: 0 })),
      ),
    ).toBe(true);
  });
});
