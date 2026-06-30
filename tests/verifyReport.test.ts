import { describe, test, expect } from 'vitest';
import { verifyReportFile } from '../src/export/verifyReport';
import { buildReportManifest, type ReportManifestInput } from '../src/render/measure/reportManifest';
import { fnv1a } from '../src/render/measure/auditLog';

function reportInput(over: Partial<ReportManifestInput> = {}): ReportManifestInput {
  return {
    dataset: { id: 'site-a', crs: 'EPSG:6433', pointCount: 4_200_000 },
    generatedAt: '2026-06-29T00:00:00Z',
    classificationEpoch: 3,
    software: '0.5.2',
    findings: [{ label: 'Stockpile volume', value: 1254, unit: 'm³', sigma: 41, confidence: 'medium' }],
    ...over,
  };
}

describe('verifyReportFile', () => {
  test('a freshly built (SHA-256) report verifies as intact', () => {
    const json = JSON.stringify(buildReportManifest(reportInput()));
    const r = verifyReportFile(json);
    expect(r.recognised).toBe(true);
    expect(r.valid).toBe(true);
    expect(r.algorithm).toBe('SHA-256');
    expect(r.software).toBe('0.5.2');
    expect(r.classificationEpoch).toBe(3);
    expect(r.findingsCount).toBe(1);
    expect(r.reason).toMatch(/intact/i);
  });

  test('pretty-printed JSON still verifies (canonical re-hash)', () => {
    const json = JSON.stringify(buildReportManifest(reportInput()), null, 2);
    expect(verifyReportFile(json).valid).toBe(true);
  });

  test('a report with undefined optional fields verifies after a file round trip', () => {
    // The export path for a dataset with no CRS / point count: those keys are
    // undefined. JSON.stringify drops them, so the digest must be computed over
    // the same body the reader sees. Regression for the round-trip verify bug.
    const m = buildReportManifest({
      dataset: { id: 'site-a' }, // crs + pointCount undefined
      generatedAt: '2026-06-29T00:00:00Z',
      classificationEpoch: 0,
      software: '0.5.2',
      findings: [{ label: 'distance 1', value: 1, unit: 'm' }],
    });
    expect(verifyReportFile(JSON.stringify(m, null, 2)).valid).toBe(true);
  });

  test('a legacy FNV-1a report verifies via its self-described algorithm', () => {
    const json = JSON.stringify(buildReportManifest(reportInput(), fnv1a, 'FNV-1a-32'));
    const r = verifyReportFile(json);
    expect(r.algorithm).toBe('FNV-1a-32');
    expect(r.valid).toBe(true);
  });

  test('altering a finding value breaks verification', () => {
    const m = buildReportManifest(reportInput());
    const tampered = { ...m, findings: [{ ...m.findings[0], value: 9999 }] };
    const r = verifyReportFile(JSON.stringify(tampered));
    expect(r.recognised).toBe(true);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/modified|does not match/i);
  });

  test('altering the classification epoch breaks verification', () => {
    const m = buildReportManifest(reportInput());
    expect(verifyReportFile(JSON.stringify({ ...m, classificationEpoch: 0 })).valid).toBe(false);
  });

  test('non-JSON is reported, not thrown', () => {
    const r = verifyReportFile('not json {');
    expect(r.recognised).toBe(false);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/json/i);
  });

  test('valid JSON that is not a report is rejected', () => {
    const r = verifyReportFile('{"hello":"world"}');
    expect(r.recognised).toBe(false);
    expect(r.reason).toMatch(/not an OpenLiDARViewer integrity report/i);
  });

  test('an unknown digest algorithm cannot be verified', () => {
    const m = buildReportManifest(reportInput());
    const r = verifyReportFile(JSON.stringify({ ...m, digestAlgorithm: 'MD5' }));
    expect(r.recognised).toBe(true);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/unknown digest algorithm/i);
  });
});
