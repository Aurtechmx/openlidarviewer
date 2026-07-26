/**
 * compare.ts
 *
 * The verdict: do the GPU and CPU implementations of the terrain derivative
 * products agree, and to what precision.
 *
 * THE ORDER OF CHECKS IS THE POINT. Four things can be wrong with a pair of
 * legs, and three of them are not "the backends disagree". Reporting them in
 * measurement order would blame the backends for all four, so they are
 * separated and each gets its own status:
 *
 *   1. The GPU leg did not run on a GPU. Node exposes no WebGPU adapter and the
 *      engine falls back to the CPU reference by design, so a naive comparison
 *      at this point compares the CPU against itself and reports perfect
 *      agreement. Status `backend-unavailable`, and the comparison is
 *      SUPPRESSED rather than run — no tolerance is evaluated, no agreement is
 *      claimed, and no failure is recorded either.
 *   2. The GPU leg claims a GPU without an adapter to show for it. Status
 *      `record-not-credible`.
 *   3. The two legs ran different parameters — a different grid, a different
 *      cell geometry, edited gate constants, a different commit. Their numbers
 *      are not two measurements of one quantity. Status `parameters-diverged`,
 *      comparison suppressed.
 *   4. Only then, the measurements. Status `equivalent-within-tolerance` or
 *      `backends-diverged`.
 *
 * SUPPRESSION IS NOT A PASS AND NOT A FAILURE. Everything above returns
 * `equivalenceEstablished: false`, and each carries the reason it could not be
 * established. A reader who sees `backend-unavailable` learns that the question
 * was not answered on this host, which is true and useful, rather than an
 * answer that was never measured.
 *
 * THE THRESHOLDS ARE READ FROM `tolerances.ts` AND NOTHING HERE ADJUSTS THEM.
 * A measurement above a gate produces `backends-diverged` with the quantity and
 * the magnitude. A measurement above the representation floor but below the
 * gate produces a pass with the excess reported as an observation, because that
 * is a divergence f32 arithmetic does not fully explain and a reader is
 * entitled to see it.
 *
 * Pure. No I/O, no clock, no randomness.
 */

import {
  gpuClaimNotCredible,
  type BackendLegRecord,
  BACKEND_SCHEMA_VERSION,
} from './record';
import {
  ASPECT_COMPARISON_SLOPE_FLOOR,
  ASPECT_GATE_RAD,
  ASPECT_REPRESENTATION_FLOOR,
  SCATTER_GATE,
  SHADE_GATE_LEVELS,
  SLOPE_GATE,
  SLOPE_REPRESENTATION_FLOOR,
} from './tolerances';

export type BackendComparisonStatus =
  /** Every compared quantity inside its pre-registered gate. */
  | 'equivalent-within-tolerance'
  /** A quantity exceeded its gate. A finding. */
  | 'backends-diverged'
  /** The requested backend did not execute. Comparison suppressed. */
  | 'backend-unavailable'
  /** A leg claims a backend its environment cannot provide. Comparison suppressed. */
  | 'record-not-credible'
  /** The legs ran different parameters. Comparison suppressed. */
  | 'parameters-diverged';

/** One quantity, its measurement, and where it fell relative to the thresholds. */
export interface QuantityVerdict {
  readonly quantity: string;
  readonly unit: string;
  readonly observed: number;
  readonly gate: number;
  readonly representationFloor: number | null;
  readonly withinGate: boolean;
  /**
   * True when the observation exceeds what f32 evaluation alone accounts for
   * while remaining inside the gate. Reported, never a failure on its own.
   */
  readonly aboveRepresentationFloor: boolean;
  /** Cells the quantity was measured over. */
  readonly cells: number;
}

export interface BackendComparison {
  readonly backendSchemaVersion: number;
  readonly status: BackendComparisonStatus;
  /** True only for `equivalent-within-tolerance`. */
  readonly equivalenceEstablished: boolean;
  /** Present whenever the status is not an equivalence verdict. */
  readonly suppressionReason: string | null;
  readonly cpuLegId: string | null;
  readonly gpuLegId: string | null;
  /** What each leg actually executed, as the engine reported it. */
  readonly executed: Readonly<Record<string, string>>;
  /** Why each leg is on the backend it is on. */
  readonly reasons: Readonly<Record<string, string>>;
  /** Empty when the comparison was suppressed. */
  readonly quantities: readonly QuantityVerdict[];
  /** Quantities that exceeded their gate. A finding, in the report's own words. */
  readonly divergences: readonly string[];
  /** Things this comparison does not establish, enumerated rather than implied. */
  readonly notCovered: readonly string[];
}

/**
 * What the suite does not establish.
 *
 * Fixed text, present on every comparison including a passing one, so the
 * limits travel with the claim instead of living in a document a reader may not
 * open.
 */
