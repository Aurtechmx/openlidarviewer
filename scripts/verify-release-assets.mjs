#!/usr/bin/env node
/**
 * verify-release-assets.mjs — validate an ALREADY-STAGED release without
 * rebuilding it.
 *
 * Everything else in the release path checks one link: the gate checks the
 * code, the evidence checks the run, the manifest binds the artifacts. Nothing
 * checked the SET — that exactly one source zip is present, that the manifest's
 * commit is the tag's commit, that the evidence inside the bundle describes the
 * bundle it shipped in, that no asset from a previous cut is sitting in the
 * directory. Those are the failures that survive every other gate, because each
 * individual file is perfectly valid.
 *
 * This runs against the staging directory and returns a binary exit code. It
 * rebuilds nothing, so it can be run on downloaded assets by someone who did
 * not produce them — which is the point.
 *
 * Usage: npm run release:verify -- --dir release/payload
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line import/no-relative-packages — same repo, ships in the archive
import { MANDATORY_RELEASE_STAGES } from './collect-evidence.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Exactly one of each of these must be staged. */
const SINGLETONS = {
  sourceZip: /-source-\d{8}-\d{4}\.zip$/,
  deployZip: /-deploy-\d{8}-\d{4}-root\.zip$/,
  sbom: /^sbom\.json$/,
  evidence: /^test-evidence-v.+\.json$/,
  manifest: /^release-manifest-v.+\.json$/,
  gateLog: /^gate\.log$/,
  gateLogSha256: /^gate\.log\.sha256$/,
  releaseNotes: /^RELEASE_NOTES_v.+\.md$/,
  checksums: /^SHA256SUMS$/,
};

/**
 * What a source archive must carry, for a given release. The four versioned
 * evidence documents are the ones a reviewer actually opens; a fixed list
 * missed them entirely, so an archive without its own validation report
 * passed the contract.
 */
function sourceRequiredFor(version) {
  return [
    'package.json',
    'package-lock.json',
    'sbom.json',
    'CITATION.cff',
    'DEPENDENCIES.md',
    'THIRD_PARTY_NOTICES.md',
    'docs/validation/claim-register.yaml',
    'docs/release/RELEASE_ASSETS.md',
    'tests/fixtures/reference/slope/SHA256SUMS',
    `RELEASE_NOTES_v${version}.md`,
    `KNOWN_LIMITATIONS_v${version}.md`,
    `VALIDATION_REPORT_v${version}.md`,
    `REPRODUCIBILITY_v${version}.md`,
  ];
}

/** ...and must not carry any of these. */
const SOURCE_FORBIDDEN = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)\.git\//,
  // Anchored with ^ against the path AFTER the archive's top-level prefix is
  // stripped (see stripArchivePrefix). Matching `release/` at any depth flagged
  // docs/release/, documentation that must ship. What must not ship is the
  // generated release/ OUTPUT tree at the root, and only that.
  /^release\//,
  /(^|\/)coverage\//,
  /(^|\/)playwright-report\//,
  /(^|\/)test-results\//,
  /READINESS_REPORT/,
  /(^|\/)docs\/_audit\//,
];

/** The deploy archive's root contract. */
const DEPLOY_REQUIRED = ['index.html', '.htaccess', '_headers'];

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/**
 * Strip the single shared top-level directory, if the archive has one.
 *
 * `git archive` prefixes every entry with `openlidarviewer-v<version>/`, while a
 * plain `zip -r . ` archive has no prefix. Anchored content rules only mean
 * something against a consistent root, so normalise before matching rather than
 * writing every pattern to tolerate both shapes.
 */
export function stripArchivePrefix(entries) {
  if (entries.length === 0) return entries;
  const first = entries[0].split('/')[0];
  if (!first) return entries;
  // Only a git-archive version prefix qualifies. A hand-rolled zip whose whole
  // content happens to live under one real directory (say `src/`) must NOT be
  // silently re-rooted, or every anchored content rule would fire against the
  // wrong paths.
  if (!/^openlidarviewer-v/.test(first)) return entries;
  const shared = entries.every((e) => e === first || e.startsWith(`${first}/`));
  if (!shared) return entries;
  return entries
    .map((e) => (e === first ? '' : e.slice(first.length + 1)))
    .filter(Boolean);
}

