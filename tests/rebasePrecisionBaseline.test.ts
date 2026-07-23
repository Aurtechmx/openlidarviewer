/**
 * rebasePrecisionBaseline.test.ts — what the in-place Float32 rebase costs.
 *
 * MEASURED, 4096 points, 200 m extent, UTM 12N magnitudes:
 *
 *   shift        drift      disclosed by the mount gate
 *      10 m    0.0038 mm
 *     100 m    0.0076 mm
 *   1 000 m    0.061  mm    0.122 mm
 *  10 000 m    0.488  mm    0.977 mm
 * 100 000 m    3.91   mm    7.81  mm   (refused: over the 1 mm budget)
 *
 * The observed error is half the disclosed quantum in every case, which is
 * what a worst-case rounding of half a step should give. The gate over-states
 * the cost by exactly 2x rather than under-stating it.
 *
 * `rebaseOrigin` adds the frame shift straight into the Float32 position
 * array (`p[i] += dx`). Two consequences follow, and neither is visible from
 * the call site:
 *
 *   1. The write is LOSSY. The sum rounds to the nearest representable
 *      float32, so the stored coordinate is no longer the one the file gave.
 *   2. The write is DESTRUCTIVE, so it is not exactly reversible.
 *      `restoreSourceFrame()` subtracts the same shift back, but subtracting
 *      a rounded number does not undo a rounding. A layer that joins a
 *      project frame and later leaves it does not come back bit-identical.
 *
 * That is the case for holding the transform in Float64 beside source-local
 * vertices instead: applied at read time, never written back, exactly
 * reversible however many times a layer joins and leaves.
 *
 * This file is the BASELINE, not a specification. It measures and prints the
 * present cost so the migration has a number to beat rather than a belief.
 * When the Float64 transform lands, the round-trip assertions here invert to
 * exact equality.
 *
 * It was written expecting to show error ACCUMULATING over repeated mount and
 * unmount cycles, and the measurement refuted that: the drift saturates after
 * the first cycle and stays flat. Once a value sits on a float32 grid point,
 * adding and subtracting the same shift returns it to that same point. The
 * defect is exactness and reversibility, not runaway drift, which is a
 * smaller problem than the roadmap assumed.
 *
 * It also checks the disclosed figure against the observed one. The mount gate
 * refuses past a millimetre using `rebaseQuantum`, and the viewer shows that
 * number to the user. If the real error exceeded it, the tool would be
 * understating the cost of its own operation.
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

/** Largest per-ordinate difference between a cloud's positions and a snapshot. */
function maxDelta(cloud: PointCloud, before: Float32Array): number {
  let worst = 0;
  for (let i = 0; i < before.length; i++) {
    const d = Math.abs(cloud.positions[i] - before[i]);
    if (d > worst) worst = d;
  }
  return worst;
}

// UTM 12N, a real-world magnitude. The absolute coordinate does not drive the
// error — the shift and the extent do — but using a plausible one keeps the
// numbers comparable to what a user would see.
const SOURCE_ORIGIN: [number, number, number] = [500000, 4100000, 1500];

