/**
 * contourStudioElReuse.test.ts
 *
 * OUTPUT-F6: contourStudioLauncher.ts and contourStudioWorkspace.ts each
 * hand-rolled a private `el(tag, { className, text })` that reimplements a
 * strict subset of the shared `el()` exported by src/ui/dom.ts (imported
 * directly by every other DOM-builder file in this audit). A source-text
 * check, in the style of the repo's other structural guards
 * (moduleGraphLint.test.ts, unsafeHtmlGuard.test.ts): both files must import
 * the shared helper and must not redeclare their own.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';

const FILES = [
  '../src/ui/contourStudioLauncher.ts',
  '../src/ui/contourStudioWorkspace.ts',
] as const;

describe('Contour Studio files reuse the shared dom.ts el() helper', () => {
  for (const rel of FILES) {
    const absPath = fileURLToPath(new URL(rel, import.meta.url));
    const path = relative(fileURLToPath(new URL('.', import.meta.url)), absPath);
    it(`${path} imports { el } from './dom' and declares no private el()`, () => {
      const src = readFileSync(absPath, 'utf8');
      expect(src).toMatch(/import\s*\{\s*el\s*\}\s*from\s*['"]\.\/dom['"]/);
      expect(src).not.toMatch(/function el[<(]/);
    });
  }
});
