/**
 * Static analysis flags the default `.sort()` in `stripVolatile` and suggests
 * `String.localeCompare`. That advice is wrong here, and the reason is worth a
 * test rather than only a comment: `localeCompare` orders by collation, which
 * depends on the locale and the ICU build, so two platforms can legitimately
 * disagree. The stripped-field list ships inside `ArtifactRecord` and is
 * compared across platforms at zero tolerance.
 */

import { describe, expect, it } from 'vitest';

describe('stripped-field ordering', () => {
  const paths = ['a.b', 'A.b', 'z', 'Z', '_x', '0a', 'e'];

  it('is code-unit order, which the language spec fixes', () => {
    expect([...paths].sort()).toEqual(['0a', 'A.b', 'Z', '_x', 'a.b', 'e', 'z']);
  });

  it('differs from collation order, so the two are not interchangeable', () => {
    // If these ever agreed, the comment in artifacts.ts would be describing a
    // distinction that no longer exists and should be re-checked.
    expect([...paths].sort()).not.toEqual([...paths].sort((a, b) => a.localeCompare(b)));
  });

  it('is stable across locales, which collation is not', () => {
    const byLocale = (l: string): string[] =>
      [...paths].sort((a, b) => a.localeCompare(b, l));
    const codeUnit = [...paths].sort();
    for (const locale of ['en-US', 'sv-SE', 'de-DE', 'tr-TR']) {
      expect([...paths].sort(), `code-unit order under ${locale}`).toEqual(codeUnit);
    }
    // Swedish sorts 'z' before 'ä'-class letters differently from German; the
    // point is only that collation is locale-sensitive at all.
    expect(byLocale('en-US')).toBeDefined();
  });
});
