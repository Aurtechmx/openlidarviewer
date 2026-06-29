import { describe, test, expect } from 'vitest';
import {
  buildReportManifest,
  serializeReportManifest,
  verifyReportManifest,
  type ReportManifestInput,
} from '../src/render/measure/reportManifest';
import { fnv1a } from '../src/render/measure/auditLog';

function input(over: Partial<ReportManifestInput> = {}): ReportManifestInput {
  return {
    dataset: { id: 'site-a', crs: 'EPSG:6433', pointCount: 4_200_000 },
    generatedAt: '2026-06-27T00:00:00Z',
    classificationEpoch: 2,
    findings: [
      {
        label: 'Stockpile volume',
        value: 1254,
        unit: 'm³',
        sigma: 41,
        confidence: 'medium',
        caveats: ['Point-sample estimate over a lowest-ground base plane.'],
      },
    ],
    ...over,
  };
}

describe('reportManifest', () => {
  test('a freshly built manifest verifies and names its digest algorithm', () => {
    const m = buildReportManifest(input());
    expect(m.digest).toBeTruthy();
    expect(m.digestAlgorithm).toBe('SHA-256');
    expect(m.digest).toHaveLength(64); // SHA-256 hex
    expect(verifyReportManifest(m)).toBe(true);
  });

  test('the named digest algorithm is covered by the digest (cannot be forged)', () => {
    const m = buildReportManifest(input());
    // Re-label the algorithm without recomputing the digest → verification fails.
    expect(verifyReportManifest({ ...m, digestAlgorithm: 'FNV-1a-32' })).toBe(false);
  });

  test('altering a finding value (or its band) breaks verification', () => {
    const m = buildReportManifest(input());
    const tamperedValue = { ...m, findings: [{ ...m.findings[0], value: 9999 }] };
    const tamperedBand = { ...m, findings: [{ ...m.findings[0], sigma: 1 }] };
    expect(verifyReportManifest(tamperedValue)).toBe(false);
    expect(verifyReportManifest(tamperedBand)).toBe(false);
  });

  test('the digest is deterministic for identical input', () => {
    expect(buildReportManifest(input()).digest).toBe(buildReportManifest(input()).digest);
  });

  test('findings carry their uncertainty band and caveats through', () => {
    const m = buildReportManifest(input());
    expect(m.findings[0].sigma).toBe(41);
    expect(m.findings[0].caveats?.[0]).toMatch(/base plane/i);
  });

  test('provenance (edit epoch + audit trail) is part of the digested body', () => {
    const m = buildReportManifest(input({ edits: [{ seq: 0, type: 'reclassify', hash: 'abc' }] }));
    // Forging the epoch after signing must fail verification.
    expect(verifyReportManifest({ ...m, classificationEpoch: 0 })).toBe(false);
  });

  test('serialize is canonical / stable and an injected hash is honoured', () => {
    const tag: typeof fnv1a = (s) => `H${s.length}`;
    const m = buildReportManifest(input(), tag);
    expect(m.digest.startsWith('H')).toBe(true);
    expect(verifyReportManifest(m, tag)).toBe(true);
    expect(verifyReportManifest(m, fnv1a)).toBe(false); // wrong hash fn
    expect(serializeReportManifest(m)).toBe(serializeReportManifest(buildReportManifest(input(), tag)));
  });
});
