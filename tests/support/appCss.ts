// Read the application stylesheet as one string, assembled from the ordered
// section files under src/styles/ in the exact order src/styles/index.ts
// imports them — the same order Vite concatenates them for the build, which is
// the cascade order. The sheet was split from a single src/style.css into
// sections for navigation; tests that assert a CSS contract read it through
// here so they keep seeing edits to those sections after the split.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STYLES_DIR = fileURLToPath(new URL('../../src/styles/', import.meta.url));

/**
 * The section file names, in the order src/styles/index.ts imports them.
 * Parsed from index.ts so this list has a single source of truth: reordering
 * an import here reorders it everywhere, and a section added to src/styles/ but
 * not imported is simply absent (which the partition test then catches).
 */
export const STYLE_ORDER: readonly string[] = (() => {
  const index = readFileSync(`${STYLES_DIR}index.ts`, 'utf8');
  const names = [...index.matchAll(/^import\s+'\.\/([^']+\.css)';/gm)].map((m) => m[1]);
  if (names.length === 0) throw new Error('src/styles/index.ts imports no .css section files');
  return names;
})();

/** One section file's raw text. */
export function readSection(name: string): string {
  return readFileSync(`${STYLES_DIR}${name}`, 'utf8');
}

/**
 * The whole application stylesheet, concatenated from the section files in
 * import order. Byte-identical to the pre-split src/style.css — proved by
 * tests/styleCssPartition.test.ts.
 */
export function readAppCss(): string {
  return STYLE_ORDER.map(readSection).join('');
}
