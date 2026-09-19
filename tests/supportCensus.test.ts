import { describe, it, expect } from 'vitest';
import {
  EMPTY_CENSUS,
  censusOf,
  totalPixels,
  reconstructedShare,
  withinReconstructionCeiling,
  RECONSTRUCTION_SHARE_CEILING,
} from '../src/render/continuity/supportCensus';
import type { SupportKind } from '../src/render/continuity/microGap';

const run = (spec: Partial<Record<SupportKind, number>>): SupportKind[] => {
  const out: SupportKind[] = [];
  for (const [kind, n] of Object.entries(spec)) {
    for (let i = 0; i < (n ?? 0); i++) out.push(kind as SupportKind);
  }
  return out;
};

describe('support census', () => {
  it('counts an empty frame as nothing', () => {
    expect(censusOf([])).toEqual(EMPTY_CENSUS);
    expect(totalPixels(EMPTY_CENSUS)).toBe(0);
  });

  it('tallies each kind', () => {
    const c = censusOf(run({ direct: 3, accumulated: 2, reconstructed: 1, none: 4 }));
    expect(c).toEqual({ direct: 3, accumulated: 2, reconstructed: 1, none: 4 });
    expect(totalPixels(c)).toBe(10);
  });

  // Against the whole frame, the same reconstruction shrinks simply by pulling
  // the camera back until most of the image is background. That is the one
  // direction this number must not be easy to move.
  it('measures against drawn pixels, not the whole frame', () => {
    const tight = censusOf(run({ direct: 8, reconstructed: 2, none: 0 }));
    const pulledBack = censusOf(run({ direct: 8, reconstructed: 2, none: 990 }));
    expect(reconstructedShare(tight)).toBeCloseTo(0.2, 12);
    expect(reconstructedShare(pulledBack)).toBeCloseTo(0.2, 12);
  });

  it('counts accumulated pixels as drawn but not invented', () => {
    const c = censusOf(run({ accumulated: 9, reconstructed: 1 }));
    expect(reconstructedShare(c)).toBeCloseTo(0.1, 12);
  });

  // An empty view must not read as a clean result.
  it('has no share when nothing was drawn', () => {
    expect(reconstructedShare(censusOf(run({ none: 500 })))).toBeNull();
    expect(reconstructedShare(EMPTY_CENSUS)).toBeNull();
  });

  it('reports a fully reconstructed frame as entirely invented', () => {
    expect(reconstructedShare(censusOf(run({ reconstructed: 10 })))).toBe(1);
  });

  it('reports a fully measured frame as nothing invented', () => {
    expect(reconstructedShare(censusOf(run({ direct: 10 })))).toBe(0);
  });

  it('passes a frame at the ceiling and fails one past it', () => {
    const at = censusOf(run({ direct: 80, reconstructed: 20 }));
    const past = censusOf(run({ direct: 70, reconstructed: 30 }));
    expect(reconstructedShare(at)).toBeCloseTo(RECONSTRUCTION_SHARE_CEILING, 12);
    expect(withinReconstructionCeiling(at)).toBe(true);
    expect(withinReconstructionCeiling(past)).toBe(false);
  });

  it('does not fail a frame that drew nothing', () => {
    expect(withinReconstructionCeiling(censusOf(run({ none: 100 })))).toBe(true);
  });

  it('honours a caller-supplied ceiling', () => {
    const c = censusOf(run({ direct: 90, reconstructed: 10 }));
    expect(withinReconstructionCeiling(c, 0.05)).toBe(false);
    expect(withinReconstructionCeiling(c, 0.5)).toBe(true);
  });
});
