/**
 * evidenceRecord.test.ts — the evidence record refuses to describe a build it
 * cannot vouch for.
 *
 * A release record's value is entirely in what it declines to assert. These
 * tests pin the fail-closed rules: a record is only authoritative when it names
 * the tag, was produced on the canonical toolchain, and came from a green run
 * with every bucket accounted for.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, no types
import { buildEvidenceRecord, parseGateStages, parseGateLog, summariseStages, bindMutationEvidence, CANONICAL_NPM, MANDATORY_RELEASE_STAGES, DEFERRED_RELEASE_STAGES } from '../scripts/collect-evidence.mjs';

const BUCKETS = ['unit', 'export', 'terrain', 'ui', 'slow'];
const fullBuckets = () =>
  Object.fromEntries(BUCKETS.map((b) => [b, { passed: 10, skipped: 0, runs: 1 }]));
const allStages = () =>
  Object.fromEntries((MANDATORY_RELEASE_STAGES as string[]).map((s) => [s, 0]));
const RELEASE_COMMIT = 'a'.repeat(40);
const mutationEvidence = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  score: 87.23,
  break: 75,
  mutants: { detected: 164, undetected: 24, scored: 188 },
  commit: RELEASE_COMMIT,
  measuredAt: '2026-07-20T04:00:00.000Z',
  workflow: 'Mutation',
  workflowRunId: '123',
  workflowRunUrl: 'https://github.com/o/r/actions/runs/123',
  ...over,
});

const base = (over: Record<string, unknown> = {}) => ({
  mode: 'release',
  version: '0.6.0-alpha.3',
  commit: 'a'.repeat(40),
  tag: 'v0.6.0-alpha.3',
  buckets: fullBuckets(),
  gateExit: 0,
  bundle: { liveEntryKiB: 713, ceilingKiB: 720 },
  nodeVersion: 'v22.11.0',
  npmVersion: CANONICAL_NPM,
  platform: 'linux-x64',
  generatedAt: '2026-07-22T00:00:00.000Z',
  gateLogSha256: 'b'.repeat(64),
  science: { e4ClaimCount: 2, e4Claims: ['SLOPE-RASTER', 'ASPECT-RASTER'], suppliedReferenceSlots: 2 },
  stages: allStages(),
  mutation: mutationEvidence(),
  ...over,
});

const problems = (over: Record<string, unknown> = {}): string[] =>
  buildEvidenceRecord(base(over)).problems as string[];

describe('buildEvidenceRecord — release mode', () => {
  it('accepts a complete, canonical, tagged, green run', () => {
    const r = buildEvidenceRecord(base());
    expect(r.ok).toBe(true);
    expect(r.record.releaseAuthoritative).toBe(true);
    expect(r.record.releaseChannel).toBe('prerelease');
    expect(r.record.schemaVersion).toBe(3);
    expect(r.record.total).toEqual({ passed: 50, skipped: 0 });
  });

  it('refuses a run that did not exit green', () => {
    expect(problems({ gateExit: 1 }).some((p) => p.includes('green'))).toBe(true);
    expect(buildEvidenceRecord(base({ gateExit: 1 })).record).toBeNull();
  });

  it('refuses when a test bucket produced no tally', () => {
    const b = fullBuckets();
    b.terrain = { passed: 0, skipped: 0, runs: 0 };
    expect(problems({ buckets: b }).some((p) => p.includes('terrain'))).toBe(true);
  });

  it('refuses without a tag, and when the tag does not match the version', () => {
    expect(problems({ tag: null }).some((p) => p.includes('requires a tag'))).toBe(true);
    expect(
      problems({ tag: 'v0.5.9' }).some((p) => p.includes('does not match')),
    ).toBe(true);
  });

  it('refuses evidence produced off the canonical toolchain', () => {
    // This is the v0.6.0-alpha.3 defect: local evidence made on Node 26 while
    // the project and CI pin 22.
    expect(problems({ nodeVersion: 'v26.0.0' }).some((p) => p.includes('Node 22'))).toBe(true);
    expect(problems({ npmVersion: '11.12.1' }).some((p) => p.includes('npm'))).toBe(true);
  });

  it('refuses without a commit', () => {
    expect(problems({ commit: null }).some((p) => p.includes('commit'))).toBe(true);
  });

  it('refuses without a bundle measurement', () => {
    expect(
      problems({ bundle: { liveEntryKiB: null, ceilingKiB: null } })
        .some((p) => p.includes('bundle')),
    ).toBe(true);
  });

  it('refuses an empty or self-contradictory scientific scope', () => {
    // A record that names no E4 claim at all is not a release record; and a
    // count that disagrees with the list it summarises means the register was
    // parsed into two different answers. Neither is a fixed number of claims:
    // pinning that to one made the second E4 promotion look like a defect.
    expect(
      problems({ science: { e4ClaimCount: 0, e4Claims: [], suppliedReferenceSlots: 0 } })
        .some((p) => p.includes('at least one E4')),
    ).toBe(true);
    expect(
      problems({ science: { e4ClaimCount: 3, e4Claims: ['A', 'B'], suppliedReferenceSlots: 2 } })
        .some((p) => p.includes('disagrees with the listed claims')),
    ).toBe(true);
    expect(
      problems({ science: { e4ClaimCount: 2, e4Claims: ['A', 'B'], suppliedReferenceSlots: 2 } })
        .some((p) => p.includes('E4')),
    ).toBe(false);
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const p = problems({ tag: null, commit: null, nodeVersion: 'v26.0.0' });
    expect(p.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses when a mandatory stage never ran', () => {
    const s = allStages();
    delete (s as Record<string, number>).coverage;
    expect(problems({ stages: s }).some((p) => p.includes('coverage') && p.includes('did not run'))).toBe(true);
  });

  it('refuses when a mandatory stage failed', () => {
    const s = allStages();
    (s as Record<string, number>).e2e = 1;
    expect(problems({ stages: s }).some((p) => p.includes('e2e') && p.includes('exited 1'))).toBe(true);
  });

  it('refuses a missing npm version instead of skipping the check', () => {
    // The old guard was `npmVersion && ...`: a machine where `npm --version`
    // failed produced release evidence with no npm assertion at all.
    expect(problems({ npmVersion: null }).some((p) => p.includes('npm'))).toBe(true);
  });

  it('requires the exact canonical Node when one is pinned', () => {
    expect(
      problems({ canonicalNode: '22.17.1', nodeVersion: 'v22.16.0' })
        .some((p) => p.includes('22.17.1')),
    ).toBe(true);
    const ok = buildEvidenceRecord(base({ canonicalNode: '22.17.1', nodeVersion: 'v22.17.1' }));
    expect(ok.ok).toBe(true);
  });

  it('records every stage as passed in the release record', () => {
    const r = buildEvidenceRecord(base());
    for (const s of MANDATORY_RELEASE_STAGES as string[]) {
      expect(r.record.stages[s]).toBe('passed');
    }
  });
});

describe('the deferred mutation stage', () => {
  it('is not mandatory, but is never silently omitted', () => {
    expect(MANDATORY_RELEASE_STAGES as string[]).not.toContain('mutation');
    expect(DEFERRED_RELEASE_STAGES as string[]).toContain('mutation');
    const s = allStages();
    expect((s as Record<string, number>).mutation).toBeUndefined();
    const r = buildEvidenceRecord(base({ stages: s }));
    expect(r.ok).toBe(true);
    // The distinction the contract turns on: absent from the log, present in
    // the record, and named as not-executed rather than left out.
    expect(r.record.stages.mutation).toBe('not-executed');
  });

  it('refuses a release record with no mutation result to stand on', () => {
    const p = problems({ mutation: null });
    expect(p.some((x) => x.includes('no mutation result to stand on'))).toBe(true);
    expect(buildEvidenceRecord(base({ mutation: null })).record).toBeNull();
  });

  it('cites the score, the commit it was measured at, and the run', () => {
    const r = buildEvidenceRecord(base());
    expect(r.record.mutation.score).toBe(87.23);
    expect(r.record.mutation.break).toBe(75);
    expect(r.record.mutation.measuredAtCommit).toBe(RELEASE_COMMIT);
    expect(r.record.mutation.workflowRunUrl).toContain('/actions/runs/123');
    expect(r.record.mutation.coversReleaseCommit).toBe(true);
  });

  it('says so when the measurement is for a different commit', () => {
    const r = buildEvidenceRecord(base({ mutation: mutationEvidence({ commit: 'c'.repeat(40) }) }));
    // Still a valid record — a cited stale figure beats no figure — but it
    // must not read as covering the release commit.
    expect(r.ok).toBe(true);
    expect(r.record.mutation.coversReleaseCommit).toBe(false);
    expect(r.record.mutation.measuredAtCommit).toBe('c'.repeat(40));
    expect(r.record.mutation.note).toContain('does not cover the release commit');
  });

  it('refuses a score under the break threshold', () => {
    expect(
      problems({ mutation: mutationEvidence({ score: 74.9 }) })
        .some((p) => p.includes('below the break threshold')),
    ).toBe(true);
  });

  it('refuses a measurement with no commit or no score', () => {
    expect(
      problems({ mutation: mutationEvidence({ commit: null }) })
        .some((p) => p.includes('names no commit')),
    ).toBe(true);
    expect(
      problems({ mutation: mutationEvidence({ score: null }) })
        .some((p) => p.includes('carries no score')),
    ).toBe(true);
  });

  it('still fails a release when the stage DID run here and failed', () => {
    const s = { ...allStages(), mutation: 1 };
    expect(problems({ stages: s }).some((p) => p.includes('deferred stage "mutation" exited 1'))).toBe(true);
  });

  it('marks it passed when the local one-pass gate ran it inline', () => {
    const s = { ...allStages(), mutation: 0 };
    const r = buildEvidenceRecord(base({ stages: s, mutation: mutationEvidence({ ranInThisGate: true }) }));
    expect(r.record.stages.mutation).toBe('passed');
    expect(r.record.mutation.ranInThisGate).toBe(true);
  });

  it('leaves a development record usable without any mutation measurement', () => {
    const r = buildEvidenceRecord(base({ mode: 'development', tag: null, mutation: null }));
    expect(r.ok).toBe(true);
    expect(r.record.mutation).toBeNull();
  });
});

describe('summariseStages', () => {
  it('translates exit codes and fills in every deferred stage', () => {
    expect(summariseStages({ staticGate: 0, e2e: 3 })).toEqual({
      staticGate: 'passed',
      e2e: 'failed',
      mutation: 'not-executed',
    });
  });

  it('returns null when there are no stages at all', () => {
    expect(summariseStages(null)).toBeNull();
  });
});

describe('bindMutationEvidence', () => {
  it('reports absence only when the caller requires a result', () => {
    expect(bindMutationEvidence(null, RELEASE_COMMIT, { required: false }).problems).toEqual([]);
    expect(bindMutationEvidence(null, RELEASE_COMMIT, { required: true }).problems.length).toBe(1);
  });

  it('does not claim coverage when the release commit is unknown', () => {
    const r = bindMutationEvidence(mutationEvidence(), null, { required: false });
    expect(r.reference.coversReleaseCommit).toBe(false);
  });
});

describe('parseGateStages', () => {
  it('reads stage markers and keeps the last occurrence per name', () => {
    const log = [
      'GATE STAGE staticGate EXIT: 0',
      'noise',
      'GATE STAGE e2e EXIT: 1',
      'GATE STAGE e2e EXIT: 0',
    ].join('\n');
    expect(parseGateStages(log)).toEqual({ staticGate: 0, e2e: 0 });
  });

  it('returns an empty object for a log without markers', () => {
    expect(parseGateStages('Tests 5 passed\nGATE EXIT: 0')).toEqual({});
  });
});

describe('parseGateLog — bucket tallies', () => {
  it('sums the canonical GATE TALLY lines across shards, per bucket', () => {
    const log = [
      'GATE TALLY bucket=unit passed=1010 skipped=4',
      'GATE TALLY bucket=unit passed=1080 skipped=0',
      'GATE TALLY bucket=unit passed=987 skipped=12',
      'GATE TALLY bucket=export passed=616 skipped=0',
      'GATE TALLY bucket=terrain passed=532 skipped=0',
      'GATE TALLY bucket=terrain passed=708 skipped=0',
      'GATE TALLY bucket=ui passed=429 skipped=0',
      'GATE TALLY bucket=slow passed=295 skipped=0',
      'GATE TALLY bucket=slow passed=222 skipped=0',
    ].join('\n');
    const b = parseGateLog(log);
    expect(b.unit).toEqual({ passed: 3077, skipped: 16, runs: 3 });
    expect(b.export).toEqual({ passed: 616, skipped: 0, runs: 1 });
    expect(b.terrain).toEqual({ passed: 1240, skipped: 0, runs: 2 });
    expect(b.slow).toEqual({ passed: 517, skipped: 0, runs: 2 });
  });

  it('prefers the canonical line and ignores the human summary — no double count', () => {
    // This is the CI failure inverted: even with both present, the count is the
    // canonical one exactly once, never canonical + human.
    const log = [
      '──── unit shard 1/1 ────',
      '      Tests  5 passed (5)',
      'GATE TALLY bucket=unit passed=5 skipped=0',
    ].join('\n');
    expect(parseGateLog(log).unit).toEqual({ passed: 5, skipped: 0, runs: 1 });
  });

  it('falls back to the human summary for an older log with no canonical line', () => {
    const log = [
      '> openlidarviewer@0.6.0 test:export',
      '      Tests  616 passed (616)',
    ].join('\n');
    expect(parseGateLog(log).export).toEqual({ passed: 616, skipped: 0, runs: 1 });
  });
});

describe('buildEvidenceRecord — development mode', () => {
  it('marks a local run as NOT authoritative', () => {
    const r = buildEvidenceRecord(base({ mode: 'development', tag: null, nodeVersion: 'v26.0.0' }));
    expect(r.ok).toBe(true);
    expect(r.record.releaseAuthoritative).toBe(false);
    expect(r.record.releaseChannel).toBe('development');
  });

  it('still refuses a red or incomplete local run', () => {
    expect(buildEvidenceRecord(base({ mode: 'development', gateExit: 1 })).ok).toBe(false);
    const b = fullBuckets();
    b.ui = { passed: 0, skipped: 0, runs: 0 };
    expect(buildEvidenceRecord(base({ mode: 'development', buckets: b })).ok).toBe(false);
  });
});
