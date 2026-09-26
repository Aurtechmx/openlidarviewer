/**
 * intakeRecoveryHeldout.test.ts: the pre-registered held-out evaluation of
 * phase C recovery, read from its recorded result.
 *
 * The held-out split is run ONCE per candidate release of the recovery code,
 * by setting INTAKE_HELDOUT_RECORD=<commit> (the commit holding the recovery
 * code under test). That run writes validation/intake-corpus/results/
 * <date>-<commit>.json and refuses to overwrite an existing result. Every other
 * run only re-checks the recorded file: its arithmetic against criteria.json,
 * and that a FAIL keeps the recovery out of the application.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scoreSplit, evaluate, type SampleOutcome, type CriteriaVerdict } from './helpers/intakeRecoveryScore';

const DIR = join(__dirname, '..', 'validation', 'intake-corpus');
const RESULTS = join(DIR, 'results');
const criteria = JSON.parse(readFileSync(join(DIR, 'criteria.json'), 'utf8'));

const record = process.env.INTAKE_HELDOUT_RECORD;
if (record) {
  const file = join(RESULTS, `2026-09-25-${record}.json`);
  if (existsSync(file)) throw new Error(`${file} exists: the held-out split is run once per candidate`);
  const t0 = Date.now();
  const outcomes = scoreSplit('heldout');
  const v = evaluate(outcomes, criteria.thresholds);
  writeFileSync(file, JSON.stringify({
    schema: 'olv.intake-corpus.result/1',
    criteria: 'validation/intake-corpus/criteria.json',
    criteriaSha256: JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')).committedFiles['criteria.json'],
    split: 'heldout',
    recoveryCommit: record,
    recoveryModule: 'src/io/probe/recover/recoverPointRecords.ts',
    runOn: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    verdict: v.verdict,
    summary: v,
    falsePositives: outcomes.filter((o) => o.label === 'negative' && o.offered).map((o) => o.id),
    coordinateFailures: outcomes.filter((o) => o.label === 'positive' && o.offered && !(o.coordinateError != null && o.coordinateError <= criteria.thresholds.offeredCoordinateRelativeErrorMax)).map((o) => ({ id: o.id, coordinateError: o.coordinateError, layoutMismatch: o.layoutMismatch })),
    samples: outcomes,
  }, null, 2) + '\n');
}

const files = existsSync(RESULTS) ? readdirSync(RESULTS).filter((f) => f.endsWith('.json')).sort() : [];

describe('held-out evaluation of point-record recovery', () => {
  it('has a recorded result', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    const r = JSON.parse(readFileSync(join(RESULTS, f), 'utf8')) as { verdict: string; summary: CriteriaVerdict; samples: SampleOutcome[]; falsePositives: string[]; recoveryModule: string };
    it(`${f}: the recorded verdict follows from its per-sample outcomes`, () => {
      expect(r.samples.length).toBe(r.summary.positives + r.summary.negatives);
      expect(r.summary.positives).toBeGreaterThanOrEqual(criteria.minimumHeldOutSize.positives);
      expect(r.summary.negatives).toBeGreaterThanOrEqual(criteria.minimumHeldOutSize.negatives);
      const again = evaluate(r.samples, criteria.thresholds);
      expect(again).toEqual(r.summary);
      expect(r.verdict).toBe(again.verdict);
      expect(r.falsePositives).toEqual(r.samples.filter((s) => s.label === 'negative' && s.offered).map((s) => s.id));
    });
    it(`${f}: a failed evaluation keeps the recovery out of the application`, () => {
      if (r.verdict === 'PASS') return;
      const reg = JSON.parse(readFileSync(join(__dirname, '..', 'docs', 'validation', 'unreachable-modules.json'), 'utf8'));
      expect(reg.modules.map((m: { path: string }) => m.path)).toContain(r.recoveryModule);
    });
  }
});
