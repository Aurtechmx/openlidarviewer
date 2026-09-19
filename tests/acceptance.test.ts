import { describe, it, expect } from 'vitest';
import {
  ACCEPTANCE_METRICS,
  compare,
  verdict,
  regressions,
  unmeasured,
  table,
  type Samples,
} from './quality/acceptance';

const all = (baseline: number, candidate: number): Samples =>
  Object.fromEntries(ACCEPTANCE_METRICS.map((m) => [m.key, { baseline, candidate }]));

const withOverride = (base: Samples, key: string, v: { baseline: number | null; candidate: number | null }): Samples => ({
  ...base,
  [key]: v,
});

describe('the comparison', () => {
  it('fixes the columns, so a later run cannot drop the one it did badly on', () => {
    expect(ACCEPTANCE_METRICS.map((m) => m.key)).toEqual([
      'gpuFrameMs',
      'attributeBytes',
      'submittedPoints',
      'directCoverage',
      'finalCoverage',
      'temporalVariance',
      'edgeLeakage',
      'settleMs',
    ]);
  });

  it('judges each metric by its own direction', () => {
    const rows = compare({
      gpuFrameMs: { baseline: 20, candidate: 15 },
      directCoverage: { baseline: 0.5, candidate: 0.8 },
    }, ACCEPTANCE_METRICS.filter((m) => m.key === 'gpuFrameMs' || m.key === 'directCoverage'));
    expect(rows.map((r) => r.movement)).toEqual(['better', 'better']);
  });

  it('calls a rise in frame time worse and a rise in coverage better', () => {
    const rows = compare({
      gpuFrameMs: { baseline: 15, candidate: 20 },
      directCoverage: { baseline: 0.8, candidate: 0.5 },
    }, ACCEPTANCE_METRICS.filter((m) => m.key === 'gpuFrameMs' || m.key === 'directCoverage'));
    expect(rows.map((r) => r.movement)).toEqual(['worse', 'worse']);
  });
});

describe('the verdict', () => {
  it('graduates a candidate that improved everything', () => {
    const rows = compare(all(10, 5));
    expect(verdict(rows)).toBe('refuse'); // coverage metrics fell, so not clean
    const better: Samples = Object.fromEntries(
      ACCEPTANCE_METRICS.map((m) => [
        m.key,
        m.direction === 'lower-is-better' ? { baseline: 10, candidate: 5 } : { baseline: 5, candidate: 10 },
      ]),
    );
    expect(verdict(compare(better))).toBe('graduate');
  });

  it('graduates a candidate that changed nothing', () => {
    expect(verdict(compare(all(10, 10)))).toBe('graduate');
  });

  // The line the programme draws: a feature does not graduate because it is
  // visually interesting. One regression is enough to stop it, whatever else
  // improved, so the trade lands in front of a person.
  it('never graduates a candidate that made something worse', () => {
    const better: Samples = Object.fromEntries(
      ACCEPTANCE_METRICS.map((m) => [
        m.key,
        m.direction === 'lower-is-better' ? { baseline: 10, candidate: 1 } : { baseline: 1, candidate: 10 },
      ]),
    );
    const oneWorse = withOverride(better, 'edgeLeakage', { baseline: 0.01, candidate: 0.4 });
    const rows = compare(oneWorse);
    expect(verdict(rows)).toBe('refuse');
    expect(regressions(rows)).toEqual(['edgeLeakage']);
  });

  it('names every regression, not just the first', () => {
    const rows = compare(
      withOverride(
        withOverride(all(10, 10), 'gpuFrameMs', { baseline: 10, candidate: 30 }),
        'settleMs',
        { baseline: 10, candidate: 40 },
      ),
    );
    expect(regressions(rows)).toEqual(['gpuFrameMs', 'settleMs']);
  });

  // A hole in the evidence is not a result.
  it('is undecided when anything was not measured', () => {
    const rows = compare(withOverride(all(10, 10), 'gpuFrameMs', { baseline: null, candidate: 12 }));
    expect(verdict(rows)).toBe('undecided');
    expect(unmeasured(rows)).toEqual(['gpuFrameMs']);
  });

  it('is undecided rather than refusing when a regression sits beside a hole', () => {
    const rows = compare(
      withOverride(
        withOverride(all(10, 10), 'edgeLeakage', { baseline: 0.01, candidate: 0.4 }),
        'gpuFrameMs',
        { baseline: null, candidate: null },
      ),
    );
    expect(verdict(rows)).toBe('undecided');
  });

  it('is undecided for an empty comparison', () => {
    expect(verdict([])).toBe('undecided');
  });

  // This is the state the programme is in today: nothing measured.
  it('is undecided for every metric this release can produce', () => {
    const nothing: Samples = Object.fromEntries(
      ACCEPTANCE_METRICS.map((m) => [m.key, { baseline: null, candidate: null }]),
    );
    const rows = compare(nothing);
    expect(verdict(rows)).toBe('undecided');
    expect(unmeasured(rows).length).toBe(ACCEPTANCE_METRICS.length);
  });

  it('treats a non-finite measurement as unmeasured rather than as a number', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const rows = compare(withOverride(all(10, 10), 'settleMs', { baseline: 10, candidate: bad }));
      expect(verdict(rows)).toBe('undecided');
    }
  });
});

describe('the table', () => {
  it('renders an unmeasured row rather than omitting it', () => {
    const rows = compare(withOverride(all(10, 10), 'gpuFrameMs', { baseline: null, candidate: null }));
    const text = table(rows);
    expect(text).toContain('| GPU frame | — | — | — |');
    expect(text.split('\n').length).toBe(ACCEPTANCE_METRICS.length + 2);
  });

  it('signs the delta so a direction is readable without the spec', () => {
    const rows = compare(withOverride(all(10, 10), 'settleMs', { baseline: 10, candidate: 40 }));
    expect(table(rows)).toContain('+30');
  });
});
