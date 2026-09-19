import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  continuitySupport,
  mayReconstruct,
  SAMPLES_FOR_FULL_SUPPORT,
  MIN_SUPPORT_TO_RECONSTRUCT,
  type SupportInput,
} from '../src/render/continuity/continuitySupport';

const full: SupportInput = {
  directSamples: SAMPLES_FOR_FULL_SUPPORT,
  phasesContributed: 4,
  phaseCount: 4,
  neighbourCoherence: 1,
};

describe('continuity support', () => {
  it('is complete when every part is', () => {
    expect(continuitySupport(full)).toBe(1);
  });

  it('stays inside [0, 1]', () => {
    const wild: SupportInput = {
      ...full,
      directSamples: 10_000,
      phasesContributed: 99,
      neighbourCoherence: 7,
    };
    expect(continuitySupport(wild)).toBe(1);
  });

  // The gate is on inventing a pixel, so every signal has to be satisfied. An
  // average would let a strong signal carry a weak one into a fill.
  it('takes the weakest part, not the average', () => {
    const fewSamples = continuitySupport({ ...full, directSamples: 1 });
    expect(fewSamples).toBeCloseTo(0.25, 12);

    const edge = continuitySupport({ ...full, neighbourCoherence: 0.2 });
    expect(edge).toBeCloseTo(0.2, 12);

    // Plenty of samples and a complete sweep do not rescue a pixel on an edge.
    const both = continuitySupport({
      ...full,
      directSamples: 1000,
      neighbourCoherence: 0.2,
    });
    expect(both).toBeCloseTo(0.2, 12);
  });

  it('has no support at all when a part is absent', () => {
    expect(continuitySupport({ ...full, directSamples: 0 })).toBe(0);
    expect(continuitySupport({ ...full, phasesContributed: 0 })).toBe(0);
    expect(continuitySupport({ ...full, neighbourCoherence: 0 })).toBe(0);
  });

  it('grows as a sweep completes', () => {
    const at = (n: number) => continuitySupport({ ...full, phasesContributed: n });
    expect(at(1)).toBeCloseTo(0.25, 12);
    expect(at(2)).toBeCloseTo(0.5, 12);
    expect(at(4)).toBe(1);
    expect(at(2)).toBeGreaterThan(at(1));
  });

  it('treats a degenerate input as no support rather than as full', () => {
    for (const bad of [Number.NaN, -1, Number.NEGATIVE_INFINITY]) {
      expect(continuitySupport({ ...full, directSamples: bad })).toBe(0);
      expect(continuitySupport({ ...full, neighbourCoherence: bad })).toBe(0);
    }
  });
});

describe('reconstruction gate', () => {
  // Refusing costs a visible gap; allowing wrongly costs a surface that was
  // never there. The first is honest, so the threshold errs toward the gap.
  it('errs toward leaving the gap', () => {
    expect(MIN_SUPPORT_TO_RECONSTRUCT).toBeGreaterThan(0.5);
  });

  it('admits a well-backed pixel and refuses a thin one', () => {
    expect(mayReconstruct(1)).toBe(true);
    expect(mayReconstruct(MIN_SUPPORT_TO_RECONSTRUCT)).toBe(true);
    expect(mayReconstruct(MIN_SUPPORT_TO_RECONSTRUCT - 1e-9)).toBe(false);
    expect(mayReconstruct(0)).toBe(false);
  });

  it('refuses a support that is not a number', () => {
    expect(mayReconstruct(Number.NaN)).toBe(false);
  });
});

describe('naming', () => {
  // This viewer already reports confidence about measured things. A display
  // quantity sharing that word would read as the same kind of claim.
  it('never calls this confidence', () => {
    // fileURLToPath, not URL.pathname: on Windows the latter yields `/D:/...`,
    // which Node then resolves against the current drive as `D:\\D:\\...`.
    const src = readFileSync(
      fileURLToPath(new URL('../src/render/continuity/continuitySupport.ts', import.meta.url)),
      'utf8',
    );
    const code = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(/confidence/i.test(code)).toBe(false);
  });
});
