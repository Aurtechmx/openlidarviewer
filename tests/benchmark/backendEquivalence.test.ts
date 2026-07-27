/**
 * backendEquivalence.test.ts
 *
 * The suite's own gate: the comparator behaves as documented, and the
 * fallback detector actually detects.
 *
 * THE NEGATIVE CONTROLS ARE THE REASON THIS FILE EXISTS. A GPU-vs-CPU check
 * that runs on a host with no WebGPU adapter compares the CPU reference against
 * itself and reports flawless agreement, and every number in it is real. The
 * controls below force exactly that situation — a real `TerrainRasterEngine`
 * whose injected factory reports no adapter, and one whose injected factory
 * hands back the CPU backend wearing a GPU label — and assert the suite refuses
 * to call either of them agreement.
 *
 * The CPU-against-CPU control runs unconditionally and must show zero
 * disagreement on every quantity. A non-zero number there would mean the
 * harness is measuring itself.
 */

import { describe, test, expect } from 'vitest';
import {
  ENGINE_REASONS,
  buildBackendLeg,
  gpuClaimNotCredible,
  hashWorkload,
  type AdapterDescriptor,
  type BackendLegRecord,
} from '../../benchmarks/backends/record';
import {
  compareBackends,
  checkCpuControl,
  NOT_COVERED,
} from '../../benchmarks/backends/compare';
import {
  ASPECT_GATE_RAD,
  ASPECT_REPRESENTATION_FLOOR,
  PRE_REGISTERED_TOLERANCES,
  SLOPE_GATE,
  SLOPE_REPRESENTATION_FLOOR,
} from '../../benchmarks/backends/tolerances';
import {
  SCATTER_PROBE_COLS,
  SCATTER_PROBE_POINTS,
  SCATTER_PROBE_ROWS,
  cpuControlLeg,
  currentWorkload,
  legFromComputeStatus,
} from '../../benchmarks/backends/leg';
import { comparisonMarkdown } from '../../benchmarks/backends/render';
import {
  EQUIVALENCE_ASPECT_SLOPE_FLOOR,
  EQUIVALENCE_SHADE_TOLERANCE,
  EQUIVALENCE_SLOPE_TOLERANCE,
  TerrainRasterEngine,
  buildScatterProbe,
  runEquivalenceProbe,
} from '../../src/terrain/engine/TerrainRasterEngine';
import { createCpuBackend } from '../../src/terrain/engine/cpuBackend';

import { witnessSuite } from './reachability';

// Both claims are witnessed from one counter window; see reachability.ts.
witnessSuite('backend-selection', 'terrain-derivatives-node');

const ADAPTER: AdapterDescriptor = {
  vendor: 'test',
  architecture: 'test-arch',
  device: 'test-device',
  description: 'a recorded adapter',
  features: [],
};

/** A believable GPU leg: browser environment, adapter present, measurements taken. */
function gpuLeg(overrides: Partial<BackendLegRecord> = {}): BackendLegRecord {
  const base = buildBackendLeg({
    legId: 'gpu',
    environment: 'browser',
    requestedBackend: 'gpu',
    reason: 'gpu-active',
    path: 'gpu',
    adapter: ADAPTER,
    commit: 'abc123',
    workload: currentWorkload(),
    measurements: {
      cells: 4096,
      comparedAspectCells: 11000,
      maxSlopeErr: 1e-6,
      maxAspectErr: 1e-6,
      maxShadeErr: 0,
      coverageMatches: true,
      scatterExact: true,
      scatterCells: 576,
    },
    runtime: 'test',
  });
  return { ...base, ...overrides };
}

function cpuLeg(overrides: Partial<BackendLegRecord> = {}): BackendLegRecord {
  const base = buildBackendLeg({
    legId: 'cpu',
    environment: 'node',
    requestedBackend: 'cpu',
    reason: 'cpu-reference',
    path: 'cpu',
    adapter: null,
    commit: 'abc123',
    workload: currentWorkload(),
    measurements: {
      cells: 4096,
      comparedAspectCells: 11000,
      maxSlopeErr: 0,
      maxAspectErr: 0,
      maxShadeErr: 0,
      coverageMatches: true,
      scatterExact: true,
      scatterCells: 576,
    },
    runtime: 'test',
  });
  return { ...base, ...overrides };
}

