/**
 * e57ClaimWording.test.ts — the E57-INGEST claim must state only what the
 * cross-decode test proves: whole-file aggregate (order-independent) agreement
 * per field, plus declared-conformance and committed-sample agreement. The test
 * comment itself records that the sum is order-independent ("same multiset of
 * values per column", not "same value at every index"), so the claim must not
 * assert exact per-point/per-index equality.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const yaml = readFileSync(resolve(ROOT, 'docs/validation/claim-register.yaml'), 'utf8');

function claimBlock(id: string): string {
  const start = yaml.indexOf(`claimId: ${id}`);
  const rest = yaml.slice(start);
  const next = rest.indexOf('\n  - claimId:');
  return next === -1 ? rest : rest.slice(0, next);
}

describe('E57-INGEST claim wording', () => {
  const block = claimBlock('E57-INGEST');

  it('does not overstate exact per-point equality', () => {
    expect(block).not.toMatch(/every point and per-point attribute decoded/i);
  });

  it('states the aggregate, order-independent scope', () => {
    expect(block).toMatch(/aggregate/i);
    expect(block).toMatch(/order-independent/i);
  });

  it('names the conformance and sample legs that the aggregate does not cover', () => {
    expect(block).toMatch(/count\/bounds|declared count|conformance/i);
    expect(block).toMatch(/sample/i);
  });
});
