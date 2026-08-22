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

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');

/**
 * Files the live source transform does NOT touch, so an import literal inside
 * them survives. Mirrors `vite.config.ts`'s `exclude`, including the worker set
 * the registry derives, so the two cannot drift apart: a module dropped from
 * the build's exclude list starts being checked here on the same run.
 */
const EXCLUDED = [
  /node_modules/,
  /lazyChunks\.ts$/,
  /parseBuffer\.ts$/,
  /loaderRegistry\.ts$/,
  /loadFile\.ts$/,
  /loadLas\.ts$/,
  /copcWorkerClient\.ts$/,
  /eptLaszipWorkerClient\.ts$/,
  /terrainCoreWorkerClient\.ts$/,
  /computeTerrainCoreAsync\.ts$/,
  /deriveClassificationWorkerClient\.ts$/,
  /deriveClassificationAsync\.ts$/,
  /lazChunkWorkerClient\.ts$/,
];

/** Every `.ts` under src/ that the transform will rewrite. */
function transformedFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...transformedFiles(p));
    else if (e.name.endsWith('.ts') && !EXCLUDED.some((r) => r.test(p))) out.push(p);
  }
  return out;
}

// A dynamic import of a RELATIVE specifier: import('./x') or import("../y").
// Type-only `import('./x')` in a type position is written as `import(...)` too,
// We must flag only RUNTIME dynamic imports — the ones the obfuscator can
// scramble into a 404. TypeScript also writes `import('./x').Type` in TYPE
// positions (`: import('./x').Foo`, `typeof import('./x')`, `x is import(...)`);
// those are erased at compile time and never emit a runtime import, so they are
// not a hazard and must not trip the guard. A runtime dynamic import in this
// codebase is always either `await import('./…')` or `import('./…').then(`;
// match exactly those two forms.
// Any RUNTIME dynamic import of a relative specifier. The previous pattern
// matched only `await import('./x')` and `import('./x').then(`, so the form
// that shipped broken in v0.6.6 — a bare `import('./x')` inside a
// Promise.all([...]) array — was invisible to it. Type positions are excluded
// below by requiring the call not be followed by a `.` member access on a type.
const INLINE_DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]\.\.?\/[^'"]*['"]\s*\)/;
// Type positions are erased at compile time and emit no runtime import:
// `typeof import('./x')`, `import('./x').Foo`, `x is import('./x').Foo`.
// Only the value-position call reaches the bundler, so only it can be
// scrambled into a 404.
const TYPE_POSITION =
  /\btypeof\s+import\s*\(|\bimport\s*\(\s*['"]\.\.?\/[^'"]*['"]\s*\)\s*\./;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

const offenders = [];
for (const file of transformedFiles(SRC)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    if (COMMENT_LINE.test(raw)) continue;
    const codeOnly = raw.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    if (!INLINE_DYNAMIC_IMPORT.test(codeOnly)) continue;
    if (TYPE_POSITION.test(codeOnly)) continue; // erased at compile time
    offenders.push({ file: relative(resolve(SRC, '..'), file), line: i + 1, text: raw });
  }
}

if (offenders.length === 0) {
  console.log(
    'lint:inline-imports OK — no inline dynamic import of a relative specifier in any transformed module',
  );
  process.exit(0);
}

console.error('lint:inline-imports FAILED');
console.error('');
console.error('A runtime dynamic import of a relative specifier sits in a module the');
console.error('live source transform rewrites. The stringArray pass turns the specifier');
console.error('into a string-array lookup, so the split chunk is never emitted and the');
console.error('call 404s in the deployed build only. Route it through src/lazyChunks.ts,');
console.error('which the transform excludes, and call the exported loader.');
console.error('');
console.error('Offenders:');
for (const o of offenders) {
  console.error(`  ${o.file}:${o.line}: ${o.text.trim()}`);
}
console.error('');
console.error('Fix: add a loader to src/lazyChunks.ts, e.g.');
console.error("  export const loadThing = () => import('./ui/Thing');");
process.exit(1);
