/**
 * record.ts
 *
 * What one backend leg reports, and how a leg's claim to have run on a GPU is
 * made checkable by someone who did not watch it run.
 *
 * THE EXECUTED BACKEND IS READ FROM THE ENGINE, NEVER FROM THE REQUEST. A leg
 * asks for the GPU by constructing the engine and calling `init()`; what it
 * records is `getComputePath()` — the engine's own account of which backend it
 * ended up on and why. Those two fields are separate on the record on purpose,
 * and the comparator compares the executed one. A suite that recorded the
 * request would report agreement between the CPU and itself on any host without
 * a WebGPU adapter, which is the specific failure this file exists to prevent:
 * Node has no adapter, the engine falls back by design, and the fallback is
 * silent to the user because that is the correct product behaviour.
 *
 * A GPU CLAIM MUST COME WITH AN ADAPTER. `executedBackend: 'gpu'` is accepted
 * only from a record whose environment is `browser` and which carries an
 * adapter descriptor read from `navigator.gpu`. Nothing in Node can satisfy
 * that, so a Node leg cannot assert a GPU run even through an injected backend
 * factory — the seam that makes the engine testable is also the seam through
 * which a CPU implementation could impersonate a GPU one, and the credibility
 * check closes it at the record boundary rather than trusting the caller.
 *
 * THE PROBE IS THE MEASUREMENT. The engine already runs a GPU-vs-CPU
 * equivalence probe once per session: the same deterministic 64x64 surface
 * through `hornSlopeAspect` in f64 on one side and the WGSL kernels on the
 * other, over three geometries (square cells, anisotropic cells, a foot
 * vertical unit), plus an 8-bit hillshade pass and a 6000-point scatter. A leg
 * records the raw per-cell maxima that probe produced. The comparator re-judges
 * those maxima against this suite's own pre-registered thresholds and never
 * reads the probe's `passed` flag, so a probe whose internal gate was loosened
 * would change nothing about the verdict here.
 *
 * WHAT A RECORD DOES NOT CONTAIN: a username, a home directory, an absolute
 * path, or a wall-clock reading. The clock is an argument to the writer.
 *
 * Pure. No I/O, no clock, no randomness.
 */

import { compareCodeUnits } from '../../src/canonicalHash';
import { sha256Hex } from '../../src/terrain/export/sha256';
import {
  ASPECT_COMPARISON_SLOPE_FLOOR,
  ASPECT_GATE_RAD,
  SHADE_GATE_LEVELS,
  SLOPE_GATE,
} from './tolerances';

/** Schema version of a backend leg. Bumped when a field's meaning changes. */
export const BACKEND_SCHEMA_VERSION = 1;

/** Which implementation a leg asked for, and which one answered. */
export type BackendKind = 'cpu' | 'gpu';

/**
 * The engine's reason codes, mirrored from `TerrainRasterReason`.
 *
 * Written out rather than imported as a type alias so a reason added to the
 * engine shows up here as a decision to make — is it a GPU run, an
 * unavailability, or a divergence — rather than flowing into the comparator
 * under whichever branch happens to catch it. A test asserts this list matches
 * the engine's union.
 */
export const ENGINE_REASONS = [
  'gpu-active',
  'not-initialised',
  'webgpu-unavailable',
  'device-request-failed',
  'probe-mismatch',
  'gpu-dispatch-failed',
] as const;

export type EngineReason = (typeof ENGINE_REASONS)[number];

/**
 * The CPU control's reason.
 *
 * The control leg never asks the engine for a GPU, so no engine reason
 * describes it. Given its own value rather than borrowed from the union, so a
 * reader cannot mistake the control for a GPU session and the comparator cannot
 * either.
 */
export const CPU_REFERENCE_REASON = 'cpu-reference';

/** What a leg records as its reason: an engine reason, or the control's. */
export type LegReason = EngineReason | typeof CPU_REFERENCE_REASON;

/**
 * Reasons under which a GPU was genuinely dispatched to.
 *
 * `probe-mismatch` belongs here even though the engine ends the session on the
 * CPU: the probe only reaches its verdict by running both backends, so a
 * mismatch is a measurement of a real GPU, and reporting it as unavailability
 * would bury the one finding this suite most needs to surface.
 */
