/**
 * loadPlanNonLas.test.ts
 *
 * Pins the `largeNonLasFormat` warning contract. Non-LAS/LAZ formats
 * load the full point set in memory before downsampling, so a large
 * file means a real RAM spike during decode. The flag lets the
 * loader surface a pre-decode warning rather than silently OOMing.
 */

import { describe, it, expect } from 'vitest';
import {
  LARGE_NON_LAS_THRESHOLD_BYTES,
  NON_STREAMING_FORMATS,
  planLoad,
} from '../src/io/loadPlan';
import type { LoadPlanInput, PointAttributes } from '../src/io/loadPlan';

const LAS_ATTRS: PointAttributes = {
  hasColor: false,
  hasIntensity: true,
  hasClassification: true,
  hasNormals: false,
};

function input(over: Partial<LoadPlanInput> = {}): LoadPlanInput {
  return {
    sourceCount: 100_000,
    fileBytes: 10_000_000,
    budget: 4_000_000,
    isMobile: false,
    attributes: LAS_ATTRS,
    format: 'las',
    ...over,
  };
}

describe('LoadPlan.largeNonLasFormat — pre-decode warning', () => {
  it('is false for LAS at any size', () => {
    const plan = planLoad(input({ fileBytes: 4_000_000_000, format: 'las' }));
    expect(plan.largeNonLasFormat).toBe(false);
  });

  it('is false for LAZ at any size', () => {
    const plan = planLoad(input({ fileBytes: 4_000_000_000, format: 'laz' }));
    expect(plan.largeNonLasFormat).toBe(false);
  });

  it('is false for small non-LAS formats', () => {
    for (const fmt of ['e57', 'pcd', 'pts', 'ply'] as const) {
      const plan = planLoad(input({ fileBytes: 50_000_000, format: fmt }));
      expect(plan.largeNonLasFormat).toBe(false);
    }
  });

  it('is true for large E57', () => {
    const plan = planLoad(input({ fileBytes: 1_000_000_000, format: 'e57' }));
    expect(plan.largeNonLasFormat).toBe(true);
  });

  it('is true for large PLY / PCD / PTS / PTX / OBJ / GLB / XYZ', () => {
    for (const fmt of ['ply', 'pcd', 'pts', 'ptx', 'obj', 'glb', 'xyz'] as const) {
      const plan = planLoad(
        input({ fileBytes: LARGE_NON_LAS_THRESHOLD_BYTES + 1, format: fmt }),
      );
      expect(plan.largeNonLasFormat).toBe(true);
    }
  });

  it('threshold sits at 300 MB', () => {
    expect(LARGE_NON_LAS_THRESHOLD_BYTES).toBe(300 * 1024 * 1024);
  });

  it('non-streaming formats set is exactly the LAS/LAZ exclusion list', () => {
    // LAS and LAZ are NOT in the set; every other supported decode-into-memory
    // format is.
    expect(NON_STREAMING_FORMATS.has('las' as never)).toBe(false);
    expect(NON_STREAMING_FORMATS.has('laz' as never)).toBe(false);
    expect(NON_STREAMING_FORMATS.has('e57' as never)).toBe(true);
    expect(NON_STREAMING_FORMATS.has('ply' as never)).toBe(true);
  });

  it('flag is independent of memoryGuardTriggered', () => {
    // A large PLY file is a non-LAS warning AND can fire the memory guard.
    // The two flags answer different questions.
    const plan = planLoad(
      input({ fileBytes: 1_000_000_000, sourceCount: 50_000_000, format: 'ply' }),
    );
    expect(plan.largeNonLasFormat).toBe(true);
  });
});

describe('LoadPlan over-ceiling routing for unbounded formats', () => {
  // Well past the 1.5 GB desktop fallback ceiling, so fixed cost alone exceeds
  // it and no point-budget reshape can bring the estimate down.
  const OVER = 4_000_000_000;

  it('flags an over-ceiling PLY and does NOT route it to the out-of-core build', () => {
    const plan = planLoad(input({ fileBytes: OVER, sourceCount: 200_000_000, format: 'ply' }));
    expect(plan.mayExceedCeiling).toBe(true);
    // It is NOT routed to the out-of-core build — that path is LAS/LAZ only.
    expect(plan.buildThenStream).toBeFalsy();
  });

  it('flags every unbounded non-streaming format over the ceiling', () => {
    for (const fmt of ['ply', 'pcd', 'pts', 'ptx', 'obj', 'glb', 'xyz'] as const) {
      const plan = planLoad(input({ fileBytes: OVER, sourceCount: 200_000_000, format: fmt }));
      expect(plan.mayExceedCeiling).toBe(true);
      expect(plan.buildThenStream).toBeFalsy();
    }
  });

  it('routes LAS/LAZ to the out-of-core build instead of flagging a refusal', () => {
    for (const fmt of ['las', 'laz'] as const) {
      const plan = planLoad(input({ fileBytes: OVER, sourceCount: 200_000_000, format: fmt }));
      expect(plan.buildThenStream).toBe(true);
    }
  });

  it('does not over-flag when the file fits under the ceiling', () => {
    const plan = planLoad(input({ fileBytes: 10_000_000, sourceCount: 100_000, format: 'ply' }));
    expect(plan.mayExceedCeiling).toBe(false);
    expect(plan.buildThenStream).toBeFalsy();
  });
});
