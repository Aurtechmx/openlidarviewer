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
  classificationCoverage,
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

// ── v0.4.8: classifiability gate ───────────────────────────────────────────
describe('classificationCoverage', () => {
  it('no array → every point is unclassified (fully derivable)', () => {
    expect(classificationCoverage(null, 100)).toEqual({ unclassified: 100, producer: 0 });
    expect(classificationCoverage(undefined, 7)).toEqual({ unclassified: 7, producer: 0 });
  });

  it('all-zero ("Created, never classified") reads as fully unclassified', () => {
    expect(classificationCoverage(new Uint8Array(50), 50)).toEqual({
      unclassified: 50,
      producer: 0,
    });
  });

  it('counts 0/1 as unclassified and 2+ as producer classes', () => {
    const c = new Uint8Array([0, 1, 2, 6, 1, 0]);
    expect(classificationCoverage(c, 6)).toEqual({ unclassified: 4, producer: 2 });
  });

  it('points beyond a short classification array default to unclassified', () => {
    expect(classificationCoverage(new Uint8Array([2, 2]), 5)).toEqual({
      unclassified: 3,
      producer: 2,
    });
  });
});

// ── v0.4.8: RGB greenness fusion ───────────────────────────────────────────
describe('deriveClassification — RGB greenness fusion', () => {
  const scene = buildScene();
  // Neutral grey everywhere, then paint the SMOOTH building patch strongly green.
  const green = new Uint8Array(scene.count * 3).fill(128);
  for (const i of scene.buildingIdx) {
    green[i * 3] = 50;
    green[i * 3 + 1] = 200;
    green[i * 3 + 2] = 50;
  }
  const vegFrac = (idx: number[], codes: Uint8Array) =>
    frac(idx, codes, DERIVED_HIGH_VEG) +
    frac(idx, codes, DERIVED_MED_VEG) +
    frac(idx, codes, DERIVED_LOW_VEG);

  it('keeps a tall, smooth, GREEN patch out of Building (reads as vegetation)', () => {
    const grey = deriveClassification(scene.positions, scene.count, { cellSizeM: 1 });
    const withRgb = deriveClassification(scene.positions, scene.count, { cellSizeM: 1, colors: green });
    // Geometry-only: the smooth roof is Building.
    expect(frac(scene.buildingIdx, grey.codes, DERIVED_BUILDING)).toBeGreaterThan(0.7);
    // With green RGB: that same patch is no longer Building — it's vegetation.
    expect(frac(scene.buildingIdx, withRgb.codes, DERIVED_BUILDING)).toBeLessThan(0.1);
    expect(vegFrac(scene.buildingIdx, withRgb.codes)).toBeGreaterThan(0.7);
  });

  it('does NOT invent vegetation on the ground (green cue only breaks the building tie)', () => {
    // Paint the GROUND green too — ground stays Ground (HAG governs ground).
    const allGreen = new Uint8Array(scene.count * 3);
    for (let i = 0; i < scene.count; i++) {
      allGreen[i * 3] = 50;
      allGreen[i * 3 + 1] = 200;
      allGreen[i * 3 + 2] = 50;
    }
    const res = deriveClassification(scene.positions, scene.count, { cellSizeM: 1, colors: allGreen });
    expect(frac(scene.groundIdx, res.codes, DERIVED_GROUND)).toBeGreaterThan(0.9);
  });

  it('colours absent ⇒ byte-identical to geometry-only', () => {
    const a = deriveClassification(scene.positions, scene.count, { cellSizeM: 1 });
    const b = deriveClassification(scene.positions, scene.count, { cellSizeM: 1, colors: undefined });
    expect(Array.from(b.codes)).toEqual(Array.from(a.codes));
  });

  it('accepts an RGBA (stride-4) buffer as well as RGB', () => {
    const rgba = new Uint8Array(scene.count * 4).fill(128);
    for (const i of scene.buildingIdx) {
      rgba[i * 4] = 50;
      rgba[i * 4 + 1] = 200;
      rgba[i * 4 + 2] = 50;
      rgba[i * 4 + 3] = 255;
    }
    const res = deriveClassification(scene.positions, scene.count, { cellSizeM: 1, colors: rgba });
    expect(frac(scene.buildingIdx, res.codes, DERIVED_BUILDING)).toBeLessThan(0.1);
  });

  it('records the RGB mode in the provenance', () => {
    const res = deriveClassification(scene.positions, scene.count, { cellSizeM: 1, colors: green });
    expect(res.provenance).toMatch(/RGB vegetation index/i);
  });
});

// ── v0.4.8: classify the gaps (preserve producer classes) ──────────────────
describe('deriveClassification — classify the gaps', () => {
  const scene = buildScene();
  const vegFrac = (idx: number[], codes: Uint8Array) =>
    frac(idx, codes, DERIVED_HIGH_VEG) +
    frac(idx, codes, DERIVED_MED_VEG) +
    frac(idx, codes, DERIVED_LOW_VEG);

  it('keeps producer classes (codes ≠ 0/1) verbatim and derives only the gaps', () => {
    // Producer Ground on the plane; the rest (building + trees) unclassified.
    const existing = new Uint8Array(scene.count).fill(DERIVED_UNCLASSIFIED);
    for (const i of scene.groundIdx) existing[i] = DERIVED_GROUND;
    const res = deriveClassification(scene.positions, scene.count, {
      cellSizeM: 1,
      existingClassification: existing,
    });
    // Every producer-Ground point keeps its code verbatim.
    expect(scene.groundIdx.every((i) => res.codes[i] === DERIVED_GROUND)).toBe(true);
    // The unclassified tree cluster was filled with vegetation.
    expect(vegFrac(scene.treeIdx, res.codes)).toBeGreaterThan(0.7);
  });

  it('a producer class overrides what the geometry would have derived', () => {
    // Tag a tree point as producer Building (6) — it must survive the derive.
    const existing = new Uint8Array(scene.count).fill(DERIVED_UNCLASSIFIED);
    const t = scene.treeIdx[0];
    existing[t] = DERIVED_BUILDING;
    const res = deriveClassification(scene.positions, scene.count, {
      cellSizeM: 1,
      existingClassification: existing,
    });
    expect(res.codes[t]).toBe(DERIVED_BUILDING);
  });

  it('records the gaps mode in the provenance', () => {
    const existing = new Uint8Array(scene.count).fill(DERIVED_GROUND);
    const res = deriveClassification(scene.positions, scene.count, {
      cellSizeM: 1,
      existingClassification: existing,
    });
    expect(res.provenance).toMatch(/producer classes preserved/i);
  });

  it('a length-mismatched existing array is ignored (no preserve)', () => {
    const plain = deriveClassification(scene.positions, scene.count, { cellSizeM: 1 });
    const res = deriveClassification(scene.positions, scene.count, {
      cellSizeM: 1,
      existingClassification: new Uint8Array(3).fill(DERIVED_GROUND),
    });
    expect(Array.from(res.codes)).toEqual(Array.from(plain.codes));
  });
});
