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
import { selectByLasso, volumeFromLassoWithFootprint } from '../src/render/measure/lassoVolume';

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
    visibilityFor: () => null,
    worldUp: [0, 0, 1] as [number, number, number],
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
    expect(out.selectionByCloudId.get('layer-1')!).toHaveLength(64);
    expect(out.selectedPositions).toHaveLength(64 * 3);
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
    expect(out.selectionByCloudId.get('layer-1')!).toHaveLength(36);
    expect(out.streamingContributed).toBe(true);
  });

  it('reports no streaming contribution for a static-only selection', () => {
    const h = host({ integrable: [['layer-1', { cloud: cloud(grid(6, 10, 2)) }]] });
    const out = computeLassoVolume({ host: h, lasso: fullBox(10), referencePercentile: 0.05 })!;
    expect(out.streamingContributed).toBe(false);
  });

  it('reports no streaming contribution when the stream selected nothing', () => {
    // A stream outside the lasso must not turn the figure into a streaming
    // claim: the authority the caller derives from it would cap a complete
    // static source at preview for nothing.
    const away = new Float32Array([100, 100, 0, 101, 100, 0, 100, 101, 0]);
    const h = host({
      integrable: [['layer-1', { cloud: cloud(grid(6, 10, 2)) }]],
      streamingPositions: [away],
    });
    const out = computeLassoVolume({ host: h, lasso: fullBox(10), referencePercentile: 0.05 })!;
    expect(out.streamingContributed).toBe(false);
  });

  it('carries the reduced-source caveat when any contributing layer was reduced', () => {
    const reduced = cloud(grid(6, 10, 2), 'reduced.las');
    const h = host({
      integrable: [['layer-1', { cloud: reduced }]],
      wasReduced: (c) => c === reduced,
      visibilityFor: () => null,
      worldUp: [0, 0, 1] as [number, number, number],
    });
    const out = computeLassoVolume({ host: h, lasso: fullBox(10), referencePercentile: 0.05 })!;
    expect(out.anySourceReduced).toBe(true);
  });

  it('does not flag a reduced source when the reduced layer selected nothing', () => {
    const reduced = cloud(grid(6, 10, 2), 'reduced.las');
    const h = host({
      integrable: [['layer-1', { cloud: reduced }]],
      wasReduced: (c) => c === reduced,
      visibilityFor: () => null,
      worldUp: [0, 0, 1] as [number, number, number],
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
    expect(out).toHaveLength(9);
    expect([...out]).toEqual([0, 0, 0, 2, 2, 2, 4, 4, 4]);
  });

  it('drops the tail rather than emitting a partial point', () => {
    // 5 points at stride 2 keeps floor(5/2) = 2, not 3 with a half-read.
    const p = Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
    expect(stridePositions(p, 2)).toHaveLength(6);
  });
});

