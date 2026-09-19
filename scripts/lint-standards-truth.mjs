#!/usr/bin/env node
/**
 * lint-standards-truth.mjs
 *
 * Guards the standards statements this release corrected, so they cannot drift
 * back. Every rule here corresponds to a defect that was in the tree and was
 * fixed against the specification text, not to a style preference.
 *
 * What it refuses, and why each is wrong:
 *
 *   1. Class 12 named Overlap for the extended formats. ASPRS Table 17 reserves
 *      12 from format 6; overlap moved to a classification flag (Table 16).
 *   2. Classes 19 to 22 called user-defined. Table 17 names them, and only 64
 *      and above are user definable.
 *   3. Classes 23 to 63 called user-defined. Table 17 reserves them.
 *   4. A modern accuracy figure described only as "95% confidence". The current
 *      ASPRS terminology does not reduce to that phrase, and a reader cannot
 *      tell an internal diagnostic from an independent assessment by it.
 *   5. An ISO crosswalk described as certification, compliance or conformance.
 *      Mapping concepts is not a conformance process.
 *   6. CityGML level-of-detail vocabulary. The application has no CityGML
 *      semantic objects, so LoD says nothing about what it holds.
 *
 * Historical release documents are exempt. A document that describes what a
 * past release said is a record of that release, and correcting it would make
 * it describe something that did not happen. Only the current release's
 * documents and the source tree are checked.
 *
 * Exit 0 = clean; exit 1 = a statement that contradicts the specification.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;

/** Directories walked for prose and source. */
const ROOTS = ['src', 'docs', 'README.md', 'CHANGELOG.md'];

/**
 * A release document for a version other than this one is history. So is any
 * frozen validation evidence, which records what a run produced.
 */
function isHistorical(rel) {
  if (rel.startsWith('docs/releases/')) return !rel.includes(`v${VERSION}`);
  if (rel.startsWith('docs/validation/')) return true;
  if (rel.startsWith('validation/')) return true;
  if (rel.startsWith('docs-site/releases/')) return !rel.includes(`v${VERSION}`);
  return false;
}

const RULES = [
  {
    id: 'extended-class-12-overlap',
    // "PDRF 6" / "format 6" ... "12" ... "Overlap" on one line.
    re: /\b(?:pdrf|point data record format|format)\s*(?:6|7|8|9|10)\b[^\n]{0,80}\b12\b[^\n]{0,40}overlap/i,
    why: 'class 12 is reserved from point data record format 6; overlap is a classification flag there (ASPRS Table 16, 17)',
  },
  {
    id: 'named-classes-called-user-defined',
    // A sentence that says the range is NAMED or RESERVED and then mentions
    // the user-definable range is correct, so the lookahead lets it through.
    re: /\b(?:19|20|21|22)\s*(?:to|-|–|through)\s*(?:20|21|22|63)\b(?![^\n]{0,80}(?:reserved|named))[^\n]{0,60}user[- ]defin/i,
    why: 'ASPRS Table 17 names classes 19 to 22; only 64 and above are user definable',
  },
  {
    id: 'reserved-range-called-user-defined',
    re: /\b23\s*(?:to|-|–|through)\s*63\b(?![^\n]{0,80}reserved)[^\n]{0,60}user[- ]defin/i,
    why: 'ASPRS Table 17 reserves classes 23 to 63; they are not user definable',
  },
  {
    id: 'bare-95-percent-accuracy',
    re: /95\s*%\s*confidence\s+accuracy/i,
    why: 'the current ASPRS terminology does not reduce to "95% confidence accuracy", and the phrase hides whether the figure is an internal diagnostic or an independent assessment',
  },
  {
    id: 'crosswalk-called-certification',
    re: /iso[^\n]{0,40}(?:certified|certification|conformant|conformance|compliant)\b/i,
    why: 'a crosswalk maps concepts and is not a conformance process; say crosswalk',
  },
  {
    id: 'citygml-lod',
    re: /\bcitygml\b|\blod\s*[0-4]\b/i,
    why: 'the application holds no CityGML semantic objects, so level-of-detail vocabulary describes nothing it has',
  },
];

/** Directory names never scanned, matched as whole path segments. */
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist']);

const EXT = new Set(['.ts', '.md', '.mjs', '.yaml', '.yml']);
const files = [];
function walk(p) {
  let st;
  try {
    st = statSync(p);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    // Match whole path SEGMENTS. The earlier alternation was unanchored, so
    // `dist` matched any path containing those four letters and `release$`
    // matched `docs/release`, which excluded two documents from the scan
    // without saying so. A check that silently stops reading files reports the
    // same clean line as one that read them all.
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (SKIP_DIR_NAMES.has(base)) return;
    // The packaged output at the repository root, not `docs/release`.
    if (relative(ROOT, p) === 'release') return;
    for (const e of readdirSync(p)) walk(join(p, e));
    return;
  }
  const rel = relative(ROOT, p);
  if (!EXT.has(rel.slice(rel.lastIndexOf('.')))) return;
  if (isHistorical(rel)) return;
  files.push(rel);
}
for (const r of ROOTS) walk(resolve(ROOT, r));

const problems = [];
for (const rel of files) {
  // The lint's own rule table quotes the wording it refuses.
  if (rel === 'scripts/lint-standards-truth.mjs') continue;
  const lines = readFileSync(resolve(ROOT, rel), 'utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    // A line that says the thing is wrong is not the thing.
    if (/\bnot\b[^\n]{0,30}(?:overlap|user[- ]defin|citygml)/i.test(line)) continue;
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        problems.push(`${rel}:${i + 1} [${rule.id}] ${rule.why}\n      ${line.trim().slice(0, 150)}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error('\nlint:standards-truth FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('');
  process.exit(1);
}
console.log(
  `lint:standards-truth OK — ${files.length} file(s) checked against ${RULES.length} rules; historical release documents exempt.`,
);
