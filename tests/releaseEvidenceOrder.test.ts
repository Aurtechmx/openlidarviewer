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
 * The discovery itself lives in `tests/support/evidenceRecords.ts` because
 * `scientificScriptSemantics` holds the same producer-before-verifier property
 * over the `validate:scientific` composition, and two copies of the walk would
 * let one command keep a guarantee the other lost.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BUCKET_SCRIPT,
  ROOT,
  bucketOfTestFile,
  chainOf,
  generatedRecordsRead,
  nodeScriptOf,
} from './support/evidenceRecords';

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
  const steps = chainOf('test:release:execute');
  const buckets = bucketOfTestFile();
  const found: Pair[] = [];
  dropped.length = 0;
  steps.forEach((name, index) => {
    const script = nodeScriptOf(name);
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

describe('the bucket lookup is not read back from a subprocess', () => {
  it('imports the rule rather than parsing a spawned --list', () => {
    const src = readFileSync(resolve(ROOT, 'tests/support/evidenceRecords.ts'), 'utf8');
    expect(
      src.includes('spawnSync'),
      'spawning test-bucket.mjs made the answer depend on the environment the ' +
        'spawn ran in: a CI shard read back a list naming no terrain file, so a ' +
        'record whose producer is a terrain test looked unclaimed and the walk ' +
        'found no pairs at all.',
    ).toBe(false);
    expect(src).toContain("from '../../scripts/lib/testBuckets.mjs'");
  });

  it('claims a terrain test as terrain, which is the case CI got wrong', () => {
    expect(bucketOfTestFile().get('tests/groundFilterPdalAgreement.test.ts')).toBe('terrain');
  });
});
