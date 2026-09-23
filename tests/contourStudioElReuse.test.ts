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

const FILES = [
  '../src/ui/contourStudioLauncher.ts',
  '../src/ui/contourStudioWorkspace.ts',
] as const;

describe('Contour Studio files reuse the shared dom.ts el() helper', () => {
  for (const rel of FILES) {
    const path = rel.replace('../', '');
    it(`${path} imports { el } from './dom' and declares no private el()`, () => {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
      expect(src).toMatch(/import\s*\{\s*el\s*\}\s*from\s*['"]\.\/dom['"]/);
      expect(src).not.toMatch(/function el[<(]/);
    });
  }
});
