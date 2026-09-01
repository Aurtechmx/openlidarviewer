/**
 * floorPlanPositions — the export path prefers the viewer's denser terrain
 * gather but must never block on it: the routing snapshot is always valid, so a
 * gather that is absent, not strictly larger, or throws falls back to it. These
 * are the negative controls — only a genuinely larger gather may win, and it is
 * returned by identity (no copy) so callers see the exact buffer.
 */
import { describe, it, expect } from 'vitest';
import {
  floorPlanPositions,
  type TerrainPositionSource,
  type PositionsCarrier,
} from '../src/app/floorPlanPositions';

const carrier = (positions: Float32Array): PositionsCarrier => ({ positions });

const sourceReturning = (
  dense: { positions: Float32Array } | null,
): TerrainPositionSource => ({ gatherTerrainPositions: () => dense });

describe('floorPlanPositions', () => {
  it('returns the dense gather when it is strictly larger (by identity)', () => {
    const dense = new Float32Array([1, 2, 3, 4]);
    const fallback = carrier(new Float32Array([9, 9]));
    const result = floorPlanPositions(sourceReturning({ positions: dense }), fallback, 100);
    expect(result).toBe(dense);
  });

  it('falls back when the gather is null', () => {
    const fallback = carrier(new Float32Array([9, 9]));
    const result = floorPlanPositions(sourceReturning(null), fallback, 100);
    expect(result).toBe(fallback.positions);
  });

  it('falls back when the gather is smaller than the snapshot', () => {
    const fallback = carrier(new Float32Array([9, 9, 9, 9]));
    const dense = new Float32Array([1, 2]);
    const result = floorPlanPositions(sourceReturning({ positions: dense }), fallback, 100);
    expect(result).toBe(fallback.positions);
  });

  it('falls back when the gather equals the snapshot length (not strictly larger)', () => {
    const fallback = carrier(new Float32Array([9, 9]));
    const dense = new Float32Array([1, 2]);
    const result = floorPlanPositions(sourceReturning({ positions: dense }), fallback, 100);
    expect(result).toBe(fallback.positions);
  });

  it('falls back when the gather throws', () => {
    const fallback = carrier(new Float32Array([9, 9]));
    const source: TerrainPositionSource = {
      gatherTerrainPositions: () => {
        throw new Error('gather failed');
      },
    };
    const result = floorPlanPositions(source, fallback, 100);
    expect(result).toBe(fallback.positions);
  });
});
