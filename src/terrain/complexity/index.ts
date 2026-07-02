/**
 * src/terrain/complexity — literature-defined terrain-complexity metrics.
 *
 * Pure-data leaves (no DOM, no three.js, no I/O, deterministic):
 *   - TPI + slope-position classes per Weiss (2001)
 *   - VRM per Sappington, Longshore & Thompson (2007), doi:10.2193/2005-723
 *
 * Both consume the existing `hornSlopeAspect` conventions where slope
 * enters (rise/run tangent; math-frame downslope aspect) — nothing here
 * recomputes derivatives. Not imported by the app shell yet: lazy-loadable
 * later without touching the index bundle.
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
