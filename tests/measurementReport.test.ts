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

/** A pure vertical measurement — rise only, so the vertical factor is isolated. */
function height(id: string, rise: number): Measurement {
  return { id, kind: 'height', name: '', points: [[0, 0, 0], [0, 0, rise]] };
}

/** A volume measurement, to pin the linear²·vertical cubic factor. */
function volume(id: string, net: number): Measurement {
  return {
    id, kind: 'volume', name: '',
    points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]],
    volume: { cut: 0, fill: net, net, footprintArea: 100 },
  } as unknown as Measurement;
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
    // Tampering a finding after the digest is stamped must break verification.
    expect(verifyReportManifest({ ...manifest, findings: [{ ...manifest.findings[0], value: 0 }] })).toBe(
      false,
    );
  });

  test('an incomplete measurement contributes no finding', () => {
    const incomplete: Measurement = { id: 'x', kind: 'distance', name: '', points: [[0, 0, 0]] };
    expect(measurementsToFindings([incomplete], up, 1)).toHaveLength(0);
  });
});


/**
 * A compound CRS — metre eastings over US-survey-foot heights — is where a
 * single scale factor stops being enough. The CSV, GeoJSON and KML exports all
 * take a separate vertical factor; the integrity report did not, so the SIGNED,
 * tamper-evident deliverable disagreed with the CSV of the same session about
 * the same measurement. Volume compounds it: the report scaled by linear³
 * rather than linear²·vertical.
 */
describe('measurementReport — compound CRS vertical factor', () => {
  const METRE = 1;
  const US_FOOT = 1200 / 3937;

  test('a height uses the VERTICAL factor, not the horizontal one', () => {
    const f = measurementsToFindings([height('h1', 100)], up, METRE, US_FOOT);
    // 100 native vertical units of US survey foot = 30.48006 m, rounded to the
    // 3 dp the metrics carry. The point is that it is NOT 100 — the horizontal
    // factor of 1 would have left it unscaled.
    expect(f[0].value).toBeCloseTo(30.48, 2);
  });

  test('a single-unit CRS is unchanged when no vertical factor is given', () => {
    // The default must keep every existing metric CRS byte-identical.
    expect(measurementsToFindings([height('h1', 100)], up, METRE)[0].value).toBeCloseTo(100, 6);
  });

  test('a volume scales by linear squared times vertical, not linear cubed', () => {
    const f = measurementsToFindings([volume('v1', 1000)], up, METRE, US_FOOT);
    // 1000 native (m²·ft) = 1000 × 1 × 1 × 0.3048006 = 304.80 m³.
    expect(Math.abs(f[0].value)).toBeCloseTo(304.8006, 3);
  });

  test('the manifest carries the same vertical-scaled value as the findings', () => {
    const manifest = measurementsToReportManifest([height('h1', 100)], up, METRE, {
      datasetId: 'd', generatedAt: '2026-01-01T00:00:00Z', classificationEpoch: 0,
    }, US_FOOT);
    expect(manifest.findings[0].value).toBeCloseTo(30.48, 2);
  });
});
