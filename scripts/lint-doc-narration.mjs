#!/usr/bin/env node
/**
 * lint-doc-narration.mjs
 *
 * Holds shipped documentation to the same rule as a pull request body: say
 * what the software does, not how the change was arrived at.
 *
 * `pr-hygiene` already enforces this on PR bodies and commit messages, and
 * those are the surfaces a reviewer sees. Documentation is the surface
 * everyone else sees, it goes into the source archive, and nothing checked it.
 * The gap showed: a ledger entry shipped with an account of an attempt in it,
 * and the only reason the rest of the tree was clean is that a private,
 * manually-run tool happened to be run each time.
 *
 * The patterns are imported from `pr-hygiene` rather than restated. A second
 * copy would be free to drift, and the rule a reviewer is held to and the rule
 * a document is held to should not be able to disagree.
 *
 * Scope is every tracked Markdown file under docs/. When this was written the
 * whole tree passed, 134 files with zero hits, so there is no grandfathered
 * list and a new violation is the only way it goes red. That property is worth
 * keeping: a lint with exceptions gets exceptions added to it.
 *
 * What this does NOT check is style. Whether prose reads as machine-written is
 * a judgement about rhythm and vocabulary, and a hard gate on it would fail on
 * ordinary technical writing. This gate catches only constructions that are
 * hard to write by accident when describing software.
 *
 * Exit 0 = clean; exit 1 = a document narrates its own authoring.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NARRATION_PATTERNS } from './pr-hygiene.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Every tracked Markdown file under docs/, at any depth.
 *
 * The pathspec is the directory rather than `docs/**\/*.md`, because that glob
 * matches only files at least one directory deep: it silently skipped all 33
 * documents sitting directly in docs/, reported a confident 134, and passed a
 * file that did contain narration. The count looked plausible, which is what
 * made it dangerous.
 */
function trackedDocs() {
  const out = execSync('git ls-files -z -- docs/', { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').map((s) => s.trim()).filter((s) => s.endsWith('.md'));
}

/** Narration hits in one document, with the line each sits on. */
export function narrationIn(text) {
  const found = [];
  for (const pattern of NARRATION_PATTERNS) {
    const flags = pattern.re.flags.includes('g') ? pattern.re.flags : `${pattern.re.flags}g`;
    const re = new RegExp(pattern.re.source, flags);
    for (const match of text.matchAll(re)) {
      const line = text.slice(0, match.index).split('\n').length;
      found.push({ id: pattern.id, why: pattern.why, line, text: match[0].trim() });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

const files = trackedDocs();
const problems = [];
// Counted rather than assumed. A read that silently failed would let this
// gate pass by inspecting nothing, which is the failure a lint cannot have:
// it reports success in the same words as a clean tree.
let scanned = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(join(ROOT, file), 'utf8');
  } catch (err) {
    problems.push(`${file}: could not be read (${(err && err.code) || 'unknown'})`);
    continue;
  }
  scanned += 1;
  for (const hit of narrationIn(text)) {
    problems.push(`${file}:${hit.line} [${hit.id}] ${hit.why} ("${hit.text.slice(0, 60)}")`);
  }
}

if (files.length > 0 && scanned === 0) {
  console.error('lint:doc-narration FAILED\n\n  • listed documents but read none of them');
  process.exit(1);
}

if (problems.length > 0) {
  console.error('lint:doc-narration FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error(
    '\nShipped documentation describes the software, not how it came to be written.'
    + '\nThese patterns are the ones pr-hygiene applies to a PR body; the same rule holds here.',
  );
  process.exit(1);
}

console.log(
  `lint:doc-narration OK — ${scanned} document(s) read under docs/, `
  + 'no account of authoring in any of them.',
);
