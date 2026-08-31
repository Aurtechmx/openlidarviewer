#!/usr/bin/env node
/**
 * lint-editorial-language.mjs — production code explains technical purpose, not
 * editorial/manuscript intent.
 *
 * Comments in `src/` and `tests/` had picked up manuscript framing —
 * "Publishability: …", "a paper figure", "the reviewer must" — as a shorthand
 * for a technical requirement that can stand on its own (a labelled colorbar so
 * exported colours read back to values; a schema that never fabricates an
 * unmeasured number). That editorial intent is process leakage in runtime
 * engineering: the neutral technical reason is what belongs there.
 *
 * This guard flags intent-revealing phrases in src/ and tests/ only. It does NOT
 * ban the bare words "paper", "publication" or "journal": a literature citation
 * (a line carrying a DOI) and a software-release "publication" (publishing a
 * tag/GitHub release) are legitimate and allowlisted.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Intent-revealing editorial phrases (case-insensitive). Not bare words. */
const BANNED = [
  /\bpublishability\b/i,
  /\bpublishable\b/i,
  /\bpublication-quality\b/i,
  /\bpublication figure/i,
  /\bpaper figure/i,
  /\bfor the paper\b/i,
  /\breviewer-facing\b/i,
  /\bcamera-ready\b/i,
  /\bmanuscript\b/i,
];

/**
 * A line is exempt when its "paper/publication" sense is legitimate: a citation
 * (carries a DOI) or a software-release publish context (publishing a tag).
 */
function isAllowed(line) {
  if (/doi:/i.test(line)) return true; // literature citation
  if (/ref for publication|for publication\b.*(tag|release|ref)/i.test(line)) return true;
  return false;
}

/** Return the banned phrases found in `text`, line by line. Pure, for tests. */
export function findEditorialLeaks(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (isAllowed(line)) return;
    for (const re of BANNED) {
      if (re.test(line)) hits.push({ line: i + 1, text: line.trim().slice(0, 90) });
    }
  });
  return hits;
}

function main() {
  const files = execSync('git ls-files src tests', { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(ts|tsx|js|mjs|css)$/.test(f))
    // The negative-control test deliberately contains sample editorial phrases
    // to prove the checker catches them; it is the one place they may appear.
    .filter((f) => !f.endsWith('tests/editorialLanguage.test.ts'));
  const violations = [];
  for (const file of files) {
    const hits = findEditorialLeaks(readFileSync(resolve(ROOT, file), 'utf8'));
    for (const h of hits) violations.push(`${file}:${h.line}  ${h.text}`);
  }
  if (violations.length > 0) {
    console.error(
      `lint:editorial-language FAILED — ${violations.length} editorial/manuscript phrase(s) in production code.\n` +
        'Replace the editorial framing with the neutral technical reason (a citation with a DOI, or a\n' +
        'release-publish line, is allowlisted).\n\n' +
        violations.map((v) => `  ${v}`).join('\n'),
    );
    process.exit(1);
  }
  console.log(`lint:editorial-language OK — ${files.length} src/test files carry no editorial/manuscript intent.`);
}

if (isCliEntry(import.meta.url)) main();
