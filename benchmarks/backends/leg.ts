/**
 * leg.ts
 *
 * Turning an engine compute status into a leg record, in one place used by
 * both runners.
 *
 * ONE CONVERSION, TWO RUNNERS. The CPU control is taken in vitest; the GPU leg
 * is taken by a Playwright spec that reads the engine's status out of a real
 * browser and builds its record here, in the Playwright process. Sharing this
 * function is what makes the two legs comparable: the workload descriptor, the
 * mapping from an engine reason to an executed backend, and the hash are the
 * same code on both sides, so a difference between two legs is a difference in
 * what ran rather than in how it was written down.
 *
 * THE WORKLOAD DESCRIPTOR IS BUILT FROM THE ENGINE'S OWN CONSTANTS. If a probe
 * grid size or a gate constant is edited in `TerrainRasterEngine.ts`, the hash
 * changes, and a comparison between a leg taken before the edit and one taken
 * after reports `parameters-diverged` instead of attributing the shift to a
 * backend.
 *
 * No I/O, no clock, no randomness. Imports the engine for its constants only.
 */

import {
  EQUIVALENCE_ASPECT_SLOPE_FLOOR,
  EQUIVALENCE_ASPECT_TOLERANCE_RAD,
  EQUIVALENCE_SHADE_TOLERANCE,
  EQUIVALENCE_SLOPE_TOLERANCE,
  PROBE_ANISO_CELL_X,
  PROBE_ANISO_CELL_Y,
  PROBE_GRID_SIZE,
  PROBE_Z_SCALE,
  type TerrainEquivalenceReport,
  type TerrainRasterComputeStatus,
} from '../../src/terrain/engine/TerrainRasterEngine';
import {
  buildBackendLeg,
  buildWorkloadDescriptor,
  CPU_REFERENCE_REASON,
  type AdapterDescriptor,
  type BackendKind,
  type BackendLegRecord,
  type BackendMeasurements,
  type EngineReason,
  type LegEnvironment,
  type WorkloadDescriptor,
} from './record';

/**
 * The scatter probe's shape, mirrored from `buildScatterProbe`.
 *
 * Mirrored rather than derived by calling the builder, because the descriptor
 * has to be constructible without allocating six thousand points, and because a
 * changed scatter probe should change the hash. A test asserts these three
 * numbers match what `buildScatterProbe()` actually produces.
 */
export const SCATTER_PROBE_POINTS = 6000;
export const SCATTER_PROBE_COLS = 24;
export const SCATTER_PROBE_ROWS = 24;

/** The workload both legs run, as the engine currently defines it. */
export function currentWorkload(): WorkloadDescriptor {
  return buildWorkloadDescriptor({
    probeGridSize: PROBE_GRID_SIZE,
    probeCellSizeM: 1,
    anisoCellX: PROBE_ANISO_CELL_X,
    anisoCellY: PROBE_ANISO_CELL_Y,
    zScale: PROBE_Z_SCALE,
    scatterPointCount: SCATTER_PROBE_POINTS,
    scatterCols: SCATTER_PROBE_COLS,
    scatterRows: SCATTER_PROBE_ROWS,
    slopeTolerance: EQUIVALENCE_SLOPE_TOLERANCE,
    aspectToleranceRad: EQUIVALENCE_ASPECT_TOLERANCE_RAD,
    aspectSlopeFloor: EQUIVALENCE_ASPECT_SLOPE_FLOOR,
    shadeTolerance: EQUIVALENCE_SHADE_TOLERANCE,
  });
}

/**
 * The raw maxima, taken from the probe report.
 *
 * The report's own `passed` flag is not carried across. A leg records what was
 * measured; whether it clears a threshold is the comparator's decision, made
 * against thresholds registered in this suite.
 */
export function measurementsFrom(probe: TerrainEquivalenceReport): BackendMeasurements {
  return {
    cells: probe.cells,
    comparedAspectCells: probe.comparedAspectCells,
    maxSlopeErr: probe.maxSlopeErr,
    maxAspectErr: probe.maxAspectErr,
    maxShadeErr: probe.maxShadeErr,
    coverageMatches: probe.coverageMatches,
    scatterExact: probe.scatterExact,
    scatterCells: probe.scatterCells,
  };
}

export interface LegFromStatusOptions {
  readonly legId: string;
  readonly environment: LegEnvironment;
  readonly requestedBackend: BackendKind;
  readonly adapter: AdapterDescriptor | null;
  readonly commit: string | null;
  readonly runtime: string;
}

/** Build a leg from what the engine reported after `init()`. */
export function legFromComputeStatus(
  status: Pick<TerrainRasterComputeStatus, 'path' | 'reason' | 'probe'>,
  options: LegFromStatusOptions,
): BackendLegRecord {
  return buildBackendLeg({
    legId: options.legId,
    environment: options.environment,
    requestedBackend: options.requestedBackend,
    reason: status.reason as EngineReason,
    path: status.path,
    adapter: options.adapter,
    commit: options.commit,
    workload: currentWorkload(),
    measurements: status.probe === null ? null : measurementsFrom(status.probe),
    runtime: options.runtime,
  });
}

/** Build the CPU control leg directly from a probe run against the CPU backend. */
export function cpuControlLeg(
  probe: TerrainEquivalenceReport,
  options: Omit<LegFromStatusOptions, 'requestedBackend' | 'adapter'>,
): BackendLegRecord {
  return buildBackendLeg({
    legId: options.legId,
    environment: options.environment,
    requestedBackend: 'cpu',
    reason: CPU_REFERENCE_REASON,
    path: 'cpu',
    adapter: null,
    commit: options.commit,
    workload: currentWorkload(),
    measurements: measurementsFrom(probe),
    runtime: options.runtime,
  });
}
