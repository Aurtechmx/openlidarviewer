/**
 * oracleConsensusFramework.test.ts — the rules of the oracle-triangulation
 * framework, tested as rules rather than against whatever records exist today.
 *
 * The lint (scripts/lint-oracle-consensus.mjs) is what keeps every consensus
 * record contract-shaped and test-backed as families land on separate branches.
 * These cases pin its behaviour: a well-formed triangulation passes, and each
 * way a record can be malformed (no contract, no tolerance, an unknown reference
 * class, a single reference with no truth anchor, an exploratory record without
 * the declaration) is caught.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs script, no types
import { collectRecordProblems, expectedTestName } from '../scripts/lint-oracle-consensus.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const goodTruth = {
  contract: { id: 'x', quantity: 'terrain.slope', absoluteToleranceDeg: 1e-5 },
  oracles: [
    { id: 'analytic', referenceClass: 'analytic-truth', meanSlopeDeg: 45 },
    { id: 'gdal', referenceClass: 'matched-implementation', meanSlopeDeg: 45 },
  ],
};

const goodCases = {
  contract: { id: 'x', quantity: 'terrain.aspect', absoluteToleranceDeg: 0.5 },
  cases: [
    { oracles: [{ id: 'analytic', referenceClass: 'analytic-truth' }, { id: 'gdal', referenceClass: 'matched-implementation' }] },
  ],
};

const goodExploratory = {
  contract: { id: 'x', quantity: 'ground.f1', sensitivityThresholdF1: 0.08 },
  evidenceRole: 'exploratory',
  scenes: [{ id: 'S1', referenceF1: { smrf: 0.9, csf: 0.8, pmf: 0.85 } }],
};

describe('oracle-consensus framework: record rules', () => {
  it('accepts a well-formed triangulation (truth + matched)', () => {
    expect(collectRecordProblems('good.consensus.json', goodTruth)).toEqual([]);
  });

  it('accepts a per-case record', () => {
    expect(collectRecordProblems('good-cases.consensus.json', goodCases)).toEqual([]);
  });

  it('accepts a declared exploratory record with a single reference', () => {
    expect(collectRecordProblems('ground.consensus.json', goodExploratory)).toEqual([]);
  });

  it('rejects a missing contract', () => {
    const p = collectRecordProblems('x.json', { oracles: [] });
    expect(p.some((s: string) => /missing "contract"/.test(s))).toBe(true);
  });

  it('rejects a missing tolerance', () => {
    const p = collectRecordProblems('x.json', { contract: { id: 'x', quantity: 'q' }, oracles: goodTruth.oracles });
    expect(p.some((s: string) => /tolerance/.test(s))).toBe(true);
  });

  it('rejects an unknown referenceClass', () => {
    const bad = { contract: goodTruth.contract, oracles: [{ id: 'z', referenceClass: 'vibes' }] };
    expect(collectRecordProblems('x.json', bad).some((s: string) => /unknown referenceClass/.test(s))).toBe(true);
  });

  it('rejects a single reference with no truth anchor and no exploratory flag', () => {
    const bad = { contract: goodTruth.contract, oracles: [{ id: 'gdal', referenceClass: 'matched-implementation' }] };
    expect(collectRecordProblems('x.json', bad).some((s: string) => /not a triangulation/.test(s))).toBe(true);
  });

  it('maps a record filename to its backing test name', () => {
    expect(expectedTestName('slope-horn.consensus.json')).toBe('oracleConsensusSlope.test.ts');
    expect(expectedTestName('crs-utm.consensus.json')).toBe('oracleConsensusCrs.test.ts');
  });
});

describe('oracle-consensus framework: the committed records obey the rules', () => {
  const dir = resolve(ROOT, 'validation/oracle-consensus');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.consensus.json')) : [];

  it('every present record is contract-shaped and test-backed', () => {
    // Vacuously true until families merge to this branch; enforced per-family in CI.
    for (const f of files) {
      const rec = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
      expect(collectRecordProblems(f, rec), f).toEqual([]);
      expect(existsSync(resolve(ROOT, 'tests', expectedTestName(f))), `${f} backing test`).toBe(true);
    }
  });
});
