/**
 * artifacts.test.ts — artifact hashing is stable across machines and runs.
 *
 * The hash is the claim "this is the same scientific artifact". Two things must
 * hold or the claim is worthless: it must NOT move when only the wall clock, the
 * checkout directory or the machine name differ (otherwise no reviewer can ever
 * reproduce it), and it MUST move when a real value changes (otherwise the strip
 * has quietly eaten the data the hash is supposed to cover).
 */
import { describe, test, expect } from 'vitest';
import {
  hashArtifact,
  stripVolatile,
  VOLATILE_RULES,
  VOLATILE_PLACEHOLDER,
} from '../../benchmarks/framework/artifacts';

const base = {
  suiteId: 'decode',
  datasetId: 'synthetic-grid-1m',
  points: 1_000_000,
  nested: { pointsPerSecond: 12345.5, classes: [1, 2, 6] },
};

describe('hash stability', () => {
  test('the same artifact hashed twice is identical', () => {
    const a = hashArtifact('metrics', base);
    const b = hashArtifact('metrics', base);
    expect(a.hash).toBe(b.hash);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('key order does not change the hash', () => {
    const reordered = {
      nested: { classes: [1, 2, 6], pointsPerSecond: 12345.5 },
      points: 1_000_000,
      datasetId: 'synthetic-grid-1m',
      suiteId: 'decode',
    };
    expect(hashArtifact('metrics', reordered).hash).toBe(hashArtifact('metrics', base).hash);
  });

  test('two artifacts differing only in a wall-clock timestamp hash the same', () => {
    const a = { ...base, generatedAt: '2026-07-25T10:00:00.000Z', startedAt: 1 };
    const b = { ...base, generatedAt: '1999-01-01T00:00:00.000Z', startedAt: 2 };
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', b).hash);
  });

  test('two artifacts differing only in an absolute path hash the same', () => {
    const a = { ...base, source: '/Users/alice/checkout/data/scan.las' };
    const b = { ...base, source: '/home/bob/ci/workspace/data/scan.las' };
    const c = { ...base, source: 'C:\\Users\\carol\\data\\scan.las' };
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', b).hash);
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', c).hash);
  });

  test('an absolute path nested in an array is stripped too', () => {
    const a = { ...base, inputs: ['/Users/alice/a.las', '/Users/alice/b.las'] };
    const b = { ...base, inputs: ['/srv/ci/x.las', '/srv/ci/y.las'] };
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', b).hash);
  });

  test('two artifacts differing only in machine identity hash the same', () => {
    const a = { ...base, hostname: 'alices-mbp.local', username: 'alice', pid: 4242 };
    const b = { ...base, hostname: 'ci-runner-7', username: 'runner', pid: 9 };
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', b).hash);
  });

  test('volatile fields buried deep in the tree are still stripped', () => {
    const a = { ...base, run: { meta: { generatedAt: 'A', hostname: 'a' }, ok: true } };
    const b = { ...base, run: { meta: { generatedAt: 'B', hostname: 'b' }, ok: true } };
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', b).hash);
  });
});

describe('hash sensitivity — the strip is not over-broad', () => {
  test('a changed measurement changes the hash', () => {
    const changed = { ...base, nested: { ...base.nested, pointsPerSecond: 12345.6 } };
    expect(hashArtifact('metrics', changed).hash).not.toBe(hashArtifact('metrics', base).hash);
  });

  test('a changed dataset id changes the hash', () => {
    const changed = { ...base, datasetId: 'synthetic-grid-2m' };
    expect(hashArtifact('metrics', changed).hash).not.toBe(hashArtifact('metrics', base).hash);
  });

  test('a RELATIVE path survives the strip and still discriminates', () => {
    // Only ABSOLUTE paths are machine-specific. A repo-relative dataset path is
    // part of the artifact's identity and must keep affecting the hash.
    const a = { ...base, source: 'tests/fixtures/tiny.las' };
    const b = { ...base, source: 'tests/fixtures/tiny.laz' };
    expect(hashArtifact('metrics', a).hash).not.toBe(hashArtifact('metrics', b).hash);
  });

  test('a duration is NOT stripped — timings are the measurement, not noise', () => {
    const a = { ...base, durationMs: 10 };
    const b = { ...base, durationMs: 11 };
    expect(hashArtifact('metrics', a).hash).not.toBe(hashArtifact('metrics', b).hash);
  });

  test('array order still matters', () => {
    const a = { ...base, nested: { ...base.nested, classes: [1, 2, 6] } };
    const b = { ...base, nested: { ...base.nested, classes: [6, 2, 1] } };
    expect(hashArtifact('metrics', a).hash).not.toBe(hashArtifact('metrics', b).hash);
  });
});

describe('the strip list is auditable', () => {
  test('every rule states which category it serves and why it is excluded', () => {
    expect(VOLATILE_RULES.length).toBeGreaterThan(0);
    for (const rule of VOLATILE_RULES) {
      expect(['timestamp', 'absolute-path', 'machine-id']).toContain(rule.kind);
      expect(['key', 'value']).toContain(rule.appliesTo);
      expect(rule.why.length).toBeGreaterThan(20);
    }
  });

  test('all three required categories are covered', () => {
    const kinds = new Set(VOLATILE_RULES.map((r) => r.kind));
    expect(kinds).toEqual(new Set(['timestamp', 'absolute-path', 'machine-id']));
  });

  test('the record names exactly the fields that were stripped, sorted and dotted', () => {
    const rec = hashArtifact('metrics', {
      ...base,
      generatedAt: 'now',
      run: { hostname: 'x', file: '/Users/alice/a.las' },
    });
    expect(rec.strippedFields).toEqual(['generatedAt', 'run.file', 'run.hostname']);
    expect(rec.name).toBe('metrics');
    expect(rec.algorithm).toBe('sha256');
    expect(rec.kind).toBe('json');
  });

  test('stripVolatile removes volatile keys and redacts absolute path values', () => {
    const out = stripVolatile({ keep: 1, generatedAt: 'x', p: '/var/tmp/a.bin' }).value as Record<
      string,
      unknown
    >;
    expect(out.keep).toBe(1);
    expect('generatedAt' in out).toBe(false);
    expect(out.p).toBe(VOLATILE_PLACEHOLDER);
  });

  test('stripVolatile does not mutate its input', () => {
    const input = { generatedAt: 'x', keep: 1 };
    stripVolatile(input);
    expect(input).toEqual({ generatedAt: 'x', keep: 1 });
  });
});

describe('byte artifacts', () => {
  test('raw bytes hash to the published SHA-256 of the same content', () => {
    // "abc" — FIPS 180-4 test vector, so the reuse of the project digest is pinned.
    const rec = hashArtifact('blob', new Uint8Array([0x61, 0x62, 0x63]));
    expect(rec.kind).toBe('bytes');
    expect(rec.hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(rec.byteLength).toBe(3);
    expect(rec.strippedFields).toEqual([]);
  });

  test('a changed byte changes the hash', () => {
    const a = hashArtifact('blob', new Uint8Array([1, 2, 3]));
    const b = hashArtifact('blob', new Uint8Array([1, 2, 4]));
    expect(a.hash).not.toBe(b.hash);
  });
});
