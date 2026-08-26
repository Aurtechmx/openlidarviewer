/**
 * releaseEvidenceOrder.test.ts — the release chain must regenerate an evidence
 * record BEFORE the verifier that grades it.
 *
 * THE DEFECT THIS EXISTS FOR. `test:release:execute` ran
 * validation:study:verify, validation:ground-metrics:verify and
 * validation:classifier-corpus:verify at steps 25, 31 and 34, while the buckets
 * that recompute the records they read (`test:unit`, `test:terrain`) ran at 47
 * and 49. Each of those verifiers says in its own header that it does not
 * recompute anything. So the gate graded the JSON committed by an earlier run
 * and only afterwards overwrote it: a regression in `deriveClassification` or in
 * the ground filter passed the check that exists to catch it, and the evidence
 * proving it passed was replaced by the run that should have failed.
 *
 * NOTHING HERE IS A COPY OF TODAY'S ORDER. The order comes from the
 * `test:release:execute` string in package.json. The dependency comes from the
 * `generatedBy` field the evidence records already carry, and the bucket a
 * producing test runs in comes from `scripts/test-bucket.mjs --list`, the one
 * place that classification lives. A NEW verifier reading a generated record,
 * or a NEW record added to a study manifest, is picked up with no edit here:
 * the discovery walks the paths each verifier names in its own source.
 *
 * WHAT COUNTS AS A DEPENDENCY. Only a record whose `generatedBy` names a file
 * under tests/. The other `generatedBy` values in validation/ name oracle
 * scripts (PDAL, GRASS, R, GDAL) that no release step runs, so they constrain
 * nothing and are deliberately skipped rather than silently treated as fresh.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** The release chain, as npm script names, in the order the chain runs them. */
function chainSteps(): string[] {
  const chain = pkg.scripts['test:release:execute'];
  expect(typeof chain, 'package.json has no test:release:execute').toBe(
    'string',
  );
  return chain
    .split('&&')
    .map((s) => s.trim())
    .map((s) => /^npm run ([\w:.-]+)/.exec(s)?.[1] ?? '')
    .filter((s) => s !== '');
}

/** bucket name -> the npm script in the chain that runs it. */
const BUCKET_SCRIPT: Record<string, string> = {
  unit: 'test:unit',
  export: 'test:export',
  terrain: 'test:terrain',
  ui: 'test:ui',
  slow: 'test:slow',
};