describe('pre-registered tolerances', () => {
  test('every gate is at or above the magnitude it was derived from', () => {
    expect(SLOPE_GATE).toBeGreaterThan(SLOPE_REPRESENTATION_FLOOR);
    expect(ASPECT_GATE_RAD).toBeGreaterThan(ASPECT_REPRESENTATION_FLOOR);
  });

  test('no suite gate is looser than the gate the product itself enforces', () => {
    // A suite that certified a backend the engine would refuse to activate
    // would be certifying something the user never gets.
    expect(SLOPE_GATE).toBeLessThanOrEqual(EQUIVALENCE_SLOPE_TOLERANCE);
    expect(ASPECT_GATE_RAD).toBeLessThanOrEqual(EQUIVALENCE_SLOPE_TOLERANCE);
    expect(PRE_REGISTERED_TOLERANCES.find((t) => t.quantity === 'hillshade')!.gate).toBeLessThanOrEqual(
      EQUIVALENCE_SHADE_TOLERANCE,
    );
  });

  test('every quantity the comparator can report has a pre-registered threshold', () => {
    const registered = new Set(PRE_REGISTERED_TOLERANCES.map((t) => t.quantity));
    const reported = compareBackends(cpuLeg(), gpuLeg()).quantities.map((q) => q.quantity);
    expect(reported.length).toBeGreaterThan(0);
    for (const q of reported) expect(registered.has(q)).toBe(true);
  });
});

describe('the workload descriptor tracks the engine', () => {
  test('the scatter probe shape matches the numbers the descriptor mirrors', () => {
    const probe = buildScatterProbe();
    expect(probe.points.count).toBe(SCATTER_PROBE_POINTS);
    expect(probe.grid.cols).toBe(SCATTER_PROBE_COLS);
    expect(probe.grid.rows).toBe(SCATTER_PROBE_ROWS);
  });

  test('the descriptor carries the engine gate constants', () => {
    const w = currentWorkload();
    expect(w.engineSlopeTolerance).toBe(EQUIVALENCE_SLOPE_TOLERANCE);
    expect(w.engineAspectSlopeFloor).toBe(EQUIVALENCE_ASPECT_SLOPE_FLOOR);
  });

  test('the hash is order-independent and changes with any parameter', () => {
    const w = currentWorkload();
    const reordered = Object.fromEntries(
      Object.entries(w).reverse(),
    ) as unknown as typeof w;
    expect(hashWorkload(reordered)).toBe(hashWorkload(w));
    expect(hashWorkload({ ...w, probeGridCols: w.probeGridCols + 1 })).not.toBe(hashWorkload(w));
  });
});

