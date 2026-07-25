/**
 * rebasePrecisionBaseline.test.ts — what the RETIRED in-place Float32 rebase
 * cost, kept as the historical context behind `rebaseQuantum`.
 *
 * The destructive mechanism (`rebaseOrigin`: add the frame shift straight
 * into the Float32 position array) was removed in step 5 of
 * docs/architecture/float64-transform.md — mounting is now a Float64
 * placement held beside the cloud, and nothing writes the buffer. Before it
 * went, this file MEASURED its cost (4096 points, 200 m extent, UTM 12N
 * magnitudes):
 *
 *   shift        drift      disclosed by the mount gate
 *      10 m    0.0038 mm
 *     100 m    0.0076 mm
 *   1 000 m    0.061  mm    0.122 mm
 *  10 000 m    0.488  mm    0.977 mm
 * 100 000 m    3.91   mm    7.81  mm   (refused: over the 1 mm budget)
 *
 * The observed error was half the disclosed quantum in every case — what a
 * worst-case rounding of half a step should give — so the gate over-stated
 * the cost by 2x rather than under-stating it. And the drift SATURATED after
 * the first mount/unmount cycle instead of accumulating: once a value sits on
 * a float32 grid point, adding and subtracting the same shift returns it to
 * that point.
 *
 * Why keep any of this? `rebaseQuantum` survives the removal because the
 * LayerService mount-refusal gates still read it as a conservative admission
 * rule: a mount that would have cost more than a millimetre under the old
 * mechanism is still refused, until browser verification of two-layer
 * placement (step 6) revisits the gates alongside
 * `MULTI_LAYER_MOUNT_ENABLED`. The cases below therefore measure the model
 * `rebaseQuantum` implements — a simulated Float32 rewrite, done on scratch
 * data, never through the (now nonexistent) PointCloud writer — and check the
 * disclosed figure still bounds the simulated cost. If the real error had
 * exceeded the disclosure, the tool would have been understating the cost of
 * its own operation.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';

/** A scan at realistic UTM-scale coordinates, recentred on its own origin. */
function scanAt(origin: [number, number, number], extentM: number, n = 4096): PointCloud {
  const positions = new Float32Array(n * 3);
  // Deterministic spread over the extent — mulberry32, no dependency.
  let s = 0x2f6e2b1;
  const rnd = (): number => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    positions[i * 3] = (rnd() - 0.5) * extentM;
    positions[i * 3 + 1] = (rnd() - 0.5) * extentM;
    positions[i * 3 + 2] = (rnd() - 0.5) * (extentM / 20);
  }
  return new PointCloud({ positions, origin, sourceFormat: 'las', name: 'baseline.las' });
}

// UTM 12N, a real-world magnitude. The absolute coordinate does not drive the
// error — the shift and the extent do — but using a plausible one keeps the
// numbers comparable to what a user would see.
const SOURCE_ORIGIN: [number, number, number] = [500000, 4100000, 1500];

describe('rebaseQuantum — the retired mechanism it models, measured', () => {
  it('the disclosed quantum bounds what the retired rewrite would have cost', () => {
    // Simulate the old writer on scratch values: shifting a coordinate onto a
    // far origin and back re-quantises it to the Float32 lattice twice. The
    // gate's figure must bound the observed loss, or the refusal threshold
    // would be named for a millimetre it does not actually protect.
    for (const shift of [1_000, 10_000, 100_000]) {
      const cloud = scanAt(SOURCE_ORIGIN, 200);
      const target: [number, number, number] = [
        SOURCE_ORIGIN[0] + shift,
        SOURCE_ORIGIN[1],
        SOURCE_ORIGIN[2],
      ];
      const disclosed = cloud.rebaseQuantum(target);

      let worstH = 0;
      for (let i = 0; i < cloud.positions.length; i += 3) {
        const written = Math.fround(cloud.positions[i] - shift); // the mount write
        const restored = Math.fround(written + shift); // the unmount write
        worstH = Math.max(
          worstH,
          Math.abs(written - (cloud.positions[i] - shift)), // loss at mount
          Math.abs(restored - cloud.positions[i]), // round-trip drift
        );
      }
      console.log(
        `  shift ${String(shift).padStart(7)} m  `
        + `simulated h ${(worstH * 1000).toPrecision(3)} mm  disclosed ${(disclosed.horizontal * 1000).toPrecision(3)} mm`,
      );
      expect(worstH).toBeLessThanOrEqual(disclosed.horizontal);
      expect(worstH).toBeGreaterThan(0); // the retired mechanism really was lossy
    }
  });

  it('cost scales with the distance moved, not the absolute coordinate', () => {
    const cloud = scanAt(SOURCE_ORIGIN, 200);
    const quanta = [10, 100, 1_000, 10_000, 100_000].map((shift) =>
      cloud.rebaseQuantum([SOURCE_ORIGIN[0] + shift, SOURCE_ORIGIN[1], SOURCE_ORIGIN[2]]).horizontal,
    );
    for (let i = 1; i < quanta.length; i++) {
      expect(quanta[i]).toBeGreaterThanOrEqual(quanta[i - 1]);
    }
    // A 100 km move must cost more than a 10 m one, or the model is wrong.
    expect(quanta[4]).toBeGreaterThan(quanta[0]);
    // And it crosses the gate's millimetre budget, which is why it refuses.
    expect(quanta[4]).toBeGreaterThan(0.001);
  });

  it('a scan that never leaves its own origin pays nothing beyond its own resolution', () => {
    // The common case, and the reason the admission rule passes every
    // single-layer mount: anchored on its own origin the modelled cost is the
    // cloud's OWN Float32 resolution over its extent — for a 200 m extent,
    // the step at a 100 m reach is 2^(6−23) ≈ 7.6 µm — with no separation
    // term at all. Three orders of magnitude under the millimetre budget.
    const cloud = scanAt(SOURCE_ORIGIN, 200);
    const q = cloud.rebaseQuantum([...SOURCE_ORIGIN]);
    expect(q.horizontal).toBe(2 ** (6 - 23));
    expect(q.vertical).toBeLessThanOrEqual(q.horizontal);
    expect(q.horizontal).toBeLessThan(1e-5);
  });
});