/** `tests/foo.test.ts` -> bucket, from the single source of that classification. */
function bucketOfTestFile(): Map<string, string> {
  const out = spawnSync('node', ['scripts/test-bucket.mjs', '--list'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  expect(out.status, `test-bucket.mjs --list failed: ${out.stderr}`).toBe(0);
  const map = new Map<string, string>();
  for (const line of out.stdout.split('\n')) {
    const [bucket, file] = line.split('\t');
    if (bucket && file) map.set(file.trim(), bucket.trim());
  }
  expect(map.size).toBeGreaterThan(0);
  return map;
}

/** Every `validation/...` path a verifier script names in its own source. */
function declaredPaths(scriptFile: string): string[] {
  const src = readFileSync(resolve(ROOT, scriptFile), 'utf8');
  const found = new Set<string>();
  for (const m of src.matchAll(/['"`](validation\/[^'"`\s${}]+)['"`]/g))
    found.add(m[1]);
  return [...found].sort();
}

interface Record_ {
  readonly path: string;
  readonly generatedBy: string;
}

/** Read one JSON file, or null when it is absent or not JSON. */
function readJson(rel: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8'));
  } catch {
    // Absent, a directory, or not JSON. Reading and catching rather than
    // testing first keeps the answer to 'can this be read' and the read
    // itself in one step, so nothing can change between them.
    return null;
  }
}

/** The JSON files a declared path covers: the file itself, or a directory of them. */
function expand(rel: string): string[] {
  // Same one-step rule as readJson: attempt the listing and let the failure
  // classify the path, rather than asking about it first. The code matters:
  // ENOTDIR means the path is a file, ENOENT means nothing is there, and
  // conflating them would report a missing artifact as a present one.
  try {
    return readdirSync(resolve(ROOT, rel))
      .filter((n) => n.endsWith('.json'))
      .sort()
      .map((n) => join(rel, n));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') return rel.endsWith('.json') ? [rel] : [];
    return [];
  }
}

/**
 * The generated records one verifier reads: the JSON it names directly, plus
 * the artifacts a study manifest points at. A study manifest carries no
 * `generatedBy` of its own (it is written by hand and frozen), so following
 * `rawArtifacts`/`derivedArtifacts` one level is what connects
 * validation:study:verify to the test that writes the artifacts it hashes.
 */
function generatedRecordsRead(scriptFile: string): Record_[] {
  const out: Record_[] = [];
  const seen = new Set<string>();
  // Several verifiers read a study manifest without ever opening the artifacts
  // it lists: validation:freeze:verify walks the manifest's git history, and
  // validation:generalization:verify resolves a studyId to check the evidence
  // it cites exists. Neither reads a byte the producing test writes, so neither
  // is stale when the test has not run yet, and following the artifact list for
  // them would report an inversion that is not one. The manifest's artifact
  // list is followed only for a verifier whose own source works with it.
  const followsArtifacts = /rawArtifacts|derivedArtifacts/.test(
    readFileSync(resolve(ROOT, scriptFile), 'utf8'),
  );
  const consider = (rel: string): void => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const doc = readJson(rel);
    if (doc === null || typeof doc !== 'object') return;
    const o = doc as Record<string, unknown>;
    if (
      typeof o.generatedBy === 'string' &&
      /^tests\/.+\.test\.ts$/.test(o.generatedBy)
    ) {
      out.push({ path: rel, generatedBy: o.generatedBy });
    }
    if (!followsArtifacts) return;
    for (const key of ['rawArtifacts', 'derivedArtifacts']) {
      const list = o[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const p = (entry as { path?: unknown })?.path;
        if (
          typeof p === 'string' &&
          p.startsWith('validation/') &&
          p.endsWith('.json')
        ) {
          consider(p);
        }
      }
    }
  };
  for (const declared of declaredPaths(scriptFile))
    for (const f of expand(declared)) consider(f);
  return out;
}

interface Pair {
  readonly verifier: string;
  readonly verifierAt: number;
  readonly producer: string;
  readonly producerAt: number;
  readonly record: string;
  readonly generatedBy: string;
}

/**
 * Records this walk saw but could not turn into a pair, and why.
 *
 * A discovery that drops a record silently fails as `expected [ Array(1) ] to
 * include ...`, which names what is missing and nothing about the reason. That
 * is unreadable anywhere the tree differs from the machine the test was
 * written on, which is exactly where this test earns its keep. Every drop is
 * recorded so the failure can say what it could not resolve.
 */
const dropped: string[] = [];

/** Every (verifier, producer) pair the release chain actually contains. */
function pairs(): Pair[] {
  const steps = chainSteps();
  const buckets = bucketOfTestFile();
  const found: Pair[] = [];
  dropped.length = 0;
  steps.forEach((name, index) => {
    const body = pkg.scripts[name];
    const script = /^node (scripts\/[\w-]+\.mjs)/.exec(body ?? '')?.[1];
    if (script === undefined) return;
    const records = generatedRecordsRead(script);
    if (records.length === 0) dropped.push(`${name}: ${script} named no readable generated record`);
    for (const rec of records) {
      const bucket = buckets.get(rec.generatedBy);
      if (bucket === undefined) {
        dropped.push(
          `${name}: ${rec.path} says generatedBy ${rec.generatedBy}, which no bucket claims`,
        );
        continue;
      }
      const producer = BUCKET_SCRIPT[bucket];
      const producerAt = producer === undefined ? -1 : steps.indexOf(producer);
      found.push({
        verifier: name,
        verifierAt: index,
        producer: producer ?? `(bucket ${bucket} runs in no chain step)`,
        producerAt,
        record: rec.path,
        generatedBy: rec.generatedBy,
      });
    }
  });
  return found;
}

describe('release chain evidence order', () => {
  it('finds the verifier/producer pairs by walking the chain, not a hardcoded list', () => {
    const found = pairs();
    // A discovery that silently stops finding anything would make every
    // assertion below vacuously true, which is the same false green this file
    // exists to prevent. These three are the pairs known to exist; the check is
    // that discovery still works, not that the list is closed.
    const keys = found.map((p) => `${p.verifier} <- ${p.generatedBy}`);
    // The drops are attached to the message rather than asserted on: a record
    // this walk cannot resolve is not itself a failure, but it is always the
    // explanation when one of the three below goes missing.
    const why = dropped.length === 0 ? '' : `\nunresolved:\n  ${dropped.join('\n  ')}`;
    expect(keys, `found ${keys.length} pair(s): ${keys.join(', ')}${why}`).toContain(
      'validation:classifier-corpus:verify <- tests/classifierCorpusEval.test.ts',
    );
    expect(keys, why).toContain(
      'validation:ground-metrics:verify <- tests/groundFilterPdalAgreement.test.ts',
    );
    expect(keys, why).toContain(
      'validation:study:verify <- tests/groundFilterPdalAgreement.test.ts',
    );
  });

  it('runs every producing bucket before the verifier that grades its record', () => {
    const inversions = pairs()
      .filter((p) => !(p.producerAt >= 0 && p.producerAt < p.verifierAt))
      .map(
        (p) =>
          `${p.verifier} runs at step ${p.verifierAt + 1} of test:release:execute and reads ` +
          `${p.record}, which ${p.generatedBy} regenerates in ${p.producer}` +
          (p.producerAt >= 0
            ? ` at step ${p.producerAt + 1}. The verifier grades the committed record and the ` +
              `producer overwrites it afterwards, so a regression in the code under test cannot ` +
              `fail this gate. Move ${p.verifier} after ${p.producer}.`
            : `, which the chain never runs. Add ${p.producer} to test:release:execute before ` +
              `${p.verifier}, or the record is never recomputed at all.`),
      );
    expect(inversions, inversions.join('\n')).toEqual([]);
  });
});
