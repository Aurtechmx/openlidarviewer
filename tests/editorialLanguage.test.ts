/**
 * editorialLanguage.test.ts — the editorial-language guard flags manuscript
 * intent in production code but leaves legitimate scholarly/release references.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations.
import { findEditorialLeaks } from '../scripts/lint-editorial-language.mjs';

describe('findEditorialLeaks', () => {
  it('flags intent-revealing editorial phrases', () => {
    for (const s of [
      '// Publishability: burn the colorbar',
      ' * a paper figure is regenerated',
      ' * the schema for the paper',
      '// publication-quality export',
      '// must not be publishable as perfect',
      '// see the manuscript',
    ]) {
      expect(findEditorialLeaks(s).length, s).toBeGreaterThan(0);
    }
  });

  it('does NOT flag bare words or legitimate references', () => {
    for (const s of [
      ' * Sappington (2007), Journal of Wildlife Management 71(5), doi:10.2193/2005-723',
      "  it('refuses a non-tag ref for publication', () => {",
      '// write the paper trail to the log', // bare "paper", not "paper figure"
      '// publication of the release tag',
    ]) {
      expect(findEditorialLeaks(s), s).toEqual([]);
    }
  });

  it('returns line numbers for each hit', () => {
    const hits = findEditorialLeaks('ok line\n// publishability matters\nok');
    expect(hits).toEqual([{ line: 2, text: '// publishability matters' }]);
  });
});
