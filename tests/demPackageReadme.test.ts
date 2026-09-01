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
      densityReferenceFloorsMet: ['QL2'], densityReferenceNote: 'ref',
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

/**
 * Set the resolved vertical factor (metres per source vertical unit) on a
 * result's DTM. The README's elevation unit now derives from this — the vertical
 * axis — not from the horizontal `linearUnit`. `null` models an unresolved
 * vertical unit (fail-closed → 'unknown').
 */
function withVerticalFactor(
  r: AnalyseContoursResult,
  metresPerUnit: number | null,
): AnalyseContoursResult {
  return {
    ...(r as unknown as Record<string, unknown>),
    dtm: { ...(r.dtm as unknown as Record<string, unknown>), verticalUnitToMetres: metresPerUnit },
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
  it('labels cell size + elevation in metres for a metric CRS (declared metre vertical)', () => {
    // The elevation unit now derives from the resolved VERTICAL factor, not the
    // horizontal unit: a metre-vertical CRS (verticalUnitToMetres === 1) reads
    // 'metres', matching the GeoTIFF vertical GeoKey (9001) in the same package.
    const txt = buildDemReadme({ result: withVerticalFactor(readyResult(), 1), ...OPTS });
    expect(txt).toMatch(/Cell size\s+1 m\b/);
    expect(txt).toMatch(/Grid cell size 1 m\b/);
    expect(txt).toMatch(/Elevation unit metres/);
  });

  it('labels cell size in FEET on a foot CRS, but an undeclared vertical unit reads "unknown"', () => {
    // The DTM grid stores cellSizeM in SOURCE units, so a foot CRS's cell size
    // reads "ft". The elevation unit is INDEPENDENT of the horizontal one: with
    // no declared vertical factor it fails closed to "unknown" — the horizontal
    // foot must never be copied onto the vertical axis (the compound-CRS drift
    // this fix pins).
    const txt = buildDemReadme({
      result: readyResult(),
      ...OPTS,
      linearUnit: 'us-survey-foot',
    });
    expect(txt).toMatch(/Cell size\s+1 ft\b/);
    expect(txt).toMatch(/Grid cell size 1 ft\b/);
    expect(txt).toMatch(/Elevation unit unknown/);
    // A foot scan must neither assert metres nor blindly inherit the plan foot.
    expect(txt).not.toMatch(/Elevation unit metres/);
    expect(txt).not.toMatch(/Elevation unit feet/);
    expect(txt).not.toMatch(/Cell size\s+1 m\b/);
  });

  it('reads FEET elevation on a metre-plan / foot-height compound CRS', () => {
    // metre horizontal (linearUnit undefined ⇒ 'm' cells) over a foot vertical
    // axis (verticalUnitToMetres === 0.3048). The elevation must read 'feet' from
    // the vertical factor even though the plan unit is metres.
    const txt = buildDemReadme({ result: withVerticalFactor(readyResult(), 0.3048), ...OPTS });
    expect(txt).toMatch(/Cell size\s+1 m\b/);
    expect(txt).toMatch(/Elevation unit feet/);
    expect(txt).not.toMatch(/Elevation unit metres/);
  });

  it('reads METRES elevation on a foot-plan / metre-height compound CRS', () => {
    // foot horizontal (cells read 'ft') over a metre vertical axis
    // (verticalUnitToMetres === 1). The elevation must read 'metres', the reverse
    // of the metre-plan/foot-height case.
    const txt = buildDemReadme({
      result: withVerticalFactor(readyResult(), 1),
      ...OPTS,
      linearUnit: 'foot',
    });
    expect(txt).toMatch(/Cell size\s+1 ft\b/);
    expect(txt).toMatch(/Elevation unit metres/);
    expect(txt).not.toMatch(/Elevation unit feet/);
  });

  it('labels degrees for cells on a geographic CRS while honouring the vertical factor (feet)', () => {
    // A geographic frame's cells/bounds are degrees, but its heights still carry
    // the declared vertical unit: a foot vertical axis reads 'feet' for elevation
    // with the cell size still 'degrees'.
    const txt = buildDemReadme({
      result: withVerticalFactor(readyResult(), 0.3048),
      ...OPTS,
      isGeographic: true,
    });
    expect(txt).toMatch(/Cell size\s+1 degrees/);
    expect(txt).toMatch(/Elevation unit feet/);
    expect(txt).not.toMatch(/Elevation unit metres/);
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
