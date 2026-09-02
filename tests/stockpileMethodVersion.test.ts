/**
 * stockpileMethodVersion.test.ts — pins the area-grid stockpile method at @2.
 *
 * The area-grid estimator changed its reported figure (concave-footprint
 * exclusion; tilted bases evaluated at the clipped-polygon centroid), so the id
 * must not keep producing @1 numbers under the same version. This asserts the
 * registered version and that the method still names its supporting test, so a
 * silent revert of the version stamp fails here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METHOD_REGISTRY, methodTag, methodRef } from '../src/science/methodRegistry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'olv.volume.stockpile-area-grid';

describe('stockpile area-grid method version', () => {
  it('is registered at version 2', () => {
    expect(METHOD_REGISTRY[ID].version).toBe(2);
    expect(methodTag(methodRef(ID))).toBe(`${ID}@2`);
  });

  it('documents the v1 semantics as historical in its summary', () => {
    expect(METHOD_REGISTRY[ID].summary).toMatch(/v1/);
    expect(METHOD_REGISTRY[ID].summary).toMatch(/v2/);
  });

  it('the doc catalogue row carries the same version', () => {
    const doc = readFileSync(resolve(ROOT, 'docs/science/METHOD_REGISTRY.md'), 'utf8');
    const row = doc.split('\n').find((l) => l.includes(`\`${ID}\``));
    expect(row, 'METHOD_REGISTRY.md is missing the area-grid row').toBeDefined();
    expect(row).toMatch(/\|\s*2\s*\|/);
  });

  it('the supporting-test binding still names its area-grid test', () => {
    // Guards that the version bump did not orphan the method→test hop.
    const bindingSrc = readFileSync(resolve(ROOT, 'tests/methodSupportingTests.test.ts'), 'utf8');
    expect(bindingSrc).toMatch(/'olv\.volume\.stockpile-area-grid':\s*\['tests\/stockpileAreaGrid\.test\.ts'\]/);
  });
});
