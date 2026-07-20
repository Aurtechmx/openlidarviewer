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
    ]) {
      expect(existsSync(root + svc), `${svc} is missing`).toBe(true);
    }
  });
});
