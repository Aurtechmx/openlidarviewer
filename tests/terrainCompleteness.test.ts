/**
 * terrainCompleteness.test.ts — quick-win 10. The validation completeness
 * summary, and its critical rule: running everything we ran successfully is NOT
 * the same as running everything we declared.
 */

import { describe, it, expect } from 'vitest';
import { summarizeStudies, rollupVerdict, type StudyResult } from '../src/validation/terrainReport';

const EXPECTED = ['whitesands/scipy', 'whitesands/pdal', 'stream/classification', 'stream/dtm'];

describe('summarizeStudies — did we run everything we declared?', () => {
  it('a fully executed, all-passing universe is complete', () => {
    const results: StudyResult[] = EXPECTED.map((id) => ({ id, status: 'pass' }));
    const s = summarizeStudies(results, EXPECTED);
    expect(s.expected).toBe(4);
    expect(s.executed).toBe(4);
    expect(s.passed).toBe(4);
    expect(s.skipped).toBe(0);
    expect(s.validationUniverseComplete).toBe(true);
    expect(s.missing).toEqual([]);
  });

  it('CRITICAL: all executed studies PASS but one declared study SKIPPED → NOT complete', () => {
    const results: StudyResult[] = [
      { id: 'whitesands/scipy', status: 'pass' },
      { id: 'whitesands/pdal', status: 'pass' },
      { id: 'stream/classification', status: 'pass' },
      { id: 'stream/dtm', status: 'skipped' }, // fixture absent — did not run
    ];
    const s = summarizeStudies(results, EXPECTED);
    expect(s.passed).toBe(3);
    expect(s.failed).toBe(0);
    expect(s.skipped).toBe(1);
    // Every study that RAN passed, yet the universe is not complete.
    expect(s.validationUniverseComplete).toBe(false);
    expect(s.missing).toEqual(['stream/dtm']);
    // And the overall verdict over the executed legs must not read PASS: a
    // skipped leg forces REVIEW, so "all executed passed" never masquerades as
    // a completely validated suite.
    expect(rollupVerdict(results.map((r) => ({ id: r.id, title: r.id, status: r.status })))).toBe('REVIEW');
  });

  it('a declared study entirely ABSENT from the results is also missing (not silently complete)', () => {
    const results: StudyResult[] = [{ id: 'whitesands/scipy', status: 'pass' }];
    const s = summarizeStudies(results, EXPECTED);
    expect(s.executed).toBe(1);
    expect(s.validationUniverseComplete).toBe(false);
    expect(s.missing).toContain('stream/dtm');
    expect(s.missing.length).toBe(3);
  });

  it('a failed executed study still counts as executed — completeness is about coverage, not success', () => {
    const results: StudyResult[] = [
      { id: 'whitesands/scipy', status: 'pass' },
      { id: 'whitesands/pdal', status: 'fail' },
      { id: 'stream/classification', status: 'pass' },
      { id: 'stream/dtm', status: 'pass' },
    ];
    const s = summarizeStudies(results, EXPECTED);
    expect(s.executed).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.validationUniverseComplete).toBe(true); // we ran them all
  });
});
