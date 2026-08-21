/**
 * invariantClassification.test.ts
 *
 * Metamorphic (invariance) tests for the derived ground/terrain classification
 * path: `deriveClassification` (src/render/class/deriveClassification.ts) and
 * the scan-routing verdict `classifyScanShape` (src/terrain/scanShape.ts).
 *
 * There is no exact oracle for the ASPRS code an arbitrary point should carry,
 * so these tests assert RELATIONS between a run on a cloud and a run on a
 * transformed copy of the same cloud. `deriveClassification` derives every label
 * from height ABOVE a grid-minimum bare-earth surface it builds from the cloud
 * itself, so its labels are a function of relative morphology, and four
 * transforms must leave them alone:
 *
 *   1. adding a constant to every Z,
 *   2. adding a constant to every X and Y,
 *   3. rotating about the vertical axis,
 *   4. permuting the input point order.
 *
 * `classifyScanShape` is the other pure, Node-testable entry point in the
 * terrain routing path and gets the same treatment on its discrete verdict.
 * `src/terrain/datasetIntelligence.ts` is NOT covered here: `summariseDataset`
 * consumes pre-computed scalar metrics (point count, bounding-box volume,
 * aggregate slope) rather than coordinates, so a coordinate transform cannot be
 * applied to its input at all.
 *
 * WHAT THE MEASUREMENTS FOUND. Relations 1 and 2 hold EXACTLY under the v2
 * parameter set, and fail under the shipping v3 defaults. The v3
 * structural-verticality rescue (`structuralNeighborRadiusM = 1.0`) reads eigen
 * descriptors over a 1 m neighbourhood, and that descriptor is fine enough to
 * resolve the float32 storage quantum of the `positions` buffer. The
 * `float32 storage quantum reproduces the offset exactly` tests below pin the
 * mechanism: quantising the coordinates through the float32 grid a large offset
 * lands on, with NO offset present during classification, produces
 * byte-identical labels to running on the offset cloud. The classifier's own
 * arithmetic is exactly translation-clean; every label that moves, moves because
 * of what the float32 input buffer can hold.
 *
 * Production is not exposed to this today: the loader subtracts an integer
 * `sourceOrigin` from the positions at load time (src/model/PointCloud.ts:115),
 * so `cloud.positions` are render-local and small when main.ts hands them to
 * `deriveClassificationAsync`.
 *
 * Every measured number quoted in a comment came from this scene at this seed.
 * No threshold here was relaxed to make an assertion pass.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveClassification,
  DERIVED_BUILDING,
  type DeriveClassificationOptions,
} from '../src/render/class/deriveClassification';
import { classifyScanShape } from '../src/terrain/scanShape';

// ── Deterministic PRNG ──────────────────────────────────────────────────────
// `Math.random()` is banned in this repo. mulberry32 at a fixed seed gives the
// same scene on every run and on every machine.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Gently sloping bare earth, ~2.9 m of relief over 60 m (max gradient ~0.05,
 * inside the classifier's 0.15 slope tolerance). Polynomial rather than
 * trigonometric: `Math.sin`/`Math.cos` results are implementation-defined in
 * JavaScript, and the exact-count assertions below need a scene that is
 * bit-identical across engines.
 */
const terrain = (x: number, y: number): number =>
  0.02 * x + 0.015 * y + 0.0009 * (x - 30) * (x - 30) - 0.0006 * (y - 25) * (y - 25);

/**
 * A 60 x 60 m scene exercising every classifier branch: bare earth, a smooth
 * roof (the per-cell roughness building rule), four vertical wall faces (the v3
 * structural-verticality rescue, which is the only path that touches
 * SpatialHash3d and the eigen descriptors), and a rough tree cluster spanning
 * the low/medium/high vegetation bands. Coordinates are jittered off the
 * integer lattice so no relation can pass by lattice alignment alone.
 */
