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
import { buildEvidenceRecord, CANONICAL_NPM } from '../scripts/collect-evidence.mjs';

const BUCKETS = ['unit', 'export', 'terrain', 'ui', 'slow'];
const fullBuckets = () =>
  Object.fromEntries(BUCKETS.map((b) => [b, { passed: 10, skipped: 0, runs: 1 }]));

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
  science: { e4ClaimCount: 1, e4Claims: ['SLOPE-RASTER'], suppliedReferenceSlots: 1 },
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
    expect(r.record.schemaVersion).toBe(2);
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

  it('refuses a scientific scope that is not exactly one E4 claim', () => {
    expect(
      problems({ science: { e4ClaimCount: 2, e4Claims: ['A', 'B'], suppliedReferenceSlots: 2 } })
        .some((p) => p.includes('exactly one E4')),
    ).toBe(true);
    expect(
      problems({ science: { e4ClaimCount: 0, e4Claims: [], suppliedReferenceSlots: 0 } })
        .some((p) => p.includes('exactly one E4')),
    ).toBe(true);
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const p = problems({ tag: null, commit: null, nodeVersion: 'v26.0.0' });
    expect(p.length).toBeGreaterThanOrEqual(3);
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
