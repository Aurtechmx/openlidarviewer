#!/usr/bin/env node
/**
 * validate-release-ref.mjs — refuse a release run before it costs anything.
 *
 * The release workflow spends twenty minutes on buckets, browsers, coverage and
 * mutation. Every one of those minutes is wasted if the ref was never
 * publishable: a tag that does not match `package.json`, a tag pointing at a
 * commit that is not HEAD, a dirty tree, a missing evidence document. Those are
 * all knowable in under a second, so they are checked first.
 *
 * The expensive alternative is worse than slow — it is a green run that
 * produces assets nobody may publish, which invites someone to publish them
 * anyway "since the tests passed".
 *
 * Usage: node scripts/validate-release-ref.mjs [--require-tag]
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Validate the checked-out ref. `env` and `git` are injected so the rules can
 * be exercised without a real tag.
 */
export function validateReleaseRef({ env = {}, git = {}, files = {}, requireTag = false } = {}) {
  const problems = [];
  const read = files.read ?? ((p) => (existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), 'utf8') : null));

  const pkgText = read('package.json');
  if (!pkgText) return { ok: false, problems: ['package.json is unreadable'], version: null };
  const pkg = JSON.parse(pkgText);
  const version = pkg.version;
  const expectedTag = `v${version}`;

  // 1. Publication runs must be on a tag, and it must be OUR tag.
  const refType = env.GITHUB_REF_TYPE ?? null;
  const refName = env.GITHUB_REF_NAME ?? null;
  if (requireTag) {
    if (refType !== 'tag') problems.push(`publication requires a tag ref, got ${refType ?? 'none'}`);
    else if (refName !== expectedTag) {
      problems.push(`ref ${refName} is not ${expectedTag} — the tag must match package.json`);
    }
  }

  // 2. The tag must point at what is checked out.
  const head = git.head ?? null;
  const tagTarget = git.tagTarget ?? null;
  if (requireTag && head && tagTarget && head !== tagTarget) {
    problems.push(`HEAD ${head.slice(0, 7)} is not the ${expectedTag} target ${tagTarget.slice(0, 7)}`);
  }

  // 3. A dirty tree means the archive would not match the commit.
  if (git.dirty) problems.push('the working tree is not clean');

  // 4. Version agreement across the manifest set.
  const lockText = read('package-lock.json');
  if (!lockText) problems.push('package-lock.json is unreadable');
  else {
    const lock = JSON.parse(lockText);
    if (lock.version !== version) problems.push(`package-lock version ${lock.version} != ${version}`);
    if (lock.packages?.['']?.version !== version) {
      problems.push(`package-lock root package version != ${version}`);
    }
  }

  const cff = read('CITATION.cff');
  if (!cff) problems.push('CITATION.cff is unreadable');
  else {
    const m = /^version:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(cff);
    if (!m) problems.push('CITATION.cff has no version field');
    else if (m[1] !== version) problems.push(`CITATION.cff version ${m[1]} != ${version}`);
  }

  const sbomText = read('sbom.json');
  if (!sbomText) problems.push('sbom.json is unreadable');
  else {
    try {
      const s = JSON.parse(sbomText);
      if (s?.metadata?.component?.version !== version) {
        problems.push(`SBOM root version ${s?.metadata?.component?.version} != ${version}`);
      }
    } catch { problems.push('sbom.json is not valid JSON'); }
  }

  // 5. Every document a reader is promised for this release.
  for (const name of [
    `RELEASE_NOTES_v${version}.md`,
    `KNOWN_LIMITATIONS_v${version}.md`,
    `VALIDATION_REPORT_v${version}.md`,
    `REPRODUCIBILITY_v${version}.md`,
  ]) {
    if (read(name) === null) problems.push(`${name} is missing`);
  }

  return { ok: problems.length === 0, problems, version, expectedTag };
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const requireTag =
    process.argv.includes('--require-tag') || process.env.GITHUB_REF_TYPE === 'tag';
  const sh = (args) => {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
  const { ok, problems, expectedTag } = validateReleaseRef({
    env: process.env,
    git: {
      head: sh(['rev-parse', 'HEAD']),
      tagTarget: sh(['rev-list', '-n1', `v${version}`]),
      dirty: (sh(['status', '--porcelain']) ?? '') !== '',
    },
    requireTag,
  });

  if (ok) {
    console.log(`validate-release-ref OK — ${expectedTag} is a publishable ref.`);
    process.exit(0);
  }
  console.error('validate-release-ref FAILED');
  console.error('');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('');
  process.exit(1);
}
