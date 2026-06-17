/**
 * exportSummary.test.ts
 *
 * Pins the pure "what you'll get" export summary: byte-model per format
 * (mirroring writeLas point-format selection), the LAZ compressed range, ASCII
 * approximation, the classification note, and every prevention warning.
 */

import { describe, it, expect } from 'vitest';
import { buildExportSummary, type ExportSummaryInput } from '../src/export/exportSummary';

const base: ExportSummaryInput = { pointCount: 1_000_000, format: 'las14', crsMode: 'keep' };

function warns(input: ExportSummaryInput): string[] {
  return buildExportSummary(input).warnings.map((w) => `${w.level}:${w.message}`);
}

describe('buildExportSummary — size model', () => {
  it('LAS 1.4 without RGB is 375 + 30/pt', () => {
    expect(buildExportSummary(base).sizeBytesEst).toBe(375 + 1_000_000 * 30);
  });

  it('LAS 1.4 with RGB is 375 + 36/pt', () => {
    expect(buildExportSummary({ ...base, hasRgb: true }).sizeBytesEst).toBe(375 + 1_000_000 * 36);
  });

  it('LAS 1.2 with RGB + GPS is 227 + 34/pt (PDRF 3)', () => {
    const s = buildExportSummary({ ...base, format: 'las', hasRgb: true, hasGpsTime: true });
    expect(s.sizeBytesEst).toBe(227 + 1_000_000 * 34);
  });

  it('LAS 1.2 plain is 227 + 20/pt (PDRF 0)', () => {
    expect(buildExportSummary({ ...base, format: 'las' }).sizeBytesEst).toBe(227 + 1_000_000 * 20);
  });

  it('LAZ is an approximate compressed range, not a single figure', () => {
    const s = buildExportSummary({ ...base, format: 'laz' });
    expect(s.sizeApproximate).toBe(true);
    expect(s.sizeLabel).toMatch(/–/); // a lo–hi range
    // midpoint sits between the raw LAS14 size /12 and /7
    const raw = 375 + 1_000_000 * 30;
    expect(s.sizeBytesEst).toBeGreaterThan(raw / 12);
    expect(s.sizeBytesEst).toBeLessThan(raw / 7);
  });

  it('ASCII (XYZ) is flagged approximate', () => {
    const s = buildExportSummary({ ...base, format: 'xyz' });
    expect(s.sizeApproximate).toBe(true);
    expect(s.sizeBytesEst).toBe(1_000_000 * 34);
  });

  it('gzip on LAS reports a compressed range and tags the format .gz', () => {
    const plain = buildExportSummary(base).sizeBytesEst!;
    const s = buildExportSummary({ ...base, gzip: true });
    expect(s.sizeApproximate).toBe(true);
    expect(s.sizeLabel).toMatch(/–/);
    expect(s.formatLabel).toBe('LAS 1.4 (.gz)');
    expect(s.sizeBytesEst).toBeLessThan(plain); // compressed estimate is smaller
    expect(s.line).toContain('(.gz)');
  });

  it('gzip is ignored for ASCII formats (no binary container to wrap)', () => {
    const s = buildExportSummary({ ...base, format: 'xyz', gzip: true });
    expect(s.formatLabel).toBe('XYZ'); // no (.gz) suffix
  });

  it('no points → empty size + a prompt line', () => {
    const s = buildExportSummary({ ...base, pointCount: 0 });
    expect(s.sizeLabel).toBe('');
    expect(s.sizeBytesEst).toBeNull();
    expect(s.line).toMatch(/open a scan/i);
  });
});

describe('buildExportSummary — classification note', () => {
  it('derived + included names it heuristic with confidence', () => {
    const s = buildExportSummary({ ...base, classification: 'derived', derivedConfidencePct: 80 });
    expect(s.classificationLabel).toBe('Classification included (derived, 80% confidence)');
    expect(warns({ ...base, classification: 'derived' })).toEqual(
      expect.arrayContaining([expect.stringMatching(/warn:.*derived \(heuristic\)/i)]),
    );
  });

  it('omitting a derived classification drops the warning', () => {
    const s = buildExportSummary({ ...base, classification: 'derived', includeClassification: false });
    expect(s.classificationLabel).toBe('Classification omitted');
    expect(warns({ ...base, classification: 'derived', includeClassification: false })).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/derived \(heuristic\)/i)]),
    );
  });

  it('source classification reads as source, no heuristic warning', () => {
    const s = buildExportSummary({ ...base, classification: 'source' });
    expect(s.classificationLabel).toBe('Classification included (source)');
  });

  it('no classification → no note', () => {
    expect(buildExportSummary(base).classificationLabel).toBeNull();
  });
});

describe('buildExportSummary — warnings', () => {
  it('reproject without a target EPSG is a blocking error', () => {
    expect(warns({ ...base, crsMode: 'reproject' })).toEqual(
      expect.arrayContaining([expect.stringMatching(/^error:.*target EPSG/i)]),
    );
  });

  it('LAS 1.2 with classification warns about the 5-bit clamp', () => {
    expect(warns({ ...base, format: 'las', classification: 'source' })).toEqual(
      expect.arrayContaining([expect.stringMatching(/info:.*5 bits/i)]),
    );
  });

  it('LAS 1.4 keep without WKT notes the GeoTIFF-keys fallback', () => {
    expect(warns({ ...base, crsLabel: 'EPSG:32612', hasWkt: false })).toEqual(
      expect.arrayContaining([expect.stringMatching(/info:.*GeoTIFF keys/i)]),
    );
  });

  it('a decimated view warns unless full-res is ticked', () => {
    expect(warns({ ...base, viewDecimated: true })).toEqual(
      expect.arrayContaining([expect.stringMatching(/warn:.*full resolution/i)]),
    );
    expect(warns({ ...base, viewDecimated: true, fullRes: true })).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/full resolution/i)]),
    );
  });

  it('a very large scan gets a heads-up', () => {
    expect(warns({ ...base, pointCount: 80_000_000 })).toEqual(
      expect.arrayContaining([expect.stringMatching(/warn:.*Large scan/i)]),
    );
  });

  it('gzip does NOT suppress the memory warning (raw buffer still built in RAM)', () => {
    // 80M pts LAS 1.4 ≈ 2.4 GB raw; gzipped midpoint < 1.5 GB, but memory is raw.
    expect(warns({ ...base, pointCount: 80_000_000, gzip: true })).toEqual(
      expect.arrayContaining([expect.stringMatching(/warn:.*Large scan.*uncompressed/i)]),
    );
  });
});

describe('buildExportSummary — CRS label + line', () => {
  it('keep with no CRS reads Local', () => {
    expect(buildExportSummary(base).crsLabel).toBe('Local — no CRS');
  });

  it('reproject shows the destination', () => {
    expect(buildExportSummary({ ...base, crsMode: 'reproject', targetEpsg: 4326 }).crsLabel).toBe(
      'Reproject → EPSG:4326',
    );
  });

  it('the one-liner threads count · format · size · CRS', () => {
    const s = buildExportSummary({ ...base, crsLabel: 'EPSG:32612' });
    expect(s.line).toContain('1,000,000 points');
    expect(s.line).toContain('LAS 1.4');
    expect(s.line).toContain('EPSG:32612');
    expect(s.line).toContain('·');
  });
});