function buildScene(): { positions: Float32Array; count: number } {
  const rnd = mulberry32(0x51d02);
  const pts: number[] = [];
  // Bare earth, ~1 m spacing, with the building footprint left empty so the
  // morphological filter has to carve the structure rather than see under it.
  for (let i = 0; i <= 60; i++) {
    for (let j = 0; j <= 60; j++) {
      const x = i + (rnd() - 0.5) * 0.6;
      const y = j + (rnd() - 0.5) * 0.6;
      if (x >= 20 && x <= 30 && y >= 20 && y <= 30) continue;
      pts.push(x, y, terrain(x, y) + (rnd() - 0.5) * 0.04);
    }
  }
  // Smooth roof 7 m above the local terrain, 0.5 m sampling.
  for (let i = 0; i <= 20; i++) {
    for (let j = 0; j <= 20; j++) {
      const x = 20 + i * 0.5 + (rnd() - 0.5) * 0.1;
      const y = 20 + j * 0.5 + (rnd() - 0.5) * 0.1;
      pts.push(x, y, terrain(x, y) + 7 + (rnd() - 0.5) * 0.05);
    }
  }
  // Four wall faces from ground to eaves. These are what the v3 rescue promotes
  // to Building; without them the rescue never fires and the eigen path is
  // untested.
  for (let i = 0; i <= 40; i++) {
    for (let k = 1; k <= 14; k++) {
      const t = 20 + i * 0.25 + (rnd() - 0.5) * 0.05;
      const h = k * 0.5;
      pts.push(t, 20 + (rnd() - 0.5) * 0.05, terrain(t, 20) + h);
      pts.push(t, 30 + (rnd() - 0.5) * 0.05, terrain(t, 30) + h);
      pts.push(20 + (rnd() - 0.5) * 0.05, t, terrain(20, t) + h);
      pts.push(30 + (rnd() - 0.5) * 0.05, t, terrain(30, t) + h);
    }
  }
  // Rough canopy, heights 1.5..9 m above the terrain.
  for (let i = 0; i <= 24; i++) {
    for (let j = 0; j <= 24; j++) {
      const x = 45 + i * 0.4 + (rnd() - 0.5) * 0.2;
      const y = 8 + j * 0.4 + (rnd() - 0.5) * 0.2;
      pts.push(x, y, terrain(x, y) + 1.5 + rnd() * 7.5);
    }
  }
  const positions = new Float32Array(pts);
  return { positions, count: positions.length / 3 };
}

/**
 * A fixed cell size for every run. `chooseCellSize` otherwise derives the grid
 * from the point spacing and the AABB, which a rotation changes, so a fixed cell
 * keeps each relation a test of the transform and not of the grid heuristic.
 */
const V3: DeriveClassificationOptions = { cellSizeM: 1 };
/**
 * The same run with the v3 structural-verticality rescue disabled.
 * `structuralNeighborRadiusM = 0` restores v2 behaviour exactly (see
 * ClassifierParams in src/render/class/deriveClassification.ts:283). Used to
 * localise which component breaks a relation.
 */
const V2: DeriveClassificationOptions = { cellSizeM: 1, structuralNeighborRadiusM: 0 };

function translated(p: Float32Array, dx: number, dy: number, dz: number): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    out[i] = p[i] + dx;
    out[i + 1] = p[i + 1] + dy;
    out[i + 2] = p[i + 2] + dz;
  }
  return out;
}

/** Rotation about the vertical axis, taking cos/sin directly so a quarter turn
 *  can be expressed with exact integer entries and carries no trig rounding. */
function rotatedZ(p: Float32Array, cos: number, sin: number): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    out[i] = p[i] * cos - p[i + 1] * sin;
    out[i + 1] = p[i] * sin + p[i + 1] * cos;
    out[i + 2] = p[i + 2];
  }
  return out;
}

/**
 * Round a coordinate through the float32 grid that `value + offset` lands on,
 * then bring it back to the origin. This carries the PRECISION of a large offset
 * without carrying the offset itself, which is what separates "the input buffer
 * lost the detail" from "the classifier's arithmetic lost the detail".
 */
