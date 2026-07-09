#!/usr/bin/env node
/**
 * lint-no-ignored-src.mjs
 *
 * A source file that is git-IGNORED compiles fine in the working tree but
 * vanishes from a clean checkout and from the `git archive` the packager ships —
 * so `tsc` passes locally while the released source zip is compile-broken. That
 * exact failure shipped once (`src/build/buildIdentity.ts` matched an unanchored
 * `build` .gitignore entry). This gate makes it impossible to miss again:
 * anything under `src/` that git ignores fails the build.
 *
 * Exit 0 = clean; exit 1 = an ignored source file (prints the paths).
 */
import { execSync } from 'node:child_process';

let ignored = '';
try {
  // Files under src/ that exist on disk but are ignored by .gitignore.
  ignored = execSync('git ls-files --others --ignored --exclude-standard -- src', {
    encoding: 'utf8',
  }).trim();
} catch (e) {
  console.error('lint:no-ignored-src could not run git:', e.message);
  process.exit(1);
}

if (ignored) {
  console.error('lint:no-ignored-src FAILED');
  console.error('');
  console.error('These files under src/ are git-IGNORED — they compile locally but would be');
  console.error('MISSING from a clean checkout and the source zip (breaking typecheck/build):');
  console.error('');
  for (const f of ignored.split('\n')) console.error(`  • ${f}`);
  console.error('');
  console.error('Fix: anchor the offending .gitignore pattern (e.g. `/build` not `build`), then');
  console.error('`git add` the file.');
  process.exit(1);
}

console.log('lint:no-ignored-src OK — no source files under src/ are git-ignored');
