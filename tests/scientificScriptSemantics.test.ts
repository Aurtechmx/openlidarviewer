/**
 * scientificScriptSemantics.test.ts — a script named `validate:` has to run
 * the science, and a command that only re-reads committed records has to say so.
 *
 * THE DEFECT THIS EXISTS FOR. `validate:scientific` pointed straight at
 * validate-scientific.mjs, whose own header states that it computes no
 * metric and only re-reads what was written down earlier. One of the ten checks
 * it runs, `validation:study:verify`, grades
 * validation/cross-implementation/pdal-pipeline/results-*.json, which
 * tests/groundFilterPdalAgreement.test.ts writes. Nothing in that command ran
 * the test. So a ground filter that had drifted from the record it once
 * produced was graded green by the one command whose name promised the
 * opposite, and it was graded green against the drifted code's own stale
 * output. `test:release:execute` already forbids exactly this inversion; the
 * standalone command carried no such guarantee.
 *
 * THE CONVENTION THIS PINS. The repository already separates the two words:
 * `validate:terrain` runs the terrain harness through vitest and grades what
 * comes out, while `verify:archive-gate`, `verify:reachability` and
 * `verify:reference-reproducibility` read artifacts that already exist.
 * `validate:scientific` was the one command on the wrong side of that line.
 *
 * NOTHING HERE IS A LIST OF TODAY'S ANSWERS. The producer requirement is
 * derived: the checks come from the CHECKS table in the verifier's own source,
 * the records each check reads come from the paths it names, and the bucket
 * that regenerates a record comes from `scripts/test-bucket.mjs --list`. A
 * check added to that table whose record a different bucket produces fails
 * here with no edit to this file.
 *
 * HISTORICAL RELEASE NOTES ARE OUT OF SCOPE. docs/releases/ and CHANGELOG.md
 * state what a past version shipped, and v0.6.3 did ship a `validate:scientific`
 * that only re-read records. Rewriting that sentence would make the record of
 * v0.6.3 false. scripts/lint-release-truth.mjs draws the same boundary.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  BUCKET_SCRIPT,
  ROOT,
  bucketOfTestFile,
  chainOf,
  generatedRecordsRead,
  nodeScriptOf,
  pkg,
} from './support/evidenceRecords';

const VERIFIER_SCRIPT = 'scripts/verify-scientific-records.mjs';

/** Read a repo-relative file, or null when it is not there. */
function read(rel: string): string | null {
  try {
    return readFileSync(resolve(ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Does this npm script, following its `npm run` chain, ever execute a test
 * file? A body that runs vitest or the bucket runner does; a body that runs a
 * `scripts/*.mjs` does when that file spawns one of them. This is what
 * separates a command that recomputes from a command that re-reads.
 */
function executesTests(scriptId: string, seen = new Set<string>()): boolean {
  if (seen.has(scriptId)) return false;
  seen.add(scriptId);
  const body = pkg.scripts[scriptId];
  if (body === undefined) return false;
  if (/\bvitest\b|test-bucket\.mjs/.test(body)) return true;
  const file = nodeScriptOf(scriptId);
  if (file !== undefined) {
    const src = read(file);
    if (src !== null && /\bvitest\b|test-bucket\.mjs/.test(src)) return true;
  }
  return chainOf(scriptId).some((id) => executesTests(id, seen));
}

/** The npm script ids the verifier's own CHECKS table names, in its order. */
function verifierChecks(): string[] {
  const src = readFileSync(resolve(ROOT, VERIFIER_SCRIPT), 'utf8');
  const table = /const CHECKS = \[([\s\S]*?)\n\];/.exec(src);
  expect(table, `${VERIFIER_SCRIPT} has no CHECKS table`).not.toBeNull();
  const ids = [...(table as RegExpExecArray)[1].matchAll(/script: '([^']+)'/g)].map(
    (m) => m[1],
  );
  expect(ids.length, 'the CHECKS table named no script').toBeGreaterThan(0);
  return ids;
}

// ── the live tree, for the dangling-reference walk ───────────────────────────

/**
 * The files a stale command name would actually mislead someone from: the
 * manifest, CI, the scripts, the tests, and the documentation that describes
 * the tree as it is now. docs/releases/ and CHANGELOG.md are excluded for the
 * reason stated in the header.
 */
const SCAN_ROOTS = ['.github', 'scripts', 'tests', 'docs'];
const SCAN_FILES = [
  'package.json',
  'README.md',
  'REPRODUCIBILITY.md',
  'ARTIFACT_EVALUATION.md',
  'REVIEWER_QUICKSTART.md',
  'DATA_AVAILABILITY.md',
];
const SCAN_EXTENSIONS = ['.md', '.mjs', '.ts', '.js', '.yml', '.yaml', '.json', '.sh'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'fixtures', 'releases', 'e2e']);

function walk(rel: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(resolve(ROOT, rel));
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const child = join(rel, name);
    const full = resolve(ROOT, child);
    if (statSync(full).isDirectory()) {
      walk(child, out);
      continue;
    }
    if (SCAN_EXTENSIONS.some((e) => name.endsWith(e))) out.push(child);
  }
}

function liveFiles(): string[] {
  const out: string[] = [];
  for (const dir of SCAN_ROOTS) walk(dir, out);
  for (const f of SCAN_FILES) if (existsSync(resolve(ROOT, f))) out.push(f);
  expect(out.length).toBeGreaterThan(50);
  return out;
}

const NPM_RUN = /npm run (?:--silent |-s )?([\w:.-]+)/g;
const QUOTED_ID = /['"`]([\w-]+(?::[\w.-]+)+)['"`]/g;
const SCRIPT_PATH = /scripts\/[\w-]+\.(?:mjs|sh)/g;

/**
 * A reference is only checkable when it is shaped like one of this project's
 * own script ids: namespaced, and under a namespace package.json actually
 * uses. `npm run terrain:slope` in a study manifest is another tool's command
 * line, and `npm run x` in a usage example names nothing. Neither is a caller
 * of a script this repository defines, and treating them as one would report a
 * reference that was never there. The cost is that a stale single-word id
 * (`typecheck`, `repro`) is not seen; every id at issue here is namespaced.
 */
function checkableId(id: string, prefixes: Set<string>): boolean {
  if (!/^[\w-]+(?::[\w.-]+)+$/.test(id)) return false;
  return prefixes.has(id.split(':')[0]);
}

describe('scientific script semantics', () => {
  it('names a command validate: only when it executes a producer', () => {
    const lying = Object.keys(pkg.scripts)
      .filter((id) => id.startsWith('validate:'))
      .filter((id) => !executesTests(id))
      .map(
        (id) =>
          `${id} runs \`${pkg.scripts[id]}\`, which never executes a test file. ` +
          `A validate: command has to run the science it grades. Either chain the ` +
          `producing bucket in front of the verifier, or rename it verify:.`,
      );
    expect(lying, lying.join('\n')).toEqual([]);
  });

  it('runs the producing bucket before the check that grades its record', () => {
    const chain = chainOf('validate:scientific');
    const verifierAt = chain.indexOf('verify:scientific-records');
    expect(
      verifierAt,
      `validate:scientific runs \`${pkg.scripts['validate:scientific']}\`, which ` +
        'never reaches verify:scientific-records',
    ).toBeGreaterThanOrEqual(0);

    const buckets = bucketOfTestFile();
    const problems: string[] = [];
    for (const check of verifierChecks()) {
      const script = nodeScriptOf(check);
      if (script === undefined) continue;
      for (const rec of generatedRecordsRead(script)) {
        const bucket = buckets.get(rec.generatedBy);
        if (bucket === undefined) {
          problems.push(
            `${check}: ${rec.path} says generatedBy ${rec.generatedBy}, which no bucket claims`,
          );
          continue;
        }
        const producer = BUCKET_SCRIPT[bucket];
        const producerAt = producer === undefined ? -1 : chain.indexOf(producer);
        if (producerAt >= 0 && producerAt < verifierAt) continue;
        problems.push(
          `verify:scientific-records runs ${check}, which grades ${rec.path}. ` +
            `${rec.generatedBy} regenerates that record in ${producer ?? `bucket ${bucket}`}, ` +
            `which validate:scientific ` +
            (producerAt >= 0
              ? `runs after the verifier. Move it in front.`
              : `never runs, so the record is graded exactly as it was committed. ` +
                `Add it to validate:scientific before verify:scientific-records.`),
        );
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('says in its own source and in REPRODUCIBILITY.md what each command does', () => {
    const src = read(VERIFIER_SCRIPT);
    expect(src, `${VERIFIER_SCRIPT} is missing`).not.toBeNull();
    // The header has to state the limit the name now carries, so a reader who
    // opens the file learns the same thing the name told them.
    expect(src as string).toMatch(/computes no metric/);
    expect(src as string).toMatch(/validate:scientific/);

    const repro = read('REPRODUCIBILITY.md');
    expect(repro, 'REPRODUCIBILITY.md is missing').not.toBeNull();
    // The command table is where a reviewer looks for what to run. Both names
    // belong there, or the distinction exists only in the manifest.
    expect(repro as string).toContain('npm run verify:scientific-records');
    expect(repro as string).toContain('npm run validate:scientific');
  });

  it('leaves no reference to a script name or file the tree no longer has', () => {
    const known = new Set(Object.keys(pkg.scripts));
    const prefixes = new Set([...known].map((id) => id.split(':')[0]));
    const dangling: string[] = [];
    for (const file of liveFiles()) {
      const text = read(file);
      if (text === null) continue;
      for (const m of text.matchAll(NPM_RUN)) {
        if (checkableId(m[1], prefixes) && !known.has(m[1]))
          dangling.push(`${file} runs \`npm run ${m[1]}\`, which package.json does not define`);
      }
      // A bare quoted id is checked only where something could run it. Prose
      // names the id it is explaining, and docs/benchmarks.md carries a section
      // headed with a browser benchmark id precisely to say that no such script
      // exists, which is the document being right rather than a caller stale.
      if (!file.endsWith('.md'))
        for (const m of text.matchAll(QUOTED_ID)) {
          if (checkableId(m[1], prefixes) && !known.has(m[1]))
            dangling.push(
              `${file} names the script id "${m[1]}", which package.json does not define`,
            );
        }
      for (const m of text.matchAll(SCRIPT_PATH)) {
        if (!existsSync(resolve(ROOT, m[0])))
          dangling.push(`${file} names ${m[0]}, which is not in the tree`);
      }
    }
    const unique = [...new Set(dangling)].sort();
    expect(unique, unique.join('\n')).toEqual([]);
  });
});
