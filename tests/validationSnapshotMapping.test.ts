/**
 * validationSnapshotMapping.test.ts
 *
 * The validation snapshot stores some collected records under a changed name —
 * `package.json` is stored as `package.json.txt` so Dependabot does not treat
 * the copy as a manifest to maintain. Reading a snapshot back used to invert
 * that rule by stripping the suffix, which is guesswork: it made a genuine
 * `foo.txt` ambiguous, it lived in code rather than in the snapshot, and its
 * suffix list was incomplete, so the collected `package.json` and
 * `package-lock.json` were silently unreadable and the identity checks that
 * consume them reported "not executed" instead of failing.
 *
 * These tests pin the replacement. Every artifact record states both ends of
 * its own pairing, and verification reads them rather than reconstructing
 * either. Each case below tampers with a real snapshot and asserts the
 * verification refuses it, because a check that cannot fail is not a check.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, cpSync, unlinkSync, mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error — plain .mjs script, no type declarations.
import { verifyDir, mappingProblems } from '../scripts/verify-validation-snapshot.mjs';
// @ts-expect-error — plain .mjs script, no type declarations.
import { evidencePath, artifactIndex, PRODUCER_STATUSES, INPUTS } from '../scripts/validation-snapshot-lib.mjs';
// @ts-expect-error — plain .mjs script, no type declarations.
import { writeManifest } from '../scripts/build-validation-snapshot.mjs';

const SOURCE = join(process.cwd(), 'validation/snapshot');

type Step = { id: string; status: 'pass' | 'fail'; problems: string[] };

/** A throwaway copy of the committed snapshot, outside the repository. */
let base: string;
const copies: string[] = [];

function freshCopy(): string {
  const dir = mkdtempSync(join(base, 'copy-'));
  rmSync(dir, { recursive: true, force: true });
  cpSync(SOURCE, dir, { recursive: true });
  copies.push(dir);
  return dir;
}

const readSnapshot = (dir: string) => JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
const writeSnapshot = (dir: string, s: unknown) =>
  writeFileSync(join(dir, 'snapshot.json'), `${JSON.stringify(s, null, 2)}\n`);

/** The failing step ids of a verification run over a directory. */
function failures(dir: string): Step[] {
  return (verifyDir(dir, { relocated: true }) as Step[]).filter((s) => s.status === 'fail');
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'olv-snapshot-mapping-'));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('the snapshot states its own path mapping', () => {
  it('gives every artifact an explicit source path, stored path, status and size', () => {
    const s = readSnapshot(SOURCE);
    const artifacts = s.producers.flatMap((p: any) => p.artifacts);
    expect(artifacts.length).toBeGreaterThan(0);
    for (const a of artifacts) {
      expect(typeof a.producerId).toBe('string');
      expect(typeof a.sourcePath).toBe('string');
      expect(typeof a.storedPath).toBe('string');
      expect(a.status).toBe('collected');
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof a.sizeBytes).toBe('number');
      expect(typeof a.mediaType).toBe('string');
    }
  });

  it('keeps the suffix that stops a collected manifest being read as a real one', () => {
    // The behaviour the inference was there to support has to survive its
    // removal: the copies still must not look like manifests to a scanner.
    const s = readSnapshot(SOURCE);
    const pkg = artifactIndex(s).find((e: any) => e.sourcePath === 'package.json');
    expect(pkg.storedPath).toBe('evidence/identity-sources/package.json.txt');
    const lock = artifactIndex(s).find((e: any) => e.sourcePath === 'package-lock.json');
    expect(lock.storedPath).toBe('evidence/identity-sources/package-lock.json.txt');
  });

  it('reads the renamed copies back, which the stripping inference did not', () => {
    // The regression this whole change exists for: package.json was stored with
    // a .txt suffix that the reader's strip rule did not cover, so the record
    // was invisible and identity-sources reported not-executed.
    const s = readSnapshot(SOURCE);
    const identity = s.producers.find((p: any) => p.producerId === 'identity-sources');
    expect(identity.status).toBe('collected');
    expect(identity.artifacts.map((a: any) => a.sourcePath)).toContain('package.json');
    expect(s.identity.fields.find((f: any) => f.field === 'packageVersion').value).not.toBeNull();
  });

  it('does not treat a stored name as recoverable from a source name', () => {
    // A source file genuinely named *.txt and one renamed into *.txt land on
    // the same stored name under the old inference, which is the ambiguity the
    // explicit pairing removes.
    expect(evidencePath('p', 'a/package.json')).toBe('evidence/p/a/package.json.txt');
    expect(evidencePath('p', 'a/package.json.txt')).toBe('evidence/p/a/package.json.txt');
  });
});

