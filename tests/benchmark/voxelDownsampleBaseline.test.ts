/**
 * voxelDownsampleBaseline.test.ts: one voxel pass, typed accumulator against
 * the Map-based reference, on a random volume. Gated on `VOXEL_BENCH=1`;
 * every run is printed, nothing asserted on time.
 */
import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { voxelDownsample } from '../../src/process/voxelDownsample';
import { voxelDownsampleReference } from '../helpers/voxelDownsampleReference';
import { PointCloud } from '../../src/model/PointCloud';

const ENABLED = process.env.VOXEL_BENCH === '1';
const POINTS = Number(process.env.VOXEL_BENCH_POINTS ?? 2_000_000);

// Skipped by design outside a benchmark run: it needs an explicit opt-in.
describe.skipIf(!ENABLED)('voxelDownsample pass cost', () => {
  it('times one pass at the size downsampleToBudget would start from', () => {
    let s = 20260915;
    const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0xffffffff);
    const positions = new Float32Array(POINTS * 3);
    for (let i = 0; i < POINTS; i++) { positions[i * 3] = rnd() * 1000; positions[i * 3 + 1] = rnd() * 1000; positions[i * 3 + 2] = rnd() * 50; }
    const cloud = new PointCloud({ positions, origin: [0, 0, 0], sourceFormat: 'laz', name: 'v' });
    for (const size of [0.9, 2, 4]) {
      const t: Record<string, number[]> = { typed: [], reference: [] };
      for (let r = 0; r < 3; r++) {
        let t0 = performance.now(); const a = voxelDownsample(cloud, size); t.typed.push(performance.now() - t0);
        t0 = performance.now(); const b = voxelDownsampleReference(cloud, size); t.reference.push(performance.now() - t0);
        expect(a.pointCount).toBe(b.pointCount);
      }
      // eslint-disable-next-line no-console
      console.log(`  ${POINTS / 1e6}M pts, voxel ${size}: typed best ${Math.min(...t.typed).toFixed(0)} ms  reference best ${Math.min(...t.reference).toFixed(0)} ms  runs typed[${t.typed.map((x) => x.toFixed(0)).join(',')}] ref[${t.reference.map((x) => x.toFixed(0)).join(',')}]`);
    }
  }, 600_000);
});