export const REASONS_WITH_GPU_EXECUTION: readonly EngineReason[] = ['gpu-active', 'probe-mismatch'];

/** Where the leg ran. */
export type LegEnvironment = 'node' | 'browser';

/** The WebGPU adapter a browser leg obtained, as the browser described it. */
export interface AdapterDescriptor {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  /** Adapter feature names, sorted. Recorded, never a pass condition. */
  readonly features: readonly string[];
}

/**
 * The parameters both legs must share for a comparison to mean anything.
 *
 * Hashed into `workloadHash`, which is checked before any measurement is. Two
 * legs that ran different grids, different cell geometries or different gate
 * constants are not two measurements of one question, and reporting their
 * numbers side by side would attribute a parameter difference to the backends.
 */
export interface WorkloadDescriptor {
  readonly probeGridCols: number;
  readonly probeGridRows: number;
  readonly probeCellSizeM: number;
  readonly anisoCellSizeXM: number;
  readonly anisoCellSizeYM: number;
  readonly zScale: number;
  readonly scatterPointCount: number;
  readonly scatterCols: number;
  readonly scatterRows: number;
  /** The engine's own gate constants, so a leg taken under edited ones is caught. */
  readonly engineSlopeTolerance: number;
  readonly engineAspectToleranceRad: number;
  readonly engineAspectSlopeFloor: number;
  readonly engineShadeTolerance: number;
}

/**
 * The raw per-cell maxima, one leg's side of the comparison.
 *
 * Maxima, not means. A mean over four thousand cells hides a single cell that
 * disagreed by a degree, and one such cell is a contour in the wrong place.
 */
export interface BackendMeasurements {
  /** Cells in the derivative probe grid. */
  readonly cells: number;
  /** Cells whose reference slope cleared the aspect floor, summed over passes. */
  readonly comparedAspectCells: number;
  /** Max per-cell |delta slope|, rise/run, worst of the three geometry passes. */
  readonly maxSlopeErr: number;
  /** Max per-cell angular aspect distance, radians, wrapped at 2*pi. */
  readonly maxAspectErr: number;
  /** Max per-cell |delta shade| in 8-bit grey levels. */
  readonly maxShadeErr: number;
  /** Hillshade coverage masks agreed cell for cell. */
  readonly coverageMatches: boolean;
  /** Scatter min/count matched bit for bit; null when the backend has no scatter. */
  readonly scatterExact: boolean | null;
  /** Cells in the scatter probe grid. */
  readonly scatterCells: number;
}

/** One backend's leg of the comparison. */
export interface BackendLegRecord {
  readonly backendSchemaVersion: number;
  readonly legId: string;
  readonly environment: LegEnvironment;
  /** What the leg asked the engine for. Never compared. */
  readonly requestedBackend: BackendKind;
  /** What the engine reported having run. This is what the comparator reads. */
  readonly executedBackend: BackendKind;
  /**
   * The engine's own `path` — which backend will serve the rest of the session.
   * Recorded because it differs from `executedBackend` after a probe mismatch,
   * and a reader should see both rather than wonder which one was meant.
   */
  readonly enginePath: BackendKind;
  readonly reason: LegReason;
  /** Present on a browser leg that obtained an adapter; null otherwise. */
  readonly adapter: AdapterDescriptor | null;
  readonly commit: string | null;
  readonly workload: WorkloadDescriptor;
  readonly workloadHash: string;
  /** Null when the leg never reached a measurement, which is the usual fallback case. */
  readonly measurements: BackendMeasurements | null;
  /** User agent for a browser leg, Node version for a Node leg. Reported, never compared. */
  readonly runtime: string;
}

/**
 * Canonical JSON: keys sorted at every depth, so a descriptor written with its
 * fields in another order hashes the same.
 */
function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    compareCodeUnits(a, b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
}

/** SHA-256 over the canonical form of the workload descriptor. */
export function hashWorkload(workload: WorkloadDescriptor): string {
  const text = canonicalise(workload);
  const bytes = new TextEncoder().encode(text);
  return sha256Hex(bytes);
}

