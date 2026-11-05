import type { AnalyseContoursResult } from '../../src/terrain/contour/analyseContours';

/** A complete, full-coverage, export-ready analysis result. */
export function readyResult(): AnalyseContoursResult {
  return {
    dtm: {
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
      coverageMode: 'full',
      meanConfidence: 82,
      cols: 200,
      rows: 150,
      cellSizeM: 1,
      sourcePointCount: 1_200_000,
      analyzedPointCount: 900_000,
    },
    intervalM: 1,
    model: {
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
      intervalM: 1,
      contourStyle: 'smooth',
      coverageMode: 'full',
      features: [{}, {}],
    },
    // A frame that RESOLVED its vertical scale, which is what makes the
    // metre-named standards below legitimate. Every residual-derived figure in
    // the report reads this flag for its suffix.
    verticalScaleResolved: true,
    accuracyStandards: {
      rmseZM: 0.14,
      nvaM: 0.27,
      vvaM: 0.3,
      pointDensityPerM2: 4.2,
      densityReferenceFloorsMet: ['QL2'], densityReferenceNote: 'ref',
    },
    quality: {
      readiness: 'ready',
      exportReadiness: 'available',
      crsKnown: true,
      datumKnown: true,
      coverageMode: 'full',
      reasons: [],
      exportReasons: [],
      interpolatedCellRatio: 0.06,
      emptyCellRatio: 0.05,
      edgeRiskRatio: 0.02,
      meanCellConfidence: 82,
      groundPointRatio: 0.6,
    },
    qualityScore: { score: 85 },
    cellMetrics: { meanDensity: 4.2, boundaryMeasuredRatio: 0.02 },
    cellStatusTally: {
      measured: 90,
      interpolated: 5,
      lowConfidence: 0,
      edgeRisk: 0,
      empty: 5,
      total: 100,
    },
    excludedByClassification: 1200,
    generationParams: {
      interpolation: 'geodesic',
      contourStyle: 'smooth',
      smoothing: true,
      despike: true,
      aggregation: 'median',
    },
    warnings: [],
  } as unknown as AnalyseContoursResult;
}
