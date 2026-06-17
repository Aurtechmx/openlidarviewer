/**
 * deriveClassification.test.ts
 *
 * Validates the unsupervised geometry-only classifier on a synthetic scene
 * with a known ground/building/tree layout, plus the honesty + degenerate
 * contracts. The scene is built so each structure exercises a distinct branch:
 *   - a flat 40×40 m ground plane → Ground (2)
 *   - a solid 10×10 m building with a smooth roof at z=6 and NO ground returns
 *     underneath (so the morphological filter must carve it) → Building (6)
 *   - a rough 4×4 m tree cluster spanning z=2..9 → High/Med vegetation (5/4)
 */

import { describe, it, expect } from 'vitest';
import {
  deriveClassification,
  DERIVED_GROUND,
  DERIVED_BUILDING,
  DERIVED_HIGH_VEG,
  DERIVED_MED_VEG,
  DERIVED_LOW_VEG,
  DERIVED_UNCLASSIFIED,
} from '../src/render/class/deriveClassification';

interface Scene {
  positions: Float32Array;
  count: number;
  groundIdx: number[];
  buildingIdx: number[];
  treeIdx: number[];
}

function buildScene(): Scene {
  const pts: number[] = [];
  const groundIdx: number[] = [];
  const buildingIdx: number[] = [];
  const treeIdx: number[] = [];
  let idx = 0;
  const push = (x: number, y: number, z: number, bucket: number[]) => {
    pts.push(x, y, z); bucket.push(idx++);
  };

  // Flat ground plane, 0..40 m, 1 m spacing, z = 0.
  for (let x = 0; x <= 40; x++) {
    for (let y = 0; y <= 40; y++) push(x, y, 0, groundIdx);
  }
  // Solid building: footprint x∈[15,25], y∈[15,25], smooth roof at z=6, no
  // ground returns under it (the interior cells only see the roof). Roof
  // sampled at 0.5 m like a real ALS roof so each ground cell holds several
  // returns for a stable planarity read.
  for (let x = 15; x <= 25; x += 0.5) {
    for (let y = 15; y <= 25; y += 0.5) push(x, y, 6, buildingIdx);
  }
  // Rough tree cluster: x∈[5,9], y∈[5,9], heights scattered 2..9 (deterministic).
  let seed = 1;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let x = 5; x <= 9; x += 0.5) {
    for (let y = 5; y <= 9; y += 0.5) push(x, y, 2 + rand() * 7, treeIdx);
  }
  return { positions: new Float32Array(pts), count: idx, groundIdx, buildingIdx, treeIdx };
}

const frac = (idx: number[], codes: Uint8Array, code: number) =>
  idx.filter((i) => codes[i] === code).length / idx.length;

describe('deriveClassification — synthetic ground / building / tree', () => {
  const scene = buildScene();
  const res = deriveClassification(scene.positions, scene.count, { cellSizeM: 1 });

  it('classifies the flat plane as Ground', () => {
    expect(frac(scene.groundIdx, res.codes, DERIVED_GROUND)).toBeGreaterThan(0.9);
  });

  it('carves the building and labels its smooth roof as Building', () => {
    expect(frac(scene.buildingIdx, res.codes, DERIVED_BUILDING)).toBeGreaterThan(0.7);
  });

  it('labels the rough tall cluster as vegetation (not building, not ground)', () => {
    const veg =
      frac(scene.treeIdx, res.codes, DERIVED_HIGH_VEG) +
      frac(scene.treeIdx, res.codes, DERIVED_MED_VEG) +
      frac(scene.treeIdx, res.codes, DERIVED_LOW_VEG);
    expect(veg).toBeGreaterThan(0.8);
    // Mostly tall vegetation given heights up to 9 m.
    expect(frac(scene.treeIdx, res.codes, DERIVED_HIGH_VEG)).toBeGreaterThan(0.3);
    expect(frac(scene.treeIdx, res.codes, DERIVED_BUILDING)).toBeLessThan(0.1);
  });

  it('emits per-class counts that sum to the point count', () => {
    const total = Object.values(res.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(scene.count);
  });

  it('is deterministic — identical output across runs', () => {
    const again = deriveClassification(scene.positions, scene.count, { cellSizeM: 1 });
    expect(Array.from(again.codes)).toEqual(Array.from(res.codes));
  });

  it('reports progress phases without changing the output', () => {
    const phases: string[] = [];
    const withPhases = deriveClassification(
      scene.positions, scene.count, { cellSizeM: 1 }, (p) => phases.push(p),
    );
    // The four pipeline phases fire in order.
    expect(phases).toEqual([
      'Building ground surface', 'Filtering ground', 'Height above ground', 'Classifying',
    ]);
    // The callback is side-effect-only — codes are identical with or without it.
    expect(Array.from(withPhases.codes)).toEqual(Array.from(res.codes));
  });

  it('survives a throwing onPhase callback (progress is best-effort)', () => {
    expect(() =>
      deriveClassification(scene.positions, scene.count, { cellSizeM: 1 }, () => {
        throw new Error('listener blew up');
      }),
    ).not.toThrow();
  });

  it('flags the result as derived with honest provenance', () => {
    expect(res.derived).toBe(true);
    expect(res.provenance).toMatch(/heuristic/i);
    expect(res.provenance).toMatch(/not a survey-grade|validate/i);
  });
});

describe('deriveClassification — degenerate inputs', () => {
  it('returns all-unclassified for an empty cloud', () => {
    const res = deriveClassification(new Float32Array(0), 0);
    expect(res.derived).toBe(true);
    expect(res.codes.length).toBe(0);
  });

  it('returns all-unclassified for a degenerate (single-footprint) cloud', () => {
    const pos = new Float32Array([1, 1, 0, 1, 1, 1, 1, 1, 2]); // same x,y
    const res = deriveClassification(pos, 3);
    expect(Array.from(res.codes)).toEqual([
      DERIVED_UNCLASSIFIED, DERIVED_UNCLASSIFIED, DERIVED_UNCLASSIFIED,
    ]);
  });

  it('does not crash on NaN coordinates', () => {
    const pos = new Float32Array([0, 0, 0, NaN, NaN, NaN, 10, 10, 0, 5, 5, 3]);
    const res = deriveClassification(pos, 4);
    expect(res.codes.length).toBe(4);
  });
});