describe('in-place Float32 rebase — baseline cost', () => {
  it('a mount and unmount does not return the data unchanged', () => {
    const cloud = scanAt(SOURCE_ORIGIN, 200);
    const before = cloud.positions.slice();

    // Join a project frame anchored 1 km away, then leave it.
    cloud.rebaseOrigin([SOURCE_ORIGIN[0] + 1000, SOURCE_ORIGIN[1] + 1000, SOURCE_ORIGIN[2]]);
    expect(cloud.isRebased).toBe(true);
    cloud.restoreSourceFrame();
    expect(cloud.isRebased).toBe(false);

    const drift = maxDelta(cloud, before);
    console.log(`  mount+unmount @ 1 km   max drift ${(drift * 1000).toPrecision(3)} mm`);

    // The property that matters: the frame is restored, the DATA is not.
    // This assertion inverts to toBe(0) when the transform moves to Float64.
    expect(drift).toBeGreaterThan(0);
    // And it is small — this is a bounded defect, not a broken viewer.
    expect(drift).toBeLessThan(0.001);
  });

  it('repeated join and leave cycles do NOT accumulate error — it saturates', () => {
    const cloud = scanAt(SOURCE_ORIGIN, 200);
    const before = cloud.positions.slice();
    const anchor: [number, number, number] = [
      SOURCE_ORIGIN[0] + 1000,
      SOURCE_ORIGIN[1] + 1000,
      SOURCE_ORIGIN[2],
    ];

    const readings: number[] = [];
    for (let cycle = 1; cycle <= 8; cycle++) {
      cloud.rebaseOrigin(anchor);
      cloud.restoreSourceFrame();
      readings.push(maxDelta(cloud, before));
    }
    console.log(
      `  drift by cycle (mm)    ${readings.map((r) => (r * 1000).toPrecision(2)).join('  ')}`,
    );

    // Measured, and it refuted the expectation this test was written to
    // confirm: the error SATURATES after the first cycle rather than growing.
    // Once a value has landed on a float32 grid point, adding and subtracting
    // the same shift maps it to that same point, so the operation is
    // idempotent from cycle two onward.
    //
    // That materially lowers the severity of the defect. The problem is
    // exactness and reversibility, not runaway drift, and this test now pins
    // the flatness so a future change cannot quietly turn it into growth.
    for (const r of readings) expect(r).toBeCloseTo(readings[0], 12);
  });

  it('cost scales with the distance moved, not the absolute coordinate', () => {
    const rows: Array<[number, number]> = [];
    for (const shift of [10, 100, 1_000, 10_000, 100_000]) {
      const cloud = scanAt(SOURCE_ORIGIN, 200);
      const before = cloud.positions.slice();
      cloud.rebaseOrigin([SOURCE_ORIGIN[0] + shift, SOURCE_ORIGIN[1], SOURCE_ORIGIN[2]]);
      cloud.restoreSourceFrame();
      rows.push([shift, maxDelta(cloud, before)]);
    }
    for (const [shift, drift] of rows) {
      console.log(`  shift ${String(shift).padStart(7)} m    drift ${(drift * 1000).toPrecision(3)} mm`);
    }
    // A 100 km move must cost more than a 10 m one, or the model is wrong.
    expect(rows[4][1]).toBeGreaterThan(rows[0][1]);
  });

  it('never costs more than the figure the mount gate discloses', () => {
    // The gate refuses past a millimetre using rebaseQuantum, and the panel
    // shows that number. Observed error exceeding it would mean the tool
    // understates the cost of its own operation — an honesty failure, not
    // just a precision one.
    for (const shift of [1_000, 10_000, 100_000]) {
      const cloud = scanAt(SOURCE_ORIGIN, 200);
      const target: [number, number, number] = [
        SOURCE_ORIGIN[0] + shift,
        SOURCE_ORIGIN[1],
        SOURCE_ORIGIN[2],
      ];
      const disclosed = cloud.rebaseQuantum(target);
      const before = cloud.positions.slice();
      cloud.rebaseOrigin(target);

      let worstH = 0;
      let worstV = 0;
      for (let i = 0; i < before.length; i += 3) {
        // Compare against the exact shift computed in double precision.
        worstH = Math.max(
          worstH,
          Math.abs(cloud.positions[i] - (before[i] - shift)),
          Math.abs(cloud.positions[i + 1] - before[i + 1]),
        );
        worstV = Math.max(worstV, Math.abs(cloud.positions[i + 2] - before[i + 2]));
      }
      console.log(
        `  shift ${String(shift).padStart(7)} m  `
        + `observed h ${(worstH * 1000).toPrecision(3)} mm  disclosed ${(disclosed.horizontal * 1000).toPrecision(3)} mm`,
      );
      expect(worstH).toBeLessThanOrEqual(disclosed.horizontal);
      expect(worstV).toBeLessThanOrEqual(Math.max(disclosed.vertical, Number.MIN_VALUE));
    }
  });

  it('a scan that never leaves its own origin pays nothing', () => {
    // The common case, and the reason this is not urgent for single-scan work.
    const cloud = scanAt(SOURCE_ORIGIN, 200);
    const before = cloud.positions.slice();
    expect(cloud.rebaseOrigin([...SOURCE_ORIGIN])).toBe(false);
    expect(maxDelta(cloud, before)).toBe(0);
  });
});
