import { describe, it, expect } from 'vitest';
import { classifyStructure, structureForNeighborhood } from '../src/classification/verticalityCue';

/** A grid of points on a plane, jittered slightly off it. */
function planePoints(axisConst: 'x' | 'y' | 'z'): Float32Array {
  const out: number[] = [];
  for (let a = 0; a < 8; a++) {
    for (let b = 0; b < 8; b++) {
      const u = a, v = b, w = 0.001 * ((a * 7 + b) % 3); // near-zero off-plane
      if (axisConst === 'z') out.push(u, v, w); // horizontal (roof/ground)
      else if (axisConst === 'y') out.push(u, w, v); // vertical wall (x-z plane)
      else out.push(w, u, v); // vertical wall (y-z plane)
    }
  }
  return Float32Array.from(out);
}

/** An isotropic 4x4x4 block — spreads equally in all axes (foliage-like). */
function scatterPoints(): Float32Array {
  const out: number[] = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) out.push(x, y, z);
  return Float32Array.from(out);
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('verticality structural cue', () => {
  it('labels a horizontal planar patch as roof/ground', () => {
    const pos = planePoints('z');
    expect(structureForNeighborhood(pos, ids(pos.length / 3))).toBe('planar-horizontal');
  });

  it('labels a vertical planar patch as a wall face', () => {
    const pos = planePoints('y');
    expect(structureForNeighborhood(pos, ids(pos.length / 3))).toBe('planar-vertical');
  });

  it('labels an isotropic block as scatter (foliage-like)', () => {
    const pos = scatterPoints();
    expect(structureForNeighborhood(pos, ids(pos.length / 3))).toBe('scatter');
  });

  it('honours custom thresholds and a degenerate neighbourhood', () => {
    // A planar-horizontal patch, but with an impossible verticalityHigh so it
    // never reads as vertical and the low branch labels it horizontal.
    const pos = planePoints('z');
    const s = structureForNeighborhood(pos, ids(pos.length / 3), {
      planarityMin: 0.5, verticalityHigh: 0.7, verticalityLow: 0.3, sphericityScatter: 0.25,
    });
    expect(s).toBe('planar-horizontal');
    // Fewer than three points cannot form a covariance — null, not a guess.
    expect(structureForNeighborhood(Float32Array.from([0, 0, 0, 1, 0, 0]), [0, 1])).toBeNull();
  });

  it('classifyStructure maps descriptor triples directly', () => {
    expect(classifyStructure({ planarity: 0.8, verticality: 0.9, sphericity: 0.05 } as never)).toBe('planar-vertical');
    expect(classifyStructure({ planarity: 0.8, verticality: 0.1, sphericity: 0.05 } as never)).toBe('planar-horizontal');
    expect(classifyStructure({ planarity: 0.1, verticality: 0.5, sphericity: 0.4 } as never)).toBe('scatter');
  });
});
