/**
 * provenanceObjectShape.test.ts
 *
 * The v0.5.7 data-validity fix: the capture-type classifier must never record a
 * compact object / interior as airborne (drone / aerial / spaceborne) from a
 * density guess. A temple is not drone LiDAR just because its point density
 * resembles a UAV survey. Direct-evidence and non-aerial guesses pass through.
 */

import { describe, it, expect } from 'vitest';
import { classify, type ScanSignals } from '../src/diagnostics/provenance';

/** UAV-density signature (572 pts/m² over a ~0.27 ha footprint) — the Tikal CSV. */
const droneLike: ScanSignals = {
  sourceFormat: 'xyz',
  pointCount: 1_564_029,
  extent: [50, 54, 47],
  densityPerSqM: 572,
};

const AERIAL = ['drone-lidar', 'aerial-als', 'spaceborne'];

describe('classify — object-shape aerial guard', () => {
  it('a UAV density signature classifies as drone when the shape is unknown', () => {
    expect(classify(droneLike).captureType).toBe('drone-lidar');
  });

  it('the same scan is NOT aerial once the shape router flags a compact object', () => {
    const fp = classify({ ...droneLike, isNonTerrain: true });
    expect(AERIAL).not.toContain(fp.captureType);
    expect(fp.captureType).toBe('unknown');
    expect(fp.confidence).toBe('low');
    expect(fp.bounds).toEqual([]);
    expect(fp.signals.some((s) => /airborne capture ruled out/i.test(s))).toBe(true);
  });

  it('a non-aerial guess (phone-LiDAR) passes through unchanged for an object', () => {
    const phoneLike: ScanSignals = {
      sourceFormat: 'ply',
      pointCount: 2_000_000,
      extent: [2, 2, 2],
      densityPerSqM: 5000,
    };
    expect(classify(phoneLike).captureType).toBe('iphone-lidar');
    expect(classify({ ...phoneLike, isNonTerrain: true }).captureType).toBe('iphone-lidar');
  });

  it('invariant: a non-terrain scan never yields an aerial capture type', () => {
    for (const densityPerSqM of [1, 5, 30, 200, 572, 1500]) {
      for (const [w, d] of [[5, 5], [80, 80], [300, 300]] as const) {
        const fp = classify({
          sourceFormat: 'xyz',
          pointCount: 1_000_000,
          extent: [w, d, 10],
          densityPerSqM,
          isNonTerrain: true,
        });
        expect(AERIAL, `density ${densityPerSqM} foot ${w}x${d}`).not.toContain(fp.captureType);
      }
    }
  });
});