describe('negative controls: a forced fallback must not read as agreement', () => {
  test('no adapter at all reports backend-unavailable, not equivalence', async () => {
    // The Node situation, made explicit: the factory reports no WebGPU, the
    // engine falls back to the CPU reference exactly as it does in production,
    // and the outputs on both sides are then the same f64 code.
    const engine = new TerrainRasterEngine({
      gpuFactory: () => Promise.resolve({ ok: false, failure: 'webgpu-unavailable' as const }),
    });
    const status = await engine.init();
    expect(status.path).toBe('cpu');

    const leg = legFromComputeStatus(status, {
      legId: 'gpu',
      environment: 'browser',
      requestedBackend: 'gpu',
      adapter: null,
      commit: 'abc123',
      runtime: 'test',
    });
    expect(leg.requestedBackend).toBe('gpu');
    expect(leg.executedBackend).toBe('cpu');

    const comparison = compareBackends(cpuLeg(), leg);
    expect(comparison.status).toBe('backend-unavailable');
    expect(comparison.equivalenceEstablished).toBe(false);
    expect(comparison.quantities).toEqual([]);
    expect(comparison.suppressionReason).toContain('webgpu-unavailable');
  });

  test('a failed device request reports backend-unavailable', async () => {
    const engine = new TerrainRasterEngine({
      gpuFactory: () => Promise.resolve({ ok: false, failure: 'device-request-failed' as const }),
    });
    const leg = legFromComputeStatus(await engine.init(), {
      legId: 'gpu',
      environment: 'browser',
      requestedBackend: 'gpu',
      adapter: null,
      commit: 'abc123',
      runtime: 'test',
    });
    const comparison = compareBackends(cpuLeg(), leg);
    expect(comparison.status).toBe('backend-unavailable');
    expect(comparison.equivalenceEstablished).toBe(false);
  });

  test('the CPU backend wearing a GPU label is refused, not believed', async () => {
    // The subtler impostor: the factory succeeds, the probe passes perfectly
    // because both sides are the same code, and the engine honestly reports
    // 'gpu-active' — it has no way to know what it was handed. The record
    // boundary catches it: a GPU claim from a Node environment has no adapter
    // behind it.
    const engine = new TerrainRasterEngine({
      gpuFactory: () => Promise.resolve({ ok: true as const, backend: createCpuBackend() }),
    });
    const status = await engine.init();
    expect(status.path).toBe('gpu');
    expect(status.probe!.maxSlopeErr).toBe(0);

    const leg = legFromComputeStatus(status, {
      legId: 'gpu',
      environment: 'node',
      requestedBackend: 'gpu',
      adapter: null,
      commit: 'abc123',
      runtime: 'test',
    });
    expect(leg.executedBackend).toBe('gpu');
    expect(gpuClaimNotCredible(leg)).not.toBeNull();

    const comparison = compareBackends(cpuLeg(), leg);
    expect(comparison.status).toBe('record-not-credible');
    expect(comparison.equivalenceEstablished).toBe(false);
    expect(comparison.quantities).toEqual([]);
  });

  test('a missing GPU leg reports backend-unavailable', () => {
    const comparison = compareBackends(cpuLeg(), null);
    expect(comparison.status).toBe('backend-unavailable');
    expect(comparison.equivalenceEstablished).toBe(false);
  });
});

describe('a divergence is a finding, not a widened threshold', () => {
  test('slope past its gate reports the quantity, the magnitude and the backend', () => {
    const leg = gpuLeg();
    const diverged: BackendLegRecord = {
      ...leg,
      measurements: { ...leg.measurements!, maxSlopeErr: 3e-3 },
    };
    const comparison = compareBackends(cpuLeg(), diverged);
    expect(comparison.status).toBe('backends-diverged');
    expect(comparison.equivalenceEstablished).toBe(false);
    expect(comparison.divergences.join(' ')).toContain('slope');
    expect(comparison.divergences.join(' ')).toContain('0.003');
    expect(comparison.divergences.join(' ')).toContain('GPU');
  });

  test('a probe mismatch counts as a GPU that ran and disagreed', () => {
    // The engine ends such a session on the CPU, but the GPU did execute and
    // did produce the numbers, so this must read as divergence rather than as
    // unavailability.
    const leg = gpuLeg({ reason: 'probe-mismatch', enginePath: 'cpu' });
    const withError: BackendLegRecord = {
      ...leg,
      measurements: { ...leg.measurements!, maxAspectErr: 0.5 },
    };
    expect(withError.executedBackend).toBe('gpu');
    const comparison = compareBackends(cpuLeg(), withError);
    expect(comparison.status).toBe('backends-diverged');
    expect(comparison.divergences.join(' ')).toContain('aspect');
  });

  test('a scatter mismatch fails against an exact threshold', () => {
    const leg = gpuLeg();
    const comparison = compareBackends(cpuLeg(), {
      ...leg,
      measurements: { ...leg.measurements!, scatterExact: false },
    });
    expect(comparison.status).toBe('backends-diverged');
    expect(comparison.divergences.join(' ')).toContain('scatterMinCount');
  });

  test('a difference above the f32 floor but inside the gate passes and is reported', () => {
    const leg = gpuLeg();
    const comparison = compareBackends(cpuLeg(), {
      ...leg,
      measurements: { ...leg.measurements!, maxSlopeErr: 9e-5 },
    });
    expect(comparison.status).toBe('equivalent-within-tolerance');
    const slope = comparison.quantities.find((q) => q.quantity === 'slope')!;
    expect(slope.withinGate).toBe(true);
    expect(slope.aboveRepresentationFloor).toBe(true);
  });

  test('disagreeing hillshade coverage is its own divergence', () => {
    const leg = gpuLeg();
    const comparison = compareBackends(cpuLeg(), {
      ...leg,
      measurements: { ...leg.measurements!, coverageMatches: false },
    });
    expect(comparison.status).toBe('backends-diverged');
    expect(comparison.divergences.join(' ')).toContain('coverage');
  });
});

