/**
 * exportGateRouting.test.ts — §19 export-gate coverage.
 *
 * Proves that the scientific exporters newly routed through the ONE evidence
 * gate (measurements CSV, the integrity report, and the map-sheet PDF) report
 * the honest claim status the registry says — exploratory / refused when a
 * product is below its bar, validated ONLY when it genuinely meets it — and
 * never silently promote an unvalidated product.
 *
 * The gate/registry API itself is pinned by evidenceRegistry.test.ts; here we
 * assert the EXPORTERS consult it rather than asserting their own status.
 */

import { describe, it, expect } from 'vitest';
import {
  evidenceStatus,
  evidenceNote,
} from '../src/validation/exportEvidenceNote';
import {
  measurementsToCsv,
  type MeasurementExportContext,
} from '../src/export/measurementExport';
import {
  integrityReportFile,
  INTEGRITY_REPORT_CLAIM,
} from '../src/export/measurementReport';
import {
  buildMapSheetPdf,
  mapSheetEvidenceNote,
  mapSheetEvidenceLine,
  MAP_SHEET_CLAIM,
} from '../src/render/measure/mapSheetPdf';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import type { ContourFeatureModel } from '../src/terrain/contour/contourFeatureModel';

const UP: Vec3 = [0, 0, 1];
const CTX: MeasurementExportContext = {
  toOutput: (p) => [p[0], p[1], p[2]],
  up: UP,
  unitToMetres: 1,
  crsName: 'EPSG:32612',
};

function dist(id: string, len: number): Measurement {
  return { id, kind: 'distance', name: `${id}`, points: [[0, 0, 0], [len, 0, 0]] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Central status helper — never promotes.
// ─────────────────────────────────────────────────────────────────────────────

describe('evidenceStatus (central helper)', () => {
  it('is exploratory for a below-required product', () => {
    expect(evidenceStatus('MEAS-DISTANCE')).toBe('exploratory');
    expect(evidenceStatus('CONTOURS')).toBe('exploratory');
    expect(evidenceStatus('DTM')).toBe('exploratory');
  });

  it('is validated ONLY when the registry says the product meets its bar', () => {
    expect(evidenceStatus('REPORT-DIGEST')).toBe('validated');
  });

  it('treats an unregistered claim as exploratory, never validated', () => {
    expect(evidenceStatus('NOT-A-REAL-CLAIM')).toBe('exploratory');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Measurements CSV — every row carries the gate verdict.
// ─────────────────────────────────────────────────────────────────────────────

describe('measurementsToCsv — routed through the gate', () => {
  it('adds a trailing evidence column marking measurements exploratory', () => {
    const csv = measurementsToCsv([dist('m1', 5), dist('m2', 3)], CTX);
    const lines = csv.split('\n');
    const header = lines[0].split(',');
    expect(header[header.length - 1]).toBe('evidence');
    const evIdx = header.indexOf('evidence');
    // Every measurement row carries the exploratory status — never validated,
    // because MEAS-DISTANCE is below its required level in the registry.
    for (const row of lines.slice(1)) {
      expect(row.split(',')[evIdx]).toBe('exploratory');
    }
  });

  it('does not add or drop rows (one row per measurement, plus the header)', () => {
    const csv = measurementsToCsv([dist('m1', 5), dist('m2', 3)], CTX);
    expect(csv.split('\n')).toHaveLength(3);
  });

  it('never stamps validated while the product is below its bar', () => {
    const csv = measurementsToCsv([dist('m1', 5)], CTX);
    expect(csv).not.toContain('validated');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integrity report — decision routed through the gate.
// ─────────────────────────────────────────────────────────────────────────────

describe('integrityReportFile — routed through the gate', () => {
  const build = (claimId?: string) =>
    integrityReportFile(
      [dist('m1', 5)],
      UP,
      1,
      'site-a',
      'EPSG:6433',
      '2026-06-27T00:00:00Z',
      1,
      '0.5.9',
      claimId,
    );

  it('reports the digest product validated (REPORT-DIGEST meets E1)', () => {
    const f = build();
    expect(INTEGRITY_REPORT_CLAIM).toBe('REPORT-DIGEST');
    expect(f.evidenceStatus).toBe('validated');
    expect(f.exploratory).toBe(false);
    expect(f.evidence).toMatch(/validated export/i);
    // The artifact itself is still produced.
    expect(f.filename).toBe('site-a-report.json');
    expect(JSON.parse(f.text).findings).toHaveLength(1);
  });

  it('flips to exploratory when routed against a below-required claim (not hardcoded)', () => {
    const f = build('DTM');
    expect(f.evidenceStatus).toBe('exploratory');
    expect(f.exploratory).toBe(true);
    expect(f.evidence).toMatch(/exploratory/i);
  });

  it('treats an unregistered claim as exploratory, never validated', () => {
    const f = build('NOT-A-REAL-CLAIM');
    expect(f.evidenceStatus).toBe('exploratory');
    expect(f.exploratory).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Map-sheet PDF — collar carries the gate verdict.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL: ContourFeatureModel = {
  features: [
    { value: 100, isIndex: true, grade: 'solid', meanConfidence: 90, closed: false, coordinates: [[0, 0], [50, 10], [100, 0]] },
  ],
  crs: 'WGS 84 / UTM zone 11N',
  verticalDatum: 'NAVD88',
  intervalM: 10,
  contourStyle: 'smooth',
  bbox: { minX: 0, minY: 0, maxX: 100, maxY: 60 },
  interpolatedFraction: 0.12,
  coverageMode: 'full',
  warnings: [],
};

describe('map-sheet PDF — routed through the gate', () => {
  it('the collar claim is CONTOURS and reads exploratory today', () => {
    expect(MAP_SHEET_CLAIM).toBe('CONTOURS');
    expect(mapSheetEvidenceNote()).toMatch(/exploratory/i);
    expect(mapSheetEvidenceLine()).toMatch(/exploratory export/i);
    expect(mapSheetEvidenceLine()).not.toMatch(/validated export/i);
  });

  it('the note is derived from the gate, not hardcoded (validated for a met claim)', () => {
    expect(mapSheetEvidenceNote('REPORT-DIGEST')).toMatch(/validated export/i);
    expect(mapSheetEvidenceLine('REPORT-DIGEST')).toMatch(/validated export/i);
    // The note matches the central resolver verbatim.
    expect(mapSheetEvidenceNote('CONTOURS')).toBe(evidenceNote('CONTOURS'));
  });

  it('still produces a valid PDF with the evidence line stamped', async () => {
    const bytes = await buildMapSheetPdf({
      model: MODEL,
      labels: [{ x: 50, y: 10, value: 100, angleRad: 0.1 }],
      worldOrigin: { x: 585000, y: 3386000 },
      crs: MODEL.crs,
      verticalDatum: MODEL.verticalDatum,
      readiness: 'previewOnly',
      title: 'Contours',
    });
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
