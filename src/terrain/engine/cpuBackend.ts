/**
 * cpuBackend.ts
 *
 * The CPU backend of the {@link TerrainRasterEngine} — PURE DELEGATION to
 * the existing, tested raster functions. No logic moves here, no parameters
 * are reinterpreted, no defaults change: every method is the underlying
 * function itself (or a Promise-wrapped call to it), so outputs are
 * byte-identical to calling those functions directly. This backend is the
 * REFERENCE implementation by contract — the GPU backend must prove
 * per-session equivalence against it before it is ever used — and the
 * always-available fallback (WebGL2-only devices run this path unchanged).
 *
 * Pure data, loadable in Node and workers. Deterministic.
 */

import { classifyGroundSmrf } from '../ground/groundFilter';
import { rasterizeDtm } from '../ground/rasterizeDtm';
import { hornSlopeAspect } from '../ground/terrainDerivatives';
import { shadeFromSlopeAspect } from '../surface/hillshade';
import { scatterMinCountReference } from './dtmScatter';
import type { TerrainRasterBackend } from './TerrainRasterEngine';

/** Build the delegation backend. Stateless — safe to construct repeatedly. */
export function createCpuBackend(): TerrainRasterBackend {
  return {
    kind: 'cpu',
    // Direct references: the engine's ground filter / rasteriser ARE the
    // existing functions — there is no wrapper logic to drift.
    groundFilterPass: classifyGroundSmrf,
    gridFromPoints: rasterizeDtm,
    // The DTM min/count scatter (phase 2) — the CPU path IS the reference the
    // GPU must match; wrapped in a resolved Promise for the async contract.
    scatterMinCount: (points, grid) => Promise.resolve(scatterMinCountReference(points, grid)),
    // The backend contract is async (WebGPU readback forces it); the CPU
    // implementations are synchronous, wrapped in a resolved Promise.
    derivatives: (z, cols, rows, cellSizeM) =>
      Promise.resolve(hornSlopeAspect(z, cols, rows, cellSizeM)),
    hillshade: (slope, aspect, coverage, cols, rows, params) =>
      Promise.resolve(shadeFromSlopeAspect(slope, aspect, coverage, cols, rows, params)),
  };
}
