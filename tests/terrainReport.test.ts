/**
 * terrainReport.test.ts — the harness result schema and its verdict rollup.
 */

import { describe, it, expect } from 'vitest';
import { rollupVerdict, buildReport, renderReport, type LegResult } from '../src/validation/terrainReport';

const leg = (status: LegResult['status'], id = status): LegResult => ({ id, title: `leg ${id}`, status });

describe('rollupVerdict', () => {
  it('FAILs if any leg failed, whatever else is present', () => {
    expect(rollupVerdict([leg('pass'), leg('fail'), leg('skipped')])).toBe('FAIL');
    expect(rollupVerdict([leg('fail')])).toBe('FAIL');
  });

  it('PASSes only when every leg ran and passed', () => {
    expect(rollupVerdict([leg('pass'), leg('pass')])).toBe('PASS');
  });

  it('REVIEWs when nothing failed but a leg was skipped — partial coverage never reads PASS', () => {
    expect(rollupVerdict([leg('pass'), leg('skipped')])).toBe('REVIEW');
    expect(rollupVerdict([leg('skipped')])).toBe('REVIEW');
  });

  it('REVIEWs an empty run — no leg ran, so nothing was proven', () => {
    expect(rollupVerdict([])).toBe('REVIEW');
  });
});

describe('buildReport', () => {
  it('counts each status and carries the caller timestamp verbatim', () => {
    const r = buildReport([leg('pass'), leg('pass'), leg('fail'), leg('skipped')], '2026-08-08T00:00:00Z');
    expect(r.schemaVersion).toBe(1);
    expect(r.generatedAt).toBe('2026-08-08T00:00:00Z');
    expect(r.summary).toEqual({ total: 4, passed: 2, failed: 1, skipped: 1 });
    expect(r.verdict).toBe('FAIL');
  });
});

describe('renderReport', () => {
  it('shows the verdict and, on REVIEW, why coverage was partial', () => {
    const text = renderReport(buildReport([leg('pass'), leg('skipped')], '2026-08-08T00:00:00Z'));
    expect(text).toContain('VERDICT: REVIEW');
    expect(text).toContain('skipped');
  });
  it('prints the per-leg detail line when present', () => {
    const text = renderReport(
      buildReport([{ id: 'a', title: 'DTM vs scipy', status: 'pass', detail: 'rmse=5.0e-5 cells=9979' }], '2026-08-08T00:00:00Z'),
    );
    expect(text).toContain('DTM vs scipy');
    expect(text).toContain('rmse=5.0e-5');
  });
});
