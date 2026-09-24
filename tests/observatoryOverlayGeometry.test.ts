/**
 * observatoryOverlayGeometry.test.ts — pure buffer builder for the
 * Observatory's shadow-voxel overlay. PRESENTATION ONLY: this never decides
 * which voxels are shadowed, only turns already-decided keys into vertices.
 */
import { describe, it, expect } from 'vitest';
import { buildShadowWireframeBuffer, MAX_SHADOW_OVERLAY_BOXES } from '../src/render/observatoryOverlayGeometry';
import { packVoxelKey } from '../src/observation/ledger';

const GRID = { nx: 10, ny: 10 };

describe('buildShadowWireframeBuffer', () => {
  it('no keys -> an empty buffer', () => {
    const verts = buildShadowWireframeBuffer([], GRID, 1, [0, 0, 0]);
    expect(verts.length).toBe(0);
  });

  it('one key -> 12 edges * 2 vertices * 3 components', () => {
    const key = packVoxelKey(1, 2, 3, GRID.nx, GRID.ny);
    const verts = buildShadowWireframeBuffer([key], GRID, 1, [0, 0, 0]);
    expect(verts.length).toBe(12 * 2 * 3);
  });

  it('the box sits at domainMin + voxel index * edge, one edge unit wide', () => {
    const key = packVoxelKey(2, 0, 0, GRID.nx, GRID.ny);
    const verts = buildShadowWireframeBuffer([key], GRID, 0.5, [10, 20, 30]);
    const xs = Array.from({ length: verts.length / 3 }, (_, i) => verts[i * 3]!);
    expect(Math.min(...xs)).toBeCloseTo(10 + 2 * 0.5, 6);
    expect(Math.max(...xs)).toBeCloseTo(10 + 3 * 0.5, 6);
  });

  it('caps at MAX_SHADOW_OVERLAY_BOXES even when given more keys', () => {
    const keys = Array.from({ length: MAX_SHADOW_OVERLAY_BOXES + 500 }, (_, i) => i);
    const verts = buildShadowWireframeBuffer(keys, { nx: 100000, ny: 1 }, 1, [0, 0, 0]);
    expect(verts.length).toBe(MAX_SHADOW_OVERLAY_BOXES * 12 * 2 * 3);
  });
});
