#!/usr/bin/env node
/**
 * lint-archive-vocab.mjs — keep development-process register out of files that
 * ship in the deposit archive.
 *
 * The claim-language lint bans marketing superlatives; this bans the opposite
 * tell — phrasing that describes the DELIBERATION about a release rather than
 * the release. "internal reasoning", "go/no-go record", a stray "the user's
 * real sheet" in a code comment: none are secrets, but they read as residue
 * from a private working session in a permanent scholarly archive, and each is
 * a phrase with no honest use in a shipped file. Found by an external
 * pre-publication review of the v0.6.0 archive; this stops it recurring.
 *
 * Scope is deliberately the SHIPPED surface — the files `git archive` would
 * include. Working notes that are already export-ignored (READINESS_REPORT,
 * docs/_audit) are exempt: they may use whatever register they like because
 * they never reach the archive.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Phrases with no honest use in a shipped file. Case-insensitive. */
const BANNED = [
  /\binternal reasoning\b/i,
  /\binternal (release )?deliberation\b/i,
  /\bgo\/no-go record\b/i,
  /\bchain[- ]of[- ]thought\b/i,
  /\brelease-process deliberation\b/i,
  // Conversational residue: a specific private case referred to as the user's.
  /\bthe user'?s (real|sample|sheet|copc|verdict|actual)\b/i,
  // A stable release calling itself an alpha (findings #1, #3, #5). Historical
  // references ("during alpha.3", "the alpha.3 baseline") are allowed by the
  // ALLOW list below — only the self-identifying present-tense forms are banned.
  /\b(this|for this|in this) alpha\b/i,
  /\boff by default for this alpha\b/i,
  /\blimits of this alpha\b/i,
];

/** Historical phrasings that legitimately name a past prerelease — never flagged. */
const ALLOW = [
  /\b(during|the) alpha\.\d/i,
  /\balpha\.\d (development|baseline|release)/i,
  /\bfirst (established|introduced) during\b/i,
];

/**
 * The files `git archive HEAD` would ship — attributes resolved from the
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
    // stderr ignored: a reviewer's ZIP is not a git repo, and git's "fatal:
    // not a git repository" is expected there, not an error to surface.
    tracked = execSync('git ls-files', {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').filter(Boolean);
  } catch {
    // No git — the earlier version returned [] here and then passed after
    // checking zero files (the vacuous pass a reviewer found from the ZIP).
    // Fall back to a real filesystem walk of the extracted archive.
    return walkExported(ROOT);
  }
  // Ask git which of them export-ignore; only lint the ones that ship, and
  // only text we would actually read (markdown, config, source, notices).
  const candidates = tracked.filter((f) => READABLE.test(f));
  if (candidates.length === 0) return walkExported(ROOT);
  const attrs = execSync(`git check-attr export-ignore -- ${candidates.map((f) => `'${f}'`).join(' ')}`, {
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
  const lines = readFileSync(full, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (ALLOW.some((re) => re.test(line))) return;
    for (const re of BANNED) {
      const m = line.match(re);
      if (m) {
        problems.push(
          `  • ${rel}:${i + 1}: "${m[0]}" — development-process register in a shipped file; describe the artifact plainly instead.`,
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
console.log('lint:archive-vocab OK — no development-process register in shipped files.');
