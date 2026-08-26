#!/usr/bin/env node
/**
 * lint-dataset-citations.mjs — resolution guard for dataset citation handles.
 *
 * `validation/datasets/dataset-register.yaml` is what a study cites instead of
 * prose. Two properties readers rely on were enforced nowhere:
 *
 *   1. The ordinal in `OLV-DS-NNN-...` names one dataset. The register's own
 *      duplicate check compares the WHOLE id, so `OLV-DS-046-SCANCMP-TLS` and
 *      `OLV-DS-046-ANTIOCHIA-NS-FLIGHT1-QUICK` both pass while ordinal 046
 *      resolves to two records.
 *   2. An id written into a comment, README or claim resolves to a record.
 *      Nothing read prose, so renumbering a branch left dangling citations
 *      behind and every gate stayed green.
 *
 * Both bit at once when branches authored in parallel took the same ordinals
 * and a later branch cited them.
 *
 * A citation may be a full id or a bare `OLV-DS-NNN`; the bare form resolves
 * through the ordinal. `EXAMPLE-DS-` handles are template records, neither
 * indexed nor required to resolve.
 *
 * A file that builds synthetic records (a test constructing a register to
 * mutate) declares `lint-dataset-citations: synthetic-ids` and is skipped. The
 * marker is deliberate and greppable, which a blanket `tests/` exclusion is
 * not: the dangling citation this lint exists to catch was in a test comment.
 *
 * `collectCitationProblems` is a function of the text it is given so the cases
 * in tests/datasetCitationLint.test.ts are about the rules rather than about
 * whatever the repository holds today. The committed tree is checked by the
 * CLI below, in CI and in the release gate.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER = resolve(ROOT, 'validation/datasets/dataset-register.yaml');

/** Directories that hold no citations, or hold copies of them. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'coverage', 'playwright-report',
  'test-results', '.vite', 'release',
]);
/** Text this lint can read. Anything else is bytes. */
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.mts', '.mjs', '.js', '.md', '.json', '.yaml', '.yml',
  '.py', '.sh', '.css', '.html', '.txt',
]);

const HANDLE = /OLV-DS-\d{3}(?:-[A-Z0-9][A-Z0-9-]*)?/g;
const SYNTHETIC = 'lint-dataset-citations: synthetic-ids';

/** The `datasetId` of every record in the register text, in file order. */
export function parseDeclaredIds(registerText) {
  return [...registerText.matchAll(/^ {2}- datasetId: (\S+)$/gm)].map((m) => m[1]);
}

/**
 * Problems in `files` (each `{ path, text }`) against `registerText`.
 * Returns `{ problems, cited, skipped, ordinals }`.
 */
export function collectCitationProblems(registerText, files) {
  const problems = [];
  const declared = parseDeclaredIds(registerText);

  const byOrdinal = new Map();
  for (const id of declared) {
    const m = /^OLV-DS-(\d{3})/.exec(id);
    if (!m) continue;
    const seen = byOrdinal.get(m[1]);
    if (seen) {
      problems.push(
        `[D1 ordinal-reused] ordinal ${m[1]} names two datasets: ${seen} and ${id}. ` +
          'An ordinal is how a reader finds a record; give the newer one the next free number.',
      );
    } else byOrdinal.set(m[1], id);
  }

  const known = new Set(declared);
  let cited = 0;
  let skipped = 0;

  for (const { path, text } of files) {
    if (text.includes(SYNTHETIC)) { skipped += 1; continue; }
    const unresolved = new Set();
    for (const [handle] of text.matchAll(HANDLE)) {
      cited += 1;
      if (known.has(handle)) continue;
      if (/^OLV-DS-\d{3}$/.test(handle) && byOrdinal.has(handle.slice(-3))) continue;
      unresolved.add(handle);
    }
    for (const handle of unresolved) {
      const ordinal = handle.slice(7, 10);
      const holder = byOrdinal.get(ordinal);
      problems.push(
        `[D2 citation-dangling] ${path} cites ${handle}, which is in no register record` +
          (holder ? `; ordinal ${ordinal} is ${holder}` : ''),
      );
    }
  }

  return { problems, cited, skipped, ordinals: byOrdinal.size };
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (TEXT_EXT.has(extname(entry))) yield full;
  }
}

/** True when this module is the entry point rather than an import. */
const isCli = isCliEntry(import.meta.url);

if (isCli) {
  const registerText = readFileSync(REGISTER, 'utf8');
  const self = resolve(ROOT, 'scripts/lint-dataset-citations.mjs');
  const files = [];
  for (const file of walk(ROOT)) {
    if (resolve(file) === REGISTER || resolve(file) === self) continue;
    files.push({ path: relative(ROOT, file), text: readFileSync(file, 'utf8') });
  }

  const { problems, cited, skipped, ordinals } = collectCitationProblems(registerText, files);

  if (problems.length > 0) {
    console.error(`\nlint-dataset-citations: ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('');
    process.exit(1);
  }

  console.log(
    `lint-dataset-citations: OK — ${parseDeclaredIds(registerText).length} record(s), ` +
      `${ordinals} distinct ordinal(s), ${cited} citation(s) all resolve` +
      `${skipped > 0 ? `, ${skipped} file(s) declared synthetic ids` : ''}.`,
  );
}
