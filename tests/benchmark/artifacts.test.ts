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
  assertHashable,
  hashArtifact,
  stripVolatile,
  VOLATILE_RULES,
  VOLATILE_PLACEHOLDER,
  RAW_BYTES_NO_STRIP_REASON,
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

  /**
   * The names a suite author actually reaches for. The first version of this
   * suite only exercised `generatedAt`/`startedAt`, which is why `date`, `time`,
   * `now`, `startTime`, `endTime`, `buildDate`, `runDate` and `datestamp` all
   * survived into the hash unnoticed — every one of them defeats the whole
   * reproducibility check on its own.
   *
   * The values here are EPOCH NUMBERS on purpose: a number cannot be caught by
   * the value-side ISO detector, so this isolates the key rule.
   */
  const TIMESTAMP_KEYS = [
    'timestamp',
    'generatedAt',
    'createdAt',
    'updatedAt',
    'startedAt',
    'finishedAt',
    'builtAt',
    'date',
    'time',
    'now',
    'startTime',
    'endTime',
    'buildDate',
    'runDate',
    'datestamp',
    'mtime',
    'epochMs',
    'unixTime',
  ];

  test.each(TIMESTAMP_KEYS)('an epoch number under `%s` does not change the hash', (key) => {
    const a = { ...base, [key]: 1_753_459_200_000 };
    const b = { ...base, [key]: 946_684_800_000 };
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', b).hash);
  });

  test('an ISO-8601 datetime is stripped by VALUE, whatever the field is called', () => {
    // Symmetric with the absolute-path rule: a wall-clock reading is volatile
    // because of what it IS, not because of the name someone gave the field.
    const a = { ...base, label: '2026-07-25T10:00:00.000Z' };
    const b = { ...base, label: '1999-01-01T00:00:00.000Z' };
    expect(hashArtifact('metrics', a).hash).toBe(hashArtifact('metrics', b).hash);
  });

  test('ISO-8601 with an offset, a space separator or no milliseconds is still stripped', () => {
    const variants = [
      '2026-07-25T10:00:00+02:00',
      '2026-07-25T10:00:00',
      '2026-07-25 10:00:00',
      '2026-07-25T10:00Z',
    ];
    const hashes = new Set(variants.map((v) => hashArtifact('metrics', { ...base, label: v }).hash));
    expect(hashes.size).toBe(1);
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

  test('the timing field names the framework itself emits all survive the strip', () => {
    // The widened timestamp key list must not reach the fields a benchmark
    // exists to report: if one of these were swallowed, a real regression would
    // hash identically to a clean run.
    for (const key of ['duration', 'durationMs', 'elapsedMs', 'peakMemory', 'pointsPerSecond']) {
      const a = { ...base, [key]: 10 };
      const b = { ...base, [key]: 11 };
      expect(hashArtifact('metrics', a).hash, key).not.toBe(hashArtifact('metrics', b).hash);
    }
  });

  test('a bare calendar date under a neutral key is NOT stripped', () => {
    // '2026-07-25' with no time is as likely to be a dataset epoch label as a
    // run timestamp, so the value rule requires a time component. A field that
    // really is a wall-clock date should be NAMED one (`date`, `buildDate`).
    const a = { ...base, epochLabel: '2026-07-25' };
    const b = { ...base, epochLabel: '2026-07-26' };
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

  test('the record DISCLOSES that no strip was applied, and why', () => {
    // A PNG tEXt date, a GeoTIFF tag or a zip mtime rehashes on every run, and
    // an empty `strippedFields` alone reads as "nothing volatile in here" — the
    // opposite of the truth. The caveat has to be on the record, not in a
    // source comment a report reader never sees.
    const rec = hashArtifact('raster', new Uint8Array([1, 2, 3]));
    expect(rec.volatilityStripped).toBe(false);
    expect(rec.unstrippedReason).toBe(RAW_BYTES_NO_STRIP_REASON);
    expect(rec.unstrippedReason).toMatch(/timestamp/i);
  });

  test('an ArrayBuffer is treated as bytes and carries the same disclosure', () => {
    const rec = hashArtifact('raster', new Uint8Array([1, 2, 3]).buffer);
    expect(rec.kind).toBe('bytes');
    expect(rec.volatilityStripped).toBe(false);
  });

  test('a JSON artifact claims the strip, with no reason to give', () => {
    const rec = hashArtifact('metrics', base);
    expect(rec.volatilityStripped).toBe(true);
    expect(rec.unstrippedReason).toBeUndefined();
  });
});

describe('values canonicalJson cannot represent are rejected, not silently collapsed', () => {
  // Each of these hashed IDENTICALLY before the guard existed: canonicalJson
  // walks own enumerable keys, so a Date and a Map both canonicalise to `{}`
  // and every non-finite number to `null`. A real value change that leaves the
  // digest untouched is the exact failure the sensitivity requirement forbids.
  test('a Date is rejected, naming its dotted path and its type', () => {
    expect(() => hashArtifact('metrics', { run: { when: new Date(0) } })).toThrow(/run\.when/);
    expect(() => hashArtifact('metrics', { run: { when: new Date(0) } })).toThrow(/Date/);
  });

  test('two Dates that differ would otherwise have collided', () => {
    expect(() => hashArtifact('metrics', { when: new Date(0) })).toThrow();
    expect(() => hashArtifact('metrics', { when: new Date(999) })).toThrow();
  });

  test('a Map and a Set are rejected', () => {
    expect(() => hashArtifact('metrics', { m: new Map([['a', 1]]) })).toThrow(/Map/);
    expect(() => hashArtifact('metrics', { s: new Set([1, 2]) })).toThrow(/Set/);
  });

  test('NaN and Infinity are rejected — both canonicalise to null', () => {
    expect(() => hashArtifact('metrics', { x: NaN })).toThrow(/\bx\b/);
    expect(() => hashArtifact('metrics', { x: NaN })).toThrow(/finite/i);
    expect(() => hashArtifact('metrics', { x: Infinity })).toThrow(/finite/i);
    expect(() => hashArtifact('metrics', { x: -Infinity })).toThrow(/finite/i);
  });

  test('a bigint, a function and a class instance are rejected', () => {
    class Cloud {
      readonly n = 1;
    }
    expect(() => hashArtifact('metrics', { n: 1n })).toThrow(/bigint/i);
    expect(() => hashArtifact('metrics', { f: () => 1 })).toThrow(/function/i);
    expect(() => hashArtifact('metrics', { c: new Cloud() })).toThrow(/Cloud/);
  });

  test('a typed array NESTED in a JSON artifact is rejected rather than hashed as an object', () => {
    expect(() => hashArtifact('metrics', { bytes: new Uint8Array([1, 2]) })).toThrow(/Uint8Array/);
  });

  test('the error names the artifact, so a suite with ten artifacts says which one', () => {
    expect(() => hashArtifact('tile-index', { when: new Date(0) })).toThrow(/tile-index/);
  });

  test('an element inside an array is named by index', () => {
    expect(() => hashArtifact('metrics', { runs: [{ ok: true }, { at: new Date(0) }] })).toThrow(
      /runs\[1\]\.at/,
    );
  });

  test('plain objects, arrays, strings, booleans and null are all accepted', () => {
    expect(() =>
      assertHashable('metrics', { a: [1, 'x', true, null, { b: Object.create(null) }] }),
    ).not.toThrow();
  });

  test('an undefined property is omitted, exactly as JSON.stringify would treat it', () => {
    // Not an error: `{ error: undefined }` is what spreading an optional field
    // produces. Dropping it is what makes the canonical form valid JSON at all
    // — canonicalJson would otherwise emit the bare token `undefined`.
    expect(hashArtifact('metrics', { a: 1, b: undefined }).hash).toBe(
      hashArtifact('metrics', { a: 1 }).hash,
    );
  });
});