describe('every declared producer is accounted for', () => {
  it('carries exactly one status from the closed set, for every declared producer', () => {
    const s = readSnapshot(SOURCE);
    expect(s.producers).toHaveLength(INPUTS.length);
    const declared = new Set(INPUTS.map((i: any) => i.id));
    for (const p of s.producers) {
      expect(declared.has(p.producerId)).toBe(true);
      expect(PRODUCER_STATUSES).toContain(p.status);
    }
    // No producer may vanish for being unavailable.
    expect(new Set(s.producers.map((p: any) => p.producerId))).toEqual(declared);
  });

  it('reports the three coverage figures separately, never as one number', () => {
    const c = readSnapshot(SOURCE).coverage;
    for (const key of ['producerAccounting', 'executedProducers', 'successfulProducers']) {
      expect(typeof c[key].numerator).toBe('number');
      expect(typeof c[key].denominator).toBe('number');
      expect(c[key].numerator).toBeLessThanOrEqual(c[key].denominator);
    }
    expect(c.producerAccounting.denominator).toBe(INPUTS.length);
    expect(c.producerAccounting.complete).toBe(true);
    // An unavailable environment leaves the executable denominator rather than
    // counting as a producer that someone forgot to run.
    expect(c.executedProducers.denominator).toBe(
      INPUTS.length - c.byStatus['not-applicable'] - c.byStatus['environment-unavailable'],
    );
    expect(c.successfulProducers.denominator).toBe(c.byStatus.collected + c.byStatus.failed);
  });

  it('has no single merged percentage anywhere in the coverage block', () => {
    const c = readSnapshot(SOURCE).coverage;
    const keys = JSON.stringify(c);
    expect(keys).not.toMatch(/percent|"overall"|"score"/i);
  });
});