function zipEntries(zipPath) {
  // `unzip -Z1` lists entries without extracting — cheap, and it cannot be
  // fooled by a file that merely looks right on disk.
  // stderr is swallowed: a corrupt archive makes `unzip` print a multi-line
  // essay, and the useful signal is the throw, which the caller turns into one
  // clear line. Leaking that essay into a verification report buries the
  // findings a reader is actually scanning for.
  const out = execFileSync('unzip', ['-Z1', zipPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

export function verifyStagedRelease(dir, opts = {}) {
  const problems = [];
  const note = (m) => problems.push(m);
  const pkgVersion =
    opts.version ?? JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
  const expectedTag = `v${pkgVersion}`;

  if (!existsSync(dir)) return { ok: false, problems: [`staging directory not found: ${dir}`] };

  const names = readdirSync(dir).filter((n) => statSync(resolve(dir, n)).isFile());

  // ── 1. Exactly one of each required asset ────────────────────────────────
  const found = {};
  for (const [kind, re] of Object.entries(SINGLETONS)) {
    const hits = names.filter((n) => re.test(n));
    if (hits.length === 0) note(`missing required asset: ${kind}`);
    else if (hits.length > 1) note(`expected exactly one ${kind}, found ${hits.length}: ${hits.join(', ')}`);
    else found[kind] = hits[0];
  }
  // A stale asset from a previous cut is the quiet failure: every file is
  // individually valid, and the reader cannot tell which pair belongs together.
  for (const n of names) {
    // Ask "does this name carry a version, and is it OURS", rather than trying
    // to re-parse the version out. A prerelease like 0.6.0-alpha.3 contains the
    // same hyphen the filename uses as a separator, so every naive capture
    // stops at "0.6.0" and reports the current release as foreign — the exact
    // trap lint-release-sync documents for its README matcher.
    if (!/[-_]v\d/.test(n)) continue;
    if (!n.includes(`v${pkgVersion}`)) {
      note(`asset from another release is staged: ${n} (expected v${pkgVersion})`);
    }
  }
  if (problems.length > 0 && !found.manifest) return { ok: false, problems };

  // ── 2. Identity agreement across manifest, evidence, SBOM, filenames ─────
  let manifest = null;
  let evidence = null;
  try {
    manifest = JSON.parse(readFileSync(resolve(dir, found.manifest), 'utf8'));
  } catch { note('manifest is not valid JSON'); }
  try {
    evidence = JSON.parse(readFileSync(resolve(dir, found.evidence), 'utf8'));
  } catch { note('evidence is not valid JSON'); }

  if (manifest) {
    if (manifest.version !== pkgVersion) note(`manifest version ${manifest.version} != ${pkgVersion}`);
    if (manifest.tag !== expectedTag) note(`manifest tag ${manifest.tag} != ${expectedTag}`);
    if (!manifest.gitCommit) note('manifest names no commit');
    if (opts.tagCommit && manifest.gitCommit !== opts.tagCommit) {
      note(`manifest commit ${manifest.gitCommit} is not the tag target ${opts.tagCommit}`);
    }
  }
  if (evidence) {
    if (evidence.version !== pkgVersion) note(`evidence version ${evidence.version} != ${pkgVersion}`);
    if (evidence.tag !== expectedTag) note(`evidence tag ${evidence.tag} != ${expectedTag}`);
    if (evidence.releaseAuthoritative !== true) note('evidence is not release-authoritative');
    if (evidence.gateExit !== 0) note(`evidence gate exit is ${evidence.gateExit}`);
    const major = Number(String(evidence.nodeVersion ?? '').replace(/^v/, '').split('.')[0]);
    if (major !== 22) note(`evidence Node major is ${major}, expected 22`);
    // Fail closed: evidence with NO npm version recorded is evidence that
    // skipped the toolchain assertion, not evidence that passed it.
    let expectedNpm = '10.9.2';
    try {
      const pm = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).packageManager;
      expectedNpm = String(pm ?? '').split('@')[1] || expectedNpm;
    } catch { /* fall back to the last known pin */ }
    if (evidence.npmVersion !== expectedNpm) {
      note(`evidence npm is ${evidence.npmVersion ?? 'unknown'}, expected ${expectedNpm}`);
    }
    // Every mandatory stage must be recorded as passed. gateExit alone once
    // meant only that the static gate ran.
    for (const s of MANDATORY_RELEASE_STAGES) {
      if (evidence.stages?.[s] !== 'passed') {
        note(`evidence does not record mandatory stage "${s}" as passed`);
      }
    }
    if (evidence.science?.e4ClaimCount !== 1) {
      note(`expected exactly one E4 claim, evidence says ${evidence.science?.e4ClaimCount}`);
    }
    if (evidence.science && evidence.science.e4Claims?.[0] !== 'SLOPE-RASTER') {
      note(`E4 claim is ${evidence.science.e4Claims?.[0]}, expected SLOPE-RASTER`);
    }
  }
  if (manifest && evidence) {
    if (manifest.gitCommit && evidence.commit && manifest.gitCommit !== evidence.commit) {
      note(`manifest commit ${manifest.gitCommit} != evidence commit ${evidence.commit}`);
    }
    if (manifest.bundle?.liveEntryKiB !== evidence.bundle?.liveEntryKiB) {
      note('manifest and evidence disagree about the bundle size');
    }
    if (
      manifest.bundle?.liveEntryKiB != null &&
      manifest.bundle.liveEntryKiB > manifest.bundle.ceilingKiB
    ) {
      note(`bundle ${manifest.bundle.liveEntryKiB} KiB exceeds its ${manifest.bundle.ceilingKiB} KiB ceiling`);
    }
  }
  if (found.sbom) {
    try {
      const s = JSON.parse(readFileSync(resolve(dir, found.sbom), 'utf8'));
      if (s?.metadata?.component?.version !== pkgVersion) {
        note(`staged SBOM root version is ${s?.metadata?.component?.version}, expected ${pkgVersion}`);
      }
    } catch { note('staged sbom.json is not valid JSON'); }
  }
  if (found.releaseNotes && found.releaseNotes !== `RELEASE_NOTES_v${pkgVersion}.md`) {
    note(`release notes filename ${found.releaseNotes} does not name v${pkgVersion}`);
  }

  // ── 3. Integrity: manifest hashes, gate-log hash, SHA256SUMS ─────────────
  if (manifest?.artifacts) {
    for (const [kind, a] of Object.entries(manifest.artifacts)) {
      if (!a?.file) { note(`manifest artifact ${kind} has no filename`); continue; }
      const full = resolve(dir, a.file);
      if (!existsSync(full)) { note(`manifest names a missing artifact: ${a.file}`); continue; }
      const size = statSync(full).size;
      if (size === 0) note(`${a.file} is zero bytes`);
      if (a.sizeBytes !== size) note(`${a.file} size ${size} != manifest ${a.sizeBytes}`);
      const digest = sha256(full);
      if (a.sha256 !== digest) note(`${a.file} sha256 mismatch against the manifest`);
    }
  }
  if (found.gateLog && found.gateLogSha256) {
    const recorded = readFileSync(resolve(dir, found.gateLogSha256), 'utf8').trim().split(/\s+/)[0];
    const actual = sha256(resolve(dir, found.gateLog));
    if (recorded !== actual) note('gate.log does not match gate.log.sha256');
    if (evidence?.gateLogSha256 && evidence.gateLogSha256 !== actual) {
      note('gate.log does not match the hash recorded in the evidence');
    }
  }
  if (found.checksums) {
    const lines = readFileSync(resolve(dir, found.checksums), 'utf8')
      .split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const [digest, ...rest] = line.split(/\s+/);
      const name = rest.join(' ').replace(/^\*/, '');
      const full = resolve(dir, name);
      if (!existsSync(full)) { note(`SHA256SUMS lists a missing file: ${name}`); continue; }
      if (sha256(full) !== digest) note(`SHA256SUMS mismatch for ${name}`);
    }
    // SHA256SUMS must cover the manifest — that is the half of the chain the
    // manifest cannot cover for itself.
    if (found.manifest && !lines.some((l) => l.endsWith(found.manifest))) {
      note('SHA256SUMS does not list the manifest');
    }
  }

  // ── 4. Archive contents ──────────────────────────────────────────────────
  if (found.sourceZip && !opts.skipZipContents) {
    let entries = null;
    try { entries = stripArchivePrefix(zipEntries(resolve(dir, found.sourceZip))); }
    catch { note(`source zip failed to list (corrupt?): ${found.sourceZip}`); }
    if (entries) {
      for (const req of sourceRequiredFor(pkgVersion)) {
        if (!entries.some((e) => e === req || e.endsWith(`/${req}`))) {
          note(`source zip is missing ${req}`);
        }
      }
      for (const bad of SOURCE_FORBIDDEN) {
        const hit = entries.find((e) => bad.test(e));
        if (hit) note(`source zip contains a forbidden path: ${hit}`);
      }
      const traversal = entries.find((e) => e.startsWith('/') || e.includes('../'));
      if (traversal) note(`source zip contains an unsafe path: ${traversal}`);
      const dupes = entries.filter((e, i) => entries.indexOf(e) !== i);
      if (dupes.length) note(`source zip has duplicate entries: ${dupes[0]}`);
    }
  }
  if (found.deployZip && !opts.skipZipContents) {
    let entries = null;
    try { entries = zipEntries(resolve(dir, found.deployZip)); }
    catch { note(`deploy zip failed to list (corrupt?): ${found.deployZip}`); }
    if (entries) {
      for (const req of DEPLOY_REQUIRED) {
        if (!entries.includes(req)) note(`deploy zip root is missing ${req}`);
      }
      if (!entries.some((e) => e.startsWith('assets/'))) note('deploy zip root is missing assets/');
      // The deploy archive is the site ROOT. A wrapping dist/ directory would
      // deploy to example.com/dist/ and 404 everywhere.
      if (entries.some((e) => e.startsWith('dist/'))) {
        note('deploy zip is wrapped in a dist/ directory — it must be the site root');
      }
      const traversal = entries.find((e) => e.startsWith('/') || e.includes('../'));
      if (traversal) note(`deploy zip contains an unsafe path: ${traversal}`);
    }
  }

  return { ok: problems.length === 0, problems };
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--dir');
  const dir = i === -1 ? null : argv[i + 1];
  if (!dir) {
    console.error('usage: npm run release:verify -- --dir <staging-directory>');
    process.exit(2);
  }
  let tagCommit = null;
  try {
    const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
    tagCommit = execFileSync('git', ['rev-list', '-n1', `v${version}`], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { /* no tag locally: the identity checks that do not need it still run */ }

  const { ok, problems } = verifyStagedRelease(resolve(dir), { tagCommit });
  if (ok) {
    console.log(`release:verify OK — ${dir} is a complete, self-consistent release asset set.`);
    process.exit(0);
  }
  console.error('release:verify FAILED');
  console.error('');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('');
  process.exit(1);
}
