/**
 * reclassifyRevealsTarget.test.ts
 *
 * A lasso reclassify only edits points the user can currently see — the guard
 * that stops it rewriting points hidden behind a filter. Reclassifying INTO a
 * class the filter hides therefore landed the edit and hid its own result in
 * the same frame: the points vanished, the panel counts still described the
 * classification from before, and the tool read as inert while it was working.
 *
 * The legend is recounted and the target class revealed. The recount runs
 * first, so the row that appears carries a real number rather than the count it
 * had before the edit.
 */
import { describe, it, expect } from 'vitest';
import { afterClassEdit } from '../src/app/classLegendRefresh';
import { reclassifyOutcome } from '../src/ui/reclassifyOutcome';

/** A legend that records what it was told, with a settable hidden set. */
function legend(hidden: readonly number[]) {
  const hiddenSet = new Set(hidden);
  const calls: { counts?: Map<number, number>; sample?: { loaded: number; declared?: number } } = {};
  return {
    hiddenSet,
    calls,
    setClasses(counts: Map<number, number>, sample?: { loaded: number; declared?: number }) {
      calls.counts = counts;
      calls.sample = sample;
    },
    revealClass(code: number): boolean {
      if (!hiddenSet.has(code)) return false;
      hiddenSet.delete(code);
      return true;
    },
  };
}

// Six points: four unclassified, two already class 6 — the shape after a lasso
// turned four code-1 returns into buildings.
const cloud = {
  classification: Uint8Array.from([1, 1, 6, 6, 1, 1]),
  pointCount: 6,
  declaredPointCount: 12,
};

describe('the class legend follows a lasso reclassify', () => {
  it('reveals the target class when the filter was hiding it', () => {
    const l = legend([6]);
    expect(afterClassEdit(l, cloud, 6)).toBe(true);
    expect(l.hiddenSet.has(6), 'the edit stayed invisible').toBe(false);
  });

  it('reports no reveal when the target was already visible', () => {
    expect(afterClassEdit(legend([]), cloud, 6)).toBe(false);
  });

  it('recounts from the edited classification, not the counts before it', () => {
    const l = legend([6]);
    afterClassEdit(l, cloud, 6);
    expect(l.calls.counts?.get(6), 'the revealed row carried a stale count').toBe(2);
    expect(l.calls.counts?.get(1)).toBe(4);
    expect(l.calls.sample).toEqual({ loaded: 6, declared: 12 });
  });

  it('reveals without recounting when the cloud carries no classification', () => {
    const l = legend([6]);
    expect(afterClassEdit(l, { pointCount: 6 }, 6)).toBe(true);
    expect(l.calls.counts).toBeUndefined();
  });
});

describe('the toast says the filter was opened', () => {
  it('names the revealed class after a successful edit', () => {
    const msg = reclassifyOutcome({ changedCount: 4, pointCount: 6 }, 6, true);
    expect(msg).toContain('Reclassified 4 points → class 6.');
    expect(msg).toMatch(/hidden by the class filter/);
  });

  it('stays quiet about the filter when nothing was revealed', () => {
    const msg = reclassifyOutcome({ changedCount: 4, pointCount: 6 }, 6, false);
    expect(msg).toBe('Reclassified 4 points → class 6.');
  });
});
