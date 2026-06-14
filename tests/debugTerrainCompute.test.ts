/**
 * debugTerrainCompute.test.ts
 *
 * The debug overlay's terrain-compute label maps the CPU/GPU equivalence-gate
 * verdict to plain words. Pure mapping — asserted without rendering the overlay.
 */

import { describe, it, expect } from 'vitest';
import { formatTerrainCompute } from '../src/ui/DebugOverlay';

describe('formatTerrainCompute', () => {
  it('reads "GPU validated" only when the GPU path is active', () => {
    expect(formatTerrainCompute({ path: 'gpu', reason: 'gpu-active' })).toBe('GPU validated');
  });

  it('names the demotion when the GPU dispatch failed mid-session', () => {
    expect(formatTerrainCompute({ path: 'cpu', reason: 'gpu-dispatch-failed' })).toBe(
      'GPU demoted to CPU',
    );
  });

  it('distinguishes a probe mismatch from an absent GPU', () => {
    expect(formatTerrainCompute({ path: 'cpu', reason: 'probe-mismatch' })).toBe(
      'CPU reference (probe mismatch)',
    );
    expect(formatTerrainCompute({ path: 'cpu', reason: 'webgpu-unavailable' })).toBe(
      'CPU reference (no GPU)',
    );
    expect(formatTerrainCompute({ path: 'cpu', reason: 'device-request-failed' })).toBe(
      'CPU reference (no GPU)',
    );
  });

  it('reads idle before a run, and surfaces an unknown reason verbatim', () => {
    expect(formatTerrainCompute({ path: 'cpu', reason: 'not-initialised' })).toBe('CPU (idle)');
    expect(formatTerrainCompute({ path: 'cpu', reason: 'something-new' })).toBe(
      'CPU reference (something-new)',
    );
  });

  it('reads "— (no main-thread run)" when nothing is reported', () => {
    expect(formatTerrainCompute(null)).toBe('— (no main-thread run)');
    expect(formatTerrainCompute(undefined)).toBe('— (no main-thread run)');
  });
});
