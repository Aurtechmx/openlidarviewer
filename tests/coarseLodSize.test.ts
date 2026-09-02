/**
 * coarseLodSize.test.ts
 *
 * The pure maths of coarse-LOD display compensation, plus the uniform
 * bookkeeping that folds it into the size graph. Both halves are exercised in
 * Node — the class takes its `uniform` factory and size nodes by injection, so
 * the fold can be observed without a GPU.
 */

import { describe, expect, it } from 'vitest';
import {
  CoarseLodSizeNodes,
  MAX_COMPENSATED_SIZE_FACTOR,
  MAX_LOD_SCALE,
  PHASE_LOD_GAIN,
  coarseLodScale,
  markNodeResolution,
  maxCompensatedPointSize,
  phaseLodGain,
  relativeNodeResolution,
} from '../src/render/streamingLodSize';
import { POINT_STYLE_DEFAULTS } from '../src/render/pointStyle';
import type { RefinementPhase } from '../src/render/refinementPhase';

const PHASES: RefinementPhase[] = ['moving', 'coverage', 'center-refine', 'full-refine'];

describe('relativeNodeResolution', () => {
  it('is the node/root ratio, clamped to 1 at the root', () => {
    expect(relativeNodeResolution(2, 4)).toBeCloseTo(0.5, 12);
    expect(relativeNodeResolution(4, 4)).toBe(1);
    expect(relativeNodeResolution(8, 4)).toBe(1);
  });

  it('refuses an unusable root resolution — no compensation', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      expect(relativeNodeResolution(2, bad)).toBe(0);
    }
  });

  it('refuses an unusable node resolution — no compensation', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      expect(relativeNodeResolution(bad, 4)).toBe(0);
    }
  });
});

describe('coarseLodScale', () => {
  it('gives the root node the maximum bounded scale while moving', () => {
    expect(coarseLodScale(1, 'moving', 'adaptive')).toBeCloseTo(MAX_LOD_SCALE, 12);
  });

  it('gives a finer node a smaller scale than a coarser one', () => {
    const coarse = coarseLodScale(1, 'moving', 'adaptive');
    const mid = coarseLodScale(0.5, 'moving', 'adaptive');
    const fine = coarseLodScale(0.125, 'moving', 'adaptive');
    expect(mid).toBeLessThan(coarse);
    expect(fine).toBeLessThan(mid);
    expect(fine).toBeGreaterThan(1);
  });

  it('converges to exactly 1 in full-refine — settled sizing is unchanged', () => {
    expect(phaseLodGain('full-refine')).toBe(0);
    for (const rel of [0, 0.25, 0.5, 1]) {
      expect(coarseLodScale(rel, 'full-refine', 'adaptive')).toBe(1);
      expect(coarseLodScale(rel, 'full-refine', 'density')).toBe(1);
    }
  });

  it('steps down through the phases at a fixed resolution', () => {
    const at = (p: RefinementPhase) => coarseLodScale(1, p, 'adaptive');
    expect(at('moving')).toBe(at('coverage'));
    expect(at('center-refine')).toBeLessThan(at('coverage'));
    expect(at('full-refine')).toBeLessThan(at('center-refine'));
  });

  it('leaves fixed mode untouched in every phase and at every resolution', () => {
    for (const phase of PHASES) {
      for (const rel of [0, 0.3, 1, NaN, -5]) {
        expect(coarseLodScale(rel, phase, 'fixed')).toBe(1);
      }
    }
  });

  it('is finite and inside [1, MAX_LOD_SCALE] for any input', () => {
    const inputs = [0, -0, -1, -1e9, 0.001, 0.5, 1, 2, 1e9, NaN, Infinity, -Infinity];
    for (const phase of PHASES) {
      for (const mode of ['adaptive', 'density', 'fixed'] as const) {
        for (const rel of inputs) {
          const s = coarseLodScale(rel, phase, mode);
          expect(Number.isFinite(s)).toBe(true);
          expect(s).toBeGreaterThanOrEqual(1);
          expect(s).toBeLessThanOrEqual(MAX_LOD_SCALE);
        }
      }
    }
  });
});