describe('verification refuses a tampered snapshot', () => {
  it('accepts the untampered snapshot, so the refusals below mean something', () => {
    expect(failures(freshCopy())).toEqual([]);
  });

  it('refuses a stored file that is missing', () => {
    const dir = freshCopy();
    const target = artifactIndex(readSnapshot(dir))[0].storedPath;
    unlinkSync(join(dir, target));
    const failed = failures(dir);
    expect(failed.map((f) => f.id)).toEqual(['manifest']);
    expect(failed.flatMap((f) => f.problems).join('\n')).toContain(target);
  });

  it('refuses a stored file that is missing and unlisted, which the manifest cannot see', () => {
    // Rebuilding the manifest over the deletion leaves nothing for the digest
    // layer to object to. The stated mapping still names the file, so the
    // mapping check is the only thing between this and a green run.
    const dir = freshCopy();
    const target = artifactIndex(readSnapshot(dir))[0].storedPath;
    unlinkSync(join(dir, target));
    writeManifest(dir);
    const failed = failures(dir);
    expect(failed.map((f) => f.id)).toEqual(['artifact-mapping']);
    expect(failed.flatMap((f) => f.problems).join('\n')).toContain('which the snapshot does not carry');
  });

  it('refuses an unexpected file that no artifact record claims', () => {
    const dir = freshCopy();
    const extra = join(dir, 'evidence/unclaimed/record.json');
    mkdirSync(dirname(extra), { recursive: true });
    writeFileSync(extra, '{"added":"by hand"}\n');
    const failed = failures(dir);
    expect(failed.map((f) => f.id)).toEqual(['manifest']);
    expect(failed.flatMap((f) => f.problems).join('\n')).toContain('evidence/unclaimed/record.json');
  });

  it('refuses an unexpected file even when the manifest is rebuilt to cover it', () => {
    const dir = freshCopy();
    const extra = join(dir, 'evidence/unclaimed/record.json');
    mkdirSync(dirname(extra), { recursive: true });
    writeFileSync(extra, '{"added":"by hand"}\n');
    writeManifest(dir);
    const failed = failures(dir);
    expect(failed.map((f) => f.id)).toEqual(['artifact-mapping']);
    expect(failed.flatMap((f) => f.problems).join('\n')).toContain('no artifact record claims it');
  });

  it('refuses a stored file that was altered', () => {
    const dir = freshCopy();
    const target = artifactIndex(readSnapshot(dir)).find(
      (e: any) => e.sourcePath === 'CITATION.cff',
    ).storedPath;
    const abs = join(dir, target);
    writeFileSync(abs, `${readFileSync(abs, 'utf8')}\n# appended\n`);
    const failed = failures(dir);
    expect(failed.map((f) => f.id)).toEqual(['manifest']);
    expect(failed.flatMap((f) => f.problems).join('\n')).toContain(target);
  });

  it('refuses a stored file that was altered with the manifest rebuilt over the edit', () => {
    const dir = freshCopy();
    const target = artifactIndex(readSnapshot(dir)).find(
      (e: any) => e.sourcePath === 'CITATION.cff',
    ).storedPath;
    const abs = join(dir, target);
    writeFileSync(abs, `${readFileSync(abs, 'utf8')}\n# appended\n`);
    writeManifest(dir);
    const failed = failures(dir);
    expect(failed.map((f) => f.id)).toEqual(['artifact-mapping']);
    expect(failed.flatMap((f) => f.problems).join('\n')).toContain('the record for CITATION.cff states');
  });

  it('refuses a sourcePath/storedPath pair that disagrees with what is on disk', () => {
    // Point one record at another record's bytes and rebuild every digest. Both
    // files exist and both are listed, so the stated pairing is the only thing
    // that is wrong and the only thing that can catch it.
    const dir = freshCopy();
    const s = readSnapshot(dir);
    const producer = s.producers.find((p: any) => p.artifacts.length >= 2);
    const [a, b] = producer.artifacts;
    a.storedPath = b.storedPath;
    writeSnapshot(dir, s);
    writeManifest(dir);
    const failed = failures(dir);
    expect(failed.map((f) => f.id)).toEqual(['artifact-mapping']);
    expect(failed.flatMap((f) => f.problems).join('\n')).toMatch(
      /two artifact records claim the stored path|hashes .* the record for/,
    );
  });

  it('refuses a storedPath that names a file the snapshot does not carry', () => {
    const dir = freshCopy();
    const s = readSnapshot(dir);
    s.producers.find((p: any) => p.artifacts.length > 0).artifacts[0].storedPath =
      'evidence/nowhere/absent.json';
    writeSnapshot(dir, s);
    writeManifest(dir);
    const failed = failures(dir);
    expect(failed.map((f) => f.id)).toEqual(['artifact-mapping']);
    expect(failed.flatMap((f) => f.problems).join('\n')).toContain('which the snapshot does not carry');
  });

  it('refuses a producer whose status is outside the closed set', () => {
    const dir = freshCopy();
    const s = readSnapshot(dir);
    s.producers[0].status = 'mostly-fine';
    writeSnapshot(dir, s);
    writeManifest(dir);
    const failed = failures(dir);
    expect(failed.map((f) => f.id)).toContain('artifact-mapping');
    expect(failed.flatMap((f) => f.problems).join('\n')).toContain('which is not one of');
  });

  it('refuses a producer dropped from the manifest for being unavailable', () => {
    const dir = freshCopy();
    const s = readSnapshot(dir);
    s.producers = s.producers.filter((p: any) => p.status === 'collected');
    writeSnapshot(dir, s);
    writeManifest(dir);
    // Refused either because the dropped producer's records are now unclaimed
    // or because re-derivation puts the producer back. A snapshot cannot shed a
    // producer to make its own coverage look better.
    const failed = failures(dir);
    expect(failed.map((f) => f.id).some((id) => id === 'artifact-mapping' || id === 're-derivation')).toBe(true);
  });

  it('refuses a snapshot written under the superseded schema', () => {
    const dir = freshCopy();
    const s = readSnapshot(dir);
    s.schemaVersion = 1;
    writeSnapshot(dir, s);
    // Rebuild the manifest so the integrity layer is satisfied and the schema
    // check is the one that has to refuse it.
    writeManifest(dir);
    const failed = failures(dir);
    expect(failed.map((f) => f.id)).toEqual(['schema-version']);
  });
});

describe('the declared source paths are current', () => {
  it('names no path that does not exist as a directory or a producible file', () => {
    // validation/replay/ was declared here long after the directory moved to
    // validation/defects/replay/, and the producer silently collected nothing.
    for (const spec of INPUTS) {
      if (!spec.dir) continue;
      expect(existsSync(join(process.cwd(), spec.dir.path))).toBe(true);
    }
  });
});