export const NOT_COVERED: readonly string[] = [
  'the ground filter and the mean/median/percentile/robust DTM rasterisation, which have no GPU implementation and run the CPU functions under both backends',
  'grids larger than the probe surface: the comparison is over a 64x64 derivative grid and a 24x24 scatter grid, so nothing here bounds a workgroup-tiling error that only appears past one dispatch tile',
  'real scan data: the surfaces are the engine probe fixtures, chosen for coverage of the flat, NaN-hole, anisotropic and vertical-unit paths rather than for resembling a particular landscape',
  'GPU adapters other than the one the recorded leg ran on; WGSL leaves atan2, sqrt and operation fusion at implementation precision, so a second vendor is a second measurement',
  'aspect on cells whose reference slope is below the 1e-6 floor, where the gradient direction is not a meaningful quantity; those cells are covered by the hillshade gate instead',
  'timing: this suite compares outputs, and reports no number for which backend is faster',
];

/** An adapter's shortest honest name; browsers leave most of these fields blank. */
export function adapterName(adapter: {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
}): string {
  const named = [adapter.vendor, adapter.architecture, adapter.device]
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .join(' ');
  return named !== '' ? named : adapter.description.trim() || 'an adapter the browser did not name';
}

function reasonsOf(legs: readonly BackendLegRecord[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const leg of legs) out[leg.legId] = leg.reason;
  return out;
}

function executedOf(legs: readonly BackendLegRecord[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const leg of legs) out[leg.legId] = leg.executedBackend;
  return out;
}

function suppressed(
  status: BackendComparisonStatus,
  reason: string,
  cpu: BackendLegRecord | null,
  gpu: BackendLegRecord | null,
): BackendComparison {
  const legs = [cpu, gpu].filter((l): l is BackendLegRecord => l !== null);
  return {
    backendSchemaVersion: BACKEND_SCHEMA_VERSION,
    status,
    equivalenceEstablished: false,
    suppressionReason: reason,
    cpuLegId: cpu?.legId ?? null,
    gpuLegId: gpu?.legId ?? null,
    executed: executedOf(legs),
    reasons: reasonsOf(legs),
    quantities: [],
    divergences: [],
    notCovered: NOT_COVERED,
  };
}

/**
 * The parameter fields both legs must agree on before their measurements are
 * comparable, in the order they are checked.
 */
function parameterMismatch(cpu: BackendLegRecord, gpu: BackendLegRecord): string | null {
  if (cpu.backendSchemaVersion !== gpu.backendSchemaVersion) {
    return `leg schema versions differ (${cpu.backendSchemaVersion} vs ${gpu.backendSchemaVersion}); the fields do not mean the same thing on both sides`;
  }
  if (cpu.workloadHash !== gpu.workloadHash) {
    return `the legs ran different workloads (${cpu.workloadHash.slice(0, 12)} vs ${gpu.workloadHash.slice(0, 12)}); their numbers are not two measurements of one quantity`;
  }
  if (cpu.commit !== null && gpu.commit !== null && cpu.commit !== gpu.commit) {
    return `the legs were taken at different commits (${cpu.commit.slice(0, 12)} vs ${gpu.commit.slice(0, 12)})`;
  }
  return null;
}

/**
 * Compare a CPU leg and a GPU leg.
 *
 * The CPU leg is the reference by contract and its own measurements are the
 * control: a CPU leg run against the CPU backend must show exactly zero
 * disagreement, and a non-zero one there means the harness is measuring
 * something other than the backends.
 */
