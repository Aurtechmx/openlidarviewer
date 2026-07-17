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
 *   3. CHANGELOG.md has a "## [X.Y.Z]" section, DATED (ISO "## [X.Y.Z] - YYYY-MM-DD",
 *      never "Unreleased"/"In progress" in that section)
 *   4. RELEASE_NOTES_vX.Y.Z.md exists and is finished (no "In progress" /
 *      "Work in progress" placeholder)
 *   5. CITATION.cff `version:` matches, and `date-released:` is present,
 *      ISO-dated, and agrees with the CHANGELOG's release date
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

// 2. README current-release line. The capture accepts semver prereleases
// (e.g. v0.6.0-alpha.1) — a plain [0-9.]* stopped at the hyphen and reported a
// spurious mismatch for any prerelease cut.
const readme = read('README.md');
const m = readme.match(/current release is \*\*v([0-9][0-9A-Za-z.\-]*)\*\*/i);
if (!m) problems.push('README.md has no "current release is **vX.Y.Z**" line to check.');
else if (m[1] !== version) problems.push(`README.md says current release v${m[1]}, expected v${version}.`);

// 3. CHANGELOG section — present, DATED, and not a work-in-progress stub.
const escaped = version.replace(/\./g, '\\.');
const changelog = read('CHANGELOG.md');
const heading = changelog.match(new RegExp(`^## \\[${escaped}\\][^\\n]*`, 'm'));
let changelogDate = null;
if (!heading) {
  problems.push(`CHANGELOG.md has no "## [${version}]" section.`);
} else {
  const dated = heading[0].match(new RegExp(`^## \\[${escaped}\\] - (\\d{4}-\\d{2}-\\d{2})$`));
  if (!dated) problems.push(`CHANGELOG.md "## [${version}]" heading is not ISO-dated ("${heading[0]}") — expected "## [${version}] - YYYY-MM-DD".`);
  else changelogDate = dated[1];
  // The section body (heading to the next "## [") must not be a placeholder.
  const start = changelog.indexOf(heading[0]);
  const next = changelog.indexOf('\n## [', start + heading[0].length);
  const section = changelog.slice(start, next === -1 ? undefined : next);
  const stub = section.match(/unreleased|in progress/i);
  if (stub) problems.push(`CHANGELOG.md "## [${version}]" section still says "${stub[0]}" — date and finish it before release.`);
}

// 4. Release-notes file — must exist and be finished, not a placeholder.
const notesPath = `RELEASE_NOTES_v${version}.md`;
if (!existsSync(resolve(ROOT, notesPath))) {
  problems.push(`${notesPath} is missing.`);
} else {
  const wip = read(notesPath).match(/work in progress|in progress/i);
  if (wip) problems.push(`${notesPath} still says "${wip[0]}" — finish the notes before release.`);
}

// 5. CITATION.cff — version and an ISO date-released that agrees with the changelog.
try {
  const cff = read('CITATION.cff');
  const cffVersion = cff.match(/^version:\s*["']?([^"'\n]+?)["']?\s*$/m);
  if (!cffVersion) problems.push('CITATION.cff has no "version:" field.');
  else if (cffVersion[1] !== version) problems.push(`CITATION.cff version is ${cffVersion[1]}, expected ${version}.`);
  const cffDate = cff.match(/^date-released:\s*["']?([^"'\n]+?)["']?\s*$/m);
  if (!cffDate) problems.push('CITATION.cff has no "date-released:" field.');
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(cffDate[1])) problems.push(`CITATION.cff date-released "${cffDate[1]}" is not an ISO date (YYYY-MM-DD).`);
  else if (changelogDate && cffDate[1] !== changelogDate) problems.push(`CITATION.cff date-released ${cffDate[1]} does not match CHANGELOG's ${changelogDate} for v${version}.`);
} catch {
  problems.push('CITATION.cff missing or unreadable.');
}

// 6. An UNVERSIONED readiness report is a claim about the current tree, so it
// has to name the current version. The v0.5.9 one drifted for exactly this
// reason: nothing checked it, and its filename carried no version to give the
// staleness away. A report for an older release belongs in
// READINESS_REPORT_vX.Y.Z.md, which this check deliberately ignores.
if (existsSync(resolve(ROOT, 'READINESS_REPORT.md'))) {
  const readiness = read('READINESS_REPORT.md');
  const claimed = /^#\s*v([0-9][0-9A-Za-z.\-]*)\s+publication-readiness report/im.exec(readiness);
  if (!claimed) {
    problems.push('READINESS_REPORT.md has no "# vX.Y.Z publication-readiness report" heading to check.');
  } else if (claimed[1] !== version) {
    problems.push(
      `READINESS_REPORT.md describes v${claimed[1]}, expected v${version} — rename it to READINESS_REPORT_v${claimed[1]}.md if it is the record for that release.`,
    );
  }
}

// 7. The service worker names its cache after the release, and its `activate`
// deletes any cache whose name !== that. If the name doesn't move with the app
// version, a returning user's browser never prunes the previous release's
// cached shell — the worker itself says "Bump on every release". It drifted to
// 0.5.9 while the app moved to 0.6 precisely because nothing checked it.
try {
  const sw = read('public/sw.js');
  const swVer = /const\s+VERSION\s*=\s*['"]olv-shell-([^'"]+)['"]/.exec(sw);
  if (!swVer) {
    problems.push("public/sw.js has no \"const VERSION = 'olv-shell-X.Y.Z'\" to check.");
  } else if (swVer[1] !== version) {
    problems.push(
      `public/sw.js cache VERSION is olv-shell-${swVer[1]}, expected olv-shell-${version} — bump it so the previous release's cache is pruned on activate.`,
    );
  }
} catch {
  problems.push('public/sw.js missing or unreadable.');
}

if (problems.length === 0) {
  console.log(`lint:release-sync OK — package, lock, README, changelog (dated ${changelogDate}), notes, CITATION.cff, and the service-worker cache all on v${version}.`);
  process.exit(0);
}

console.error('lint:release-sync FAILED');
console.error('');
console.error(`Release metadata is out of sync with package.json (v${version}):`);
for (const p of problems) console.error(`  • ${p}`);
console.error('');
process.exit(1);
