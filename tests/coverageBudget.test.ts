import { describe, it, expect } from 'vitest';
import {
  projectedSpacingPx,
  coverageNeed,
  discountedNeed,
  coverageFactor,
  nodeCoverageFactor,
  MIN_COVERAGE_FACTOR,
  OVERSAMPLED_SPACING_PX,
  FULL_NEED_SPACING_PX,
  type NodeCoverageDescriptor,
} from '../src/render/streaming/coverageBudget';
import { nodeScore, DEPTH_WEIGHT, SIZE_TERM_MAX } from '../src/render/streaming/streamingScore';
import type { Box6 } from '../src/io/copc/copcTypes';

const FOCAL = 800;
const box = (half: number): Box6 => [-half, -half, -half, half, half, half];

describe('projected spacing', () => {
  it('shrinks with distance and grows with focal length', () => {
    const near = projectedSpacingPx(0.1, 10, FOCAL)!;
    const far = projectedSpacingPx(0.1, 100, FOCAL)!;
    expect(near).toBeGreaterThan(far);
    expect(projectedSpacingPx(0.1, 10, FOCAL * 2)!).toBeCloseTo(near * 2, 10);
  });

  it('has no answer where the projection has no meaning', () => {
    expect(projectedSpacingPx(0.1, 0, FOCAL)).toBeNull();
    expect(projectedSpacingPx(0.1, -5, FOCAL)).toBeNull();
    expect(projectedSpacingPx(0, 10, FOCAL)).toBeNull();
    expect(projectedSpacingPx(NaN, 10, FOCAL)).toBeNull();
    expect(projectedSpacingPx(0.1, 10, 0)).toBeNull();
  });
});

describe('coverage need', () => {
  it('is nothing for a node finer than a pixel', () => {
    expect(coverageNeed(OVERSAMPLED_SPACING_PX)).toBe(0);
    expect(coverageNeed(0.3)).toBe(0);
  });

  it('is full for a node leaving visible gaps', () => {
    expect(coverageNeed(FULL_NEED_SPACING_PX)).toBe(1);
    expect(coverageNeed(40)).toBe(1);
  });

  it('rises monotonically between the two', () => {
    let previous = -1;
    for (let px = 1; px <= 4; px += 0.25) {
      const n = coverageNeed(px);
      expect(n).toBeGreaterThanOrEqual(previous);
      previous = n;
    }
  });

  it('treats an unknown spacing as needing coverage, not as redundant', () => {
    expect(coverageNeed(null)).toBe(1);
    expect(coverageNeed(NaN)).toBe(1);
  });
});

describe('support discounts need without replacing it', () => {
  it('removes need in proportion to what history already carries', () => {
    expect(discountedNeed(1, 0)).toBe(1);
    expect(discountedNeed(1, 0.5)).toBe(0.5);
    expect(discountedNeed(1, 1)).toBe(0);
    expect(discountedNeed(0.5, 0.5)).toBe(0.25);
  });

  it('discounts nothing for a support figure that is not a share', () => {
    for (const bad of [NaN, Infinity, -0.2, 1.4]) expect(discountedNeed(1, bad)).toBe(1);
  });
});

describe('the factor never excludes a node', () => {
  it('is strictly positive for every input', () => {
    const inputs = [-1, 0, 0.25, 0.5, 1, 2, NaN, Infinity];
    for (const need of inputs) {
      for (const support of inputs) {
        const f = coverageFactor(need, support);
        expect(f).toBeGreaterThan(0);
        expect(f).toBeGreaterThanOrEqual(MIN_COVERAGE_FACTOR);
        expect(f).toBeLessThanOrEqual(1);
      }
    }
  });

  it('reaches the floor for a fully oversampled, fully supported node', () => {
    expect(coverageFactor(0, 0)).toBeCloseTo(MIN_COVERAGE_FACTOR, 10);
    expect(coverageFactor(1, 1)).toBeCloseTo(MIN_COVERAGE_FACTOR, 10);
  });

  it('reaches one only for a node with full unmet need', () => {
    expect(coverageFactor(1, 0)).toBe(1);
  });
});

describe('coarse-first survives any coverage factor', () => {
  const scoreAt = (depth: number, factor: number): number => {
    const raw = nodeScore({
      bounds: box(50),
      cameraPos: [0, 0, 200],
      depth,
      depthCap: 10,
    });
    // Coverage scales the size term the way the focus bias does: it can only
    // shrink the lower digit, never borrow from the depth digit above it.
    const depthPart = Math.floor(raw / DEPTH_WEIGHT) * DEPTH_WEIGHT;
    const sizePart = raw - depthPart;
    return depthPart + sizePart * factor;
  };

  it('keeps a shallower node ahead of a deeper one however much better its coverage', () => {
    // Deeper node with the best possible coverage, shallower with the worst.
    const deepBest = scoreAt(6, 1);
    const shallowWorst = scoreAt(5, MIN_COVERAGE_FACTOR);
    expect(shallowWorst).toBeGreaterThan(deepBest);
  });

  it('keeps the scaled size term inside its slot', () => {
    for (const factor of [MIN_COVERAGE_FACTOR, 0.5, 1]) {
      const s = scoreAt(5, factor);
      const sizePart = s - Math.floor(s / DEPTH_WEIGHT) * DEPTH_WEIGHT;
      expect(sizePart).toBeGreaterThanOrEqual(0);
      expect(sizePart).toBeLessThanOrEqual(SIZE_TERM_MAX);
    }
  });

  it('reorders within a depth without removing anyone from it', () => {
    const factors = [1, 0.4, MIN_COVERAGE_FACTOR];
    const scores = factors.map((f) => scoreAt(5, f));
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
    // Every one is still a candidate: zero is what means 'not this tick'.
    for (const s of scores) expect(s).toBeGreaterThan(0);
  });
});

describe('the whole descriptor path', () => {
  const near: NodeCoverageDescriptor = { spacing: 0.5, distance: 20, temporalSupport: 0 };
  const oversampled: NodeCoverageDescriptor = { spacing: 0.001, distance: 20, temporalSupport: 0 };

  it('prefers a node that would close gaps over one already finer than a pixel', () => {
    expect(nodeCoverageFactor(near, FOCAL)).toBeGreaterThan(
      nodeCoverageFactor(oversampled, FOCAL),
    );
  });

  it('lowers a node whose region history already carries', () => {
    const supported = { ...near, temporalSupport: 0.9 };
    expect(nodeCoverageFactor(supported, FOCAL)).toBeLessThan(nodeCoverageFactor(near, FOCAL));
  });

  it('never returns a factor that would exclude the node', () => {
    for (const d of [near, oversampled, { spacing: -1, distance: -1, temporalSupport: 2 }]) {
      expect(nodeCoverageFactor(d, FOCAL)).toBeGreaterThan(0);
    }
  });
});
