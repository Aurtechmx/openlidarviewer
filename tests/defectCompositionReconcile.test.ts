/**
 * defectCompositionReconcile.test.ts — the defect registry and the changelog
 * prose that describes it must agree.
 *
 * The defect audit is a frozen event: `defect-registry.json` carries a
 * `registryVersion`, and the composition prose ("Eighteen defects are fixed;
 * twelve were exposed by a validation suite; …") lives in that version's
 * changelog entry, not the newest one. The snapshot builder once read the
 * composition from the NEWEST entry, so once the changelog advanced past the
 * audit the declared figures came back null and a matching registry was reported
 * as a disagreement. This pins the real invariant against the correct entry:
 * every figure the registry derives is stated, in words, by its own-version
 * changelog entry — so adding a defect without updating that prose (or vice
 * versa) fails here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs script, no type declarations.
import { derivedComposition, declaredComposition, changelogEntryForVersion } from '../scripts/validation-snapshot-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');
const registry = JSON.parse(read('validation/defects/defect-registry.json')) as {
  registryVersion: string;
};
const changelog = read('CHANGELOG.md');

describe('defect composition reconciles with its own-version changelog entry', () => {
  it('the registry version has a changelog entry', () => {
    expect(changelogEntryForVersion(changelog, registry.registryVersion)).not.toBeNull();
  });

  it('every derived figure is stated, and matches, in that entry', () => {
    const entry = changelogEntryForVersion(changelog, registry.registryVersion);
    const declared = declaredComposition(entry.body);
    const derived = derivedComposition(registry);
    for (const figure of Object.keys(derived)) {
      expect(declared[figure], `${figure} must be stated in CHANGELOG [${registry.registryVersion}]`).not.toBeNull();
      expect(declared[figure], `${figure} derived vs stated`).toBe(derived[figure]);
    }
  });
});
