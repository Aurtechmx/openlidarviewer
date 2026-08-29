/**
 * claimMethodIds.test.ts — a claim's methodId must name a registered method.
 *
 * claim-register.yaml describes each claim's algorithm in free text
 * (`algorithm:`, `algorithmVersion:`), which is exactly the drift the method
 * registry exists to fix. Claims that run a registered method now carry a
 * machine-readable `methodId:` binding it to the catalogue. This asserts every
 * such binding resolves — a renamed or unregistered method id fails here rather
 * than pointing a scientific claim at a method the registry does not define.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMethodId, methodRef, methodTag } from '../src/science/methodRegistry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const yaml = readFileSync(resolve(ROOT, 'docs/validation/claim-register.yaml'), 'utf8');

function claimMethodIds(): string[] {
  return [...yaml.matchAll(/^\s{4}methodId:\s*(\S+)/gm)].map((m) => m[1]);
}

describe('claim-register methodId bindings', () => {
  it('binds a meaningful number of claims to registered methods', () => {
    expect(claimMethodIds().length).toBeGreaterThanOrEqual(10);
  });

  it('every claim methodId names a registered method', () => {
    const unregistered = claimMethodIds().filter((id) => !isMethodId(id));
    expect(unregistered, `claim methodIds not in the registry: ${unregistered.join(', ')}`).toEqual([]);
  });

  it('every claim methodId resolves to a stable id@version tag', () => {
    for (const id of claimMethodIds()) {
      expect(methodTag(methodRef(id))).toMatch(/^olv\.[a-z0-9.-]+@\d+$/);
    }
  });
});
