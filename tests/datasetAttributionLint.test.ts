/**
 * datasetAttributionLint.test.ts: attribution-required datasets with committed
 * derived files are credited in the notices and on the credits page.
 *
 * lint-dataset-citations: synthetic-ids
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain .mjs script, no types
import { collectAttributionProblems } from '../scripts/lint-dataset-attribution.mjs';

const yaml = `datasets:
  - datasetId: OLV-DS-900-EXAMPLE-CCBY
    redistribution: attribution-required
  - datasetId: OLV-DS-901-EXAMPLE-PD
    redistribution: permitted
`;

describe('lint:dataset-attribution', () => {
  it('passes when the dataset is credited in both places', () => {
    const files = ['validation/real-scene/x/OLV-DS-900.json'];
    expect(collectAttributionProblems({ yaml, files, notices: 'OLV-DS-900', credits: 'OLV-DS-900' })).toEqual([]);
  });

  it('fails for each place the credit is missing', () => {
    const files = ['validation/real-scene/x/OLV-DS-900.json'];
    const problems = collectAttributionProblems({ yaml, files, notices: '', credits: 'OLV-DS-900' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/THIRD_PARTY_NOTICES/);
  });

  it('ignores datasets with no committed derivative, and permissive ones', () => {
    const files = ['validation/real-scene/x/OLV-DS-901.json', 'validation/other/OLV-DS-9000.json'];
    expect(collectAttributionProblems({ yaml, files, notices: '', credits: '' })).toEqual([]);
  });
});
