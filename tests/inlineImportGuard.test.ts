/**
 * inlineImportGuard.test.ts — the shapes lint:inline-imports must see.
 *
 * The guard exists because the live source transform rewrites string literals,
 * including a dynamic import specifier. Once it is not a literal the bundler
 * cannot emit the split chunk and the call 404s in the deployed build only. In
 * v0.6.6 that reached the stale-chunk handler, which reloaded the page, so a
 * finished terrain analysis looked like a crash back to the start screen.
 *
 * Three line-based versions of the guard each shipped a hole, and each hole let
 * a real offender through: a bare call inside a Promise.all array, a specifier
 * split across lines, and `.then(…)` exempted as if it were a type. The cases
 * below are those holes, so a future rewrite cannot reopen one silently.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types
import { findRuntimeRelativeImports } from '../scripts/lint-inline-imports.mjs';

const specifiers = (src: string): string[] =>
  (findRuntimeRelativeImports(src, 'probe.ts') as { specifier: string }[]).map((h) => h.specifier);

describe('lint:inline-imports detection', () => {
  it('sees a plain awaited import', () => {
    expect(specifiers("const m = await import('./same-line');")).toEqual(['./same-line']);
  });

  it('sees a specifier split across lines', () => {
    // The form that shipped in sessionIo.ts and passed a line-based guard.
    const src = ["const { a } = await import(", "  '../science/verify'", ");"].join('\n');
    expect(specifiers(src)).toEqual(['../science/verify']);
  });

  it('sees a bare call inside a Promise.all array', () => {
    // The form that shipped in terrainAnalysisRunner.ts and broke every
    // deployed terrain analysis.
    const src = "const [a, b] = await Promise.all([import('./one'), import('../two')]);";
    expect(specifiers(src)).toEqual(['./one', '../two']);
  });

  it('sees the .then form', () => {
    // Exempted by the trailing-dot type heuristic, which is what a type member
    // access also looks like.
    expect(specifiers("import('./then-form').then((m) => m.run());")).toEqual(['./then-form']);
  });

  it('reports the line the call starts on', () => {
    const src = ['const x = 1;', '', "const m = await import('./third-line');"].join('\n');
    const hits = findRuntimeRelativeImports(src, 'probe.ts') as { line: number }[];
    expect(hits.map((h) => h.line)).toEqual([3]);
  });

  it('skips type positions, which are erased before emit', () => {
    expect(specifiers("let t: typeof import('./type-only');")).toEqual([]);
    expect(specifiers("let u: import('./type-member').Foo;")).toEqual([]);
    expect(specifiers("function f(x: unknown): x is import('./guard').T { return true; }")).toEqual(
      [],
    );
  });

  it('skips a package specifier, which the bundler resolves from the import map', () => {
    expect(specifiers("const three = await import('three');")).toEqual([]);
  });

  it('skips a non-literal specifier, which carries nothing to scramble', () => {
    expect(specifiers('const m = await import(chosenPath);')).toEqual([]);
  });

  it('finds every offender in a file rather than stopping at the first', () => {
    const src = [
      "const a = await import('./one');",
      "let t: typeof import('./type');",
      "const b = await import('../two');",
    ].join('\n');
    expect(specifiers(src)).toEqual(['./one', '../two']);
  });
});