export function compareBackends(
  cpu: BackendLegRecord | null,
  gpu: BackendLegRecord | null,
): BackendComparison {
  if (cpu === null) {
    return suppressed('backend-unavailable', 'no CPU reference leg was recorded', cpu, gpu);
  }
  if (gpu === null) {
    return suppressed(
      'backend-unavailable',
      'no GPU leg was recorded; the GPU-vs-CPU question is unanswered on this host',
      cpu,
      gpu,
    );
  }

  // 1. Did a GPU actually run. Asked before anything is measured, because the
  //    engine's fallback is silent and its outputs are then the CPU's own.
  if (gpu.executedBackend !== 'gpu') {
    return suppressed(
      'backend-unavailable',
      `the GPU leg requested ${gpu.requestedBackend} and the engine reported ${gpu.executedBackend} (${gpu.reason}); comparing these outputs would compare the CPU against itself`,
      cpu,
      gpu,
    );
  }

  // 2. Is the GPU claim believable.
  const notCredible = gpuClaimNotCredible(gpu);
  if (notCredible !== null) {
    return suppressed('record-not-credible', notCredible, cpu, gpu);
  }

  // 3. Did the two legs run the same thing.
  const mismatch = parameterMismatch(cpu, gpu);
  if (mismatch !== null) {
    return suppressed('parameters-diverged', mismatch, cpu, gpu);
  }

  const m = gpu.measurements;
  if (m === null) {
    return suppressed('backend-unavailable', `leg ${gpu.legId} recorded no measurements`, cpu, gpu);
  }

  // 4. The measurements.
  const quantities: QuantityVerdict[] = [
    {
      quantity: 'slope',
      unit: 'rise/run',
      observed: m.maxSlopeErr,
      gate: SLOPE_GATE,
      representationFloor: SLOPE_REPRESENTATION_FLOOR,
      withinGate: m.maxSlopeErr <= SLOPE_GATE,
      aboveRepresentationFloor: m.maxSlopeErr > SLOPE_REPRESENTATION_FLOOR,
      cells: m.cells,
    },
    {
      quantity: 'aspect',
      unit: 'rad',
      observed: m.maxAspectErr,
      gate: ASPECT_GATE_RAD,
      representationFloor: ASPECT_REPRESENTATION_FLOOR,
      withinGate: m.maxAspectErr <= ASPECT_GATE_RAD,
      aboveRepresentationFloor: m.maxAspectErr > ASPECT_REPRESENTATION_FLOOR,
      cells: m.comparedAspectCells,
    },
    {
      quantity: 'hillshade',
      unit: '8-bit grey level',
      observed: m.maxShadeErr,
      gate: SHADE_GATE_LEVELS,
      representationFloor: null,
      withinGate: m.maxShadeErr <= SHADE_GATE_LEVELS,
      aboveRepresentationFloor: false,
      cells: m.cells,
    },
  ];

  // The scatter is exact or it is not; there is no magnitude to report. A
  // backend without a scatter contributes no verdict rather than a vacuous
  // pass, and the absence is named in the divergence list below.
  if (m.scatterExact !== null) {
    quantities.push({
      quantity: 'scatterMinCount',
      unit: 'cells differing',
      observed: m.scatterExact ? 0 : m.scatterCells,
      gate: SCATTER_GATE,
      representationFloor: null,
      withinGate: m.scatterExact,
      aboveRepresentationFloor: false,
      cells: m.scatterCells,
    });
  }

  const divergences: string[] = [];
  for (const q of quantities) {
    if (!q.withinGate) {
      divergences.push(
        `${q.quantity}: the GPU differs from the CPU reference by up to ${q.observed} ${q.unit} over ${q.cells} cells, against a pre-registered gate of ${q.gate}`,
      );
    }
  }
  if (!m.coverageMatches) {
    divergences.push(
      'hillshade coverage: the two backends marked different cells as covered, so the shaded extent itself differs',
    );
  }

  const legs = [cpu, gpu];
  const status: BackendComparisonStatus =
    divergences.length === 0 ? 'equivalent-within-tolerance' : 'backends-diverged';
  const notCovered = [...NOT_COVERED];
  if (m.scatterExact === null) {
    notCovered.push(
      'the DTM min/count scatter: this GPU backend reported no scatter implementation, so that product was not compared',
    );
  }
  if (gpu.adapter !== null) {
    notCovered.push(
      `adapters other than ${adapterName(gpu.adapter)}, the one this leg ran on`,
    );
  }

  return {
    backendSchemaVersion: BACKEND_SCHEMA_VERSION,
    status,
    equivalenceEstablished: status === 'equivalent-within-tolerance',
    suppressionReason: null,
    cpuLegId: cpu.legId,
    gpuLegId: gpu.legId,
    executed: executedOf(legs),
    reasons: reasonsOf(legs),
    quantities,
    divergences,
    notCovered,
  };
}

/**
 * The control on the harness itself: the CPU backend measured against the CPU
 * reference must disagree nowhere at all.
 *
 * Both sides are the same f64 code, so anything other than zero is the harness
 * measuring itself rather than the backends, and a suite with that fault would
 * report a floor it invented. Separate from `compareBackends` because it
 * answers a different question and must not be confused with a GPU result.
 */
export function checkCpuControl(cpu: BackendLegRecord): { pass: boolean; problems: string[] } {
  const problems: string[] = [];
  const m = cpu.measurements;
  if (m === null) {
    return { pass: false, problems: ['the CPU control leg recorded no measurements'] };
  }
  if (m.maxSlopeErr !== 0) problems.push(`CPU-vs-CPU slope error is ${m.maxSlopeErr}, not 0`);
  if (m.maxAspectErr !== 0) problems.push(`CPU-vs-CPU aspect error is ${m.maxAspectErr}, not 0`);
  if (m.maxShadeErr !== 0) problems.push(`CPU-vs-CPU shade error is ${m.maxShadeErr}, not 0`);
  if (!m.coverageMatches) problems.push('CPU-vs-CPU hillshade coverage masks differ');
  if (m.scatterExact === false) problems.push('CPU-vs-CPU scatter is not bit-identical');
  if (m.comparedAspectCells === 0) {
    problems.push(
      `no cell cleared the ${ASPECT_COMPARISON_SLOPE_FLOOR} aspect floor, so the aspect comparison was vacuous`,
    );
  }
  return { pass: problems.length === 0, problems };
}