describe('maxCompensatedPointSize', () => {
  it('is the existing adaptive maximum times the largest LOD scale', () => {
    const base = 2;
    const existing = base * POINT_STYLE_DEFAULTS.maxSizeFactor;
    expect(maxCompensatedPointSize(base, POINT_STYLE_DEFAULTS.maxSizeFactor)).toBeCloseTo(
      existing * MAX_LOD_SCALE,
      12,
    );
    expect(MAX_COMPENSATED_SIZE_FACTOR).toBeCloseTo(
      POINT_STYLE_DEFAULTS.maxSizeFactor * MAX_LOD_SCALE,
      12,
    );
  });

  it('bounds the compensated adaptive size for every phase and resolution', () => {
    const base = 3;
    const cap = maxCompensatedPointSize(base, POINT_STYLE_DEFAULTS.maxSizeFactor);
    const adaptiveMax = base * POINT_STYLE_DEFAULTS.maxSizeFactor;
    for (const phase of PHASES) {
      for (const rel of [0, 0.5, 1, NaN, Infinity]) {
        const sized = adaptiveMax * coarseLodScale(rel, phase, 'adaptive');
        expect(sized).toBeLessThanOrEqual(cap + 1e-12);
        expect(sized).toBeGreaterThanOrEqual(POINT_STYLE_DEFAULTS.minSizePx);
      }
    }
  });
});

// --- uniform bookkeeping -------------------------------------------------

/** A node stand-in recording the operations the fold applies to it. */
interface FakeNode {
  op: string;
  args: unknown[];
  add(o: unknown): FakeNode;
  mul(o: unknown): FakeNode;
  clamp(lo: unknown, hi: unknown): FakeNode;
}

function fakeNode(op: string, args: unknown[] = []): FakeNode {
  return {
    op,
    args,
    add: (o) => fakeNode('add', [op, o]),
    mul: (o) => fakeNode('mul', [op, o]),
    clamp: (lo, hi) => fakeNode('clamp', [op, lo, hi]),
  };
}

function harness() {
  let made = 0;
  const uniform = (value: number) => {
    made++;
    return { value };
  };
  const nodes = new CoarseLodSizeNodes(uniform, fakeNode('base'), fakeNode('min'));
  return { nodes, made: () => made };
}

function material(node: number, root: number): { userData: Record<string, unknown> } {
  const m = { userData: {} as Record<string, unknown> };
  markNodeResolution(m.userData, node, root);
  return m;
}

describe('CoarseLodSizeNodes', () => {
  it('starts at the settled gain — nothing is enlarged until a phase says so', () => {
    expect(harness().nodes.phaseGain).toBe(PHASE_LOD_GAIN['full-refine']);
  });

  it('registers one uniform per material and reports first registration', () => {
    const h = harness();
    const a = material(4, 4);
    expect(h.nodes.register(a)).toBe(true);
    expect(h.nodes.register(a)).toBe(false);
    const b = material(1, 4);
    expect(h.nodes.register(b)).toBe(true);
    // one shared gain uniform + one per material
    expect(h.made()).toBe(3);
  });

  it('does not fold on an unregistered material or in fixed mode', () => {
    const h = harness();
    const m = material(4, 4);
    expect(h.nodes.has(m, 'adaptive')).toBe(false);
    h.nodes.register(m);
    expect(h.nodes.has(m, 'adaptive')).toBe(true);
    expect(h.nodes.has(m, 'density')).toBe(true);
    expect(h.nodes.has(m, 'fixed')).toBe(false);
    const untouched = fakeNode('size');
    expect(h.nodes.apply(untouched, material(4, 4))).toBe(untouched);
  });

  it('a phase change writes the shared uniform and creates nothing', () => {
    const h = harness();
    h.nodes.register(material(4, 4));
    const before = h.made();
    h.nodes.setPhase('moving');
    expect(h.nodes.phaseGain).toBe(1);
    h.nodes.setPhase('center-refine');
    expect(h.nodes.phaseGain).toBe(0.5);
    h.nodes.setPhase('full-refine');
    expect(h.nodes.phaseGain).toBe(0);
    expect(h.made()).toBe(before);
  });

  it('applies the compensated clamp to the folded size', () => {
    const h = harness();
    const m = material(4, 4);
    h.nodes.register(m);
    const folded = h.nodes.apply(fakeNode('size'), m);
    expect(folded.op).toBe('clamp');
    expect(folded.args[0]).toBe('add');
    expect((folded.args[2] as FakeNode).op).toBe('mul');
    expect((folded.args[2] as FakeNode).args).toEqual(['base', MAX_COMPENSATED_SIZE_FACTOR]);
  });

  it('forgets a material so a removed streaming mesh stops folding', () => {
    const h = harness();
    const m = material(4, 4);
    h.nodes.register(m);
    h.nodes.forget(m);
    expect(h.nodes.has(m, 'adaptive')).toBe(false);
    expect(h.nodes.register(m)).toBe(true);
  });

  it('registers an unusable resolution pair at the identity scale', () => {
    const h = harness();
    const m = { userData: {} as Record<string, unknown> };
    expect(h.nodes.register(m)).toBe(true);
    expect(coarseLodScale(0, 'moving', 'adaptive')).toBe(1);
  });
});