/**
 * The workload both legs run, built from the engine's own constants.
 *
 * Takes them as arguments rather than importing them, so this module stays
 * loadable in the browser leg without pulling the engine in, and so a test can
 * build a descriptor that deliberately disagrees.
 */
export function buildWorkloadDescriptor(engine: {
  readonly probeGridSize: number;
  readonly probeCellSizeM: number;
  readonly anisoCellX: number;
  readonly anisoCellY: number;
  readonly zScale: number;
  readonly scatterPointCount: number;
  readonly scatterCols: number;
  readonly scatterRows: number;
  readonly slopeTolerance: number;
  readonly aspectToleranceRad: number;
  readonly aspectSlopeFloor: number;
  readonly shadeTolerance: number;
}): WorkloadDescriptor {
  return {
    probeGridCols: engine.probeGridSize,
    probeGridRows: engine.probeGridSize,
    probeCellSizeM: engine.probeCellSizeM,
    anisoCellSizeXM: engine.anisoCellX,
    anisoCellSizeYM: engine.anisoCellY,
    zScale: engine.zScale,
    scatterPointCount: engine.scatterPointCount,
    scatterCols: engine.scatterCols,
    scatterRows: engine.scatterRows,
    engineSlopeTolerance: engine.slopeTolerance,
    engineAspectToleranceRad: engine.aspectToleranceRad,
    engineAspectSlopeFloor: engine.aspectSlopeFloor,
    engineShadeTolerance: engine.shadeTolerance,
  };
}

export interface BuildLegOptions {
  readonly legId: string;
  readonly environment: LegEnvironment;
  readonly requestedBackend: BackendKind;
  readonly reason: LegReason;
  readonly path: BackendKind;
  readonly adapter: AdapterDescriptor | null;
  readonly commit: string | null;
  readonly workload: WorkloadDescriptor;
  readonly measurements: BackendMeasurements | null;
  readonly runtime: string;
}

/**
 * Build a leg, deriving `executedBackend` from the engine's reason rather than
 * from the engine's `path`.
 *
 * `path` answers "which backend will serve the rest of this session", and it is
 * `cpu` after a probe mismatch — correct for the product, wrong for this
 * record, because a mismatch is precisely a case where the GPU did run and did
 * produce numbers. `executedBackend` answers "did a GPU compute the measured
 * outputs", which is the question the comparator needs.
 */
export function buildBackendLeg(options: BuildLegOptions): BackendLegRecord {
  const gpuRan =
    options.requestedBackend === 'gpu' &&
    REASONS_WITH_GPU_EXECUTION.includes(options.reason as EngineReason);
  return {
    backendSchemaVersion: BACKEND_SCHEMA_VERSION,
    legId: options.legId,
    environment: options.environment,
    requestedBackend: options.requestedBackend,
    executedBackend: gpuRan ? 'gpu' : 'cpu',
    enginePath: options.path,
    reason: options.reason,
    adapter: options.adapter,
    commit: options.commit,
    workload: options.workload,
    workloadHash: hashWorkload(options.workload),
    measurements: options.measurements,
    runtime: options.runtime,
  };
}

/**
 * Whether a record's claim to have executed on a GPU can be believed.
 *
 * Returns null when it can, or the reason it cannot. Applied by the comparator
 * before any measurement is read.
 */
export function gpuClaimNotCredible(record: BackendLegRecord): string | null {
  if (record.executedBackend !== 'gpu') return null;
  if (record.environment !== 'browser') {
    return `leg ${record.legId} claims a GPU run from a ${record.environment} environment; a WebGPU adapter exists only in the browser`;
  }
  if (record.adapter === null) {
    return `leg ${record.legId} claims a GPU run but carries no adapter descriptor`;
  }
  if (record.measurements === null) {
    return `leg ${record.legId} claims a GPU run but recorded no measurements`;
  }
  return null;
}

/** The gates a leg's own workload must have been taken under, for the report. */
export const SUITE_GATES = {
  slope: SLOPE_GATE,
  aspectRad: ASPECT_GATE_RAD,
  aspectSlopeFloor: ASPECT_COMPARISON_SLOPE_FLOOR,
  shadeLevels: SHADE_GATE_LEVELS,
} as const;
