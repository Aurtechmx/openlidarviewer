/**
 * measureConfidence.test.ts — the measurement-context state. Every displayed
 * value states what kind of number it is (viewer measurement with a resolved
 * datum / approximate scene-local figure / no shared basis), and none of the
 * wording is allowed to promise more than the scene has proven.
 */

import { describe, it, expect } from 'vitest';
import {
  confidenceForKind,
  layerContextOf,
  measureConfidence,
  UNRESOLVED_SCENE_CONTEXT,
  type MeasureConfidenceContext,
  type MeasureLayerContext,
} from '../src/render/measure/measureConfidence';

/** A fully-proven context — the only shape that may read as verified. */
const proven: MeasureConfidenceContext = {
  datumResolved: true,
  layers: 'single',
  verticalReferenceKnown: true,
  dependsOnHeight: false,
};

describe('measureConfidence', () => {
  it('verified when the datum resolved over a single layer', () => {
    const c = measureConfidence(proven);
    expect(c.level).toBe('verified');
    expect(c.label).toBe('Viewer measurement · datum resolved');
  });

  it('verified when the datum resolved over an all-verified layer set', () => {
    const c = measureConfidence({ ...proven, layers: 'all-verified' });
    expect(c.level).toBe('verified');
  });

  it('approximate when the shared datum is unresolved', () => {
    const c = measureConfidence({ ...proven, datumResolved: false });
    expect(c.level).toBe('approximate');
    if (c.level !== 'approximate') return;
    expect(c.reason).toContain('shared datum unresolved — coordinates are scene-local');
  });

  it('approximate when a height-dependent kind has no known vertical reference', () => {
    const c = measureConfidence({
      ...proven,
      verticalReferenceKnown: false,
      dependsOnHeight: true,
    });
    expect(c.level).toBe('approximate');
    if (c.level !== 'approximate') return;
    expect(c.reason).toContain('vertical reference unknown');
  });

  it('an unknown vertical reference does NOT demote a kind that ignores height', () => {
    const c = measureConfidence({ ...proven, verticalReferenceKnown: false });
    expect(c.level).toBe('verified');
  });

  it('joins both caveats when the datum is unresolved AND the vertical is unknown', () => {
    const c = measureConfidence({
      datumResolved: false,
      layers: 'single',
      verticalReferenceKnown: false,
      dependsOnHeight: true,
    });
    expect(c.level).toBe('approximate');
    if (c.level !== 'approximate') return;
    expect(c.reason).toContain('shared datum unresolved');
    expect(c.reason).toContain('vertical reference unknown');
  });

  it('fail-closed: a mixed layer set is approximate even with a resolved datum', () => {
    const c = measureConfidence({ ...proven, layers: 'mixed' });
    expect(c.level).toBe('approximate');
    if (c.level !== 'approximate') return;
    expect(c.reason).toContain('unproven');
  });

  it('unavailable when the layer set is incomparable — and it beats every other rule', () => {
    const c = measureConfidence({ ...proven, layers: 'incomparable' });
    expect(c.level).toBe('unavailable');
    if (c.level !== 'unavailable') return;
    expect(c.reason.length).toBeGreaterThan(0);
    // Still unavailable when the other caveats also apply.
    const worst = measureConfidence({
      datumResolved: false,
      layers: 'incomparable',
      verticalReferenceKnown: false,
      dependsOnHeight: true,
    });
    expect(worst.level).toBe('unavailable');
  });

  it('the fail-closed default scene reads approximate with the datum reason', () => {
    const c = measureConfidence({ ...UNRESOLVED_SCENE_CONTEXT, dependsOnHeight: false });
    expect(c.level).toBe('approximate');
    if (c.level !== 'approximate') return;
    expect(c.reason).toContain('shared datum unresolved');
  });

  it('never uses certifying words in any label or reason, across every context', () => {
    const banned = /accurate|survey|certified|precise/i;
    const layerStates: MeasureLayerContext[] = ['single', 'all-verified', 'mixed', 'incomparable'];
    for (const datumResolved of [true, false]) {
      for (const layers of layerStates) {
        for (const verticalReferenceKnown of [true, false]) {
          for (const dependsOnHeight of [true, false]) {
            const c = measureConfidence({
              datumResolved,
              layers,
              verticalReferenceKnown,
              dependsOnHeight,
            });
            expect(c.label).not.toMatch(banned);
            if (c.level !== 'verified') expect(c.reason).not.toMatch(banned);
          }
        }
      }
    }
  });
});

describe('confidenceForKind', () => {
  it('height and volume depend on the vertical reference', () => {
    const scene = { datumResolved: true, layers: 'single', verticalReferenceKnown: false } as const;
    expect(confidenceForKind('height', scene).level).toBe('approximate');
    expect(confidenceForKind('volume', scene).level).toBe('approximate');
  });

  it('a horizontal kind stays verified when only the vertical is unknown', () => {
    const scene = { datumResolved: true, layers: 'single', verticalReferenceKnown: false } as const;
    expect(confidenceForKind('distance', scene).level).toBe('verified');
    expect(confidenceForKind('area', scene).level).toBe('verified');
  });
});

describe('layerContextOf', () => {
  it('zero or one layer is the single-layer context', () => {
    expect(layerContextOf([])).toBe('single');
    expect(layerContextOf(['verified'])).toBe('single');
    expect(layerContextOf(['unknown'])).toBe('single');
  });

  it('a unanimous verified set is all-verified', () => {
    expect(layerContextOf(['verified', 'verified'])).toBe('all-verified');
  });

  it('any incompatible layer makes the set incomparable', () => {
    expect(layerContextOf(['verified', 'incompatible'])).toBe('incomparable');
  });

  it('unknown or horizontal-only members make the set mixed (fail-closed)', () => {
    expect(layerContextOf(['verified', 'unknown'])).toBe('mixed');
    expect(layerContextOf(['verified', 'horizontal-only'])).toBe('mixed');
  });
});
