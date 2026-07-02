/**
 * scanAcceptance.test.ts
 *
 * Verifies the v0.3.6 Scan Acceptance template + its acceptance-checklist
 * section. The metadata-row builder + UI threshold input live in main.ts;
 * the tests here exercise the pure-data report engine surface — the
 * template existence, the bounds-check on row count, the renderer's
 * graceful handling of empty / missing arrays, and a full round-trip
 * through pdf-lib so the Methods appendix actually ships in the bytes.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  REPORT_TEMPLATES,
  getReportTemplate,
  generateReport,
  type ReportInputs,
  type ReportAcceptanceRow,
} from '../src/report';

function baseInputs(): ReportInputs {
  return {
    templateId: 'scan-acceptance',
    branding: {
      organisation: 'Acme Survey Co.',
      author: 'A. Inspector',
      theme: 'light-technical',
    },
    cover: {
      title: 'Scan Acceptance — East Levee',
      datasetName: 'east-levee.copc.laz',
      exportedAt: '2026-05-28T12:00:00.000Z',
    },
    datasetRows: [
      { label: 'Format', value: 'COPC (LAS 1.4 PDRF 6)' },
      { label: 'Points', value: '12,400,000' },
    ],
    visuals: [],
    annotations: [],
    measurements: [],
  };
}

describe('Scan Acceptance — template registration', () => {
  it('is registered in REPORT_TEMPLATES', () => {
    expect(getReportTemplate('scan-acceptance')).toBeDefined();
  });

  it('carries cover + inspection-summary + dataset-summary + provenance + acceptance-checklist + footer sections', () => {
    const t = getReportTemplate('scan-acceptance');
    expect(t).toBeDefined();
    expect(t?.sections).toEqual([
      'cover',
      'inspection-summary',
      'dataset-summary',
      'provenance',
      'acceptance-checklist',
      'footer',
    ]);
  });

  it('is included in the full template catalogue', () => {
    expect(REPORT_TEMPLATES.map((t) => t.id)).toContain('scan-acceptance');
  });
});

describe('Scan Acceptance — rendering', () => {
  it('renders a passing checklist end-to-end with pdf-lib round-trip', async () => {
    const acceptanceChecks: ReportAcceptanceRow[] = [
      { label: 'Point count', threshold: '≥ 5,000,000', actual: '12,400,000', pass: true },
      { label: 'CRS declared', threshold: 'required', actual: 'EPSG:32612', pass: true },
      { label: 'Classification', threshold: 'required', actual: 'present', pass: true },
      { label: 'Intensity', threshold: 'required', actual: 'present', pass: true },
    ];
    const result = await generateReport({ ...baseInputs(), acceptanceChecks });
    expect(result.pages).toBeGreaterThan(0);
    expect(result.blob.size).toBeGreaterThan(1024);

    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBe(result.pages);
    expect(parsed.getTitle()).toBe('Scan Acceptance — East Levee');
  });

  it('renders a partially-failing checklist with explanation notes', async () => {
    const acceptanceChecks: ReportAcceptanceRow[] = [
      { label: 'Point count', threshold: '≥ 5,000,000', actual: '12,400,000', pass: true },
      {
        label: 'CRS declared',
        threshold: 'required',
        actual: 'missing',
        pass: false,
        note: 'CRS missing — cannot georeference exports without it.',
      },
      { label: 'Classification', threshold: 'required', actual: 'present', pass: true },
    ];
    const result = await generateReport({ ...baseInputs(), acceptanceChecks });
    expect(result.pages).toBeGreaterThan(0);
    expect(result.blob.size).toBeGreaterThan(1024);
  });

  it('renders gracefully when acceptanceChecks is empty', async () => {
    // An empty array should skip the section entirely — same shape as
    // omitting the field. The cover + dataset summary + footer still
    // render.
    const result = await generateReport({ ...baseInputs(), acceptanceChecks: [] });
    expect(result.pages).toBeGreaterThan(0);
  });

  it('renders gracefully when acceptanceChecks is omitted', async () => {
    const result = await generateReport(baseInputs());
    expect(result.pages).toBeGreaterThan(0);
  });

  it('renders under the dark-inspection theme without throwing', async () => {
    const acceptanceChecks: ReportAcceptanceRow[] = [
      { label: 'Point count', threshold: '≥ 5,000,000', actual: '12,400,000', pass: true },
    ];
    const result = await generateReport({
      ...baseInputs(),
      branding: { ...baseInputs().branding, theme: 'dark-inspection' },
      acceptanceChecks,
    });
    expect(result.pages).toBeGreaterThan(0);
  });

  it('renders under the minimal-engineering theme without throwing', async () => {
    const acceptanceChecks: ReportAcceptanceRow[] = [
      { label: 'Point count', threshold: '≥ 5,000,000', actual: '12,400,000', pass: true },
    ];
    const result = await generateReport({
      ...baseInputs(),
      branding: { ...baseInputs().branding, theme: 'minimal-engineering' },
      acceptanceChecks,
    });
    expect(result.pages).toBeGreaterThan(0);
  });
});

describe('Scan Acceptance — Unicode threshold sanitisation', () => {
  it('renders Unicode glyphs (≥, ≤, ²) in thresholds without losing the section', async () => {
    // pdf-lib's WinAnsi Helvetica encoding can't render U+2265 / U+2264
    // directly; the renderer's sanitiseForPdf maps those to ASCII (while
    // WinAnsi-native glyphs like ² pass through verbatim since v0.5.4).
    // Without the sanitiser the per-section error path would silently skip
    // the whole acceptance-checklist section, leaving the user with a
    // PDF that looks correct but has no checks rendered.
    const acceptanceChecks: ReportAcceptanceRow[] = [
      { label: 'Point count', threshold: '≥ 5,000,000', actual: '12,400,000', pass: true },
      { label: 'NPS', threshold: '≤ 0.7 m', actual: '0.4 m', pass: true },
      { label: 'Density', threshold: '≥ 2 pts/m²', actual: '2.4 pts/m²', pass: true },
    ];
    const result = await generateReport({ ...baseInputs(), acceptanceChecks });
    // The result must actually carry the section's content — verify by
    // checking the byte size against an empty-acceptance variant.
    const empty = await generateReport({ ...baseInputs(), acceptanceChecks: [] });
    expect(result.blob.size).toBeGreaterThan(empty.blob.size);
  });
});

describe('Scan Acceptance — bounds-checked input', () => {
  it('rejects a checklist with more than 100 rows', async () => {
    const acceptanceChecks: ReportAcceptanceRow[] = Array.from(
      { length: 150 },
      (_, i) => ({
        label: `Check ${i + 1}`,
        threshold: 'required',
        actual: 'present',
        pass: true,
      }),
    );
    await expect(
      generateReport({ ...baseInputs(), acceptanceChecks }),
    ).rejects.toThrow(/acceptance checklist.*cap/i);
  });
});
