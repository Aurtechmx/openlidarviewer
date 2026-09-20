import { describe, it, expect } from 'vitest';
import { activePhases, footprintCompensation, PHASES_DRAWN_WHILE } from '../src/render/continuity/movingSubset';
import { temporalPhase, type PhaseCount } from '../src/render/continuity/temporalPhase';
import { REFINEMENT_PHASE_ORDER } from '../src/render/refinementPhase';

const COUNTS: PhaseCount[] = [2, 4, 8];

describe('moving subset', () => {
  // The renderer already drops resolution and halves the node budget while
  // moving. A third reduction on the same frames multiplies with those two and
  // has not been measured, so the shipped default draws everything.
  it.each(COUNTS)('draws every phase by default at k=%i', (k) => {
    expect(activePhases(k)).toEqual(Array.from({ length: k }, (_, i) => i));
  });

  // The record of the decision, which every refinement phase shares. The
  // function cannot consult it, and no longer takes a phase implying it might.
  it.each(REFINEMENT_PHASE_ORDER)('records that %s draws all of them', (refinement) => {
    expect(PHASES_DRAWN_WHILE[refinement]).toBe('all');
  });

  it('is deterministic: the same request gives the same set', () => {
    expect(activePhases(4, 2)).toEqual(activePhases(4, 2));
  });

  // A frame drawing no phase draws no points; one naming more phases than exist
  // names phases no point is assigned to.
  it.each(COUNTS)('clamps the drawn count into [1, k] for k=%i', (k) => {
    for (const asked of [-5, 0, 1, k, k + 3, Number.NaN]) {
      const got = activePhases(k, asked);
      expect(got.length).toBeGreaterThanOrEqual(1);
      expect(got.length).toBeLessThanOrEqual(k);
    }
  });

  it('draws a prefix of the phase numbering, so every drawn phase exists', () => {
    for (const k of COUNTS) {
      for (let n = 1; n <= k; n++) {
        const got = activePhases(k, n);
        expect(got).toEqual([...got].sort((a, b) => a - b));
        for (const p of got) expect(p).toBeLessThan(k);
      }
    }
  });

  // The subset has to select real points, not an empty slice of the cloud.
  it('selects a proportional share of points at k=4', () => {
    const n = 40000;
    const drawn = new Set(activePhases(4, 1));
    let hit = 0;
    for (let i = 0; i < n; i++) if (drawn.has(temporalPhase(i, 0, 4))) hit++;
    expect(Math.abs(hit / n - 0.25)).toBeLessThan(0.01);
  });
});

describe('footprint compensation', () => {
  it('leaves the footprint alone when every phase is drawn', () => {
    for (const k of COUNTS) expect(footprintCompensation(k, k)).toBeCloseTo(1, 12);
  });

  it('leaves the footprint alone at zero strength', () => {
    expect(footprintCompensation(1, 8, 0)).toBeCloseTo(1, 12);
  });

  // Samples on a surface spread over two dimensions, so drawing a quarter of
  // them doubles their mean separation and full compensation is 1/sqrt(f).
  it('restores the covered area at full strength', () => {
    expect(footprintCompensation(1, 4, 1)).toBeCloseTo(2, 12);
    expect(footprintCompensation(2, 8, 1)).toBeCloseTo(2, 12);
    expect(footprintCompensation(1, 2, 1)).toBeCloseTo(Math.SQRT2, 12);
  });

  // Full compensation hides a real gap as readily as a sampling gap, so the
  // default sits below it.
  it('defaults below full compensation', () => {
    expect(footprintCompensation(1, 4)).toBeLessThan(footprintCompensation(1, 4, 1));
    expect(footprintCompensation(1, 4)).toBeGreaterThan(1);
  });

  it('never shrinks a point', () => {
    for (const k of COUNTS)
      for (let n = 1; n <= k; n++)
        for (const s of [0, 0.25, 0.5, 1])
          expect(footprintCompensation(n, k, s)).toBeGreaterThanOrEqual(1);
  });

  it('clamps strength outside [0, 1]', () => {
    expect(footprintCompensation(1, 4, -3)).toBeCloseTo(1, 12);
    expect(footprintCompensation(1, 4, 9)).toBeCloseTo(2, 12);
  });
});
