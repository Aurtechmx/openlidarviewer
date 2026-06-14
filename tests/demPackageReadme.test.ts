import { describe, it, expect } from 'vitest';
import { buildDemReadme, type DemReadmeOptions } from '../src/terrain/export/demPackage';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

const COLS = 2;
const ROWS = 2;
const Z = new Float32Array([10, 20, 30, 40]);
const COV = new Uint8Array([2, 2, 1, 0]);

/**
 * A COMPLETE 'full' coverage, export-ready analysis result with everything
 * known. buildDemReadme now derives its shared provenance via
 * terrainAssessment(result), so the fixture carries the same fields a real run
 * produces (cellStatusTally, cellMetrics, qualityScore) — a fuller, not weaker,
 * fixture.
 */
function readyResult(): AnalyseContoursResult {
  return {
    dtm: {
      z: Z, coverage: COV, cols: COLS, rows: ROWS, cellSizeM: 1,
      originH1: 0, originH2: 0, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703',
      coverageMode: 'full', meanConfidence: 82,
    },
    intervalM: 1,
    surface: { canopy: { heightM: new Float32Array([0, 5, NaN, NaN]) } },
    accuracyStandards: {
      rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, pointDensityPerM2: 4.2,
      qualityLevel: 'QL2', qualityLevelReason: '4.2 pts/m² and 0.14 m RMSEz meet QL2.',
    },
    quality: {
      readiness: 'ready', exportReadiness: 'available',
      crsKnown: true, datumKnown: true, coverageMode: 'full', reasons: [], exportReasons: [],
    },
    qualityScore: { score: 85 },
    cellMetrics: { meanDensity: 4.2, edgeRiskRatio: 0.02 },
    cellStatusTally: { measured: 90, interpolated: 5, lowConfidence: 0, edgeRisk: 0, empty: 5, total: 100 },
    generationParams: { interpolation: 'geodesic', contourStyle: 'smooth', smoothing: true, despike: true, aggregation: 'median' },
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
  generationDateIso: '2026-06-05T00:00:00.000Z',
  softwareName: 'OpenLiDARViewer',
  softwareVersion: '9.9.9',
  metricVersion: 'v0.4.1',
};

describe('buildDemReadme — always-on metadata', () => {
  it('includes every required field for a full/ready result', () => {
    const txt = buildDemReadme({ result: readyResult(), ...OPTS });
    // CRS + status — now single-sourced from the unified provenance block, which
    // states the CRS itself (an unknown CRS reads "not georeferenced"), so the
    // README no longer needs a separate "(known)" annotation.
    expect(txt).toContain('EPSG:32610');
    expect(txt).toMatch(/Horizontal CRS\s+EPSG:32610/);
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
    // Quality-gate section is retained for the per-axis reason lists; the
    // unified VERDICTS now come from the shared provenance block, in the same
    // user-facing vocabulary every export uses (Good / Ready) rather than the
    // gate-internal tokens (ready / available). This is a superset, not a
    // weakening — the README now agrees word-for-word with the other exports.
    expect(txt).toMatch(/Quality gate/i);
    expect(txt).toMatch(/Surface quality\s+Good/);
    expect(txt).toMatch(/Export readiness\s+Ready/);
    expect(txt).toMatch(/not survey-grade/i);
    // Generation parameters
    expect(txt).toMatch(/Interpolation\s+geodesic/i);
    expect(txt).toMatch(/Cell aggregation\s+median/i);
    // Contour style is now single-sourced in the provenance block.
    expect(txt).toMatch(/Contour style\s+Smooth/i);
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
      generationDateIso: '2026-06-05T00:00:00.000Z',
      softwareName: 'OpenLiDARViewer', softwareVersion: '9.9.9', metricVersion: 'v0.4.1',
    });
    expect(txt).toMatch(/unknown/i);
  });
});

describe('buildDemReadme — generation parameters derive from the run', () => {
  it('reflects the result\'s actual generationParams (crisp contour style)', () => {
    const base = readyResult() as unknown as { generationParams: Record<string, unknown> };
    const crisp = {
      ...(base as unknown as AnalyseContoursResult),
      generationParams: {
        interpolation: 'idw', contourStyle: 'crisp', smoothing: false, despike: false, aggregation: 'mean',
      },
    } as unknown as AnalyseContoursResult;
    const txt = buildDemReadme({ result: crisp, ...OPTS });
    expect(txt).toMatch(/Interpolation\s+idw void fill/i);
    expect(txt).toMatch(/Cell aggregation\s+mean/i);
    expect(txt).toMatch(/Contour style\s+Crisp/i);
    expect(txt).toMatch(/Despike\s+off/i);
    // A different style names itself too.
    const semi = {
      ...(base as unknown as AnalyseContoursResult),
      generationParams: {
        interpolation: 'geodesic', contourStyle: 'semi-geometric', smoothing: true, despike: true, aggregation: 'median',
      },
    } as unknown as AnalyseContoursResult;
    const semiTxt = buildDemReadme({ result: semi, ...OPTS });
    expect(semiTxt).toMatch(/Contour style\s+Semi-geometric/i);
    expect(semiTxt).toMatch(/Despike\s+on/i);
  });

  it('says "unknown" rather than defaulting when generationParams is absent', () => {
    const base = readyResult() as unknown as Record<string, unknown>;
    delete base.generationParams;
    const txt = buildDemReadme({ result: base as unknown as AnalyseContoursResult, ...OPTS });
    expect(txt).toMatch(/Interpolation\s+unknown/i);
    expect(txt).toMatch(/Cell aggregation\s+unknown/i);
    expect(txt).toMatch(/Contour style\s+unknown/i);
    expect(txt).toMatch(/Despike\s+unknown/i);
  });
});

describe('buildDemReadme — unit labels follow the source CRS (label-vs-value)', () => {
  it('labels cell size + elevation in metres for a metric CRS (default)', () => {
    const txt = buildDemReadme({ result: readyResult(), ...OPTS });
    expect(txt).toMatch(/Cell size\s+1 m\b/);
    expect(txt).toMatch(/Grid cell size 1 m\b/);
    expect(txt).toMatch(/Elevation unit metres/);
  });

  it('labels cell size + elevation in FEET on a foot CRS — never "m"/"metres"', () => {
    // The DTM grid stores cellSizeM and Z in SOURCE units; a foot CRS carries
    // feet, so the README must read "ft" / "feet", not the metre default.
    const txt = buildDemReadme({
      result: readyResult(),
      ...OPTS,
      linearUnit: 'us-survey-foot',
    });
    expect(txt).toMatch(/Cell size\s+1 ft\b/);
    expect(txt).toMatch(/Grid cell size 1 ft\b/);
    expect(txt).toMatch(/Elevation unit feet/);
    // The drift: a foot scan must NOT assert metres anywhere in the raster block.
    expect(txt).not.toMatch(/Elevation unit metres/);
    expect(txt).not.toMatch(/Cell size\s+1 m\b/);
  });

  it('labels degrees for a geographic CRS, with linear elevation', () => {
    const txt = buildDemReadme({ result: readyResult(), ...OPTS, isGeographic: true });
    expect(txt).toMatch(/Cell size\s+1 degrees/);
    // Geographic heights are still linear metres by the standing default.
    expect(txt).toMatch(/Elevation unit metres/);
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
