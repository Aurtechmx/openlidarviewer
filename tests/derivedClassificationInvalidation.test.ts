/**
 * A derive must enter the same invalidation contract as every other
 * classification mutator.
 *
 * `applyDerivedClassification` — the primitive behind both "Classify" and
 * "Fill Unclassified" — replaced a cloud's classification without bumping the
 * edit epoch. Every sibling mutator (swapClassification, reclassifyInPolygon,
 * reclassifyLasso, undoClassification, redoClassification) calls
 * `_markClassificationEdited`, which bumps the epoch, clears the terrain core
 * cache and raises the stale notice. The derive did not, so an auto-classify
 * under an existing DTM left the result on screen presenting itself as current
 * for a classification it was never built from — with no warning at all, which
 * is worse than the manual-edit case that at least showed a caveat.
 *
 * Source-level: instantiating a Viewer needs a GPU device. The defect was a
 * missing call in a specific method, so the method is what to assert.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../src/render/Viewer.ts'), 'utf8');

/** The body of a named method, up to the next method at the same indent. */
function methodBody(name: string): string {
  // Methods may be declared `private`, so match either form.
  let at = SRC.indexOf(`  ${name}(`);
  if (at === -1) at = SRC.indexOf(`  private ${name}(`);
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  const rest = SRC.slice(at);
  const end = rest.indexOf('\n  }\n');
  return rest.slice(0, end === -1 ? 2000 : end);
}

describe('every classification mutator bumps the edit epoch', () => {
  it('applyDerivedClassification marks the classification edited', () => {
    expect(methodBody('applyDerivedClassification')).toMatch(/_markClassificationEdited\(/);
  });

  it('the sibling mutators still do, so the contract is uniform', () => {
    for (const m of ['swapClassification', 'reclassifyInPolygon', 'reclassifyLasso']) {
      expect(methodBody(m), m).toMatch(/_markClassificationEdited\(/);
    }
  });

  it('the bump is what clears the cache and notifies, so it is the single seam', () => {
    // If this ever stops being true, a mutator could "bump" without
    // invalidating anything and the tests above would still pass.
    const mark = methodBody('_markClassificationEdited');
    expect(mark).toMatch(/_classEpochs\.bump\(/);
    expect(mark).toMatch(/onClassificationEdited\?\.\(/);
  });
});
