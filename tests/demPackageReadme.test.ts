import { describe, it, expect } from 'vitest';
import { buildDemReadme, type DemReadmeOptions } from '../src/terrain/export/demPackage';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

const COLS = 2;
const ROWS = 2;
const Z = new Float32Array([10, 20, 30, 40]);
const COV = new Uint8Array([2, 2, 1, 0]);

/** A 'full' coverage, export-ready analysis result with everything known. */
function readyResult(): AnalyseContoursResult {
  return {
    dtm: {
      z: Z, coverage: COV, cols: COLS, rows: ROWS, cellSizeM: 1,
      originH1: 0, originH2: 0, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703',
      coverageMode: 'full', meanConfidence: 82,
    },
    surface: { canopy: { heightM: new Float32Array([0, 5, NaN, NaN]) } },
    accuracyStandards: {
      rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, pointDensityPerM2: 4.2,
      qualityLevel: 'QL2', qualityLevelReason: '4.2 pts/m² and 0.14 m RMSEz meet QL2.',
    },
    quality: {
      readiness: 'ready', exportReadiness: 'available',
      crsKnown: true, datumKnown: true, reasons: [],
    },
    warnings: [],
  } as unknown as AnalyseContoursResult;
}

/** A resident-only, preview-only result with warnings (the honest-caveat case). */
function previewResult(): AnalyseContoursResult {
  const base = readyResult() as unknown as { dtm: Record<string, unknown>; quality: Record<string, unknown>; warnings: string[] };
  return {
    ...(base as unknown as AnalyseContoursResult),
    dtm: { ...base.dtm, coverageMode: 'resident-only' },
    quality: {
      ...base.quality, readiness: 'previewOnly', exportReadiness: 'previewOnly',
      reasons: ['Preview only: 31% of cells are interpolated and CRS is unknown.'],
    },
    warnings: ['Removed 3 outlier ground cell(s) before building the surface.'],
  } as unknown as AnalyseContoursResult;
}

const OPTS: Omit<DemReadmeOptions, 'result'> = {
  basename: 'site',
  isGeographic: false,
  boundsMinX: 600000, boundsMinY: 4000000, boundsMaxX: 600002, boundsMaxY: 4000002,
  interpolation: 'geodesic',
  smoothingApplied: true,
  despikeApplied: true,
  generationDateIso: '2026-06-05T00:00:00.000Z',
  softwareName: 'OpenLiDARViewer',
  softwareVersion: '9.9.9',
  metricVersion: 'v0.4.1',
};

describe('buildDemReadme — always-on metadata', () => {
  it('includes every required field for a full/ready result', () => {
    const txt = buildDemReadme({ result: readyResult(), ...OPTS });
    // CRS + status
    expect(txt).toContain('EPSG:32610');
    expect(txt).toMatch(/Horizontal CRS[\s\S]*known/i);
    // Vertical datum + status
    expect(txt).toContain('EPSG:5703');
    // No-data value
    expect(txt).toContain('-9999');
    // Cell size
    expect(txt).toMatch(/Cell size\s+1/);
    // Bounds extent (min/max X/Y)
    expect(txt).toContain('600000');
    expect(txt).toContain('600002');
    expect(txt).toContain('4000000');
    expect(txt).toContain('4000002');
    // Coverage mode
    expect(txt).toMatch(/Coverage mode\s+full/i);
    // Quality-gate verdict + status
    expect(txt).toMatch(/Quality gate/i);
    expect(txt).toContain('ready');
    expect(txt).toContain('available');
    // Generation parameters
    expect(txt).toMatch(/Interpolation\s+geodesic/i);
    expect(txt).toMatch(/Smoothing/i);
    expect(txt).toMatch(/Despik/i);
    // Generation date (ISO)
    expect(txt).toContain('2026-06-05T00:00:00.000Z');
    // Software name + version + metric version
    expect(txt).toContain('OpenLiDARViewer');
    expect(txt).toContain('9.9.9');
    expect(txt).toContain('v0.4.1');
  });

  it('prints "unknown"/"not provided" rather than fabricating missing fields', () => {
    const r = readyResult() as unknown as { dtm: Record<string, unknown> };
    const noCrs = {
      ...(r as unknown as AnalyseContoursResult),
      dtm: { ...r.dtm, crs: null, verticalDatum: null },
    } as unknown as AnalyseContoursResult;
    const txt = buildDemReadme({
      result: noCrs, basename: 'site', isGeographic: false,
      boundsMinX: null, boundsMinY: null, boundsMaxX: null, boundsMaxY: null,
      interpolation: 'geodesic', smoothingApplied: true, despikeApplied: true,
      generationDateIso: '2026-06-05T00:00:00.000Z',
      softwareName: 'OpenLiDARViewer', softwareVersion: '9.9.9', metricVersion: 'v0.4.1',
    });
    expect(txt).toMatch(/unknown/i);
  });
});

describe('buildDemReadme — honest gating caveat', () => {
  it('carries a prominent PRELIMINARY caveat for a resident-only/preview result', () => {
    const txt = buildDemReadme({ result: previewResult(), ...OPTS });
    expect(txt).toMatch(/PRELIMINARY/);
    expect(txt).toMatch(/resident-only/);
    expect(txt).toMatch(/preview/i);
    // The caveat must appear before the file listing — i.e. at the very top.
    const caveatPos = txt.indexOf('PRELIMINARY');
    const filesPos = txt.indexOf('Files');
    expect(caveatPos).toBeGreaterThanOrEqual(0);
    expect(caveatPos).toBeLessThan(filesPos);
  });

  it('lists analysis warnings in the README', () => {
    const txt = buildDemReadme({ result: previewResult(), ...OPTS });
    expect(txt).toContain('Removed 3 outlier ground cell(s) before building the surface.');
  });

  it('does NOT carry the PRELIMINARY caveat for a full/ready result', () => {
    const txt = buildDemReadme({ result: readyResult(), ...OPTS });
    expect(txt).not.toMatch(/PRELIMINARY/);
  });
});
