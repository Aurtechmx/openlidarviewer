#!/usr/bin/env node
/**
 * lint-inline-imports.mjs
 *
 * Guards the class of bug that broke the deployed v0.5.0 build and returned in
 * v0.6.6: a runtime dynamic `import('./…')` written inside a module the live
 * source transform rewrites.
 *
 * That transform's `stringArray` pass turns string literals into string-array
 * lookups, the import specifier among them. Once the specifier is no longer a
 * literal, Rolldown cannot analyse the import, the split chunk is never
 * emitted, and the call 404s at runtime in the deployed build only. In v0.6.6
 * that reached the stale-chunk handler, which reloaded the page, so a finished
 * terrain analysis looked like a crash back to the start screen.
 *
 * The fix at every call site is the same: put the `import()` in
 * `src/lazyChunks.ts`, which the transform excludes, and call the exported
 * loader.
 *
 * DETECTION PARSES, it does not text-match. Three line-based patterns each
 * missed a real form:
 *   - the original matched only `await import(…)` and `import(…).then(`, so a
 *     bare `import('./x')` inside a `Promise.all([...])` array was invisible;
 *   - widening it to any `import('./x')` swept in type positions;
 *   - exempting type positions by a trailing `.` also exempted
 *     `import('./x').then(…)`, the very form the original caught, and a
 *     specifier split across lines defeated all three.
 * The parser here is the one the bundler itself uses, so the question the lint
 * asks is the question the build answers: an `ImportExpression` with a literal
 * source is a runtime import, while `typeof import('./x')` and
 * `import('./x').Foo` parse as `TSImportType`, are erased before emit, and are
 * skipped with their subtree.
 *
 * Usage: `node scripts/lint-inline-imports.mjs`
 * (also wired as `npm run lint:inline-imports` and into `test:release` + CI).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';
import { parseSync } from 'rolldown/experimental';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');
const ROOT = resolve(HERE, '..');

/**
 * Files the live source transform does NOT touch, so an import literal inside
 * them survives to the bundler. Mirrors `vite.config.ts`'s `exclude`, including
 * the worker set the registry derives, so the two cannot drift: a module
 * dropped from the build's exclude list starts being checked here.
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

/** Every `.ts` under `dir` that the transform will rewrite. */
export function transformedFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...transformedFiles(p));
    else if (entry.name.endsWith('.ts') && !EXCLUDED.some((r) => r.test(p))) out.push(p);
  }
  return out;
}

/**
 * Runtime dynamic imports of a RELATIVE specifier in `source`.
 *
 * Returns `{ line, specifier, text }` per offender, 1-based lines. A bare
 * `import(someVariable)` is not reported: it carries no literal for the
 * transform to scramble. A package specifier (`import('three')`) is not
 * relative and is resolved by the bundler from the import map, so it is safe.
 */
export function findRuntimeRelativeImports(source, fileName = 'file.ts') {
  const parsed = parseSync(fileName, source);
  const root = parsed.program ?? parsed;
  const lineOf = (offset) => source.slice(0, offset).split('\n').length;
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    // A type, erased before emit, so it never reaches the bundler. Skipping the
    // whole subtree also keeps its inner literal from being reported.
    if (node.type === 'TSImportType') return;
    if (node.type === 'ImportExpression') {
      const src = node.source;
      const specifier = src && typeof src.value === 'string' ? src.value : null;
      // A non-literal specifier carries nothing for the transform to scramble.
      // A package specifier is resolved from the import map, not the file tree.
      if (specifier && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        found.push({
          line: lineOf(node.start ?? 0),
          specifier,
          text: source.slice(node.start ?? 0, node.end ?? 0).replace(/\s+/g, ' ').slice(0, 90),
        });
      }
    }
    for (const key in node) {
      if (key === 'type' || key === 'parent') continue;
      walk(node[key]);
    }
  };
  walk(root);
  return found;
}

// Run the scan only when invoked as a command. Importing this module (the
// regression tests import `findRuntimeRelativeImports`) must not scan the tree
// or call process.exit.
const INVOKED_DIRECTLY =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (INVOKED_DIRECTLY) {
  const offenders = [];
  for (const file of transformedFiles(SRC)) {
  for (const hit of findRuntimeRelativeImports(readFileSync(file, 'utf8'), file)) {
    offenders.push({ file: relative(ROOT, file), ...hit });
  }
  }

  if (offenders.length === 0) {
  console.log(
    'lint:inline-imports OK — no runtime dynamic import of a relative specifier in any transformed module',
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
  console.error(`  ${o.file}:${o.line}: ${o.text}`);
  }
  console.error('');
  console.error('Fix: add a loader to src/lazyChunks.ts, e.g.');
  console.error("  export const loadThing = () => import('./ui/Thing');");
  process.exit(1);
}
