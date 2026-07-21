/**
 * lassoVolumeCompute.test.ts — the lasso walk, without a WebGL context.
 *
 * This logic sat on the Viewer, so testing it meant standing up a renderer.
 * It now takes a host, and the only piece that genuinely needed three.js — the
 * camera projector — is a plain function the caller supplies. Everything below
 * runs in Node.
 *
 * The cases are the ones that were previously only reachable by driving the
 * browser: strided selection remapping, streaming clouds contributing volume
 * without contributing highlight indices, and the reduced-source caveat.
 */

import { describe, it, expect } from 'vitest';
import { computeLassoVolume, stridePositions } from '../src/render/measure/lassoVolumeCompute';
import type { LassoVolumeHost } from '../src/render/measure/lassoVolumeCompute';
import { PointCloud } from '../src/model/PointCloud';

/** Orthographic top-down projector: x,y pass through, z ignored. */
const topDown = (x: number, y: number): { x: number; y: number } => ({ x, y });

/** A flat-ish grid of `n`×`n` points spanning [0,size] with a raised centre. */
function grid(n: number, size: number, height: number): Float32Array {
  const p = new Float32Array(n * n * 3);
  let i = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = (c / (n - 1)) * size;
      const y = (r / (n - 1)) * size;
      const dx = x - size / 2;
      const dy = y - size / 2;
      p[i++] = x;
      p[i++] = y;
      p[i++] = Math.hypot(dx, dy) < size / 4 ? height : 0;
    }
  }
  return p;
}

function cloud(positions: Float32Array, name = 'a.las'): PointCloud {
  return new PointCloud({ positions, origin: [0, 0, 0], sourceFormat: 'las', name });
}

/** A square lasso covering the whole grid. */
const fullBox = (size: number) => [
  { x: -1, y: -1 },
  { x: size + 1, y: -1 },
  { x: size + 1, y: size + 1 },
  { x: -1, y: size + 1 },
];

function host(over: Partial<LassoVolumeHost> = {}): LassoVolumeHost {
  return {
    project: topDown,
    integrable: [],
    streamingPositions: [],
    wasReduced: () => false,
    ...over,
  };
}

describe('computeLassoVolume', () => {
  it('refuses a degenerate lasso', () => {
    const h = host({ integrable: [['a', { cloud: cloud(grid(8, 10, 2)) }]] });
    expect(computeLassoVolume({ host: h, lasso: [{ x: 0, y: 0 }], referencePercentile: 0.05 })).toBeNull();
  });

  it('refuses when fewer than three points fall inside', () => {
    const h = host({ integrable: [['a', { cloud: cloud(grid(8, 10, 2)) }]] });
    const tiny = [
      { x: -5, y: -5 },
      { x: -4, y: -5 },
      { x: -4, y: -4 },
    ];
    expect(computeLassoVolume({ host: h, lasso: tiny, referencePercentile: 0.05 })).toBeNull();
  });

  it('selects across the grid and reports per-cloud indices', () => {
    const h = host({ integrable: [['layer-1', { cloud: cloud(grid(8, 10, 2)) }]] });
    const out = computeLassoVolume({ host: h, lasso: fullBox(10), referencePercentile: 0.05 })!;
    expect(out).not.toBeNull();
    expect(out.selectedCount).toBe(64);
    expect(out.selectionByCloudId.get('layer-1')!.length).toBe(64);
    expect(out.selectedPositions.length).toBe(64 * 3);
    // The grid has a raised disc in the middle, so a top-down lasso over the
    // whole thing must find fill above the reference plane and a real footprint.
    expect(out.result.fill).toBeGreaterThan(0);
    expect(out.result.footprintArea).toBeGreaterThan(0);
    // 49, not 64: the footprint is the convex HULL of the selected points, so
    // the grid's outermost ring lies exactly on the boundary, and the polygon
    // test is half-open — it keeps the left and bottom edges and drops the top
    // and right. 8x8 selected becomes 7x7 inside. Asserted exactly, because a
    // change in that convention would move every stockpile density figure.
    expect(out.result.pointsInPolygon).toBe(49);
  });

  it('keeps each layer under its own id', () => {
    const h = host({
      integrable: [
        ['layer-1', { cloud: cloud(grid(6, 10, 2), 'a.las') }],
        ['layer-2', { cloud: cloud(grid(6, 10, 3), 'b.las') }],
      ],
    });
    const out = computeLassoVolume({ host: h, lasso: fullBox(10), referencePercentile: 0.05 })!;
    expect([...out.selectionByCloudId.keys()].sort()).toEqual(['layer-1', 'layer-2']);
    expect(out.selectedCount).toBe(72);
  });

  it('counts streaming points toward the volume but not the highlight', () => {
    // Streaming clouds have no per-mesh index surface, so they must contribute
    // to the volume while staying out of selectionByCloudId. Getting this
    // backwards would light up the wrong points or silently drop the stream
    // from the measurement.
    const h = host({
      integrable: [['layer-1', { cloud: cloud(grid(6, 10, 2)) }]],
      streamingPositions: [grid(6, 10, 4)],
    });
    const out = computeLassoVolume({ host: h, lasso: fullBox(10), referencePercentile: 0.05 })!;
    expect(out.selectedCount).toBe(72);
    expect([...out.selectionByCloudId.keys()]).toEqual(['layer-1']);
    expect(out.selectionByCloudId.get('layer-1')!.length).toBe(36);
  });

  it('carries the reduced-source caveat when any contributing layer was reduced', () => {
    const reduced = cloud(grid(6, 10, 2), 'reduced.las');
    const h = host({
      integrable: [['layer-1', { cloud: reduced }]],
      wasReduced: (c) => c === reduced,
    });
    const out = computeLassoVolume({ host: h, lasso: fullBox(10), referencePercentile: 0.05 })!;
    expect(out.anySourceReduced).toBe(true);
  });

  it('does not flag a reduced source when the reduced layer selected nothing', () => {
    const reduced = cloud(grid(6, 10, 2), 'reduced.las');
    const h = host({
      integrable: [['layer-1', { cloud: reduced }]],
      wasReduced: (c) => c === reduced,
    });
    // Lasso well away from the grid: nothing selected, so no caveat to carry.
    const away = [
      { x: 100, y: 100 },
      { x: 110, y: 100 },
      { x: 110, y: 110 },
      { x: 100, y: 110 },
    ];
    expect(computeLassoVolume({ host: h, lasso: away, referencePercentile: 0.05 })).toBeNull();
  });
});

describe('stridePositions', () => {
  it('returns the source untouched at stride 1', () => {
    const p = grid(4, 10, 1);
    expect(stridePositions(p, 1)).toBe(p);
  });

  it('keeps every nth point, and the kept values are the source values', () => {
    const p = Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5]);
    const out = stridePositions(p, 2);
    expect(out.length).toBe(9);
    expect([...out]).toEqual([0, 0, 0, 2, 2, 2, 4, 4, 4]);
  });

  it('drops the tail rather than emitting a partial point', () => {
    // 5 points at stride 2 keeps floor(5/2) = 2, not 3 with a half-read.
    const p = Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
    expect(stridePositions(p, 2).length).toBe(6);
  });
});
