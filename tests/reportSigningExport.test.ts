/**
 * reportSigningExport.test.ts
 *
 * The integrity-report export honours the "Sign this report" choice: off by
 * default and unsigned, signed when on, and refused (never written unsigned)
 * when signing was requested and cannot be done.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { exportMeasurementIntegrityReport, exportFindingsReport, type MeasurementExportActionDeps } from '../src/app/measurementExportActions';
import * as report from '../src/export/measurementReport';
import { createSigningKey, type SigningKeyBackend, type StoredSigningKey } from '../src/export/reportSigningKeyStore';
import { setReportSignerLabel, setReportSigningRequested } from '../src/export/reportSigningState';
import { verifyReportFileWithSignature } from '../src/export/verifyReport';

function backend(): SigningKeyBackend {
  let rec: StoredSigningKey | null = null;
  return { load: async () => rec, save: async (r) => { rec = r; }, clear: async () => { rec = null; } };
}

function setup(b: SigningKeyBackend | null) {
  const files: Array<{ filename: string; text: string }> = [];
  const refusals: string[] = [];
  const deps: MeasurementExportActionDeps = {
    measure: {
      getMeasurements: () => [{ id: 'm1', kind: 'distance', name: 'D', points: [[0, 0, 0], [1, 0, 0]] }],
      worldUp: [0, 0, 1], unitToMetres: 1, verticalUnitToMetres: 1, crsKnown: true, geographicCrs: false,
    },
    geo: () => ({ origin: [0, 0, 0], crsName: 'EPSG:32612', name: 'scan.laz' }),
    baseName: (n) => n.replace(/\.[^.]+$/, ''),
    downloadText: (filename, text) => { files.push({ filename, text }); },
    loadMeasurementExport: () => Promise.reject(new Error('unused')),
    loadMeasurementReport: async () => ({
      integrityReportFile: report.integrityReportFile,
      findingsReportFile: report.findingsReportFile,
      measurementsToFindings: report.measurementsToFindings,
      resolveExportDigests: async () => undefined,
      ...(b ? { signReportText: (t: string, o: Parameters<typeof report.signReportText>[1]) => report.signReportText(t, o, b) } : {}),
    }) as never,
    refuse: (m) => { refusals.push(m); },
    activeClassificationEpoch: () => 1,
    appVersion: '0.7.0',
    now: () => '2026-10-05T10:00:00.000Z',
  };
  return { deps, files, refusals };
}

afterEach(() => { setReportSigningRequested(false); setReportSignerLabel(''); });

describe('signing in the report exports', () => {
  it('writes an unsigned report when signing is off', async () => {
    const s = setup(backend());
    await exportMeasurementIntegrityReport(s.deps);
    expect(s.files).toHaveLength(1);
    expect(JSON.parse(s.files[0]!.text).reportSignature).toBeUndefined();
  });

  it('signs the integrity report when signing is on', async () => {
    const b = backend();
    await createSigningKey('t', b);
    setReportSigningRequested(true);
    setReportSignerLabel('Field team');
    const s = setup(b);
    await exportMeasurementIntegrityReport(s.deps);
    const r = await verifyReportFileWithSignature(s.files[0]!.text);
    expect(r.valid).toBe(true);
    expect(r.signature?.status).toBe('valid-unknown-signer');
    expect(r.signature?.signerLabelUnverified).toBe('Field team');
    expect(r.signature?.signedAtClaim).toBe('2026-10-05T10:00:00.000Z');
  });

  it('signs the findings report when signing is on', async () => {
    const b = backend();
    await createSigningKey('t', b);
    setReportSigningRequested(true);
    const s = setup(b);
    await exportFindingsReport(s.deps, [{ label: 'Length', value: 1, unit: 'm' }]);
    expect((await verifyReportFileWithSignature(s.files[0]!.text)).signature?.signatureValid).toBe(true);
  });

  it('refuses and writes nothing when signing is on and there is no key', async () => {
    setReportSigningRequested(true);
    const s = setup(backend());
    await exportMeasurementIntegrityReport(s.deps);
    expect(s.files).toHaveLength(0);
    expect(s.refusals[0]).toMatch(/could not be signed/i);
  });

  it('refuses when the signing function is unavailable', async () => {
    setReportSigningRequested(true);
    const s = setup(null);
    await exportMeasurementIntegrityReport(s.deps);
    expect(s.files).toHaveLength(0);
    expect(s.refusals).toHaveLength(1);
    vi.restoreAllMocks();
  });
});
