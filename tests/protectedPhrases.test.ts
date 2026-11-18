/**
 * protectedPhrases.test.ts: proves scripts/check-protected-phrases.mjs fails
 * when a protected statement is dropped from the app, and passes on the real
 * tree.
 *
 * The check is a pure function of `read(path)` and `list(dir)`, so each failing
 * case builds a small fake tree instead of touching src/.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs script, no types
import { checkProtectedPhrases } from '../scripts/check-protected-phrases.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Entry {
  id: string;
  phrase: string;
  surfaces: string[];
  constant?: string;
  knownUnused?: boolean;
}

const realList = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(resolve(ROOT, rel));
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(rel, n);
      if (statSync(resolve(ROOT, p)).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
};
const realRead = (p: string): string | null => {
  try {
    return readFileSync(resolve(ROOT, p), 'utf8');
  } catch {
    return null;
  }
};

/** A fake tree: a map of path to text. */
function fake(files: Record<string, string>) {
  return {
    read: (p: string): string | null => (p in files ? files[p] : null),
    list: (dir: string): string[] => Object.keys(files).filter((p) => p.startsWith(dir.replace(/\/?$/, '/'))),
  };
}

describe('checkProtectedPhrases', () => {
  it('passes on the current tree', () => {
    const phrases = JSON.parse(readFileSync(resolve(ROOT, 'scripts/protected-phrases.json'), 'utf8')) as Entry[];
    expect(phrases.length).toBeGreaterThan(200);
    expect(checkProtectedPhrases(phrases, realRead, realList).missing).toEqual([]);
  });

  it('fails when a phrase is missing', () => {
    const phrases: Entry[] = [{ id: 'p1', phrase: 'Not survey-grade.', surfaces: ['ui'] }];
    const { read, list } = fake({ 'src/ui/x.ts': "export const a = 'something else';" });
    expect(checkProtectedPhrases(phrases, read, list).missing).toEqual([{ id: 'p1', surface: 'ui' }]);
  });

  it('does not count a phrase that only appears in a comment', () => {
    const phrases: Entry[] = [{ id: 'p1', phrase: 'Not survey-grade.', surfaces: ['ui'] }];
    const { read, list } = fake({
      'src/ui/x.ts': "// Not survey-grade.\n/* Not survey-grade. */\nexport const a = 1;",
    });
    expect(checkProtectedPhrases(phrases, read, list).missing).toEqual([{ id: 'p1', surface: 'ui' }]);
  });

  it('passes when the phrase is present and nothing else is required', () => {
    const phrases: Entry[] = [{ id: 'p1', phrase: 'Not survey-grade.', surfaces: ['ui'] }];
    const { read, list } = fake({ 'src/ui/x.ts': "export const a = 'Not survey-grade.';" });
    expect(checkProtectedPhrases(phrases, read, list).missing).toEqual([]);
  });

  it('fails an export phrase present only in UI code', () => {
    const phrases: Entry[] = [{ id: 'p2', phrase: 'Preview export', surfaces: ['export'] }];
    const { read, list } = fake({ 'src/ui/x.ts': "export const a = 'Preview export';" });
    expect(checkProtectedPhrases(phrases, read, list).missing).toEqual([{ id: 'p2', surface: 'export' }]);
  });

  it('accepts an export phrase outside the UI layer', () => {
    for (const dir of ['src/export/', 'src/report/', 'src/science/', 'src/terrain/contour/']) {
      const phrases: Entry[] = [{ id: 'p2', phrase: 'Preview export', surfaces: ['export'] }];
      const { read, list } = fake({ [`${dir}x.ts`]: "export const a = 'Preview export';" });
      expect(checkProtectedPhrases(phrases, read, list).missing).toEqual([]);
    }
  });

  it('accepts an export phrase in the export panel', () => {
    const phrases: Entry[] = [{ id: 'p2', phrase: 'Preview export', surfaces: ['export'] }];
    const { read, list } = fake({ 'src/ui/ExportPanel.ts': "export const a = 'Preview export';" });
    expect(checkProtectedPhrases(phrases, read, list).missing).toEqual([]);
  });

  it('fails when a protected constant is defined but no longer used', () => {
    const phrases: Entry[] = [
      { id: 'p3', phrase: 'No measurements yet.', surfaces: ['ui'], constant: 'NO_MEASUREMENTS_HINT' },
    ];
    const { read, list } = fake({
      'src/ui/x.ts': "export const NO_MEASUREMENTS_HINT = 'No measurements yet.';",
    });
    expect(checkProtectedPhrases(phrases, read, list).missing).toEqual([{ id: 'p3', surface: 'use' }]);
  });

  it('does not count a comment mention as a use of the constant', () => {
    const phrases: Entry[] = [
      { id: 'p3', phrase: 'No measurements yet.', surfaces: ['ui'], constant: 'NO_MEASUREMENTS_HINT' },
    ];
    const { read, list } = fake({
      'src/ui/x.ts': "export const NO_MEASUREMENTS_HINT = 'No measurements yet.';",
      'src/ui/y.ts': '// NO_MEASUREMENTS_HINT is shown in the panel\nexport const b = 1;',
    });
    expect(checkProtectedPhrases(phrases, read, list).missing).toEqual([{ id: 'p3', surface: 'use' }]);
  });

  it('passes when the constant is referenced elsewhere', () => {
    const phrases: Entry[] = [
      { id: 'p3', phrase: 'No measurements yet.', surfaces: ['ui'], constant: 'NO_MEASUREMENTS_HINT' },
    ];
    const { read, list } = fake({
      'src/ui/x.ts': "export const NO_MEASUREMENTS_HINT =\n  'No measurements yet.';",
      'src/ui/y.ts': 'el.textContent = NO_MEASUREMENTS_HINT;',
    });
    expect(checkProtectedPhrases(phrases, read, list).missing).toEqual([]);
  });

  const useEntry: Entry[] = [
    { id: 'p3', phrase: 'No measurements yet.', surfaces: ['ui'], constant: 'HINT' },
  ];
  const defFile = { 'src/ui/a.ts': "export const HINT = 'No measurements yet.';" };

  it('does not count an import as a use', () => {
    const { read, list } = fake({
      ...defFile,
      'src/ui/b.ts': "import {\n  OTHER,\n  HINT,\n} from './a';\nexport const b = OTHER;",
      'src/ui/c.ts': "import { HINT } from './a';",
    });
    expect(checkProtectedPhrases(useEntry, read, list).missing).toEqual([{ id: 'p3', surface: 'use' }]);
  });

  it('does not count a re-export as a use', () => {
    const { read, list } = fake({ ...defFile, 'src/ui/b.ts': "export { HINT } from './a';" });
    expect(checkProtectedPhrases(useEntry, read, list).missing).toEqual([{ id: 'p3', surface: 'use' }]);
  });

  it('does not count the name inside a string as a use', () => {
    const { read, list } = fake({ ...defFile, 'src/ui/b.ts': 'const s = "HINT";\nconst t = `HINT`;' });
    expect(checkProtectedPhrases(useEntry, read, list).missing).toEqual([{ id: 'p3', surface: 'use' }]);
  });

  it('counts a template interpolation as a use', () => {
    const { read, list } = fake({
      ...defFile,
      'src/ui/b.ts': "import { HINT } from './a';\nel.textContent = `Note: ${HINT}`;",
    });
    expect(checkProtectedPhrases(useEntry, read, list).missing).toEqual([]);
  });

  it('skips the use rule for an entry marked knownUnused', () => {
    const phrases: Entry[] = [
      { id: 'p3', phrase: 'No measurements yet.', surfaces: ['ui'], constant: 'NO_MEASUREMENTS_HINT', knownUnused: true },
    ];
    const { read, list } = fake({
      'src/ui/x.ts': "export const NO_MEASUREMENTS_HINT = 'No measurements yet.';",
    });
    expect(checkProtectedPhrases(phrases, read, list).missing).toEqual([]);
  });

  it('ships only the public fields', () => {
    const phrases = JSON.parse(readFileSync(resolve(ROOT, 'scripts/protected-phrases.json'), 'utf8')) as Record<string, unknown>[];
    const allowed = new Set(['id', 'category', 'phrase', 'surfaces', 'constant', 'knownUnused']);
    for (const p of phrases) for (const k of Object.keys(p)) expect(allowed.has(k)).toBe(true);
  });
});
