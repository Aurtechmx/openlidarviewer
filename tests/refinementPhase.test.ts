/**
 * refinementPhase.test.ts
 *
 * Pins the P6 phase machine and its weighting maths: motion always resets to
 * `moving`; parked, the machine advances only on readiness signals (never on
 * elapsed time alone) with the settle window as a lower bound; DPR/selection
 * scales rise monotonically coarse→fine; and center weighting peaks at the
 * center and clamps at the edge.
 */

import { describe, it, expect } from 'vitest';
import {
  REFINEMENT_PHASE_ORDER,
  nextRefinementPhase,
  phaseDprScale,
  phaseSelectionFactor,
  centerWeight,
  type PhaseInput,
} from '../src/render/refinementPhase';

const SETTLE = 280;
function parked(overrides: Partial<PhaseInput> = {}): PhaseInput {
  return {
    moving: false,
    msSinceSettle: 10_000,
    settleMs: SETTLE,
    coverageComplete: true,
    centralRefined: true,
    ...overrides,
  };
}

describe('nextRefinementPhase', () => {
  it('any motion drops straight back to moving', () => {
    for (const p of REFINEMENT_PHASE_ORDER) {
      expect(nextRefinementPhase(p, parked({ moving: true }))).toBe('moving');
    }
  });

  it('enters coverage on settle (from moving)', () => {
    // Just parked, still inside the settle window, coverage not yet complete.
    const next = nextRefinementPhase('moving', parked({ msSinceSettle: 0, coverageComplete: false, centralRefined: false }));
    expect(next).toBe('coverage');
  });

  it('does NOT advance past coverage on elapsed time alone', () => {
    // Well past the settle window, but coverage is not reported complete.
    const next = nextRefinementPhase('coverage', parked({ coverageComplete: false, centralRefined: false }));
    expect(next).toBe('coverage');
  });

  it('advances coverage → center-refine only when covered AND past the settle window', () => {
    // Covered but still inside the settle window → hold.
    expect(
      nextRefinementPhase('coverage', parked({ msSinceSettle: SETTLE - 1, coverageComplete: true, centralRefined: false })),
    ).toBe('coverage');
    // Covered and past the window → advance.
    expect(
      nextRefinementPhase('coverage', parked({ msSinceSettle: SETTLE + 1, coverageComplete: true, centralRefined: false })),
    ).toBe('center-refine');
  });

  it('advances center-refine → full-refine only when centrally refined', () => {
    expect(nextRefinementPhase('center-refine', parked({ centralRefined: false }))).toBe('center-refine');
    expect(nextRefinementPhase('center-refine', parked({ centralRefined: true }))).toBe('full-refine');
  });

  it('holds full-refine while parked', () => {
    expect(nextRefinementPhase('full-refine', parked())).toBe('full-refine');
  });
});

describe('phase scales are monotonic coarse → fine', () => {
  it('DPR scale never decreases along the phase order and ends at full', () => {
    let prev = 0;
    for (const p of REFINEMENT_PHASE_ORDER) {
      const s = phaseDprScale(p);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s).toBeGreaterThan(0);
      prev = s;
    }
    expect(phaseDprScale('full-refine')).toBe(1);
  });

  it('selection factor never decreases along the phase order and ends at full', () => {
    let prev = 0;
    for (const p of REFINEMENT_PHASE_ORDER) {
      const s = phaseSelectionFactor(p);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s).toBeGreaterThan(0);
      prev = s;
    }
    expect(phaseSelectionFactor('full-refine')).toBe(1);
  });
});

describe('centerWeight', () => {
  it('is 1 at the exact center', () => {
    expect(centerWeight(0, 0, 1, 1)).toBe(1);
  });
  it('is 0 at/after the edge', () => {
    expect(centerWeight(1, 0, 1, 1)).toBe(0);
    expect(centerWeight(2, 2, 1, 1)).toBe(0);
  });
  it('decreases with distance from center', () => {
    const near = centerWeight(0.2, 0, 1, 1);
    const far = centerWeight(0.6, 0, 1, 1);
    expect(near).toBeGreaterThan(far);
  });
  it('respects the aspect weights', () => {
    // A wide viewport (wx=2) makes the same projX count as nearer the center.
    expect(centerWeight(1, 0, 2, 1)).toBeCloseTo(0.5, 10);
  });
  it('guards non-positive / non-finite aspect weights', () => {
    expect(centerWeight(0, 0, 0, Number.NaN)).toBe(1);
  });
});
