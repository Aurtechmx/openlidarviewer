/**
 * mutationEvidence.test.ts — the score the release record cites is computed,
 * not copied.
 *
 * The mutation figure is now measured somewhere other than the release gate,
 * which makes the arithmetic that produces it part of the evidence chain
 * rather than a detail of a log a human read once. Stryker's denominator is
 * the part that gets misremembered: ignored mutants and compile errors are
 * excluded from BOTH sides, so counting them anywhere moves the score.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, no types
import { scoreReport } from '../scripts/collect-mutation-evidence.mjs';

const report = (statuses: string[]) => ({
  files: { 'src/process/numerics.ts': { mutants: statuses.map((status) => ({ status })) } },
});

describe('scoreReport', () => {
  it('counts killed and timed-out mutants as detected', () => {
    const r = scoreReport(report(['Killed', 'Killed', 'Timeout', 'Survived']));
    expect(r.mutants.detected).toBe(3);
    expect(r.mutants.undetected).toBe(1);
    expect(r.score).toBe(75);
  });

  it('counts NoCoverage against the score, not as an absence', () => {
    // A mutant no test reaches is the strongest evidence of a gap there is.
    // Dropping it from the denominator would let a shrinking suite raise the
    // score.
    expect(scoreReport(report(['Killed', 'NoCoverage'])).score).toBe(50);
  });

  it('excludes ignored and errored mutants from both sides', () => {
    const r = scoreReport(report(['Killed', 'Survived', 'Ignored', 'CompileError', 'RuntimeError']));
    expect(r.score).toBe(50);
    expect(r.mutants.scored).toBe(2);
    expect(r.mutants.ignored).toBe(1);
    expect(r.mutants.errors).toBe(2);
  });

  it('sums across files', () => {
    const r = scoreReport({
      files: {
        a: { mutants: [{ status: 'Killed' }, { status: 'Killed' }] },
        b: { mutants: [{ status: 'Killed' }, { status: 'Survived' }] },
      },
    });
    expect(r.score).toBe(75);
    expect(r.mutants.scored).toBe(4);
  });

  it('returns no score rather than a fabricated one when nothing was scored', () => {
    // 0/0 is not 100 %. A run that mutated nothing must not be reported as
    // a perfect one.
    expect(scoreReport(report(['Ignored'])).score).toBeNull();
    expect(scoreReport({}).score).toBeNull();
  });

  it('rounds to two decimals, the precision the published figure is quoted at', () => {
    expect(scoreReport(report(['Killed', 'Killed', 'Survived'])).score).toBe(66.67);
  });
});
