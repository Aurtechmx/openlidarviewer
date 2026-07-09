/**
 * scientificAnalysisRecord.test.ts — the canonical record's composition rules.
 *
 * The properties that make the record trustworthy: it resolves method ids
 * against the registry (unknown ids throw), its content fingerprint is STABLE
 * across builds and generation times (so the same analysis of the same data
 * hashes identically) yet CHANGES when the science changes, and it never
 * fabricates a linear unit it was not given.
 */
import { describe, it, expect } from 'vitest';
import {
  buildScientificAnalysisRecord,
  scientificRecordJson,
  SCIENTIFIC_RECORD_SCHEMA,
  type ScientificAnalysisRecordInput,
} from '../src/science/scientificAnalysisRecord';
import type { BuildIdentity } from '../src/build/buildIdentity';

const buildA: BuildIdentity = {
  version: '0.5.8',
  commit: 'aaaaaaa',
  dirty: false,
  builtAt: '2026-07-08T00:00:00.000Z',
  node: 'v22.22.3',
  channel: 'live',
};
const buildB: BuildIdentity = { ...buildA, commit: 'bbbbbbb', builtAt: '2027-01-01T00:00:00.000Z' };

const base: ScientificAnalysisRecordInput = {
  kind: 'terrain-dtm',
  source: 'site.laz',
  crs: {
    horizontal: 'EPSG:32610',
    horizontalKnown: true,
    verticalDatum: 'EPSG:5703',
    verticalDatumKnown: true,
  },
  methodIds: ['olv.ground.smrf', 'olv.validation.spatial-block'],
  evidenceExploratory: true,
  summary: { rmseZM: 0.14, quality: 'Good' },
  generatedAt: '2026-06-05T00:00:00.000Z',
  build: buildA,
};

describe('buildScientificAnalysisRecord', () => {
  it('resolves method ids to id+version refs from the registry', () => {
    const r = buildScientificAnalysisRecord(base);
    expect(r.schemaVersion).toBe(SCIENTIFIC_RECORD_SCHEMA);
    expect(r.methods).toEqual([
      { id: 'olv.ground.smrf', version: 1 },
      { id: 'olv.validation.spatial-block', version: 2 },
    ]);
  });

  it('throws on an unregistered method id (no reference to an undefined method)', () => {
    expect(() =>
      buildScientificAnalysisRecord({ ...base, methodIds: ['olv.ground.smrf', 'olv.ghost'] }),
    ).toThrow(/Unknown method id/);
  });

  it('content fingerprint is STABLE across build and generation time', () => {
    const r1 = buildScientificAnalysisRecord(base);
    const r2 = buildScientificAnalysisRecord({
      ...base,
      build: buildB,
      generatedAt: '2099-12-31T23:59:59.000Z',
    });
    expect(r2.contentHash).toBe(r1.contentHash);
  });

  it('content fingerprint CHANGES when the science changes', () => {
    const r1 = buildScientificAnalysisRecord(base);
    const rMethods = buildScientificAnalysisRecord({ ...base, methodIds: ['olv.ground.smrf'] });
    const rSummary = buildScientificAnalysisRecord({
      ...base,
      summary: { rmseZM: 0.99, quality: 'Good' },
    });
    expect(rMethods.contentHash).not.toBe(r1.contentHash);
    expect(rSummary.contentHash).not.toBe(r1.contentHash);
  });

  it('omits the linear unit when none is supplied (never fabricated)', () => {
    const r = buildScientificAnalysisRecord(base);
    expect(r.crs.linearUnit).toBeUndefined();
    expect(scientificRecordJson(r).crs).not.toHaveProperty('linearUnit');
  });

  it('carries a supplied linear unit through', () => {
    const r = buildScientificAnalysisRecord({
      ...base,
      crs: { ...base.crs, linearUnit: 'us-survey-foot' },
    });
    expect(r.crs.linearUnit).toBe('us-survey-foot');
  });
});

describe('scientificRecordJson', () => {
  it('emits method tags and the fingerprint', () => {
    const j = scientificRecordJson(buildScientificAnalysisRecord(base));
    expect(j.methods).toEqual(['olv.ground.smrf@1', 'olv.validation.spatial-block@2']);
    expect(typeof j.contentHash).toBe('string');
    expect(j.build).toBe('0.5.8 (aaaaaaa)');
  });
});
