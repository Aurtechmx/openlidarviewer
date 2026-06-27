import { describe, test, expect } from 'vitest';
import {
  measurementsToFindings,
  measurementsToReportManifest,
} from '../src/export/measurementReport';
import { verifyReportManifest } from '../src/render/measure/reportManifest';
import type { Measurement } from '../src/render/measure/types';
import type { Vec3 } from '../src/render/measure/types';

const up: Vec3 = [0, 0, 1];

function distance(id: string, len: number, name = ''): Measurement {
  return { id, kind: 'distance', name, points: [[0, 0, 0], [len, 0, 0]] };
}

describe('measurementReport', () => {
  test('a distance becomes a length finding in metres', () => {
    const f = measurementsToFindings([distance('m1', 3)], up, 1);
    expect(f).toHaveLength(1);
    expect(f[0].value).toBeCloseTo(3, 6);
    expect(f[0].unit).toBe('m');
    expect(f[0].label).toBe('distance 1');
  });

  test('a US-foot scan converts length to metres', () => {
    const f = measurementsToFindings([distance('m1', 10)], up, 0.3048);
    expect(f[0].value).toBeCloseTo(3.048, 4);
  });

  test('a named measurement keeps its label', () => {
    expect(measurementsToFindings([distance('m1', 2, 'Fence run')], up, 1)[0].label).toBe(
      'Fence run',
    );
  });

  test('builds a signed manifest that verifies and stamps provenance', () => {
    const manifest = measurementsToReportManifest([distance('m1', 5)], up, 1, {
      datasetId: 'site-a',
      crsName: 'EPSG:6433',
      generatedAt: '2026-06-27T00:00:00Z',
      classificationEpoch: 1,
    });
    expect(verifyReportManifest(manifest)).toBe(true);
    expect(manifest.classificationEpoch).toBe(1);
    expect(manifest.findings[0].unit).toBe('m');
    // Tampering a finding after signing must break the signature.
    expect(verifyReportManifest({ ...manifest, findings: [{ ...manifest.findings[0], value: 0 }] })).toBe(
      false,
    );
  });

  test('an incomplete measurement contributes no finding', () => {
    const incomplete: Measurement = { id: 'x', kind: 'distance', name: '', points: [[0, 0, 0]] };
    expect(measurementsToFindings([incomplete], up, 1)).toHaveLength(0);
  });
});