describe('different parameters is a different verdict from different results', () => {
  test('a changed workload suppresses the comparison rather than blaming a backend', () => {
    const other = { ...currentWorkload(), probeGridCols: 128 };
    const leg = gpuLeg({ workload: other, workloadHash: hashWorkload(other) });
    const comparison = compareBackends(cpuLeg(), leg);
    expect(comparison.status).toBe('parameters-diverged');
    expect(comparison.quantities).toEqual([]);
    expect(comparison.suppressionReason).toContain('different workloads');
  });

  test('a different commit suppresses the comparison', () => {
    const comparison = compareBackends(cpuLeg(), gpuLeg({ commit: 'def456' }));
    expect(comparison.status).toBe('parameters-diverged');
  });
});

describe('the CPU control', () => {
  test('the CPU backend measured against the CPU reference disagrees nowhere', async () => {
    const probe = await runEquivalenceProbe(createCpuBackend());
    const leg = cpuControlLeg(probe, {
      legId: 'cpu-control',
      environment: 'node',
      commit: null,
      runtime: 'vitest',
    });
    const control = checkCpuControl(leg);
    expect(control.problems).toEqual([]);
    expect(control.pass).toBe(true);
    // The control is only meaningful if it actually compared something.
    expect(leg.measurements!.cells).toBe(64 * 64);
    expect(leg.measurements!.comparedAspectCells).toBeGreaterThan(0);
    expect(leg.measurements!.scatterExact).toBe(true);
  });
});

describe('the record and the report', () => {
  test('the mirrored engine reason list matches the engine', () => {
    // A reason added to the engine and not to this list would be classified by
    // whichever branch happened to catch it.
    const engineReasons = [
      'gpu-active',
      'not-initialised',
      'webgpu-unavailable',
      'device-request-failed',
      'probe-mismatch',
      'gpu-dispatch-failed',
    ];
    expect([...ENGINE_REASONS].sort()).toEqual(engineReasons.sort());
  });

  test('a suppressed comparison never prints an agreement claim', () => {
    const md = comparisonMarkdown(compareBackends(cpuLeg(), null), [cpuLeg()]);
    expect(md).toContain('backend-unavailable');
    expect(md).toContain('Not measured');
    expect(md).not.toContain('agree on every compared quantity');
  });

  test('the limits are printed on a pass as well as on a failure', () => {
    const comparison = compareBackends(cpuLeg(), gpuLeg());
    expect(comparison.status).toBe('equivalent-within-tolerance');
    for (const n of NOT_COVERED) expect(comparison.notCovered).toContain(n);
    const md = comparisonMarkdown(comparison, [cpuLeg(), gpuLeg()]);
    expect(md).toContain('## Not covered');
    expect(md).toContain('ground filter');
  });

  test('the report names which backend executed, not which was requested', () => {
    const engineFallback = gpuLeg({ executedBackend: 'cpu', reason: 'webgpu-unavailable' });
    const md = comparisonMarkdown(compareBackends(cpuLeg(), engineFallback), [engineFallback]);
    expect(md).toContain('| gpu | browser | gpu | **cpu** | webgpu-unavailable |');
  });
});
