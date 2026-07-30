#!/usr/bin/env node
/**
 * sonar-new-findings.mjs — what did the last merge introduce?
 *
 *   node scripts/sonar-new-findings.mjs                  # since the last tag
 *   node scripts/sonar-new-findings.mjs --since v0.6.2
 *   node scripts/sonar-new-findings.mjs --since 2026-07-30T16:00:00Z
 *   node scripts/sonar-new-findings.mjs --since HEAD~5
 *
 * WHY THIS EXISTS. A branch gets verified against the thing it was asked to
 * do, it merges, and nobody looks again. Twice that let a change land on the
 * default branch carrying a defect of a class already fixed elsewhere in the
 * same session: the second time it moved the reliability rating from A to C,
 * and it was noticed only because someone happened to open the dashboard.
 *
 * The gap was never "which rule". It was that verification stopped at the
 * author's own intent. Checking a change against what it meant to do says
 * nothing about what else it did.
 *
 * WHAT THIS DOES. Asks the analysis service which Bugs and Vulnerabilities on
 * the default branch were CREATED after a point you name, and fails if there
 * are any. Run it after a merge, or before a release. It needs no baseline
 * file to drift, because every finding already carries a creation date.
 *
 * WHAT IT DOES NOT DO. It reports what the service has already analysed, so a
 * merge from the last few minutes may not be in it yet; the timestamp of the
 * newest finding is printed so a stale answer is visible rather than silent.
 * It is a net, not a proof, and a clean run means nothing new was found, not
 * that nothing new exists.
 *
 * Exit 0 when nothing new, 1 when there is, 2 on a usage or network error.
 */

import { execFileSync } from 'node:child_process';
import { requireBinaryOnPath } from './lib/binaryOnPath.mjs';

const PROJECT = 'Aurtechmx_openlidarviewer';
const BRANCH = 'main';
const HOST = 'https://sonarcloud.io';

const GIT = requireBinaryOnPath('git');

function usage(message) {
  if (message) console.error(`sonar-new-findings: ${message}\n`);
  console.error('usage: node scripts/sonar-new-findings.mjs [--since <git-ref|ISO-date>]');
  console.error('       default: the most recent tag, or the last 20 commits if untagged.');
  process.exit(2);
}

/** An ISO instant for `ref`, which may already be a date or may be a git ref. */
function resolveSince(ref) {
  if (/^\d{4}-\d{2}-\d{2}/.test(ref)) {
    const parsed = new Date(ref);
    if (Number.isNaN(parsed.getTime())) usage(`"${ref}" is not a date this can read.`);
    return parsed;
  }
  let iso;
  try {
    // stderr is swallowed: git's "ambiguous argument" is less useful here than
    // the message below, which says what the argument was supposed to be.
    iso = execFileSync(GIT, ['log', '-1', '--format=%cI', ref], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    usage(`"${ref}" is neither a date nor a ref this repository knows.`);
  }
  return new Date(iso);
}

function defaultSince() {
  try {
    const tag = execFileSync(GIT, ['describe', '--tags', '--abbrev=0'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { ref: tag, at: resolveSince(tag) };
  } catch {
    return { ref: 'HEAD~20', at: resolveSince('HEAD~20') };
  }
}

/** Sonar wants `yyyy-MM-ddTHH:mm:ss+0000`, not the `Z` form Date gives. */
function sonarInstant(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, '+0000');
}

const args = process.argv.slice(2);
let since = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--since') {
    const value = args[i + 1];
    if (value === undefined) usage('--since needs a value.');
    since = { ref: value, at: resolveSince(value) };
    i++;
  } else if (args[i] === '--help' || args[i] === '-h') {
    usage(null);
  } else {
    usage(`unrecognised argument "${args[i]}".`);
  }
}
if (since === null) since = defaultSince();

// A future instant is always answered with a 400, which reads as a network
// fault when it is really a typo. Say which it is.
if (since.at.getTime() > Date.now()) {
  usage(`--since ${since.ref} resolves to ${since.at.toISOString()}, which is in the future.`);
}

const url =
  `${HOST}/api/issues/search?componentKeys=${PROJECT}&branch=${BRANCH}` +
  `&types=BUG,VULNERABILITY&resolved=false&ps=200` +
  `&createdAfter=${encodeURIComponent(sonarInstant(since.at))}`;

let payload;
try {
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`sonar-new-findings: the service answered ${response.status}.`);
    process.exit(2);
  }
  payload = await response.json();
} catch (err) {
  console.error(`sonar-new-findings: could not reach the service (${err.message}).`);
  process.exit(2);
}

const issues = payload.issues ?? [];
const newest = issues.reduce((a, i) => (a === null || i.creationDate > a ? i.creationDate : a), null);

if (issues.length === 0) {
  console.log(
    `sonar-new-findings OK — no Bug or Vulnerability created on ${BRANCH} since ` +
      `${since.ref} (${since.at.toISOString().slice(0, 10)}).`,
  );
  process.exit(0);
}

console.error(`sonar-new-findings FAILED — ${issues.length} finding(s) created since ${since.ref}\n`);
// Grouped by file, because a batch of findings in one file is usually one
// change and one fix, and a flat list hides that.
const byFile = new Map();
for (const i of issues) {
  const file = i.component.split(':').pop();
  if (!byFile.has(file)) byFile.set(file, []);
  byFile.get(file).push(i);
}
for (const [file, list] of [...byFile.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  console.error(`  ${file}`);
  for (const i of list.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))) {
    console.error(`    ${String(i.line ?? '?').padStart(5)}  ${i.type.padEnd(13)} ${i.rule}`);
    console.error(`           ${i.message}`);
  }
}
console.error(`\nNewest finding analysed at ${newest}.`);
console.error('A merge from the last few minutes may not be in that yet.');
process.exit(1);
