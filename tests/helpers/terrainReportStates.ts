/**
 * terrainReportStates.ts: analysis results that put the terrain report and the
 * Contour Studio PDF into each state they can print, for the language tests
 * and the frozen English digests.
 */
import type { AnalyseContoursResult } from '../../src/terrain/contour/analyseContours';
import type { TerrainReportContentOptions } from '../../src/terrain/export/terrainReportContent';
import type { ContourPdfInput } from '../../src/terrain/contourStudio/contourDeliverablePdfModel';
import { summariseDataset } from '../../src/terrain/datasetIntelligence';
import { crsOriginOf } from '../../src/science/crsOrigin';
import { SLOPE_ASPECT_CONVENTION_NOTE } from '../../src/terrain/complexity/complexitySummary';
import { SOURCE_CANCELLED_NOTE, SOURCE_NOT_COMPUTED_NOTE, SOURCE_NOT_HELD_NOTE, STREAMED_SOURCE_NOTE } from '../../src/science/exportDigestRecord';
import { exploratoryDecision, validatedDecision } from './exportDecisions';
import { NOT_SURVEY_GRADE_NOTE } from '../../src/terrain/export/exportNotes';

type Over = Record<string, unknown>;
const READY = {
  dtm: { crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', coverageMode: 'full', cols: 200, rows: 1500, cellSizeM: 1, sourcePointCount: 1_200_000, analyzedPointCount: 900_000 },
  intervalM: 1,
  horizontalScaleResolved: true,
  verticalScaleResolved: true,
  model: { crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', intervalM: 1, contourStyle: 'smooth', coverageMode: 'full', features: [{}, {}] },
  accuracyStandards: { rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, pointDensityPerM2: 4.2, densityReferenceFloorsMet: ['QL2'], densityReferenceNote: 'ref' },
  quality: {
    readiness: 'ready', exportReadiness: 'available', crsKnown: true, datumKnown: true, coverageMode: 'full', reasons: [], exportReasons: [],
    measuredCellRatio: 0.9, interpolatedCellRatio: 0.06, emptyCellRatio: 0.05, interpolatedOfSurfaceRatio: 0.07, edgeRiskRatio: 0.02, meanCellConfidence: 82, groundPointRatio: 0.6,
  },
  qualityScore: { score: 85 },
  cellMetrics: { meanDensity: 4.2, boundaryMeasuredRatio: 0.02 },
  cellStatusTally: { measured: 90, interpolated: 5, lowConfidence: 0, edgeRisk: 0, empty: 5, total: 100 },
  excludedByClassification: 1200,
  generationParams: { interpolation: 'geodesic', contourStyle: 'smooth', smoothing: true, despike: true, aggregation: 'median' },
  warnings: [] as string[],
};
/** The ready result with the named parts replaced; nested objects are merged. */
export function terrainState(over: Over = {}): AnalyseContoursResult {
  const out: Over = { ...READY };
  for (const [k, v] of Object.entries(over)) {
    const was = (READY as Over)[k];
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) && was && typeof was === 'object' ? { ...was, ...v } : v;
  }
  return out as unknown as AnalyseContoursResult;
}
export const REPORT_OPTS: TerrainReportContentOptions = {
  verticalUnitToMetres: 1, basename: 'site-42', generatedAt: '2026-06-05T00:00:00.000Z', softwareVersion: '9.9.9', metricVersion: 'v0.4.1', linearUnit: 'metre', isGeographic: false,
  digests: { sourceSha256: 'a1'.repeat(32), sourceSha256Note: null, crsOrigin: crsOriginOf({ source: 'las-vlr', name: 'WGS 84 / UTM zone 10N', epsg: 32610, verticalEpsg: 5703 }) },
};
const complexity = (over: Over = {}): Over => ({
  band: 'moderate', vrmMedian: 0.034, vrmIqr: 0.021, vrmWindowCells: 3, vrmWindowGroundM: 3.2, vrmText: 'median 0.0340 [IQR 0.0210], 3×3-cell window (≈3.2 m), dimensionless',
  tpiRadiusCells: 10, tpiRadiusGroundM: 10, tpiDominantClass: 'flat', tpiText: 'dominant class flat (62% of valid cells), median 0.10 [IQR 0.20] m, radius 10 cells (≈10 m)',
  zUnitLabel: 'm', slopeAspectConvention: SLOPE_ASPECT_CONVENTION_NOTE, confidence: 91, warnings: [], ...over,
});
const blocked = (over: Over = {}): Over => ({ n: 400, rmse: 0.21, ciStatus: 'computed', ciUnavailableReason: null, ciLow: 0.18, ciHigh: 0.25, ciLevel: 0.95, classificationScope: 'train-only', ...over });
const reliability = { measured: { n: 900, reliability: 0.71, ciLow: 0.68, ciHigh: 0.74, tolerance: 0.14 } };
const none = { accuracyStandards: { rmseZM: null, nvaM: null, vvaM: null, pointDensityPerM2: 0, densityReferenceFloorsMet: [] } };

/** Every state: a result, and the options that differ from {@link REPORT_OPTS}. */
export const REPORT_STATES: Record<string, { r: AnalyseContoursResult; o?: Partial<TerrainReportContentOptions> }> = {
  ready: { r: terrainState() },
  full: { r: terrainState({ complexity: complexity(), reliabilitySplit: reliability, blockedAccuracy: blocked(), validation: { rmse: 0.14, method: 'holdout-cross-validation', classificationScope: 'train-only', sampleSize: 900 } }) },
  trusted: { r: terrainState({ generationParams: { despike: false, contourStyle: 'crisp' }, excludedByClassification: 0, blockedAccuracy: blocked({ classificationScope: 'fixed-source-classification' }), validation: { rmse: 0.14, classificationScope: 'fixed-source-classification' } }) },
  wholeCloud: { r: terrainState({ generationParams: { contourStyle: 'rounded' }, blockedAccuracy: blocked({ classificationScope: 'whole-cloud', ciStatus: 'unavailable', ciUnavailableReason: 'one-scored-block', ciLow: null, ciHigh: null }), validation: { rmse: 0.14, classificationScope: 'train-only' } }) },
  scopesB: { r: terrainState({ generationParams: { contourStyle: 'generalized' }, blockedAccuracy: blocked({ classificationScope: 'fixed-source-classification', ciStatus: 'unavailable', ciUnavailableReason: 'bootstrap-disabled', ciLow: null, ciHigh: null }), validation: { rmse: 0.14, classificationScope: 'whole-cloud' } }) },
  scopesC: { r: terrainState({ generationParams: { contourStyle: 'semi-geometric' }, blockedAccuracy: blocked({ n: 0, ciStatus: 'unavailable', ciUnavailableReason: 'no-residuals' }), validation: { rmse: 0.14, classificationScope: 'fixed-source-classification' } }) },
  scopesD: { r: terrainState({ blockedAccuracy: blocked({ classificationScope: 'train-only', ciUnavailableReason: 'no-residuals', ciStatus: 'unavailable', ciLow: null, ciHigh: null }), validation: { rmse: 0.14, classificationScope: 'fixed-source-classification' } }) },
  scopesE: { r: terrainState({ blockedAccuracy: blocked({ classificationScope: 'whole-cloud' }), validation: { rmse: 0.14, classificationScope: 'whole-cloud' } }) },
  noContrast: { r: terrainState({ blockedAccuracy: blocked({ classificationScope: undefined }) }) },
  resident: {
    r: terrainState({ ...none, dtm: { coverageMode: 'resident-only', verticalDatum: null }, model: { verticalDatum: null, coverageMode: 'resident-only' }, quality: { readiness: 'previewOnly', datumKnown: false, coverageMode: 'resident-only', reasons: ['Preview only: 48% of the surface is interpolated and vertical accuracy could not be validated.'], interpolatedOfSurfaceRatio: 0.48 }, warnings: ['no reliable contour interval for this scan'] }),
    o: { analysedBasis: { analysedPointCount: 1200, declaredPointCount: 90_000, coverage: 'resident-only', loadStride: null, residentPointCount: 4000, interpretationLevel: null } },
  },
  sampled: {
    r: terrainState({ dtm: { coverageMode: 'sampled' }, quality: { coverageMode: 'sampled' }, accuracyStandards: { densityReferenceFloorsMet: ['QL2'] } }),
    o: { analysedBasis: { analysedPointCount: 1_912_920, declaredPointCount: 10_789_680, coverage: 'sampled', loadStride: 6, interpretationLevel: 'PROBABLE' } },
  },
  basisFull: { r: terrainState(), o: { analysedBasis: { analysedPointCount: 900_000, declaredPointCount: 900_000, coverage: 'full', loadStride: null, interpretationLevel: 'VERIFIED' } } },
  basisSubsample: { r: terrainState(), o: { analysedBasis: { analysedPointCount: 900_000, declaredPointCount: 1_800_000, coverage: 'full', loadStride: null, interpretationLevel: 'COMPATIBLE' } } },
  basisResident: { r: terrainState({ dtm: { coverageMode: 'resident-only' } }), o: { analysedBasis: { analysedPointCount: 5000, declaredPointCount: null, coverage: 'resident-only', loadStride: null, interpretationLevel: 'RECOVERED' } } },
  basisDisplay: { r: terrainState(), o: { analysedBasis: { analysedPointCount: 5000, declaredPointCount: 80_000, coverage: 'sampled', loadStride: null, residentPointCount: 9000, interpretationLevel: 'PREVIEW_ONLY' } } },
  basisTruncated: { r: terrainState(), o: { analysedBasis: { analysedPointCount: 5000, declaredPointCount: 80_000, coverage: 'partial', loadStride: null, interpretationLevel: 'OPAQUE' } } },
  noCrs: { r: terrainState({ dtm: { crs: null, verticalDatum: null }, model: { crs: null, verticalDatum: null }, quality: { crsKnown: false, datumKnown: false } }), o: { digests: null, linearUnit: 'unknown', verticalUnitToMetres: null } },
  noCrsOnly: { r: terrainState({ dtm: { crs: null }, model: { crs: null }, quality: { crsKnown: false } }), o: { digests: { sourceSha256: null, sourceSha256Note: STREAMED_SOURCE_NOTE, crsOrigin: crsOriginOf({ source: 'user-override', name: 'My grid', verticalDatum: 'NAVD88' }) } } },
  limited: {
    r: terrainState({ ...none, qualityScore: { score: 22 }, accuracyStandards: { rmseZM: 0.9, nvaM: 1.7, vvaM: 1.9, pointDensityPerM2: 0.4, densityReferenceFloorsMet: [] }, cellMetrics: { meanDensity: 0.4, boundaryMeasuredRatio: 0.4 }, cellStatusTally: { measured: 15, interpolated: 30, empty: 55, total: 100 }, quality: { readiness: 'previewOnly', interpolatedOfSurfaceRatio: 0.66, emptyCellRatio: 0.55, edgeRiskRatio: 0.3, groundPointRatio: 0.04, meanCellConfidence: 30 } }),
    o: { digests: { sourceSha256: null, sourceSha256Note: SOURCE_NOT_HELD_NOTE, crsOrigin: crsOriginOf({ source: 'catalog-tile', name: 'NAD83 / UTM', epsg: 26912, assertedBy: 'USGS' }) } },
  },
  limitedBare: { r: terrainState({ qualityScore: { score: 22 }, quality: { meanCellConfidence: 30 } }), o: { digests: { sourceSha256: null, sourceSha256Note: SOURCE_CANCELLED_NOTE, crsOrigin: crsOriginOf(null) } } },
  capsOnly: { r: terrainState({ dtm: { coverageMode: 'sampled' }, cellMetrics: { meanDensity: 0.8, boundaryMeasuredRatio: 0.2 }, cellStatusTally: { measured: 55, interpolated: 45, empty: 0, total: 100 } }) },
  capsTwo: { r: terrainState({ cellStatusTally: { measured: 30, interpolated: 22, empty: 48, total: 100 } }) },
  capsOne: { r: terrainState({ quality: { groundPointRatio: 0.05 } }) },
  capsDensity: { r: terrainState({ cellMetrics: { meanDensity: 0.8 } }) },
  gatePreview: { r: terrainState({ quality: { readiness: 'previewOnly', reasons: ['Preview only: 45% of the surface is interpolated, 44% of the surveyed area has no data, 20% of cells are a long interpolation from real returns, vertical accuracy could not be validated, and mean confidence is low.'] } }) },
  blockedGate: { r: terrainState({ quality: { readiness: 'blocked', reasons: ['Only 8% of the surface is measured ground — too little to contour honestly.'] } }) },
  blockedInterval: { r: terrainState({ intervalM: null, model: { intervalM: null }, quality: { readiness: 'blocked', reasons: ['No contour interval is reliable for this scan (too sparse or vertical error too high).'] } }) },
  blockedPlain: { r: terrainState({ quality: { readiness: 'blocked', reasons: [] } }) },
  blockedEmpty: { r: terrainState({ ...none, qualityScore: null, dtm: { cols: 0, rows: Number.NaN, cellSizeM: Number.NaN, sourcePointCount: Number.NaN, analyzedPointCount: Number.NaN }, cellStatusTally: { measured: 0, interpolated: 0, lowConfidence: 0, edgeRisk: 0, empty: 100, total: 100 }, quality: { readiness: 'blocked', reasons: ['No measured or interpolated ground cells — no surface to contour.'], measuredCellRatio: Number.NaN } }) },
  noStyle: { r: terrainState({ generationParams: { contourStyle: null }, model: { contourStyle: null } }), o: { basename: null } },
  geographic: { r: terrainState({ dtm: { cellSizeM: 1e-5, cols: 200, rows: 150, cellUnitToMetres: null }, complexity: complexity({ vrmText: 'median — [IQR —], 3×3-cell window (ground size unknown), dimensionless', tpiText: 'dominant class not derived, median — [IQR —] source Z units, radius 2 cells (ground size unknown)' }) }), o: { isGeographic: true } },
  feet: { r: terrainState({ dtm: { cellSizeM: 3, cellUnitToMetres: 0.3048 } }), o: { linearUnit: 'foot', verticalUnitToMetres: 0.3048 } },
  usFeet: { r: terrainState({ dtm: { cellSizeM: 50, cellUnitToMetres: 0.3048 } }), o: { linearUnit: 'us-survey-foot', verticalUnitToMetres: 0.9 } },
  unresolvedZ: { r: terrainState({ ...none, verticalScaleResolved: false, reliabilitySplit: reliability, blockedAccuracy: blocked(), validation: { rmse: 0.5, classificationScope: 'train-only' } }), o: { verticalUnitToMetres: null } },
  permitOk: { r: terrainState(), o: { exportPermit: { status: 'validated', label: 'Internal validation', watermark: null, caveats: [] } } },
  permitExploratory: { r: terrainState(), o: { exportPermit: { status: 'exploratory', label: 'Exploratory', watermark: 'EXPLORATORY', caveats: [] }, digests: { sourceSha256: null, sourceSha256Note: SOURCE_NOT_COMPUTED_NOTE, crsOrigin: crsOriginOf({ source: 'default-assumption', name: 'Local' }) } } },
  transform: { r: terrainState(), o: { transform: { operation: 'EPSG:4326 → EPSG:32610', accuracyMetres: 1.5, sourceRealization: 'WGS 84 (G2139)', targetRealization: 'NAD83(2011)', coordinateEpoch: 2024.5 } } },
  transformSame: { r: terrainState(), o: { transform: { operation: 'no transform (identical CRS EPSG:32610)', accuracyMetres: null } } },
  scoped: { r: terrainState(), o: { methodDigest: 'abc', evidenceClaimId: 'DTM' } },
  scopedStudy: { r: terrainState(), o: { methodDigest: 'abc', scopedRecords: [{ claimId: 'DTM', evidenceLevel: 'E5_EXTERNALLY_VALIDATED', studyId: 'ST-1', applicabilityEnvelope: { methodDigest: 'abc' } }] } },
  scopedOutside: { r: terrainState(), o: { methodDigest: 'abc', scopedRecords: [{ claimId: 'DTM', evidenceLevel: 'E5_EXTERNALLY_VALIDATED', studyId: 'ST-1', applicabilityEnvelope: { methodDigest: 'zzz' } }] } },
  scopedUnknown: { r: terrainState(), o: { methodDigest: 'abc', scopedRecords: [{ claimId: 'DTM', evidenceLevel: 'E5_EXTERNALLY_VALIDATED', studyId: 'ST-1', applicabilityEnvelope: { horizontalEpsg: 32610 } }] } },
  intelLow: { r: terrainState(), o: { intelligence: summariseDataset({ residentDensity: 1, meanSlopeDeg: 1, groundPointRatio: 0.1, coverageMeta: { coverage: 'full', confidence: 40 } } as never) } },
  intelHigh: { r: terrainState(), o: { intelligence: summariseDataset({ residentDensity: 9000, meanSlopeDeg: 44, meanRoughness: 0.5, elevationVariance: 25, terrainSuggestion: { groundFraction: 0.9, vegetationFraction: 0 }, coverageMeta: { coverage: 'full', confidence: 88 } } as never) } },
  unresolvedXY: { r: terrainState({ horizontalScaleResolved: false }) },
};

const CS_PROV = {
  software: 'OpenLiDARViewer', softwareVersion: '0.5.9', gitCommit: '0.5.9 (abc1234) · release · built 2026-07-12T00:00:00.000Z', generated: '2026-07-12T00:00:00.000Z',
  crs: 'EPSG:32610', verticalDatum: 'EGM2008 height', horizontalUnit: 'm', verticalUnit: 'm', grid: '10x10 @ 1.25 m',
  methodIds: ['olv.contour.analytical@2'], sourceSha256: 'deadbeefcafe', recordHash: 'abcd1234',
};
const CS: ContourPdfInput = {
  title: 'site-42 - Contour deliverable', provenance: CS_PROV, support: { measuredPct: 80.1234, interpolatedPct: 15, unsupportedPct: 5 },
  validation: { mode: 'holdout-cross-validation', rmseM: 0.123, sampleSize: 42_000, independentCheckpoints: false }, decision: validatedDecision(), geometry: { cartographic: false, analyticalAvailable: true },
};
export const STUDIO_STATES: Record<string, ContourPdfInput> = {
  analytical: CS,
  cartographic: { ...CS, geometry: { cartographic: true, analyticalAvailable: true }, decision: exploratoryDecision(undefined, [NOT_SURVEY_GRADE_NOTE]), standardsTraceability: true },
  cartographicOnly: { ...CS, geometry: { cartographic: true, analyticalAvailable: false }, validation: { ...CS.validation, rmseM: null, independentCheckpoints: true }, decision: exploratoryDecision() },
  unknowns: { ...CS, provenance: { ...CS_PROV, crs: 'not georeferenced', verticalDatum: 'unknown', horizontalUnit: 'units', verticalUnit: 'unknown', grid: 'unknown', methodIds: [], sourceSha256: STREAMED_SOURCE_NOTE, gitCommit: '0.5.9 (dirty) · dev · built unknown' } },
  degrees: { ...CS, provenance: { ...CS_PROV, horizontalUnit: 'degrees', verticalUnit: 'ft', grid: '10x10 @ 0.00001 degrees', sourceSha256: SOURCE_NOT_HELD_NOTE } },
};
