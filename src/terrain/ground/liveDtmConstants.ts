/**
 * liveDtmConstants.ts
 *
 * The tiny, dependency-free source of truth for the two DTM method constants
 * that both the production path (`analyseContours.computeTerrainCore`) and the
 * canonical method descriptor (`science/liveDtmDescriptor`) must agree on. They
 * live here — not inline in the heavy `analyseContours` module — so the
 * descriptor can import the SAME literal the production surface is built from
 * without pulling the whole terrain pipeline into its bundle. Change the value
 * here and both the delivered surface and the method digest move together; that
 * is the point.
 *
 * Pure data: no DOM, no three.js, no I/O.
 */

import type { DtmAggregation } from './rasterizeDtm';

/**
 * Per-cell aggregation of the delivered DTM surface: the 50th percentile is
 * outlier-resistant, so a lone high/low ground return no longer pulls the cell.
 * The hold-out validation rebuilds with this SAME aggregation and the DEM
 * provenance reports it, so the RMSE measures the surface that ships.
 */
export const LIVE_DTM_AGGREGATION: DtmAggregation = 'median';

/** ASPRS classification code for bare-earth ground returns. */
export const ASPRS_GROUND_CLASS = 2;
