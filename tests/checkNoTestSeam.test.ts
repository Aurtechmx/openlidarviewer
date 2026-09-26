/**
 * The build check that keeps the Playwright seam out of shipped bundles. The
 * markers must all be present in the guarded block of src/main.ts, or the check
 * would pass vacuously after a rename.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
// @ts-expect-error untyped build script
import { TEST_SEAM_MARKERS, findTestSeamMarkers } from '../scripts/check-no-test-seam.mjs';

describe('check-no-test-seam', () => {
  it('every marker still names real seam code in src/main.ts', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    for (const m of TEST_SEAM_MARKERS as string[]) expect(main, m).toContain(m);
  });

  it('flags a bundle that mounts the seam and passes one that does not', () => {
    expect(findTestSeamMarkers('window.__OLV_TEST_API__={version:"1"}')).toEqual(['__OLV_TEST_API__']);
    expect(findTestSeamMarkers('console.log("hello")')).toEqual([]);
  });
});
