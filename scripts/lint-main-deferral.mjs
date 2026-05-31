#!/usr/bin/env node
/**
 * lint-main-deferral.mjs
 *
 * Guards against the class of bug that broke v0.3.4 at startup: a
 * synchronous `viewer.*` dereference at module top level in `src/main.ts`,
 * fired before the lazy-loaded Viewer chunk has resolved.
 *
 * Every interaction with `viewer.*` that runs at module-load time must be
 * deferred inside a `void viewerLoaded.then(() => { ... })` block (or a
 * function body that only executes after the page has wired up). The
 * declaration of `viewer` itself is exempt, and so are TypeScript type
 * annotations.
 *
 * The check is intentionally heuristic — no AST parser is involved — but
 * the patterns it catches are precisely the patterns that have failed
 * in production. Run from CI in the `build-and-test` job so any
 * regression fails the hard gate before it ships.
 *
 * Usage: `node scripts/lint-main-deferral.mjs`
 * (also wired as `npm run lint:main-deferral`).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_TS = resolve(HERE, '..', 'src', 'main.ts');

const source = readFileSync(MAIN_TS, 'utf8');
const lines = source.split('\n');

// A line is "top level" when it begins at column 0 (no leading whitespace).
// Block contents — function bodies, arrow callbacks, .then() handlers,
// classes, conditionals — all carry at least one level of indentation in
// this codebase (2-space indent throughout), so a column-0 statement is
// reliably module-scope.
const VIEWER_DEREF = /\bviewer\.[A-Za-z_]/;

// Permitted top-level patterns that mention `viewer` without dereferencing
// the lazy instance:
//   - `let viewer: Viewer = null as unknown as Viewer;`  (declaration)
//   - `const viewerLoaded: Promise<Viewer> = ...`        (the promise)
//   - `let viewerReady = false;`                         (init flag)
//   - `import type { Viewer } from './render/Viewer';`   (type import)
//   - `import { ... } from './render/Viewer';`           (value import)
const PERMITTED_DECL =
  /^(let|const|var)\s+(viewer(Loaded|Ready)?)\b/;
const PERMITTED_IMPORT = /^import\s/;
const PERMITTED_TYPE_ANNOT = /^[A-Za-z_$][\w$]*\s*:\s*Viewer\b/;

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

const offenders = [];

for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];

  // Empty lines and comments are never offenders.
  if (raw.trim() === '') continue;
  if (COMMENT_LINE.test(raw)) continue;

  // Only flag column-0 (module-scope) statements.
  if (/^\s/.test(raw)) continue;

  // Strip inline trailing comments so a comment that mentions `viewer.x`
  // on the same line as a real statement doesn't cause a false positive
  // or mask a real offender.
  const codeOnly = raw.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');

  if (PERMITTED_DECL.test(codeOnly)) continue;
  if (PERMITTED_IMPORT.test(codeOnly)) continue;
  if (PERMITTED_TYPE_ANNOT.test(codeOnly)) continue;

  if (VIEWER_DEREF.test(codeOnly)) {
    offenders.push({ line: i + 1, text: raw });
  }
}

if (offenders.length === 0) {
  console.log(
    'lint:main-deferral OK — no top-level `viewer.*` dereferences in src/main.ts',
  );
  process.exit(0);
}

console.error('lint:main-deferral FAILED');
console.error('');
console.error('A top-level `viewer.*` dereference was found in src/main.ts.');
console.error('Because the Viewer chunk is lazy-loaded, `viewer` is null until');
console.error('`viewerLoaded` resolves; any synchronous access at module load');
console.error('throws a TypeError that breaks the entire app at startup.');
console.error('');
console.error('Offenders:');
for (const o of offenders) {
  console.error(`  src/main.ts:${o.line}: ${o.text.trimEnd()}`);
}
console.error('');
console.error('Fix: move the offending line(s) inside a deferred block, for example');
console.error('');
console.error('  void viewerLoaded.then(() => {');
console.error('    viewer.setMeasureListeners({ ... });');
console.error('  });');
console.error('');
process.exit(1);