const quantisedThrough = (value: number, offset: number): number =>
  Math.fround(Math.fround(value + offset) - offset);

function quantisedAxes(p: Float32Array, offset: number, axes: readonly number[]): Float32Array {
  const out = new Float32Array(p);
  for (let i = 0; i < out.length; i += 3) {
    for (const a of axes) out[i + a] = quantisedThrough(out[i + a], offset);
  }
  return out;
}

/** Number of positions where two label arrays disagree. */
function changedCount(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

const agreement = (a: Uint8Array, b: Uint8Array): number => 1 - changedCount(a, b) / a.length;

/** Per-code histogram, so a multiset comparison is independent of point order. */
function histogram(codes: Uint8Array): Map<number, number> {
  const h = new Map<number, number>();
  for (const c of codes) h.set(c, (h.get(c) ?? 0) + 1);
  return h;
}

const scene = buildScene();
const base = deriveClassification(scene.positions, scene.count, V3);
const baseV2 = deriveClassification(scene.positions, scene.count, V2);

const translatedRun = (dx: number, dy: number, dz: number, opt: DeriveClassificationOptions) =>
  deriveClassification(translated(scene.positions, dx, dy, dz), scene.count, opt);

describe('deriveClassification — metamorphic invariance', () => {
  it('runs the branches the relations depend on', () => {
    // 6981 points; v3 codes {ground 3783, low veg 554, med veg 518, high veg
    // 839, building 1287}. The rescue is what separates v3 from v2 here: it
    // promotes 1091 wall points that the per-cell roughness rule sends to
    // vegetation (v2 building count 196).
    expect(scene.count).toBe(6981);
    expect(base.gridWidth).toBe(62);
    expect(base.gridHeight).toBe(62);
    expect(base.classifier.cues).toContain('structural-verticality');
    expect(changedCount(base.codes, baseV2.codes)).toBeGreaterThan(500);
  });

  // ── Relation 1: vertical translation ──────────────────────────────────────
  describe('relation 1: vertical translation', () => {
    it('HOLDS exactly at +10 m', () => {
      expect(changedCount(base.codes, translatedRun(0, 0, 10, V3).codes)).toBe(0);
    });

    it('FAILS at +1000 m and +100000 m under the shipping v3 defaults', () => {
      // PINNED FAILURE of relation 1 (vertical translation invariance).
      // Measured on this scene: +100 m moves 3 labels (0.043 %), +1000 m moves
      // 27 (0.387 %), +10000 m and +100000 m move 89 each (1.275 %). The class
      // that moves is Building: 1287 at the origin, 1236 at +100000 m, as wall
      // points lose the structural rescue. The bound is an upper limit on the
      // known damage, not a tolerance: the lower bound asserts the relation is
      // still broken, so repairing the classifier reds this test and the pin
      // must then be rewritten to the exact-equality form.
      for (const dz of [100, 1000, 100000]) {
        const changed = changedCount(base.codes, translatedRun(0, 0, dz, V3).codes);
        expect(changed).toBeGreaterThan(0);
        expect(changed).toBeLessThan(scene.count * 0.03);
      }
    });

    it('HOLDS exactly to +100000 m once the structural rescue is disabled', () => {
      // Same scene, same grid, `structuralNeighborRadiusM = 0`. Zero labels move
      // at +10, +1000 or +100000 m, which places the whole of the failure above
      // in the v3 eigen-descriptor rescue rather than in the grid-minimum
      // surface, the morphological ground filter, or the HAG bands.
      for (const dz of [10, 1000, 100000]) {
        expect(changedCount(baseV2.codes, translatedRun(0, 0, dz, V2).codes)).toBe(0);
      }
    });

    it('reaches the float32 ceiling at +1000000 m even without the rescue', () => {
      // 45 labels move at +1e6 m and 476 at +1e7 m: the float32 quantum there is
      // 0.0625 m and 0.5 m, which the 0.5 m ground band and the 2/5 m vegetation
      // bands can no longer absorb. This is the ceiling of the Float32Array
      // input contract itself.
      expect(changedCount(baseV2.codes, translatedRun(0, 0, 1_000_000, V2).codes)).toBeGreaterThan(0);
    });
  });

  // ── Relation 2: horizontal translation ────────────────────────────────────
  describe('relation 2: horizontal translation', () => {
    it('HOLDS exactly at +10 m and +1000 m', () => {
      for (const d of [10, 1000]) {
        expect(changedCount(base.codes, translatedRun(d, d, 0, V3).codes)).toBe(0);
      }
    });

    it('FAILS at +100000 m under the shipping v3 defaults', () => {
      // PINNED FAILURE of relation 2 (horizontal translation invariance).
      // Measured: 82 labels (1.175 %) at +100000 m, 163 at +500000 m, 195 at
      // +1000000 m. Same cause as relation 1: the wall faces are 0.05 m thick
      // and the float32 quantum at 1e5 is 0.0078 m, so the eigen normal the
      // rescue reads is degraded and crosses `structuralVerticalityMin` (0.85).
      const changed = changedCount(base.codes, translatedRun(100_000, 100_000, 0, V3).codes);
      expect(changed).toBeGreaterThan(0);
      expect(changed).toBeLessThan(scene.count * 0.03);
    });

    it('HOLDS exactly to +1000000 m once the structural rescue is disabled', () => {
      // The grid path bins with `Math.floor((x - minX) / cell)` on a 1 m cell,
      // so a 0.0625 m quantum at +1e6 changes no cell assignment. Horizontal
      // invariance survives two orders of magnitude further than vertical does
      // because no horizontal threshold in the classifier is finer than a cell.
      for (const d of [10, 1000, 100_000, 1_000_000]) {
        expect(changedCount(baseV2.codes, translatedRun(d, d, 0, V2).codes)).toBe(0);
      }
    });
  });

  // ── Relation 3: rotation about the vertical axis ──────────────────────────
  describe('relation 3: rotation about the vertical axis', () => {
    // WHY THIS IS AN AGREEMENT FRACTION AND NOT EXACT EQUALITY. Every stage of
    // the classifier bins on an AXIS-ALIGNED grid anchored at the AABB corner:
    // `cellOf` floors `(x - b.minX) / cell` (deriveClassification.ts:740), the
    // bilinear DTM sample and the ground-support read index the same lattice
    // (lines 809 and 832), and the morphological structuring element is an
    // axis-aligned square (`morph`, line 560). A rotation moves the AABB corner,
    // resizes the grid, and carries points across cell boundaries, so points
    // near a boundary legitimately change cell and can change label. Exact
    // equality would be a claim about the grid, not about the classifier.
    const MIN_AGREEMENT = 0.96;

    it('keeps at least 96 % of labels through a full sweep of angles', () => {
      // 18 angles at 20 degree steps. Measured minimum 0.96834 at 200 degrees
      // (221 labels moved); the maximum is 0.99112 at 270 degrees. The floor is
      // set just under the measured worst case. It is not vacuous: the height
      // scaling negative control below scores 0.67039 against the same metric.
      let worst = 1;
      let worstDeg = 0;
      for (let deg = 20; deg < 360; deg += 20) {
        const rad = (deg * Math.PI) / 180;
        const rotated = rotatedZ(scene.positions, Math.cos(rad), Math.sin(rad));
        const a = agreement(base.codes, deriveClassification(rotated, scene.count, V3).codes);
        if (a < worst) {
          worst = a;
          worstDeg = deg;
        }
      }
      expect(worst, `worst agreement ${worst.toFixed(5)} at ${worstDeg} deg`).toBeGreaterThanOrEqual(
        MIN_AGREEMENT,
      );
    });

    it('moves some labels even on an exact quarter turn', () => {
      // Quarter turns use exact integer matrix entries, so no trig rounding is
      // involved and the point set maps onto itself. Labels still move:
      // 90 degrees 0.98224, 180 degrees 0.96963, 270 degrees 0.99112. The cause
      // is the floor in `cellOf`, which is not symmetric under the coordinate
      // mirroring a quarter turn applies, so a point sitting on a cell boundary
      // bins to the neighbouring cell after the turn.
      for (const [cos, sin] of [[0, 1], [-1, 0], [0, -1]] as const) {
        const turned = deriveClassification(rotatedZ(scene.positions, cos, sin), scene.count, V3);
        expect(agreement(base.codes, turned.codes)).toBeGreaterThanOrEqual(MIN_AGREEMENT);
        expect(changedCount(base.codes, turned.codes)).toBeGreaterThan(0);
      }
    });

    it('is not the structural rescue that costs the rotation agreement', () => {
      // v2 scores 0.98224 / 0.97006 / 0.99112 on the same three quarter turns,
      // within 0.0005 of v3. Rotation sensitivity is the axis-aligned grid, and
      // not the component that breaks relations 1 and 2.
      for (const [cos, sin] of [[0, 1], [-1, 0], [0, -1]] as const) {
        const turned = deriveClassification(rotatedZ(scene.positions, cos, sin), scene.count, V2);
        expect(agreement(baseV2.codes, turned.codes)).toBeGreaterThanOrEqual(MIN_AGREEMENT);
      }
    });
  });

  // ── Relation 4: permutation of input order ────────────────────────────────
  describe('relation 4: permutation of input order', () => {
    const rnd = mulberry32(0x9e37);
    const perm = Array.from({ length: scene.count }, (_, i) => i);
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const shuffled = new Float32Array(scene.positions.length);
    for (let k = 0; k < perm.length; k++) {
      shuffled[k * 3] = scene.positions[perm[k] * 3];
      shuffled[k * 3 + 1] = scene.positions[perm[k] * 3 + 1];
      shuffled[k * 3 + 2] = scene.positions[perm[k] * 3 + 2];
    }
    const permuted = deriveClassification(shuffled, scene.count, V3);

    it('HOLDS: every point keeps its own label through the permutation', () => {
      // The per-point mapping, not the histogram. A histogram alone would pass
      // an implementation that shuffled labels between points, so this is the
      // assertion that carries the relation.
      let mismatched = 0;
      for (let k = 0; k < perm.length; k++) {
        if (permuted.codes[k] !== base.codes[perm[k]]) mismatched++;
      }
      expect(mismatched).toBe(0);
    });

    it('HOLDS: the label multiset is identical', () => {
      const a = histogram(base.codes);
      const b = histogram(permuted.codes);
      expect([...b.entries()].sort((x, y) => x[0] - y[0])).toEqual(
        [...a.entries()].sort((x, y) => x[0] - y[0]),
      );
    });

    it('is order-independent in the accumulators the relation could break', () => {
      // The two order-sensitive accumulations are the per-cell Welford roughness
      // (deriveClassification.ts:862) and the eigen covariance the rescue reads
      // through SpatialHash3d, whose bin lists are built in input order. Neither
      // moves a label here, and the derived confidence matches bit for bit.
      expect(permuted.confidence).toBe(base.confidence);
      expect(permuted.cellSizeM).toBe(base.cellSizeM);
    });
  });

  // ── Relation 5: negative controls ─────────────────────────────────────────
  describe('relation 5: negative controls', () => {
    it('adding a tall smooth object changes the label multiset', () => {
      // A 10 x 10 m smooth surface 12 m above the terrain over open ground, 441
      // points at 0.5 m sampling. Measured: Building rises 1287 to 1728, which
      // is exactly the 441 added points, and Ground, both low bands and High
      // vegetation are untouched. The added object is classified, not absorbed.
      const extra: number[] = [];
      for (let i = 0; i <= 20; i++) {
        for (let j = 0; j <= 20; j++) {
          const x = 5 + i * 0.5;
          const y = 45 + j * 0.5;
          extra.push(x, y, terrain(x, y) + 12);
        }
      }
      const withObject = new Float32Array(scene.positions.length + extra.length);
      withObject.set(scene.positions, 0);
      withObject.set(extra, scene.positions.length);
      const added = extra.length / 3;
      const result = deriveClassification(withObject, withObject.length / 3, V3);

      expect(result.counts[DERIVED_BUILDING]).toBe(base.counts[DERIVED_BUILDING] + added);
      // The object is local: the 6981 pre-existing points keep their labels, so
      // the multiset moved for a reason and not through a global reshuffle.
      expect(changedCount(base.codes, result.codes.subarray(0, scene.count))).toBe(0);
    });

    it('scaling every height falsifies relations 1, 2 and 4 and the rotation floor', () => {
      // Heights tripled about the terrain datum, point order and XY untouched,
      // so this runs through exactly the comparators the four relations use.
      // Measured: 2301 of 6981 labels move (32.96 %), agreement 0.67039. High
      // vegetation goes 839 to 2644 as the medium band empties upward, and
      // Building drops 1287 to 196 as the walls stretch past the rescue.
      const scaled = new Float32Array(scene.positions);
      for (let i = 0; i < scene.count; i++) {
        const g = terrain(scaled[i * 3], scaled[i * 3 + 1]);
        scaled[i * 3 + 2] = g + (scaled[i * 3 + 2] - g) * 3;
      }
      const result = deriveClassification(scaled, scene.count, V3);

      expect(changedCount(base.codes, result.codes)).toBeGreaterThan(scene.count * 0.25);
      // Below the 0.96 floor relation 3 asserts, so that floor can be failed.
      expect(agreement(base.codes, result.codes)).toBeLessThan(0.96);
      // And the multiset moves too, so the histogram comparator can fail.
      expect(histogram(result.codes)).not.toEqual(histogram(base.codes));
    });
  });

  // ── Mechanism of the relation 1 and 2 failures ────────────────────────────
  describe('float32 storage quantum reproduces the offset exactly', () => {
    it('vertical: quantised-only labels are byte-identical to translated labels', () => {
      // Round Z through the float32 grid the offset lands on, then classify at
      // the ORIGIN. If the classifier's own arithmetic were losing precision at
      // large coordinates, these two runs would differ. They agree on all 6981
      // labels at every offset, so the entire loss is in what the Float32Array
      // input buffer can represent, and the v3 rescue is the consumer fine
      // enough to notice it.
      for (const dz of [100, 1000, 100_000]) {
        const quantised = deriveClassification(
          quantisedAxes(scene.positions, dz, [2]),
          scene.count,
          V3,
        );
        expect(changedCount(quantised.codes, translatedRun(0, 0, dz, V3).codes)).toBe(0);
      }
    });

    it('horizontal: quantised-only labels are byte-identical to translated labels', () => {
      const quantised = deriveClassification(
        quantisedAxes(scene.positions, 100_000, [0, 1]),
        scene.count,
        V3,
      );
      expect(
        changedCount(quantised.codes, translatedRun(100_000, 100_000, 0, V3).codes),
      ).toBe(0);
    });
  });
});

describe('classifyScanShape — metamorphic invariance', () => {
  const verdict = (s: ReturnType<typeof classifyScanShape>) => ({
    kind: s.kind,
    spaceKind: s.spaceKind,
    nonTerrain: s.nonTerrain,
    up: s.up,
    confidence: s.confidence,
  });
  const baseShape = classifyScanShape(scene.positions);

  it('routes the scene as terrain', () => {
    expect(verdict(baseShape)).toEqual({
      kind: 'terrain',
      spaceKind: 'terrain',
      nonTerrain: false,
      up: 'z',
      confidence: 0.85,
    });
  });

  it('HOLDS: vertical translation leaves the verdict and the cell signals alone', () => {
    for (const dz of [10, 1000, 100_000]) {
      const s = classifyScanShape(translated(scene.positions, 0, 0, dz));
      expect(verdict(s)).toEqual(verdict(baseShape));
      // The cell-based signals are ratios of occupied-cell counts, so they are
      // exactly invariant at +10 and +1000 m. At +100000 m the float32 quantum
      // moves floorCoverage 0.80701 to 0.80791, which the tolerance covers.
      expect(s.overhangFraction).toBeCloseTo(baseShape.overhangFraction, 3);
      expect(s.wallCoverage).toBeCloseTo(baseShape.wallCoverage, 3);
      expect(s.floorCoverage).toBeCloseTo(baseShape.floorCoverage, 2);
    }
  });

  it('HOLDS: horizontal translation leaves the verdict and the cell signals alone', () => {
    for (const d of [1000, 100_000]) {
      const s = classifyScanShape(translated(scene.positions, d, d, 0));
      expect(verdict(s)).toEqual(verdict(baseShape));
      expect(s.aspect).toBeCloseTo(baseShape.aspect, 4);
      expect(s.overhangFraction).toBeCloseTo(baseShape.overhangFraction, 3);
    }
  });

  it('HOLDS exactly on a quarter turn: the AABB maps onto itself', () => {
    for (const [cos, sin] of [[0, 1], [-1, 0]] as const) {
      const s = classifyScanShape(rotatedZ(scene.positions, cos, sin));
      expect(verdict(s)).toEqual(verdict(baseShape));
      // A quarter turn swaps the two horizontal AABB axes without resizing
      // either, so aspect is bit-identical (0.17454).
      expect(s.aspect).toBe(baseShape.aspect);
      expect(s.wallCoverage).toBe(baseShape.wallCoverage);
      expect(s.overhangFraction).toBe(baseShape.overhangFraction);
    }
  });

  it('keeps the verdict but not `aspect` under an arbitrary rotation', () => {
    // PINNED NON-INVARIANCE. `aspect` is vertical extent over horizontal
    // footprint taken from the AXIS-ALIGNED bounding box (scanShape.ts, the
    // `extent` field), and rotating a square footprint grows that box, so aspect
    // shrinks: 0.17454 at rest, 0.12821 at 31 degrees, 0.12446 at 45 degrees.
    // The routing verdict is unaffected because the terrain decision has ample
    // margin at this aspect, but a scan sitting near an aspect threshold would
    // route differently depending on its orientation in the source CRS.
    for (const deg of [31, 45]) {
      const rad = (deg * Math.PI) / 180;
      const s = classifyScanShape(rotatedZ(scene.positions, Math.cos(rad), Math.sin(rad)));
      expect(verdict(s)).toEqual(verdict(baseShape));
      expect(s.aspect).toBeLessThan(baseShape.aspect * 0.9);
    }
  });

  it('HOLDS exactly under permutation of input order', () => {
    const rnd = mulberry32(0x1234);
    const perm = Array.from({ length: scene.count }, (_, i) => i);
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const shuffled = new Float32Array(scene.positions.length);
    for (let k = 0; k < perm.length; k++) {
      shuffled[k * 3] = scene.positions[perm[k] * 3];
      shuffled[k * 3 + 1] = scene.positions[perm[k] * 3 + 1];
      shuffled[k * 3 + 2] = scene.positions[perm[k] * 3 + 2];
    }
    const s = classifyScanShape(shuffled);
    expect(verdict(s)).toEqual(verdict(baseShape));
    expect(s.aspect).toBe(baseShape.aspect);
    expect(s.overhangFraction).toBe(baseShape.overhangFraction);
    expect(s.wallCoverage).toBe(baseShape.wallCoverage);
    expect(s.floorCoverage).toBe(baseShape.floorCoverage);
  });
});
