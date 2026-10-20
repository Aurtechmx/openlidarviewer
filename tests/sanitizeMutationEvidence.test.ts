/**
 * The mutation workflow commits an evidence file made by a job that ran the
 * repository's code. It is rebuilt from known, type-checked fields first.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error — plain .mjs script, no types
import { sanitizeMutationEvidence } from '../scripts/sanitize-mutation-evidence.mjs';

const committed = JSON.parse(readFileSync(new URL('../docs/validation/mutation-evidence.json', import.meta.url), 'utf8'));

describe('sanitizeMutationEvidence', () => {
  it('keeps the committed evidence exactly', () => {
    expect(JSON.stringify(sanitizeMutationEvidence(committed), null, 2)).toBe(JSON.stringify(committed, null, 2));
  });

  it('drops unknown fields and malformed values', () => {
    const out = sanitizeMutationEvidence({
      ...committed,
      extra: '<script>',
      workflowRunUrl: 'https://evil.example/actions/runs/1',
      mutate: ['src/a.ts', '../../etc/passwd', 'README.md'],
      commit: 'not-a-sha',
      mutants: { killed: 3, survived: -1, injected: 9 },
    });
    expect(out).not.toHaveProperty('extra');
    expect(out).not.toHaveProperty('workflowRunUrl');
    expect(out).not.toHaveProperty('commit');
    expect(out.mutate).toEqual(['src/a.ts']);
    expect(out.mutants).toEqual({ killed: 3 });
  });

  it('refuses evidence without a score from 0 to 100', () => {
    for (const bad of [null, [], {}, { score: 'x' }, { score: Number.NaN }, { score: 101 }]) {
      expect(() => sanitizeMutationEvidence(bad)).toThrow();
    }
  });
});
