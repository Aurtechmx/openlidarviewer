/**
 * tests/densityModeWiring.test.ts
 *
 * Pins the density colour mode's call site: `colorForMode('density')` must
 * size its bins from the cloud's own estimated spacing. The defect this
 * guards read a `spacing` field PointCloud has never carried, so every cloud
 * fell to the 1-unit fallback and rendered per-point speckle.
 */

import { describe, it, expect, vi } from 'vitest';
import * as densityColors from '../src/render/densityColors';
import { colorForMode } from '../src/render/colorModes';
import { PointCloud } from '../src/model/PointCloud';

vi.mock('../src/render/densityColors', { spy: true });

function gridCloud(): PointCloud {
  const n = 30 * 30;
  const positions = new Float32Array(n * 3);
  let i = 0;
  for (let iy = 0; iy < 30; iy++) {
    for (let ix = 0; ix < 30; ix++) {
      positions[i * 3] = ix * 2;
      positions[i * 3 + 1] = iy * 2;
      positions[i * 3 + 2] = 0;
      i++;
    }
  }
  return new PointCloud({ positions, origin: [0, 0, 0], sourceFormat: 'las', name: 'wiring-density.las' });
}

describe('density mode bin sizing', () => {
  it('hands densityForChunk a cell sized from the estimated spacing', () => {
    colorForMode('density', gridCloud());
    expect(densityColors.densityForChunk).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(densityColors.densityForChunk).mock.calls[0][0];
    // ~5x the grid's ~1.93 estimate; the defect pinned against was exactly 1.
    expect(arg.cellSize).toBeGreaterThan(9);
    expect(arg.cellSize).toBeLessThan(10.5);
  });
});
