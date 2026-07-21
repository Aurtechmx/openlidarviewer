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

import { execSync } from 'node:child_process';
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

// 5b. A release date that predates the code it ships is a stale date.
//
// The version and the changelog agreement were already checked, but nothing
// noticed when `date-released` simply went out of date: a candidate carried
// 2026-07-19 while HEAD was two days newer, so the archive claimed to have
// been released before some of the commits inside it existed. A reviewer
// caught that, not the gate.
//
// Checking "is it today" would be wrong — a genuinely published release has a
// past date forever. What cannot be true is a release date EARLIER than the
// newest commit it contains. Skipped when git is unavailable (building from a
// source archive), where there is nothing to compare against.
try {
  const cff = read('CITATION.cff');
  const cffDate = cff.match(/^date-released:\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*$/m);
  if (cffDate) {
    const headDate = execSync('git log -1 --format=%cs', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(headDate) && cffDate[1] < headDate) {
      problems.push(
        `Release date ${cffDate[1]} predates the newest commit (${headDate}) — the archive would claim `
        + 'to have been released before some of the code in it existed. Set the real publication date '
        + 'in CITATION.cff and CHANGELOG.md before tagging.',
      );
    }
  }
} catch {
  // No git, or no readable CITATION.cff — earlier checks already report the
  // latter, and the former is a legitimate way to build.
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

// 8. The VERSIONED evidence set. Checks 1-7 all watch metadata that carries the
// version in its own text, so drift there is self-announcing. The evidence
// reports are the opposite: each release gets a NEW file, the previous one stays
// on disk, and every prose reference to it keeps resolving — so a stale link is
// silent and points a reviewer at the wrong release's evidence. That is exactly
// what happened at alpha.2: README, AI_ASSISTANCE, ARTIFACT_EVALUATION and the
// docs-site include all still named the alpha.1 validation report.
const EVIDENCE = [
  'VALIDATION_REPORT',
  'KNOWN_LIMITATIONS',
  'REPRODUCIBILITY',
  'READINESS_REPORT',
];
for (const name of EVIDENCE) {
  const path = `${name}_v${version}.md`;
  if (!existsSync(resolve(ROOT, path))) {
    problems.push(`${path} is missing — every release needs its own ${name} file.`);
  }
}

// A docs-site release page per release; the site's release list stops dead
// without one, so the newest release is the one a reader cannot find.
const releasePage = `docs-site/releases/v${version}.md`;
if (!existsSync(resolve(ROOT, releasePage))) {
  problems.push(`${releasePage} is missing — the docs site needs a page for this release.`);
}

// Any prose that names a versioned evidence file must name THIS version's.
// Scanning for the older-version filename is what catches the silent case: the
// link still resolves, so nothing else can notice it is pointing backwards.
const REFERRERS = [
  'README.md',
  'AI_ASSISTANCE.md',
  'ARTIFACT_EVALUATION.md',
  'docs-site/reproducibility/validation-report.md',
];
for (const file of REFERRERS) {
  let text;
  try {
    text = read(file);
  } catch {
    problems.push(`${file} missing or unreadable.`);
    continue;
  }
  for (const name of EVIDENCE) {
    // Every versioned mention of this evidence family in this file...
    const mentions = [...text.matchAll(new RegExp(`${name}_v([0-9][0-9A-Za-z.\\-]*)\\.md`, 'g'))];
    if (mentions.length === 0) continue;
    // ...must include the current one. An older report may still be cited
    // deliberately (alpha.2 inherits terrain evidence from v0.5.9), so the rule
    // is "the current release is named", not "no older release is named".
    if (!mentions.some((m) => m[1] === version)) {
      const seen = [...new Set(mentions.map((m) => m[1]))].join(', ');
      problems.push(
        `${file} cites ${name}_v${seen}.md but never ${name}_v${version}.md — ` +
          `the link still resolves, so it silently sends a reviewer to the wrong release's evidence.`,
      );
    }
  }
}

// 9. The evidence files each restate the same suite totals in their own prose.
// A reviewer receiving three permanent documents that disagree about how many
// tests ran cannot tell which is the record — and unlike a stale link, nothing
// about the wrong number looks wrong. At alpha.2 the validation report carried
// the alpha.1 figures while the reproducibility file carried the current ones,
// and a later fix updated two of the three files, leaving a fresh disagreement.
// So: extract the tuple wherever it appears and require the files to agree.
// The counts are written with thousands separators and followed by varying
// punctuation ("export 567," vs "export 567 ·"), so capture the NUMBER only —
// a greedy [\d,]+ swallows the trailing comma and reports a phantom mismatch
// between two files that actually agree.
const NUM = String.raw`(\d{1,3}(?:,\d{3})*)`;
const COUNT_RE = new RegExp(
  `[Uu]nit ${NUM}[^\\n]*?export ${NUM}[^\\n]*?terrain ${NUM}[^\\n]*?ui ${NUM}[^\\n]*?slow ${NUM}`,
);
const counted = [];
for (const name of EVIDENCE) {
  const path = `${name}_v${version}.md`;
  let text;
  try {
    text = read(path);
  } catch {
    continue; // absence is already reported by check 8
  }
  const m = COUNT_RE.exec(text);
  if (m) counted.push({ path, tuple: m.slice(1, 6).join(' / ') });
}
if (counted.length > 1) {
  const distinct = [...new Set(counted.map((c) => c.tuple))];
  if (distinct.length > 1) {
    problems.push(
      `the v${version} evidence files disagree about the suite totals (unit / export / terrain / ui / slow):\n` +
        counted.map((c) => `      - ${c.path}: ${c.tuple}`).join('\n') +
        `\n    Re-run the buckets and write the SAME measured figures into each.`,
    );
  }
}

if (problems.length === 0) {
  console.log(`lint:release-sync OK — package, lock, README, changelog (dated ${changelogDate}), notes, CITATION.cff, the service-worker cache, and the versioned evidence set all on v${version}.`);
  process.exit(0);
}

console.error('lint:release-sync FAILED');
console.error('');
console.error(`Release metadata is out of sync with package.json (v${version}):`);
for (const p of problems) console.error(`  • ${p}`);
console.error('');
process.exit(1);
