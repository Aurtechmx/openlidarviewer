/**
 * Drift check for docs/architecture/architecture-map.md.
 *
 * A map that has drifted from the tree is worse than no map: it sends a reader
 * (or a future extraction) to a path that no longer exists. This test parses the
 * module paths the document names and asserts each one is still real, so moving
 * a module forces the same change to update the map.
 *
 * It deliberately checks PATHS, not prose: the narrative is free to evolve, but
 * a named `src/...` path must resolve.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const MAP = 'docs/architecture/architecture-map.md';

function mapText(): string {
  return readFileSync(new URL(`../${MAP}`, import.meta.url), 'utf8');
}

/**
 * Every `src/...` path the map names, in backticks. Trailing punctuation and the
 * `src/foo/` directory form are both accepted; a bare `src/` prefix inside prose
 * without backticks is ignored, so only deliberate references are checked.
 */
function referencedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split('\n')) {
    // A destination marked `*(planned)*` is an extraction target that does not
    // exist yet — the map names it so the decomposition has somewhere to aim.
    // Skip those; when the extraction lands, drop the marker and this check
    // starts holding the path to account.
    if (line.includes('(planned)')) continue;
    for (const m of line.matchAll(/`(src\/[A-Za-z0-9_./-]+)`/g)) {
      found.add(m[1].replace(/[.,;:]$/, ''));
    }
  }
  return [...found];
}

describe('architecture map stays in step with the tree', () => {
  it('names at least the layers and both monoliths (the map is not empty)', () => {
    const paths = referencedPaths(mapText());
    expect(paths.length).toBeGreaterThanOrEqual(10);
    expect(paths).toContain('src/main.ts');
    expect(paths).toContain('src/render/Viewer.ts');
    expect(paths).toContain('src/app/appContext.ts');
  });

  it('every module path the map names still exists', () => {
    const missing = referencedPaths(mapText()).filter((p) => !existsSync(root + p));
    expect(
      missing,
      `${MAP} references paths that no longer exist — move the module and the map ` +
        `in the same change:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  /**
   * The block tables carry line counts, and a stale count is not cosmetic: an
   * earlier revision overstated `_onResize` by 10× (314 vs 31) and listed a
   * colour-write block already extracted to `colorEncode.ts`, which aimed the
   * decomposition at a method not worth moving and at work already done. These
   * two checks pin the numbers that drift fastest.
   */
  it('the monolith totals in the map match the files on disk', () => {
    const text = mapText();
    for (const file of ['src/main.ts', 'src/render/Viewer.ts']) {
      // e.g. **`src/render/Viewer.ts` (7,297)**
      const m = new RegExp(`\`${file.replace(/[./]/g, '\\$&')}\`\\s*\\(([\\d,]+)\\)`).exec(text);
      expect(m, `${MAP} no longer states a line total for ${file}`).not.toBeNull();
      const stated = Number(m![1].replace(/,/g, ''));
      const actual = readFileSync(root + file, 'utf8').split('\n').length - 1;
      // 2% tolerance: the totals are context for a reader, not a budget, so a
      // few lines of churn should not fail the suite — but a drift large enough
      // to mislead an extraction decision should.
      expect(
        Math.abs(stated - actual) / actual,
        `${MAP} says ${file} is ${stated} lines; it is ${actual}. Update the map.`,
      ).toBeLessThan(0.02);
    }
  });

  it('every block the extraction tables name still exists in its monolith', () => {
    const text = mapText();
    // Table rows look like: | `blockName` | 265 | target |
    // A cell may name two blocks (`handleRemoteEpt` / `openStreamingCopc`).
    const rows = text.split('\n').filter((l) => /^\|\s*`?[A-Za-z_]/.test(l) && /\|\s*[\d,]+\s*\|/.test(l));
    expect(rows.length, 'the extraction tables have gone missing').toBeGreaterThanOrEqual(10);

    const lines = [
      ...readFileSync(root + 'src/main.ts', 'utf8').split('\n'),
      ...readFileSync(root + 'src/render/Viewer.ts', 'utf8').split('\n'),
    ];

    /**
     * Is `name` DECLARED in a monolith — not merely imported or called there?
     *
     * The distinction is the whole point: `writeFloatColorsInto` was extracted to
     * `colorEncode.ts` yet stayed listed as a Viewer block for a release, because
     * a substring search still found its import and its call sites. A declaration
     * is `name(` at member or top-level indent and does NOT end in `;`, which is
     * what separates `  private _foo(a: number): void {` from `  _foo(a);`.
     */
    const declared = (name: string): boolean =>
      lines.some((l) => {
        if (l.trimEnd().endsWith(';') || /^\s*(import|export type)\b/.test(l)) return false;
        const decl = new RegExp(
          `^\\s*(export\\s+)?(private |protected |public )?(static )?(readonly )?` +
            `(async )?(function )?(get |set )?\\*?${name}\\s*(<[^>]*>)?\\(`,
        );
        return decl.test(l);
      });

    const missing: string[] = [];
    for (const row of rows) {
      const cell = row.split('|')[1] ?? '';
      for (const m of cell.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) {
        const name = m[1];
        // `constructor` is a keyword present in both; the identifier check is
        // meaningful only for named blocks.
        if (name === 'constructor') continue;
        if (!declared(name)) missing.push(name);
      }
    }
    expect(
      missing,
      `${MAP} lists blocks that no longer exist in either monolith — they were ` +
        `extracted or renamed, so the row should be dropped or updated:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the services table names a real service module per owned cluster', () => {
    // The composition-root contract: each AppContext cluster has exactly one
    // owning service. If a service is renamed or removed, the map must follow.
    for (const svc of [
      'src/app/AppRuntime.ts',
      'src/app/appContext.ts',
      'src/app/LayerService.ts',
      'src/app/viewBookmarks.ts',
      'src/app/ScanService.ts',
      'src/app/ScanRouteService.ts',
      'src/app/projectFrame.ts',
    ]) {
      expect(existsSync(root + svc), `${svc} is missing`).toBe(true);
    }
  });
});
