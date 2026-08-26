/**
 * tests/support/evidenceRecords.ts — which generated evidence record a verifier
 * reads, and which test bucket regenerates it.
 *
 * Two tests need the same answer and must not be allowed to drift apart:
 * `releaseEvidenceOrder` checks that `test:release:execute` runs a producing
 * bucket before the verifier that grades its record, and
 * `scientificScriptSemantics` checks the same property for the
 * `validate:scientific` composition. A second copy of this walk would let one
 * command keep an ordering guarantee the other quietly lost, which is the exact
 * failure mode both tests exist to prevent.
 *
 * NOTHING HERE IS A LIST OF TODAY'S ANSWERS. The dependency comes from the
 * `generatedBy` field the evidence records already carry, and the bucket a
 * producing test runs in comes from `scripts/test-bucket.mjs --list`, the one
 * place that classification lives.
 *
 * WHAT COUNTS AS A DEPENDENCY. Only a record whose `generatedBy` names a file
 * under tests/. The other `generatedBy` values in validation/ name oracle
 * scripts (PDAL, GRASS, R, GDAL) that no release step runs, so they constrain
 * nothing and are deliberately skipped rather than silently treated as fresh.
 */

import { expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export const pkg = JSON.parse(
  readFileSync(resolve(ROOT, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };

/** bucket name -> the npm script that runs it. */
export const BUCKET_SCRIPT: Record<string, string> = {
  unit: 'test:unit',
  export: 'test:export',
  terrain: 'test:terrain',
  ui: 'test:ui',
  slow: 'test:slow',
};

/** The npm script names one `&&` chain runs, in order. */
export function chainOf(scriptId: string): string[] {
  const chain = pkg.scripts[scriptId];
  expect(typeof chain, `package.json has no ${scriptId}`).toBe('string');
  return chain
    .split('&&')
    .map((s) => s.trim())
    .map((s) => /^npm run ([\w:.-]+)/.exec(s)?.[1] ?? '')
    .filter((s) => s !== '');
}

/** `tests/foo.test.ts` -> bucket, from the single source of that classification. */
export function bucketOfTestFile(): Map<string, string> {
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
export function declaredPaths(scriptFile: string): string[] {
  const src = readFileSync(resolve(ROOT, scriptFile), 'utf8');
  const found = new Set<string>();
  for (const m of src.matchAll(/['"`](validation\/[^'"`\s${}]+)['"`]/g))
    found.add(m[1]);
  return [...found].sort();
}

export interface EvidenceRecord {
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
export function generatedRecordsRead(scriptFile: string): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
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

/** The scripts/ entry point an npm script body runs directly, or undefined. */
export function nodeScriptOf(scriptId: string): string | undefined {
  return /^node (scripts\/[\w-]+\.mjs)/.exec(pkg.scripts[scriptId] ?? '')?.[1];
}