describe('computeLassoVolume — selection basis', () => {
  /**
   * Two stacked surfaces seen head-on: a near plate at depth 10 over ground at
   * depth 40, both filling the lasso. Screen position is x/y, depth is the
   * third coordinate, so the projector below is a real depth-carrying one.
   */
  function stacked(n: number, size: number, near: number, far: number): Float32Array {
    const p = new Float32Array(n * n * 2 * 3);
    let i = 0;
    for (const d of [near, far]) {
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          p[i++] = (c / (n - 1)) * size;
          p[i++] = (r / (n - 1)) * size;
          p[i++] = d;
        }
      }
    }
    return p;
  }

  /** Top-down projector that reports the point's Z as its view-axis depth. */
  const withDepth = (x: number, y: number, z: number) => ({ x, y, depth: z });

  const scene = stacked(24, 480, 10, 40);
  const box = fullBox(480);

  it('defaults to the through-surfaces basis, selecting both surfaces', () => {
    const h = host({ project: withDepth, integrable: [['layer-1', { cloud: cloud(scene) }]] });
    const out = computeLassoVolume({ host: h, lasso: box, referencePercentile: 0.05 })!;
    expect(out.selectedCount).toBe(24 * 24 * 2);
    expect(out.selectionBasis.effective).toBe('through-surfaces');
    expect(out.selectionBasis.occludedCount).toBe(0);
  });

  it('excludes the hidden surface on the occluded-excluded basis', () => {
    const h = host({ project: withDepth, integrable: [['layer-1', { cloud: cloud(scene) }]] });
    const out = computeLassoVolume({
      host: h,
      lasso: box,
      referencePercentile: 0.05,
      basis: 'occluded-excluded',
    })!;
    expect(out.selectedCount).toBe(24 * 24);
    expect(out.selectionBasis.effective).toBe('occluded-excluded');
    expect(out.selectionBasis.occludedCount).toBe(24 * 24);
    // The highlight must only light up what the measurement actually counted.
    expect(out.selectionByCloudId.get('layer-1')!).toHaveLength(24 * 24);
  });

  it('reproduces the pre-occlusion result exactly when the basis is off', () => {
    // The default basis is the contract every stored lasso volume was taken
    // under. Byte-for-byte the same numbers, not merely close.
    const h = () => host({ project: withDepth, integrable: [['layer-1', { cloud: cloud(scene) }]] });
    const off = computeLassoVolume({
      host: h(),
      lasso: box,
      referencePercentile: 0.05,
      basis: 'through-surfaces',
    })!;
    const on = computeLassoVolume({
      host: h(),
      lasso: box,
      referencePercentile: 0.05,
      basis: 'occluded-excluded',
    })!;
    // The reference is the untouched pair the walk used before the basis
    // existed: the polygon-only selection, integrated the same way.
    const indices = selectByLasso({ positions: scene, lasso: box, project: withDepth });
    const reference = volumeFromLassoWithFootprint({
      positions: scene,
      selected: indices,
      referencePercentile: 0.05,
    }).result;
    expect(off.result).toEqual(reference);
    expect(off.selectedPositions).toHaveLength(24 * 24 * 2 * 3);
    // And the occlusion-aware run is a genuinely different measurement, which
    // is the reason the basis has to be stated wherever the figure is.
    expect(on.result.fill).not.toBe(off.result.fill);
  });

  it('hides one layer behind another', () => {
    // The depth buffer is pooled across sources: a plate in layer-1 has to
    // occlude ground in layer-2, which a per-layer buffer would never see.
    const plate = stacked(24, 480, 10, 10).subarray(0, 24 * 24 * 3);
    const ground = stacked(24, 480, 40, 40).subarray(0, 24 * 24 * 3);
    const h = host({
      project: withDepth,
      integrable: [
        ['layer-1', { cloud: cloud(new Float32Array(plate), 'plate.las') }],
        ['layer-2', { cloud: cloud(new Float32Array(ground), 'ground.las') }],
      ],
    });
    const out = computeLassoVolume({
      host: h,
      lasso: box,
      referencePercentile: 0.05,
      basis: 'occluded-excluded',
    })!;
    expect(out.selectionByCloudId.get('layer-1')!).toHaveLength(24 * 24);
    expect(out.selectionByCloudId.has('layer-2')).toBe(false);
  });

  it('reports the through-surfaces basis when no tolerance could be estimated', () => {
    // Too few candidates to estimate from. The figure is a through-surfaces
    // figure whatever was asked for, and has to say so.
    const h = host({ project: withDepth, integrable: [['layer-1', { cloud: cloud(stacked(3, 480, 10, 40)) }]] });
    const out = computeLassoVolume({
      host: h,
      lasso: box,
      referencePercentile: 0.05,
      basis: 'occluded-excluded',
    })!;
    expect(out.selectionBasis.requested).toBe('occluded-excluded');
    expect(out.selectionBasis.effective).toBe('through-surfaces');
    expect(out.selectionBasis.outcome).toBe('too-few-points');
    expect(out.selectedCount).toBe(18);
  });

  it('leaves the selection alone when the projector reports no depth', () => {
    // A projector written before depth existed still typechecks and still
    // selects. It cannot separate near from far, and must not pretend to.
    const h = host({ project: topDown, integrable: [['layer-1', { cloud: cloud(scene) }]] });
    const out = computeLassoVolume({
      host: h,
      lasso: box,
      referencePercentile: 0.05,
      basis: 'occluded-excluded',
    })!;
    expect(out.selectedCount).toBe(24 * 24 * 2);
    expect(out.selectionBasis.effective).toBe('through-surfaces');
  });
});

