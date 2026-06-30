#!/usr/bin/env node
/**
 * lint-release-sync.mjs
 *
 * Catches the release-hygiene class that a human review found in v0.5.2: the
 * code was correct but the packaging drifted — package-lock still on the old
 * version, README still naming the previous release, a missing release-notes
 * file. None of those break a build, so only a dedicated guard catches them.
 *
 * Fails (exit 1) unless ALL of these line up with `package.json`'s version:
 *   1. package-lock.json `.version` AND `.packages[""].version`
 *   2. README.md "current release is **vX.Y.Z**"
 *   3. CHANGELOG.md has a "## [X.Y.Z]" section
 *   4. RELEASE_NOTES_vX.Y.Z.md exists
 *
 * Usage: `node scripts/lint-release-sync.mjs` (also `npm run lint:release-sync`,
 * wired into `test:release` and CI).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const version = JSON.parse(read('package.json')).version;
const problems = [];

// 1. package-lock version (both the root and the self-package entry).
try {
  const lock = JSON.parse(read('package-lock.json'));
  const rootV = lock.version;
  const selfV = lock.packages?.['']?.version;
  if (rootV !== version) problems.push(`package-lock.json .version is ${rootV}, expected ${version} — run \`npm install --package-lock-only\`.`);
  if (selfV !== version) problems.push(`package-lock.json .packages[""].version is ${selfV}, expected ${version}.`);
} catch {
  problems.push('package-lock.json missing or unparseable.');
}

// 2. README current-release line.
const readme = read('README.md');
const m = readme.match(/current release is \*\*v([0-9][0-9.]*)\*\*/i);
if (!m) problems.push('README.md has no "current release is **vX.Y.Z**" line to check.');
else if (m[1] !== version) problems.push(`README.md says current release v${m[1]}, expected v${version}.`);

// 3. CHANGELOG section.
if (!new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(read('CHANGELOG.md'))) {
  problems.push(`CHANGELOG.md has no "## [${version}]" section.`);
}

// 4. Release-notes file.
if (!existsSync(resolve(ROOT, `RELEASE_NOTES_v${version}.md`))) {
  problems.push(`RELEASE_NOTES_v${version}.md is missing.`);
}

if (problems.length === 0) {
  console.log(`lint:release-sync OK — package, lock, README, changelog, and notes all on v${version}.`);
  process.exit(0);
}

console.error('lint:release-sync FAILED');
console.error('');
console.error(`Release metadata is out of sync with package.json (v${version}):`);
for (const p of problems) console.error(`  • ${p}`);
console.error('');
process.exit(1);
