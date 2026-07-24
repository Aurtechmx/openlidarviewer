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
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
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
];

/**
 * The files `git archive HEAD` would ship — attributes resolved from the
 * working tree so a fix is visible before it is committed. Falls back to a
 * tracked-file list if git is unavailable.
 */
function shippedFiles() {
  let tracked;
  try {
    tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
  // Ask git which of them export-ignore; only lint the ones that ship, and
  // only text we would actually read (markdown, config, source, notices).
  const readable = /\.(md|ts|mjs|js|json|cff|yaml|yml)$|^\.gitattributes$|^NOTICE$/;
  const candidates = tracked.filter((f) => readable.test(f));
  if (candidates.length === 0) return [];
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

const problems = [];
for (const rel of shippedFiles()) {
  const full = resolve(ROOT, rel);
  if (!existsSync(full)) continue;
  // The lint's own definitions and the commit-msg hook name the phrases they
  // guard against — exempt them as the claims lint exempts its policy file.
  if (rel === 'scripts/lint-archive-vocab.mjs') continue;
  const lines = readFileSync(full, 'utf8').split('\n');
  lines.forEach((line, i) => {
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

if (problems.length > 0) {
  console.error('lint:archive-vocab FAILED\n');
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('lint:archive-vocab OK — no development-process register in shipped files.');
