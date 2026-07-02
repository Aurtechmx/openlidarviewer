/**
 * src/terrain/complexity — literature-defined terrain-complexity metrics.
 *
 * Pure-data leaves (no DOM, no three.js, no I/O, deterministic):
 *   - TPI + slope-position classes per Weiss (2001)
 *   - VRM per Sappington, Longshore & Thompson (2007), doi:10.2193/2005-723
 *
 * Both consume the existing `hornSlopeAspect` conventions where slope
 * enters (rise/run tangent; math-frame downslope aspect) — nothing here
 * recomputes derivatives. Imported ONLY by the lazily-loaded analysis
 * pipeline (`analyseContours` chunk), never by the app shell, so the
 * index bundle carries none of this weight.
 */

export {
  computeTPI,
  TPI_CLASS,
  TPI_FLAT_SLOPE_TAN,
  type TpiParams,
  type TpiResult,
  type TpiSummary,
  type TpiClassName,
} from './terrainPositionIndex';

export {
  computeVRM,
  type VrmParams,
  type VrmResult,
  type VrmSummary,
} from './vectorRuggedness';

export {
  deriveComplexityConfidence,
  finaliseComplexityEnvelope,
  type ComplexityEnvelope,
  type ComplexityMetaInput,
  type ComplexitySupport,
} from './complexityEnvelope';

export {
  summariseTerrainComplexity,
  vrmBand,
  complexityBandLabel,
  densityReliabilityCaveat,
  pickTpiRadiusCells,
  tpiClassLabel,
  COMPLEXITY_DENSITY_THRESHOLD_PTS_M2,
  SLOPE_ASPECT_CONVENTION_NOTE,
  TPI_TARGET_RADIUS_M,
  VRM_BAND_THRESHOLDS,
  type ComplexityBand,
  type ComplexitySummaryInput,
  type TerrainComplexitySummary,
} from './complexitySummary';
