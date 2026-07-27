/**
 * runBackends.test.ts — the entry point `npm run benchmark:backends` invokes.
 *
 * Two things happen here, and only one of them can happen in Node.
 *
 * THE CPU CONTROL, WHICH ALWAYS RUNS. The CPU backend is put through the same
 * probe workload the GPU leg uses and must disagree with the CPU reference
 * nowhere at all. Both sides are the same f64 code, so anything but zero means
 * the harness is measuring itself and no GPU number taken through it would be
 * trustworthy. This is the control on the instrument, taken before the
 * instrument is used.
 *
 * THE GPU ATTEMPT, WHICH IN NODE ALWAYS FALLS BACK. Node exposes no WebGPU
 * adapter. The engine detects that and returns the CPU reference, silently,
 * which is the correct product behaviour. The leg written here records
 * `requestedBackend: 'gpu'` and `executedBackend: 'cpu'` with the engine's
 * reason, and the comparator turns that into `backend-unavailable` — the
 * question was not answered on this host. The test asserts that outcome rather
 * than treating it as a pass, so a Node run can never be cited as evidence the
 * backends agree.
 *
 * The real answer comes from `npm run benchmark:backends:gpu`, which runs
 * tests/e2e/backendGpuLeg.spec.ts in a browser, overwrites the GPU slot with a
 * record taken on an actual adapter, and rebuilds the comparison.
 *
 * A vitest file rather than a bare node script, for the reason the other
 * benchmark entry points are: the framework reads `__BUILD_IDENTITY__`, a Vite
 * define, which is a ReferenceError under plain node.
 */

import { execFileSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';
import { cpuControlLeg, legFromComputeStatus } from '../../benchmarks/backends/leg';
import { checkCpuControl } from '../../benchmarks/backends/compare';
import {
  CPU_LEG_FILE,
  GPU_LEG_FILE,
  writeComparison,
  writeLeg,
} from '../../benchmarks/backends/writer';
import {
  TerrainRasterEngine,
  runEquivalenceProbe,
} from '../../src/terrain/engine/TerrainRasterEngine';
import { createCpuBackend } from '../../src/terrain/engine/cpuBackend';

const enabled = process.env.BENCHMARK_BACKENDS === '1';

/** The commit both legs must share. Null when this is not a git checkout. */
function currentCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

describe('benchmark:backends', () => {
  test.runIf(enabled)(
    'record the CPU reference leg and whatever backend this host could actually run',
    async () => {
      const commit = currentCommit();
      const runtime = `node ${process.version}`;

      // ── The control on the instrument ──
      const controlProbe = await runEquivalenceProbe(createCpuBackend());
      const cpu = cpuControlLeg(controlProbe, {
        legId: 'cpu-reference',
        environment: 'node',
        commit,
        runtime,
      });
      const control = checkCpuControl(cpu);
      expect(
        control.problems,
        'the CPU backend must agree with the CPU reference exactly; a non-zero difference here means the harness is measuring itself rather than the backends',
      ).toEqual([]);
      writeLeg(cpu, CPU_LEG_FILE);

      // ── The GPU attempt, through the shipped factory ──
      // No injected seam: this asks for the GPU the way the product does, so
      // what gets recorded is what this host genuinely provides.
      const engine = new TerrainRasterEngine();
      const status = await engine.init();
      const gpu = legFromComputeStatus(status, {
        legId: 'gpu-attempt',
        environment: 'node',
        requestedBackend: 'gpu',
        adapter: null,
        commit,
        runtime,
      });
      writeLeg(gpu, GPU_LEG_FILE);

      const { comparison } = writeComparison();

      // Node cannot answer the question, and the suite has to say so rather
      // than report the agreement the fallback would otherwise manufacture.
      expect(gpu.requestedBackend).toBe('gpu');
      expect(gpu.executedBackend).toBe('cpu');
      expect(comparison.status).toBe('backend-unavailable');
      expect(comparison.equivalenceEstablished).toBe(false);
      expect(comparison.quantities).toEqual([]);
    },
    600_000,
  );
});
