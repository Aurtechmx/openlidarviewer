/**
 * observatoryOverlayGeometry.test.ts: the OB-PR-02 slice plane's texels.
 * PRESENTATION ONLY: states are read, never decided. Only OBSERVED_EMPTY,
 * SHADOWED, UNADDRESSED and the frontier are drawn; every other state is
 * clear, so nothing else can read as empty (OB-INV-01).
 */
import { describe, it, expect } from 'vitest';
import {
  buildSliceTexels,
  defaultSliceLevel,
  sliceLegendText,
  sliceSize,
  MAX_SLICE_EDGE,
  SLICE_STATES,
} from '../src/render/observatoryOverlayGeometry';
import { packVoxelKey } from '../src/observation/ledger';
import { OBSERVATION_STATES, type ObservationState } from '../src/observation/types';

const GRID = { nx: 4, ny: 3, nz: 2 };

describe('buildSliceTexels', () => {
  it('draws only the slice states and the frontier; every other state is clear', () => {
    const states = new Map<number, ObservationState>();
    OBSERVATION_STATES.slice(0, 9).forEach((s, i) => { if (i < 12) states.set(packVoxelKey(i % 4, Math.floor(i / 4), 1, 4, 3), s); });
    const t = buildSliceTexels((k) => states.get(k), new Set(), GRID, 1);
    expect(t.length).toBe(4 * 3 * 4);
    OBSERVATION_STATES.slice(0, 9).forEach((s, i) => {
      expect(t[i * 4 + 3]! > 0, s).toBe(SLICE_STATES.includes(s));
    });
  });

  it('the frontier colour wins over the state colour, and levels outside the grid are clear', () => {
    const key = packVoxelKey(1, 1, 0, 4, 3);
    const t = buildSliceTexels(() => 'SURFACE', new Set([key]), GRID, 0);
    expect(t[(1 * 4 + 1) * 4 + 3]).toBeGreaterThan(0);
    expect(t[3]).toBe(0);
    expect(buildSliceTexels(() => 'SHADOWED', new Set(), GRID, 5).every((v) => v === 0)).toBe(true);
  });

  it('strides a field wider than the maximum slice edge', () => {
    const s = sliceSize({ nx: MAX_SLICE_EDGE * 2 + 1, ny: 10, nz: 1 });
    expect(s.stride).toBe(3);
    expect(s.width).toBeLessThanOrEqual(MAX_SLICE_EDGE);
    expect(sliceSize(GRID)).toEqual({ width: 4, height: 3, stride: 1 });
  });
});

describe('defaultSliceLevel and the legend', () => {
  it('opens at the level with the most shadowed voxels, lowest on a tie', () => {
    const k = (iz: number) => packVoxelKey(0, 0, iz, 4, 3);
    expect(defaultSliceLevel([k(1), k(1), k(0)], GRID)).toBe(1);
    expect(defaultSliceLevel([k(0), k(1)], GRID)).toBe(0);
    expect(defaultSliceLevel([], GRID)).toBe(0);
  });

  it('names every drawn state by glyph and word, not colour alone (OB-PR-04)', () => {
    expect(sliceLegendText()).toBe('○ Observed empty, ▲ Shadowed, □ Unaddressed, ◆ Frontier');
  });
});