// A measurement must not be taken over points the user cannot see. The
// reclassify path has enforced this since the reclassify-invisible-points
// finding, on the grounds that an EDIT must not rewrite invisible points; a
// measurement is a claim about the scene on screen, so the case is stronger.
describe('hidden points do not enter the measurement', () => {
  // A flat pad at z = 10 with a deep pit of low returns beneath it. Clipping
  // the pit away is the "isolate the pile from the road cut behind it" case.
  function padOverPit(): Float32Array {
    const p: number[] = [];
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 20; c++) {
        p.push(c, r, 10);       // the pad the viewer is looking at
        p.push(c, r, -40);      // hidden low returns
      }
    }
    return new Float32Array(p);
  }
  const pad = cloud(padOverPit());

  it('excludes points the clip box hides, so they cannot set the reference', () => {
    const all = computeLassoVolume({
      host: host({ integrable: [['a', { cloud: pad }]] }),
      lasso: fullBox(19), referencePercentile: 0.05,
    })!;
    const visibleOnly = computeLassoVolume({
      host: host({
        integrable: [['a', { cloud: pad }]],
        visibilityFor: () => ({ keepPoint: (_x, _y, z) => z > -1 }),
      }),
      lasso: fullBox(19), referencePercentile: 0.05,
    })!;
    // The hidden returns halve the candidate count and drag the reference
    // plane 50 units down, which is the inflation this closes.
    expect(visibleOnly.selectedCount).toBe(all.selectedCount / 2);
    expect(all.referenceZ).toBeLessThan(0);
    expect(visibleOnly.referenceZ).toBeCloseTo(10, 6);
    expect(visibleOnly.result.fill).toBeLessThan(all.result.fill);
  });

  it('excludes points a class filter hides, by the cloud index', () => {
    const half = computeLassoVolume({
      host: host({
        integrable: [['a', { cloud: pad }]],
        // Every other point, in the cloud's own index space.
        visibilityFor: () => ({ acceptIndex: (i) => i % 2 === 0 }),
      }),
      lasso: fullBox(19), referencePercentile: 0.05,
    })!;
    expect(half.selectedCount).toBe(400);
    expect(half.referenceZ).toBeCloseTo(10, 6);
  });

  it('says so when the selection was restricted', () => {
    const restricted = computeLassoVolume({
      host: host({
        integrable: [['a', { cloud: pad }]],
        visibilityFor: () => ({ keepPoint: (_x, _y, z) => z > -1 }),
      }),
      lasso: fullBox(19), referencePercentile: 0.05,
    })!;
    const unrestricted = computeLassoVolume({
      host: host({ integrable: [['a', { cloud: pad }]] }),
      lasso: fullBox(19), referencePercentile: 0.05,
    })!;
    expect(restricted.selectionRestrictedByVisibility).toBe(true);
    expect(unrestricted.selectionRestrictedByVisibility).toBe(false);
  });

  it('a filter that hides nothing changes no figure', () => {
    const plain = computeLassoVolume({
      host: host({ integrable: [['a', { cloud: pad }]] }),
      lasso: fullBox(19), referencePercentile: 0.05,
    })!;
    const filtered = computeLassoVolume({
      host: host({
        integrable: [['a', { cloud: pad }]],
        visibilityFor: () => ({ keepPoint: () => true, acceptIndex: () => true }),
      }),
      lasso: fullBox(19), referencePercentile: 0.05,
    })!;
    expect(filtered.selectedCount).toBe(plain.selectedCount);
    expect(filtered.result.fill).toBeCloseTo(plain.result.fill, 9);
    expect(filtered.selectionRestrictedByVisibility).toBe(false);
  });
});

// The footprint hull and the reference plane DEFINE the measurement, and both
// were built on X/Y and index 2 whatever the scan's up axis was. `up` was
// declared and forwarded only to the cut/fill integration.
describe('the footprint follows the up axis', () => {
  // A Y-up pile: 20x20 in x/z, height in y.
  function yUpPile(): Float32Array {
    const p: number[] = [];
    for (let a = 0; a < 20; a++) {
      for (let b = 0; b < 20; b++) {
        const tall = Math.hypot(a - 10, b - 10) < 5;
        p.push(a, tall ? 4 : 0, b);
      }
    }
    return new Float32Array(p);
  }
  const pile = cloud(yUpPile());

  it('reads the height off the up axis rather than off index 2', () => {
    const yUp = computeLassoVolume({
      host: host({ integrable: [['a', { cloud: pile }]], worldUp: [0, 1, 0] }),
      lasso: fullBox(19), referencePercentile: 0.05,
    })!;
    // The reference plane is the 5th percentile of HEIGHT, which is the flat
    // ground at 0 — not the 5th percentile of a horizontal coordinate.
    expect(yUp.referenceZ).toBeCloseTo(0, 6);
    expect(yUp.result.fill).toBeGreaterThan(0);
  });

  it('gets a different answer when told the wrong axis, so this is not decoration', () => {
    const asIfZUp = computeLassoVolume({
      host: host({ integrable: [['a', { cloud: pile }]] }),
      lasso: fullBox(19), referencePercentile: 0.05,
    })!;
    const yUp = computeLassoVolume({
      host: host({ integrable: [['a', { cloud: pile }]], worldUp: [0, 1, 0] }),
      lasso: fullBox(19), referencePercentile: 0.05,
    })!;
    expect(asIfZUp.result.fill).not.toBeCloseTo(yUp.result.fill, 3);
  });

  it('is unchanged for a Z-up scan, which is every survey source', () => {
    const z = cloud(grid(8, 10, 2));
    const implicit = computeLassoVolume({
      host: host({ integrable: [['a', { cloud: z }]] }),
      lasso: fullBox(10), referencePercentile: 0.05,
    })!;
    const explicit = computeLassoVolume({
      host: host({ integrable: [['a', { cloud: z }]], worldUp: [0, 0, 1] }),
      lasso: fullBox(10), referencePercentile: 0.05,
    })!;
    expect(explicit.result.fill).toBe(implicit.result.fill);
    expect(explicit.referenceZ).toBe(implicit.referenceZ);
  });
});
