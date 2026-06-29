#!/usr/bin/env node
/**
 * lint-inline-imports.mjs
 *
 * Guards against the class of bug that broke the deployed v0.5.0 build: an
 * inline dynamic `import('./…')` specifier written directly in `src/main.ts`.
 *
 * `main.ts` is run through the production obfuscator, whose `stringArray`
 * transform scrambles a FRACTION of string literals — including inline
 * `import()` specifiers — on some builds. A scrambled specifier 404s only on
 * the build where it happened to get mangled ("works in dev, breaks on the one
 * build it scrambles"). The fix is to route every runtime dynamic import
 * through `src/lazyChunks.ts`, which is in the obfuscator `exclude` list, so the
 * specifiers can never be scrambled.
 *
 * This check fails the build if a relative inline `import('./…')` (or
 * `import("../…")`) reappears in `main.ts`. Static `import … from '…'` lines are
 * fine; only the dynamic `import(<relative-specifier>)` form is banned here.
 *
 * Usage: `node scripts/lint-inline-imports.mjs`
 * (also wired as `npm run lint:inline-imports` and into `test:release` + CI).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_TS = resolve(HERE, '..', 'src', 'main.ts');

const source = readFileSync(MAIN_TS, 'utf8');
const lines = source.split('\n');

// A dynamic import of a RELATIVE specifier: import('./x') or import("../y").
// Type-only `import('./x')` in a type position is written as `import(...)` too,
// We must flag only RUNTIME dynamic imports — the ones the obfuscator can
// scramble into a 404. TypeScript also writes `import('./x').Type` in TYPE
// positions (`: import('./x').Foo`, `typeof import('./x')`, `x is import(...)`);
// those are erased at compile time and never emit a runtime import, so they are
// not a hazard and must not trip the guard. A runtime dynamic import in this
// codebase is always either `await import('./…')` or `import('./…').then(`;
// match exactly those two forms.
const INLINE_DYNAMIC_IMPORT =
  /\bawait\s+import\s*\(\s*['"]\.\.?\/|\bimport\s*\(\s*['"]\.\.?\/[^'"]*['"]\s*\)\s*\.then\b/;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

const offenders = [];
for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  if (raw.trim() === '') continue;
  if (COMMENT_LINE.test(raw)) continue;
  const codeOnly = raw.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
  if (INLINE_DYNAMIC_IMPORT.test(codeOnly)) {
    offenders.push({ line: i + 1, text: raw });
  }
}

if (offenders.length === 0) {
  console.log(
    "lint:inline-imports OK — no inline dynamic import('./…') in src/main.ts",
  );
  process.exit(0);
}

console.error('lint:inline-imports FAILED');
console.error('');
console.error("An inline dynamic import('./…') was found in src/main.ts.");
console.error('main.ts is obfuscated; the stringArray pass can scramble the');
console.error('specifier on some builds, producing a live-only 404. Route the');
console.error('import through src/lazyChunks.ts (the obfuscator exclude module)');
console.error('and call the exported loader instead.');
console.error('');
console.error('Offenders:');
for (const o of offenders) {
  console.error(`  src/main.ts:${o.line}: ${o.text.trim()}`);
}
console.error('');
console.error('Fix: add a loader to src/lazyChunks.ts, e.g.');
console.error("  export const loadThing = () => import('./ui/Thing');");
console.error('then import { loadThing } from ./lazyChunks and call loadThing().');
console.error('');
process.exit(1);
