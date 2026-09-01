/**
 * referenceStrategy.test.ts — the reference-coverage reducer, tested as rules
 * rather than against whatever records exist today, plus one assertion that
 * every committed consensus record classifies and is test-backed.
 *
 * scripts/lint-reference-strategy.mjs is the gate; scripts/lib/referenceCoverage.mjs
 * is the pure reducer it runs. These cases pin the verdict-class derivation
 * (exploratory -> METHOD_SENSITIVITY, a truth leg -> PASS_TRUTH, matched-only ->
 * PASS_REPLICATION, nothing -> unclassified) and the tool/reference extraction,
 * so the meaning of the coverage matrix is fixed independent of the repository's
 * current contents.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs script, no types
import { buildCoverage, coverageSummary, deriveVerdictClass } from '../scripts/lib/referenceCoverage.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'validation/oracle-consensus');
const TESTS = resolve(ROOT, 'tests');

const truthRecord = {
  contract: { id: 'x', quantity: 'terrain.slope' },
  oracles: [
    { id: 'analytic', referenceClass: 'analytic-truth', tool: 'closed form atan(1)' },
    { id: 'gdal', referenceClass: 'matched-implementation', tool: 'GDAL 3.13.3 gdaldem slope' },
  ],
};

const matchedOnlyRecord = {
  contract: { id: 'y', quantity: 'crs.utm-projection' },
  oracles: [
    { id: 'proj', referenceClass: 'matched-implementation', tool: 'PROJ 9.8.1 cs2cs' },
    { id: 'gl', referenceClass: 'matched-implementation', tool: 'GeographicLib 2.7 GeoConvert' },
  ],
};

const exploratoryRecord = {
  contract: { id: 'z', quantity: 'ground.classification.f1' },
  evidenceRole: 'exploratory',
  scenes: [
    { id: 'S1', olvF1: 0.8, referenceF1: { smrf: 0.86, csf: 0.95, pmf: 0.87 } },
    { id: 'S2', olvF1: 0.9, referenceF1: { smrf: 0.93, csf: 0.94, pmf: 0.95 } },
  ],
};

const casesRecord = {
  contract: { id: 'c', quantity: 'terrain.aspect' },
  cases: [
    {
      oracles: [
        { id: 'analytic', referenceClass: 'analytic-truth', tool: 'closed form' },
        { id: 'grass', referenceClass: 'matched-implementation', tool: 'GRASS 8.5.0 r.slope.aspect' },
      ],
    },
  ],
};

describe('deriveVerdictClass', () => {
  it('exploratory record -> METHOD_SENSITIVITY', () => {
    expect(deriveVerdictClass(exploratoryRecord)).toBe('METHOD_SENSITIVITY');
  });
  it('record with an analytic-truth leg -> PASS_TRUTH', () => {
    expect(deriveVerdictClass(truthRecord)).toBe('PASS_TRUTH');
    expect(deriveVerdictClass(casesRecord)).toBe('PASS_TRUTH');
  });
  it('matched implementations only -> PASS_REPLICATION', () => {
    expect(deriveVerdictClass(matchedOnlyRecord)).toBe('PASS_REPLICATION');
  });
  it('no truth, no matched, not exploratory -> null (unclassifiable)', () => {
    expect(deriveVerdictClass({ contract: { quantity: 'q' }, oracles: [] })).toBeNull();
  });
});

describe('buildCoverage', () => {
  const coverage = buildCoverage([
    { file: 'slope.consensus.json', record: truthRecord },
    { file: 'crs.consensus.json', record: matchedOnlyRecord },
    { file: 'ground.consensus.json', record: exploratoryRecord },
  ]);

  it('is sorted by quantity', () => {
    expect(coverage.map((r: { quantity: string }) => r.quantity)).toEqual([
      'crs.utm-projection',
      'ground.classification.f1',
      'terrain.slope',
    ]);
  });

  it('extracts external tools from oracle tool leaders, dropping the closed-form leg', () => {
    const slope = coverage.find((r: { quantity: string }) => r.quantity === 'terrain.slope');
    expect(slope.externalTools).toEqual(['GDAL']);
    const crs = coverage.find((r: { quantity: string }) => r.quantity === 'crs.utm-projection');
    expect(crs.externalTools).toEqual(['GeographicLib', 'PROJ']);
  });

  it('reads exploratory tools from referenceF1 keys', () => {
    const ground = coverage.find((r: { quantity: string }) => r.quantity === 'ground.classification.f1');
    expect(ground.externalTools).toEqual(['csf', 'pmf', 'smrf']);
    expect(ground.referenceClasses).toContain('exploratory-reference');
  });

  it('summary counts by verdict class', () => {
    const summary = coverageSummary(coverage);
    expect(summary.total).toBe(3);
    expect(summary.byVerdictClass).toEqual({
      PASS_TRUTH: 1,
      PASS_REPLICATION: 1,
      METHOD_SENSITIVITY: 1,
    });
  });
});

describe('committed consensus records', () => {
  const files = existsSync(DIR)
    ? readdirSync(DIR).filter((f) => f.endsWith('.consensus.json'))
    : [];

  it('there is at least one committed record to cover', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every committed record classifies, names a reference, and has a backing test on disk', () => {
    const records = files.map((f) => ({
      file: f,
      record: JSON.parse(readFileSync(resolve(DIR, f), 'utf8')),
    }));
    const coverage = buildCoverage(records);
    for (const row of coverage) {
      expect(row.verdictClass, `${row.record} classifies`).not.toBeNull();
      expect(
        row.externalTools.length + row.referenceClasses.length,
        `${row.record} names a reference`,
      ).toBeGreaterThan(0);
      expect(existsSync(resolve(TESTS, row.test)), `tests/${row.test} exists`).toBe(true);
    }
  });
});
