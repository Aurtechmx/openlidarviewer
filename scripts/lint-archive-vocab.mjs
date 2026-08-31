#!/usr/bin/env node
/**
 * lint-archive-vocab.mjs — keep shipped files in a plain, product-facing voice.
 *
 * A companion to the claim-language lint. That one rejects marketing
 * superlatives; this rejects the opposite: working-notes phrasing that talks
 * about how the software was built or released rather than what it does. That
 * phrasing has no honest use in a file a reader opens to learn the software.
 *
 * The patterns are assembled from fragments (see `rx` below) so the phrasings
 * this lint rejects never appear as literal strings in this file.
 *
 * It also fails on a signed-URL secret — an AWS/Azure/GCS pre-authenticated
 * query string or an OAuth token — reaching a shipped file, so a credential
 * pasted into a doc or fixture cannot ship.
 *
 * Scope is the shipped surface: the files `git archive` would include. Files
 * that are already export-ignored are exempt.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireBinaryOnPath } from './lib/binaryOnPath.mjs';
import { findSecret, findNarration } from './lib/hygienePatterns.mjs';

// Spawned programs are resolved to an absolute path by reading PATH, so the
// path that runs is a value this script can name rather than whatever the OS
// picks up. See scripts/lib/binaryOnPath.mjs.
const GIT = requireBinaryOnPath('git');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Assemble a case-insensitive pattern from fragments, so no rejected phrase
 *  appears contiguously in this file. */
const rx = (...parts) => new RegExp(parts.join(''), 'i');

/** Patterns with no honest use in a shipped file. */
const BANNED = [
  rx('\\binternal ', 'reasoning\\b'),
  rx('\\binternal (release )?', 'deliberation\\b'),
  rx('\\bgo', '\\/no-go record\\b'),
  rx('\\bchain[- ]of[- ]', 'thought\\b'),
  rx('\\brelease-process ', 'deliberation\\b'),
  // Phrasing that points at a specific private example instead of the software.
  rx("\\bthe user'?s (real|sample|sheet|copc|verdict|actual)\\b"),
  // A stable release that refers to itself as a prerelease. Past references
  // like "during <prerelease>.3" stay allowed by the ALLOW list below; only
  // the self-identifying present-tense forms are rejected.
  rx('\\b(this|for this|in this) ', 'alpha\\b'),
  rx('\\boff by default for this ', 'alpha\\b'),
  rx('\\blimits of this ', 'alpha\\b'),
];

/** Phrasings that legitimately name a past prerelease, never flagged. */
const ALLOW = [
  /\b(during|the) alpha\.\d/i,
  /\balpha\.\d (development|baseline|release)/i,
  /\bfirst (established|introduced) during\b/i,
];

/**
 * Query parameters that carry the secret in a signed / pre-authenticated URL —
 * AWS SigV4, Azure SAS, GCS signed URLs, and OAuth bearer tokens. A signed URL
 * committed to the tree ships a live (if short-lived) credential. Matched only
 * with a long value so an ordinary `?token=next` or `?sig=off` in prose or a
 * fixture does not trip the check; a real signature or token is a long blob.
 */
const LEAKED_URL_SECRET = /[?&](X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Goog-Signature|AWSAccessKeyId|sig|access_token)=[A-Za-z0-9%_\-+/]{16,}/i;

/**
 * The files `git archive HEAD` would ship; attributes resolve from the
 * working tree so a fix is visible before it is committed. Falls back to a
 * tracked-file list if git is unavailable.
 */
const READABLE = /\.(md|ts|mjs|js|json|cff|yaml|yml)$|(^|\/)\.gitattributes$|(^|\/)NOTICE$/;

/**
 * Walk the extracted tree when git metadata is absent — a reviewer running
 * this from the Zenodo source ZIP has no `.git`. Everything present in the ZIP
 * is already the shipped set (export-ignore was applied at archive time), so a
 * plain filesystem walk is the correct fallback. Skips the dirs a checkout or
 * an install would add.
 */
function walkExported(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', 'release', 'coverage'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkExported(full, acc);
    else if (READABLE.test(relative(ROOT, full))) acc.push(relative(ROOT, full));
  }
  return acc;
}

function shippedFiles() {
  let tracked;
  try {
    // stderr ignored: a source ZIP is not a git repo, and git's "fatal:
    // not a git repository" is expected there, not an error to surface.
    tracked = execFileSync(GIT, ['ls-files'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').filter(Boolean);
  } catch {
    // No git: fall back to a filesystem walk of the extracted archive.
    // Returning [] here would pass after checking zero files, a vacuous pass.
    return walkExported(ROOT);
  }
  // Ask git which of them export-ignore; only lint the ones that ship, and
  // only text we would actually read (markdown, config, source, notices).
  const candidates = tracked.filter((f) => READABLE.test(f));
  if (candidates.length === 0) return walkExported(ROOT);
  const attrs = execFileSync(GIT, ['check-attr', 'export-ignore', '--', ...candidates], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const ignored = new Set();
  for (const line of attrs.split('\n')) {
    const m = line.match(/^(.*): export-ignore: set$/);
    if (m) ignored.add(m[1]);
  }
  return candidates.filter((f) => !ignored.has(f));
}

const shipped = shippedFiles();
const SHIPPED_COUNT = shipped.length;
const problems = [];
for (const rel of shipped) {
  const full = resolve(ROOT, rel);
  if (!existsSync(full)) continue;
  // The lint's own definitions and the commit-msg hook name the phrases they
  // guard against — exempt them as the claims lint exempts its policy file.
  if (rel.endsWith('lint-archive-vocab.mjs')) continue;
  // The hygiene-pattern negative-control test deliberately contains sample
  // secret/narration shapes to prove the scanner catches them; exempt it as the
  // one place those shapes may legitimately appear.
  if (rel.endsWith('tests/hygienePatterns.test.ts')) continue;
  if (rel.endsWith('scripts/lib/hygienePatterns.mjs')) continue;
  // AI_ASSISTANCE.md legitimately discusses AI assistance at a policy level, so
  // it is exempt from the narration scan (never from the secret scans).
  const narrationExempt = rel.endsWith('AI_ASSISTANCE.md');
  const lines = readFileSync(full, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const secret = line.match(LEAKED_URL_SECRET);
    if (secret) {
      problems.push(
        `  • ${rel}:${i + 1}: "${secret[1]}=…" — a signed-URL secret in a shipped file; redact the query string before committing.`,
      );
    }
    const cred = findSecret(line);
    if (cred) {
      problems.push(
        `  • ${rel}:${i + 1}: a ${cred} in a shipped file — remove it and rotate the credential (treat it as leaked).`,
      );
    }
    if (!narrationExempt) {
      const narr = findNarration(line);
      if (narr) {
        problems.push(
          `  • ${rel}:${i + 1}: "${narr}" — conversational/process narration in a shipped file; describe the software, not the conversation.`,
        );
      }
    }
    if (ALLOW.some((re) => re.test(line))) return;
    for (const re of BANNED) {
      const m = line.match(re);
      if (m) {
        problems.push(
          `  • ${rel}:${i + 1}: "${m[0]}" — working-notes phrasing in a shipped file; describe the software plainly instead.`,
        );
      }
    }
  });
}

if (SHIPPED_COUNT === 0) {
  console.error('lint:archive-vocab FAILED\n\n  • no files to check — neither git nor a filesystem walk found any shipped file. A pass here would be vacuous.');
  process.exit(1);
}
if (problems.length > 0) {
  console.error('lint:archive-vocab FAILED\n');
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('lint:archive-vocab OK — shipped files read in a plain product voice.');
